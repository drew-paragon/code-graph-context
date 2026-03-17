/**
 * Detect Dead Code Tool
 * Identifies potentially unused code in the codebase
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import {
  toNumber,
  isUIComponent,
  isPackageExport,
  isExcludedByPattern,
  getShortPath,
  type UnreferencedExportResult,
  type UncalledPrivateMethodResult,
  type UnreferencedInterfaceResult,
  type FrameworkEntryPointResult,
} from '../../core/utils/shared-utils.js';
import { Neo4jService, QUERIES } from '../../storage/neo4j/neo4j.service.js';
import { TOOL_NAMES, TOOL_METADATA } from '../constants.js';
import { createErrorResponse, createSuccessResponse, debugLog, resolveProjectIdOrError } from '../utils.js';

// Result type for semantic types query
interface SemanticTypeResult {
  semanticType: string;
}

// Default file patterns to exclude
const DEFAULT_ENTRY_POINT_FILE_PATTERNS = [
  // Common entry points
  'main.ts',
  'app.ts',
  'index.ts',
  // NestJS
  '*.module.ts',
  '*.controller.ts',
  // Fastify / Express
  '*.routes.ts',
  '*.router.ts',
  '*.handler.ts',
  'server.ts',
  // Next.js / React frameworks (file-based routing)
  'page.tsx',
  'page.ts',
  'layout.tsx',
  'layout.ts',
  'route.tsx',
  'route.ts',
  'loading.tsx',
  'error.tsx',
  'not-found.tsx',
  'template.tsx',
  'default.tsx',
  // Remix
  'root.tsx',
  // Astro
  '*.astro',
];

// Confidence levels
type ConfidenceLevel = 'HIGH' | 'MEDIUM' | 'LOW';

// Dead code categories for filtering
type DeadCodeCategory = 'library-export' | 'ui-component' | 'internal-unused';

interface DeadCodeItem {
  nodeId: string;
  name: string;
  type: string;
  coreType: string;
  semanticType: string | null;
  filePath: string;
  lineNumber: number;
  confidence: ConfidenceLevel;
  confidenceReason: string;
  category: DeadCodeCategory;
  reason: string;
}

interface EntryPoint {
  nodeId: string;
  name: string;
  type: string;
  semanticType: string | null;
  filePath: string;
}

/**
 * Determine confidence level based on code characteristics.
 * Returns both the level and a human-readable explanation.
 */
const determineConfidence = (item: {
  isExported?: boolean;
  visibility?: string;
  coreType: string;
  reason: string;
}): { level: ConfidenceLevel; reason: string } => {
  // HIGH: Exported but definitively never imported
  if (item.isExported && item.reason.includes('never imported')) {
    return { level: 'HIGH', reason: 'Exported but never imported anywhere' };
  }

  // MEDIUM: Private with no internal calls
  if (item.visibility === 'private') {
    return { level: 'MEDIUM', reason: 'Private method with no internal callers' };
  }

  // LOW: Could be used dynamically
  return { level: 'LOW', reason: 'Could be used via dynamic references' };
};

/**
 * Calculate risk level based on dead code count.
 */
const getRiskLevel = (totalCount: number, highCount: number): 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL' => {
  if (highCount >= 20 || totalCount >= 50) return 'CRITICAL';
  if (highCount >= 10 || totalCount >= 25) return 'HIGH';
  if (highCount >= 5 || totalCount >= 10) return 'MEDIUM';
  return 'LOW';
};

/**
 * Check if confidence meets minimum threshold.
 */
const shouldInclude = (confidence: ConfidenceLevel, minConfidence: ConfidenceLevel): boolean => {
  const levels: ConfidenceLevel[] = ['LOW', 'MEDIUM', 'HIGH'];
  return levels.indexOf(confidence) >= levels.indexOf(minConfidence);
};

/**
 * Check if semantic type is excluded.
 */
const isExcludedBySemanticType = (semanticType: string | null, excludeTypes: string[]): boolean => {
  return semanticType != null && excludeTypes.includes(semanticType);
};

/**
 * Determine category of dead code item based on file path.
 */
const determineCategory = (filePath: string): DeadCodeCategory => {
  if (isUIComponent(filePath)) return 'ui-component';
  if (isPackageExport(filePath)) return 'library-export';
  return 'internal-unused';
};

export const createDetectDeadCodeTool = (server: McpServer): void => {
  server.registerTool(
    TOOL_NAMES.detectDeadCode,
    {
      title: TOOL_METADATA[TOOL_NAMES.detectDeadCode].title,
      description: TOOL_METADATA[TOOL_NAMES.detectDeadCode].description,
      inputSchema: {
        projectId: z.string().describe('Project ID, name, or path'),
        excludePatterns: z
          .array(z.string())
          .optional()
          .describe('Additional file patterns to exclude as entry points'),
        excludeSemanticTypes: z
          .array(z.string())
          .optional()
          .describe('Additional semantic types to exclude'),
        includeEntryPoints: z
          .boolean()
          .optional()
          .describe('Include excluded entry points in audit section')
          .default(true),
        minConfidence: z
          .enum(['LOW', 'MEDIUM', 'HIGH'])
          .optional()
          .describe('Minimum confidence threshold for results')
          .default('LOW'),
        summaryOnly: z
          .boolean()
          .optional()
          .describe('Return summary statistics only, no item list')
          .default(false),
        limit: z
          .number()
          .int()
          .min(1)
          .max(500)
          .optional()
          .describe('Max dead code items per page')
          .default(100),
        offset: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe('Items to skip for pagination')
          .default(0),
        filterCategory: z
          .enum(['library-export', 'ui-component', 'internal-unused', 'all'])
          .optional()
          .describe('Filter results to a specific category')
          .default('all'),
        excludeLibraryExports: z
          .boolean()
          .optional()
          .describe('Exclude items from packages/* directories')
          .default(false),
        excludeCoreTypes: z
          .array(z.string())
          .optional()
          .describe('Core types to exclude from results')
          .default([]),
      },
    },
    async ({
      projectId,
      excludePatterns = [],
      excludeSemanticTypes = [],
      includeEntryPoints = true,
      minConfidence = 'LOW',
      summaryOnly = false,
      limit = 100,
      offset = 0,
      filterCategory = 'all',
      excludeLibraryExports = false,
      excludeCoreTypes = [],
    }) => {
      const neo4jService = new Neo4jService();
      try {
        // Resolve project ID
        const projectResult = await resolveProjectIdOrError(projectId, neo4jService);
        if (!projectResult.success) return projectResult.error;
        const resolvedProjectId = projectResult.projectId;

        // Query project's actual semantic types (data-driven, per-project detection)
        const semanticTypesResult = (await neo4jService.run(QUERIES.GET_PROJECT_SEMANTIC_TYPES, {
          projectId: resolvedProjectId,
        })) as SemanticTypeResult[];
        const projectSemanticTypes = semanticTypesResult.map((r) => r.semanticType);

        // Combine project semantic types with user-provided exclusions
        const allExcludeSemanticTypes = [...projectSemanticTypes, ...excludeSemanticTypes];
        const allExcludePatterns = [...DEFAULT_ENTRY_POINT_FILE_PATTERNS, ...excludePatterns];

        // Run all queries in parallel for better performance
        const [unreferencedExports, uncalledPrivateMethods, unreferencedInterfaces, entryPointsResult] =
          await Promise.all([
            // 1. Find unreferenced exports
            neo4jService.run(QUERIES.FIND_UNREFERENCED_EXPORTS, {
              projectId: resolvedProjectId,
            }),
            // 2. Find uncalled private methods
            neo4jService.run(QUERIES.FIND_UNCALLED_PRIVATE_METHODS, {
              projectId: resolvedProjectId,
            }),
            // 3. Find unreferenced interfaces
            neo4jService.run(QUERIES.FIND_UNREFERENCED_INTERFACES, {
              projectId: resolvedProjectId,
            }),
            // 4. Get framework entry points for exclusion/audit (using project's semantic types)
            neo4jService.run(QUERIES.GET_FRAMEWORK_ENTRY_POINTS, {
              projectId: resolvedProjectId,
              semanticTypes: allExcludeSemanticTypes,
            }),
          ]);

        // Create set of entry point IDs for filtering
        const entryPointIds = new Set((entryPointsResult as FrameworkEntryPointResult[]).map((r) => r.nodeId));

        // Process and filter results
        const deadCodeItems: DeadCodeItem[] = [];

        // Process unreferenced exports
        for (const item of unreferencedExports as UnreferencedExportResult[]) {
          if (entryPointIds.has(item.nodeId)) continue;
          if (isExcludedByPattern(item.filePath, allExcludePatterns)) continue;
          if (isExcludedBySemanticType(item.semanticType, allExcludeSemanticTypes)) continue;

          const confidence = determineConfidence({
            isExported: true,
            coreType: item.coreType,
            reason: item.reason,
          });

          if (shouldInclude(confidence.level, minConfidence as ConfidenceLevel)) {
            const category = determineCategory(item.filePath);
            deadCodeItems.push({
              nodeId: item.nodeId,
              name: item.name,
              type: item.coreType,
              coreType: item.coreType,
              semanticType: item.semanticType ?? null,
              filePath: item.filePath,
              lineNumber: toNumber(item.lineNumber),
              confidence: confidence.level,
              confidenceReason: confidence.reason,
              category,
              reason: item.reason,
            });
          }
        }

        // Process uncalled private methods
        for (const item of uncalledPrivateMethods as UncalledPrivateMethodResult[]) {
          // Apply same exclusion checks as other dead code types
          if (entryPointIds.has(item.nodeId)) continue;
          if (isExcludedByPattern(item.filePath, allExcludePatterns)) continue;
          if (isExcludedBySemanticType(item.semanticType, allExcludeSemanticTypes)) continue;

          const confidence = determineConfidence({
            isExported: false,
            visibility: 'private',
            coreType: item.coreType,
            reason: item.reason,
          });

          if (shouldInclude(confidence.level, minConfidence as ConfidenceLevel)) {
            const category = determineCategory(item.filePath);
            deadCodeItems.push({
              nodeId: item.nodeId,
              name: item.name,
              type: item.coreType,
              coreType: item.coreType,
              semanticType: item.semanticType ?? null,
              filePath: item.filePath,
              lineNumber: toNumber(item.lineNumber),
              confidence: confidence.level,
              confidenceReason: confidence.reason,
              category,
              reason: item.reason,
            });
          }
        }

        // Process unreferenced interfaces
        for (const item of unreferencedInterfaces as UnreferencedInterfaceResult[]) {
          if (entryPointIds.has(item.nodeId)) continue;
          if (isExcludedByPattern(item.filePath, allExcludePatterns)) continue;

          const confidence = determineConfidence({
            isExported: true,
            coreType: item.coreType,
            reason: item.reason,
          });

          if (shouldInclude(confidence.level, minConfidence as ConfidenceLevel)) {
            const category = determineCategory(item.filePath);
            deadCodeItems.push({
              nodeId: item.nodeId,
              name: item.name,
              type: item.coreType,
              coreType: item.coreType,
              semanticType: item.semanticType ?? null,
              filePath: item.filePath,
              lineNumber: toNumber(item.lineNumber),
              confidence: confidence.level,
              confidenceReason: confidence.reason,
              category,
              reason: item.reason,
            });
          }
        }

        // Apply exclusion filters
        let filteredItems = deadCodeItems;

        // Exclude library exports if requested
        if (excludeLibraryExports) {
          filteredItems = filteredItems.filter((i) => i.category !== 'library-export');
        }

        // Exclude specific core types if requested
        if (excludeCoreTypes.length > 0) {
          filteredItems = filteredItems.filter((i) => !excludeCoreTypes.includes(i.coreType));
        }

        // Apply category filter if specified
        if (filterCategory !== 'all') {
          filteredItems = filteredItems.filter((i) => i.category === filterCategory);
        }

        // Calculate statistics on ALL items (before filtering)
        const byConfidence: Record<ConfidenceLevel, number> = {
          HIGH: deadCodeItems.filter((i) => i.confidence === 'HIGH').length,
          MEDIUM: deadCodeItems.filter((i) => i.confidence === 'MEDIUM').length,
          LOW: deadCodeItems.filter((i) => i.confidence === 'LOW').length,
        };

        const byCategory: Record<DeadCodeCategory, number> = {
          'library-export': deadCodeItems.filter((i) => i.category === 'library-export').length,
          'ui-component': deadCodeItems.filter((i) => i.category === 'ui-component').length,
          'internal-unused': deadCodeItems.filter((i) => i.category === 'internal-unused').length,
        };

        const byType: Record<string, number> = {};
        for (const item of deadCodeItems) {
          byType[item.type] = (byType[item.type] ?? 0) + 1;
        }

        // Use filtered items for affected files and output
        const affectedFiles = [...new Set(filteredItems.map((i) => i.filePath))].sort();
        const riskLevel = getRiskLevel(filteredItems.length, byConfidence.HIGH);

        // Build entry points list for audit
        const excludedEntryPoints: EntryPoint[] = includeEntryPoints
          ? (entryPointsResult as FrameworkEntryPointResult[]).map((r) => ({
              nodeId: r.nodeId,
              name: r.name,
              type: r.coreType ?? 'Unknown',
              semanticType: r.semanticType ?? null,
              filePath: r.filePath,
            }))
          : [];

        // Build summary based on filter
        const filterSuffix = filterCategory !== 'all' ? ` (filtered to ${filterCategory})` : '';
        const summary =
          filteredItems.length === 0
            ? 'No potentially dead code found' + filterSuffix
            : `Found ${filteredItems.length} potentially dead code items across ${affectedFiles.length} files` +
              filterSuffix;

        // Count entry points (always available)
        const excludedEntryPointsCount = entryPointsResult.length;

        // Compute top files by dead code count (used in both modes)
        const fileDeadCodeCounts: Record<string, number> = {};
        for (const item of filteredItems) {
          const shortPath = getShortPath(item.filePath);
          fileDeadCodeCounts[shortPath] = (fileDeadCodeCounts[shortPath] ?? 0) + 1;
        }
        const topFilesByDeadCode = Object.entries(fileDeadCodeCounts)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 20)
          .map(([file, count]) => ({ file, count }));

        // Build result based on summaryOnly flag
        let result: Record<string, unknown>;

        if (summaryOnly) {
          // Summary mode: statistics only, no full arrays
          result = {
            summary,
            riskLevel,
            totalCount: filteredItems.length,
            totalBeforeFilter: deadCodeItems.length,
            byConfidence,
            byCategory,
            byType,
            affectedFiles,
            topFilesByDeadCode,
            excludedEntryPointsCount,
          };
        } else {
          // Paginated mode: apply limit/offset
          const paginatedItems = filteredItems.slice(offset, offset + limit);
          const hasMore = offset + limit < filteredItems.length;

          result = {
            summary,
            riskLevel,
            totalCount: filteredItems.length,
            totalBeforeFilter: deadCodeItems.length,
            byConfidence,
            byCategory,
            byType,
            topFilesByDeadCode,
            deadCode: paginatedItems,
            pagination: {
              offset,
              limit,
              returned: paginatedItems.length,
              hasMore,
            },
            excludedEntryPointsCount,
            // Only include full entry points array on first page
            ...(offset === 0 && includeEntryPoints ? { excludedEntryPoints } : {}),
            affectedFiles,
          };
        }

        return createSuccessResponse(JSON.stringify(result, null, 2));
      } catch (error) {
        console.error('Dead code detection error:', error);
        await debugLog('Dead code detection error', { projectId, error });
        return createErrorResponse(error);
      } finally {
        await neo4jService.close();
      }
    },
  );
};
