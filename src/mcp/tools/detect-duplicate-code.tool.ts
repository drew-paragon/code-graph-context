/**
 * Detect Duplicate Code Tool
 * Identifies duplicate code using structural (AST hash) and semantic (embedding similarity) analysis
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import {
  toNumber,
  isUIComponent,
  getMonorepoAppName,
  getShortPath,
  truncateSourceCode,
  type StructuralDuplicateResult,
  type SemanticDuplicateResult,
} from '../../core/utils/shared-utils.js';
import { Neo4jService, QUERIES } from '../../storage/neo4j/neo4j.service.js';
import { TOOL_NAMES, TOOL_METADATA } from '../constants.js';
import { createEmptyResponse, createErrorResponse, createSuccessResponse, debugLog, resolveProjectIdOrError } from '../utils.js';

// Types
type Scope = 'methods' | 'functions' | 'classes' | 'all';
type ConfidenceLevel = 'HIGH' | 'MEDIUM' | 'LOW';
type DuplicateCategory = 'ui-component' | 'cross-app' | 'same-file' | 'cross-file';

interface DuplicateItem {
  nodeId: string;
  name: string;
  coreType: string;
  semanticType: string | null;
  filePath: string;
  lineNumber: number;
  sourceCode?: string;
}

interface DuplicateGroup {
  groupId: string;
  type: 'structural' | 'semantic';
  similarity: number;
  confidence: ConfidenceLevel;
  category: DuplicateCategory;
  items: DuplicateItem[];
  recommendation: string;
}

/**
 * Determine confidence based on duplicate characteristics.
 */
const determineConfidence = (
  type: 'structural' | 'semantic',
  similarity: number,
  itemCount: number,
): ConfidenceLevel => {
  if (type === 'structural') {
    // Structural duplicates with identical hash are high confidence
    return 'HIGH';
  }

  // Semantic duplicates: confidence based on similarity and item count
  if (similarity >= 0.9 && itemCount >= 2) {
    return 'HIGH';
  }
  if (similarity >= 0.85) {
    return 'MEDIUM';
  }
  return 'LOW';
};

/**
 * Check if items are in different monorepo apps.
 */
const areInDifferentApps = (items: DuplicateItem[]): boolean => {
  const apps = new Set(items.map((i) => getMonorepoAppName(i.filePath)).filter(Boolean));
  return apps.size > 1;
};

/**
 * Analyze duplicates and generate category + recommendation.
 */
const analyzeAndRecommend = (
  type: 'structural' | 'semantic',
  items: DuplicateItem[],
): { category: DuplicateCategory; recommendation: string } => {
  const names = [...new Set(items.map((i) => i.name))].slice(0, 3).join(', ');
  const filesAffected = new Set(items.map((i) => i.filePath)).size;

  // Check for UI component patterns
  const allUIComponents = items.every((i) => isUIComponent(i.filePath));
  if (allUIComponents) {
    return {
      category: 'ui-component',
      recommendation: `UI components ${names} have similar structure - likely intentional co-location`,
    };
  }

  // Check for monorepo cross-app duplicates
  if (areInDifferentApps(items)) {
    const apps = [...new Set(items.map((i) => getMonorepoAppName(i.filePath)).filter(Boolean))];
    return {
      category: 'cross-app',
      recommendation: `Code duplicated across apps (${apps.slice(0, 3).join(', ')}) - consider shared package if unifying`,
    };
  }

  // Same file duplicates
  if (filesAffected === 1) {
    return {
      category: 'same-file',
      recommendation:
        type === 'structural'
          ? `Consider extracting shared logic from ${names} into a single method`
          : `Review ${names} for potential consolidation`,
    };
  }

  // Cross-file duplicates (default)
  return {
    category: 'cross-file',
    recommendation:
      type === 'structural'
        ? `Consider extracting ${names} into a shared utility function`
        : `Semantically similar code in ${names} - consider unifying the approach`,
  };
};

/**
 * Map scope to core types for filtering.
 */
const getScopeFilter = (scope: Scope): string[] => {
  switch (scope) {
    case 'methods':
      return ['MethodDeclaration'];
    case 'functions':
      return ['FunctionDeclaration'];
    case 'classes':
      return ['ClassDeclaration'];
    case 'all':
    default:
      return ['MethodDeclaration', 'FunctionDeclaration', 'ClassDeclaration'];
  }
};

export const createDetectDuplicateCodeTool = (server: McpServer): void => {
  server.registerTool(
    TOOL_NAMES.detectDuplicateCode,
    {
      title: TOOL_METADATA[TOOL_NAMES.detectDuplicateCode].title,
      description: TOOL_METADATA[TOOL_NAMES.detectDuplicateCode].description,
      inputSchema: {
        projectId: z.string().describe('Project ID, name, or path'),
        type: z
          .enum(['structural', 'semantic', 'all'])
          .optional()
          .describe('Detection approach: structural (AST hash), semantic (embeddings), or all')
          .default('all'),
        minSimilarity: z
          .number()
          .min(0.5)
          .max(1.0)
          .optional()
          .describe('Minimum similarity threshold for semantic duplicates')
          .default(0.8),
        includeCode: z
          .boolean()
          .optional()
          .describe('Include source code snippets in results')
          .default(false),
        maxResults: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .describe('Max duplicate groups to return')
          .default(20),
        scope: z
          .enum(['methods', 'functions', 'classes', 'all'])
          .optional()
          .describe('Node types to analyze')
          .default('all'),
        summaryOnly: z
          .boolean()
          .optional()
          .describe('Return summary statistics only, no duplicates list')
          .default(false),
        offset: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe('Groups to skip for pagination')
          .default(0),
        vectorNeighbors: z
          .number()
          .int()
          .min(10)
          .max(200)
          .optional()
          .describe('Vector neighbors per node (higher = more thorough)')
          .default(50),
      },
    },
    async ({
      projectId,
      type = 'all',
      minSimilarity = 0.8,
      includeCode = false,
      maxResults = 20,
      scope = 'all',
      summaryOnly = false,
      offset = 0,
      vectorNeighbors = 50,
    }) => {
      const neo4jService = new Neo4jService();
      try {
        // Resolve project ID
        const projectResult = await resolveProjectIdOrError(projectId, neo4jService);
        if (!projectResult.success) return projectResult.error;
        const resolvedProjectId = projectResult.projectId;

        const coreTypes = getScopeFilter(scope as Scope);
        const duplicateGroups: DuplicateGroup[] = [];
        let groupCounter = 1;
        const includeStructuralInOutput = type === 'structural' || type === 'all';

        // 1. Find structural duplicates (always run for filtering, only include in output if requested)
        // This ensures semantic-only mode filters out exact copy pairs
        const structuralPairs = new Set<string>(); // Pairs of nodeIds that are exact copies
        {
          const structuralResult = (await neo4jService.run(QUERIES.FIND_STRUCTURAL_DUPLICATES, {
            projectId: resolvedProjectId,
            coreTypes,
            limit: Math.floor(maxResults * 10), // Get extra for grouping (each group has multiple items)
          })) as StructuralDuplicateResult[];

          // Group by normalizedHash
          const hashGroups = new Map<string, DuplicateItem[]>();

          for (const item of structuralResult) {
            const hash = item.normalizedHash;
            if (!hash) continue;

            const duplicateItem: DuplicateItem = {
              nodeId: item.nodeId,
              name: item.name,
              coreType: item.coreType,
              semanticType: item.semanticType ?? null,
              filePath: item.filePath,
              lineNumber: toNumber(item.lineNumber),
            };

            if (includeCode) {
              duplicateItem.sourceCode = truncateSourceCode(item.sourceCode);
            }

            if (!hashGroups.has(hash)) {
              hashGroups.set(hash, []);
            }
            hashGroups.get(hash)!.push(duplicateItem);
          }

          // Convert to duplicate groups (only groups with 2+ items are duplicates)
          for (const [, items] of hashGroups) {
            if (items.length >= 2) {
              // Track all pairs within this group for semantic filtering
              // This ensures we only filter pairs that are EXACT copies of each other
              for (let i = 0; i < items.length; i++) {
                for (let j = i + 1; j < items.length; j++) {
                  const pairKey = [items[i].nodeId, items[j].nodeId].sort().join('::');
                  structuralPairs.add(pairKey);
                }
              }

              // Only add to output if structural was requested
              if (includeStructuralInOutput) {
                const { category, recommendation } = analyzeAndRecommend('structural', items);
                duplicateGroups.push({
                  groupId: `dup_${groupCounter++}`,
                  type: 'structural',
                  similarity: 1.0,
                  confidence: determineConfidence('structural', 1.0, items.length),
                  category,
                  items,
                  recommendation,
                });
              }
            }
          }
        }

        // 2. Find semantic duplicates (embedding similarity)
        // Diagnostic counters to debug filtering
        let semanticQueryResults = 0;
        let filteredAsSameFile = 0;
        let filteredAsSeenPair = 0;
        let filteredAsStructural = 0;
        let filteredAsUsedInGroup = 0;
        let semanticQueryError: string | null = null;

        if (type === 'semantic' || type === 'all') {
          let semanticResult: SemanticDuplicateResult[] = [];

          try {
            semanticResult = (await neo4jService.run(QUERIES.FIND_SEMANTIC_DUPLICATES, {
              projectId: resolvedProjectId,
              coreTypes,
              minSimilarity,
              vectorNeighbors,
              limit: Math.floor(maxResults * 2), // Get extra for filtering (ensure integer)
            })) as SemanticDuplicateResult[];
          } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            // Check for vector index errors
            if (
              errorMessage.includes('vector') ||
              errorMessage.includes('index') ||
              errorMessage.includes('embedding')
            ) {
              semanticQueryError =
                'Semantic duplicate detection requires embeddings. ' +
                'Re-parse the project with embeddings enabled (useEmbeddings: true) to enable this feature.';
              await debugLog('Semantic query skipped - vector index not available', { error: errorMessage });
            } else {
              // Re-throw non-vector-index errors
              throw error;
            }
          }

          // Process semantic pairs
          const seenPairs = new Set<string>();
          const usedInSemanticGroup = new Set<string>();

          for (const pair of semanticResult) {
            semanticQueryResults++;

            const nodeId1 = pair.nodeId1;
            const nodeId2 = pair.nodeId2;
            const similarity = toNumber(pair.similarity);

            // Skip if same file (same-file similarity is expected)
            if (pair.filePath1 === pair.filePath2) {
              filteredAsSameFile++;
              continue;
            }

            // Skip if already seen this pair
            const pairKey = [nodeId1, nodeId2].sort().join('::');
            if (seenPairs.has(pairKey)) {
              filteredAsSeenPair++;
              continue;
            }
            seenPairs.add(pairKey);

            // Skip if this specific pair is already a structural duplicate (exact copies of each other)
            if (structuralPairs.has(pairKey)) {
              filteredAsStructural++;
              continue;
            }

            // Skip if either node is already in a semantic duplicate group (first match wins)
            if (usedInSemanticGroup.has(nodeId1) || usedInSemanticGroup.has(nodeId2)) {
              filteredAsUsedInGroup++;
              continue;
            }

            const items: DuplicateItem[] = [
              {
                nodeId: nodeId1,
                name: pair.name1,
                coreType: pair.coreType1,
                semanticType: pair.semanticType1 ?? null,
                filePath: pair.filePath1,
                lineNumber: toNumber(pair.lineNumber1),
              },
              {
                nodeId: nodeId2,
                name: pair.name2,
                coreType: pair.coreType2,
                semanticType: pair.semanticType2 ?? null,
                filePath: pair.filePath2,
                lineNumber: toNumber(pair.lineNumber2),
              },
            ];

            if (includeCode) {
              items[0].sourceCode = truncateSourceCode(pair.sourceCode1);
              items[1].sourceCode = truncateSourceCode(pair.sourceCode2);
            }

            const { category, recommendation } = analyzeAndRecommend('semantic', items);
            duplicateGroups.push({
              groupId: `dup_${groupCounter++}`,
              type: 'semantic',
              similarity: Math.round(similarity * 1000) / 1000,
              confidence: determineConfidence('semantic', similarity, 2),
              category,
              items,
              recommendation,
            });

            // Mark both nodes as used to prevent appearing in multiple groups
            usedInSemanticGroup.add(nodeId1);
            usedInSemanticGroup.add(nodeId2);
          }
        }

        // Sort by similarity (descending)
        duplicateGroups.sort((a, b) => b.similarity - a.similarity);

        // Calculate statistics on ALL groups before pagination
        const allStructuralGroups = duplicateGroups.filter((g) => g.type === 'structural');
        const allSemanticGroups = duplicateGroups.filter((g) => g.type === 'semantic');
        const totalGroups = duplicateGroups.length;
        const totalDuplicates = duplicateGroups.reduce((sum, g) => sum + g.items.length, 0);
        const affectedFiles = [...new Set(duplicateGroups.flatMap((g) => g.items.map((i) => i.filePath)))].sort();

        const byType = {
          structural: {
            groups: allStructuralGroups.length,
            items: allStructuralGroups.reduce((sum, g) => sum + g.items.length, 0),
          },
          semantic: {
            groups: allSemanticGroups.length,
            items: allSemanticGroups.reduce((sum, g) => sum + g.items.length, 0),
          },
        };

        // Check embedding count for diagnostic (do this before building summary)
        let embeddingCount = 0;
        let semanticDiagnostic: { nodesWithEmbeddings: number; message: string } | null = null;

        if ((type === 'semantic' || type === 'all') && allSemanticGroups.length === 0) {
          const embeddingCountResult = await neo4jService.run(
            `MATCH (n:Embedded) WHERE n.projectId = $projectId RETURN count(n) AS count`,
            { projectId: resolvedProjectId },
          );
          embeddingCount = toNumber(embeddingCountResult[0]?.count);

          if (embeddingCount === 0) {
            semanticDiagnostic = {
              nodesWithEmbeddings: 0,
              message:
                'No nodes have embeddings. Re-parse with OPENAI_API_KEY set to enable semantic duplicate detection.',
            };
          } else {
            semanticDiagnostic = {
              nodesWithEmbeddings: embeddingCount,
              message: `${embeddingCount} nodes have embeddings but no semantic duplicates found above ${minSimilarity} similarity threshold.`,
            };
          }
        }

        // Early return for zero results
        if (totalGroups === 0) {
          return createEmptyResponse(
            'No duplicate code found',
            semanticDiagnostic
              ? `Semantic analysis note: ${semanticDiagnostic}. Try lowering minSimilarity or changing scope.`
              : 'Try lowering minSimilarity or broadening scope.',
          );
        }

        // Build summary with warning if no embeddings
        let summary = `Found ${totalGroups} duplicate code groups across ${affectedFiles.length} files`;

        if (semanticQueryError) {
          summary += ` (Warning: ${semanticQueryError})`;
        } else if ((type === 'semantic' || type === 'all') && embeddingCount === 0 && allSemanticGroups.length === 0) {
          summary += ' (Warning: No embeddings for semantic detection)';
        }

        // Build result based on summaryOnly flag
        let result: Record<string, unknown>;

        if (summaryOnly) {
          // Summary mode: statistics only, no full arrays
          const fileDuplicateCounts: Record<string, number> = {};
          for (const group of duplicateGroups) {
            for (const item of group.items) {
              const shortPath = getShortPath(item.filePath);
              fileDuplicateCounts[shortPath] = (fileDuplicateCounts[shortPath] ?? 0) + 1;
            }
          }
          const topFilesByDuplicates = Object.entries(fileDuplicateCounts)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 20)
            .map(([file, count]) => ({ file, count }));

          result = {
            summary,
            totalGroups,
            totalDuplicates,
            byType,
            affectedFiles,
            topFilesByDuplicates,
          };
        } else {
          // Paginated mode: apply offset/maxResults
          const paginatedGroups = duplicateGroups.slice(offset, offset + maxResults);
          const hasMore = offset + maxResults < duplicateGroups.length;

          result = {
            summary,
            totalGroups,
            totalDuplicates,
            byType,
            duplicates: paginatedGroups,
            pagination: {
              offset,
              limit: maxResults,
              returned: paginatedGroups.length,
              hasMore,
            },
            affectedFiles,
          };
        }

        // Add pre-computed diagnostic to result
        if (semanticDiagnostic) {
          result.semanticDiagnostic = semanticDiagnostic;
        }

        return createSuccessResponse(JSON.stringify(result, null, 2));
      } catch (error) {
        console.error('Duplicate code detection error:', error);
        await debugLog('Duplicate code detection error', { projectId, error });
        return createErrorResponse(error);
      } finally {
        await neo4jService.close();
      }
    },
  );
};
