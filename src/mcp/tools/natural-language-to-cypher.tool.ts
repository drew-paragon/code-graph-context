/**
 * Natural Language to Cypher Tool
 * Converts natural language queries to Cypher using OpenAI GPT-4
 */

import { join } from 'path';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { NaturalLanguageToCypherService } from '../../core/embeddings/natural-language-to-cypher.service.js';
import { Neo4jService } from '../../storage/neo4j/neo4j.service.js';
import { TOOL_NAMES, TOOL_METADATA, MESSAGES, FILE_PATHS } from '../constants.js';
import {
  createEmptyResponse,
  createErrorResponse,
  createSuccessResponse,
  formatQueryResults,
  debugLog,
  resolveProjectIdOrError,
} from '../utils.js';

// Service instance - initialized asynchronously
let naturalLanguageToCypherService: NaturalLanguageToCypherService | null = null;

/**
 * Initialize the Natural Language to Cypher service
 */
export const initializeNaturalLanguageService = async (): Promise<void> => {
  try {
    const service = new NaturalLanguageToCypherService();
    // Use same path as service-init.ts writes to (process.cwd())
    const schemaPath = join(process.cwd(), FILE_PATHS.schemaOutput);

    await service.getOrCreateAssistant(schemaPath);
    naturalLanguageToCypherService = service;

    await debugLog('Natural Language to Cypher service initialized successfully');
  } catch (error) {
    await debugLog('Failed to initialize Natural Language to Cypher service', error);
    naturalLanguageToCypherService = null;
  }
};

export const createNaturalLanguageToCypherTool = (server: McpServer): void => {
  server.registerTool(
    TOOL_NAMES.naturalLanguageToCypher,
    {
      title: TOOL_METADATA[TOOL_NAMES.naturalLanguageToCypher].title,
      description: TOOL_METADATA[TOOL_NAMES.naturalLanguageToCypher].description,
      inputSchema: {
        projectId: z.string().describe('Project ID, name, or path (e.g., "backend" or "proj_a1b2c3d4e5f6")'),
        query: z.string().describe('Natural language query to convert to Cypher'),
      },
    },
    async ({ projectId, query }) => {
      const neo4jService = new Neo4jService();
      try {
        // Resolve project ID from name, path, or ID
        const projectResult = await resolveProjectIdOrError(projectId, neo4jService);
        if (!projectResult.success) return projectResult.error;
        const resolvedProjectId = projectResult.projectId;

        if (!naturalLanguageToCypherService) {
          await debugLog('Natural language service not available', { projectId: resolvedProjectId, query });
          return createEmptyResponse(
            'natural_language_to_cypher requires OPENAI_API_KEY',
            'Set OPENAI_API_KEY and restart the MCP server to enable this tool.',
          );
        }

        const cypherResult = await naturalLanguageToCypherService.promptToQuery(query, resolvedProjectId);

        // Validate Cypher syntax using EXPLAIN (no execution, just parse)
        const parameters = { ...cypherResult.parameters, projectId: resolvedProjectId };

        try {
          await neo4jService.run(`EXPLAIN ${cypherResult.cypher}`, parameters);
        } catch (validationError) {
          const message = validationError instanceof Error ? validationError.message : String(validationError);
          await debugLog('Generated Cypher validation failed', {
            cypher: cypherResult.cypher,
            error: message,
          });
          return createErrorResponse(
            `Generated Cypher query has syntax errors:\n\n` +
              `Query: ${cypherResult.cypher}\n\n` +
              `Error: ${message}\n\n` +
              `Try rephrasing your request or use a simpler query.`,
          );
        }

        // Execute the validated query
        const results = await neo4jService.run(cypherResult.cypher, parameters);

        const formattedResponse = formatQueryResults(results, query, cypherResult);
        return createSuccessResponse(JSON.stringify(formattedResponse, null, 2));
      } catch (error) {
        console.error('Natural language to Cypher error:', error);
        await debugLog('Natural language to Cypher error', { query, error });
        return createErrorResponse(error);
      } finally {
        await neo4jService.close();
      }
    },
  );
};
