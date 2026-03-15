/**
 * Parse TypeScript Project Tool
 * Parses TypeScript/NestJS projects and builds Neo4j graph
 */

import { writeFileSync } from 'fs';
import { constants as fsConstants } from 'fs';
import { stat, access, realpath } from 'fs/promises';
import { dirname, join, resolve, sep } from 'path';
import { fileURLToPath } from 'url';
import { Worker } from 'worker_threads';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { CORE_TYPESCRIPT_SCHEMA } from '../../core/config/schema.js';
import { stopEmbeddingSidecar } from '../../core/embeddings/embedding-sidecar.js';
import { EmbeddingsService } from '../../core/embeddings/embeddings.service.js';
import { ParserFactory, ProjectType } from '../../core/parsers/parser-factory.js';
import { detectChangedFiles } from '../../core/utils/file-change-detection.js';
import {
  resolveProjectId,
  getProjectName,
  UPSERT_PROJECT_QUERY,
  UPDATE_PROJECT_STATUS_QUERY,
} from '../../core/utils/project-id.js';
import { Neo4jService, QUERIES } from '../../storage/neo4j/neo4j.service.js';
import {
  TOOL_NAMES,
  TOOL_METADATA,
  DEFAULTS,
  FILE_PATHS,
  LOG_CONFIG,
  PARSING,
  CONFIG_FILE_PATTERNS,
} from '../constants.js';
import {
  CrossFileEdge,
  deleteSourceFileSubgraphs,
  loadExistingNodesForEdgeDetection,
  getCrossFileEdges,
} from '../handlers/cross-file-edge.helpers.js';
import { GraphGeneratorHandler } from '../handlers/graph-generator.handler.js';
import { StreamingImportHandler } from '../handlers/streaming-import.handler.js';
import { jobManager } from '../services/job-manager.js';
import { watchManager } from '../services/watch-manager.js';
import {
  createErrorResponse,
  createSuccessResponse,
  formatParseSuccess,
  formatParsePartialSuccess,
  debugLog,
} from '../utils.js';

/**
 * Validates that a path exists and is accessible
 * @throws Error if path doesn't exist or isn't accessible
 */
const validatePathExists = async (path: string, pathType: 'directory' | 'file'): Promise<void> => {
  try {
    await access(path, fsConstants.R_OK);
    const stats = await stat(path);
    if (pathType === 'directory' && !stats.isDirectory()) {
      throw new Error(`Path exists but is not a directory: ${path}`);
    }
    if (pathType === 'file' && !stats.isFile()) {
      throw new Error(`Path exists but is not a file: ${path}`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`Path does not exist: ${path}`);
    }
    throw error;
  }
};

/**
 * Validates that a resolved file path stays within the project directory
 * to prevent path traversal attacks via symlinks
 * @throws Error if path escapes project directory
 */
const _validatePathWithinProject = async (filePath: string, projectPath: string): Promise<void> => {
  const realProjectPath = await realpath(projectPath);
  const realFilePath = await realpath(filePath);

  // Ensure file path is within project directory
  if (!realFilePath.startsWith(realProjectPath + sep) && realFilePath !== realProjectPath) {
    throw new Error(`SECURITY: Path traversal detected - file "${filePath}" resolves outside project directory`);
  }
};
// Export for potential use by other modules
export { _validatePathWithinProject as validatePathWithinProject };

export const createParseTypescriptProjectTool = (server: McpServer): void => {
  server.registerTool(
    TOOL_NAMES.parseTypescriptProject,
    {
      title: TOOL_METADATA[TOOL_NAMES.parseTypescriptProject].title,
      description: TOOL_METADATA[TOOL_NAMES.parseTypescriptProject].description,
      inputSchema: {
        projectPath: z.string().describe('Path to the TypeScript project root directory'),
        tsconfigPath: z.string().describe('Path to TypeScript project tsconfig.json file'),
        configFileGlobs: z
          .array(z.string())
          .optional()
          .describe('Custom glob patterns for config files (default: all JSON, YAML, .env, Dockerfile, .sh, .py)')
          .default(CONFIG_FILE_PATTERNS.defaultGlobs),
        projectId: z
          .string()
          .optional()
          .describe('Optional project ID override. If not provided, auto-generated from projectPath'),
        clearExisting: z.boolean().optional().describe('Clear existing graph data for this project first'),
        excludeNodeTypes: z
          .array(z.string())
          .optional()
          .describe('Node types to skip during parsing, e.g. ["TestFile", "Parameter"]'),
        projectType: z
          .enum(['nestjs', 'fairsquare', 'both', 'vanilla', 'auto'])
          .optional()
          .default('auto')
          .describe('Project framework type (auto-detect by default)'),
        chunkSize: z
          .number()
          .optional()
          .default(100)
          .describe('Files per chunk for streaming import (default: 50). Set to 0 to disable streaming.'),
        useStreaming: z
          .enum(['auto', 'always', 'never'])
          .optional()
          .default('auto')
          .describe('When to use streaming import: auto (>100 files), always, or never'),
        async: z.coerce
          .boolean()
          .optional()
          .default(true)
          .describe('Run parsing in background and return job ID immediately. Use check_parse_status to monitor.'),
        watch: z
          .boolean()
          .optional()
          .default(false)
          .describe('Start file watching after parse completes. Only works with async: false.'),
        watchDebounceMs: z
          .number()
          .optional()
          .default(1000)
          .describe('Debounce delay for watch mode in milliseconds (default: 1000)'),
      },
    },
    async ({
      tsconfigPath,
      projectPath,
      projectId,
      configFileGlobs,
      clearExisting,
      projectType = 'auto',
      chunkSize = 100,
      useStreaming = 'auto',
      async: asyncMode = false,
      watch = false,
      watchDebounceMs = 1000,
    }) => {
      try {
        // SECURITY: Validate input paths before processing
        await validatePathExists(projectPath, 'directory');
        await validatePathExists(tsconfigPath, 'file');
        // Note: tsconfig can be outside project in monorepo setups, so we just validate it exists

        await debugLog('TypeScript project parsing started', {
          projectPath,
          tsconfigPath,
          clearExisting,
          projectType,
          chunkSize,
          useStreaming,
          asyncMode,
        });

        // Reject conflicting parameters: watch only works with sync mode
        if (asyncMode && watch) {
          return createErrorResponse(
            new Error(
              'Invalid parameter combination: watch=true cannot be used with async=true. ' +
                'File watching requires synchronous parsing. Either set async=false or watch=false.',
            ),
          );
        }

        // Resolve projectId early
        const resolvedProjectId = resolveProjectId(projectPath, projectId);

        // Handle async mode - return job ID immediately and process in Worker thread
        if (asyncMode) {
          const jobId = jobManager.createJob(projectPath, resolvedProjectId);
          jobManager.startJob(jobId);

          // Get path to worker script
          const __filename = fileURLToPath(import.meta.url);
          const __dirname = dirname(__filename);
          const workerPath = join(__dirname, '..', 'workers', 'parse-coordinator.js');

          // Create Worker thread to run parsing without blocking MCP server
          const worker = new Worker(workerPath, {
            workerData: {
              projectPath,
              tsconfigPath,
              projectId: resolvedProjectId,
              projectType,
              chunkSize: chunkSize > 0 ? chunkSize : 50,
              configFileGlobs,
            },
            resourceLimits: {
              maxOldGenerationSizeMb: 8192, // 8GB heap for large monorepos
              maxYoungGenerationSizeMb: 1024,
            },
          });

          // Worker cleanup function
          const terminateWorker = async (reason: string): Promise<void> => {
            try {
              await worker.terminate();
              await debugLog('Worker terminated', { jobId, reason });
            } catch (terminateError) {
              console.warn('Error terminating worker:', terminateError);
            }
          };

          // Set timeout for worker execution (30 minutes)
          const timeoutId = setTimeout(async () => {
            const job = jobManager.getJob(jobId);
            if (job && job.status === 'running') {
              jobManager.failJob(jobId, `Worker timed out after ${PARSING.workerTimeoutMs / 60000} minutes`);
              await stopEmbeddingSidecar();
              await terminateWorker('timeout');
            }
          }, PARSING.workerTimeoutMs);

          // Handle progress messages from worker
          worker.on('message', (msg: any) => {
            if (msg.type === 'progress') {
              jobManager.updateProgress(jobId, msg.data);
            } else if (msg.type === 'complete') {
              clearTimeout(timeoutId);
              jobManager.completeJob(jobId, msg.data);
              debugLog('Async parsing completed', { jobId, result: msg.data });
              terminateWorker('complete');
            } else if (msg.type === 'error') {
              clearTimeout(timeoutId);
              jobManager.failJob(jobId, msg.error);
              debugLog('Async parsing failed', { jobId, error: msg.error });
              stopEmbeddingSidecar();
              terminateWorker('error');
            }
          });

          // Handle worker errors
          worker.on('error', (err) => {
            clearTimeout(timeoutId);
            jobManager.failJob(jobId, err.message ?? String(err));
            console.error('Worker thread error:', err);
            stopEmbeddingSidecar();
            terminateWorker('worker-error');
          });

          // Handle worker exit
          worker.on('exit', (code) => {
            clearTimeout(timeoutId);
            if (code !== 0) {
              const job = jobManager.getJob(jobId);
              if (job && job.status === 'running') {
                jobManager.failJob(jobId, `Worker stopped with exit code ${code}`);
              }
            }
          });

          return createSuccessResponse(
            `Background parsing started in Worker thread.\n` +
              `Job ID: ${jobId}\n` +
              `Project ID: ${resolvedProjectId}\n\n` +
              `Use check_parse_status({ jobId: "${jobId}" }) to monitor progress.`,
          );
        }

        const neo4jService = new Neo4jService();
        const embeddingsService = new EmbeddingsService();
        const graphGeneratorHandler = new GraphGeneratorHandler(neo4jService, embeddingsService);

        // Determine if we should use streaming import
        // Use lazyLoad = true for consistent glob-based file discovery (matches incremental parse)
        const parser =
          projectType === 'auto'
            ? await ParserFactory.createParserWithAutoDetection(projectPath, tsconfigPath, resolvedProjectId, true)
            : ParserFactory.createParser({
                workspacePath: projectPath,
                tsConfigPath: tsconfigPath,
                projectType: projectType as ProjectType,
                projectId: resolvedProjectId,
                lazyLoad: true,
              });

        const discoveredFiles = await parser.discoverSourceFiles();
        const totalFiles = discoveredFiles.length;
        const shouldUseStreaming =
          useStreaming === 'always' ||
          (useStreaming === 'auto' && totalFiles > PARSING.streamingThreshold && chunkSize > 0);

        console.error(`📊 Project has ${totalFiles} files. Streaming: ${shouldUseStreaming ? 'enabled' : 'disabled'}`);

        if (shouldUseStreaming && clearExisting !== false) {
          // Use streaming import for large projects
          console.error(`🚀 Using streaming import with chunk size ${chunkSize}`);
          await debugLog('Using streaming import', { totalFiles, chunkSize });

          // Create Project node BEFORE starting import (status: parsing)
          const projectName = await getProjectName(projectPath);
          await neo4jService.run(UPSERT_PROJECT_QUERY, {
            projectId: resolvedProjectId,
            name: projectName,
            path: resolve(projectPath),
            status: 'parsing',
          });
          await debugLog('Project node created with parsing status', { projectId: resolvedProjectId });

          try {
            // Clear existing project data first
            graphGeneratorHandler.setProjectId(resolvedProjectId);
            await neo4jService.run(QUERIES.CLEAR_PROJECT, { projectId: resolvedProjectId });

            const streamingHandler = new StreamingImportHandler(graphGeneratorHandler);
            const result = await streamingHandler.importProjectStreaming(parser, {
              chunkSize,
              projectId: resolvedProjectId,
            });

            await debugLog('Streaming import completed', result);

            // Ingest config files
            const configResult = await graphGeneratorHandler.ingestConfigFiles(
              projectPath,
              resolvedProjectId,
              configFileGlobs,
              CONFIG_FILE_PATTERNS.excludeGlobs,
              CONFIG_FILE_PATTERNS.maxFileSizeBytes,
            );
            result.nodesImported += configResult.nodesCreated;
            await debugLog('Config file ingestion completed', { nodesCreated: configResult.nodesCreated });

            // Update Project node status to complete
            await neo4jService.run(UPDATE_PROJECT_STATUS_QUERY, {
              projectId: resolvedProjectId,
              status: 'complete',
              nodeCount: result.nodesImported,
              edgeCount: result.edgesImported,
            });
            await debugLog('Project status updated to complete', { projectId: resolvedProjectId });

            return createSuccessResponse(
              `Successfully imported project using streaming mode:\n` +
                `- Project: ${projectName}\n` +
                `- Files processed: ${result.filesProcessed}\n` +
                `- Nodes imported: ${result.nodesImported}\n` +
                `- Edges imported: ${result.edgesImported}\n` +
                `- Chunks: ${result.chunksProcessed}\n` +
                `- Time: ${(result.elapsedMs / 1000).toFixed(2)}s\n` +
                `- Project ID: ${resolvedProjectId}\n\n` +
                `Tip: Use "${projectName}" instead of "${resolvedProjectId}" in other tools.`,
            );
          } catch (streamingError) {
            // Update Project node status to failed
            await neo4jService.run(UPDATE_PROJECT_STATUS_QUERY, {
              projectId: resolvedProjectId,
              status: 'failed',
              nodeCount: 0,
              edgeCount: 0,
            });
            await debugLog('Project status updated to failed', { projectId: resolvedProjectId, error: streamingError });
            throw streamingError;
          }
        }

        // Standard non-streaming import
        // Create Project node BEFORE starting import (status: parsing)
        const projectName = await getProjectName(projectPath);
        await neo4jService.run(UPSERT_PROJECT_QUERY, {
          projectId: resolvedProjectId,
          name: projectName,
          path: resolve(projectPath),
          status: 'parsing',
        });
        await debugLog('Project node created with parsing status', { projectId: resolvedProjectId });

        const graphData = await parseProject({
          neo4jService,
          tsconfigPath,
          projectPath,
          projectId,
          clearExisting,
          projectType,
        });

        const { nodes, edges, savedCrossFileEdges, resolvedProjectId: finalProjectId } = graphData;

        console.error(`Parsed ${nodes.length} nodes / ${edges.length} edges for project ${finalProjectId}`);
        await debugLog('Parsing completed', {
          nodeCount: nodes.length,
          edgeCount: edges.length,
          projectId: finalProjectId,
        });

        const outputPath = join(projectPath, FILE_PATHS.graphOutput);
        writeFileSync(outputPath, JSON.stringify(graphData, null, LOG_CONFIG.jsonIndentation));
        console.error(`Graph data written to ${outputPath}`);

        try {
          // Set projectId for project-scoped operations (clear, indexes)
          graphGeneratorHandler.setProjectId(finalProjectId);
          const result = await graphGeneratorHandler.generateGraph(outputPath, DEFAULTS.batchSize, clearExisting);

          // Recreate cross-file edges after incremental parse
          if (!clearExisting && savedCrossFileEdges.length > 0) {
            await debugLog('Recreating cross-file edges', { edgesToRecreate: savedCrossFileEdges.length });
            const recreateResult = await neo4jService.run(QUERIES.RECREATE_CROSS_FILE_EDGES, {
              edges: savedCrossFileEdges,
              projectId: finalProjectId,
            });
            const recreatedCount = recreateResult[0]?.recreatedCount ?? 0;
            await debugLog('Cross-file edges recreated', { recreatedCount, expected: savedCrossFileEdges.length });
          }

          console.error('Graph generation completed:', result);
          await debugLog('Neo4j import completed', result);

          // Ingest config files
          const configResult = await graphGeneratorHandler.ingestConfigFiles(
            projectPath,
            finalProjectId,
            configFileGlobs,
            CONFIG_FILE_PATTERNS.excludeGlobs,
            CONFIG_FILE_PATTERNS.maxFileSizeBytes,
          );
          result.nodesImported += configResult.nodesCreated;
          await debugLog('Config file ingestion completed', { nodesCreated: configResult.nodesCreated });

          // Update Project node status to complete
          await neo4jService.run(UPDATE_PROJECT_STATUS_QUERY, {
            projectId: finalProjectId,
            status: 'complete',
            nodeCount: result.nodesImported,
            edgeCount: result.edgesImported,
          });
          await debugLog('Project status updated to complete', { projectId: finalProjectId });

          // Start file watcher if requested (only in synchronous mode)
          let watchMessage = '';
          if (watch && !asyncMode) {
            try {
              const watcherInfo = await watchManager.startWatching({
                projectPath,
                projectId: finalProjectId,
                tsconfigPath,
                debounceMs: watchDebounceMs,
              });
              await debugLog('File watcher started', { projectId: finalProjectId, status: watcherInfo.status });
              watchMessage = `\n\nFile watcher started (debounce: ${watchDebounceMs}ms). Graph will auto-update on file changes.`;
            } catch (watchError) {
              console.error('Failed to start file watcher:', watchError);
              await debugLog('File watcher failed to start', { error: watchError });
              watchMessage = `\n\nWarning: Failed to start file watcher: ${watchError instanceof Error ? watchError.message : String(watchError)}`;
            }
          }

          // Add watcher tip if not already watching
          const watcherTip =
            watch && !asyncMode
              ? ''
              : `\n\nTip: Use start_watch_project to automatically update the graph when files change.`;

          return createSuccessResponse(
            formatParseSuccess(nodes.length, edges.length, result) +
              `\n\nTip: Use "${projectName}" instead of "${finalProjectId}" in other tools.` +
              watcherTip +
              watchMessage,
          );
        } catch (neo4jError) {
          console.error('Neo4j import failed:', neo4jError);
          await debugLog('Neo4j import failed', neo4jError);

          // Update Project node status to failed
          await neo4jService.run(UPDATE_PROJECT_STATUS_QUERY, {
            projectId: finalProjectId,
            status: 'failed',
            nodeCount: 0,
            edgeCount: 0,
          });
          await debugLog('Project status updated to failed', { projectId: finalProjectId });

          // Stop sidecar to free memory (restarts lazily on next embed request)
          await stopEmbeddingSidecar();

          return createSuccessResponse(
            formatParsePartialSuccess(nodes.length, edges.length, outputPath, neo4jError.message),
          );
        }
      } catch (error) {
        console.error('Parse tool error:', error);
        await debugLog('Parse tool error', { projectPath, tsconfigPath, error });
        // Stop sidecar to free memory (restarts lazily on next embed request)
        await stopEmbeddingSidecar();
        return createErrorResponse(error);
      }
    },
  );
};

interface ParseProjectOptions {
  neo4jService: Neo4jService;
  tsconfigPath: string;
  projectPath: string;
  projectId?: string;
  clearExisting?: boolean;
  projectType?: string;
}

interface ParseProjectResult {
  nodes: any[];
  edges: any[];
  savedCrossFileEdges: CrossFileEdge[];
  resolvedProjectId: string;
  metadata: {
    coreSchema: string;
    frameworkSchemas: string[];
    projectType: string;
    projectId: string;
    generated: string;
    incremental?: {
      filesReparsed: number;
      filesDeleted: number;
    };
  };
}

const parseProject = async (options: ParseProjectOptions): Promise<ParseProjectResult> => {
  const { neo4jService, tsconfigPath, projectPath, projectId, clearExisting = true, projectType = 'auto' } = options;

  // Resolve projectId early - needed for incremental queries before parser is created
  const resolvedId = resolveProjectId(projectPath, projectId);

  // Use lazyLoad = true for consistent glob-based file discovery (matches incremental parse)
  const parser =
    projectType === 'auto'
      ? await ParserFactory.createParserWithAutoDetection(projectPath, tsconfigPath, resolvedId, true)
      : ParserFactory.createParser({
          workspacePath: projectPath,
          tsConfigPath: tsconfigPath,
          projectType: projectType as ProjectType,
          projectId: resolvedId,
          lazyLoad: true,
        });

  let incrementalStats: { filesReparsed: number; filesDeleted: number } | undefined;

  let savedCrossFileEdges: CrossFileEdge[] = [];

  if (clearExisting) {
    // Full rebuild: parse all files
    await parser.parseWorkspace();
  } else {
    // Incremental: detect changes and parse only affected files
    const { filesToReparse, filesToDelete } = await detectChangedFiles(projectPath, neo4jService, resolvedId);
    incrementalStats = { filesReparsed: filesToReparse.length, filesDeleted: filesToDelete.length };

    await debugLog('Incremental change detection', { filesToReparse, filesToDelete });

    const filesToRemoveFromGraph = [...filesToDelete, ...filesToReparse];
    if (filesToRemoveFromGraph.length > 0) {
      // Save cross-file edges before deletion (they'll be recreated after import)
      savedCrossFileEdges = await getCrossFileEdges(neo4jService, filesToRemoveFromGraph, resolvedId);
      await debugLog('Saved cross-file edges', { count: savedCrossFileEdges.length, edges: savedCrossFileEdges });

      await deleteSourceFileSubgraphs(neo4jService, filesToRemoveFromGraph, resolvedId);
    }

    if (filesToReparse.length > 0) {
      await debugLog('Incremental parse starting', {
        filesChanged: filesToReparse.length,
        filesDeleted: filesToDelete.length,
      });

      // Load existing nodes from Neo4j for edge target matching
      const existingNodes = await loadExistingNodesForEdgeDetection(neo4jService, filesToRemoveFromGraph, resolvedId);
      await debugLog('Loaded existing nodes for edge detection', { count: existingNodes.length });
      parser.setExistingNodes(existingNodes);

      await parser.parseWorkspace(filesToReparse);
    } else {
      await debugLog('Incremental parse: no changes detected');
    }
  }

  const { nodes, edges } = parser.exportToJson();
  const frameworkSchemas = parser['frameworkSchemas']?.map((s: any) => s.name) ?? ['Auto-detected'];
  const resolvedProjectId = parser.getProjectId();

  return {
    nodes,
    edges,
    savedCrossFileEdges,
    resolvedProjectId,
    metadata: {
      coreSchema: CORE_TYPESCRIPT_SCHEMA.name,
      frameworkSchemas,
      projectType,
      projectId: resolvedProjectId,
      generated: new Date().toISOString(),
      ...(incrementalStats && { incremental: incrementalStats }),
    },
  };
};
