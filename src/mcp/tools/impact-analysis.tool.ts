/**
 * Impact Analysis Tool
 * Analyzes what would be affected if a node is modified
 * Reuses cross-file edge pattern from incremental parsing
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { Neo4jService, QUERIES } from '../../storage/neo4j/neo4j.service.js';
import { TOOL_NAMES, TOOL_METADATA } from '../constants.js';
import { createErrorResponse, createSuccessResponse, debugLog, resolveProjectIdOrError } from '../utils.js';

/**
 * Default relationship weights for impact/risk analysis.
 *
 * NOTE: These weights are intentionally different from CoreEdge.relationshipWeight
 * in the core schema. They serve different purposes:
 *
 * - Core schema weights (traversalWeight): "What relationships help me understand the code?"
 *   → CALLS is high (0.85) because following execution flow aids comprehension
 *
 * - Impact analysis weights: "What breaks if I modify this node?"
 *   → EXTENDS/IMPLEMENTS are highest (0.95) because changing a base class/interface
 *     breaks ALL subclasses/implementers - inheritance is a hard contract
 *
 * Example: A class with 50 callers and 10 subclasses
 * - For traversal: follow the 50 CALLS to understand usage patterns
 * - For impact: the 10 subclasses are CRITICAL - they inherit the contract
 */
const DEFAULT_RELATIONSHIP_WEIGHTS: Record<string, number> = {
  // Critical - inheritance/interface contracts (changing base breaks ALL children)
  EXTENDS: 0.95,
  IMPLEMENTS: 0.95,

  // High - direct code dependencies (callers may break but often handle changes)
  CALLS: 0.75,
  HAS_MEMBER: 0.65,
  TYPED_AS: 0.6,

  // Medium - module dependencies
  IMPORTS: 0.5,
  EXPORTS: 0.5,

  // Lower - structural (container doesn't break if child changes)
  CONTAINS: 0.3,
  HAS_PARAMETER: 0.3,
  DECORATED_WITH: 0.4,
};

// Schema for framework-specific configuration
const FrameworkConfigSchema = z.object({
  relationshipWeights: z.record(z.string(), z.number().min(0).max(1)).optional(),
  highRiskTypes: z.array(z.string()).optional(),
  name: z.string().optional(),
});

export type FrameworkConfig = z.infer<typeof FrameworkConfigSchema>;

interface Dependent {
  nodeId: string;
  name: string;
  labels: string[];
  semanticType: string | null;
  coreType: string | null;
  filePath: string;
  relationshipType: string;
  weight: number;
  depth?: number;
  relationshipPath?: string[];
}

export const createImpactAnalysisTool = (server: McpServer): void => {
  server.registerTool(
    TOOL_NAMES.impactAnalysis,
    {
      title: TOOL_METADATA[TOOL_NAMES.impactAnalysis].title,
      description: TOOL_METADATA[TOOL_NAMES.impactAnalysis].description,
      inputSchema: {
        projectId: z.string().describe('Project ID, name, or path (e.g., "backend" or "proj_a1b2c3d4e5f6")'),
        nodeId: z
          .string()
          .optional()
          .describe('The node ID to analyze impact for (from search_codebase or traverse_from_node results)'),
        filePath: z
          .string()
          .optional()
          .describe('Alternatively, provide a file path to analyze all exports from that file'),
        maxDepth: z
          .number()
          .int()
          .min(1)
          .max(6)
          .optional()
          .describe('Maximum depth for transitive dependent traversal')
          .default(4),
        frameworkConfig: FrameworkConfigSchema.optional().describe(
          'Framework-specific configuration for risk scoring. Includes relationshipWeights (e.g., {"INJECTS": 0.9}), highRiskTypes (e.g., ["Controller", "Service"]), and optional name.',
        ),
      },
    },
    async ({ projectId, nodeId, filePath, maxDepth = 4, frameworkConfig }) => {
      const neo4jService = new Neo4jService();
      try {
        // Resolve project ID from name, path, or ID
        const projectResult = await resolveProjectIdOrError(projectId, neo4jService);
        if (!projectResult.success) return projectResult.error;
        const resolvedProjectId = projectResult.projectId;

        if (!nodeId && !filePath) {
          return createErrorResponse('Either nodeId or filePath must be provided');
        }

        // Merge default weights with framework-specific weights
        const weights = { ...DEFAULT_RELATIONSHIP_WEIGHTS, ...frameworkConfig?.relationshipWeights };
        const highRiskTypes = new Set(frameworkConfig?.highRiskTypes ?? []);

        let targetInfo: { id: string; name: string; type: string; filePath: string };
        let directDependents: Dependent[];

        if (nodeId) {
          // Get target node info
          const targetResult = await neo4jService.run(QUERIES.GET_NODE_BY_ID, { nodeId, projectId: resolvedProjectId });
          if (targetResult.length === 0) {
            return createErrorResponse(`Node with ID "${nodeId}" not found in project "${resolvedProjectId}"`);
          }
          const target = targetResult[0];
          targetInfo = {
            id: target.id,
            name: target.name ?? 'Unknown',
            type: target.semanticType ?? target.coreType ?? target.labels?.[0] ?? 'Unknown',
            filePath: target.filePath ?? '',
          };

          // Get direct dependents using cross-file edge pattern
          const directResult = await neo4jService.run(QUERIES.GET_NODE_IMPACT, {
            nodeId,
            projectId: resolvedProjectId,
          });
          directDependents = normalizeDependents(directResult);
        } else {
          // File-based analysis - find all Class/Function/Interface entities in the file
          // and aggregate their impact analysis results
          const entitiesQuery = `
            MATCH (n)
            WHERE n.projectId = $projectId
              AND (n.filePath = $filePath OR n.filePath ENDS WITH '/' + $filePath)
              AND (n:Class OR n:Function OR n:Interface)
            RETURN n.id AS nodeId, n.name AS name, labels(n) AS labels,
                   n.semanticType AS semanticType, n.coreType AS coreType
          `;

          const entities = await neo4jService.run(entitiesQuery, {
            filePath,
            projectId: resolvedProjectId,
          });

          if (entities.length === 0) {
            // No exportable entities found
            targetInfo = {
              id: filePath!,
              name: filePath!.split('/').pop() ?? filePath!,
              type: 'SourceFile',
              filePath: filePath!,
            };
            directDependents = [];
          } else {
            // Use first entity as the primary target for display
            const primaryEntity = entities[0];
            targetInfo = {
              id: primaryEntity.nodeId as string,
              name: (primaryEntity.name as string) ?? filePath!.split('/').pop() ?? filePath!,
              type: (primaryEntity.semanticType as string) ?? (primaryEntity.coreType as string) ?? 'Class',
              filePath: filePath!,
            };

            // Aggregate impact from all entities in the file
            const allDependentsMap = new Map<string, Dependent>();

            for (const entity of entities) {
              const entityResult = await neo4jService.run(QUERIES.GET_NODE_IMPACT, {
                nodeId: entity.nodeId,
                projectId: resolvedProjectId,
              });

              for (const dep of normalizeDependents(entityResult)) {
                // Dedupe by nodeId, keeping highest weight
                const existing = allDependentsMap.get(dep.nodeId);
                if (!existing || dep.weight > existing.weight) {
                  allDependentsMap.set(dep.nodeId, dep);
                }
              }
            }

            directDependents = Array.from(allDependentsMap.values());

            // Update nodeId for transitive analysis if we have dependents
            if (directDependents.length > 0 && entities.length > 0) {
              // Use first entity's nodeId for transitive analysis
              nodeId = primaryEntity.nodeId as string;
            }
          }
        }

        // Get transitive dependents if nodeId provided
        let transitiveDependents: Dependent[] = [];
        if (nodeId && maxDepth > 1) {
          const transitiveResult = await neo4jService.run(QUERIES.GET_TRANSITIVE_DEPENDENTS(maxDepth), {
            nodeId,
            projectId: resolvedProjectId,
          });
          transitiveDependents = normalizeTransitiveDependents(transitiveResult);

          // Filter out direct dependents from transitive
          const directIds = new Set(directDependents.map((d) => d.nodeId));
          transitiveDependents = transitiveDependents.filter((d) => !directIds.has(d.nodeId));
        }

        // Calculate risk score
        const riskScore = calculateRiskScore(directDependents, transitiveDependents, weights, highRiskTypes);
        const riskLevel = getRiskLevel(riskScore);

        // Group dependents by type
        const directByType = groupByType(directDependents);
        const directByRelationship = groupByRelationship(directDependents);
        const transitiveByType = groupByType(transitiveDependents);

        // Get affected files
        const affectedFiles = getAffectedFiles([...directDependents, ...transitiveDependents]);

        // Find critical paths (high-weight relationships)
        const criticalPaths = findCriticalPaths(directDependents, targetInfo, weights);

        // Build summary
        const summary = buildSummary(
          targetInfo,
          directDependents.length,
          transitiveDependents.length,
          affectedFiles.length,
          riskLevel,
        );

        const result = {
          target: targetInfo,
          riskLevel,
          riskScore: Math.round(riskScore * 100) / 100,
          summary,
          directDependents: {
            count: directDependents.length,
            byType: directByType,
            byRelationship: directByRelationship,
          },
          transitiveDependents: {
            count: transitiveDependents.length,
            maxDepth: getMaxDepth(transitiveDependents),
            byType: transitiveByType,
          },
          affectedFiles,
          criticalPaths,
        };

        return createSuccessResponse(JSON.stringify(result, null, 2));
      } catch (error) {
        console.error('Impact analysis error:', error);
        await debugLog('Impact analysis error', { nodeId, filePath, error });
        return createErrorResponse(error);
      } finally {
        await neo4jService.close();
      }
    },
  );
};

// Helper functions

const normalizeDependents = (results: Record<string, unknown>[]): Dependent[] => {
  return results.map((r) => ({
    nodeId: r.nodeId as string,
    name: (r.name as string) ?? 'Unknown',
    labels: (r.labels as string[]) ?? [],
    semanticType: r.semanticType as string | null,
    coreType: r.coreType as string | null,
    filePath: (r.filePath as string) ?? '',
    relationshipType: (r.relationshipType as string) ?? 'UNKNOWN',
    weight:
      typeof r.weight === 'object'
        ? (r.weight as { toNumber: () => number }).toNumber()
        : ((r.weight as number) ?? 0.5),
  }));
};

const normalizeTransitiveDependents = (results: Record<string, unknown>[]): Dependent[] => {
  return results.map((r) => ({
    nodeId: r.nodeId as string,
    name: (r.name as string) ?? 'Unknown',
    labels: (r.labels as string[]) ?? [],
    semanticType: r.semanticType as string | null,
    coreType: r.coreType as string | null,
    filePath: (r.filePath as string) ?? '',
    relationshipType: (r.relationshipPath as string[])?.[0] ?? 'UNKNOWN',
    weight: 0.5,
    depth: typeof r.depth === 'object' ? (r.depth as { toNumber: () => number }).toNumber() : (r.depth as number),
    relationshipPath: r.relationshipPath as string[],
  }));
};

const calculateRiskScore = (
  directDependents: Dependent[],
  transitiveDependents: Dependent[],
  weights: Record<string, number>,
  highRiskTypes: Set<string>,
): number => {
  if (directDependents.length === 0) return 0;

  let score = 0;

  // Factor 1: Number of direct dependents (logarithmic, max 0.3)
  score += Math.min(Math.log10(directDependents.length + 1) / 2, 0.3);

  // Factor 2: Average relationship weight of direct deps (max 0.3)
  const avgWeight =
    directDependents.reduce((sum, d) => sum + (weights[d.relationshipType] ?? d.weight), 0) / directDependents.length;
  score += avgWeight * 0.3;

  // Factor 3: High-risk types affected (max 0.2)
  const highRiskCount = directDependents.filter(
    (d) => highRiskTypes.has(d.semanticType ?? '') || highRiskTypes.has(d.coreType ?? ''),
  ).length;
  if (highRiskTypes.size > 0) {
    score += Math.min(highRiskCount / Math.max(highRiskTypes.size, 3), 1) * 0.2;
  }

  // Factor 4: Transitive impact (max 0.2)
  score += Math.min(Math.log10(transitiveDependents.length + 1) / 3, 0.2);

  return Math.min(score, 1);
};

const getRiskLevel = (score: number): 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL' => {
  if (score >= 0.75) return 'CRITICAL';
  if (score >= 0.5) return 'HIGH';
  if (score >= 0.25) return 'MEDIUM';
  return 'LOW';
};

const groupByType = (dependents: Dependent[]): Record<string, number> => {
  const groups: Record<string, number> = {};
  for (const dep of dependents) {
    const type = dep.semanticType ?? dep.coreType ?? dep.labels?.[0] ?? 'Unknown';
    groups[type] = (groups[type] ?? 0) + 1;
  }
  return groups;
};

const groupByRelationship = (dependents: Dependent[]): Record<string, number> => {
  const groups: Record<string, number> = {};
  for (const dep of dependents) {
    groups[dep.relationshipType] = (groups[dep.relationshipType] ?? 0) + 1;
  }
  return groups;
};

const getAffectedFiles = (dependents: Dependent[]): string[] => {
  const files = new Set<string>();
  for (const dep of dependents) {
    if (dep.filePath) files.add(dep.filePath);
  }
  return Array.from(files).sort();
};

const getMaxDepth = (dependents: Dependent[]): number => {
  if (dependents.length === 0) return 0;
  return Math.max(...dependents.map((d) => d.depth ?? 1));
};

const findCriticalPaths = (
  directDependents: Dependent[],
  target: { name: string; type: string },
  weights: Record<string, number>,
): string[] => {
  const paths: string[] = [];

  for (const dep of directDependents) {
    const relWeight = weights[dep.relationshipType] ?? 0.5;
    // Only include high-weight relationships
    if (relWeight >= 0.6) {
      const depType = dep.semanticType ?? dep.coreType ?? '';
      paths.push(`${dep.name} (${depType}) -[${dep.relationshipType}]-> ${target.name} (${target.type})`);
    }
  }

  return paths.slice(0, 10);
};

const buildSummary = (
  target: { name: string; type: string },
  directCount: number,
  transitiveCount: number,
  fileCount: number,
  riskLevel: string,
): string => {
  if (directCount === 0) {
    return `${target.name} (${target.type}) has no external dependents - safe to modify`;
  }

  return `Modifying ${target.name} (${target.type}) affects ${directCount} direct and ${transitiveCount} transitive dependents across ${fileCount} files. Risk: ${riskLevel}`;
};
