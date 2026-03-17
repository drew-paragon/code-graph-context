/**
 * Session Bookmark Tools
 * Save and restore session context for cross-session continuity
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { Neo4jService } from '../../storage/neo4j/neo4j.service.js';
import { TOOL_NAMES, TOOL_METADATA } from '../constants.js';
import { createEmptyResponse, createErrorResponse, createSuccessResponse, resolveProjectIdOrError, debugLog } from '../utils.js';

/**
 * Neo4j query to create a SessionBookmark node and link to code nodes
 */
const CREATE_BOOKMARK_QUERY = `
  CREATE (b:SessionBookmark {
    id: $bookmarkId,
    projectId: $projectId,
    sessionId: $sessionId,
    agentId: $agentId,
    summary: $summary,
    workingSetNodeIds: $workingSetNodeIds,
    taskContext: $taskContext,
    findings: $findings,
    nextSteps: $nextSteps,
    metadata: $metadata,
    createdAt: timestamp(),
    updatedAt: timestamp()
  })

  // Link to referenced code nodes (exclude coordination nodes)
  WITH b
  OPTIONAL MATCH (target)
  WHERE target.id IN $workingSetNodeIds
    AND target.projectId = $projectId
    AND NOT target:Pheromone
    AND NOT target:SwarmTask
    AND NOT target:SessionBookmark
    AND NOT target:SessionNote
  WITH b, collect(DISTINCT target) AS targets
  FOREACH (t IN targets | MERGE (b)-[:REFERENCES]->(t))

  RETURN b.id AS id,
         b.sessionId AS sessionId,
         b.agentId AS agentId,
         b.summary AS summary,
         b.taskContext AS taskContext,
         b.createdAt AS createdAt,
         size(targets) AS linkedNodes
`;

/**
 * Neo4j query to find the most recent SessionBookmark matching filters
 */
const FIND_BOOKMARK_QUERY = `
  MATCH (b:SessionBookmark)
  WHERE b.projectId = $projectId
    AND ($sessionId IS NULL OR b.sessionId = $sessionId)
    AND ($agentId IS NULL OR b.agentId = $agentId)
  RETURN b.id AS id,
         b.projectId AS projectId,
         b.sessionId AS sessionId,
         b.agentId AS agentId,
         b.summary AS summary,
         b.workingSetNodeIds AS workingSetNodeIds,
         b.taskContext AS taskContext,
         b.findings AS findings,
         b.nextSteps AS nextSteps,
         b.metadata AS metadata,
         b.createdAt AS createdAt,
         b.updatedAt AS updatedAt
  ORDER BY b.createdAt DESC
  LIMIT 1
`;

/**
 * Neo4j query to get code nodes referenced by a bookmark
 */
const GET_BOOKMARK_WORKING_SET_QUERY = `
  MATCH (b:SessionBookmark {id: $bookmarkId, projectId: $projectId})-[:REFERENCES]->(target)
  WHERE NOT target:Pheromone
    AND NOT target:SwarmTask
    AND NOT target:SessionBookmark
    AND NOT target:SessionNote
  RETURN target.id AS id,
         target.projectId AS projectId,
         labels(target)[0] AS type,
         target.name AS name,
         target.filePath AS filePath,
         CASE WHEN $includeCode THEN target.sourceCode ELSE null END AS sourceCode,
         target.coreType AS coreType,
         target.semanticType AS semanticType,
         target.startLine AS startLine,
         target.endLine AS endLine
  ORDER BY target.filePath, target.startLine
`;

/**
 * Neo4j query to get SessionNote nodes linked to a bookmark's session
 */
const GET_SESSION_NOTES_QUERY = `
  MATCH (n:SessionNote)
  WHERE n.projectId = $projectId
    AND n.sessionId = $sessionId
    AND (n.expiresAt IS NULL OR n.expiresAt > timestamp())

  OPTIONAL MATCH (n)-[:ABOUT]->(codeNode)
  WHERE NOT codeNode:SessionNote
    AND NOT codeNode:SessionBookmark
    AND NOT codeNode:Pheromone
    AND NOT codeNode:SwarmTask

  RETURN n.id AS id,
         n.topic AS topic,
         n.content AS content,
         n.category AS category,
         n.severity AS severity,
         n.agentId AS agentId,
         n.sessionId AS sessionId,
         n.createdAt AS createdAt,
         n.expiresAt AS expiresAt,
         collect(DISTINCT {id: codeNode.id, name: codeNode.name, filePath: codeNode.filePath}) AS aboutNodes
  ORDER BY n.createdAt ASC
  LIMIT 50
`;

export const createSaveSessionBookmarkTool = (server: McpServer): void => {
  server.registerTool(
    TOOL_NAMES.saveSessionBookmark,
    {
      title: TOOL_METADATA[TOOL_NAMES.saveSessionBookmark].title,
      description: TOOL_METADATA[TOOL_NAMES.saveSessionBookmark].description,
      inputSchema: {
        projectId: z.string().describe('Project ID, name, or path (e.g., "backend" or "proj_a1b2c3d4e5f6")'),
        sessionId: z.string().describe('Unique session identifier (e.g., conversation ID) for cross-session recovery'),
        agentId: z.string().describe('Agent identifier for this bookmark'),
        summary: z.string().min(10).describe('Brief summary of current work state'),
        workingSetNodeIds: z
          .array(z.string())
          .describe('Code node IDs currently being focused on (from search_codebase or traverse_from_node)'),
        taskContext: z.string().describe('High-level task currently being worked on'),
        findings: z.string().optional().default('').describe('Key discoveries or decisions made so far'),
        nextSteps: z.string().optional().default('').describe('What to do next when resuming this session'),
        metadata: z.record(z.unknown()).optional().describe('Additional structured data to store with the bookmark'),
      },
    },
    async ({
      projectId,
      sessionId,
      agentId,
      summary,
      workingSetNodeIds,
      taskContext,
      findings = '',
      nextSteps = '',
      metadata,
    }) => {
      const neo4jService = new Neo4jService();

      const projectResult = await resolveProjectIdOrError(projectId, neo4jService);
      if (!projectResult.success) {
        await neo4jService.close();
        return projectResult.error;
      }
      const resolvedProjectId = projectResult.projectId;

      try {
        const bookmarkId = `bookmark_${Date.now().toString(36)}_${Math.random().toString(36).substring(2, 8)}`;
        const metadataJson = metadata ? JSON.stringify(metadata) : null;

        const result = await neo4jService.run(CREATE_BOOKMARK_QUERY, {
          bookmarkId,
          projectId: resolvedProjectId,
          sessionId,
          agentId,
          summary,
          workingSetNodeIds,
          taskContext,
          findings,
          nextSteps,
          metadata: metadataJson,
        });

        if (result.length === 0) {
          return createErrorResponse('Failed to create session bookmark');
        }

        const bookmark = result[0];
        const linkedNodes =
          typeof bookmark.linkedNodes === 'object' && bookmark.linkedNodes?.toNumber
            ? bookmark.linkedNodes.toNumber()
            : (bookmark.linkedNodes ?? 0);

        return createSuccessResponse(
          JSON.stringify({
            success: true,
            bookmarkId: bookmark.id,
            sessionId: bookmark.sessionId,
            agentId: bookmark.agentId,
            projectId: resolvedProjectId,
            summary: bookmark.summary,
            taskContext: bookmark.taskContext,
            workingSetSize: workingSetNodeIds.length,
            linkedNodes,
            createdAt:
              typeof bookmark.createdAt === 'object' && bookmark.createdAt?.toNumber
                ? bookmark.createdAt.toNumber()
                : bookmark.createdAt,
            message: `Session bookmark saved. ${linkedNodes} of ${workingSetNodeIds.length} working set nodes linked in graph.`,
          }),
        );
      } catch (error) {
        await debugLog('Save session bookmark error', { error: String(error) });
        return createErrorResponse(error instanceof Error ? error : String(error));
      } finally {
        await neo4jService.close();
      }
    },
  );
};

export const createRestoreSessionBookmarkTool = (server: McpServer): void => {
  server.registerTool(
    TOOL_NAMES.restoreSessionBookmark,
    {
      title: TOOL_METADATA[TOOL_NAMES.restoreSessionBookmark].title,
      description: TOOL_METADATA[TOOL_NAMES.restoreSessionBookmark].description,
      inputSchema: {
        projectId: z.string().describe('Project ID, name, or path (e.g., "backend" or "proj_a1b2c3d4e5f6")'),
        sessionId: z
          .string()
          .optional()
          .describe('Specific session ID to restore. If omitted, restores the most recent bookmark.'),
        agentId: z
          .string()
          .optional()
          .describe('Filter bookmarks by agent ID. If omitted, returns bookmarks from any agent.'),
        includeCode: z
          .boolean()
          .optional()
          .default(true)
          .describe('Include source code snippets for working set nodes'),
        snippetLength: z
          .number()
          .int()
          .min(50)
          .max(5000)
          .optional()
          .default(500)
          .describe('Max characters per code snippet'),
      },
    },
    async ({ projectId, sessionId, agentId, includeCode = true, snippetLength = 500 }) => {
      const neo4jService = new Neo4jService();

      const projectResult = await resolveProjectIdOrError(projectId, neo4jService);
      if (!projectResult.success) {
        await neo4jService.close();
        return projectResult.error;
      }
      const resolvedProjectId = projectResult.projectId;

      try {
        // Find the most recent matching bookmark
        const bookmarkRows = await neo4jService.run(FIND_BOOKMARK_QUERY, {
          projectId: resolvedProjectId,
          sessionId: sessionId ?? null,
          agentId: agentId ?? null,
        });

        if (bookmarkRows.length === 0) {
          return createEmptyResponse(
            sessionId
              ? `No bookmark found for session "${sessionId}" in project ${resolvedProjectId}`
              : `No bookmarks found for project ${resolvedProjectId}`,
            'Save a bookmark first with save_session_bookmark, or check the sessionId.',
          );
        }

        const bm = bookmarkRows[0];

        // Fetch working set nodes linked in the graph
        const workingSetRows = await neo4jService.run(GET_BOOKMARK_WORKING_SET_QUERY, {
          bookmarkId: bm.id,
          projectId: resolvedProjectId,
          includeCode,
        });

        // Fetch any session notes for this session
        const noteRows = await neo4jService.run(GET_SESSION_NOTES_QUERY, {
          projectId: resolvedProjectId,
          sessionId: bm.sessionId,
        });

        // Build working set with optional code truncation
        const workingSet = workingSetRows.map((row: any) => {
          const node: Record<string, unknown> = {
            id: row.id,
            type: row.type,
            name: row.name,
            filePath: row.filePath,
            coreType: row.coreType,
            semanticType: row.semanticType,
            startLine:
              typeof row.startLine === 'object' && row.startLine?.toNumber ? row.startLine.toNumber() : row.startLine,
            endLine: typeof row.endLine === 'object' && row.endLine?.toNumber ? row.endLine.toNumber() : row.endLine,
          };

          if (includeCode && row.sourceCode) {
            const code: string = row.sourceCode;
            if (code.length <= snippetLength) {
              node.sourceCode = code;
            } else {
              const half = Math.floor(snippetLength / 2);
              node.sourceCode =
                code.substring(0, half) + '\n\n... [truncated] ...\n\n' + code.substring(code.length - half);
              node.truncated = true;
            }
          }

          return node;
        });

        const notes = noteRows.map((n: any) => {
          const aboutNodes = (n.aboutNodes ?? []).filter((node: any) => node?.id != null);
          return {
            id: n.id,
            topic: n.topic,
            content: n.content,
            category: n.category,
            severity: n.severity,
            agentId: n.agentId,
            sessionId: n.sessionId,
            createdAt: typeof n.createdAt === 'object' && n.createdAt?.toNumber ? n.createdAt.toNumber() : n.createdAt,
            expiresAt: typeof n.expiresAt === 'object' && n.expiresAt?.toNumber ? n.expiresAt.toNumber() : n.expiresAt,
            aboutNodes,
          };
        });

        // Identify working set nodes not found in the graph (stale IDs after re-parse)
        const foundIds = new Set(workingSetRows.map((r: any) => r.id));
        const storedIds: string[] = Array.isArray(bm.workingSetNodeIds) ? bm.workingSetNodeIds : [];
        const staleNodeIds = storedIds.filter((id) => !foundIds.has(id));

        return createSuccessResponse(
          JSON.stringify({
            success: true,
            bookmark: {
              id: bm.id,
              projectId: resolvedProjectId,
              sessionId: bm.sessionId,
              agentId: bm.agentId,
              summary: bm.summary,
              taskContext: bm.taskContext,
              findings: bm.findings,
              nextSteps: bm.nextSteps,
              metadata: bm.metadata ? JSON.parse(bm.metadata) : null,
              createdAt:
                typeof bm.createdAt === 'object' && bm.createdAt?.toNumber ? bm.createdAt.toNumber() : bm.createdAt,
              updatedAt:
                typeof bm.updatedAt === 'object' && bm.updatedAt?.toNumber ? bm.updatedAt.toNumber() : bm.updatedAt,
            },
            workingSet,
            notes,
            staleNodeIds,
            stats: {
              workingSetTotal: storedIds.length,
              workingSetFound: workingSet.length,
              workingSetStale: staleNodeIds.length,
              notesCount: notes.length,
            },
          }),
        );
      } catch (error) {
        await debugLog('Restore session bookmark error', { error: String(error) });
        return createErrorResponse(error instanceof Error ? error : String(error));
      } finally {
        await neo4jService.close();
      }
    },
  );
};
