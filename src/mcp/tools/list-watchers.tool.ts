/**
 * List Watchers Tool
 * Lists all active file watchers
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { TOOL_NAMES, TOOL_METADATA } from '../constants.js';
import { watchManager } from '../services/watch-manager.js';
import { createEmptyResponse, createErrorResponse, createSuccessResponse, debugLog } from '../utils.js';

export const createListWatchersTool = (server: McpServer): void => {
  server.registerTool(
    TOOL_NAMES.listWatchers,
    {
      title: TOOL_METADATA[TOOL_NAMES.listWatchers].title,
      description: TOOL_METADATA[TOOL_NAMES.listWatchers].description,
      inputSchema: {},
    },
    async () => {
      try {
        const watchers = watchManager.listWatchers();

        if (watchers.length === 0) {
          return createEmptyResponse(
            'No active file watchers',
            'Use start_watch_project to begin watching, or parse_typescript_project with watch=true.',
          );
        }

        const header = `Found ${watchers.length} active watcher(s):\n\n`;

        const watcherList = watchers
          .map((w) => {
            const lines = [
              `- ${w.projectId} [${w.status}]`,
              `  Path: ${w.projectPath}`,
              `  Debounce: ${w.debounceMs}ms`,
              `  Pending changes: ${w.pendingChanges}`,
            ];

            if (w.lastUpdateTime) {
              lines.push(`  Last update: ${w.lastUpdateTime}`);
            }

            if (w.errorMessage) {
              lines.push(`  Error: ${w.errorMessage}`);
            }

            return lines.join('\n');
          })
          .join('\n\n');

        const tip = '\n\nUse stop_watch_project with a project ID to stop watching.';

        return createSuccessResponse(header + watcherList + tip);
      } catch (error) {
        console.error('List watchers error:', error);
        await debugLog('List watchers error', { error });
        return createErrorResponse(error instanceof Error ? error : new Error(String(error)));
      }
    },
  );
};
