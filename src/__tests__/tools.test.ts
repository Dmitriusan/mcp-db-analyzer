import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the db module before importing analyzers
vi.mock("../db.js", () => ({
  query: vi.fn(),
  queryUnsafe: vi.fn(),
  closePool: vi.fn(),
  getDriverType: vi.fn(() => "postgres"),
  initDriver: vi.fn(),
}));

import { query, queryUnsafe, getDriverType } from "../db.js";
import { listTables, inspectTable } from "../analyzers/schema.js";
import { analyzeIndexUsage, findMissingIndexes } from "../analyzers/indexes.js";
import { explainQuery } from "../analyzers/query.js";
import { analyzeTableBloat } from "../analyzers/bloat.js";
import { suggestMissingIndexes } from "../analyzers/suggestions.js";
import { analyzeSlowQueries } from "../analyzers/slow-queries.js";
import { analyzeConnections } from "../analyzers/connections.js";
import { analyzeTableRelationships } from "../analyzers/relationships.js";

const mockQuery = vi.mocked(query);
const mockQueryUnsafe = vi.mocked(queryUnsafe);
const mockGetDriverType = vi.mocked(getDriverType);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("Tool Registration", () => {
  it("should export all 5 analyzer functions", () => {
    expect(typeof listTables).toBe("function");
    expect(typeof inspectTable).toBe("function");
    expect(typeof analyzeIndexUsage).toBe("function");
    expect(typeof findMissingIndexes).toBe("function");
    expect(typeof explainQuery).toBe("function");
    expect(typeof analyzeTableBloat).toBe("function");
    expect(typeof suggestMissingIndexes).toBe("function");
  });
});

describe("inspect_schema — listTables", () => {
  it("should return formatted markdown table with row counts", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        { table_name: "users", table_schema: "public", row_estimate: "1500", total_size: "256 kB" },
        { table_name: "orders", table_schema: "public", row_estimate: "500", total_size: "128 kB" },
      ],
    });

    const result = await listTables("public");
    expect(result).toContain("## Tables in schema 'public'");
    expect(result).toContain("| users | 1500 | 256 kB |");
    expect(result).toContain("| orders | 500 | 128 kB |");
  });

  it("should return message when no tables found", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const result = await listTables("empty_schema");
    expect(result).toContain("No tables found");
  });
});

describe("analyze_indexes — analyzeIndexUsage", () => {
  it("should identify unused indexes with zero scans", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          table_name: "users",
          index_name: "idx_users_old",
          index_size: "16 kB",
          idx_scan: "0",
          idx_tup_read: "0",
          idx_tup_fetch: "0",
          index_def: "CREATE INDEX idx_users_old ON users USING btree (old_col)",
        },
        {
          table_name: "orders",
          index_name: "idx_orders_status",
          index_size: "32 kB",
          idx_scan: "5000",
          idx_tup_read: "12000",
          idx_tup_fetch: "11000",
          index_def: "CREATE INDEX idx_orders_status ON orders USING btree (status)",
        },
      ],
    });

    const result = await analyzeIndexUsage("public");
    expect(result).toContain("Unused Indexes (1 found)");
    expect(result).toContain("idx_users_old");
    expect(result).toContain("All Indexes by Scan Count");
  });
});

describe("explain_query", () => {
  it("should return error for empty SQL string", async () => {
    const result = await explainQuery("", false);
    expect(result).toContain("SQL query cannot be empty");
    expect(mockQueryUnsafe).not.toHaveBeenCalled();
  });

  it("should return error for whitespace-only SQL", async () => {
    const result = await explainQuery("   \n\t  ", false);
    expect(result).toContain("SQL query cannot be empty");
    expect(mockQueryUnsafe).not.toHaveBeenCalled();
  });

  it("should reject DML in analyze mode", async () => {
    const result = await explainQuery("DELETE FROM users", true);
    expect(result).toContain("only allowed on pure SELECT");
  });

  it("should not reject SELECT with DML keyword in a string literal", async () => {
    // A legitimate query whose WHERE clause contains a string value that happens
    // to include a DML keyword — must not be blocked.
    mockQueryUnsafe.mockResolvedValueOnce({
      rows: [
        {
          "QUERY PLAN": [
            {
              Plan: {
                "Node Type": "Seq Scan",
                "Relation Name": "audit_log",
                "Startup Cost": 0.0,
                "Total Cost": 12.5,
                "Plan Rows": 1,
                "Plan Width": 64,
              },
              "Planning Time": 0.1,
              "Execution Time": 0.2,
            },
          ],
        },
      ],
    });

    const result = await explainQuery(
      "SELECT * FROM audit_log WHERE action = 'DELETE user record'",
      true
    );
    expect(result).not.toContain("only allowed on pure SELECT");
    expect(result).toContain("Query Plan Analysis");
  });

  it("should format query plan with cost estimates", async () => {
    mockQueryUnsafe.mockResolvedValueOnce({
      rows: [
        {
          "QUERY PLAN": [
            {
              Plan: {
                "Node Type": "Seq Scan",
                "Relation Name": "users",
                "Startup Cost": 0.0,
                "Total Cost": 35.5,
                "Plan Rows": 2550,
                "Plan Width": 36,
              },
              "Planning Time": 0.1,
              "Execution Time": 0.5,
            },
          ],
        },
      ],
    });

    const result = await explainQuery("SELECT * FROM users", false);
    expect(result).toContain("Query Plan Analysis");
    expect(result).toContain("Seq Scan");
    expect(result).toContain("users");
    expect(result).toContain("cost=0..35.5");
  });

  it("should detect stale statistics when actual rows far exceed estimate (overestimate)", async () => {
    mockQueryUnsafe.mockResolvedValueOnce({
      rows: [
        {
          "QUERY PLAN": [
            {
              Plan: {
                "Node Type": "Index Scan",
                "Relation Name": "events",
                "Startup Cost": 0.4,
                "Total Cost": 8.5,
                "Plan Rows": 1,
                "Plan Width": 48,
                "Actual Startup Time": 0.1,
                "Actual Total Time": 25.0,
                "Actual Rows": 50000,
                "Actual Loops": 1,
              },
              "Planning Time": 0.5,
              "Execution Time": 25.0,
            },
          ],
        },
      ],
    });

    const result = await explainQuery("SELECT * FROM events WHERE created_at > $1", true);
    expect(result).toContain("Stale statistics");
    expect(result).toContain("events");
    expect(result).toContain("ANALYZE");
  });

  it("should detect stale statistics when actual rows far below estimate (underestimate)", async () => {
    mockQueryUnsafe.mockResolvedValueOnce({
      rows: [
        {
          "QUERY PLAN": [
            {
              Plan: {
                "Node Type": "Seq Scan",
                "Relation Name": "products",
                "Startup Cost": 0.0,
                "Total Cost": 1200.0,
                "Plan Rows": 80000,
                "Plan Width": 120,
                "Actual Startup Time": 0.1,
                "Actual Total Time": 3.2,
                "Actual Rows": 100,
                "Actual Loops": 1,
              },
              "Planning Time": 0.3,
              "Execution Time": 3.2,
            },
          ],
        },
      ],
    });

    const result = await explainQuery("SELECT * FROM products WHERE discontinued = true", true);
    expect(result).toContain("Stale statistics");
    expect(result).toContain("products");
    expect(result).toContain("ANALYZE");
  });

  it("should detect stale statistics when planner estimates 0 rows but actual > 0", async () => {
    mockQueryUnsafe.mockResolvedValueOnce({
      rows: [
        {
          "QUERY PLAN": [
            {
              Plan: {
                "Node Type": "Index Scan",
                "Relation Name": "sessions",
                "Startup Cost": 0.4,
                "Total Cost": 1.0,
                "Plan Rows": 0,
                "Plan Width": 32,
                "Actual Startup Time": 0.1,
                "Actual Total Time": 2.5,
                "Actual Rows": 4200,
                "Actual Loops": 1,
              },
              "Planning Time": 0.2,
              "Execution Time": 2.5,
            },
          ],
        },
      ],
    });

    const result = await explainQuery("SELECT * FROM sessions WHERE token = $1", true);
    expect(result).toContain("Stale statistics");
    expect(result).toContain("sessions");
    expect(result).toContain("0 rows");
    expect(result).toContain("4200");
    expect(result).toContain("ANALYZE");
  });

  it("should not warn about statistics when actual vs estimated rows are close", async () => {
    mockQueryUnsafe.mockResolvedValueOnce({
      rows: [
        {
          "QUERY PLAN": [
            {
              Plan: {
                "Node Type": "Index Scan",
                "Relation Name": "users",
                "Startup Cost": 0.4,
                "Total Cost": 5.0,
                "Plan Rows": 100,
                "Plan Width": 64,
                "Actual Startup Time": 0.05,
                "Actual Total Time": 0.8,
                "Actual Rows": 95,
                "Actual Loops": 1,
              },
              "Planning Time": 0.2,
              "Execution Time": 0.9,
            },
          ],
        },
      ],
    });

    const result = await explainQuery("SELECT * FROM users WHERE active = true", true);
    expect(result).not.toContain("Stale statistics");
  });
});

describe("analyze_table_bloat", () => {
  it("should flag tables with >10% dead tuples", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          table_name: "audit_log",
          n_live_tup: "8000",
          n_dead_tup: "2000",
          table_size: "10 MB",
          last_vacuum: null,
          last_autovacuum: null,
          last_analyze: null,
        },
        {
          table_name: "users",
          n_live_tup: "1000",
          n_dead_tup: "10",
          table_size: "256 kB",
          last_vacuum: "2026-03-05 12:00:00",
          last_autovacuum: null,
          last_analyze: "2026-03-05 12:00:00",
        },
      ],
    });

    const result = await analyzeTableBloat("public");
    expect(result).toContain("Tables Needing VACUUM (1 found)");
    expect(result).toContain("audit_log");
    expect(result).toContain("20.0%");
    expect(result).toContain("VACUUM ANALYZE");
  });

  it("should report no bloat when all tables are healthy", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          table_name: "users",
          n_live_tup: "1000",
          n_dead_tup: "5",
          table_size: "256 kB",
          last_vacuum: "2026-03-05",
          last_autovacuum: null,
          last_analyze: "2026-03-05",
        },
      ],
    });

    const result = await analyzeTableBloat("public");
    expect(result).toContain("No significant bloat detected");
  });
});

describe("suggest_missing_indexes", () => {
  it("should flag tables with high seq_scans and no idx_scans", async () => {
    // First query: tables needing indexes
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          table_name: "events",
          seq_scan: "5000",
          idx_scan: "0",
          n_live_tup: "50000",
          table_size: "25 MB",
        },
      ],
    });
    // Second query: unused indexes
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          table_name: "users",
          index_name: "idx_users_legacy",
          index_size: "8 kB",
          index_def: "CREATE INDEX idx_users_legacy ON users USING btree (legacy_col)",
        },
      ],
    });

    const result = await suggestMissingIndexes("public");
    expect(result).toContain("Tables Missing Indexes (1 found)");
    expect(result).toContain("events");
    expect(result).toContain("5000");
    expect(result).toContain("Unused Indexes (1 found)");
    expect(result).toContain("idx_users_legacy");
    expect(result).toContain("DROP INDEX");
  });
});

describe("Markdown output formatting", () => {
  it("listTables output includes proper markdown table headers", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ table_name: "t", table_schema: "public", row_estimate: "1", total_size: "8 kB" }],
    });

    const result = await listTables();
    expect(result).toContain("| Table | Rows (est.) | Total Size |");
    expect(result).toContain("|-------|-------------|------------|");
  });
});

describe("analyze_slow_queries", () => {
  it("should return unavailable message for SQLite", async () => {
    mockGetDriverType.mockReturnValue("sqlite");
    const result = await analyzeSlowQueries("public", 10);
    expect(result).toContain("Not available for SQLite");
  });

  it("should prompt to install pg_stat_statements when not available", async () => {
    mockGetDriverType.mockReturnValue("postgres");
    mockQuery.mockResolvedValueOnce({ rows: [] }); // extCheck returns nothing
    const result = await analyzeSlowQueries("public", 10);
    expect(result).toContain("pg_stat_statements extension not installed");
    expect(result).toContain("CREATE EXTENSION pg_stat_statements");
    expect(result).toContain("shared_preload_libraries");
  });

  it("should display slow queries table with recommendations", async () => {
    mockGetDriverType.mockReturnValue("postgres");
    // Extension check passes
    mockQuery.mockResolvedValueOnce({ rows: [{ extname: "pg_stat_statements" }] });
    // Slow queries result
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          query: "SELECT * FROM orders WHERE status = $1",
          calls: 5000,
          total_exec_time: 750000,
          mean_exec_time: 150.0,
          min_exec_time: 10.0,
          max_exec_time: 500.0,
          rows: 25000,
        },
        {
          query: "SELECT u.* FROM users u JOIN orders o ON u.id = o.user_id",
          calls: 200,
          total_exec_time: 40000,
          mean_exec_time: 200.0,
          min_exec_time: 50.0,
          max_exec_time: 1000.0,
          rows: 400,
        },
      ],
    });

    const result = await analyzeSlowQueries("public", 10);
    expect(result).toContain("Slow Query Analysis");
    expect(result).toContain("150.0ms");
    expect(result).toContain("5000");
    expect(result).toContain("high-impact queries");
  });

  it("should report no stats when queries are empty", async () => {
    mockGetDriverType.mockReturnValue("postgres");
    mockQuery.mockResolvedValueOnce({ rows: [{ extname: "pg_stat_statements" }] });
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const result = await analyzeSlowQueries("public", 10);
    expect(result).toContain("No query statistics found");
  });

  it("should detect missing-index candidates (slow queries returning few rows)", async () => {
    mockGetDriverType.mockReturnValue("postgres");
    mockQuery.mockResolvedValueOnce({ rows: [{ extname: "pg_stat_statements" }] });
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          query: "SELECT * FROM users WHERE email = $1",
          calls: 1000,
          total_exec_time: 80000,
          mean_exec_time: 80.0,
          min_exec_time: 20.0,
          max_exec_time: 300.0,
          rows: 1000, // 1 row per call — likely missing index
        },
      ],
    });

    const result = await analyzeSlowQueries("public", 10);
    expect(result).toContain("queries returning few rows but slow");
    expect(result).toContain("missing indexes");
  });
});

describe("analyze_table_relationships", () => {
  it("should detect orphan tables with no FK relationships", async () => {
    mockGetDriverType.mockReturnValue("postgres");
    // Tables query
    mockQuery.mockResolvedValueOnce({
      rows: [
        { table_name: "users" },
        { table_name: "audit_log" },
        { table_name: "orders" },
      ],
    });
    // FK query - only users→orders relationship, audit_log is orphan
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          source_table: "orders",
          source_column: "user_id",
          target_table: "users",
          target_column: "id",
          constraint_name: "fk_orders_user",
          on_delete: "RESTRICT",
          on_update: "NO ACTION",
        },
      ],
    });

    const result = await analyzeTableRelationships("public");
    expect(result).toContain("Orphan Tables");
    expect(result).toContain("audit_log");
    expect(result).toContain("Foreign Key Map");
    expect(result).toContain("orders");
    expect(result).toContain("users");
  });

  it("should detect cascading delete chains", async () => {
    mockGetDriverType.mockReturnValue("postgres");
    mockQuery.mockResolvedValueOnce({
      rows: [
        { table_name: "users" },
        { table_name: "orders" },
        { table_name: "order_items" },
      ],
    });
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          source_table: "orders",
          source_column: "user_id",
          target_table: "users",
          target_column: "id",
          constraint_name: "fk_orders_user",
          on_delete: "CASCADE",
          on_update: "NO ACTION",
        },
        {
          source_table: "order_items",
          source_column: "order_id",
          target_table: "orders",
          target_column: "id",
          constraint_name: "fk_items_order",
          on_delete: "CASCADE",
          on_update: "NO ACTION",
        },
      ],
    });

    const result = await analyzeTableRelationships("public");
    expect(result).toContain("Cascading Delete");
    expect(result).toContain("users");
    expect(result).toContain("cascades to");
    expect(result).toContain("further cascades");
    expect(result).toContain("WARNING");
  });

  it("should show entity connectivity and hub detection", async () => {
    mockGetDriverType.mockReturnValue("postgres");
    // Hub table with 5+ connections
    mockQuery.mockResolvedValueOnce({
      rows: [
        { table_name: "users" },
        { table_name: "orders" },
        { table_name: "reviews" },
        { table_name: "addresses" },
        { table_name: "payments" },
        { table_name: "notifications" },
      ],
    });
    mockQuery.mockResolvedValueOnce({
      rows: [
        { source_table: "orders", source_column: "user_id", target_table: "users", target_column: "id", constraint_name: "fk1", on_delete: "RESTRICT", on_update: "NO ACTION" },
        { source_table: "reviews", source_column: "user_id", target_table: "users", target_column: "id", constraint_name: "fk2", on_delete: "RESTRICT", on_update: "NO ACTION" },
        { source_table: "addresses", source_column: "user_id", target_table: "users", target_column: "id", constraint_name: "fk3", on_delete: "RESTRICT", on_update: "NO ACTION" },
        { source_table: "payments", source_column: "user_id", target_table: "users", target_column: "id", constraint_name: "fk4", on_delete: "RESTRICT", on_update: "NO ACTION" },
        { source_table: "notifications", source_column: "user_id", target_table: "users", target_column: "id", constraint_name: "fk5", on_delete: "RESTRICT", on_update: "NO ACTION" },
      ],
    });

    const result = await analyzeTableRelationships("public");
    expect(result).toContain("hub");
    expect(result).toContain("Entity Connectivity");
  });

  it("should handle no tables", async () => {
    mockGetDriverType.mockReturnValue("postgres");
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const result = await analyzeTableRelationships("public");
    expect(result).toContain("No tables found");
  });

  it("should handle SQLite", async () => {
    mockGetDriverType.mockReturnValue("sqlite");
    // Tables
    mockQuery.mockResolvedValueOnce({
      rows: [{ name: "users" }, { name: "orders" }],
    });
    // FK list for users
    mockQuery.mockResolvedValueOnce({ rows: [] });
    // FK list for orders
    mockQuery.mockResolvedValueOnce({
      rows: [
        { id: 0, seq: 0, table: "users", from: "user_id", to: "id", on_delete: "CASCADE", on_update: "NO ACTION" },
      ],
    });

    const result = await analyzeTableRelationships("public");
    expect(result).toContain("Table Relationships");
    expect(result).toContain("orders");
    expect(result).toContain("users");
  });

  it("should handle SQLite with no FK relationships", async () => {
    mockGetDriverType.mockReturnValue("sqlite");
    mockQuery.mockResolvedValueOnce({
      rows: [{ name: "config" }, { name: "metadata" }],
    });
    // No FKs for either table
    mockQuery.mockResolvedValueOnce({ rows: [] });
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const result = await analyzeTableRelationships("public");
    expect(result).toContain("Table Relationships");
    expect(result).toContain("Orphan Tables");
    expect(result).toContain("config");
    expect(result).toContain("metadata");
  });
});

describe("connection error handling", () => {
  it("should provide helpful error when query fails with connection error", async () => {
    mockQuery.mockRejectedValueOnce(
      new Error("connect ECONNREFUSED 127.0.0.1:5432")
    );

    await expect(listTables("public")).rejects.toThrow("ECONNREFUSED");
  });

  it("should propagate errors through tool handlers", async () => {
    mockQuery.mockRejectedValueOnce(
      new Error("password authentication failed for user \"postgres\"")
    );

    await expect(listTables("public")).rejects.toThrow(
      "password authentication failed"
    );
  });
});

describe("analyze_connections", () => {
  it("should return unavailable for SQLite", async () => {
    mockGetDriverType.mockReturnValue("sqlite");
    const result = await analyzeConnections();
    expect(result).toContain("not available for SQLite");
  });

  it("should show connection states and max connections for PostgreSQL", async () => {
    mockGetDriverType.mockReturnValue("postgres");
    // Connection summary
    mockQuery.mockResolvedValueOnce({
      rows: [
        { state: "active", count: "3" },
        { state: "idle", count: "12" },
        { state: "idle in transaction", count: "2" },
      ],
    });
    // Max connections
    mockQuery.mockResolvedValueOnce({ rows: [{ setting: "100" }] });
    // Idle-in-transaction
    mockQuery.mockResolvedValueOnce({
      rows: [
        { pid: "1234", usename: "app", state: "idle in transaction", duration: "00:05:30", query: "UPDATE orders SET status = $1" },
      ],
    });
    // Long-running queries
    mockQuery.mockResolvedValueOnce({ rows: [] });
    // Blocked connections
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const result = await analyzeConnections();
    expect(result).toContain("Connection Analysis (PostgreSQL)");
    expect(result).toContain("| active | 3 |");
    expect(result).toContain("| idle | 12 |");
    expect(result).toContain("**Total** | **17**");
    expect(result).toContain("**Max connections**: 100");
    expect(result).toContain("17.0%");
    expect(result).toContain("Idle-in-Transaction");
    expect(result).toContain("1234");
    expect(result).toContain("idle_in_transaction_session_timeout");
  });

  it("should warn when connection pool utilization exceeds 80%", async () => {
    mockGetDriverType.mockReturnValue("postgres");
    mockQuery.mockResolvedValueOnce({
      rows: [{ state: "active", count: "85" }],
    });
    mockQuery.mockResolvedValueOnce({ rows: [{ setting: "100" }] });
    mockQuery.mockResolvedValueOnce({ rows: [] }); // no idle txn
    mockQuery.mockResolvedValueOnce({ rows: [] }); // no long queries
    mockQuery.mockResolvedValueOnce({ rows: [] }); // no blocked

    const result = await analyzeConnections();
    expect(result).toContain("WARNING");
    expect(result).toContain("85.0%");
    expect(result).toContain("PgBouncer");
  });

  it("should escape pipe characters in query text to avoid breaking markdown tables", async () => {
    mockGetDriverType.mockReturnValue("postgres");
    mockQuery.mockResolvedValueOnce({
      rows: [{ state: "idle in transaction", count: "1" }],
    });
    mockQuery.mockResolvedValueOnce({ rows: [{ setting: "100" }] });
    // Idle-in-transaction connection whose query text contains a pipe
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          pid: "5678",
          usename: "app",
          state: "idle in transaction",
          duration: "00:01:00",
          query: "SELECT a || b FROM t WHERE x | y = 1",
        },
      ],
    });
    mockQuery.mockResolvedValueOnce({ rows: [] }); // long queries
    mockQuery.mockResolvedValueOnce({ rows: [] }); // blocked

    const result = await analyzeConnections();
    // Pipe characters in query text must be escaped so the markdown table stays valid
    expect(result).toContain("\\|");
    // The query content still appears (just with escaped pipes)
    expect(result).toContain("SELECT a");
  });

  it("should report no issues when connections are healthy", async () => {
    mockGetDriverType.mockReturnValue("postgres");
    mockQuery.mockResolvedValueOnce({
      rows: [{ state: "active", count: "2" }, { state: "idle", count: "5" }],
    });
    mockQuery.mockResolvedValueOnce({ rows: [{ setting: "100" }] });
    mockQuery.mockResolvedValueOnce({ rows: [] }); // no idle txn
    mockQuery.mockResolvedValueOnce({ rows: [] }); // no long queries
    mockQuery.mockResolvedValueOnce({ rows: [] }); // no blocked

    const result = await analyzeConnections();
    expect(result).toContain("No connection issues detected");
  });
});

describe("find_missing_indexes — unindexed FK detection", () => {
  it("should report unindexed foreign keys", async () => {
    mockGetDriverType.mockReturnValue("postgres");
    // First query: sequential scan stats (empty — no seq scan issues)
    mockQuery.mockResolvedValueOnce({ rows: [] });
    // Second query: unindexed FK check
    mockQuery.mockResolvedValueOnce({
      rows: [
        { table_name: "orders", column_name: "user_id", constraint_name: "fk_orders_user", foreign_table: "users" },
      ],
    });

    const result = await findMissingIndexes("public");
    expect(result).toContain("Unindexed Foreign Keys");
    expect(result).toContain("orders");
    expect(result).toContain("user_id");
    expect(result).toContain("users");
  });

  it("should not report FKs that have indexes", async () => {
    mockGetDriverType.mockReturnValue("postgres");
    mockQuery.mockResolvedValueOnce({ rows: [] }); // seq scan stats
    mockQuery.mockResolvedValueOnce({ rows: [] }); // no unindexed FKs

    const result = await findMissingIndexes("public");
    expect(result).not.toContain("Unindexed Foreign Keys");
  });

  it("should use word-boundary regex instead of LIKE substring match", async () => {
    mockGetDriverType.mockReturnValue("postgres");
    mockQuery.mockResolvedValueOnce({ rows: [] }); // seq scan stats
    mockQuery.mockResolvedValueOnce({ rows: [] }); // unindexed FKs

    await findMissingIndexes("public");

    // Verify the FK query uses word-boundary regex (\\m...\\M) not LIKE
    const fkQueryCall = mockQuery.mock.calls[1];
    const sql = fkQueryCall[0] as string;
    expect(sql).toContain("\\m");
    expect(sql).toContain("\\M");
    expect(sql).not.toContain("LIKE");
  });
});
