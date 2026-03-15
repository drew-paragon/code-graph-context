/**
 * Parse Coordinator
 * Runs TypeScript parsing in a separate thread to avoid blocking the MCP server.
 * For large projects, spawns a worker pool for parallel chunk parsing.
 */

import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { parentPort, workerData } from 'worker_threads';

// Load environment variables in worker thread
import dotenv from 'dotenv';
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
dotenv.config({ path: join(__dirname, '..', '..', '..', '.env') });

import { EmbeddingsService } from '../../core/embeddings/embeddings.service.js';
import { ParserFactory, ProjectType } from '../../core/parsers/parser-factory.js';
import { StreamingParser } from '../../core/parsers/typescript-parser.js';
import { WorkspaceParser } from '../../core/parsers/workspace-parser.js';
import { debugLog } from '../../core/utils/file-utils.js';
import { ProgressCallback } from '../../core/utils/progress-reporter.js';
import { getProjectName, UPSERT_PROJECT_QUERY, UPDATE_PROJECT_STATUS_QUERY } from '../../core/utils/project-id.js';
import { WorkspaceDetector } from '../../core/workspace/index.js';
import { Neo4jService, QUERIES } from '../../storage/neo4j/neo4j.service.js';
import { PARSING, CONFIG_FILE_PATTERNS } from '../constants.js';
import { GraphGeneratorHandler } from '../handlers/graph-generator.handler.js';
import { ParallelImportHandler } from '../handlers/parallel-import.handler.js';
import { StreamingImportHandler } from '../handlers/streaming-import.handler.js';

interface WorkerData {
  projectPath: string;
  tsconfigPath: string;
  projectId: string;
  projectType: string;
  chunkSize: number;
  configFileGlobs?: string[];
}

interface ProgressMessage {
  type: 'progress';
  data: {
    phase: string;
    filesProcessed: number;
    filesTotal: number;
    nodesImported: number;
    edgesImported: number;
    currentChunk: number;
    totalChunks: number;
  };
}

interface CompleteMessage {
  type: 'complete';
  data: {
    nodesImported: number;
    edgesImported: number;
    elapsedMs: number;
  };
}

interface ErrorMessage {
  type: 'error';
  error: string;
}

type WorkerMessage = ProgressMessage | CompleteMessage | ErrorMessage;

const sendMessage = (msg: WorkerMessage): void => {
  parentPort?.postMessage(msg);
};

const sendProgress = (
  phase: string,
  filesProcessed: number,
  filesTotal: number,
  nodesImported: number,
  edgesImported: number,
  currentChunk: number,
  totalChunks: number,
): void => {
  sendMessage({
    type: 'progress',
    data: { phase, filesProcessed, filesTotal, nodesImported, edgesImported, currentChunk, totalChunks },
  });
};

const runParser = async (): Promise<void> => {
  const config = workerData as WorkerData;
  const startTime = Date.now();

  let resolvedProjectId: string = config.projectId;
  let neo4jService: Neo4jService | null = null;

  try {
    sendProgress('discovery', 0, 0, 0, 0, 0, 0);

    neo4jService = new Neo4jService();
    const embeddingsService = new EmbeddingsService();
    const graphGeneratorHandler = new GraphGeneratorHandler(neo4jService, embeddingsService);

    const lazyLoad = true;

    const workspaceDetector = new WorkspaceDetector();
    await debugLog('Detecting workspace', { projectPath: config.projectPath });
    const workspaceConfig = await workspaceDetector.detect(config.projectPath);
    await debugLog('Workspace detection result', {
      type: workspaceConfig.type,
      rootPath: workspaceConfig.rootPath,
      packageCount: workspaceConfig.packages.length,
    });

    let detectedProjectType: ProjectType;
    if (config.projectType === 'auto') {
      detectedProjectType = await ParserFactory.detectProjectType(config.projectPath);
      await debugLog('Auto-detected project type', { projectType: detectedProjectType });
    } else {
      detectedProjectType = config.projectType as ProjectType;
    }

    let parser: StreamingParser;

    if (workspaceConfig.type !== 'single' && workspaceConfig.packages.length > 1) {
      await debugLog('Using WorkspaceParser', {
        type: workspaceConfig.type,
        packageCount: workspaceConfig.packages.length,
      });
      parser = new WorkspaceParser(workspaceConfig, config.projectId, lazyLoad, detectedProjectType);
      resolvedProjectId = parser.getProjectId();
    } else {
      await debugLog('Using single project mode');
      parser = ParserFactory.createParser({
        workspacePath: config.projectPath,
        tsConfigPath: config.tsconfigPath,
        projectType: detectedProjectType,
        projectId: config.projectId,
        lazyLoad,
      });
      resolvedProjectId = parser.getProjectId();
    }

    const sourceFiles = await parser.discoverSourceFiles();
    const totalFiles = sourceFiles.length;
    const chunkSize = config.chunkSize > 0 ? config.chunkSize : PARSING.defaultChunkSize;

    graphGeneratorHandler.setProjectId(resolvedProjectId);
    await neo4jService.run(QUERIES.CLEAR_PROJECT, { projectId: resolvedProjectId });

    const projectName = await getProjectName(config.projectPath);
    await neo4jService.run(UPSERT_PROJECT_QUERY, {
      projectId: resolvedProjectId,
      name: projectName,
      path: config.projectPath,
      status: 'parsing',
    });
    await debugLog('Project node created', { projectId: resolvedProjectId, name: projectName });

    let totalNodesImported = 0;
    let totalEdgesImported = 0;

    const onProgress: ProgressCallback = async (progress) => {
      sendProgress(
        progress.phase,
        progress.current,
        progress.total,
        progress.details?.nodesCreated ?? 0,
        progress.details?.edgesCreated ?? 0,
        progress.details?.chunkIndex ?? 0,
        progress.details?.totalChunks ?? 0,
      );
    };

    const useParallel = totalFiles >= PARSING.parallelThreshold;

    if (useParallel) {
      await debugLog('Using parallel parsing', { totalFiles });
      const parallelHandler = new ParallelImportHandler(graphGeneratorHandler);
      const result = await parallelHandler.importProjectParallel(parser, sourceFiles, {
        chunkSize,
        projectId: resolvedProjectId,
        projectPath: config.projectPath,
        tsconfigPath: config.tsconfigPath,
        projectType: detectedProjectType,
        onProgress,
      });

      totalNodesImported = result.nodesImported;
      totalEdgesImported = result.edgesImported;
    } else {
      await debugLog('Using sequential parsing', { totalFiles });
      const streamingHandler = new StreamingImportHandler(graphGeneratorHandler);
      const result = await streamingHandler.importProjectStreaming(parser, {
        chunkSize,
        projectId: resolvedProjectId,
        onProgress,
      });

      totalNodesImported = result.nodesImported;
      totalEdgesImported = result.edgesImported;
    }

    // Ingest config files (JSON, YAML, Dockerfiles, etc.)
    const configGlobs = config.configFileGlobs ?? CONFIG_FILE_PATTERNS.defaultGlobs;
    const configResult = await graphGeneratorHandler.ingestConfigFiles(
      config.projectPath,
      resolvedProjectId,
      configGlobs,
      CONFIG_FILE_PATTERNS.excludeGlobs,
      CONFIG_FILE_PATTERNS.maxFileSizeBytes,
    );
    totalNodesImported += configResult.nodesCreated;
    await debugLog('Config file ingestion completed', { nodesCreated: configResult.nodesCreated });

    await neo4jService.run(UPDATE_PROJECT_STATUS_QUERY, {
      projectId: resolvedProjectId,
      status: 'complete',
      nodeCount: totalNodesImported,
      edgeCount: totalEdgesImported,
    });
    await debugLog('Project node updated', {
      projectId: resolvedProjectId,
      status: 'complete',
      nodeCount: totalNodesImported,
      edgeCount: totalEdgesImported,
    });

    sendMessage({
      type: 'complete',
      data: {
        nodesImported: totalNodesImported,
        edgesImported: totalEdgesImported,
        elapsedMs: Date.now() - startTime,
      },
    });
  } catch (error: any) {
    try {
      const serviceForUpdate = neo4jService ?? new Neo4jService();
      await serviceForUpdate.run(UPDATE_PROJECT_STATUS_QUERY, {
        projectId: resolvedProjectId,
        status: 'failed',
        nodeCount: 0,
        edgeCount: 0,
      });
      if (!neo4jService) {
        await serviceForUpdate.close();
      }
    } catch {
      // Ignore errors updating project status on failure
    }

    sendMessage({
      type: 'error',
      error: error.message ?? String(error),
    });
  } finally {
    if (neo4jService) {
      try {
        await neo4jService.close();
      } catch {
        // Ignore cleanup errors
      }
    }
  }
};

runParser().catch((err) => {
  sendMessage({
    type: 'error',
    error: err.message ?? String(err),
  });
});
