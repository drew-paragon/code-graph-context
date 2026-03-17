/**
 * Traverse From Node Tool
 * Deep graph traversal from a specific node with pagination support
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { MAX_TRAVERSAL_DEPTH } from '../../constants.js';
import { Neo4jService } from '../../storage/neo4j/neo4j.service.js';
import { TOOL_NAMES, TOOL_METADATA, DEFAULTS } from '../constants.js';
import { TraversalHandler } from '../handlers/traversal.handler.js';
import { createErrorResponse, sanitizeNumericInput, debugLog, resolveProjectIdOrError } from '../utils.js';

export const createTraverseFromNodeTool = (server: McpServer): void => {
  server.registerTool(
    TOOL_NAMES.traverseFromNode,
    {
      title: TOOL_METADATA[TOOL_NAMES.traverseFromNode].title,
      description: TOOL_METADATA[TOOL_NAMES.traverseFromNode].description,
      inputSchema: {
        projectId: z.string().describe('Project ID, name, or path (e.g., "backend" or "proj_a1b2c3d4e5f6")'),
        nodeId: z
          .string()
          .optional()
          .describe('The node ID to start traversal from (required if filePath not provided)'),
        filePath: z
          .string()
          .optional()
          .describe('File path to start traversal from (alternative to nodeId - finds the SourceFile node)'),
        maxDepth: z
          .number()
          .int()
          .optional()
          .describe('Maximum relationship traversal depth')
          .default(DEFAULTS.traversalDepth),
        skip: z
          .number()
          .int()
          .optional()
          .describe('Results to skip for pagination')
          .default(DEFAULTS.skipOffset),
        direction: z
          .enum(['OUTGOING', 'INCOMING', 'BOTH'])
          .optional()
          .describe(
            'Filter by relationship direction: OUTGOING (what this calls), INCOMING (who calls this), BOTH (default)',
          )
          .default('BOTH'),
        relationshipTypes: z
          .array(z.string())
          .optional()
          .describe(
            'Filter by specific relationship types (e.g., ["INJECTS", "USES_REPOSITORY"]). If not specified, shows all relationships.',
          ),
        displayOptions: z
          .object({
            includeCode: z.boolean().optional().default(true).describe('Include source code snippets'),
            snippetLength: z
              .number()
              .int()
              .optional()
              .default(DEFAULTS.codeSnippetLength)
              .describe('Code snippet character limit'),
            summaryOnly: z.boolean().optional().default(false).describe('Return only file paths and statistics'),
            maxNodesPerChain: z.number().int().optional().default(5).describe('Maximum chains per depth level'),
            maxTotalNodes: z.number().int().optional().default(50).describe('Maximum unique nodes across all depths'),
            limit: z.number().int().optional().default(50).describe('Maximum results per page'),
          })
          .optional()
          .describe('Output formatting options (all have sensible defaults)'),
      },
    },
    async ({
      projectId,
      nodeId,
      filePath,
      maxDepth = DEFAULTS.traversalDepth,
      skip = DEFAULTS.skipOffset,
      direction = 'BOTH',
      relationshipTypes,
      displayOptions,
    }) => {
      const {
        includeCode = true,
        snippetLength = DEFAULTS.codeSnippetLength,
        summaryOnly = false,
        maxNodesPerChain = 5,
        maxTotalNodes = 50,
        limit = 50,
      } = displayOptions ?? {};

      // Validate that either nodeId or filePath is provided
      if (!nodeId && !filePath) {
        return createErrorResponse('Either nodeId or filePath must be provided.');
      }

      const neo4jService = new Neo4jService();
      try {
        // Resolve project ID from name, path, or ID
        const projectResult = await resolveProjectIdOrError(projectId, neo4jService);
        if (!projectResult.success) return projectResult.error;
        const resolvedProjectId = projectResult.projectId;

        const traversalHandler = new TraversalHandler(neo4jService);

        // If filePath is provided, resolve it to a nodeId
        let resolvedNodeId: string | undefined = nodeId;
        if (!resolvedNodeId && filePath) {
          const fileNodeId = await traversalHandler.resolveNodeIdFromFilePath(filePath, resolvedProjectId);
          if (!fileNodeId) {
            // Try to provide helpful suggestions
            const fileName = filePath.split('/').pop() ?? filePath;
            return createErrorResponse(
              `No SourceFile node found for "${filePath}" in project "${resolvedProjectId}".\n\n` +
                `Suggestions:\n` +
                `- Use the full absolute path (e.g., /Users/.../src/file.ts)\n` +
                `- Use just the filename (e.g., "${fileName}")\n` +
                `- Use search_codebase to find the correct node ID first\n` +
                `- Run list_projects to verify the project exists`,
            );
          }
          resolvedNodeId = fileNodeId;
        }

        const sanitizedMaxDepth = sanitizeNumericInput(maxDepth, DEFAULTS.traversalDepth, MAX_TRAVERSAL_DEPTH);
        const sanitizedSkip = sanitizeNumericInput(skip, DEFAULTS.skipOffset);

        // Safety check - resolvedNodeId should be set at this point
        if (!resolvedNodeId) {
          return createErrorResponse('Could not resolve node ID from provided parameters.');
        }

        return await traversalHandler.traverseFromNode(resolvedNodeId, [], {
          projectId: resolvedProjectId,
          maxDepth: sanitizedMaxDepth,
          skip: sanitizedSkip,
          limit,
          direction,
          relationshipTypes,
          includeStartNodeDetails: true,
          includeCode,
          maxNodesPerChain,
          summaryOnly,
          snippetLength,
          maxTotalNodes,
          title: filePath ? `File Traversal from: ${filePath}` : `Node Traversal from: ${resolvedNodeId}`,
        });
      } catch (error) {
        console.error('Node traversal error:', error);
        await debugLog('Node traversal error', { nodeId, filePath, error });
        return createErrorResponse(error);
      } finally {
        await neo4jService.close();
      }
    },
  );
};
