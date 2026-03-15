/**
 * Swarm Pheromone Tool
 * Leave a pheromone marker on a code node for stigmergic coordination
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { Neo4jService } from '../../storage/neo4j/neo4j.service.js';
import { TOOL_NAMES, TOOL_METADATA } from '../constants.js';
import { createErrorResponse, createSuccessResponse, resolveProjectIdOrError, debugLog } from '../utils.js';

import { PHEROMONE_TYPES, WORKFLOW_STATES, getHalfLife, PheromoneType } from './swarm-constants.js';

/**
 * Neo4j query to clean up other workflow states before setting a new one.
 * Only runs for workflow state pheromones, not flags.
 */
const CLEANUP_WORKFLOW_STATES_QUERY = `
  MATCH (p:Pheromone)
  WHERE p.projectId = $projectId
    AND p.nodeId = $nodeId
    AND p.agentId = $agentId
    AND p.swarmId = $swarmId
    AND p.type IN $workflowStates
    AND p.type <> $newType
  DETACH DELETE p
  RETURN count(p) as cleaned
`;

/**
 * Neo4j query to create or update a pheromone
 */
const CREATE_PHEROMONE_QUERY = `
  // Find the target code node (exclude other pheromones)
  MATCH (target)
  WHERE target.id = $nodeId
    AND target.projectId = $projectId
    AND NOT target:Pheromone
  WITH target
  LIMIT 1

  // Create or update pheromone (scoped to project)
  MERGE (p:Pheromone {projectId: $projectId, nodeId: $nodeId, agentId: $agentId, swarmId: $swarmId, type: $type})
  ON CREATE SET
    p.id = randomUUID(),
    p.intensity = $intensity,
    p.timestamp = timestamp(),
    p.data = $data,
    p.halfLife = $halfLife,
    p.sessionId = $sessionId
  ON MATCH SET
    p.intensity = $intensity,
    p.timestamp = timestamp(),
    p.data = $data,
    p.sessionId = COALESCE($sessionId, p.sessionId)

  // Create relationship to target node if it exists
  WITH p, target
  WHERE target IS NOT NULL
  MERGE (p)-[:MARKS]->(target)

  RETURN p.id as id, p.nodeId as nodeId, p.projectId as projectId, p.type as type, p.intensity as intensity,
         p.timestamp as timestamp, p.agentId as agentId, p.swarmId as swarmId,
         CASE WHEN target IS NOT NULL THEN true ELSE false END as linkedToNode
`;

/**
 * Neo4j query to delete a pheromone
 */
const DELETE_PHEROMONE_QUERY = `
  MATCH (p:Pheromone {projectId: $projectId, nodeId: $nodeId, agentId: $agentId, swarmId: $swarmId, type: $type})
  DETACH DELETE p
  RETURN count(p) as deleted
`;

const BY_FILE_PATH = `MATCH (n:SourceFile)
     WHERE n.projectId = $projectId AND n.filePath ENDS WITH $filePath
     RETURN n.id as nodeId LIMIT 1`;

export const createSwarmPheromoneTool = (server: McpServer): void => {
  server.registerTool(
    TOOL_NAMES.swarmPheromone,
    {
      title: TOOL_METADATA[TOOL_NAMES.swarmPheromone].title,
      description: TOOL_METADATA[TOOL_NAMES.swarmPheromone].description,
      inputSchema: {
        projectId: z.string().describe('Project ID, name, or path (e.g., "backend" or "proj_a1b2c3d4e5f6")'),
        nodeId: z.string().optional().describe('The code node ID to mark with a pheromone'),
        filePath: z
          .string()
          .optional()
          .describe('File path to mark (alternative to nodeId — auto-resolves to SourceFile node)'),
        type: z
          .enum(PHEROMONE_TYPES as [string, ...string[]])
          .describe(
            'Type of pheromone: exploring (browsing), modifying (active work), claiming (ownership), completed (done), warning (danger), blocked (stuck), proposal (awaiting approval), needs_review (review request), session_context (session working set)',
          ),
        intensity: z
          .number()
          .min(0)
          .max(1)
          .optional()
          .default(1.0)
          .describe('Pheromone intensity from 0.0 to 1.0 (default: 1.0)'),
        agentId: z.string().describe('Unique identifier for the agent leaving the pheromone'),
        swarmId: z.string().describe('Swarm ID for grouping related agents (e.g., "swarm_xyz")'),
        sessionId: z
          .string()
          .optional()
          .describe('Session identifier for cross-session recovery (e.g., conversation ID)'),
        data: z
          .record(z.unknown())
          .optional()
          .describe('Optional metadata to attach to the pheromone (e.g., summary, reason)'),
        remove: z
          .boolean()
          .optional()
          .default(false)
          .describe('If true, removes the pheromone instead of creating/updating it'),
      },
    },
    async ({
      projectId,
      nodeId,
      filePath,
      type,
      intensity = 1.0,
      agentId,
      swarmId,
      sessionId,
      data,
      remove = false,
    }) => {
      const neo4jService = new Neo4jService();
      if (!nodeId && !filePath) {
        return createErrorResponse(new Error('nodeId or filePath required'));
      }

      // Resolve project ID
      const projectResult = await resolveProjectIdOrError(projectId, neo4jService);
      if (!projectResult.success) {
        await neo4jService.close();
        return projectResult.error;
      }
      const resolvedProjectId = projectResult.projectId;

      try {
        // Resolve filePath to nodeId before any queries that need it
        let resolvedFromFilePath = false;
        let linkedToNode = true;
        if (!nodeId && filePath) {
          const records = await neo4jService.run(BY_FILE_PATH, { projectId: resolvedProjectId, filePath });
          if (records[0]?.nodeId) {
            nodeId = records[0].nodeId;
          } else {
            // No graph node — use filePath as identifier so pheromone is still created
            nodeId = filePath;
            linkedToNode = false;
          }
          resolvedFromFilePath = true;
        }

        if (remove) {
          const result = await neo4jService.run(DELETE_PHEROMONE_QUERY, {
            projectId: resolvedProjectId,
            nodeId,
            agentId,
            swarmId,
            type,
          });

          const deleted = result[0]?.deleted ?? 0;

          if (deleted > 0) {
            return createSuccessResponse(
              JSON.stringify({
                success: true,
                action: 'removed',
                projectId: resolvedProjectId,
                nodeId,
                type,
                agentId,
                swarmId,
              }),
            );
          } else {
            return createSuccessResponse(
              JSON.stringify({
                success: true,
                action: 'not_found',
                message: 'No matching pheromone found to remove',
                projectId: resolvedProjectId,
                nodeId,
                type,
                agentId,
                swarmId,
              }),
            );
          }
        }

        // Create or update pheromone
        const halfLife = getHalfLife(type as PheromoneType);
        const dataJson = data ? JSON.stringify(data) : null;

        // If setting a workflow state, clean up other workflow states first
        let cleanedStates = 0;
        if (WORKFLOW_STATES.includes(type as PheromoneType)) {
          const cleanupResult = await neo4jService.run(CLEANUP_WORKFLOW_STATES_QUERY, {
            projectId: resolvedProjectId,
            nodeId,
            agentId,
            swarmId,
            workflowStates: WORKFLOW_STATES,
            newType: type,
          });
          cleanedStates = cleanupResult[0]?.cleaned ?? 0;
        }

        const result = await neo4jService.run(CREATE_PHEROMONE_QUERY, {
          projectId: resolvedProjectId,
          nodeId,
          type,
          intensity,
          agentId,
          swarmId,
          sessionId: sessionId ?? null,
          data: dataJson,
          halfLife,
        });

        if (result.length === 0) {
          return createErrorResponse(`Failed to create pheromone. Node ${nodeId} may not exist in the graph.`);
        }

        const pheromone = result[0];

        return createSuccessResponse(
          JSON.stringify({
            success: true,
            action: cleanedStates > 0 ? 'transitioned' : 'created',
            previousStatesRemoved: cleanedStates,
            pheromone: {
              id: pheromone.id,
              projectId: pheromone.projectId,
              nodeId: pheromone.nodeId,
              type: pheromone.type,
              intensity: pheromone.intensity,
              agentId: pheromone.agentId,
              swarmId: pheromone.swarmId,
              timestamp: pheromone.timestamp,
              linkedToNode: pheromone.linkedToNode,
              halfLifeMs: halfLife,
              expiresIn: halfLife < 0 ? 'never' : `${Math.round(halfLife / 60000)} minutes`,
            },
          }),
        );
      } catch (error) {
        await debugLog('Swarm pheromone error', { error: String(error) });
        return createErrorResponse(error instanceof Error ? error : String(error));
      } finally {
        await neo4jService.close();
      }
    },
  );
};
