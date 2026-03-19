import neo4j, { Driver } from 'neo4j-driver';

import { MAX_TRAVERSAL_DEPTH } from '../../constants.js';
import { getTimeoutConfig } from '../../core/config/timeouts.js';
export class Neo4jService {
  private driver: Driver;

  constructor() {
    this.driver = this.createDriver();
  }

  private createDriver() {
    const uri = process.env.NEO4J_URI ?? 'bolt://localhost:7687';
    const user = process.env.NEO4J_USER ?? 'neo4j';
    const password = process.env.NEO4J_PASSWORD ?? 'PASSWORD';
    const timeoutConfig = getTimeoutConfig();

    return neo4j.driver(uri, neo4j.auth.basic(user, password), {
      connectionTimeout: timeoutConfig.neo4j.connectionTimeoutMs,
      maxTransactionRetryTime: timeoutConfig.neo4j.queryTimeoutMs,
    });
  }

  public async run(query: string, params: Record<string, any> = {}) {
    const session = this.driver.session();
    const timeoutConfig = getTimeoutConfig();
    try {
      const result = await session.run(query, params, {
        timeout: timeoutConfig.neo4j.queryTimeoutMs,
      });
      return result.records.map((record) => record.toObject());
    } catch (error: any) {
      // Provide helpful error message for timeout
      if (error.code === 'Neo.TransientError.Transaction.Terminated') {
        throw new Error(
          `Neo4j query timed out after ${timeoutConfig.neo4j.queryTimeoutMs}ms. ` +
            'Consider simplifying the query or increasing NEO4J_QUERY_TIMEOUT_MS.',
        );
      }
      console.error('Error running query:', error);
      throw error;
    } finally {
      // Wrap session close in try-catch to avoid masking the original error
      try {
        await session.close();
      } catch (closeError) {
        // Log but don't re-throw to preserve original error
        console.warn('Error closing Neo4j session:', closeError);
      }
    }
  }

  public getDriver() {
    return this.driver;
  }

  /**
   * Close the Neo4j driver connection.
   * Should be called when the service is no longer needed to release resources.
   */
  public async close(): Promise<void> {
    if (this.driver) {
      await this.driver.close();
    }
  }
}

export const QUERIES = {
  // Project-scoped deletion - only deletes nodes for the specified project
  // Uses APOC batched deletion to avoid transaction memory limits on large projects
  CLEAR_PROJECT: `
    CALL apoc.periodic.iterate(
      'MATCH (n) WHERE n.projectId = $projectId RETURN n',
      'DETACH DELETE n',
      {batchSize: 1000, params: {projectId: $projectId}}
    )
    YIELD batches, total
    RETURN batches, total
  `,

  // Full database clear - use with caution, clears ALL projects
  // Uses APOC batched deletion to avoid transaction memory limits
  CLEAR_DATABASE: `
    CALL apoc.periodic.iterate(
      'MATCH (n) RETURN n',
      'DETACH DELETE n',
      {batchSize: 1000}
    )
    YIELD batches, total
    RETURN batches, total
  `,

  // Create indexes on projectId for efficient filtering across key node types
  CREATE_PROJECT_INDEX_EMBEDDED: 'CREATE INDEX project_embedded_idx IF NOT EXISTS FOR (n:Embedded) ON (n.projectId)',
  CREATE_PROJECT_INDEX_SOURCEFILE:
    'CREATE INDEX project_sourcefile_idx IF NOT EXISTS FOR (n:SourceFile) ON (n.projectId)',

  // Create composite indexes on projectId + id for efficient lookups
  CREATE_PROJECT_ID_INDEX_EMBEDDED:
    'CREATE INDEX project_id_embedded_idx IF NOT EXISTS FOR (n:Embedded) ON (n.projectId, n.id)',
  CREATE_PROJECT_ID_INDEX_SOURCEFILE:
    'CREATE INDEX project_id_sourcefile_idx IF NOT EXISTS FOR (n:SourceFile) ON (n.projectId, n.id)',

  // Create composite index on GraphNode for efficient edge resolution lookups
  CREATE_PROJECT_ID_INDEX_GRAPHNODE:
    'CREATE INDEX project_id_graphnode_idx IF NOT EXISTS FOR (n:GraphNode) ON (n.projectId, n.id)',

  // Create index on normalizedHash for efficient structural duplicate detection
  CREATE_NORMALIZED_HASH_INDEX: 'CREATE INDEX normalized_hash_idx IF NOT EXISTS FOR (n:Embedded) ON (n.normalizedHash)',

  CREATE_NODE: `
    UNWIND $nodes AS nodeData
    CALL apoc.create.node(nodeData.labels, nodeData.properties) YIELD node
    RETURN count(*) as created
  `,

  CREATE_RELATIONSHIP: `
    UNWIND $edges AS edgeData
    MATCH (start:GraphNode) WHERE start.id = edgeData.startNodeId AND start.projectId = $projectId
    MATCH (end:GraphNode) WHERE end.id = edgeData.endNodeId AND end.projectId = $projectId
    WITH start, end, edgeData
    CALL apoc.create.relationship(start, edgeData.type, edgeData.properties, end) YIELD rel
    RETURN count(*) as created
  `,

  CREATE_INDEX: (label: string, property: string) => `CREATE INDEX IF NOT EXISTS FOR (n:${label}) ON (n.${property})`,

  GET_STATS: `
    MATCH (n)
    WHERE n.projectId = $projectId
    RETURN labels(n)[0] as nodeType, count(*) as count
    ORDER BY count DESC
  `,

  CREATE_EMBEDDED_VECTOR_INDEX: (dimensions: number) => `
  CREATE VECTOR INDEX embedded_nodes_idx IF NOT EXISTS
  FOR (n:Embedded) ON (n.embedding)
  OPTIONS {indexConfig: {
    \`vector.dimensions\`: ${dimensions},
    \`vector.similarity_function\`: 'cosine'
  }}
`,

  CREATE_SESSION_NOTES_VECTOR_INDEX: (dimensions: number) => `
  CREATE VECTOR INDEX session_notes_idx IF NOT EXISTS
  FOR (n:SessionNote) ON (n.embedding)
  OPTIONS {indexConfig: {
    \`vector.dimensions\`: ${dimensions},
    \`vector.similarity_function\`: 'cosine'
  }}
`,

  // Indexes for efficient SessionBookmark and SessionNote lookups
  CREATE_SESSION_BOOKMARK_INDEX:
    'CREATE INDEX session_bookmark_idx IF NOT EXISTS FOR (n:SessionBookmark) ON (n.projectId, n.sessionId)',
  CREATE_SESSION_NOTE_INDEX:
    'CREATE INDEX session_note_idx IF NOT EXISTS FOR (n:SessionNote) ON (n.projectId, n.sessionId)',
  CREATE_SESSION_NOTE_CATEGORY_INDEX:
    'CREATE INDEX session_note_category_idx IF NOT EXISTS FOR (n:SessionNote) ON (n.projectId, n.category)',

  // Vector search with configurable fetch multiplier for project filtering.
  // fetchMultiplier (default: 10) controls how many extra results to fetch before filtering by projectId.
  // minSimilarity (default: 0.3) filters out low-confidence matches for nonsense queries.
  // Higher values = more accurate results but slower; lower values = faster but may miss results.
  VECTOR_SEARCH: `
  CALL db.index.vector.queryNodes('embedded_nodes_idx', toInteger($limit * coalesce($fetchMultiplier, 10)), $embedding)
  YIELD node, score
  WHERE node.projectId = $projectId AND score >= coalesce($minSimilarity, 0.3)
  WITH node, score
  LIMIT toInteger($limit)
  RETURN {
    id: node.id,
    labels: labels(node),
    properties: apoc.map.removeKeys(properties(node), ['embedding', 'contentHash', 'mtime', 'size'])
  } as node, score
  ORDER BY score DESC
`,

  // Check if index exists
  CHECK_VECTOR_INDEX: `
    SHOW INDEXES YIELD name, type
    WHERE name = 'node_embedding_idx' AND type = 'VECTOR'
    RETURN count(*) > 0 as exists
  `,

  GET_SOURCE_FILE_TRACKING_INFO: `
    MATCH (sf:SourceFile)
    WHERE sf.projectId = $projectId
    RETURN sf.filePath AS filePath,
           COALESCE(sf.mtime, 0) AS mtime,
           COALESCE(sf.size, 0) AS size,
           COALESCE(sf.contentHash, '') AS contentHash
  `,

  // Get cross-file edges before deletion (edges where one endpoint is outside the subgraph)
  // These will be recreated after import using deterministic IDs
  // Uses filePath matching instead of relationship traversal to avoid following INJECTS/IMPORTS
  GET_CROSS_FILE_EDGES: `
    MATCH (n)
    WHERE n.filePath IN $filePaths AND n.projectId = $projectId
    WITH collect(DISTINCT n) AS nodesToDelete
    UNWIND nodesToDelete AS node
    MATCH (node)-[r]-(other)
    WHERE NOT other IN nodesToDelete AND other.projectId = $projectId
    RETURN DISTINCT
      startNode(r).id AS startNodeId,
      endNode(r).id AS endNodeId,
      type(r) AS edgeType,
      properties(r) AS edgeProperties
  `,

  // Delete source file subgraphs (nodes and all their edges)
  // Uses filePath matching to delete only nodes belonging to the specified files
  // Avoids following INJECTS/IMPORTS edges which would delete nodes from other files
  DELETE_SOURCE_FILE_SUBGRAPHS: `
    MATCH (n)
    WHERE n.filePath IN $filePaths AND n.projectId = $projectId
    DETACH DELETE n
  `,

  // Recreate cross-file edges after import (uses deterministic IDs)
  RECREATE_CROSS_FILE_EDGES: `
    UNWIND $edges AS edge
    MATCH (startNode {id: edge.startNodeId})
    WHERE startNode.projectId = $projectId
    MATCH (endNode {id: edge.endNodeId})
    WHERE endNode.projectId = $projectId
    CALL apoc.create.relationship(startNode, edge.edgeType, edge.edgeProperties, endNode) YIELD rel
    RETURN count(rel) AS recreatedCount
  `,

  // Note: Dangling edge cleanup is not needed because:
  // 1. DETACH DELETE removes all edges when deleting nodes
  // 2. Edges cannot exist without both endpoints in Neo4j
  // The previous query (WHERE startNode(r) IS NULL OR endNode(r) IS NULL) could never match anything

  // Get existing nodes (excluding files being reparsed) for edge target matching
  // Returns minimal info needed for edge detection: id, name, coreType, semanticType
  // NOTE: Using property-based query instead of path traversal to avoid Cartesian explosion
  // The old query `MATCH (sf:SourceFile)-[*]->(n)` caused OOM with large graphs
  GET_EXISTING_NODES_FOR_EDGE_DETECTION: `
    MATCH (n)
    WHERE n.projectId = $projectId
      AND n.filePath IS NOT NULL
      AND NOT n.filePath IN $excludeFilePaths
    RETURN DISTINCT n.id AS id,
           n.name AS name,
           n.coreType AS coreType,
           n.semanticType AS semanticType,
           labels(n) AS labels,
           n.filePath AS filePath
  `,

  EXPLORE_ALL_CONNECTIONS: (
    maxDepth: number = MAX_TRAVERSAL_DEPTH,
    direction: 'OUTGOING' | 'INCOMING' | 'BOTH' = 'BOTH',
    relationshipTypes?: string[],
  ) => {
    const safeMaxDepth = Math.min(Math.max(maxDepth, 1), MAX_TRAVERSAL_DEPTH);

    // Build relationship pattern based on direction
    // For INCOMING, we reverse the match order: (connected)-[*]->(start) instead of (start)<-[*]-(connected)
    // This is because Neo4j variable-length patterns like <-[*1..N]- require ALL edges to point toward start,
    // but in multi-hop paths (A→B→C), intermediate edges (A→B) don't point toward C, causing 0 results.
    let relPattern = '';
    let isReversed = false;
    if (direction === 'OUTGOING') {
      relPattern = `-[*1..${safeMaxDepth}]->`;
    } else if (direction === 'INCOMING') {
      relPattern = `-[*1..${safeMaxDepth}]->`; // Same pattern as OUTGOING
      isReversed = true; // But we'll reverse start/connected in MATCH
    } else {
      relPattern = `-[*1..${safeMaxDepth}]-`;
    }

    // Build relationship type filter if specified
    // SECURITY: Validate relationship types to prevent Cypher injection
    // Only allow uppercase letters and underscores (valid Neo4j relationship type format)
    let relTypeFilter = '';
    if (relationshipTypes && relationshipTypes.length > 0) {
      const validRelTypePattern = /^[A-Z_]+$/;
      const validatedTypes = relationshipTypes.filter((t) => validRelTypePattern.test(t));
      if (validatedTypes.length !== relationshipTypes.length) {
        console.warn(
          'Some relationship types were filtered out due to invalid format. Valid format: uppercase letters and underscores only.',
        );
      }
      if (validatedTypes.length > 0) {
        const types = validatedTypes.map((t) => `'${t}'`).join(', ');
        relTypeFilter = `AND all(rel in relationships(path) WHERE type(rel) IN [${types}])`;
      }
    }

    // For INCOMING, reverse the match: (connected)-[*]->(start) finds nodes that can REACH start
    const matchPattern = isReversed ? `(connected)${relPattern}(start)` : `(start)${relPattern}(connected)`;

    return `
      MATCH (start) WHERE start.id = $nodeId AND start.projectId = $projectId

      CALL {
        WITH start
        MATCH path = ${matchPattern}
        WHERE connected <> start AND connected.projectId = $projectId
        ${relTypeFilter}
        WITH path, connected, length(path) as depth

        RETURN {
          id: connected.id,
          labels: labels(connected),
          properties: apoc.map.removeKeys(properties(connected), ['embedding', 'contentHash', 'mtime', 'size'])
        } as node,
        depth,
        [rel in relationships(path) | {
          type: type(rel),
          start: startNode(rel).id,
          end: endNode(rel).id,
          properties: properties(rel)
        }] as relationshipChain

      }

      WITH start, collect({
        node: node,
        depth: depth,
        relationshipChain: relationshipChain
      }) as allConnections

      WITH start, allConnections,
           allConnections[$skip..] as connections

      RETURN {
        startNode: {
          id: start.id,
          labels: labels(start),
          properties: apoc.map.removeKeys(properties(start), ['embedding', 'contentHash', 'mtime', 'size'])
        },
        connections: connections,
        totalConnections: size(allConnections),
        graph: {
          nodes: [conn in connections | conn.node] + [{
            id: start.id,
            labels: labels(start),
            properties: apoc.map.removeKeys(properties(start), ['embedding', 'contentHash', 'mtime', 'size'])
          }],
          relationships: reduce(rels = [], conn in connections | rels + conn.relationshipChain)
        }
      } as result
    `;
  },

  /**
   * DEPTH-BY-DEPTH WEIGHTED TRAVERSAL
   *
   * This query is called once per depth level, allowing you to score and prune
   * at each level before deciding which nodes to explore further.
   *
   * Parameters:
   *   $sourceNodeIds: string[] - Node IDs to explore FROM (starts with just start node)
   *   $visitedNodeIds: string[] - Node IDs already visited (to avoid cycles)
   *   $queryEmbedding: number[] - The original query embedding for similarity scoring
   *   $currentDepth: number - Which depth level we're at (1-indexed)
   *   $depthDecay: number - Decay factor per depth (e.g., 0.85 means 15% penalty per level)
   *   $maxNodesPerDepth: number - Maximum nodes to return at this depth
   *   $direction: 'OUTGOING' | 'INCOMING' | 'BOTH'
   *
   * How it works:
   *
   * 1. UNWIND $sourceNodeIds - For each node we're exploring FROM
   * 2. MATCH neighbors - Find all immediate neighbors (1 hop only)
   * 3. Filter out visited nodes - Avoid cycles
   * 4. Score each neighbor using:
   *    - edgeWeight: The relationshipWeight we added to edges (how important is this relationship type?)
   *    - nodeSimilarity: Cosine similarity between neighbor's embedding and query embedding
   *    - depthPenalty: Exponential decay based on current depth
   * 5. Combine: score = edgeWeight * nodeSimilarity * depthPenalty
   * 6. ORDER BY score DESC, LIMIT to top N
   * 7. Return scored neighbors - caller decides which to explore at next depth
   *
   * Example flow:
   *   Depth 1: sourceNodeIds=[startNode], returns top 5 neighbors with scores
   *   Depth 2: sourceNodeIds=[top 3 from depth 1], returns top 5 neighbors of those
   *   Depth 3: sourceNodeIds=[top 3 from depth 2], returns top 5 neighbors of those
   *   ...until maxDepth reached or no more neighbors
   */
  EXPLORE_DEPTH_LEVEL: (direction: 'OUTGOING' | 'INCOMING' | 'BOTH' = 'BOTH', maxNodesPerDepth: number = 5) => {
    // Build relationship pattern based on direction
    let relPattern = '';
    if (direction === 'OUTGOING') {
      relPattern = '-[rel]->';
    } else if (direction === 'INCOMING') {
      relPattern = '<-[rel]-';
    } else {
      relPattern = '-[rel]-';
    }

    return `
      // Unwind the source nodes we're exploring from
      UNWIND $sourceNodeIds AS sourceId
      MATCH (source) WHERE source.id = sourceId AND source.projectId = $projectId

      // Find immediate neighbors (exactly 1 hop)
      MATCH (source)${relPattern}(neighbor)

      // Filter: skip already visited nodes and ensure same project
      WHERE NOT neighbor.id IN $visitedNodeIds AND neighbor.projectId = $projectId

      // Calculate the three scoring components
      WITH source, neighbor, rel,

           // 1. Edge weight: how important is this relationship type?
           //    Falls back to 0.5 if not set
           COALESCE(rel.relationshipWeight, 0.5) AS edgeWeight,

           // 2. Node similarity: how relevant is this node to the query?
           //    Uses cosine similarity if neighbor has an embedding
           //    Falls back to 0.5 if no embedding (structural nodes like decorators)
           CASE
             WHEN neighbor.embedding IS NOT NULL AND $queryEmbedding IS NOT NULL
             THEN vector.similarity.cosine(neighbor.embedding, $queryEmbedding)
             ELSE 0.5
           END AS nodeSimilarity,

           // 3. Depth penalty: exponential decay
           //    depth 1: decay^0 = 1.0 (no penalty)
           //    depth 2: decay^1 = 0.85 (if decay=0.85)
           //    depth 3: decay^2 = 0.72
           //    This ensures closer nodes are preferred
           ($depthDecay ^ ($currentDepth - 1)) AS depthPenalty

      // Combine into final score
      WITH source, neighbor, rel, edgeWeight, nodeSimilarity, depthPenalty,
           (edgeWeight * nodeSimilarity * depthPenalty) AS combinedScore

      // Return all neighbor data with scores
      RETURN {
        node: {
          id: neighbor.id,
          labels: labels(neighbor),
          properties: apoc.map.removeKeys(properties(neighbor), ['embedding', 'contentHash', 'mtime', 'size'])
        },
        relationship: {
          type: type(rel),
          startNodeId: startNode(rel).id,
          endNodeId: endNode(rel).id,
          properties: properties(rel)
        },
        sourceNodeId: source.id,
        scoring: {
          edgeWeight: edgeWeight,
          nodeSimilarity: nodeSimilarity,
          depthPenalty: depthPenalty,
          combinedScore: combinedScore
        }
      } AS result

      // Sort by score and limit to top N per depth
      ORDER BY combinedScore DESC
      LIMIT toInteger(${maxNodesPerDepth})
    `;
  },

  // ============================================
  // DYNAMIC SCHEMA DISCOVERY QUERIES
  // ============================================

  /**
   * Get all distinct node labels with counts, property keys, and property types.
   * Samples up to 10 nodes per label to collect comprehensive property info.
   */
  DISCOVER_NODE_TYPES: `
    CALL db.labels() YIELD label
    CALL {
      WITH label
      MATCH (n) WHERE label IN labels(n) AND n.projectId = $projectId
      RETURN count(n) AS nodeCount
    }
    CALL {
      WITH label
      MATCH (n) WHERE label IN labels(n) AND n.projectId = $projectId
      WITH n LIMIT 10
      UNWIND keys(n) AS key
      WITH DISTINCT key, n[key] AS val
      RETURN collect(DISTINCT key) AS properties
    }
    RETURN label, nodeCount, properties
    ORDER BY nodeCount DESC
  `,

  /**
   * Get all distinct relationship types with counts and all connection patterns
   */
  DISCOVER_RELATIONSHIP_TYPES: `
    CALL db.relationshipTypes() YIELD relationshipType
    CALL {
      WITH relationshipType
      MATCH (a)-[r]->(b) WHERE type(r) = relationshipType AND a.projectId = $projectId AND b.projectId = $projectId
      RETURN count(r) AS relCount
    }
    CALL {
      WITH relationshipType
      MATCH (a)-[r]->(b) WHERE type(r) = relationshipType AND a.projectId = $projectId AND b.projectId = $projectId
      WITH DISTINCT labels(a)[0] AS fromLabel, labels(b)[0] AS toLabel
      RETURN collect({from: fromLabel, to: toLabel}) AS connections
    }
    RETURN relationshipType, relCount, connections
    ORDER BY relCount DESC
  `,

  /**
   * Get semantic types with counts and which label they appear on
   */
  DISCOVER_SEMANTIC_TYPES: `
    MATCH (n)
    WHERE n.semanticType IS NOT NULL AND n.projectId = $projectId
    WITH n.semanticType AS semanticType, labels(n)[0] AS nodeLabel, count(*) AS count
    RETURN semanticType, nodeLabel, count
    ORDER BY count DESC
  `,

  /**
   * Get all relationship patterns between node types
   */
  DISCOVER_COMMON_PATTERNS: `
    MATCH (a)-[r]->(b)
    WHERE a.projectId = $projectId AND b.projectId = $projectId
    WITH labels(a)[0] AS fromType, type(r) AS relType, labels(b)[0] AS toType, count(*) AS count
    WHERE count > 2
    RETURN fromType, relType, toType, count
    ORDER BY count DESC
    LIMIT 50
  `,

  // ============================================
  // IMPACT ANALYSIS QUERIES
  // Reuses cross-file edge pattern to find dependents
  // ============================================

  /**
   * Get node details by ID
   */
  GET_NODE_BY_ID: `
    MATCH (n) WHERE n.id = $nodeId AND n.projectId = $projectId
    RETURN n.id AS id,
           n.name AS name,
           labels(n) AS labels,
           n.semanticType AS semanticType,
           n.coreType AS coreType,
           n.filePath AS filePath
  `,

  /**
   * Get impact of changing a node - finds all external nodes that depend on it
   * Based on GET_CROSS_FILE_EDGES pattern but for a single node
   */
  GET_NODE_IMPACT: `
    MATCH (target) WHERE target.id = $nodeId AND target.projectId = $projectId
    MATCH (dependent)-[r]->(target)
    WHERE dependent.id <> target.id AND dependent.projectId = $projectId
    RETURN DISTINCT
      dependent.id AS nodeId,
      dependent.name AS name,
      labels(dependent) AS labels,
      dependent.semanticType AS semanticType,
      dependent.coreType AS coreType,
      dependent.filePath AS filePath,
      type(r) AS relationshipType,
      coalesce(r.relationshipWeight, 0.5) AS weight
  `,

  /**
   * Get impact of changing a file - finds all external nodes that depend on nodes in this file
   * Directly reuses GET_CROSS_FILE_EDGES pattern
   */
  GET_FILE_IMPACT: `
    MATCH (sf:SourceFile)
    WHERE sf.projectId = $projectId
      AND (sf.filePath = $filePath OR sf.filePath ENDS WITH '/' + $filePath)
    MATCH (sf)-[:CONTAINS]->(entity)
    WHERE entity:Class OR entity:Function OR entity:Interface
    WITH collect(DISTINCT entity) AS entitiesInFile, sf.filePath AS sourceFilePath
    UNWIND entitiesInFile AS n
    MATCH (dependent)-[r]->(n)
    WHERE NOT dependent IN entitiesInFile
      AND dependent.projectId = $projectId
      AND dependent.filePath <> sourceFilePath
    RETURN DISTINCT
      dependent.id AS nodeId,
      dependent.name AS name,
      labels(dependent) AS labels,
      dependent.semanticType AS semanticType,
      dependent.coreType AS coreType,
      dependent.filePath AS filePath,
      type(r) AS relationshipType,
      coalesce(r.relationshipWeight, 0.5) AS weight,
      n.id AS targetNodeId,
      n.name AS targetNodeName
  `,

  /**
   * Get transitive dependents - nodes that depend on dependents (for deeper impact)
   */
  GET_TRANSITIVE_DEPENDENTS: (maxDepth: number = 4) => `
    MATCH (target) WHERE target.id = $nodeId AND target.projectId = $projectId
    MATCH path = (dependent)-[*2..${maxDepth}]->(target)
    WHERE dependent.projectId = $projectId AND all(n IN nodes(path) WHERE n.projectId = $projectId)
    WITH dependent,
         length(path) AS depth,
         [r IN relationships(path) | type(r)] AS relationshipPath
    RETURN DISTINCT
      dependent.id AS nodeId,
      dependent.name AS name,
      labels(dependent) AS labels,
      dependent.semanticType AS semanticType,
      dependent.coreType AS coreType,
      dependent.filePath AS filePath,
      depth,
      relationshipPath
    ORDER BY depth ASC
  `,

  // ============================================
  // DEAD CODE DETECTION QUERIES
  // ============================================

  /**
   * Find exported classes/functions/interfaces with no incoming references from other files.
   * These are potentially dead code - exported but never imported or used.
   */
  FIND_UNREFERENCED_EXPORTS: `
    MATCH (n)
    WHERE n.projectId = $projectId
      AND n.isExported = true
      AND n.coreType IN ['ClassDeclaration', 'FunctionDeclaration', 'InterfaceDeclaration']
    WITH n
    OPTIONAL MATCH (other)-[r]->(n)
    WHERE other.projectId = $projectId
      AND other.filePath <> n.filePath
      AND type(r) IN ['IMPORTS', 'EXTENDS', 'IMPLEMENTS', 'TYPED_AS', 'INJECTS', 'CALLS']
    WITH n, count(other) AS incomingCount
    WHERE incomingCount = 0
    RETURN n.id AS nodeId,
           n.name AS name,
           n.coreType AS coreType,
           n.semanticType AS semanticType,
           n.filePath AS filePath,
           n.startLine AS lineNumber,
           n.isExported AS isExported,
           'Exported but never imported or referenced' AS reason
    ORDER BY n.filePath, n.startLine
  `,

  /**
   * Find private methods with no incoming CALLS edges.
   * Private methods that are never called are likely dead code.
   */
  FIND_UNCALLED_PRIVATE_METHODS: `
    MATCH (n)
    WHERE n.projectId = $projectId
      AND n.coreType = 'MethodDeclaration'
      AND n.visibility = 'private'
    WITH n
    OPTIONAL MATCH (caller)-[r:CALLS]->(n)
    WHERE caller.projectId = $projectId
    WITH n, count(caller) AS callCount
    WHERE callCount = 0
    RETURN n.id AS nodeId,
           n.name AS name,
           n.coreType AS coreType,
           n.semanticType AS semanticType,
           n.filePath AS filePath,
           n.startLine AS lineNumber,
           n.visibility AS visibility,
           'Private method never called' AS reason
    ORDER BY n.filePath, n.startLine
  `,

  /**
   * Find interfaces that are never implemented or referenced.
   * Interfaces without implementations may be dead code.
   */
  FIND_UNREFERENCED_INTERFACES: `
    MATCH (n)
    WHERE n.projectId = $projectId
      AND n.coreType = 'InterfaceDeclaration'
      AND n.isExported = true
    WITH n
    OPTIONAL MATCH (other)-[r]->(n)
    WHERE other.projectId = $projectId
      AND type(r) IN ['IMPLEMENTS', 'EXTENDS', 'TYPED_AS', 'IMPORTS']
    WITH n, count(other) AS refCount
    WHERE refCount = 0
    RETURN n.id AS nodeId,
           n.name AS name,
           n.coreType AS coreType,
           n.semanticType AS semanticType,
           n.filePath AS filePath,
           n.startLine AS lineNumber,
           'Interface never implemented or referenced' AS reason
    ORDER BY n.filePath, n.startLine
  `,

  /**
   * Get all distinct semantic types for a project.
   * Used to dynamically determine framework entry points for dead code detection.
   */
  GET_PROJECT_SEMANTIC_TYPES: `
    MATCH (n)
    WHERE n.projectId = $projectId
      AND n.semanticType IS NOT NULL
      AND n.coreType IN ['ClassDeclaration', 'FunctionDeclaration', 'InterfaceDeclaration', 'MethodDeclaration']
    RETURN DISTINCT n.semanticType AS semanticType
  `,

  /**
   * Get framework entry points that should be excluded from dead code analysis.
   * These are nodes that may appear unused but are actually framework-managed.
   * Filters by coreType to exclude ImportDeclarations and only return actual classes/functions/interfaces.
   * Accepts $semanticTypes parameter for dynamic, per-project framework detection.
   */
  GET_FRAMEWORK_ENTRY_POINTS: `
    MATCH (n)
    WHERE n.projectId = $projectId
      AND n.coreType IN ['ClassDeclaration', 'FunctionDeclaration', 'InterfaceDeclaration']
      AND (
        n.semanticType IN $semanticTypes
        OR n.filePath ENDS WITH 'main.ts'
        OR n.filePath ENDS WITH '.module.ts'
        OR n.filePath ENDS WITH '.controller.ts'
        OR n.filePath ENDS WITH 'index.ts'
      )
    RETURN n.id AS nodeId,
           n.name AS name,
           n.coreType AS coreType,
           n.semanticType AS semanticType,
           n.filePath AS filePath
    ORDER BY n.semanticType, n.name
  `,

  // ============================================================================
  // DUPLICATE CODE DETECTION QUERIES
  // ============================================================================

  /**
   * Find structural duplicates - nodes with identical normalizedHash.
   * Returns all nodes that share the same normalized code hash.
   * Limited to prevent memory issues on large codebases.
   */
  FIND_STRUCTURAL_DUPLICATES: `
    MATCH (n)
    WHERE n.projectId = $projectId
      AND n.coreType IN $coreTypes
      AND n.normalizedHash IS NOT NULL
      AND n.normalizedHash <> ''
    WITH n.normalizedHash AS hash, collect(n) AS nodes
    WHERE size(nodes) >= 2
    UNWIND nodes AS n
    RETURN n.id AS nodeId,
           n.name AS name,
           n.coreType AS coreType,
           n.semanticType AS semanticType,
           n.filePath AS filePath,
           n.startLine AS lineNumber,
           n.normalizedHash AS normalizedHash,
           n.sourceCode AS sourceCode
    ORDER BY n.normalizedHash, n.filePath, n.startLine
    LIMIT toInteger($limit)
  `,

  /**
   * Find semantic duplicates - nodes with similar embeddings.
   * Uses vector similarity search to find semantically similar code.
   * Note: Requires the vector index 'embedded_nodes_idx' to exist.
   */
  FIND_SEMANTIC_DUPLICATES: `
    MATCH (n1)
    WHERE n1.projectId = $projectId
      AND n1.coreType IN $coreTypes
      AND n1.embedding IS NOT NULL
    WITH n1
    CALL db.index.vector.queryNodes('embedded_nodes_idx', toInteger($vectorNeighbors), n1.embedding)
    YIELD node AS n2, score AS similarity
    WHERE n2.projectId = $projectId
      AND n2.coreType IN $coreTypes
      AND n1.id < n2.id
      AND similarity >= $minSimilarity
      AND n1.filePath <> n2.filePath
      AND (n1.normalizedHash IS NULL OR n2.normalizedHash IS NULL OR n1.normalizedHash <> n2.normalizedHash)
    RETURN n1.id AS nodeId1,
           n1.name AS name1,
           n1.coreType AS coreType1,
           n1.semanticType AS semanticType1,
           n1.filePath AS filePath1,
           n1.startLine AS lineNumber1,
           n1.sourceCode AS sourceCode1,
           n2.id AS nodeId2,
           n2.name AS name2,
           n2.coreType AS coreType2,
           n2.semanticType AS semanticType2,
           n2.filePath AS filePath2,
           n2.startLine AS lineNumber2,
           n2.sourceCode AS sourceCode2,
           similarity
    ORDER BY similarity DESC
    LIMIT toInteger($limit)
  `,
};
