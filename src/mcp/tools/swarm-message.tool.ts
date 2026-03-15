/**
 * Swarm Message Tool
 * Direct agent-to-agent messaging via Neo4j for reliable coordination.
 *
 * Unlike pheromones (passive, decay-based stigmergy), messages are explicit
 * and delivered to agents when they claim tasks. This ensures critical
 * coordination signals (blocked, conflict, findings) are reliably received.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { Neo4jService } from '../../storage/neo4j/neo4j.service.js';
import { TOOL_NAMES, TOOL_METADATA } from '../constants.js';
import { createErrorResponse, createSuccessResponse, resolveProjectIdOrError, debugLog } from '../utils.js';

import { MESSAGE_CATEGORY_KEYS, MESSAGE_DEFAULT_TTL_MS, generateMessageId } from './swarm-constants.js';

// ============================================================================
// NEO4J QUERIES
// ============================================================================

/**
 * Send a message. Creates a SwarmMessage node with optional target agent.
 * Broadcast messages (no toAgentId) are visible to all agents in the swarm.
 */
const SEND_MESSAGE_QUERY = `
  CREATE (m:SwarmMessage {
    id: $messageId,
    projectId: $projectId,
    swarmId: $swarmId,
    fromAgentId: $fromAgentId,
    toAgentId: $toAgentId,
    category: $category,
    content: $content,
    taskId: $taskId,
    filePaths: $filePaths,
    timestamp: timestamp(),
    expiresAt: timestamp() + $ttlMs,
    readBy: []
  })
  RETURN m.id as id,
         m.swarmId as swarmId,
         m.fromAgentId as fromAgentId,
         m.toAgentId as toAgentId,
         m.category as category,
         m.timestamp as timestamp,
         m.expiresAt as expiresAt
`;

/**
 * Read messages for an agent. Returns messages that are:
 * 1. Addressed to this agent specifically, OR
 * 2. Broadcast (toAgentId is null) to the same swarm
 * AND not yet expired.
 * Optionally filters to unread-only (not in readBy list).
 */
const READ_MESSAGES_QUERY = `
  MATCH (m:SwarmMessage)
  WHERE m.projectId = $projectId
    AND m.swarmId = $swarmId
    AND m.expiresAt > timestamp()
    AND (m.toAgentId IS NULL OR m.toAgentId = $agentId)
    AND ($unreadOnly = false OR NOT $agentId IN m.readBy)
    AND ($categories IS NULL OR size($categories) = 0 OR m.category IN $categories)
    AND ($fromAgentId IS NULL OR m.fromAgentId = $fromAgentId)
  RETURN m.id as id,
         m.swarmId as swarmId,
         m.fromAgentId as fromAgentId,
         m.toAgentId as toAgentId,
         m.category as category,
         m.content as content,
         m.taskId as taskId,
         m.filePaths as filePaths,
         m.timestamp as timestamp,
         m.expiresAt as expiresAt,
         m.readBy as readBy,
         NOT $agentId IN m.readBy as isUnread
  ORDER BY m.timestamp DESC
  LIMIT toInteger($limit)
`;

/**
 * Acknowledge (mark as read) specific messages for an agent.
 * Uses APOC to atomically add agentId to readBy array.
 */
const ACKNOWLEDGE_MESSAGES_QUERY = `
  UNWIND $messageIds as msgId
  MATCH (m:SwarmMessage {id: msgId, projectId: $projectId})
  WHERE NOT $agentId IN m.readBy
  SET m.readBy = m.readBy + $agentId
  RETURN m.id as id, m.category as category
`;

/**
 * Acknowledge ALL unread messages for an agent in a swarm.
 */
const ACKNOWLEDGE_ALL_QUERY = `
  MATCH (m:SwarmMessage)
  WHERE m.projectId = $projectId
    AND m.swarmId = $swarmId
    AND (m.toAgentId IS NULL OR m.toAgentId = $agentId)
    AND NOT $agentId IN m.readBy
    AND m.expiresAt > timestamp()
  SET m.readBy = m.readBy + $agentId
  RETURN count(m) as acknowledged
`;

/**
 * Fetch pending messages for delivery during task claim.
 * Returns unread messages addressed to or broadcast to the agent.
 * Used internally by swarm_claim_task integration.
 */
export const PENDING_MESSAGES_FOR_AGENT_QUERY = `
  MATCH (m:SwarmMessage)
  WHERE m.projectId = $projectId
    AND m.swarmId = $swarmId
    AND m.expiresAt > timestamp()
    AND (m.toAgentId IS NULL OR m.toAgentId = $agentId)
    AND NOT $agentId IN m.readBy
  RETURN m.id as id,
         m.fromAgentId as fromAgentId,
         m.category as category,
         m.content as content,
         m.taskId as taskId,
         m.filePaths as filePaths,
         m.timestamp as timestamp
  ORDER BY
    CASE m.category
      WHEN 'alert' THEN 0
      WHEN 'conflict' THEN 1
      WHEN 'blocked' THEN 2
      WHEN 'request' THEN 3
      WHEN 'finding' THEN 4
      WHEN 'handoff' THEN 5
      ELSE 6
    END,
    m.timestamp DESC
  LIMIT 10
`;

/**
 * Auto-acknowledge messages that were delivered during claim.
 */
export const AUTO_ACKNOWLEDGE_QUERY = `
  UNWIND $messageIds as msgId
  MATCH (m:SwarmMessage {id: msgId})
  WHERE NOT $agentId IN m.readBy
  SET m.readBy = m.readBy + $agentId
  RETURN count(m) as acknowledged
`;

/**
 * Cleanup expired messages for a swarm.
 */
const CLEANUP_EXPIRED_QUERY = `
  MATCH (m:SwarmMessage)
  WHERE m.projectId = $projectId
    AND ($swarmId IS NULL OR m.swarmId = $swarmId)
    AND m.expiresAt < timestamp()
  DELETE m
  RETURN count(m) as cleaned
`;

// ============================================================================
// TOOL CREATION
// ============================================================================

export const createSwarmMessageTool = (server: McpServer): void => {
  server.registerTool(
    TOOL_NAMES.swarmMessage,
    {
      title: TOOL_METADATA[TOOL_NAMES.swarmMessage].title,
      description: TOOL_METADATA[TOOL_NAMES.swarmMessage].description,
      inputSchema: {
        projectId: z.string().describe('Project ID, name, or path'),
        swarmId: z.string().describe('Swarm ID for scoping messages'),
        agentId: z.string().describe('Your unique agent identifier'),
        action: z
          .enum(['send', 'read', 'acknowledge'])
          .describe('Action: send (post message), read (get messages), acknowledge (mark as read)'),

        // Send parameters
        toAgentId: z.string().optional().describe('Target agent ID. Omit for broadcast to all swarm agents.'),
        category: z
          .enum(MESSAGE_CATEGORY_KEYS)
          .optional()
          .describe(
            'Message category: blocked (need help), conflict (resource clash), finding (important discovery), ' +
              'request (direct ask), alert (urgent notification), handoff (context transfer)',
          ),
        content: z.string().optional().describe('Message content (required for send action)'),
        taskId: z.string().optional().describe('Related task ID for context'),
        filePaths: z.array(z.string()).optional().describe('File paths relevant to this message'),
        ttlMs: z
          .number()
          .int()
          .optional()
          .describe(`Time-to-live in ms (default: ${MESSAGE_DEFAULT_TTL_MS / 3600000}h). Set 0 for swarm lifetime.`),

        // Read parameters
        unreadOnly: z.boolean().optional().default(true).describe('Only return unread messages (default: true)'),
        categories: z.array(z.enum(MESSAGE_CATEGORY_KEYS)).optional().describe('Filter by message categories'),
        fromAgentId: z.string().optional().describe('Filter messages from a specific agent'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .default(20)
          .describe('Maximum messages to return (default: 20)'),

        // Acknowledge parameters
        messageIds: z
          .array(z.string())
          .optional()
          .describe('Specific message IDs to acknowledge. Omit to acknowledge all unread.'),

        // Maintenance
        cleanup: z.boolean().optional().default(false).describe('Also clean up expired messages'),
      },
    },
    async ({
      projectId,
      swarmId,
      agentId,
      action,
      toAgentId,
      category,
      content,
      taskId,
      filePaths,
      ttlMs,
      unreadOnly = true,
      categories,
      fromAgentId,
      limit = 20,
      messageIds,
      cleanup = false,
    }) => {
      const neo4jService = new Neo4jService();

      const projectResult = await resolveProjectIdOrError(projectId, neo4jService);
      if (!projectResult.success) {
        await neo4jService.close();
        return projectResult.error;
      }
      const resolvedProjectId = projectResult.projectId;

      try {
        // Optional cleanup of expired messages
        let cleanedCount = 0;
        if (cleanup) {
          const cleanResult = await neo4jService.run(CLEANUP_EXPIRED_QUERY, {
            projectId: resolvedProjectId,
            swarmId,
          });
          cleanedCount = cleanResult[0]?.cleaned ?? 0;
        }

        // ── SEND ──────────────────────────────────────────────────────
        if (action === 'send') {
          if (!category) {
            return createErrorResponse('category is required for send action');
          }
          if (!content) {
            return createErrorResponse('content is required for send action');
          }

          const messageId = generateMessageId();
          const effectiveTtl = ttlMs ?? MESSAGE_DEFAULT_TTL_MS;

          const result = await neo4jService.run(SEND_MESSAGE_QUERY, {
            messageId,
            projectId: resolvedProjectId,
            swarmId,
            fromAgentId: agentId,
            toAgentId: toAgentId ?? null,
            category,
            content,
            taskId: taskId ?? null,
            filePaths: filePaths ?? [],
            ttlMs: effectiveTtl,
          });

          if (result.length === 0) {
            return createErrorResponse('Failed to create message');
          }

          const msg = result[0];
          const ts =
            typeof msg.timestamp === 'object' && msg.timestamp?.toNumber ? msg.timestamp.toNumber() : msg.timestamp;

          return createSuccessResponse(
            JSON.stringify({
              action: 'sent',
              message: {
                id: messageId,
                swarmId: msg.swarmId,
                from: msg.fromAgentId,
                to: msg.toAgentId ?? 'broadcast',
                category: msg.category,
                expiresIn: effectiveTtl > 0 ? `${Math.round(effectiveTtl / 60000)} minutes` : 'never',
              },
              ...(cleanedCount > 0 && { expiredCleaned: cleanedCount }),
            }),
          );
        }

        // ── READ ──────────────────────────────────────────────────────
        if (action === 'read') {
          const result = await neo4jService.run(READ_MESSAGES_QUERY, {
            projectId: resolvedProjectId,
            swarmId,
            agentId,
            unreadOnly,
            categories: categories ?? null,
            fromAgentId: fromAgentId ?? null,
            limit: Math.floor(limit),
          });

          const messages = result.map((m: any) => {
            const ts = typeof m.timestamp === 'object' && m.timestamp?.toNumber ? m.timestamp.toNumber() : m.timestamp;
            return {
              id: m.id,
              from: m.fromAgentId,
              to: m.toAgentId ?? 'broadcast',
              category: m.category,
              content: m.content,
              taskId: m.taskId ?? undefined,
              filePaths: m.filePaths?.length > 0 ? m.filePaths : undefined,
              isUnread: m.isUnread,
              age: ts ? `${Math.round((Date.now() - ts) / 1000)}s ago` : null,
            };
          });

          return createSuccessResponse(
            JSON.stringify({
              action: 'read',
              swarmId,
              forAgent: agentId,
              count: messages.length,
              messages,
              ...(cleanedCount > 0 && { expiredCleaned: cleanedCount }),
            }),
          );
        }

        // ── ACKNOWLEDGE ───────────────────────────────────────────────
        if (action === 'acknowledge') {
          if (messageIds && messageIds.length > 0) {
            // Acknowledge specific messages
            const result = await neo4jService.run(ACKNOWLEDGE_MESSAGES_QUERY, {
              messageIds,
              projectId: resolvedProjectId,
              agentId,
            });

            return createSuccessResponse(
              JSON.stringify({
                action: 'acknowledged',
                count: result.length,
                messageIds: result.map((r: any) => r.id),
                ...(cleanedCount > 0 && { expiredCleaned: cleanedCount }),
              }),
            );
          } else {
            // Acknowledge all unread
            const result = await neo4jService.run(ACKNOWLEDGE_ALL_QUERY, {
              projectId: resolvedProjectId,
              swarmId,
              agentId,
            });

            const count =
              typeof result[0]?.acknowledged === 'object'
                ? result[0].acknowledged.toNumber()
                : (result[0]?.acknowledged ?? 0);

            return createSuccessResponse(
              JSON.stringify({
                action: 'acknowledged_all',
                count,
                ...(cleanedCount > 0 && { expiredCleaned: cleanedCount }),
              }),
            );
          }
        }

        return createErrorResponse(`Unknown action: ${action}`);
      } catch (error) {
        await debugLog('Swarm message error', { error: String(error) });
        return createErrorResponse(error instanceof Error ? error : String(error));
      } finally {
        await neo4jService.close();
      }
    },
  );
};
