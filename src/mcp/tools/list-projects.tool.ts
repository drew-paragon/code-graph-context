/**
 * List Projects Tool
 * Lists all parsed projects in the database
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { LIST_PROJECTS_QUERY } from '../../core/utils/project-id.js';
import { Neo4jService } from '../../storage/neo4j/neo4j.service.js';
import { TOOL_NAMES, TOOL_METADATA } from '../constants.js';
import { createEmptyResponse, createErrorResponse, createSuccessResponse, debugLog } from '../utils.js';

interface ProjectInfo {
  projectId: string;
  name: string;
  path: string;
  status: string;
  nodeCount: number | null;
  edgeCount: number | null;
  updatedAt: string;
}

export const createListProjectsTool = (server: McpServer): void => {
  server.registerTool(
    TOOL_NAMES.listProjects,
    {
      title: TOOL_METADATA[TOOL_NAMES.listProjects].title,
      description: TOOL_METADATA[TOOL_NAMES.listProjects].description,
      inputSchema: {},
    },
    async () => {
      const neo4jService = new Neo4jService();
      try {
        const results = await neo4jService.run(LIST_PROJECTS_QUERY, {});

        if (results.length === 0) {
          return createEmptyResponse(
            'No projects found in the database',
            'Use parse_typescript_project to add a project first.',
          );
        }

        const projects: ProjectInfo[] = results.map((r) => ({
          projectId: r.projectId as string,
          name: r.name as string,
          path: r.path as string,
          status: (r.status as string) ?? 'unknown',
          nodeCount: r.nodeCount as number | null,
          edgeCount: r.edgeCount as number | null,
          updatedAt: r.updatedAt?.toString() ?? 'Unknown',
        }));

        // Format output for readability
        const header = `Found ${projects.length} project(s):\n\n`;
        const formatStats = (p: ProjectInfo) => {
          if (p.status === 'complete' && p.nodeCount !== null) {
            return `  Stats: ${p.nodeCount} nodes, ${p.edgeCount ?? 0} edges`;
          }
          return '';
        };
        const projectList = projects
          .map(
            (p) =>
              `- ${p.name} [${p.status}]\n` +
              `  ID: ${p.projectId}\n` +
              `  Path: ${p.path}\n` +
              formatStats(p) +
              (formatStats(p) ? '\n' : '') +
              `  Updated: ${p.updatedAt}`,
          )
          .join('\n\n');

        const tip =
          '\n\nTip: Use the project name (e.g., "' +
          projects[0].name +
          '") in other tools instead of the full projectId.';

        return createSuccessResponse(header + projectList + tip);
      } catch (error) {
        console.error('List projects error:', error);
        await debugLog('List projects error', { error });
        return createErrorResponse(error);
      } finally {
        await neo4jService.close();
      }
    },
  );
};
