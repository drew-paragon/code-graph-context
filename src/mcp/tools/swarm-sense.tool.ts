/**
 * Swarm Sense Tool
 * Query pheromones in the code graph for stigmergic coordination
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { Neo4jService } from '../../storage/neo4j/neo4j.service.js';
import { TOOL_NAMES, TOOL_METADATA } from '../constants.js';
import { createErrorResponse, createSuccessResponse, resolveProjectIdOrError, debugLog } from '../utils.js';

import { PHEROMONE_TYPES } from './swarm-constants.js';

/**
 * Neo4j query to sense pheromones with decay calculation
 * Uses nodeId-based matching (self-healing) instead of [:MARKS] relationship
 * This survives graph rebuilds since nodeIds are deterministic
 */
const SENSE_PHEROMONES_QUERY = `
  // Match pheromones scoped to project, optionally filtering by type
  MATCH (p:Pheromone)
  WHERE p.projectId = $projectId
    AND ($types IS NULL OR size($types) = 0 OR p.type IN $types)
    AND ($nodeIds IS NULL OR size($nodeIds) = 0 OR p.nodeId IN $nodeIds)
    AND ($agentIds IS NULL OR size($agentIds) = 0 OR p.agentId IN $agentIds)
    AND ($swarmId IS NULL OR p.swarmId = $swarmId)
    AND ($excludeAgentId IS NULL OR p.agentId <> $excludeAgentId)
    AND ($sessionId IS NULL OR p.sessionId = $sessionId)

  // Calculate current intensity with exponential decay
  WITH p,
    CASE
      WHEN p.halfLife IS NULL OR p.halfLife <= 0 THEN p.intensity
      ELSE p.intensity * exp(-0.693147 * (timestamp() - p.timestamp) / p.halfLife)
    END AS currentIntensity

  // Filter by minimum intensity
  WHERE currentIntensity >= $minIntensity

  // Find target by nodeId (self-healing - survives graph rebuilds)
  OPTIONAL MATCH (target)
  WHERE target.id = p.nodeId AND target.projectId = p.projectId

  // Return pheromone data
  RETURN
    p.id AS id,
    p.projectId AS projectId,
    p.nodeId AS nodeId,
    p.type AS type,
    p.intensity AS originalIntensity,
    currentIntensity,
    p.agentId AS agentId,
    p.swarmId AS swarmId,
    p.timestamp AS timestamp,
    p.data AS data,
    p.halfLife AS halfLifeMs,
    p.sessionId AS sessionId,
    CASE WHEN target IS NOT NULL THEN labels(target)[0] ELSE null END AS targetType,
    CASE WHEN target IS NOT NULL THEN target.name ELSE null END AS targetName,
    CASE WHEN target IS NOT NULL THEN target.filePath ELSE null END AS targetFilePath

  ORDER BY currentIntensity DESC, p.timestamp DESC
  LIMIT toInteger($limit)
`;

/**
 * Neo4j query to get pheromone summary statistics
 */
const PHEROMONE_STATS_QUERY = `
  MATCH (p:Pheromone)
  WHERE p.projectId = $projectId
  WITH p,
    CASE
      WHEN p.halfLife IS NULL OR p.halfLife <= 0 THEN p.intensity
      ELSE p.intensity * exp(-0.693147 * (timestamp() - p.timestamp) / p.halfLife)
    END AS currentIntensity
  WHERE currentIntensity >= $minIntensity

  RETURN
    p.type AS type,
    count(p) AS count,
    avg(currentIntensity) AS avgIntensity,
    collect(DISTINCT p.agentId) AS agents
  ORDER BY count DESC
`;

/**
 * Neo4j query to clean up fully decayed pheromones for a project
 */
const CLEANUP_DECAYED_QUERY = `
  MATCH (p:Pheromone)
  WHERE p.projectId = $projectId
    AND p.halfLife IS NOT NULL
    AND p.halfLife > 0
    AND p.intensity * exp(-0.693147 * (timestamp() - p.timestamp) / p.halfLife) < 0.01
  DETACH DELETE p
  RETURN count(p) AS cleaned
`;

export const createSwarmSenseTool = (server: McpServer): void => {
  server.registerTool(
    TOOL_NAMES.swarmSense,
    {
      title: TOOL_METADATA[TOOL_NAMES.swarmSense].title,
      description: TOOL_METADATA[TOOL_NAMES.swarmSense].description,
      inputSchema: {
        projectId: z.string().describe('Project ID, name, or path (e.g., "backend" or "proj_a1b2c3d4e5f6")'),
        types: z
          .array(z.enum(PHEROMONE_TYPES as [string, ...string[]]))
          .optional()
          .describe(
            'Filter by pheromone types. If empty, returns all types. Options: exploring, modifying, claiming, completed, warning, blocked, proposal, needs_review',
          ),
        nodeIds: z.array(z.string()).optional().describe('Filter by specific node IDs. If empty, searches all nodes.'),
        filePaths: z
          .array(z.string())
          .optional()
          .describe(
            'Filter by file paths (resolves to SourceFile nodeIds). Also matches pheromones placed via filePath.',
          ),
        agentIds: z
          .array(z.string())
          .optional()
          .describe('Filter by specific agent IDs. If empty, returns pheromones from all agents.'),
        swarmId: z.string().optional().describe('Filter by swarm ID. If empty, returns pheromones from all swarms.'),
        excludeAgentId: z
          .string()
          .optional()
          .describe('Exclude pheromones from this agent ID (useful for seeing what OTHER agents are doing)'),
        sessionId: z
          .string()
          .optional()
          .describe('Filter pheromones by session ID. Use to recover context after compaction or session restart.'),
        minIntensity: z
          .number()
          .min(0)
          .max(1)
          .optional()
          .default(0.3)
          .describe('Minimum effective intensity after decay (0.0-1.0, default: 0.3)'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(500)
          .optional()
          .default(50)
          .describe('Maximum number of pheromones to return (default: 50, max: 500)'),
        includeStats: z.boolean().optional().default(false).describe('Include summary statistics by pheromone type'),
        cleanup: z
          .boolean()
          .optional()
          .default(false)
          .describe('Run cleanup of fully decayed pheromones (intensity < 0.01)'),
      },
    },
    async ({
      projectId,
      types,
      nodeIds,
      filePaths,
      agentIds,
      swarmId,
      excludeAgentId,
      sessionId,
      minIntensity = 0.3,
      limit = 50,
      includeStats = false,
      cleanup = false,
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
        // Resolve filePaths to nodeIds and merge with any explicit nodeIds
        if (filePaths?.length) {
          const resolvedIds: string[] = [...(nodeIds ?? [])];
          const records = await neo4jService.run(
            `MATCH (n:SourceFile)
             WHERE n.projectId = $projectId AND any(fp IN $filePaths WHERE n.filePath ENDS WITH fp)
             RETURN collect(n.id) as nodeIds`,
            { projectId: resolvedProjectId, filePaths },
          );
          if (records[0]?.nodeIds) {
            resolvedIds.push(...records[0].nodeIds);
          }
          // Also include raw filePaths — catches pheromones placed on new files via filePath
          resolvedIds.push(...filePaths);
          nodeIds = resolvedIds;
        }
        const result: {
          pheromones: any[];
          stats?: any[];
          cleaned?: number;
          projectId: string;
          query: {
            types: string[] | null;
            minIntensity: number;
            limit: number;
          };
        } = {
          pheromones: [],
          projectId: resolvedProjectId,
          query: {
            types: types ?? null,
            minIntensity,
            limit,
          },
        };

        // Run cleanup if requested
        if (cleanup) {
          const cleanupResult = await neo4jService.run(CLEANUP_DECAYED_QUERY, { projectId: resolvedProjectId });
          result.cleaned = cleanupResult[0]?.cleaned ?? 0;
        }

        // Query pheromones (ensure limit is integer for Neo4j LIMIT clause)
        const pheromones = await neo4jService.run(SENSE_PHEROMONES_QUERY, {
          projectId: resolvedProjectId,
          types: types ?? null,
          nodeIds: nodeIds ?? null,
          agentIds: agentIds ?? null,
          swarmId: swarmId ?? null,
          excludeAgentId: excludeAgentId ?? null,
          sessionId: sessionId ?? null,
          minIntensity,
          limit: Math.floor(limit),
        });

        result.pheromones = pheromones.map((p: any) => {
          // Convert Neo4j Integer to JS number
          const ts = typeof p.timestamp === 'object' && p.timestamp?.toNumber ? p.timestamp.toNumber() : p.timestamp;
          return {
            id: p.id,
            projectId: p.projectId,
            nodeId: p.nodeId,
            type: p.type,
            intensity: Math.round(p.currentIntensity * 1000) / 1000, // Round to 3 decimals
            originalIntensity: p.originalIntensity,
            agentId: p.agentId,
            swarmId: p.swarmId,
            sessionId: p.sessionId ?? null,
            timestamp: ts,
            age: ts ? `${Math.round((Date.now() - ts) / 1000)}s ago` : null,
            data: p.data ? JSON.parse(p.data) : null,
            target: p.targetType
              ? {
                  type: p.targetType,
                  name: p.targetName,
                  filePath: p.targetFilePath,
                }
              : null,
          };
        });

        // Include stats if requested
        if (includeStats) {
          const stats = await neo4jService.run(PHEROMONE_STATS_QUERY, { projectId: resolvedProjectId, minIntensity });
          result.stats = stats.map((s: any) => ({
            type: s.type,
            count: typeof s.count === 'object' ? s.count.toNumber() : s.count,
            avgIntensity: Math.round(s.avgIntensity * 1000) / 1000,
            activeAgents: s.agents,
          }));
        }

        return createSuccessResponse(JSON.stringify(result, null, 2));
      } catch (error) {
        await debugLog('Swarm sense error', { error: String(error) });
        return createErrorResponse(error instanceof Error ? error : String(error));
      } finally {
        await neo4jService.close();
      }
    },
  );
};
