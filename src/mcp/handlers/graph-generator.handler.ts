/**
 * Graph Generator Handler
 * Handles importing parsed graph data into Neo4j with embeddings
 */

import fs from 'fs/promises';

import { Neo4jNode, Neo4jEdge } from '../../core/config/schema.js';
import { EmbeddingsService, EMBEDDING_BATCH_CONFIG, getEmbeddingDimensions } from '../../core/embeddings/embeddings.service.js';
import { Neo4jService, QUERIES } from '../../storage/neo4j/neo4j.service.js';
import { DEFAULTS } from '../constants.js';
import { debugLog } from '../utils.js';

interface GraphData {
  nodes: Neo4jNode[];
  edges: Neo4jEdge[];
  metadata: any;
}

interface ImportResult {
  nodesImported: number;
  edgesImported: number;
  metadata: any;
}

export class GraphGeneratorHandler {
  private static readonly EMBEDDED_LABEL = 'Embedded';
  private projectId: string | null = null;

  constructor(
    private readonly neo4jService: Neo4jService,
    private readonly embeddingsService: EmbeddingsService,
  ) {}

  /**
   * Set the projectId for project-scoped operations
   */
  setProjectId(projectId: string): void {
    this.projectId = projectId;
  }

  async generateGraph(
    graphJsonPath: string,
    batchSize: number = DEFAULTS.batchSize,
    clearExisting = true,
  ): Promise<ImportResult> {
    console.error(`Generating graph from JSON file: ${graphJsonPath}`);
    await debugLog('Starting graph generation', { graphJsonPath, batchSize, clearExisting, projectId: this.projectId });

    try {
      const graphData = await this.loadGraphData(graphJsonPath);
      const { nodes, edges, metadata } = graphData;

      console.error(`Generating graph with ${nodes.length} nodes and ${edges.length} edges`);
      await debugLog('Graph data loaded', { nodeCount: nodes.length, edgeCount: edges.length });

      if (clearExisting) {
        await this.clearExistingData();
      }

      await this.createProjectIndexes();
      await this.importNodes(nodes, batchSize);
      await this.importEdges(edges, batchSize);
      await this.createVectorIndexes();

      const result: ImportResult = {
        nodesImported: nodes.length,
        edgesImported: edges.length,
        metadata,
      };

      await debugLog('Graph generation completed', result);
      return result;
    } catch (error) {
      console.error('generateGraph error:', error);
      await debugLog('Graph generation error', error);
      throw error;
    }
  }

  private async loadGraphData(graphJsonPath: string): Promise<GraphData> {
    const fileContent = await fs.readFile(graphJsonPath, 'utf-8');
    return JSON.parse(fileContent);
  }

  private async clearExistingData(): Promise<void> {
    if (this.projectId) {
      console.error(`Clearing existing graph data for project: ${this.projectId}...`);
      await this.neo4jService.run(QUERIES.CLEAR_PROJECT, { projectId: this.projectId });
      await debugLog('Existing project graph data cleared', { projectId: this.projectId });
    } else {
      console.error('Clearing ALL existing graph data (no projectId set)...');
      await this.neo4jService.run(QUERIES.CLEAR_DATABASE);
      await debugLog('Existing graph data cleared');
    }
  }

  private async createProjectIndexes(): Promise<void> {
    console.error('Creating project indexes...');
    await this.neo4jService.run(QUERIES.CREATE_PROJECT_INDEX_EMBEDDED);
    await this.neo4jService.run(QUERIES.CREATE_PROJECT_INDEX_SOURCEFILE);
    await this.neo4jService.run(QUERIES.CREATE_PROJECT_ID_INDEX_EMBEDDED);
    await this.neo4jService.run(QUERIES.CREATE_PROJECT_ID_INDEX_SOURCEFILE);
    await this.neo4jService.run(QUERIES.CREATE_NORMALIZED_HASH_INDEX);
    await this.neo4jService.run(QUERIES.CREATE_SESSION_BOOKMARK_INDEX);
    await this.neo4jService.run(QUERIES.CREATE_SESSION_NOTE_INDEX);
    await this.neo4jService.run(QUERIES.CREATE_SESSION_NOTE_CATEGORY_INDEX);
    await debugLog('Project indexes created');
  }

  private async importNodes(nodes: Neo4jNode[], batchSize: number): Promise<void> {
    console.error(`Importing ${nodes.length} nodes with embeddings...`);

    for (let i = 0; i < nodes.length; i += batchSize) {
      const batch = await this.processNodeBatch(nodes.slice(i, i + batchSize));
      const result = await this.neo4jService.run(QUERIES.CREATE_NODE, { nodes: batch });

      const batchEnd = Math.min(i + batchSize, nodes.length);
      console.error(`Created ${result[0].created} nodes in batch ${i + 1}-${batchEnd}`);

      await debugLog('Node batch imported', {
        batchStart: i + 1,
        batchEnd,
        created: result[0].created,
      });
    }
  }

  /**
   * Process a batch of nodes with batched embedding calls.
   * Collects all texts needing embedding, makes a single batched API call,
   * then maps embeddings back to their respective nodes.
   */
  private async processNodeBatch(nodes: any[]): Promise<any[]> {
    // Separate nodes that need embedding from those that don't
    const nodesNeedingEmbedding: { node: any; index: number; text: string }[] = [];
    const nodeResults: any[] = new Array(nodes.length);

    // First pass: identify nodes needing embedding and prepare texts
    nodes.forEach((node, index) => {
      if (node.properties?.sourceCode && !node.skipEmbedding) {
        // Truncate to stay under embedding model's 8192 token limit (~4 chars/token)
        const truncatedCode = node.properties.sourceCode.slice(0, DEFAULTS.maxEmbeddingChars);
        // Include node name and type in embedding for better search matching
        // e.g., "ProfileService ClassDeclaration" helps "profile service" queries match
        const metadata = `${node.properties.name ?? ''} ${node.labels?.join(' ') ?? ''}`.trim();
        const embeddingText = metadata ? `${metadata}\n${truncatedCode}` : truncatedCode;
        nodesNeedingEmbedding.push({
          node,
          index,
          text: embeddingText,
        });
      } else {
        // Node doesn't need embedding - prepare it immediately
        nodeResults[index] = {
          ...node,
          labels: node.labels,
          properties: {
            ...this.flattenProperties(node.properties),
            embedding: null,
          },
        };
      }
    });

    // Batch embed all texts that need it
    if (nodesNeedingEmbedding.length > 0) {
      const texts = nodesNeedingEmbedding.map((n) => n.text);
      const effectiveBatchSize = parseInt(process.env.EMBEDDING_BATCH_SIZE ?? '', 10) || EMBEDDING_BATCH_CONFIG.maxBatchSize;
      const totalBatches = Math.ceil(texts.length / effectiveBatchSize);
      console.error(`[embedding] Starting ${texts.length} texts in ~${totalBatches} batches (effective_batch_size=${effectiveBatchSize}, config_max=${EMBEDDING_BATCH_CONFIG.maxBatchSize})`);

      try {
        const embeddings = await this.embeddingsService.embedTextsInBatches(texts, EMBEDDING_BATCH_CONFIG.maxBatchSize);

        // Map embeddings back to their nodes
        let embeddedCount = 0;
        nodesNeedingEmbedding.forEach((item, i) => {
          const embedding = embeddings[i];
          if (embedding) embeddedCount++;
          nodeResults[item.index] = {
            ...item.node,
            labels: embedding ? [...item.node.labels, GraphGeneratorHandler.EMBEDDED_LABEL] : item.node.labels,
            properties: {
              ...this.flattenProperties(item.node.properties),
              embedding,
            },
          };
        });

        console.error(`[embedding] Done: ${embeddedCount}/${texts.length} nodes embedded`);
        await debugLog('Batch embedding completed', {
          totalNodes: nodes.length,
          nodesEmbedded: embeddedCount,
          batchesUsed: totalBatches,
        });
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        console.error(`[embedding] FAILED: ${msg}`);
        await debugLog('Embedding failed', { error: msg });
        throw error;
      }
    }

    return nodeResults;
  }

  private async importEdges(edges: any[], batchSize: number): Promise<void> {
    console.error(`Importing ${edges.length} edges using APOC...`);

    for (let i = 0; i < edges.length; i += batchSize) {
      const batch = edges.slice(i, i + batchSize).map((edge) => ({
        ...edge,
        properties: this.flattenProperties(edge.properties),
      }));

      const result = await this.neo4jService.run(QUERIES.CREATE_RELATIONSHIP, {
        edges: batch,
        projectId: this.projectId,
      });

      const batchEnd = Math.min(i + batchSize, edges.length);
      console.error(`Created ${result[0].created} edges in batch ${i + 1}-${batchEnd}`);

      await debugLog('Edge batch imported', {
        batchStart: i + 1,
        batchEnd,
        created: result[0].created,
      });
    }
  }

  private async createVectorIndexes(): Promise<void> {
    const dims = getEmbeddingDimensions();
    console.error(`Creating vector indexes (dimensions: ${dims})...`);
    await this.neo4jService.run(QUERIES.CREATE_EMBEDDED_VECTOR_INDEX(dims));
    await this.neo4jService.run(QUERIES.CREATE_SESSION_NOTES_VECTOR_INDEX(dims));
    await debugLog('Vector indexes created', { dimensions: dims });
  }

  private flattenProperties(properties: any): any {
    const flattened: any = {};

    for (const [key, value] of Object.entries(properties)) {
      if (this.isComplexObject(value)) {
        // Convert nested objects to JSON strings for Neo4j compatibility
        flattened[key] = JSON.stringify(value);
      } else if (this.isComplexArray(value)) {
        // Convert arrays with objects to JSON strings
        flattened[key] = JSON.stringify(value);
      } else {
        // Keep scalar values as-is
        flattened[key] = value;
      }
    }

    return flattened;
  }

  private isComplexObject(value: any): boolean {
    return value && typeof value === 'object' && !Array.isArray(value);
  }

  private isComplexArray(value: any): boolean {
    return Array.isArray(value) && value.some((item) => typeof item === 'object');
  }
}
