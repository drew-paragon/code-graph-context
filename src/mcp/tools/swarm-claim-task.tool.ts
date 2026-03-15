/**
 * Swarm Claim Task Tool
 * Allow an agent to claim an available task from the blackboard
 *
 * Phase 1 improvements:
 * - Atomic claim_and_start action (eliminates race window)
 * - Retry logic on race loss
 * - Recovery actions (abandon, force_start)
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { Neo4jService } from '../../storage/neo4j/neo4j.service.js';
import { TOOL_NAMES, TOOL_METADATA } from '../constants.js';
import { createErrorResponse, createSuccessResponse, resolveProjectIdOrError, debugLog } from '../utils.js';

import { TASK_TYPES, TASK_PRIORITIES, TaskPriority } from './swarm-constants.js';
import { PENDING_MESSAGES_FOR_AGENT_QUERY, AUTO_ACKNOWLEDGE_QUERY } from './swarm-message.tool.js';

/** Maximum retries when racing for a task */
const MAX_CLAIM_RETRIES = 3;
/** Delay between retries (ms) */
const RETRY_DELAY_BASE_MS = 50;

/**
 * Query to claim a specific task by ID
 * Uses atomic update to prevent race conditions
 */
const CLAIM_TASK_BY_ID_QUERY = `
  MATCH (t:SwarmTask {id: $taskId, projectId: $projectId})
  WHERE t.status IN ['available', 'blocked']

  // Check if dependencies are complete
  OPTIONAL MATCH (t)-[:DEPENDS_ON]->(dep:SwarmTask)
  WHERE dep.status <> 'completed'
  WITH t, count(dep) as incompleteDeps

  // Only claim if all dependencies are complete
  WHERE incompleteDeps = 0

  // Acquire exclusive lock to prevent race conditions
  CALL apoc.lock.nodes([t])

  // Double-check status after acquiring lock
  WITH t WHERE t.status IN ['available', 'blocked']

  // Atomic claim
  SET t.status = $targetStatus,
      t.claimedBy = $agentId,
      t.claimedAt = timestamp(),
      t.startedAt = CASE WHEN $targetStatus = 'in_progress' THEN timestamp() ELSE null END,
      t.updatedAt = timestamp()

  // Return task details with target info
  WITH t
  OPTIONAL MATCH (t)-[:TARGETS]->(target)
  RETURN t.id as id,
         t.projectId as projectId,
         t.swarmId as swarmId,
         t.title as title,
         t.description as description,
         t.type as type,
         t.priority as priority,
         t.priorityScore as priorityScore,
         t.status as status,
         t.targetNodeIds as targetNodeIds,
         t.targetFilePaths as targetFilePaths,
         t.dependencies as dependencies,
         t.claimedBy as claimedBy,
         t.claimedAt as claimedAt,
         t.startedAt as startedAt,
         t.createdBy as createdBy,
         t.metadata as metadata,
         collect(DISTINCT {
           id: target.id,
           type: labels(target)[0],
           name: target.name,
           filePath: target.filePath
         }) as targets
`;

/**
 * Query to claim the highest priority available task matching criteria
 * Uses APOC locking to prevent race conditions between parallel workers
 * Supports both 'claimed' and 'in_progress' target states for atomic claim_and_start
 */
const CLAIM_NEXT_TASK_QUERY = `
  // Find available or blocked tasks (blocked tasks may have deps completed now)
  MATCH (t:SwarmTask {projectId: $projectId, swarmId: $swarmId})
  WHERE t.status IN ['available', 'blocked']
    AND ($types IS NULL OR size($types) = 0 OR t.type IN $types)
    AND ($minPriority IS NULL OR t.priorityScore >= $minPriority)

  // Exclude tasks with incomplete dependencies
  OPTIONAL MATCH (t)-[:DEPENDS_ON]->(dep:SwarmTask)
  WHERE dep.status <> 'completed'
  WITH t, count(dep) as incompleteDeps
  WHERE incompleteDeps = 0

  // Re-establish context for ordering (required by Cypher syntax)
  WITH t
  ORDER BY t.priorityScore DESC, t.createdAt ASC
  LIMIT 1

  // Acquire exclusive lock to prevent race conditions
  CALL apoc.lock.nodes([t])

  // Double-check status after acquiring lock (another worker may have claimed it)
  WITH t WHERE t.status IN ['available', 'blocked']

  // Atomic claim - supports both claim and claim_and_start via $targetStatus
  SET t.status = $targetStatus,
      t.claimedBy = $agentId,
      t.claimedAt = timestamp(),
      t.startedAt = CASE WHEN $targetStatus = 'in_progress' THEN timestamp() ELSE null END,
      t.updatedAt = timestamp()

  // Return task details with target info
  WITH t
  OPTIONAL MATCH (t)-[:TARGETS]->(target)
  RETURN t.id as id,
         t.projectId as projectId,
         t.swarmId as swarmId,
         t.title as title,
         t.description as description,
         t.type as type,
         t.priority as priority,
         t.priorityScore as priorityScore,
         t.status as status,
         t.targetNodeIds as targetNodeIds,
         t.targetFilePaths as targetFilePaths,
         t.dependencies as dependencies,
         t.claimedBy as claimedBy,
         t.claimedAt as claimedAt,
         t.startedAt as startedAt,
         t.createdBy as createdBy,
         t.metadata as metadata,
         collect(DISTINCT {
           id: target.id,
           type: labels(target)[0],
           name: target.name,
           filePath: target.filePath
         }) as targets
`;

/**
 * Query to start working on a claimed task (transition to in_progress)
 */
const START_TASK_QUERY = `
  MATCH (t:SwarmTask {id: $taskId, projectId: $projectId})
  WHERE t.status = 'claimed' AND t.claimedBy = $agentId

  SET t.status = 'in_progress',
      t.startedAt = timestamp(),
      t.updatedAt = timestamp()

  RETURN t.id as id,
         t.status as status,
         t.claimedBy as claimedBy,
         t.startedAt as startedAt
`;

/**
 * Query to release a claimed task (unclaim it)
 */
const RELEASE_TASK_QUERY = `
  MATCH (t:SwarmTask {id: $taskId, projectId: $projectId})
  WHERE t.status IN ['claimed', 'in_progress'] AND t.claimedBy = $agentId

  SET t.status = 'available',
      t.claimedBy = null,
      t.claimedAt = null,
      t.startedAt = null,
      t.updatedAt = timestamp(),
      t.releaseReason = $reason

  RETURN t.id as id,
         t.title as title,
         t.status as status
`;

/**
 * Query to abandon a task - releases it with tracking for debugging
 * More explicit than release, tracks abandon history
 */
const ABANDON_TASK_QUERY = `
  MATCH (t:SwarmTask {id: $taskId, projectId: $projectId})
  WHERE t.claimedBy = $agentId
    AND t.status IN ['claimed', 'in_progress']

  // Track abandon history
  SET t.status = 'available',
      t.previousClaimedBy = t.claimedBy,
      t.claimedBy = null,
      t.claimedAt = null,
      t.startedAt = null,
      t.updatedAt = timestamp(),
      t.abandonedBy = $agentId,
      t.abandonedAt = timestamp(),
      t.abandonReason = $reason,
      t.abandonCount = COALESCE(t.abandonCount, 0) + 1

  RETURN t.id as id,
         t.title as title,
         t.status as status,
         t.abandonCount as abandonCount,
         t.abandonReason as abandonReason
`;

/**
 * Query to force-start a task that's stuck in claimed state
 * Allows recovery when the normal start action fails
 */
const FORCE_START_QUERY = `
  MATCH (t:SwarmTask {id: $taskId, projectId: $projectId})
  WHERE t.claimedBy = $agentId
    AND t.status IN ['claimed', 'available']

  SET t.status = 'in_progress',
      t.claimedBy = $agentId,
      t.claimedAt = COALESCE(t.claimedAt, timestamp()),
      t.startedAt = timestamp(),
      t.updatedAt = timestamp(),
      t.forceStarted = true,
      t.forceStartReason = $reason

  RETURN t.id as id,
         t.title as title,
         t.status as status,
         t.claimedBy as claimedBy,
         t.startedAt as startedAt,
         t.forceStarted as forceStarted
`;

/**
 * Query to get current task state for better error messages
 */
const GET_TASK_STATE_QUERY = `
  MATCH (t:SwarmTask {id: $taskId, projectId: $projectId})
  RETURN t.id as id,
         t.title as title,
         t.status as status,
         t.claimedBy as claimedBy,
         t.claimedAt as claimedAt,
         t.startedAt as startedAt,
         t.abandonCount as abandonCount,
         t.previousClaimedBy as previousClaimedBy
`;

export const createSwarmClaimTaskTool = (server: McpServer): void => {
  server.registerTool(
    TOOL_NAMES.swarmClaimTask,
    {
      title: TOOL_METADATA[TOOL_NAMES.swarmClaimTask].title,
      description: TOOL_METADATA[TOOL_NAMES.swarmClaimTask].description,
      inputSchema: {
        projectId: z.string().describe('Project ID, name, or path'),
        swarmId: z.string().describe('Swarm ID to find tasks in'),
        agentId: z.string().describe('Your unique agent identifier'),
        taskId: z
          .string()
          .optional()
          .describe('Specific task ID to claim (if omitted, claims highest priority available task)'),
        types: z
          .array(z.enum(TASK_TYPES))
          .optional()
          .describe('Filter by task types when auto-selecting (e.g., ["implement", "fix"])'),
        minPriority: z
          .enum(Object.keys(TASK_PRIORITIES) as [string, ...string[]])
          .optional()
          .describe('Minimum priority level when auto-selecting'),
        action: z
          .enum(['claim', 'claim_and_start', 'start', 'release', 'abandon', 'force_start'])
          .optional()
          .default('claim_and_start')
          .describe(
            'Action: claim_and_start (RECOMMENDED: atomic claim+start), claim (reserve only), ' +
              'start (begin work on claimed task), release (give up task), ' +
              'abandon (release with tracking), force_start (recover from stuck claimed state)',
          ),
        releaseReason: z.string().optional().describe('Reason for releasing/abandoning the task'),
      },
    },
    async ({ projectId, swarmId, agentId, taskId, types, minPriority, action = 'claim_and_start', releaseReason }) => {
      const neo4jService = new Neo4jService();

      // Resolve project ID
      const projectResult = await resolveProjectIdOrError(projectId, neo4jService);
      if (!projectResult.success) {
        await neo4jService.close();
        return projectResult.error;
      }
      const resolvedProjectId = projectResult.projectId;

      try {
        // Handle release action
        if (action === 'release') {
          if (!taskId) {
            return createErrorResponse('taskId is required for release action');
          }

          const result = await neo4jService.run(RELEASE_TASK_QUERY, {
            taskId,
            projectId: resolvedProjectId,
            agentId,
            reason: releaseReason || 'No reason provided',
          });

          if (result.length === 0) {
            // Get current state for better error message
            const stateResult = await neo4jService.run(GET_TASK_STATE_QUERY, {
              taskId,
              projectId: resolvedProjectId,
            });
            const currentState = stateResult[0];
            return createErrorResponse(
              `Cannot release task ${taskId}. ` +
                (currentState
                  ? `Current state: ${currentState.status}, claimedBy: ${currentState.claimedBy || 'none'}`
                  : 'Task not found.'),
            );
          }

          return createSuccessResponse(JSON.stringify({ action: 'released', taskId: result[0].id }));
        }

        // Handle abandon action (release with tracking)
        if (action === 'abandon') {
          if (!taskId) {
            return createErrorResponse('taskId is required for abandon action');
          }

          const result = await neo4jService.run(ABANDON_TASK_QUERY, {
            taskId,
            projectId: resolvedProjectId,
            agentId,
            reason: releaseReason || 'No reason provided',
          });

          if (result.length === 0) {
            const stateResult = await neo4jService.run(GET_TASK_STATE_QUERY, {
              taskId,
              projectId: resolvedProjectId,
            });
            const currentState = stateResult[0];
            return createErrorResponse(
              `Cannot abandon task ${taskId}. ` +
                (currentState
                  ? `Current state: ${currentState.status}, claimedBy: ${currentState.claimedBy || 'none'}`
                  : 'Task not found.'),
            );
          }

          const abandonCount =
            typeof result[0].abandonCount === 'object' ? result[0].abandonCount.toNumber() : result[0].abandonCount;
          return createSuccessResponse(JSON.stringify({ action: 'abandoned', taskId: result[0].id, abandonCount }));
        }

        // Handle force_start action (recovery from stuck claimed state)
        if (action === 'force_start') {
          if (!taskId) {
            return createErrorResponse('taskId is required for force_start action');
          }

          const result = await neo4jService.run(FORCE_START_QUERY, {
            taskId,
            projectId: resolvedProjectId,
            agentId,
            reason: releaseReason || 'Recovering from stuck state',
          });

          if (result.length === 0) {
            const stateResult = await neo4jService.run(GET_TASK_STATE_QUERY, {
              taskId,
              projectId: resolvedProjectId,
            });
            const currentState = stateResult[0];
            return createErrorResponse(
              `Cannot force_start task ${taskId}. ` +
                (currentState
                  ? `Current state: ${currentState.status}, claimedBy: ${currentState.claimedBy || 'none'}. ` +
                    `force_start requires status=claimed|available and you must be the claimant.`
                  : 'Task not found.'),
            );
          }

          return createSuccessResponse(
            JSON.stringify({ action: 'force_started', taskId: result[0].id, status: 'in_progress' }),
          );
        }

        // Handle start action
        if (action === 'start') {
          if (!taskId) {
            return createErrorResponse('taskId is required for start action');
          }

          const result = await neo4jService.run(START_TASK_QUERY, {
            taskId,
            projectId: resolvedProjectId,
            agentId,
          });

          if (result.length === 0) {
            // Get current state for better error message
            const stateResult = await neo4jService.run(GET_TASK_STATE_QUERY, {
              taskId,
              projectId: resolvedProjectId,
            });
            const currentState = stateResult[0];
            return createErrorResponse(
              `Cannot start task ${taskId}. ` +
                (currentState
                  ? `Current state: ${currentState.status}, claimedBy: ${currentState.claimedBy || 'none'}. ` +
                    `Tip: Use action="force_start" to recover from stuck claimed state, ` +
                    `or action="abandon" to release the task.`
                  : 'Task not found.'),
            );
          }

          return createSuccessResponse(
            JSON.stringify({ action: 'started', taskId: result[0].id, status: 'in_progress' }),
          );
        }

        // Handle claim and claim_and_start actions
        // Determine target status based on action
        const targetStatus = action === 'claim_and_start' ? 'in_progress' : 'claimed';

        let result;
        let retryCount = 0;

        if (taskId) {
          // Claim specific task
          result = await neo4jService.run(CLAIM_TASK_BY_ID_QUERY, {
            taskId,
            projectId: resolvedProjectId,
            agentId,
            targetStatus,
          });

          if (result.length === 0) {
            const stateResult = await neo4jService.run(GET_TASK_STATE_QUERY, {
              taskId,
              projectId: resolvedProjectId,
            });
            const currentState = stateResult[0];
            return createErrorResponse(
              `Cannot claim task ${taskId}. ` +
                (currentState
                  ? `Current state: ${currentState.status}, claimedBy: ${currentState.claimedBy || 'none'}`
                  : 'Task not found or has incomplete dependencies.'),
            );
          }
        } else {
          // Auto-select highest priority available task with retry logic
          const minPriorityScore = minPriority ? TASK_PRIORITIES[minPriority as TaskPriority] : null;

          // Retry loop to handle race conditions
          while (retryCount < MAX_CLAIM_RETRIES) {
            result = await neo4jService.run(CLAIM_NEXT_TASK_QUERY, {
              projectId: resolvedProjectId,
              swarmId,
              agentId,
              types: types || null,
              minPriority: minPriorityScore,
              targetStatus,
            });

            if (result.length > 0) {
              break; // Successfully claimed a task
            }

            retryCount++;
            if (retryCount < MAX_CLAIM_RETRIES) {
              // Wait before retry with exponential backoff
              await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_BASE_MS * Math.pow(2, retryCount - 1)));
            }
          }

          if (!result || result.length === 0) {
            return createSuccessResponse(JSON.stringify({ action: 'no_tasks', retryAttempts: retryCount }));
          }
        }

        const task = result[0];

        const actionLabel = action === 'claim_and_start' ? 'claimed_and_started' : 'claimed';

        // Extract valid targets (resolved via :TARGETS relationship)
        const resolvedTargets = (task.targets || [])
          .filter((t: { id?: string }) => t?.id)
          .map((t: { id: string; name?: string; filePath?: string }) => ({
            nodeId: t.id,
            name: t.name,
            filePath: t.filePath,
          }));

        // Fetch pending messages for this agent (direct delivery on claim)
        let pendingMessages: any[] = [];
        try {
          const msgResult = await neo4jService.run(PENDING_MESSAGES_FOR_AGENT_QUERY, {
            projectId: resolvedProjectId,
            swarmId,
            agentId,
          });

          if (msgResult.length > 0) {
            pendingMessages = msgResult.map((m: any) => {
              const ts =
                typeof m.timestamp === 'object' && m.timestamp?.toNumber ? m.timestamp.toNumber() : m.timestamp;
              return {
                id: m.id,
                from: m.fromAgentId,
                category: m.category,
                content: m.content,
                taskId: m.taskId ?? undefined,
                filePaths: m.filePaths?.length > 0 ? m.filePaths : undefined,
                age: ts ? `${Math.round((Date.now() - ts) / 1000)}s ago` : null,
              };
            });

            // Auto-acknowledge delivered messages
            const deliveredIds = pendingMessages.map((m: any) => m.id);
            await neo4jService.run(AUTO_ACKNOWLEDGE_QUERY, {
              messageIds: deliveredIds,
              agentId,
            });
          }
        } catch (msgError) {
          // Non-fatal: message delivery failure shouldn't block task claim
          await debugLog('Swarm claim task: message delivery failed (non-fatal)', { error: String(msgError) });
        }

        // Slim response - only essential fields for agent to do work
        return createSuccessResponse(
          JSON.stringify({
            action: actionLabel,
            task: {
              id: task.id,
              title: task.title,
              description: task.description,
              status: task.status,
              type: task.type,
              // Prefer resolved targets over stored nodeIds (resolved targets are from graph relationships)
              targets: resolvedTargets.length > 0 ? resolvedTargets : undefined,
              targetNodeIds: task.targetNodeIds?.length > 0 ? task.targetNodeIds : undefined,
              targetFilePaths: task.targetFilePaths,
              ...(task.dependencies?.length > 0 && { dependencies: task.dependencies }),
            },
            ...(pendingMessages.length > 0 && { messages: pendingMessages }),
            ...(retryCount > 0 && { retryAttempts: retryCount }),
          }),
        );
      } catch (error) {
        await debugLog('Swarm claim task error', { error: String(error) });
        return createErrorResponse(error instanceof Error ? error : String(error));
      } finally {
        await neo4jService.close();
      }
    },
  );
};
