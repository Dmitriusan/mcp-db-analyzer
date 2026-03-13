#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { listTables, inspectTable } from "./analyzers/schema.js";
import { analyzeIndexUsage, findMissingIndexes } from "./analyzers/indexes.js";
import { explainQuery } from "./analyzers/query.js";
import { analyzeTableBloat } from "./analyzers/bloat.js";
import { suggestMissingIndexes } from "./analyzers/suggestions.js";
import { analyzeSlowQueries } from "./analyzers/slow-queries.js";
import { analyzeConnections } from "./analyzers/connections.js";
import { analyzeTableRelationships } from "./analyzers/relationships.js";
import { analyzeVacuum } from "./analyzers/vacuum.js";
import { closePool, initDriver, setConnectionTimeoutMs, type DriverType } from "./db.js";
import { formatToolError } from "./errors.js";

// Handle --help
if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log(`mcp-db-analyzer v0.1.0 — MCP server for database analysis

Usage:
  mcp-db-analyzer [options]

Options:
  --driver <type>   Database driver: postgres (default), mysql, sqlite
  --help, -h        Show this help message

Environment:
  DATABASE_URL      Connection string (required)
  DB_DRIVER         Alternative to --driver flag
  PGHOST/PGPORT/... PostgreSQL individual variables
  MYSQL_HOST/...    MySQL individual variables

Tools provided:
  inspect_schema          List tables or inspect a specific table
  analyze_indexes         Find unused and missing indexes
  explain_query           EXPLAIN/EXPLAIN ANALYZE for SQL queries
  analyze_table_bloat     Detect dead tuples and fragmentation
  suggest_missing_indexes Actionable index recommendations
  analyze_slow_queries    Find slowest queries from pg_stat_statements
  analyze_connections     Detect idle-in-transaction, long queries, lock waits
  analyze_table_relationships  FK dependency graph, orphans, cascade chains
  analyze_vacuum          PostgreSQL vacuum health, dead tuples, autovacuum config`);
  process.exit(0);
}

// Parse --driver flag from CLI args or DB_DRIVER env var
const VALID_DRIVERS = new Set(["postgres", "mysql", "sqlite"]);

function detectDriver(): DriverType {
  const driverArg = process.argv.find((a) => a.startsWith("--driver="));
  if (driverArg) {
    const val = driverArg.split("=")[1];
    if (VALID_DRIVERS.has(val)) return val as DriverType;
    console.error(`Unknown driver: ${val}. Use 'postgres', 'mysql', or 'sqlite'.`);
    process.exit(1);
  }

  const driverIdx = process.argv.indexOf("--driver");
  if (driverIdx !== -1 && process.argv[driverIdx + 1]) {
    const val = process.argv[driverIdx + 1];
    if (VALID_DRIVERS.has(val)) return val as DriverType;
    console.error(`Unknown driver: ${val}. Use 'postgres', 'mysql', or 'sqlite'.`);
    process.exit(1);
  }

  const envDriver = process.env.DB_DRIVER;
  if (envDriver && VALID_DRIVERS.has(envDriver)) return envDriver as DriverType;

  return "postgres";
}

const server = new McpServer({
  name: "mcp-db-analyzer",
  version: "0.1.0",
});

// Shared Zod parameter for connection timeout
const timeoutParam = z
  .number()
  .optional()
  .default(30000)
  .describe(
    "Connection timeout in milliseconds (default: 30000). Increase for slow or remote databases."
  );

function applyTimeout(timeout_ms: number): void {
  setConnectionTimeoutMs(timeout_ms);
}

// --- Tool: inspect_schema ---
server.tool(
  "inspect_schema",
  "List all tables in a schema with row counts and sizes, or inspect a specific table's columns, types, constraints, and foreign keys.",
  {
    table: z
      .string()
      .optional()
      .describe(
        "Specific table name to inspect. Omit to list all tables."
      ),
    schema: z
      .string()
      .default("public")
      .describe("Database schema to inspect (default: public)"),
    timeout_ms: timeoutParam,
  },
  async ({ table, schema, timeout_ms }) => {
    applyTimeout(timeout_ms);
    try {
      const result = table
        ? await inspectTable(table, schema)
        : await listTables(schema);
      return { content: [{ type: "text", text: result }] };
    } catch (err) {
      return {
        content: [
          {
            type: "text",
            text: formatToolError("inspecting schema", err),
          },
        ],
      };
    }
  }
);

// --- Tool: analyze_indexes ---
server.tool(
  "analyze_indexes",
  "Analyze index usage statistics to find unused indexes wasting space and missing indexes causing slow sequential scans. Also detects unindexed foreign keys.",
  {
    schema: z
      .string()
      .default("public")
      .describe("Database schema to analyze (default: public)"),
    mode: z
      .enum(["usage", "missing", "all"])
      .default("all")
      .describe(
        "Analysis mode: 'usage' for unused index detection, 'missing' for missing index suggestions, 'all' for both"
      ),
    timeout_ms: timeoutParam,
  },
  async ({ schema, mode, timeout_ms }) => {
    applyTimeout(timeout_ms);
    try {
      const parts: string[] = [];

      if (mode === "usage" || mode === "all") {
        parts.push(await analyzeIndexUsage(schema));
      }
      if (mode === "missing" || mode === "all") {
        parts.push(await findMissingIndexes(schema));
      }

      return { content: [{ type: "text", text: parts.join("\n\n---\n\n") }] };
    } catch (err) {
      return {
        content: [
          {
            type: "text",
            text: formatToolError("analyzing indexes", err),
          },
        ],
      };
    }
  }
);

// --- Tool: explain_query ---
server.tool(
  "explain_query",
  "Run EXPLAIN on a SQL query and return a formatted plan with cost estimates, node types, and optimization warnings. Optionally runs EXPLAIN ANALYZE for actual execution statistics (read-only queries only).",
  {
    sql: z.string().describe("The SQL query to explain"),
    analyze: z
      .boolean()
      .default(false)
      .describe(
        "Run EXPLAIN ANALYZE to get actual execution times (executes the query). Only allowed for SELECT queries."
      ),
    timeout_ms: timeoutParam,
  },
  async ({ sql, analyze, timeout_ms }) => {
    applyTimeout(timeout_ms);
    try {
      const result = await explainQuery(sql, analyze);
      return { content: [{ type: "text", text: result }] };
    } catch (err) {
      return {
        content: [
          {
            type: "text",
            text: formatToolError("explaining query", err),
          },
        ],
      };
    }
  }
);

// --- Tool: analyze_table_bloat ---
server.tool(
  "analyze_table_bloat",
  "Analyze table bloat by checking dead tuple ratios (PostgreSQL) or InnoDB fragmentation (MySQL), vacuum history, and table sizes.",
  {
    schema: z
      .string()
      .default("public")
      .describe("Database schema to analyze (default: public)"),
    timeout_ms: timeoutParam,
  },
  async ({ schema, timeout_ms }) => {
    applyTimeout(timeout_ms);
    try {
      const result = await analyzeTableBloat(schema);
      return { content: [{ type: "text", text: result }] };
    } catch (err) {
      return {
        content: [
          {
            type: "text",
            text: formatToolError("analyzing table bloat", err),
          },
        ],
      };
    }
  }
);

// --- Tool: suggest_missing_indexes ---
server.tool(
  "suggest_missing_indexes",
  "Find tables with high sequential scan counts and zero index usage, cross-referenced with unused indexes wasting space. Provides actionable CREATE INDEX and DROP INDEX recommendations.",
  {
    schema: z
      .string()
      .default("public")
      .describe("Database schema to analyze (default: public)"),
    timeout_ms: timeoutParam,
  },
  async ({ schema, timeout_ms }) => {
    applyTimeout(timeout_ms);
    try {
      const result = await suggestMissingIndexes(schema);
      return { content: [{ type: "text", text: result }] };
    } catch (err) {
      return {
        content: [
          {
            type: "text",
            text: formatToolError("suggesting indexes", err),
          },
        ],
      };
    }
  }
);

// --- Tool: analyze_slow_queries ---
server.tool(
  "analyze_slow_queries",
  "Find the slowest queries using pg_stat_statements (PostgreSQL) or performance_schema (MySQL). Shows execution times, call counts, and optimization recommendations.",
  {
    schema: z
      .string()
      .default("public")
      .describe("Database schema (default: public)"),
    limit: z
      .number()
      .default(10)
      .describe("Number of slow queries to return (default: 10)"),
    timeout_ms: timeoutParam,
  },
  async ({ schema, limit, timeout_ms }) => {
    applyTimeout(timeout_ms);
    try {
      const result = await analyzeSlowQueries(schema, limit);
      return { content: [{ type: "text", text: result }] };
    } catch (err) {
      return {
        content: [
          {
            type: "text",
            text: formatToolError("analyzing slow queries", err),
          },
        ],
      };
    }
  }
);

// Tool 7: analyze_connections
server.tool(
  "analyze_connections",
  "Analyze active database connections. Detects idle-in-transaction sessions, long-running queries, lock contention, and connection pool utilization. PostgreSQL and MySQL only.",
  {
    timeout_ms: timeoutParam,
  },
  async ({ timeout_ms }) => {
    applyTimeout(timeout_ms);
    try {
      const result = await analyzeConnections();
      return { content: [{ type: "text", text: result }] };
    } catch (err) {
      return {
        content: [
          {
            type: "text",
            text: formatToolError("analyzing connections", err),
          },
        ],
      };
    }
  }
);

// Tool 8: analyze_table_relationships
server.tool(
  "analyze_table_relationships",
  "Analyze foreign key relationships between tables. Builds a dependency graph showing entity connectivity, orphan tables (no FKs), cascading delete chains, and hub entities. Useful for understanding schema design and impact analysis.",
  {
    schema: z
      .string()
      .default("public")
      .describe("Database schema to analyze (default: public)"),
    timeout_ms: timeoutParam,
  },
  async ({ schema, timeout_ms }) => {
    applyTimeout(timeout_ms);
    try {
      const result = await analyzeTableRelationships(schema);
      return { content: [{ type: "text", text: result }] };
    } catch (err) {
      return {
        content: [
          {
            type: "text",
            text: formatToolError("analyzing relationships", err),
          },
        ],
      };
    }
  }
);

// --- Tool: analyze_vacuum ---
server.tool(
  "analyze_vacuum",
  "Analyze PostgreSQL VACUUM maintenance status. Checks dead tuple ratios, vacuum staleness, autovacuum configuration, and identifies tables needing manual VACUUM. PostgreSQL only.",
  {
    schema: z
      .string()
      .default("public")
      .describe("Database schema to analyze (default: public)"),
    timeout_ms: timeoutParam,
  },
  async ({ schema, timeout_ms }) => {
    applyTimeout(timeout_ms);
    try {
      const result = await analyzeVacuum(schema);
      return { content: [{ type: "text", text: result }] };
    } catch (err) {
      return {
        content: [
          {
            type: "text",
            text: formatToolError("analyzing vacuum status", err),
          },
        ],
      };
    }
  }
);

// --- Start server ---
async function main() {
  const driver = detectDriver();
  await initDriver(driver);
  console.error(`MCP DB Analyzer running on stdio (driver: ${driver})`);

  // Test database connectivity early — warn on stderr if unreachable
  try {
    const { query: testQuery } = await import("./db.js");
    await testQuery("SELECT 1");
    console.error("Database connection: OK");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const sanitized = msg.replace(/\/\/[^@]+@/g, "//****:****@");
    console.error(`WARNING: Database connection failed: ${sanitized}`);
    if (driver === "postgres") {
      console.error(
        "Configure via DATABASE_URL or PGHOST/PGPORT/PGUSER/PGPASSWORD/PGDATABASE environment variables."
      );
    } else if (driver === "mysql") {
      console.error(
        "Configure via DATABASE_URL or MYSQL_HOST/MYSQL_PORT/MYSQL_USER/MYSQL_PASSWORD/MYSQL_DATABASE environment variables."
      );
    } else {
      console.error(
        "Configure via DATABASE_URL, SQLITE_PATH, or DB_PATH environment variable."
      );
    }
    console.error(
      "The server will start, but tools will return errors until the database is reachable."
    );
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

// Graceful shutdown
process.on("SIGINT", async () => {
  await closePool();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  await closePool();
  process.exit(0);
});

main().catch((error) => {
  // Sanitize error to avoid leaking credentials from connection strings
  const msg = error instanceof Error ? error.message : String(error);
  const sanitized = msg.replace(/\/\/[^@]+@/g, "//****:****@");
  console.error("Fatal error:", sanitized);
  process.exit(1);
});
