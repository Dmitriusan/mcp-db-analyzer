# MCP Database Analyzer — Architecture

## Overview

MCP server that gives AI agents deep PostgreSQL analysis capabilities:
schema introspection, index optimization, and query plan inspection.
Not another CRUD connector — this is the **analysis layer** that no
existing MCP server provides.

## Technical Stack

- **Protocol**: MCP (Model Context Protocol) v1.x
- **SDK**: `@modelcontextprotocol/sdk` ^1.27.1
- **Language**: TypeScript (ESM, Node 22+)
- **Database**: PostgreSQL via `pg` (node-postgres)
- **Schema**: Zod v3 for tool input validation
- **Transport**: stdio (standard for local MCP servers)

## Architecture Decisions

### 1. Read-only by default
All schema and index queries use `SET TRANSACTION READ ONLY`.
Only `explain_query` with `analyze: true` uses writable connections,
and it rejects DDL/DML statements.

### 2. Markdown output format
Tools return Markdown-formatted text with tables, headers, and code blocks.
This is optimal for LLM consumption — structured enough to parse,
readable enough to present to users.

### 3. PostgreSQL system catalogs over information_schema
Where possible, we use `pg_stat_user_tables`, `pg_stat_user_indexes`,
and `pg_catalog` for richer statistics. `information_schema` is used
for standard schema metadata (columns, constraints).

### 4. Connection via environment variables
Standard PostgreSQL connection: `DATABASE_URL` or `PGHOST`/`PGPORT`/
`PGDATABASE`/`PGUSER`/`PGPASSWORD`. No config files. Compatible with
every hosting provider (Heroku, Render, Supabase, Neon, etc.).

### 5. Error as content, not exceptions
Tool handlers catch all errors and return them as text content.
This prevents MCP protocol errors and lets the AI agent decide
how to handle database connectivity issues.

## Tools

### `inspect_schema`
- **Input**: optional `table` name, optional `schema` (default: "public")
- **Without table**: lists all tables with row estimates and sizes
- **With table**: detailed columns, types, nullable, defaults, constraints, FKs
- **Queries**: `information_schema.tables`, `.columns`, `.table_constraints`,
  `.key_column_usage`, `pg_stat_user_tables`

### `analyze_indexes`
- **Input**: optional `schema`, `mode` ("usage" | "missing" | "all")
- **Usage mode**: finds unused indexes (zero scans) with sizes and definitions
- **Missing mode**: finds tables with more seq scans than idx scans (>1000 rows),
  plus unindexed foreign keys
- **Queries**: `pg_stat_user_indexes`, `pg_indexes`, `pg_stat_user_tables`

### `explain_query`
- **Input**: `sql` query, optional `analyze` flag
- **Output**: formatted plan tree with node types, costs, actual times (if analyzed),
  buffer stats, and automated warnings
- **Warnings detected**:
  - Sequential scans on large tables
  - High filter ratios (rows removed >> rows kept)
  - Nested loops with high row counts
  - Disk sorts (external merge)
- **Safety**: rejects DDL/DML in ANALYZE mode

## Project Structure

```
mcp-db-analyzer/
├── package.json          # MCP server package with bin entry
├── tsconfig.json         # ES2022, Node16 modules
├── src/
│   ├── index.ts          # MCP server entry — tool registration + transport
│   ├── db.ts             # PostgreSQL pool management + query helpers
│   └── analyzers/
│       ├── schema.ts     # Schema introspection (tables, columns, constraints)
│       ├── indexes.ts    # Index usage + missing index detection
│       └── query.ts      # EXPLAIN plan parsing + warnings
└── build/                # Compiled output (gitignored)
```

## Distribution Strategy

1. **npm**: `npx @leaven/mcp-db-analyzer` — primary distribution
2. **MCPize**: Paid tiers (free basic, $19-29/mo pro)
3. **GitHub**: Open-source core for awareness + trust
4. **Marketplace listings**: mcp.so, PulseMCP, awesome-mcp-servers

## Roadmap

### Phase 1: MVP (current)
- PostgreSQL schema introspection
- Index usage analysis + missing index detection
- Query plan analysis with warnings

### Phase 2: Deep Analysis
- Table bloat detection (dead tuples, vacuum stats)
- Slow query log analysis (pg_stat_statements)
- Schema anti-pattern detection (varchar(255), missing timestamps, etc.)
- Duplicate index detection

### Phase 3: Multi-Database
- MySQL support (information_schema + EXPLAIN parsing)
- Connection profiles (switch between databases)

### Phase 4: Premium
- Optimization script generation (CREATE INDEX suggestions)
- Migration diff analysis
- Scheduled health reports
- Team sharing via MCP resources

## Competitive Positioning

- **PostgreSQL MCP connector** ($4.2K/mo): CRUD operations only. No analysis.
- **Neon MCP**: Neon-specific. Not general PostgreSQL.
- **Supabase MCP**: Supabase management. Not database analysis.
- **CrystalDBA** (2.3K stars): PostgreSQL-only analytical MCP. 8 tools. No MySQL/SQLite.
- **Us**: The only **multi-database** analytical MCP server (PostgreSQL + MySQL + SQLite). 8 tools covering bloat, slow queries, index health, connections, schema, and optimization suggestions.
