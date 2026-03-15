/**
 * MCP Server Constants
 * All constants used throughout the MCP server implementation
 */

// Re-export shared constants
export { LOG_CONFIG } from '../constants.js';

// Server Configuration
export const MCP_SERVER_CONFIG = {
  name: 'codebase-graph',
  version: '1.0.0',
} as const;

// File Paths
export const FILE_PATHS = {
  debugLog: 'debug-search.log',
  schemaOutput: 'neo4j-apoc-schema.json',
  graphOutput: 'graph.json',
} as const;

// Tool Names
export const TOOL_NAMES = {
  hello: 'hello',
  searchCodebase: 'search_codebase',
  naturalLanguageToCypher: 'natural_language_to_cypher',
  traverseFromNode: 'traverse_from_node',
  parseTypescriptProject: 'parse_typescript_project',
  testNeo4jConnection: 'test_neo4j_connection',
  impactAnalysis: 'impact_analysis',
  checkParseStatus: 'check_parse_status',
  listProjects: 'list_projects',
  startWatchProject: 'start_watch_project',
  stopWatchProject: 'stop_watch_project',
  listWatchers: 'list_watchers',
  detectDeadCode: 'detect_dead_code',
  detectDuplicateCode: 'detect_duplicate_code',
  swarmPheromone: 'swarm_pheromone',
  swarmSense: 'swarm_sense',
  swarmCleanup: 'swarm_cleanup',
  swarmPostTask: 'swarm_post_task',
  swarmClaimTask: 'swarm_claim_task',
  swarmCompleteTask: 'swarm_complete_task',
  swarmGetTasks: 'swarm_get_tasks',
  saveSessionBookmark: 'save_session_bookmark',
  restoreSessionBookmark: 'restore_session_bookmark',
  saveSessionNote: 'save_session_note',
  recallSessionNotes: 'recall_session_notes',
  cleanupSession: 'cleanup_session',
  swarmMessage: 'swarm_message',
} as const;

// Tool Metadata
export const TOOL_METADATA = {
  [TOOL_NAMES.hello]: {
    title: 'Hello Tool',
    description: 'Test tool that says hello',
  },
  [TOOL_NAMES.searchCodebase]: {
    title: 'Search Codebase',
    description: `Semantic search for code, functions, classes, implementations. Returns normalized JSON with source code.

Use list_projects first to get project name/ID.

Parameters:
- query: Natural language description of what you're looking for
- maxDepth (default: 3): Relationship hops to traverse
- includeCode (default: true): Set false for structure only
- snippetLength (default: 700): Code snippet length
- maxNodesPerChain (default: 5): Chains per depth level

If output too large: reduce maxDepth, set includeCode=false, or reduce snippetLength.`,
  },
  [TOOL_NAMES.naturalLanguageToCypher]: {
    title: 'Natural Language to Cypher',
    description: `Convert natural language to Cypher for complex queries search_codebase can't handle.

Use list_projects first to get project name.

**Node types:** SourceFile, Class, Function, Method, Interface, Property, Parameter, Import, Export, Enum, TypeAlias

**Key relationships:** CONTAINS, HAS_MEMBER, HAS_PARAMETER, IMPORTS, EXTENDS, IMPLEMENTS, CALLS, TYPED_AS

**NestJS:** Use semanticType property (e.g., semanticType='NestController'), not decorators. Relationships: INJECTS, EXPOSES, MODULE_IMPORTS/PROVIDES/EXPORTS

**Tips:** Use concrete properties (filePath, name) not abstract concepts. Import nodes store file paths, not module names.`,
  },
  [TOOL_NAMES.traverseFromNode]: {
    title: 'Traverse from Node',
    description: `Explore connections from a node ID (from search_codebase results).

Parameters:
- nodeId (required): Starting node ID
- maxDepth (default: 3): Relationship hops (1-10)
- includeCode (default: true): Set false for structure only
- summaryOnly: true for file paths and stats only
- maxNodesPerChain (default: 5): Chains per depth level
- maxTotalNodes: Cap unique nodes returned`,
  },
  [TOOL_NAMES.parseTypescriptProject]: {
    title: 'Parse TypeScript Project',
    description: `Parse a TypeScript/NestJS project and build a code graph in Neo4j.

**IMPORTANT: Always use async mode for parsing:**
- Set async: true to avoid timeouts on large codebases
- Use check_parse_status to monitor progress

**Workflow:**
1. Call with async: true and projectPath
2. Note the returned jobId
3. Poll check_parse_status({ jobId }) until completed
4. Use list_projects to confirm the project was added

**Parameters:**
- projectPath (required): Absolute path to the project root
- async (recommended: true): Run parsing in background
- clearExisting: Set true to replace existing graph for this project
- projectId: Optional custom ID (auto-generated from path if omitted)

**Example:**
parse_typescript_project({ projectPath: "/path/to/project", async: true })
→ Returns jobId for polling`,
  },
  [TOOL_NAMES.testNeo4jConnection]: {
    title: 'Test Neo4j Connection & APOC',
    description: 'Test connection to Neo4j database and verify APOC plugin is available',
  },
  [TOOL_NAMES.impactAnalysis]: {
    title: 'Impact Analysis',
    description: `Analyze the impact of modifying a code node. Shows what depends on this node and helps assess risk before making changes.

**Before analyzing:**
Use list_projects to see available projects and get the project name.

Returns:
- Risk level (LOW/MEDIUM/HIGH/CRITICAL) based on dependency count and relationship types
- Direct dependents: nodes that directly reference the target
- Transitive dependents: nodes affected through dependency chains
- Affected files: list of files that would need review
- Critical paths: high-risk dependency chains

Parameters:
- nodeId: Node ID from search_codebase or traverse_from_node results
- filePath: Alternative - analyze all exports from a file
- maxDepth: How far to trace transitive dependencies (default: 4)

Use this before refactoring to understand blast radius of changes.`,
  },
  [TOOL_NAMES.checkParseStatus]: {
    title: 'Check Parse Status',
    description: `Check the status of an async parsing job started with parse_typescript_project({ async: true }).

Returns:
- Job status (pending/running/completed/failed)
- Progress: phase, files processed, chunks completed
- Nodes and edges imported so far
- Final result on completion or error message on failure

Use this to poll for progress when parsing large codebases asynchronously.`,
  },
  [TOOL_NAMES.listProjects]: {
    title: 'List Projects',
    description: `List all parsed projects in the database with their IDs, names, and paths.

Returns:
- projectId: The full project ID (e.g., "proj_a1b2c3d4e5f6")
- name: Friendly project name from package.json (e.g., "backend")
- path: Full filesystem path to the project
- updatedAt: When the project was last parsed

Use the name or path in other tools instead of the cryptic projectId.`,
  },
  [TOOL_NAMES.startWatchProject]: {
    title: 'Start Watch Project',
    description: `Watch project for .ts file changes and auto-update graph.

Parameters: projectPath (required), tsconfigPath (required), debounceMs (default: 1000ms).

Auto-excludes node_modules, dist, build, .git. Use list_watchers to see active, stop_watch_project to stop.`,
  },
  [TOOL_NAMES.stopWatchProject]: {
    title: 'Stop Watch Project',
    description: `Stop watching a project. Requires projectId.`,
  },
  [TOOL_NAMES.listWatchers]: {
    title: 'List Watchers',
    description: `List active file watchers with status, pending changes, last update time.`,
  },
  [TOOL_NAMES.detectDeadCode]: {
    title: 'Detect Dead Code',
    description: `Find unused exports, uncalled methods, orphan interfaces. Use list_projects first.

Returns risk level, dead code items with confidence (HIGH/MEDIUM/LOW), grouped by type and category.

Key parameters:
- projectId (required)
- filterCategory: library-export, ui-component, internal-unused, all (default: all)
- minConfidence: LOW/MEDIUM/HIGH (default: LOW)
- summaryOnly: true for stats only
- excludePatterns, excludeSemanticTypes: Additional exclusions

Auto-excludes NestJS entry points (controllers, modules, guards, etc.). Use filterCategory=internal-unused for actionable cleanup.`,
  },
  [TOOL_NAMES.detectDuplicateCode]: {
    title: 'Detect Duplicate Code',
    description: `Find duplicates using structural (AST hash) and semantic (embedding) analysis. Use list_projects first.

Parameters:
- projectId (required)
- type: structural, semantic, or all (default: all)
- minSimilarity: 0.5-1.0 (default: 0.80). 0.90+ = almost certain duplicates
- scope: methods, functions, classes, or all (default: all)
- summaryOnly: true for stats only
- includeCode: Include source snippets (default: false)`,
  },
  [TOOL_NAMES.swarmPheromone]: {
    title: 'Swarm Pheromone',
    description: `Mark a code node with a pheromone for coordination. Types: exploring (2min), modifying (10min), claiming (1hr), completed (24hr), warning (permanent), blocked (5min), proposal (1hr), needs_review (30min), session_context (8hr).

Workflow states (exploring/claiming/modifying/completed/blocked) are mutually exclusive per agent+node. Flag types (warning/proposal/needs_review/session_context) can coexist. Use remove:true to delete. Pheromones decay automatically.`,
  },
  [TOOL_NAMES.swarmSense]: {
    title: 'Swarm Sense',
    description: `Query active pheromones to see what other agents are doing. Filter by swarmId, types, nodeIds, agentIds. Use excludeAgentId to see only others' activity.

Returns pheromones with current intensity after decay. minIntensity default: 0.3. Add includeStats:true for summary counts.`,
  },
  [TOOL_NAMES.swarmCleanup]: {
    title: 'Swarm Cleanup',
    description: `Bulk delete pheromones, tasks, and messages. Specify swarmId, agentId, or all:true. Warning pheromones preserved by default (override with keepTypes:[]). Messages and tasks are deleted when swarmId is provided. Use dryRun:true to preview.`,
  },
  [TOOL_NAMES.swarmPostTask]: {
    title: 'Swarm Post Task',
    description: `Post a task to the swarm queue. Required: projectId, swarmId, title, description, type, createdBy.

Types: implement, refactor, fix, test, review, document, investigate, plan. Priority: critical, high, normal, low, backlog.

Use dependencies array for task ordering. Tasks with incomplete deps auto-block until ready.`,
  },
  [TOOL_NAMES.swarmClaimTask]: {
    title: 'Swarm Claim Task',
    description: `Claim a task from the swarm task queue.

**Actions:** claim_and_start (default, recommended), claim, start, release, abandon, force_start

**Flow:** claim_and_start → do work → swarm_complete_task

Without taskId, claims highest-priority available task. Use types/minPriority to filter.

Recovery: Use abandon to release stuck tasks, force_start to recover from failed start.`,
  },
  [TOOL_NAMES.swarmCompleteTask]: {
    title: 'Swarm Complete Task',
    description: `Mark a task as completed, failed, or request review.

**Actions:** complete, fail, request_review, approve, reject, retry

Required: summary (for complete/request_review), reason (for fail), reviewerId (for approve/reject).

Complete unblocks dependent tasks. Failed tasks can be retried if retryable=true.`,
  },
  [TOOL_NAMES.swarmGetTasks]: {
    title: 'Swarm Get Tasks',
    description: `Query tasks with filters. Use taskId for single task, or filter by swarmId, statuses, types, claimedBy, createdBy, minPriority.

Sort by: priority (default), created, updated. Add includeStats:true for aggregate counts.`,
  },
  [TOOL_NAMES.saveSessionBookmark]: {
    title: 'Save Session Bookmark',
    description: `Save current session context as a bookmark for cross-session continuity.

Records your working set (code node IDs), task context, findings, and next steps so a future session can resume exactly where you left off.

Parameters:
- projectId (required): Project ID, name, or path
- sessionId (required): Unique session/conversation ID for recovery
- agentId (required): Your agent identifier
- summary (required, min 10 chars): Brief description of current work state
- workingSetNodeIds (required): Code node IDs you are focused on
- taskContext (required): High-level task being worked on
- findings: Key discoveries or decisions made so far
- nextSteps: What to do next when resuming
- metadata: Additional structured data

Returns bookmarkId for use with restore_session_bookmark.`,
  },
  [TOOL_NAMES.restoreSessionBookmark]: {
    title: 'Restore Session Bookmark',
    description: `Restore a previously saved session bookmark to resume work.

Retrieves the bookmark, fetches working set code nodes (with source), and returns any session notes. Use after conversation compaction or when resuming a task in a new session.

Parameters:
- projectId (required): Project ID, name, or path
- sessionId: Specific session to restore (latest bookmark if omitted)
- agentId: Filter by agent ID (any agent if omitted)
- includeCode (default: true): Include source code for working set nodes
- snippetLength (default: 500): Max characters per code snippet

Returns: bookmark data, working set nodes, session notes, and staleNodeIds (nodes no longer in graph after re-parse).`,
  },
  [TOOL_NAMES.saveSessionNote]: {
    title: 'Save Session Note',
    description: `Save an observation, decision, insight, or risk as a durable session note linked to code nodes.

Notes survive session compaction and are recalled by restore_session_bookmark or recall_session_notes.

Parameters:
- projectId (required): Project ID, name, or path
- sessionId (required): Session/conversation identifier
- agentId (required): Your agent identifier
- topic (required, 3-100 chars): Short topic label
- content (required, min 10 chars): Full observation text
- category (required): architectural, bug, insight, decision, risk, or todo
- severity (default: info): info, warning, or critical
- aboutNodeIds: Code node IDs this note is about (creates [:ABOUT] links)
- expiresInHours: Auto-expire after N hours (omit for permanent)

Returns noteId, hasEmbedding (enables semantic recall), and expiresAt.`,
  },
  [TOOL_NAMES.recallSessionNotes]: {
    title: 'Recall Session Notes',
    description: `Search and retrieve saved session notes. Supports semantic vector search (when query provided) or filter-based search.

Parameters:
- projectId (required): Project ID, name, or path
- query: Natural language search — triggers semantic vector search when provided
- category: Filter by architectural, bug, insight, decision, risk, todo
- severity: Filter by info, warning, or critical
- sessionId: Filter by session ID
- agentId: Filter by agent ID
- limit (default: 10, max: 50): Maximum notes to return
- minSimilarity (default: 0.3): Minimum similarity for vector search

Returns notes with topic, content, category, severity, relevance score (vector mode), and linked aboutNodes.`,
  },
  [TOOL_NAMES.cleanupSession]: {
    title: 'Cleanup Session',
    description: `Clean up expired session notes and old session bookmarks.

Removes:
- Expired SessionNote nodes (past expiresAt) and their edges
- Old SessionBookmark nodes, keeping only the most recent N per session (default: 3)

Parameters:
- projectId (required): Project ID, name, or path
- keepBookmarks (default: 3): Number of most recent bookmarks to keep per session
- dryRun (default: false): Preview what would be deleted without deleting

Returns counts of deleted notes, bookmarks, and edges.`,
  },
  [TOOL_NAMES.swarmMessage]: {
    title: 'Swarm Message',
    description: `Direct agent-to-agent messaging via Neo4j. Unlike pheromones (passive/decay-based), messages are explicit and delivered when agents claim tasks.

**Actions:**
- send: Post a message to a specific agent or broadcast to all agents in a swarm
- read: Retrieve unread messages (or all messages) for an agent
- acknowledge: Mark messages as read

**Categories:** blocked, conflict, finding, request, alert, handoff

**Key behavior:**
- Messages sent to a specific agent are delivered when that agent calls swarm_claim_task
- Broadcast messages (toAgentId omitted) are visible to all agents in the swarm
- Messages auto-expire after 4 hours (configurable via ttlMs)
- Use this for critical coordination signals that agents MUST see, not optional context

**Examples:**
- Agent finds a breaking type error: send alert to all
- Agent is blocked on a file another agent owns: send blocked to that agent
- Agent discovers context another agent needs: send finding to that agent`,
  },
} as const;

// Default Values
export const DEFAULTS = {
  traversalDepth: 3,
  skipOffset: 0,
  batchSize: 500,
  maxResultsDisplayed: 30,
  codeSnippetLength: 500, // Reduced from 1000 to control output size
  chainSnippetLength: 700,
  maxEmbeddingChars: 30000, // ~7500 tokens, under 8192 limit for text-embedding-3-large
} as const;

// Parsing Configuration
export const PARSING = {
  /** File count threshold to trigger parallel parsing with worker pool */
  parallelThreshold: 250,
  /** File count threshold to trigger streaming import */
  streamingThreshold: 100,
  /** Default number of files per chunk */
  defaultChunkSize: 75,
  /** Worker timeout in milliseconds (30 minutes) */
  workerTimeoutMs: 30 * 60 * 1000,
} as const;

// Job Management
export const JOBS = {
  /** Interval for cleaning up completed/stale jobs (5 minutes) */
  cleanupIntervalMs: 5 * 60 * 1000,
  /** Maximum number of jobs to keep in memory */
  maxJobs: 100,
} as const;

// Watch Mode Configuration
export const WATCH = {
  /** Default debounce delay before processing file changes */
  defaultDebounceMs: 1000,
  /** Maximum concurrent file watchers */
  maxWatchers: 10,
  /** Maximum pending file change events before dropping */
  maxPendingEvents: 1000,
  /** Default exclude patterns for file watching */
  excludePatterns: [
    '**/node_modules/**',
    '**/dist/**',
    '**/build/**',
    '**/.git/**',
    '**/*.d.ts',
    '**/*.js',
    '**/*.map',
  ],
} as const;

// Messages
export const MESSAGES = {
  errors: {
    noRelevantCode: 'No relevant code found.',
    serviceNotInitialized:
      'ERROR: Natural Language to Cypher service is not initialized yet. Please try again in a few moments.',
    connectionTestFailed: 'Connection test failed',
    neo4jRequirement: 'Note: This server requires Neo4j with APOC plugin installed',
    genericError: 'ERROR:',
  },
  success: {
    hello: 'Hello from codebase MCP!',
    parseSuccess: 'SUCCESS:',
    partialSuccess: 'PARTIAL SUCCESS:',
  },
  queries: {
    naturalLanguagePrefix: 'Natural Language Query:',
    cypherQueryHeader: 'Generated Cypher Query',
    queryResultsHeader: 'Query Results',
    noResultsFound: 'No results found for this query.',
    moreResultsIndicator: '_... and {} more results_',
    summaryPrefix: '**Summary:** Executed query and found {} results.',
  },
  neo4j: {
    connectionTest: 'RETURN "Connected!" as message, datetime() as timestamp',
    apocTest: 'CALL apoc.help("apoc") YIELD name RETURN count(name) as apocFunctions',
    connectionSuccess: 'Neo4j connected: {} at {}\nAPOC plugin available with {} functions',
  },
  server: {
    starting: '=== MCP Server Starting ===',
    connected: '=== MCP Server Connected and Running ===',
    creatingTransport: 'Creating transport...',
    connectingTransport: 'Connecting server to transport...',
    startingServer: 'Starting MCP server...',
  },
} as const;

export const CONFIG_FILE_PATTERNS = {
  defaultGlobs: [
    'docker-compose*.{yml,yaml}',
    'Dockerfile*',
    '**/*.json', // All JSON files (package.json, tsconfig.json, .mcp.json, etc.)
    '**/*.{yml,yaml}', // All YAML files (CI configs, k8s manifests, etc.)
    '**/*.toml', // Cargo.toml, pyproject.toml, etc.
    '**/*.cfg', // Python setup.cfg, etc.
    '**/*.ini', // INI config files
    '**/Makefile', // Makefiles
    '.env*',
    '**/*.sh', // Shell scripts
    '**/*.py', // Python files (sidecar, scripts)
  ],
  excludeGlobs: [
    '**/node_modules/**',
    '**/dist/**',
    '**/build/**',
    '**/.git/**',
    '**/coverage/**',
    '**/.next/**',
    '**/package-lock.json', // Too large, not useful for search
    '**/yarn.lock',
    '**/pnpm-lock.yaml',
  ],
  maxFileSizeBytes: 512 * 1024, // 512 KB — skip large generated files
};
