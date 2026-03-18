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
  swarmReleaseTask: 'swarm_release_task',
  swarmAdvanceTask: 'swarm_advance_task',
  swarmCompleteTask: 'swarm_complete_task',
  swarmGetTasks: 'swarm_get_tasks',
  saveSessionBookmark: 'save_session_bookmark',
  restoreSessionBookmark: 'restore_session_bookmark',
  saveSessionNote: 'save_session_note',
  recallSessionNotes: 'recall_session_notes',
  cleanupSession: 'cleanup_session',
  swarmMessage: 'swarm_message',
  sessionSave: 'session_save',
  sessionRecall: 'session_recall',
} as const;

// Tool Metadata
export const TOOL_METADATA = {
  [TOOL_NAMES.hello]: {
    title: 'Hello Tool',
    description: 'Diagnostic tool. Use only to verify the MCP server is running.',
  },
  [TOOL_NAMES.searchCodebase]: {
    title: 'Search Codebase',
    description: `Primary tool for finding code. Use this first for any code exploration query. Combines semantic vector search with dependency graph traversal from the best match.

Returns normalized JSON with nodes map and relationship chains. If output too large: reduce maxDepth, set includeCode=false, or reduce snippetLength.`,
  },
  [TOOL_NAMES.naturalLanguageToCypher]: {
    title: 'Natural Language to Cypher',
    description: `Advanced query tool. Use only when search_codebase cannot answer the question — aggregate queries ('how many services exist'), complex relationship patterns, or bulk property filtering. Requires OPENAI_API_KEY.

**Node types:** SourceFile, Class, Function, Method, Interface, Property, Parameter, Import, Export, Enum, TypeAlias
**Key relationships:** CONTAINS, HAS_MEMBER, HAS_PARAMETER, IMPORTS, EXTENDS, IMPLEMENTS, CALLS, TYPED_AS
**NestJS:** Use semanticType property (e.g., semanticType='NestController'). Relationships: INJECTS, EXPOSES, MODULE_IMPORTS/PROVIDES/EXPORTS
**Tips:** Use concrete properties (filePath, name) not abstract concepts.`,
  },
  [TOOL_NAMES.traverseFromNode]: {
    title: 'Traverse from Node',
    description: `Follow-up exploration tool. Use after search_codebase when you have a specific node ID and want to explore its relationships in more depth or different directions.

Accepts nodeId or filePath as starting point. Set summaryOnly=true for file paths and stats only.`,
  },
  [TOOL_NAMES.parseTypescriptProject]: {
    title: 'Parse TypeScript Project',
    description: `Setup tool. Parse a TypeScript/NestJS project and build a code graph in Neo4j. Run once per project, then use search_codebase to query.

**Always use async mode:** set async=true, then poll check_parse_status with the returned jobId. Set clearExisting=true to replace an existing graph.`,
  },
  [TOOL_NAMES.testNeo4jConnection]: {
    title: 'Test Neo4j Connection & APOC',
    description: 'Diagnostic tool. Use only to verify Neo4j connectivity and APOC plugin availability.',
  },
  [TOOL_NAMES.impactAnalysis]: {
    title: 'Impact Analysis',
    description: `Risk assessment tool. Use before modifying shared code to understand what depends on a node and the blast radius of changes.

Returns risk level (LOW/MEDIUM/HIGH/CRITICAL), direct and transitive dependents, affected files, and critical paths. Accepts nodeId or filePath.`,
  },
  [TOOL_NAMES.checkParseStatus]: {
    title: 'Check Parse Status',
    description: `Setup tool. Poll the status of an async parsing job started with parse_typescript_project. Returns job status, progress, and final result.`,
  },
  [TOOL_NAMES.listProjects]: {
    title: 'List Projects',
    description: `Utility tool. Lists all parsed projects with IDs, names, and paths. Most tools accept project names or paths directly, so this is rarely needed.`,
  },
  [TOOL_NAMES.startWatchProject]: {
    title: 'Start Watch Project',
    description: `File watcher tool. Watch a project for .ts file changes and auto-update the graph. Auto-excludes node_modules, dist, build, .git.`,
  },
  [TOOL_NAMES.stopWatchProject]: {
    title: 'Stop Watch Project',
    description: `File watcher tool. Stop watching a project for file changes.`,
  },
  [TOOL_NAMES.listWatchers]: {
    title: 'List Watchers',
    description: `File watcher tool. List active file watchers with status and pending changes.`,
  },
  [TOOL_NAMES.detectDeadCode]: {
    title: 'Detect Dead Code',
    description: `Code quality tool. Find unused exports, uncalled methods, and orphan interfaces. Returns items with confidence scores grouped by type and category.

Auto-excludes NestJS entry points. Use filterCategory=internal-unused for actionable cleanup.`,
  },
  [TOOL_NAMES.detectDuplicateCode]: {
    title: 'Detect Duplicate Code',
    description: `Code quality tool. Find duplicates using structural (AST hash) and semantic (embedding) analysis. Returns grouped results with similarity scores.`,
  },
  [TOOL_NAMES.swarmPheromone]: {
    title: 'Swarm Pheromone',
    description: `Swarm coordination tool. Mark a code node with a pheromone to signal activity. Workflow states (exploring/claiming/modifying/completed/blocked) are mutually exclusive per agent+node. Flag types (warning/proposal/needs_review/session_context) can coexist. Pheromones decay automatically.`,
  },
  [TOOL_NAMES.swarmSense]: {
    title: 'Swarm Sense',
    description: `Swarm coordination tool. Query active pheromones to see what other agents are doing. Filter by swarmId, types, nodeIds, agentIds. Returns pheromones with current intensity after decay.`,
  },
  [TOOL_NAMES.swarmCleanup]: {
    title: 'Swarm Cleanup',
    description: `Swarm orchestration tool. Bulk delete pheromones, tasks, and messages for a swarm or agent. Warning pheromones preserved by default. Use dryRun=true to preview.`,
  },
  [TOOL_NAMES.swarmPostTask]: {
    title: 'Swarm Post Task',
    description: `Swarm orchestration tool. Post a task to the swarm queue. Use dependencies array for task ordering — tasks with incomplete deps auto-block until ready.`,
  },
  [TOOL_NAMES.swarmClaimTask]: {
    title: 'Swarm Claim Task',
    description: `Swarm orchestration tool. Claim a task from the queue. Without taskId, claims highest-priority available task. Set startImmediately=false to claim without starting.

Flow: swarm_claim_task → do work → swarm_complete_task. Use swarm_release_task to give up work, swarm_advance_task for state transitions.`,
  },
  [TOOL_NAMES.swarmReleaseTask]: {
    title: 'Swarm Release Task',
    description: `Swarm orchestration tool. Release or abandon a claimed task. Use when an agent can no longer complete a task. Set trackAbandonment=true to record the abandonment for retry tracking.`,
  },
  [TOOL_NAMES.swarmAdvanceTask]: {
    title: 'Swarm Advance Task',
    description: `Swarm orchestration tool. Start or force-start a claimed task. Use after claiming with startImmediately=false, or set force=true to recover from a stuck claimed state.`,
  },
  [TOOL_NAMES.swarmCompleteTask]: {
    title: 'Swarm Complete Task',
    description: `Swarm orchestration tool. Mark a task as completed, failed, or request review. Completing unblocks dependent tasks. Failed tasks can be retried if retryable=true.`,
  },
  [TOOL_NAMES.swarmGetTasks]: {
    title: 'Swarm Get Tasks',
    description: `Swarm orchestration tool. Query tasks with filters. Use taskId for a single task, or filter by swarmId, statuses, types, claimedBy. Add includeStats=true for aggregate counts.`,
  },
  [TOOL_NAMES.saveSessionBookmark]: {
    title: 'Save Session Bookmark',
    description: `Session persistence tool. Save current working set, task context, findings, and next steps as a bookmark for cross-session continuity. Use session_recall to resume.`,
  },
  [TOOL_NAMES.restoreSessionBookmark]: {
    title: 'Restore Session Bookmark',
    description: `Session persistence tool. Restore a previously saved bookmark to resume work. Returns bookmark data, working set nodes with source code, session notes, and stale node IDs.`,
  },
  [TOOL_NAMES.saveSessionNote]: {
    title: 'Save Session Note',
    description: `Session persistence tool. Save an observation, decision, or risk as a durable note linked to code nodes. Notes survive session compaction and are searchable via session_recall.`,
  },
  [TOOL_NAMES.recallSessionNotes]: {
    title: 'Recall Session Notes',
    description: `Session persistence tool. Search and retrieve saved session notes. Provide query for semantic vector search, or filter by category/severity/sessionId/agentId.`,
  },
  [TOOL_NAMES.cleanupSession]: {
    title: 'Cleanup Session',
    description: `Session persistence tool. Remove expired session notes and old bookmarks, keeping the most recent per session.`,
  },
  [TOOL_NAMES.sessionSave]: {
    title: 'Session Save',
    description: `Session persistence tool. Save session context — auto-detects bookmark vs note based on input. Provide workingSetNodeIds for a bookmark, topic+content for a note, or both for a bookmark with an attached note.`,
  },
  [TOOL_NAMES.sessionRecall]: {
    title: 'Session Recall',
    description: `Session persistence tool. Retrieve saved session context. Provide query for semantic note search, or sessionId to restore the latest bookmark and all notes for that session.`,
  },
  [TOOL_NAMES.swarmMessage]: {
    title: 'Swarm Message',
    description: `Swarm coordination tool. Direct agent-to-agent messaging. Unlike pheromones (passive/decay-based), messages are explicit and delivered when agents claim tasks. Use for critical coordination signals.

Actions: send (post or broadcast), read (retrieve), acknowledge (mark read). Categories: blocked, conflict, finding, request, alert, handoff.`,
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
  maxEmbeddingChars: 24000, // ~6000 tokens, safe margin for 8192 token limit on text-embedding-3-large
} as const;

// Parsing Configuration
export const PARSING = {
  /** File count threshold to trigger parallel parsing with worker pool */
  parallelThreshold: 250,
  /** File count threshold to trigger streaming import */
  streamingThreshold: 100,
  /** Default number of files per chunk */
  defaultChunkSize: 50,
  /** Worker timeout in milliseconds (default: 8 hours, configurable via WORKER_TIMEOUT_HOURS) */
  workerTimeoutMs: (Number(process.env.WORKER_TIMEOUT_HOURS) || 8) * 60 * 60 * 1000,
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
      'natural_language_to_cypher requires OPENAI_API_KEY. Set it and restart the MCP server to enable this tool.',
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
  maxFileSizeBytes: 64 * 1024, // 64 KB — skip large config files (grafana dashboards, generated JSON, etc.)
};
