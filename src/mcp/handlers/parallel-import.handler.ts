/**
 * Parallel Import Handler
 * Orchestrates parallel chunk parsing using a worker pool with pipelined import.
 * Used for large codebases (>= PARSING.parallelThreshold files).
 */

import { Neo4jNode, Neo4jEdge } from '../../core/config/schema.js';
import { ProjectType } from '../../core/parsers/parser-factory.js';
import { StreamingParser } from '../../core/parsers/typescript-parser.js';
import { ProgressCallback, ProgressReporter } from '../../core/utils/progress-reporter.js';
import { debugLog } from '../utils.js';
import { ChunkWorkerPool } from '../workers/chunk-worker-pool.js';

import { GraphGeneratorHandler } from './graph-generator.handler.js';

export interface ParallelImportConfig {
  chunkSize: number;
  projectId: string;
  projectPath: string;
  tsconfigPath: string;
  projectType: ProjectType;
  onProgress?: ProgressCallback;
}

export interface ParallelImportResult {
  nodesImported: number;
  edgesImported: number;
  filesProcessed: number;
  chunksProcessed: number;
  elapsedMs: number;
}

export class ParallelImportHandler {
  private progressReporter: ProgressReporter;

  constructor(private readonly graphGeneratorHandler: GraphGeneratorHandler) {
    this.progressReporter = new ProgressReporter();
  }

  /**
   * Import a project using parallel worker pool with pipelined import.
   * Chunks are distributed to workers, and imports happen as chunks complete.
   */
  async importProjectParallel(
    parser: StreamingParser,
    sourceFiles: string[],
    config: ParallelImportConfig,
  ): Promise<ParallelImportResult> {
    const startTime = Date.now();

    if (config.onProgress) {
      this.progressReporter.setCallback(config.onProgress);
    }

    const totalFiles = sourceFiles.length;
    let totalNodesImported = 0;
    let totalEdgesImported = 0;

    const chunks = this.createChunks(sourceFiles, config.chunkSize);
    this.progressReporter.report({
      phase: 'parsing',
      current: 0,
      total: totalFiles,
      message: `Starting parallel parse of ${totalFiles} files in ${chunks.length} chunks`,
      details: { chunkIndex: 0, totalChunks: chunks.length },
    });
    await debugLog('Using parallel chunk workers', { totalFiles, chunkCount: chunks.length });

    const pool = new ChunkWorkerPool({
      projectPath: config.projectPath,
      tsconfigPath: config.tsconfigPath,
      projectId: config.projectId,
      projectType: config.projectType,
    });

    // Create indexes once before chunked imports start
    await this.graphGeneratorHandler.ensureIndexes();

    // Pipelined: import starts as soon as each chunk completes parsing
    const poolResult = await pool.processChunks(chunks, async (result, stats) => {
      await this.importToNeo4j(result.nodes, result.edges);
      totalNodesImported += result.nodes.length;
      totalEdgesImported += result.edges.length;

      // Accumulate nodes for cross-chunk edge resolution
      parser.addParsedNodesFromChunk(result.nodes);

      // Merge shared context from workers for enabling cross-chunk references
      if (result.sharedContext && result.sharedContext.length > 0) {
        parser.mergeSerializedSharedContext(result.sharedContext);
      }

      // Collect deferred edges for resolution after all chunks complete
      if (result.deferredEdges && result.deferredEdges.length > 0) {
        parser.mergeDeferredEdges(result.deferredEdges);
      }

      this.progressReporter.report({
        phase: 'parsing',
        current: stats.chunksCompleted * config.chunkSize,
        total: totalFiles,
        message: `Chunk ${stats.chunksCompleted}/${stats.totalChunks}: ${totalNodesImported} nodes, ${totalEdgesImported} edges`,
        details: {
          nodesCreated: totalNodesImported,
          edgesCreated: totalEdgesImported,
          chunkIndex: stats.chunksCompleted,
          totalChunks: stats.totalChunks,
        },
      });
      debugLog(
        `Chunk ${result.chunkIndex + 1}/${stats.totalChunks}: ${result.nodes.length} nodes, ${result.edges.length} edges (imported)`,
      );
    });

    debugLog(
      `Parallel parse+import complete: ${poolResult.totalNodes} nodes, ${poolResult.totalEdges} edges in ${poolResult.elapsedMs}ms`,
    );

    this.progressReporter.report({
      phase: 'resolving',
      current: totalFiles,
      total: totalFiles,
      message: 'Resolving cross-chunk edges',
      details: {
        nodesCreated: totalNodesImported,
        edgesCreated: totalEdgesImported,
        chunkIndex: chunks.length,
        totalChunks: chunks.length,
      },
    });

    const resolvedEdges = await parser.resolveDeferredEdges();
    if (resolvedEdges.length > 0) {
      await this.importToNeo4j([], resolvedEdges);
      totalEdgesImported += resolvedEdges.length;
      await debugLog(`Resolved ${resolvedEdges.length} cross-chunk edges`);
    }

    parser.loadFrameworkSchemasForType(config.projectType);

    const enhancedEdges = await parser.applyEdgeEnhancementsManually();
    if (enhancedEdges.length > 0) {
      await this.importToNeo4j([], enhancedEdges);
      totalEdgesImported += enhancedEdges.length;
      await debugLog(`Created ${enhancedEdges.length} edges from enhancements`);
    }

    parser.clearParsedData();

    const elapsedMs = Date.now() - startTime;

    return {
      nodesImported: totalNodesImported,
      edgesImported: totalEdgesImported,
      filesProcessed: totalFiles,
      chunksProcessed: chunks.length,
      elapsedMs,
    };
  }

  private createChunks(files: string[], chunkSize: number): string[][] {
    const chunks: string[][] = [];
    for (let i = 0; i < files.length; i += chunkSize) {
      chunks.push(files.slice(i, i + chunkSize));
    }
    return chunks;
  }

  private async importToNeo4j(nodes: Neo4jNode[], edges: Neo4jEdge[]): Promise<void> {
    if (nodes.length === 0 && edges.length === 0) return;
    await this.graphGeneratorHandler.generateGraphFromData(nodes, edges, false, {}, true);
  }
}
