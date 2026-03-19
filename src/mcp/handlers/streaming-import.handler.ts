/**
 * Streaming Import Handler
 * Orchestrates chunked parsing and import for large codebases
 */

import { Neo4jNode, Neo4jEdge } from '../../core/config/schema.js';
import { StreamingParser } from '../../core/parsers/typescript-parser.js';
import { ProgressCallback, ProgressReporter } from '../../core/utils/progress-reporter.js';
import { DEFAULTS } from '../constants.js';
import { debugLog } from '../utils.js';

import { GraphGeneratorHandler } from './graph-generator.handler.js';

export interface StreamingImportConfig {
  chunkSize: number; // Files per chunk (default: 50)
  projectId: string;
  onProgress?: ProgressCallback;
}

export interface StreamingImportResult {
  nodesImported: number;
  edgesImported: number;
  filesProcessed: number;
  chunksProcessed: number;
  elapsedMs: number;
}

export class StreamingImportHandler {
  private progressReporter: ProgressReporter;

  constructor(private readonly graphGeneratorHandler: GraphGeneratorHandler) {
    this.progressReporter = new ProgressReporter();
  }

  /**
   * Import a project using chunked parsing to reduce memory usage.
   * Files are parsed and imported in chunks, with progress reporting.
   * Supports both TypeScriptParser (single project) and WorkspaceParser (monorepo).
   */
  async importProjectStreaming(parser: StreamingParser, config: StreamingImportConfig): Promise<StreamingImportResult> {
    const startTime = Date.now();

    if (config.onProgress) {
      this.progressReporter.setCallback(config.onProgress);
    }

    const allFilePaths = await parser.discoverSourceFiles();

    await debugLog('Streaming import started', {
      totalFiles: allFilePaths.length,
      chunkSize: config.chunkSize,
    });

    this.progressReporter.report({
      phase: 'parsing',
      current: 0,
      total: allFilePaths.length,
      message: `Starting streaming import of ${allFilePaths.length} files in chunks of ~${config.chunkSize}`,
    });

    const chunks: string[][] = [];
    for (let i = 0; i < allFilePaths.length; i += config.chunkSize) {
      chunks.push(allFilePaths.slice(i, i + config.chunkSize));
    }

    let totalNodesImported = 0;
    let totalEdgesImported = 0;

    // Create indexes once before chunked imports start
    await this.graphGeneratorHandler.ensureIndexes();

    for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex++) {
      const chunk = chunks[chunkIndex];
      const filesProcessed = chunkIndex * config.chunkSize + chunk.length;

      try {
        // Skip edge resolution during chunk parsing - resolve after all chunks complete
        const { nodes, edges } = await parser.parseChunk(chunk, true);
        // Accumulate nodes for cross-chunk edge resolution
        parser.addExistingNodesFromChunk(nodes);

        if (nodes.length > 0 || edges.length > 0) {
          await debugLog('Importing chunk', {
            chunkIndex: chunkIndex + 1,
            totalChunks: chunks.length,
            nodeCount: nodes.length,
          });
          await this.importChunkToNeo4j(nodes, edges);
          totalNodesImported += nodes.length;
          totalEdgesImported += edges.length;
        } else {
          await debugLog('Empty chunk result', {
            chunkIndex: chunkIndex + 1,
            fileCount: chunk.length,
            sampleFiles: chunk.slice(0, 3),
          });
        }

        await this.progressReporter.report({
          phase: 'importing',
          current: filesProcessed,
          total: allFilePaths.length,
          message: `Processed chunk ${chunkIndex + 1}/${chunks.length}: ${totalNodesImported} nodes, ${totalEdgesImported} edges`,
          details: {
            filesProcessed,
            nodesCreated: totalNodesImported,
            edgesCreated: totalEdgesImported,
            currentFile: chunk[0],
            chunkIndex: chunkIndex + 1,
            totalChunks: chunks.length,
          },
        });
      } catch (chunkError) {
        await debugLog('Chunk processing error', {
          chunkIndex: chunkIndex + 1,
          fileCount: chunk.length,
          sampleFiles: chunk.slice(0, 3),
          error: chunkError instanceof Error ? chunkError.message : String(chunkError),
          stack: chunkError instanceof Error ? chunkError.stack : undefined,
        });
        throw chunkError;
      }
    }

    await this.progressReporter.reportResolving(0, totalEdgesImported);

    const resolvedEdges = await parser.resolveDeferredEdges();
    if (resolvedEdges.length > 0) {
      await this.importEdgesToNeo4j(resolvedEdges);
      totalEdgesImported += resolvedEdges.length;
      await debugLog(`Resolved ${resolvedEdges.length} cross-chunk edges`);
    }

    const enhancedEdges = await parser.applyEdgeEnhancementsManually();
    if (enhancedEdges.length > 0) {
      await this.importEdgesToNeo4j(enhancedEdges);
      totalEdgesImported += enhancedEdges.length;
      await debugLog(`Created ${enhancedEdges.length} edges from edge enhancements`);
    }

    parser.clearParsedData();

    await this.progressReporter.reportResolving(resolvedEdges.length, resolvedEdges.length);

    const elapsedMs = Date.now() - startTime;
    await this.progressReporter.reportComplete(totalNodesImported, totalEdgesImported);

    const result: StreamingImportResult = {
      nodesImported: totalNodesImported,
      edgesImported: totalEdgesImported,
      filesProcessed: allFilePaths.length,
      chunksProcessed: chunks.length,
      elapsedMs,
    };

    await debugLog('Streaming import completed', result);

    return result;
  }

  private async importChunkToNeo4j(nodes: Neo4jNode[], edges: Neo4jEdge[]): Promise<void> {
    await this.graphGeneratorHandler.generateGraphFromData(nodes, edges, false, {}, true);
  }

  private async importEdgesToNeo4j(edges: Neo4jEdge[]): Promise<void> {
    if (edges.length === 0) return;
    await this.graphGeneratorHandler.generateGraphFromData([], edges, false, {}, true);
  }
}
