/**
 * Incremental Parse Handler
 * Handles incremental graph updates triggered by file watchers
 */

import { writeFileSync, unlinkSync } from 'fs';
import { join } from 'path';

import { CORE_TYPESCRIPT_SCHEMA } from '../../core/config/schema.js';
import { EmbeddingsService } from '../../core/embeddings/embeddings.service.js';
import { ParserFactory } from '../../core/parsers/parser-factory.js';
import { detectChangedFiles } from '../../core/utils/file-change-detection.js';
import { resolveProjectId, getProjectName, UPSERT_PROJECT_QUERY } from '../../core/utils/project-id.js';
import { Neo4jService, QUERIES } from '../../storage/neo4j/neo4j.service.js';
import { DEFAULTS, FILE_PATHS, LOG_CONFIG } from '../constants.js';
import { debugLog } from '../utils.js';

import {
  CrossFileEdge,
  deleteSourceFileSubgraphs,
  loadExistingNodesForEdgeDetection,
  getCrossFileEdges,
} from './cross-file-edge.helpers.js';
import { GraphGeneratorHandler } from './graph-generator.handler.js';

interface IncrementalParseResult {
  nodesUpdated: number;
  edgesUpdated: number;
  filesReparsed: number;
  filesDeleted: number;
}

/**
 * Performs incremental parsing for a project
 * This is used by the WatchManager when files change
 */
export const performIncrementalParse = async (
  projectPath: string,
  projectId: string,
  tsconfigPath: string,
): Promise<IncrementalParseResult> => {
  const neo4jService = new Neo4jService();
  const embeddingsService = new EmbeddingsService();
  const graphHandler = new GraphGeneratorHandler(neo4jService, embeddingsService);

  try {
    await debugLog('Incremental parse started', { projectPath, projectId });

    // Resolve project ID
    const resolvedId = resolveProjectId(projectPath, projectId);
    const projectName = await getProjectName(projectPath);

    // Create parser with auto-detection and lazy loading enabled for memory efficiency
    const parser = await ParserFactory.createParserWithAutoDetection(projectPath, tsconfigPath, resolvedId, true);

    // Detect changed files
    const { filesToReparse, filesToDelete } = await detectChangedFiles(projectPath, neo4jService, resolvedId);

    await debugLog('Incremental change detection', {
      filesToReparse: filesToReparse.length,
      filesToDelete: filesToDelete.length,
    });

    // If no changes, return early
    if (filesToReparse.length === 0 && filesToDelete.length === 0) {
      await debugLog('Incremental parse: no changes, returning early', {});
      return {
        nodesUpdated: 0,
        edgesUpdated: 0,
        filesReparsed: 0,
        filesDeleted: filesToDelete.length,
      };
    }

    await debugLog('Incremental parse: changes detected, continuing', { filesToReparse: filesToReparse.length });

    let savedCrossFileEdges: CrossFileEdge[] = [];
    const filesToRemoveFromGraph = [...filesToDelete, ...filesToReparse];

    if (filesToRemoveFromGraph.length > 0) {
      await debugLog('Incremental parse: getting cross-file edges', { count: filesToRemoveFromGraph.length });
      // Save cross-file edges before deletion
      savedCrossFileEdges = await getCrossFileEdges(neo4jService, filesToRemoveFromGraph, resolvedId);
      await debugLog('Incremental parse: got cross-file edges', { savedCount: savedCrossFileEdges.length });

      await debugLog('Incremental parse: deleting old subgraphs', {});
      // Delete old subgraphs
      await deleteSourceFileSubgraphs(neo4jService, filesToRemoveFromGraph, resolvedId);
      await debugLog('Incremental parse: deleted old subgraphs', {});
    }

    let nodesImported = 0;
    let edgesImported = 0;

    if (filesToReparse.length > 0) {
      await debugLog('Incremental parse: loading existing nodes', {});
      // Load existing nodes for edge detection
      const existingNodes = await loadExistingNodesForEdgeDetection(neo4jService, filesToRemoveFromGraph, resolvedId);
      await debugLog('Incremental parse: loaded existing nodes', { count: existingNodes.length });
      parser.setExistingNodes(existingNodes);

      await debugLog('Incremental parse: parsing workspace', { fileCount: filesToReparse.length });
      // Parse only changed files
      await parser.parseWorkspace(filesToReparse);
      await debugLog('Incremental parse: parsed workspace', {});

      // Export graph data
      await debugLog('Incremental parse: exporting to JSON', {});
      const { nodes, edges } = parser.exportToJson();
      await debugLog('Incremental parse: exported to JSON', { nodeCount: nodes.length, edgeCount: edges.length });

      // Get framework schemas if available (use unknown as intermediate to access private property)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const parserAny = parser as any;
      const frameworkSchemas: string[] = Array.isArray(parserAny.frameworkSchemas)
        ? parserAny.frameworkSchemas.map((s: { name: string }) => s.name)
        : ['Auto-detected'];

      const graphData = {
        nodes,
        edges,
        metadata: {
          coreSchema: CORE_TYPESCRIPT_SCHEMA.name,
          frameworkSchemas,
          projectType: 'auto',
          projectId: resolvedId,
          generated: new Date().toISOString(),
        },
      };

      // Write to JSON file (required by GraphGeneratorHandler)
      await debugLog('Incremental parse: writing JSON file', {});
      const outputPath = join(projectPath, FILE_PATHS.graphOutput);
      writeFileSync(outputPath, JSON.stringify(graphData, null, LOG_CONFIG.jsonIndentation));
      await debugLog('Incremental parse: wrote JSON file', { outputPath });

      // Update Project node
      await debugLog('Incremental parse: updating project node', {});
      await neo4jService.run(UPSERT_PROJECT_QUERY, {
        projectId: resolvedId,
        path: projectPath,
        name: projectName,
        status: 'complete',
      });
      await debugLog('Incremental parse: updated project node', {});

      // Import nodes and edges (clearExisting = false for incremental)
      await debugLog('Incremental parse: starting graph import', {});
      graphHandler.setProjectId(resolvedId);
      try {
        const result = await graphHandler.generateGraph(outputPath, false);
        nodesImported = result.nodesImported;
        edgesImported = result.edgesImported;
        await debugLog('Incremental parse: graph import completed', { nodesImported, edgesImported });
      } finally {
        // Clean up temporary graph.json file
        try {
          unlinkSync(outputPath);
          await debugLog('Incremental parse: cleaned up temp file', {});
        } catch {
          // Ignore cleanup errors - file may not exist or be inaccessible
        }
      }

      // Recreate cross-file edges
      if (savedCrossFileEdges.length > 0) {
        const recreateResult = await neo4jService.run(QUERIES.RECREATE_CROSS_FILE_EDGES, {
          projectId: resolvedId,
          edges: savedCrossFileEdges.map((e) => ({
            startNodeId: e.startNodeId,
            endNodeId: e.endNodeId,
            edgeType: e.edgeType,
            edgeProperties: e.edgeProperties,
          })),
        });
        // Safely extract recreatedCount with runtime validation
        const firstResult = recreateResult[0];
        const recreatedCount =
          firstResult && typeof firstResult === 'object' && 'recreatedCount' in firstResult
            ? Number(firstResult.recreatedCount) || 0
            : 0;
        edgesImported += recreatedCount;
      }
    }

    await debugLog('Incremental parse completed', {
      nodesImported,
      edgesImported,
      filesReparsed: filesToReparse.length,
      filesDeleted: filesToDelete.length,
    });

    return {
      nodesUpdated: nodesImported,
      edgesUpdated: edgesImported,
      filesReparsed: filesToReparse.length,
      filesDeleted: filesToDelete.length,
    };
  } finally {
    await neo4jService.close();
  }
};
