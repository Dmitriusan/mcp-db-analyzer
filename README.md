[![npm version](https://img.shields.io/npm/v/mcp-db-analyzer)](https://www.npmjs.com/package/mcp-db-analyzer)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)

# MCP DB Analyzer

A Model Context Protocol (MCP) server that gives AI assistants deep visibility into your databases. It inspects schemas, detects index problems, analyzes table bloat/fragmentation, and explains query plans — so your AI can give you actionable database optimization advice instead of generic suggestions.

Supports **PostgreSQL**, **MySQL**, and **SQLite**.

## Why This Tool?

There are dozens of database MCP servers — most are **CRUD gateways** (run queries, list tables). This tool **analyzes** your database: schema problems, missing indexes, bloated tables, slow queries, vacuum health.

Other analytical MCP servers (CrystalDBA, pg-dash, MCP-PostgreSQL-Ops) cover PostgreSQL only. **MCP DB Analyzer is the only analytical MCP server that supports PostgreSQL, MySQL, and SQLite** in a single `npx` install — no Python, no Go, no Docker.

## Features

- **9 MCP tools** for comprehensive database analysis
- **PostgreSQL + MySQL + SQLite** support via `--driver` flag
- **Read-only by design** — all queries wrapped in READ ONLY transactions
- **Markdown output** optimized for LLM consumption
- **Zero configuration** — just set `DATABASE_URL`

## Installation

```bash
npx mcp-db-analyzer
```

Or install globally:

```bash
npm install -g mcp-db-analyzer
```

## Configuration

Set the `DATABASE_URL` environment variable:

```bash
export DATABASE_URL="postgresql://user:password@localhost:5432/mydb"
```

Or use individual PG variables: `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER`, `PGPASSWORD`.

### MySQL

Set `DATABASE_URL` with a MySQL connection string and pass `--driver mysql`:

```bash
export DATABASE_URL="mysql://user:password@localhost:3306/mydb"
mcp-db-analyzer --driver mysql
```

Or use individual MySQL variables: `MYSQL_HOST`, `MYSQL_PORT`, `MYSQL_DATABASE`, `MYSQL_USER`, `MYSQL_PASSWORD`.

You can also set `DB_DRIVER=mysql` as an environment variable instead of passing the flag.

### SQLite

Pass a file path via `DATABASE_URL` and use `--driver sqlite`:

```bash
export DATABASE_URL="/path/to/database.db"
mcp-db-analyzer --driver sqlite
```

### Claude Desktop (PostgreSQL)

Add to `~/.claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "db-analyzer": {
      "command": "npx",
      "args": ["-y", "mcp-db-analyzer"],
      "env": {
        "DATABASE_URL": "postgresql://user:password@localhost:5432/mydb"
      }
    }
  }
}
```

### Claude Desktop (MySQL)

```json
{
  "mcpServers": {
    "db-analyzer": {
      "command": "npx",
      "args": ["-y", "mcp-db-analyzer", "--driver", "mysql"],
      "env": {
        "DATABASE_URL": "mysql://user:password@localhost:3306/mydb"
      }
    }
  }
}
```

### Claude Desktop (SQLite)

```json
{
  "mcpServers": {
    "db-analyzer": {
      "command": "npx",
      "args": ["-y", "mcp-db-analyzer", "--driver", "sqlite"],
      "env": {
        "DATABASE_URL": "/path/to/database.db"
      }
    }
  }
}
```

## Quick Demo

Once configured, try these prompts in Claude:

1. **"Show me the schema and how tables are related"** — Returns table structures, foreign keys, and identifies orphan tables
2. **"Are there any slow queries or missing indexes?"** — Ranks slow queries by execution time and suggests indexes to add
3. **"How many connections are active? Are any queries blocked?"** — Shows connection pool utilization, idle-in-transaction sessions, and blocked queries

## Tools

### `inspect_schema`

List all tables with row counts and sizes, or drill into a specific table's columns, types, constraints, and foreign keys.

**Parameters:**
- `table` (optional) — Table name to inspect. Omit to list all tables.
- `schema` (default: `"public"`) — Database schema.

```
> inspect_schema

## Tables in schema 'public'

| Table       | Rows (est.) | Total Size |
|-------------|-------------|------------|
| users       | 12,450      | 3.2 MB     |
| orders      | 89,100      | 18.4 MB    |
| order_items | 245,000     | 12.1 MB    |
```

```
> inspect_schema table="users"

## Table: public.users

- **Rows (est.)**: 12,450
- **Total size**: 3.2 MB

### Columns
| # | Column | Type          | Nullable | Default |
|---|--------|---------------|----------|---------|
| 1 | id     | integer       | NO       | nextval |
| 2 | email  | varchar(255)  | NO       | -       |
| 3 | name   | varchar(100)  | YES      | -       |
```

### `analyze_indexes`

Find unused indexes wasting disk space and missing indexes causing slow sequential scans. Also detects unindexed foreign keys.

**Parameters:**
- `schema` (default: `"public"`) — Database schema.
- `mode` (`"usage"` | `"missing"` | `"all"`, default: `"all"`) — Analysis mode.

```
> analyze_indexes

### Unused Indexes (2 found)
| Table | Index              | Size   | Definition                    |
|-------|--------------------|--------|-------------------------------|
| users | idx_users_legacy   | 1.2 MB | CREATE INDEX ... (old_col)    |

### Unindexed Foreign Keys (1 found)
| Table       | Column  | FK →   | Constraint        |
|-------------|---------|--------|-------------------|
| order_items | user_id | users  | fk_items_user_id  |
```

### `explain_query`

Run EXPLAIN on a SQL query and get a formatted execution plan with cost estimates, node types, and optimization warnings. Optionally run EXPLAIN ANALYZE for actual timing (SELECT queries only).

**Parameters:**
- `sql` — The SQL query to explain.
- `analyze` (default: `false`) — Run EXPLAIN ANALYZE (executes the query; SELECT only).

```
> explain_query sql="SELECT * FROM orders WHERE status = 'pending'"

## Query Plan Analysis

- **Estimated Total Cost**: 1234.56
- **Estimated Rows**: 500

### Plan Tree
→ Seq Scan on orders (cost=0..1234.56 rows=500)
  Filter: (status = 'pending')

### Potential Issues
- **Sequential Scan** on `orders` (~500 rows). Consider adding an index.
```

### `analyze_table_bloat`

Analyze table bloat by checking dead tuple ratios, vacuum history, and table sizes. Recommends VACUUM ANALYZE for tables with >10% dead tuples.

**Parameters:**
- `schema` (default: `"public"`) — Database schema.

```
> analyze_table_bloat

### Tables Needing VACUUM (1 found)
| Table     | Live Tuples | Dead Tuples | Bloat % | Size  | Last Vacuum |
|-----------|-------------|-------------|---------|-------|-------------|
| audit_log | 8,000       | 2,000       | 20.0%   | 10 MB | Never       |

### Recommended Actions
VACUUM ANALYZE public.audit_log;
```

### `suggest_missing_indexes`

Find tables with high sequential scan counts and zero index usage, cross-referenced with unused indexes wasting space. Provides actionable CREATE INDEX and DROP INDEX recommendations.

**Parameters:**
- `schema` (default: `"public"`) — Database schema.

```
> suggest_missing_indexes

### Tables Missing Indexes (1 found)
| Table  | Seq Scans | Index Scans | Rows   | Size  |
|--------|-----------|-------------|--------|-------|
| events | 5,000     | 0           | 50,000 | 25 MB |

### Unused Indexes (1 found)
| Table | Index            | Size | Definition                       |
|-------|------------------|------|----------------------------------|
| users | idx_users_legacy | 8 kB | CREATE INDEX ... (legacy_col)    |

DROP INDEX public.idx_users_legacy;
```

### `analyze_slow_queries`

Find the slowest queries using `pg_stat_statements` (PostgreSQL) or `performance_schema` (MySQL). Shows execution times, call counts, and identifies optimization candidates.

**Parameters:**
- `schema` (default: `"public"`) — Database schema.
- `limit` (default: `10`) — Number of slow queries to return.

```
> analyze_slow_queries

## Slow Query Analysis (by avg execution time)

| # | Avg Time | Total Time | Calls | Avg Rows | Query |
|---|----------|------------|-------|----------|-------|
| 1 | 150.0ms  | 750000ms   | 5000  | 5        | `SELECT * FROM orders WHERE status = $1` |
| 2 | 200.0ms  | 40000ms    | 200   | 2        | `SELECT u.* FROM users u JOIN orders o...` |

### Recommendations
- **2 high-impact queries** — called >100 times with >100ms avg
- **2 queries returning few rows but slow** — likely missing indexes
```

### `analyze_connections`

Analyze active database connections. Detects idle-in-transaction sessions, long-running queries, lock contention, and connection pool utilization. PostgreSQL and MySQL only.

```
> analyze_connections

## Connection Analysis (PostgreSQL)

### Connection States
| State | Count |
|-------|-------|
| active | 3 |
| idle | 12 |
| idle in transaction | 2 |
| **Total** | **17** |

**Max connections**: 100
**Utilization**: 17.0%

### Idle-in-Transaction Connections
| PID  | User | Duration | Query |
|------|------|----------|-------|
| 1234 | app  | 00:05:30 | UPDATE orders SET status = $1 |
```

### `analyze_table_relationships`

Analyze foreign key relationships between tables. Builds a dependency graph showing entity connectivity, orphan tables (no FKs), cascading delete chains, and hub entities.

**Parameters:**
- `schema` (default: `"public"`) — Database schema.

```
> analyze_table_relationships

## Table Relationships

**Tables**: 5
**Foreign Keys**: 4

### Entity Connectivity
| Table | Incoming FKs | Outgoing FKs | Total |
|-------|-------------|-------------|-------|
| users **hub** | 5 | 0 | 5 |
| orders | 1 | 2 | 3 |

### Orphan Tables (no FK relationships)
- `audit_log`

### Cascading Delete Chains
- **users** → cascades to: orders, addresses
  - **orders** → further cascades to: order_items
```

### `analyze_vacuum`

Analyze PostgreSQL VACUUM maintenance status. Checks dead tuple ratios, vacuum staleness, autovacuum configuration, and identifies tables needing manual VACUUM. **PostgreSQL only.**

```
> analyze_vacuum
```

**Detects:**
- Tables with high dead tuple ratios (>10% warning, >20% critical)
- Tables never vacuumed or analyzed
- Autovacuum disabled globally
- Autovacuum configuration issues

**Output includes:**
- Findings grouped by severity (CRITICAL / WARNING / INFO)
- Tables needing VACUUM with dead tuple percentages
- Full vacuum history per table
- Autovacuum configuration settings

## Security

- All queries are wrapped in READ ONLY transactions by default
- `EXPLAIN ANALYZE` is restricted to `SELECT` queries only
- DDL/DML statements are rejected in ANALYZE mode
- No data modification queries are allowed

## Contributing

1. Clone the repo
2. `npm install`
3. `npm run build` — TypeScript compilation
4. `npm test` — Run unit tests (vitest)
5. `npm run dev` — Watch mode for development

## Limitations & Known Issues

- **Read-only**: All queries use read-only connections. Cannot modify data or schema.
- **pg_stat_statements required**: Slow query analysis on PostgreSQL requires the `pg_stat_statements` extension to be installed and loaded.
- **MySQL performance_schema**: Index usage and scan statistics require `performance_schema` to be enabled (off by default in some MySQL installations).
- **SQLite**: No index usage statistics available (SQLite doesn't track this). Sequential scan analysis and slow query detection are not supported for SQLite.
- **Large databases**: Schema inspection on databases with 500+ tables may produce very long output. Use the `schema` parameter to limit scope.
- **Table name parameterization**: SQLite PRAGMA statements use string interpolation for table names (SQLite does not support parameterized PRAGMAs). Table names are sourced from `sqlite_master` system table.
- **Cross-database queries**: Cannot analyze queries that span multiple databases or use database links.
- **Estimated row counts**: MySQL `TABLE_ROWS` in `information_schema` is an estimate, not exact.
- **Schema scope**: All tools default to `public` schema. Non-public schemas require explicit specification. Multi-schema analysis requires running tools per schema separately.
- **Connection analysis**: `analyze_connections` is PostgreSQL/MySQL only. Not available for SQLite databases.
- **Vacuum analysis**: `analyze_vacuum` is PostgreSQL only. For MySQL, use `OPTIMIZE TABLE` or `analyze_table_bloat`.

## Part of the MCP Java Backend Suite

- [mcp-spring-boot-actuator](https://www.npmjs.com/package/mcp-spring-boot-actuator) — Spring Boot health, metrics, and bean analysis
- [mcp-jvm-diagnostics](https://www.npmjs.com/package/mcp-jvm-diagnostics) — Thread dump and GC log analysis
- [mcp-redis-diagnostics](https://www.npmjs.com/package/mcp-redis-diagnostics) — Redis memory, slowlog, and client diagnostics
- [mcp-migration-advisor](https://www.npmjs.com/package/mcp-migration-advisor) — Flyway/Liquibase migration risk analysis

## License

MIT
