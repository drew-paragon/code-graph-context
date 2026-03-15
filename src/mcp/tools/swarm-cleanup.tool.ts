/**
 * Swarm Cleanup Tool
 * Bulk delete pheromones after a swarm completes
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { Neo4jService } from '../../storage/neo4j/neo4j.service.js';
import { TOOL_NAMES, TOOL_METADATA } from '../constants.js';
import { createErrorResponse, createSuccessResponse, resolveProjectIdOrError, debugLog } from '../utils.js';

/**
 * Neo4j query to delete pheromones by swarm ID
 */
const CLEANUP_PHEROMONES_BY_SWARM_QUERY = `
  MATCH (p:Pheromone)
  WHERE p.projectId = $projectId
    AND p.swarmId = $swarmId
    AND NOT p.type IN $keepTypes
  WITH p, p.agentId as agentId, p.type as type
  DETACH DELETE p
  RETURN count(p) as deleted, collect(DISTINCT agentId) as agents, collect(DISTINCT type) as types
`;

/**
 * Neo4j query to delete SwarmTask nodes by swarm ID
 */
const CLEANUP_TASKS_BY_SWARM_QUERY = `
  MATCH (t:SwarmTask)
  WHERE t.projectId = $projectId
    AND t.swarmId = $swarmId
  WITH t, t.status as status
  DETACH DELETE t
  RETURN count(t) as deleted, collect(DISTINCT status) as statuses
`;

/**
 * Neo4j query to delete pheromones by agent ID
 */
const CLEANUP_BY_AGENT_QUERY = `
  MATCH (p:Pheromone)
  WHERE p.projectId = $projectId
    AND p.agentId = $agentId
    AND NOT p.type IN $keepTypes
  WITH p, p.swarmId as swarmId, p.type as type
  DETACH DELETE p
  RETURN count(p) as deleted, collect(DISTINCT swarmId) as swarms, collect(DISTINCT type) as types
`;

/**
 * Neo4j query to delete all pheromones in a project
 */
const CLEANUP_ALL_QUERY = `
  MATCH (p:Pheromone)
  WHERE p.projectId = $projectId
    AND NOT p.type IN $keepTypes
  WITH p, p.agentId as agentId, p.swarmId as swarmId, p.type as type
  DETACH DELETE p
  RETURN count(p) as deleted, collect(DISTINCT agentId) as agents, collect(DISTINCT swarmId) as swarms, collect(DISTINCT type) as types
`;

/**
 * Count queries for dry run
 */
const COUNT_PHEROMONES_BY_SWARM_QUERY = `
  MATCH (p:Pheromone)
  WHERE p.projectId = $projectId AND p.swarmId = $swarmId AND NOT p.type IN $keepTypes
  RETURN count(p) as count, collect(DISTINCT p.agentId) as agents, collect(DISTINCT p.type) as types
`;

const COUNT_TASKS_BY_SWARM_QUERY = `
  MATCH (t:SwarmTask)
  WHERE t.projectId = $projectId AND t.swarmId = $swarmId
  RETURN count(t) as count, collect(DISTINCT t.status) as statuses
`;

const COUNT_BY_AGENT_QUERY = `
  MATCH (p:Pheromone)
  WHERE p.projectId = $projectId AND p.agentId = $agentId AND NOT p.type IN $keepTypes
  RETURN count(p) as count, collect(DISTINCT p.swarmId) as swarms, collect(DISTINCT p.type) as types
`;

const COUNT_ALL_QUERY = `
  MATCH (p:Pheromone)
  WHERE p.projectId = $projectId AND NOT p.type IN $keepTypes
  RETURN count(p) as count, collect(DISTINCT p.agentId) as agents, collect(DISTINCT p.swarmId) as swarms, collect(DISTINCT p.type) as types
`;

/**
 * Neo4j query to delete SwarmMessage nodes by swarm ID
 */
const CLEANUP_MESSAGES_BY_SWARM_QUERY = `
  MATCH (m:SwarmMessage)
  WHERE m.projectId = $projectId
    AND m.swarmId = $swarmId
  WITH m, m.category as category
  DELETE m
  RETURN count(m) as deleted, collect(DISTINCT category) as categories
`;

const COUNT_MESSAGES_BY_SWARM_QUERY = `
  MATCH (m:SwarmMessage)
  WHERE m.projectId = $projectId AND m.swarmId = $swarmId
  RETURN count(m) as count, collect(DISTINCT m.category) as categories
`;

export const createSwarmCleanupTool = (server: McpServer): void => {
  server.registerTool(
    TOOL_NAMES.swarmCleanup,
    {
      title: TOOL_METADATA[TOOL_NAMES.swarmCleanup].title,
      description: TOOL_METADATA[TOOL_NAMES.swarmCleanup].description,
      inputSchema: {
        projectId: z.string().describe('Project ID, name, or path'),
        swarmId: z.string().optional().describe('Delete all pheromones and tasks from this swarm'),
        agentId: z.string().optional().describe('Delete all pheromones from this agent'),
        all: z.boolean().optional().default(false).describe('Delete ALL pheromones in project (use with caution)'),
        includeTasks: z
          .boolean()
          .optional()
          .default(true)
          .describe('Also delete SwarmTask nodes (default: true, only applies when swarmId is provided)'),
        keepTypes: z
          .array(z.string())
          .optional()
          .default(['warning'])
          .describe('Pheromone types to preserve (default: ["warning"])'),
        dryRun: z.boolean().optional().default(false).describe('Preview what would be deleted without deleting'),
      },
    },
    async ({
      projectId,
      swarmId,
      agentId,
      all = false,
      includeTasks = true,
      keepTypes = ['warning'],
      dryRun = false,
    }) => {
      const neo4jService = new Neo4jService();

      // Resolve project ID
      const projectResult = await resolveProjectIdOrError(projectId, neo4jService);
      if (!projectResult.success) {
        await neo4jService.close();
        return projectResult.error;
      }
      const resolvedProjectId = projectResult.projectId;

      try {
        // Validate: must specify swarmId, agentId, or all
        if (!swarmId && !agentId && !all) {
          return createErrorResponse('Must specify one of: swarmId, agentId, or all=true. Use dryRun=true to preview.');
        }

        const params: Record<string, unknown> = { projectId: resolvedProjectId, keepTypes };
        let pheromoneDeleteQuery: string;
        let pheromoneCountQuery: string;
        let mode: string;

        if (swarmId) {
          params.swarmId = swarmId;
          pheromoneDeleteQuery = CLEANUP_PHEROMONES_BY_SWARM_QUERY;
          pheromoneCountQuery = COUNT_PHEROMONES_BY_SWARM_QUERY;
          mode = 'swarm';
        } else if (agentId) {
          params.agentId = agentId;
          pheromoneDeleteQuery = CLEANUP_BY_AGENT_QUERY;
          pheromoneCountQuery = COUNT_BY_AGENT_QUERY;
          mode = 'agent';
        } else {
          pheromoneDeleteQuery = CLEANUP_ALL_QUERY;
          pheromoneCountQuery = COUNT_ALL_QUERY;
          mode = 'all';
        }

        if (dryRun) {
          const pheromoneResult = await neo4jService.run(pheromoneCountQuery, params);
          const pheromoneCount = pheromoneResult[0]?.count ?? 0;

          let taskCount = 0;
          let taskStatuses: string[] = [];
          if (swarmId && includeTasks) {
            const taskResult = await neo4jService.run(COUNT_TASKS_BY_SWARM_QUERY, params);
            taskCount = taskResult[0]?.count ?? 0;
            taskCount =
              typeof taskCount === 'object' && 'toNumber' in taskCount ? (taskCount as any).toNumber() : taskCount;
            taskStatuses = taskResult[0]?.statuses ?? [];
          }

          let messageCount = 0;
          let messageCategories: string[] = [];
          if (swarmId) {
            const msgResult = await neo4jService.run(COUNT_MESSAGES_BY_SWARM_QUERY, params);
            messageCount = msgResult[0]?.count ?? 0;
            messageCount =
              typeof messageCount === 'object' && 'toNumber' in messageCount
                ? (messageCount as any).toNumber()
                : messageCount;
            messageCategories = msgResult[0]?.categories ?? [];
          }

          return createSuccessResponse(
            JSON.stringify({
              success: true,
              dryRun: true,
              mode,
              pheromones: {
                wouldDelete:
                  typeof pheromoneCount === 'object' && 'toNumber' in pheromoneCount
                    ? (pheromoneCount as any).toNumber()
                    : pheromoneCount,
                agents: pheromoneResult[0]?.agents ?? [],
                types: pheromoneResult[0]?.types ?? [],
              },
              tasks:
                swarmId && includeTasks
                  ? {
                      wouldDelete: taskCount,
                      statuses: taskStatuses,
                    }
                  : null,
              messages: swarmId
                ? {
                    wouldDelete: messageCount,
                    categories: messageCategories,
                  }
                : null,
              keepTypes,
              projectId: resolvedProjectId,
            }),
          );
        }

        // Delete pheromones
        const pheromoneResult = await neo4jService.run(pheromoneDeleteQuery, params);
        const pheromonesDeleted = pheromoneResult[0]?.deleted ?? 0;

        // Delete tasks if swarmId provided and includeTasks is true
        let tasksDeleted = 0;
        let taskStatuses: string[] = [];
        if (swarmId && includeTasks) {
          const taskResult = await neo4jService.run(CLEANUP_TASKS_BY_SWARM_QUERY, params);
          tasksDeleted = taskResult[0]?.deleted ?? 0;
          tasksDeleted =
            typeof tasksDeleted === 'object' && 'toNumber' in tasksDeleted
              ? (tasksDeleted as any).toNumber()
              : tasksDeleted;
          taskStatuses = taskResult[0]?.statuses ?? [];
        }

        // Delete messages if swarmId provided
        let messagesDeleted = 0;
        let messageCategories: string[] = [];
        if (swarmId) {
          const msgResult = await neo4jService.run(CLEANUP_MESSAGES_BY_SWARM_QUERY, params);
          messagesDeleted = msgResult[0]?.deleted ?? 0;
          messagesDeleted =
            typeof messagesDeleted === 'object' && 'toNumber' in messagesDeleted
              ? (messagesDeleted as any).toNumber()
              : messagesDeleted;
          messageCategories = msgResult[0]?.categories ?? [];
        }

        const parts = [`${pheromonesDeleted} pheromones`];
        if (swarmId && includeTasks) parts.push(`${tasksDeleted} tasks`);
        if (swarmId) parts.push(`${messagesDeleted} messages`);

        return createSuccessResponse(
          JSON.stringify({
            success: true,
            mode,
            pheromones: {
              deleted:
                typeof pheromonesDeleted === 'object' && 'toNumber' in pheromonesDeleted
                  ? (pheromonesDeleted as any).toNumber()
                  : pheromonesDeleted,
              agents: pheromoneResult[0]?.agents ?? [],
              types: pheromoneResult[0]?.types ?? [],
            },
            tasks:
              swarmId && includeTasks
                ? {
                    deleted: tasksDeleted,
                    statuses: taskStatuses,
                  }
                : null,
            messages: swarmId
              ? {
                  deleted: messagesDeleted,
                  categories: messageCategories,
                }
              : null,
            keepTypes,
            projectId: resolvedProjectId,
            message: `Cleaned up ${parts.join(', ')}`,
          }),
        );
      } catch (error) {
        await debugLog('Swarm cleanup error', { error: String(error) });
        return createErrorResponse(error instanceof Error ? error : String(error));
      } finally {
        await neo4jService.close();
      }
    },
  );
};
