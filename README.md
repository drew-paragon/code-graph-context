# Code Graph Context

[![npm version](https://badge.fury.io/js/code-graph-context.svg)](https://www.npmjs.com/package/code-graph-context)
[![MIT License](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.8-007ACC?logo=typescript&logoColor=white)](https://typescriptlang.org/)
[![Neo4j](https://img.shields.io/badge/Neo4j-5.23+-018bff?logo=neo4j&logoColor=white)](https://neo4j.com/)
[![NestJS](https://img.shields.io/badge/NestJS-Compatible-E0234E?logo=nestjs&logoColor=white)](https://nestjs.com/)
[![OpenAI](https://img.shields.io/badge/OpenAI-Optional-412991?logo=openai&logoColor=white)](https://openai.com/)
[![MCP](https://img.shields.io/badge/MCP-Server-blue)](https://modelcontextprotocol.io/)

**Give your AI coding assistant a photographic memory of your codebase.**

Code Graph Context is an MCP server that builds a semantic graph of your TypeScript codebase, enabling Claude to understand not just individual files, but how your entire system fits together.

> **Config-Driven & Extensible**: Define custom framework schemas to capture domain-specific patterns beyond the included NestJS support. The parser is fully configurable to recognize your architectural patterns, decorators, and relationships.

```
                    ┌─────────────────────────────────────────────────────────────┐
                    │                     YOUR CODEBASE                           │
                    │  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐    │
                    │  │ Service  │  │Controller│  │  Module  │  │  Entity  │    │
                    │  └────┬─────┘  └────┬─────┘  └────┬─────┘  └────┬─────┘    │
                    └───────┼─────────────┼─────────────┼─────────────┼──────────┘
                            │             │             │             │
                            ▼             ▼             ▼             ▼
                    ┌─────────────────────────────────────────────────────────────┐
                    │                   CODE GRAPH CONTEXT                        │
                    │                                                             │
                    │   AST Parser ──► Neo4j Graph ──► Vector Embeddings          │
                    │   (ts-morph)     (Relationships)  (Local or OpenAI)         │
                    │                                                             │
                    └─────────────────────────────────────────────────────────────┘
                                                │
                                                ▼
                    ┌─────────────────────────────────────────────────────────────┐
                    │                      CLAUDE CODE                            │
                    │                                                             │
                    │   "What services depend on UserService?"                    │
                    │   "What's the blast radius if I change this function?"      │
                    │   "Find all HTTP endpoints that accept a UserDTO"           │
                    │   "Refactor this across all 47 files that use it"           │
                    │                                                             │
                    └─────────────────────────────────────────────────────────────┘
```

## Why Code Graph Context?

| Without Code Graph | With Code Graph |
|---|---|
| Claude reads files one at a time | Claude understands the entire dependency tree |
| "What uses this?" requires manual searching | Instant impact analysis with risk scoring |
| Refactoring misses edge cases | Graph traversal finds every reference |
| Large codebases overwhelm context | Semantic search finds exactly what's relevant |
| Multi-file changes are error-prone | Swarm agents coordinate parallel changes |

## Features

- **Multi-Project Support**: Parse and query multiple projects in a single database with complete isolation
- **Semantic Search**: Vector-based search using local or OpenAI embeddings to find relevant code
- **Natural Language Querying**: Convert questions into Cypher queries
- **Framework-Aware**: Built-in NestJS schema with ability to define custom framework patterns
- **Weighted Graph Traversal**: Intelligent traversal scoring paths by importance and relevance
- **Workspace Support**: Auto-detects Nx, Turborepo, pnpm, Yarn, and npm workspaces
- **Parallel & Async Parsing**: Multi-threaded parsing with Worker threads for large codebases
- **Streaming Import**: Chunked processing for projects with 100+ files
- **Incremental Parsing**: Only reparse changed files
- **File Watching**: Real-time graph updates on file changes
- **Impact Analysis**: Assess refactoring risk (LOW/MEDIUM/HIGH/CRITICAL)
- **Dead Code Detection**: Find unreferenced exports with confidence scoring
- **Duplicate Detection**: Structural (AST hash) and semantic (embedding similarity) duplicates
- **Swarm Coordination**: Multi-agent stigmergic coordination with pheromone decay

## Architecture

```
TypeScript Source → AST Parser (ts-morph) → Neo4j Graph + Vector Embeddings → MCP Tools
```

**Core Components:**
- `src/core/parsers/typescript-parser.ts` - AST parsing with ts-morph
- `src/storage/neo4j/neo4j.service.ts` - Graph storage and queries
- `src/core/embeddings/embeddings.service.ts` - Embedding service (local sidecar or OpenAI)
- `src/mcp/mcp.server.ts` - MCP server and tool registration

**Dual-Schema System:**
- **Core Schema**: AST-level nodes (ClassDeclaration, MethodDeclaration, ImportDeclaration, etc.)
- **Framework Schema**: Semantic interpretation (NestController, NestService, HttpEndpoint, etc.)

Nodes have both `coreType` (AST) and `semanticType` (framework meaning), enabling queries like "find all controllers" while maintaining AST precision.

## Quick Start

### Prerequisites

- **Node.js** >= 18
- **Python** >= 3.10 (for local embeddings)
- **Docker** (for Neo4j)

> **No API keys required.** Local embeddings work out of the box using a Python sidecar.

### 1. Install

```bash
npm install -g code-graph-context
code-graph-context init  # Sets up Neo4j + Python sidecar + downloads embedding model
```

The `init` command handles everything:
- Starts a Neo4j container via Docker
- Creates a Python virtual environment
- Installs embedding dependencies (PyTorch, sentence-transformers)
- Downloads the default embedding model (~3GB)

### 2. Configure Claude Code

```bash
claude mcp add --scope user code-graph-context -- code-graph-context
```

**That's it.** No API keys needed. Restart Claude Code and you're ready to go.

> **Want to use OpenAI instead?** See [Embedding Configuration](#embedding-configuration) below.

### 3. Parse Your Project

In Claude Code, say:
> "Parse this project and build the code graph"

Claude will run `parse_typescript_project` and index your codebase.

---

## Configuration Files

Claude Code stores MCP server configs in JSON files. The location depends on scope:

| Scope | File | Use Case |
|-------|------|----------|
| User (global) | `~/.claude.json` | Available in all projects |
| Project | `.claude.json` in project root | Project-specific config |
| Local | `.mcp.json` in project root | Git-ignored local overrides |

### Manual Configuration

If you prefer to edit the config files directly:

**~/.claude.json** (user scope - recommended):
```json
{
  "mcpServers": {
    "code-graph-context": {
      "command": "code-graph-context"
    }
  }
}
```

**With OpenAI (optional):**
```json
{
  "mcpServers": {
    "code-graph-context": {
      "command": "code-graph-context",
      "env": {
        "OPENAI_ENABLED": "true",
        "OPENAI_API_KEY": "sk-your-key-here"
      }
    }
  }
}
```

**From source installation:**
```json
{
  "mcpServers": {
    "code-graph-context": {
      "command": "node",
      "args": ["/absolute/path/to/code-graph-context/dist/cli/cli.js"]
    }
  }
}
```

### Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `NEO4J_URI` | No | `bolt://localhost:7687` | Neo4j connection URI |
| `NEO4J_USER` | No | `neo4j` | Neo4j username |
| `NEO4J_PASSWORD` | No | `PASSWORD` | Neo4j password |
| `EMBEDDING_MODEL` | No | `Qwen/Qwen3-Embedding-0.6B` | Local embedding model (see [Embedding Configuration](#embedding-configuration)) |
| `EMBEDDING_SIDECAR_PORT` | No | `8787` | Port for local embedding server |
| `EMBEDDING_HALF_PRECISION` | No | `false` | Set `true` for float16 (uses ~0.5x memory) |
| `OPENAI_ENABLED` | No | `false` | Set `true` to use OpenAI instead of local |
| `OPENAI_API_KEY` | No* | - | Required when `OPENAI_ENABLED=true` |

---

## Core Capabilities

### Semantic Code Search

Find code by describing what you need, not by memorizing file paths:

```
"Find where user authentication tokens are validated"
"Show me the database connection pooling logic"
"What handles webhook signature verification?"
```

### Impact Analysis

Before you refactor, understand the blast radius:

```
┌─────────────────────────────────────────────────────────────┐
│ Impact Analysis: UserService.findById()                     │
├─────────────────────────────────────────────────────────────┤
│ Risk Level: HIGH                                            │
│                                                             │
│ Direct Dependents (12):                                     │
│   └── AuthController.login()                                │
│   └── ProfileController.getProfile()                        │
│   └── AdminService.getUserDetails()                         │
│   └── ... 9 more                                            │
│                                                             │
│ Transitive Dependents (34):                                 │
│   └── 8 controllers, 15 services, 11 tests                  │
│                                                             │
│ Affected Files: 23                                          │
│ Recommendation: Add deprecation warning before changing     │
└─────────────────────────────────────────────────────────────┘
```

### Graph Traversal

Explore relationships in any direction:

```
UserController
    │
    ├── INJECTS ──► UserService
    │                   │
    │                   ├── INJECTS ──► UserRepository
    │                   │                   │
    │                   │                   └── MANAGES ──► User (Entity)
    │                   │
    │                   └── INJECTS ──► CacheService
    │
    └── EXPOSES ──► POST /users
                        │
                        └── ACCEPTS ──► CreateUserDTO
```

### Dead Code Detection

Find code that can be safely removed:

```
Dead Code Analysis: 47 items found
├── HIGH confidence (23): Exported but never imported
│   └── formatLegacyDate() in src/utils/date.ts:45
│   └── UserV1DTO in src/dto/legacy/user.dto.ts:12
│   └── ... 21 more
├── MEDIUM confidence (18): Private, never called
└── LOW confidence (6): May be used dynamically
```

### Duplicate Code Detection

Identify DRY violations across your codebase:

```
Duplicate Groups Found: 8

Group 1 (Structural - 100% identical):
├── validateEmail() in src/auth/validation.ts:23
└── validateEmail() in src/user/validation.ts:45
    Recommendation: Extract to shared utils

Group 2 (Semantic - 94% similar):
├── parseUserInput() in src/api/parser.ts:78
└── sanitizeInput() in src/webhook/parser.ts:34
    Recommendation: Review for consolidation
```

---

## Swarm Coordination

**Execute complex, multi-file changes with parallel AI agents.**

The swarm system enables multiple Claude agents to work on your codebase simultaneously, coordinating through the code graph without stepping on each other.

```
                         ┌──────────────────┐
                         │   ORCHESTRATOR   │
                         │                  │
                         │ "Add JSDoc to    │
                         │  all services"   │
                         └────────┬─────────┘
                                  │
                    ┌─────────────┼─────────────┐
                    │             │             │
                    ▼             ▼             ▼
             ┌──────────┐  ┌──────────┐  ┌──────────┐
             │ Worker 1 │  │ Worker 2 │  │ Worker 3 │
             │          │  │          │  │          │
             │ Claiming │  │ Working  │  │ Claiming │
             │ AuthSvc  │  │ UserSvc  │  │ PaySvc   │
             └──────────┘  └──────────┘  └──────────┘
                    │             │             │
                    └─────────────┼─────────────┘
                                  │
                                  ▼
                    ┌─────────────────────────────┐
                    │      PHEROMONE TRAILS       │
                    │                             │
                    │  AuthService: [claimed]     │
                    │  UserService: [modifying]   │
                    │  PayService:  [claimed]     │
                    │  CacheService: [available]  │
                    │                             │
                    └─────────────────────────────┘
```

### Two Coordination Mechanisms

#### 1. Pheromone System (Stigmergic)

Agents leave markers on code nodes that decay over time—like ants leaving scent trails:

| Pheromone | Half-Life | Meaning |
|-----------|-----------|---------|
| `exploring` | 2 min | "I'm looking at this" |
| `claiming` | 1 hour | "This is my territory" |
| `modifying` | 10 min | "I'm actively changing this" |
| `completed` | 24 hours | "I finished work here" |
| `warning` | Never | "Don't touch this" |
| `blocked` | 5 min | "I'm stuck" |

**Self-healing**: If an agent crashes, its pheromones decay and the work becomes available again.

#### 2. Task Queue (Blackboard)

Explicit task management with dependencies:

```
┌─────────────────────────────────────────────────────────────┐
│                        TASK QUEUE                           │
├─────────────────────────────────────────────────────────────┤
│ [available] Add JSDoc to UserService         priority: high │
│ [claimed]   Add JSDoc to AuthService         agent: worker1 │
│ [blocked]   Update API docs ─────────────────► depends on ──┤
│ [in_progress] Add JSDoc to PaymentService    agent: worker2 │
│ [completed] Add JSDoc to CacheService        ✓              │
└─────────────────────────────────────────────────────────────┘
```

### Swarm Tools

| Tool | Purpose |
|------|---------|
| `swarm_post_task` | Add a task to the queue |
| `swarm_get_tasks` | Query tasks with filters |
| `swarm_claim_task` | Claim/start/release a task |
| `swarm_complete_task` | Complete/fail/request review |
| `swarm_pheromone` | Leave a marker on a code node |
| `swarm_sense` | Query what other agents are doing |
| `swarm_cleanup` | Remove pheromones after completion |

### Example: Parallel Refactoring

```typescript
// Orchestrator decomposes the task and creates individual work items
swarm_post_task({
  projectId: "backend",
  swarmId: "swarm_rename_user",
  title: "Update UserService.findUserById",
  description: "Rename getUserById to findUserById in UserService",
  type: "refactor",
  createdBy: "orchestrator"
})

// Workers claim and execute tasks
swarm_claim_task({ projectId: "backend", swarmId: "swarm_rename_user", agentId: "worker_1" })
// ... do work ...
swarm_complete_task({ taskId: "task_1", agentId: "worker_1", action: "complete", summary: "Renamed method" })
```

### Install the Swarm Skill

For optimal swarm execution, install the included Claude Code skill that teaches agents the coordination protocol:

```bash
# Copy to your global skills directory
mkdir -p ~/.claude/skills
cp -r skills/swarm ~/.claude/skills/
```

Or for a specific project:
```bash
cp -r skills/swarm .claude/skills/
```

The skill provides:
- Worker agent protocol with step-by-step workflow
- Multi-phase orchestration patterns (discovery, contracts, implementation, validation)
- Common failure modes and how to prevent them
- Complete tool reference

Once installed, just say "swarm" or "parallel agents" and Claude will use the skill automatically.

See [`skills/swarm/SKILL.md`](skills/swarm/SKILL.md) for the full documentation.

---

## All Tools

| Tool | Description |
|------|-------------|
| **Discovery** | |
| `list_projects` | List parsed projects in the database |
| `search_codebase` | Semantic search using vector embeddings |
| `traverse_from_node` | Explore relationships from a node |
| `natural_language_to_cypher` | Convert questions to Cypher queries |
| **Analysis** | |
| `impact_analysis` | Assess refactoring risk (LOW/MEDIUM/HIGH/CRITICAL) |
| `detect_dead_code` | Find unreferenced exports and methods |
| `detect_duplicate_code` | Find structural and semantic duplicates |
| **Parsing** | |
| `parse_typescript_project` | Build the graph from source |
| `check_parse_status` | Monitor async parsing jobs |
| `start_watch_project` | Auto-update graph on file changes |
| `stop_watch_project` | Stop file watching |
| `list_watchers` | List active file watchers |
| **Swarm** | |
| `swarm_post_task` | Add task to the queue |
| `swarm_get_tasks` | Query tasks |
| `swarm_claim_task` | Claim/start/release tasks |
| `swarm_complete_task` | Complete/fail/review tasks |
| `swarm_pheromone` | Leave coordination markers |
| `swarm_sense` | Query what others are doing |
| `swarm_cleanup` | Clean up after swarm completion |
| **Utility** | |
| `test_neo4j_connection` | Verify database connectivity |

### Tool Workflow Patterns

**Pattern 1: Discovery → Focus → Deep Dive**
```
list_projects → search_codebase → traverse_from_node → traverse (with skip for pagination)
```

**Pattern 2: Pre-Refactoring Safety**
```
search_codebase("function to change") → impact_analysis(nodeId) → review risk level
```

**Pattern 3: Code Health Audit**
```
detect_dead_code → detect_duplicate_code → prioritize cleanup
```

**Pattern 4: Multi-Agent Work**
```
swarm_post_task → swarm_claim_task → swarm_complete_task → swarm_get_tasks(includeStats) → swarm_cleanup
```

### Multi-Project Support

All query tools require `projectId` for isolation. You can use:
- **Project ID**: `proj_a1b2c3d4e5f6` (auto-generated)
- **Project name**: `my-backend` (from package.json)
- **Project path**: `/path/to/project` (resolved automatically)

```typescript
// These all work:
search_codebase({ projectId: "my-backend", query: "auth" })
search_codebase({ projectId: "proj_a1b2c3d4e5f6", query: "auth" })
search_codebase({ projectId: "/path/to/my-backend", query: "auth" })
```

---

## Framework Support

### NestJS (Built-in)

Deep understanding of NestJS patterns:

- **Controllers** with route analysis (`@Controller`, `@Get`, `@Post`, etc.)
- **Services** with dependency injection mapping (`@Injectable`)
- **Modules** with import/export relationships (`@Module`)
- **Guards, Pipes, Interceptors** as middleware chains
- **DTOs** with validation decorators (`@IsString`, `@IsEmail`, etc.)
- **Entities** with TypeORM relationship mapping

**NestJS-Specific Relationships:**
- `INJECTS` - Dependency injection
- `EXPOSES` - Controller exposes HTTP endpoint
- `MODULE_IMPORTS`, `MODULE_PROVIDES`, `MODULE_EXPORTS` - Module system
- `GUARDED_BY`, `TRANSFORMED_BY`, `INTERCEPTED_BY` - Middleware

### Custom Framework Schemas

The parser is **config-driven**. Define your own framework patterns:

```typescript
// Example: Custom React schema
const REACT_SCHEMA = {
  name: 'react',
  decoratorPatterns: [
    { pattern: /^use[A-Z]/, semanticType: 'ReactHook' },
    { pattern: /^with[A-Z]/, semanticType: 'HOC' },
  ],
  nodeTypes: [
    { coreType: 'FunctionDeclaration', condition: (node) => node.name?.endsWith('Provider'), semanticType: 'ContextProvider' },
  ],
  relationships: [
    { type: 'PROVIDES_CONTEXT', from: 'ContextProvider', to: 'ReactHook' },
  ]
};
```

The dual-schema system means every node has:
- `coreType`: AST-level (ClassDeclaration, FunctionDeclaration)
- `semanticType`: Framework meaning (NestController, ReactHook)

This enables queries like "find all hooks that use context" while maintaining AST precision for refactoring.

---

## Embedding Configuration

Local embeddings are the default — **no API key needed**. The Python sidecar starts automatically on first use and runs a local model for high-quality code embeddings.

The sidecar uses **float16 (half precision)** by default, which halves memory usage with no meaningful quality loss. It also auto-shuts down after 3 minutes of inactivity to free memory, and restarts lazily when needed (~15-20s).

> **Half precision mode:** To reduce memory usage at the cost of some accuracy, set `EMBEDDING_HALF_PRECISION=true`.

### Available Models

Set via the `EMBEDDING_MODEL` environment variable:

| Model | Dimensions | RAM (fp16) | Quality | Best For |
|-------|-----------|-----|---------|----------|
| `Qwen/Qwen3-Embedding-0.6B` (default) | 1024 | ~1.2 GB | Best | Default, code-aware, MTEB-Code #1 |
| `Qodo/Qodo-Embed-1-1.5B` | 1536 | ~4.5 GB | Great | Machines with 32+ GB RAM |
| `BAAI/bge-base-en-v1.5` | 768 | ~250 MB | Good | General purpose, low RAM |
| `sentence-transformers/all-MiniLM-L6-v2` | 384 | ~100 MB | OK | Minimal RAM, fast |
| `nomic-ai/nomic-embed-text-v1.5` | 768 | ~300 MB | Good | Code + prose mixed |
| `sentence-transformers/all-mpnet-base-v2` | 768 | ~250 MB | Good | Balanced quality/speed |
| `BAAI/bge-small-en-v1.5` | 384 | ~65 MB | OK | Smallest footprint |

**Example:** Use a lightweight model on a low-memory machine:
```bash
claude mcp add --scope user code-graph-context \
  -e EMBEDDING_MODEL=BAAI/bge-base-en-v1.5 \
  -- code-graph-context
```

### Switching Models

**Switching models requires re-parsing** — vector index dimensions are locked per model. Drop existing indexes first:

```cypher
DROP INDEX embedded_nodes_idx IF EXISTS;
DROP INDEX session_notes_idx IF EXISTS;
```

Then re-parse your project with the new model configured.

### Using OpenAI Instead

If you prefer OpenAI embeddings (higher quality, requires API key):

```bash
claude mcp add --scope user code-graph-context \
  -e OPENAI_ENABLED=true \
  -e OPENAI_API_KEY=sk-your-key-here \
  -- code-graph-context
```

---

## Troubleshooting

### MCP Server Not Connecting

```bash
# Check the server is registered
claude mcp list

# Verify Neo4j is running
docker ps | grep neo4j

# Test manually
code-graph-context status
```

### Embedding Errors

**"Failed to generate embedding"** — The local sidecar may not have started. Check:
```bash
# Verify Python deps are installed
code-graph-context status

# Re-run init to fix sidecar setup
code-graph-context init
```

**Out of memory (large model on 16GB machine)** — Switch to a lighter model:
```bash
claude mcp add --scope user code-graph-context \
  -e EMBEDDING_MODEL=BAAI/bge-base-en-v1.5 \
  -- code-graph-context
```

**Using OpenAI and getting auth errors** — Ensure your key is configured:
```bash
claude mcp remove code-graph-context
claude mcp add --scope user code-graph-context \
  -e OPENAI_ENABLED=true \
  -e OPENAI_API_KEY=sk-your-key-here \
  -- code-graph-context
```

### Neo4j Memory Issues

For large codebases, increase memory limits:

```bash
# Stop and recreate with more memory
code-graph-context stop
code-graph-context init --memory 4G
```

### Parsing Timeouts

Use async mode for large projects:
```typescript
parse_typescript_project({
  projectPath: "/path/to/project",
  tsconfigPath: "/path/to/project/tsconfig.json",
  async: true  // Returns immediately, poll with check_parse_status
})
```

---

## CLI Commands

```bash
code-graph-context init [options]   # Set up Neo4j + Python sidecar + embedding model
code-graph-context status           # Check Docker/Neo4j/sidecar status
code-graph-context stop             # Stop Neo4j container
```

**Init options:**
- `-p, --port <port>` - Bolt port (default: 7687)
- `--http-port <port>` - Browser port (default: 7474)
- `--password <password>` - Neo4j password (default: PASSWORD)
- `-m, --memory <size>` - Heap memory (default: 2G)
- `-f, --force` - Recreate container

---

## Contributing

```bash
git clone https://github.com/drewdrewH/code-graph-context.git
cd code-graph-context
npm install
npm run build
npm run dev  # Watch mode
```

Conventional Commits: `feat|fix|docs|refactor(scope): description`

---

## License

MIT - see [LICENSE](LICENSE)

---

## Links

- [Issues](https://github.com/drewdrewH/code-graph-context/issues)
- [MCP Documentation](https://modelcontextprotocol.io/docs)
- [Neo4j](https://neo4j.com/)
