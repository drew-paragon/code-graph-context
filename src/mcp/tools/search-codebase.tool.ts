/**
 * Search Codebase Tool
 * Semantic search using vector embeddings to find relevant code
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { EmbeddingsService } from '../../core/embeddings/embeddings.service.js';
import { Neo4jService, QUERIES } from '../../storage/neo4j/neo4j.service.js';
import { TOOL_NAMES, TOOL_METADATA, DEFAULTS } from '../constants.js';
import { TraversalHandler } from '../handlers/traversal.handler.js';
import {
  createEmptyResponse,
  createErrorResponse,
  createSuccessResponse,
  debugLog,
  sanitizeNumericInput,
  resolveProjectIdOrError,
} from '../utils.js';

export const createSearchCodebaseTool = (server: McpServer): void => {
  server.registerTool(
    TOOL_NAMES.searchCodebase,
    {
      title: TOOL_METADATA[TOOL_NAMES.searchCodebase].title,
      description: TOOL_METADATA[TOOL_NAMES.searchCodebase].description,
      inputSchema: {
        projectId: z.string().describe('Project ID, name, or path (e.g., "backend" or "proj_a1b2c3d4e5f6")'),
        query: z.string().describe('Natural language query to search the codebase'),
        maxDepth: z
          .number()
          .int()
          .optional()
          .describe('Maximum relationship traversal depth')
          .default(DEFAULTS.traversalDepth),
        maxNodesPerChain: z
          .number()
          .int()
          .optional()
          .describe('Maximum chains to show per depth level')
          .default(5),
        skip: z.number().int().optional().describe('Results to skip for pagination').default(0),
        includeCode: z
          .boolean()
          .optional()
          .describe('Include source code snippets in results')
          .default(true),
        snippetLength: z
          .number()
          .int()
          .optional()
          .describe('Code snippet character limit')
          .default(DEFAULTS.codeSnippetLength),
        topK: z
          .number()
          .int()
          .optional()
          .describe('Number of top vector matches; best match is traversed, others shown as alternatives')
          .default(3),
        minSimilarity: z
          .number()
          .optional()
          .describe('Minimum similarity score threshold')
          .default(0.65),
        useWeightedTraversal: z
          .boolean()
          .optional()
          .describe('Score each traversed node for relevance; higher quality but slower')
          .default(true),
      },
    },
    async ({
      projectId,
      query,
      maxDepth = DEFAULTS.traversalDepth,
      maxNodesPerChain = 5,
      skip = 0,
      includeCode = true,
      snippetLength = DEFAULTS.codeSnippetLength,
      topK = 3,
      minSimilarity = 0.65,
      useWeightedTraversal = true,
    }) => {
      const neo4jService = new Neo4jService();
      try {
        // Resolve project ID from name, path, or ID
        const projectResult = await resolveProjectIdOrError(projectId, neo4jService);
        if (!projectResult.success) return projectResult.error;
        const resolvedProjectId = projectResult.projectId;

        // Sanitize numeric inputs to ensure integers (Neo4j LIMIT requires integers)
        const sanitizedMaxDepth = sanitizeNumericInput(maxDepth, DEFAULTS.traversalDepth, 10);
        const sanitizedMaxNodesPerChain = sanitizeNumericInput(maxNodesPerChain, 5);
        const sanitizedSkip = sanitizeNumericInput(skip, 0);
        const sanitizedSnippetLength = sanitizeNumericInput(snippetLength, DEFAULTS.codeSnippetLength);
        const sanitizedTopK = sanitizeNumericInput(topK, 3, 10);

        const embeddingsService = new EmbeddingsService();
        const traversalHandler = new TraversalHandler(neo4jService);

        const embedding = await embeddingsService.embedText(query);

        const vectorResults = await neo4jService.run(QUERIES.VECTOR_SEARCH, {
          limit: sanitizedTopK,
          embedding,
          projectId: resolvedProjectId,
          fetchMultiplier: 10,
          minSimilarity,
        });

        if (vectorResults.length === 0) {
          return createEmptyResponse(
            `No code found with similarity >= ${minSimilarity}`,
            'Try rephrasing your query or lowering the minSimilarity threshold.',
          );
        }

        // Filter results that meet the similarity threshold
        const qualifiedResults = vectorResults.filter((r: { score: number }) => r.score >= minSimilarity);

        if (qualifiedResults.length === 0) {
          const bestScore = vectorResults[0].score;
          return createEmptyResponse(
            `No sufficiently relevant code found (best match: ${bestScore.toFixed(3)}, threshold: ${minSimilarity})`,
            'Try rephrasing your query or lowering minSimilarity.',
          );
        }

        // Best match — traverse from this node
        const bestMatch = qualifiedResults[0];
        const nodeId = bestMatch.node.properties.id;
        const bestScore = bestMatch.score.toFixed(3);

        // Build alternative matches summary for the response
        const alternatives = qualifiedResults.slice(1);
        const altLines = alternatives.map(
          (r: { node: { properties: { id: string; name?: string; filePath?: string } }; score: number }) => {
            const props = r.node.properties;
            const name = props.name ?? props.id;
            const file = props.filePath ? ` (${props.filePath})` : '';
            return `  - ${name}${file} [score: ${r.score.toFixed(3)}, id: ${props.id}]`;
          },
        );

        const altSection =
          altLines.length > 0
            ? `\n\nAlternative matches (use traverse_from_node to explore):\n${altLines.join('\n')}`
            : '';

        const traversalResult = await traversalHandler.traverseFromNode(nodeId, embedding, {
          projectId: resolvedProjectId,
          maxDepth: sanitizedMaxDepth,
          direction: 'BOTH',
          includeCode,
          maxNodesPerChain: sanitizedMaxNodesPerChain,
          skip: sanitizedSkip,
          summaryOnly: false,
          snippetLength: sanitizedSnippetLength,
          title: `Search Results (${qualifiedResults.length} matches, best: ${bestScore}) - Traversing from: ${nodeId}`,
          useWeightedTraversal,
        });

        // Append alternatives to the traversal response
        if (altSection && traversalResult.content?.[0]?.type === 'text') {
          traversalResult.content[0].text += altSection;
        }

        return traversalResult;
      } catch (error) {
        console.error('Search codebase error:', error);
        await debugLog('Search codebase error', error);
        return createErrorResponse(error);
      } finally {
        await neo4jService.close();
      }
    },
  );
};
