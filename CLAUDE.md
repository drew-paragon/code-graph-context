# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Code Graph Context is an MCP (Model Context Protocol) server that builds code graphs to provide rich context to LLMs. It parses TypeScript codebases using AST analysis (ts-morph), stores the graph in Neo4j with vector embeddings, and provides semantic search and graph traversal tools.

## Build & Development Commands

```bash
npm run build          # Compile TypeScript to dist/
npm run dev            # Watch mode compilation
npm run mcp            # Run MCP server: node dist/mcp/mcp.server.js
npm run lint           # ESLint with auto-fix
npm run format         # Prettier formatting
```

## Architecture

### Data Flow
```
TypeScript Project → AST Parser (ts-morph) → Graph Nodes/Edges → Neo4j + Vector Embeddings → MCP Tools
```

### Key Directories

- `src/mcp/` - MCP server entry point and tools
  - `mcp.server.ts` - Server initialization
  - `tools/` - 7 MCP tools (search_codebase, traverse_from_node, impact_analysis, etc.)
  - `handlers/` - Business logic for graph generation and traversal
- `src/core/` - Core business logic
  - `parsers/typescript-parser.ts` - Main AST parser (~1000 lines)
  - `config/schema.ts` - Core graph schema definitions
  - `config/nestjs-framework-schema.ts` - NestJS semantic patterns
  - `embeddings/` - OpenAI embeddings and NL-to-Cypher services
- `src/storage/neo4j/` - Neo4j driver and queries

### Dual-Schema System

The parser uses two schema layers:
1. **Core Schema** (AST-level): ClassDeclaration, MethodDeclaration, PropertyDeclaration, ImportDeclaration, etc.
2. **Framework Schema** (Semantic): Controller, Service, Module, Guard, Repository, etc. (NestJS patterns)

Nodes have both `coreType` (AST) and `semanticType` (framework interpretation).

### Multi-Project Support

The system supports multiple projects in a single Neo4j database through project isolation:

- **Project ID Format**: `proj_<12-hex-chars>` (e.g., `proj_a1b2c3d4e5f6`)
- **Auto-generation**: If not provided, projectId is generated deterministically from the project path
- **Explicit Override**: Pass `projectId` to `parse_typescript_project` to use a custom ID
- **Isolation**: All queries are automatically scoped to the project - nodes from different projects never interfere

**Usage in Tools:**
```typescript
// All query tools require projectId
search_codebase({ projectId: "proj_abc123...", query: "..." })
traverse_from_node({ projectId: "proj_abc123...", nodeId: "..." })
impact_analysis({ projectId: "proj_abc123...", nodeId: "..." })

// parse_typescript_project returns the resolved projectId
const result = await parse_typescript_project({ projectPath: "/path/to/project" });
// result.resolvedProjectId => "proj_a1b2c3d4e5f6"
```

### Migration from Pre-Multi-Project Versions

If upgrading from a version without multi-project support, note these breaking changes:

**Breaking Changes:**
- Node IDs now include projectId prefix (format: `proj_xxx:CoreType:hash`)
- All query tools now require `projectId` parameter
- Existing nodes in the database have old ID format and won't be accessible

**Migration Options:**

1. **Clear and Re-parse (Recommended)**
   ```bash
   # Clear the database and re-parse your project
   # The new projectId will be auto-generated from the project path
   ```

2. **Continue Without Multi-Project**
   - Not recommended - existing node IDs are incompatible
   - Queries will fail to find nodes with old ID format

**Note:** There is no automatic migration path. Existing graphs must be rebuilt to use the new ID format with projectId isolation.

### MCP Tools

| Tool | Purpose |
|------|---------|
| `search_codebase` | Semantic search via vector embeddings - start here |
| `traverse_from_node` | Explore relationships from a node ID |
| `impact_analysis` | Analyze dependencies (LOW/MEDIUM/HIGH/CRITICAL risk) |
| `parse_typescript_project` | Build the graph from source code |
| `natural_language_to_cypher` | Convert NL to Cypher queries |
| `test_neo4j_connection` | Health check |

### Response Format

All tools return JSON:API normalized responses:
- `nodes` map: Each node stored once, referenced by ID
- `depths` array: Relationship chains at each depth level
- Source code truncated to 1000 chars (first 500 + last 500)

### Response Size Control (Compact Mode)

All query tools support parameters to reduce response size for exploration:

| Parameter | Tools | Effect |
|-----------|-------|--------|
| `includeCode: false` | search_codebase, traverse_from_node | Exclude source code (names/paths only) |
| `summaryOnly: true` | traverse_from_node | Return only file paths and statistics |
| `snippetLength: N` | search_codebase, traverse_from_node | Limit code snippets to N characters |
| `maxTotalNodes: N` | traverse_from_node | Cap total unique nodes returned |
| `maxNodesPerChain: N` | both | Limit relationship chains per depth |

**Recommended usage patterns:**
```typescript
// Structure overview - just names/paths, no source code
search_codebase({ projectId: "...", query: "...", includeCode: false })

// Quick summary - file paths and statistics only
traverse_from_node({ projectId: "...", nodeId: "...", summaryOnly: true })

// Detailed with smaller snippets
traverse_from_node({ projectId: "...", nodeId: "...", snippetLength: 200 })

// Minimal output for large graphs
traverse_from_node({ projectId: "...", nodeId: "...", includeCode: false, maxNodesPerChain: 3 })
```

## Dependencies

- **Neo4j 5.0+** with APOC plugin required
- **Python 3.10+** for local embeddings (sidecar)
- **ts-morph** for TypeScript AST parsing
- **OpenAI API** (optional) for embeddings and NL queries

## Embedding Configuration

Local embeddings are the default — no API key needed. The sidecar runs a Python
model that starts automatically on first use.

| Env Variable | Default | Description |
|---|---|---|
| `EMBEDDING_MODEL` | `Qwen/Qwen3-Embedding-0.6B` | HuggingFace model for local embeddings |
| `EMBEDDING_DEVICE` | `cpu` | Device for embeddings (`cpu` or `mps`). CPU default avoids MPS memory bloat |
| `EMBEDDING_HALF_PRECISION` | `false` | Set `true` for float16 (halves memory) |
| `EMBEDDING_SIDECAR_PORT` | `8787` | Port for the local embedding server |
| `OPENAI_ENABLED` | `false` | Set `true` to use OpenAI instead of local |
| `OPENAI_API_KEY` | — | Required when OPENAI_ENABLED=true |

**Available local models (set via EMBEDDING_MODEL):**

| Model | Dims | RAM | Quality | Best for |
|---|---|---|---|---|
| `Qwen/Qwen3-Embedding-0.6B` | 1024 | ~1.2 GB | Best | Default, code-aware, MTEB-Code #1 |
| `Qodo/Qodo-Embed-1-1.5B` | 1536 | ~9 GB | Great | Machines with 32+ GB RAM |
| `BAAI/bge-base-en-v1.5` | 768 | ~500 MB | Good | General purpose, low RAM |
| `sentence-transformers/all-MiniLM-L6-v2` | 384 | ~200 MB | OK | Minimal RAM, fast |
| `nomic-ai/nomic-embed-text-v1.5` | 768 | ~600 MB | Good | Code + prose mixed |
| `sentence-transformers/all-mpnet-base-v2` | 768 | ~500 MB | Good | Balanced quality/speed |
| `BAAI/bge-small-en-v1.5` | 384 | ~130 MB | OK | Smallest footprint |

**Switching models requires re-parsing** — vector index dimensions are locked per model.
Drop existing indexes first:
```cypher
DROP INDEX embedded_nodes_idx IF EXISTS;
DROP INDEX session_notes_idx IF EXISTS;
```

## Environment Variables

```
NEO4J_URI=bolt://localhost:7687
NEO4J_USER=neo4j
NEO4J_PASSWORD=PASSWORD

# Optional — local embeddings work without any of these
EMBEDDING_MODEL=Qwen/Qwen3-Embedding-0.6B
OPENAI_ENABLED=true
OPENAI_API_KEY=sk-...
```

## Commit Convention

Conventional Commits: `type(scope): description`
- feat, fix, docs, style, refactor, perf, test, chore
