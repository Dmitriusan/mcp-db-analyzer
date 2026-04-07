import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../db.js", () => ({
  query: vi.fn(),
  queryUnsafe: vi.fn(),
  closePool: vi.fn(),
  getDriverType: vi.fn(() => "postgres"),
  initDriver: vi.fn(),
}));

import { query, getDriverType } from "../db.js";
import { analyzeSlowQueries } from "../analyzers/slow-queries.js";
import { analyzeConnections } from "../analyzers/connections.js";
import { analyzeTableRelationships } from "../analyzers/relationships.js";

const mockQuery = vi.mocked(query);
const mockGetDriverType = vi.mocked(getDriverType);

beforeEach(() => {
  vi.clearAllMocks();
  mockGetDriverType.mockReturnValue("postgres");
});

describe("analyze_slow_queries — extended tests", () => {
  it("should handle MySQL driver", async () => {
    mockGetDriverType.mockReturnValue("mysql");
    // MySQL performance_schema returns uppercase column names
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          DIGEST_TEXT: "SELECT * FROM users WHERE id = ?",
          COUNT_STAR: 500,
          AVG_TIMER_WAIT: 150.5,
          SUM_TIMER_WAIT: 75250,
          SUM_ROWS_SENT: 500,
          SUM_ROWS_EXAMINED: 50000,
        },
      ],
    });

    const result = await analyzeSlowQueries("public", 10);
    expect(result).toContain("Slow Query Analysis (MySQL");
    expect(result).toContain("150.5ms");
    expect(result).toContain("SELECT * FROM users WHERE id = ?");
  });

  it("should handle queries with very high mean times", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ extname: "pg_stat_statements" }] });
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          query: "SELECT * FROM huge_table",
          calls: 10,
          total_exec_time: 600000, // 600 seconds total
          mean_exec_time: 60000.0, // 60 seconds each
          min_exec_time: 50000.0,
          max_exec_time: 90000.0,
          rows: 10000000,
        },
      ],
    });

    const result = await analyzeSlowQueries("public", 10);
    expect(result).toContain("60000.0ms");
    expect(result).toContain("Slow Query Analysis");
  });
});

describe("analyze_connections — extended tests", () => {
  it("should handle MySQL connections", async () => {
    mockGetDriverType.mockReturnValue("mysql");
    // Process list
    mockQuery.mockResolvedValueOnce({
      rows: [
        { state: "Query", count: "5" },
        { state: "Sleep", count: "20" },
      ],
    });
    // max_connections
    mockQuery.mockResolvedValueOnce({ rows: [{ max_connections: "151" }] });
    // Long-running
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const result = await analyzeConnections();
    expect(result).toContain("Connection Analysis (MySQL)");
    expect(result).toContain("| Query | 5 |");
    expect(result).toContain("| Sleep | 20 |");
    expect(result).toContain("**Total** | **25**");
  });

  it("should show long-running queries and blocked connections together", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ state: "active", count: "10" }],
    });
    mockQuery.mockResolvedValueOnce({ rows: [{ setting: "100" }] });
    mockQuery.mockResolvedValueOnce({ rows: [] }); // no idle txn
    // Long-running query
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          pid: "5678",
          usename: "analytics",
          duration: "00:15:00",
          wait_event_type: "IO",
          query: "SELECT * FROM events WHERE ...",
        },
      ],
    });
    // Blocked connection
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          blocked_pid: "1111",
          blocking_pid: "2222",
          blocked_query: "UPDATE users SET ...",
          blocking_query: "ALTER TABLE users ...",
        },
      ],
    });

    const result = await analyzeConnections();
    expect(result).toContain("Long-Running Queries");
    expect(result).toContain("5678");
    expect(result).toContain("IO");
    expect(result).toContain("Blocked Connections");
    expect(result).toContain("1111");
    expect(result).toContain("2222");
    expect(result).toContain("statement_timeout");
    expect(result).toContain("pg_terminate_backend");
  });

  it("should handle zero connections gracefully", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    mockQuery.mockResolvedValueOnce({ rows: [{ setting: "100" }] });
    mockQuery.mockResolvedValueOnce({ rows: [] });
    mockQuery.mockResolvedValueOnce({ rows: [] });
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const result = await analyzeConnections();
    expect(result).toContain("**Total** | **0**");
    expect(result).toContain("0.0%");
    expect(result).toContain("No connection issues detected");
  });
});

describe("analyze_table_relationships — extended tests", () => {
  it("should detect self-referencing FK", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ table_name: "categories" }],
    });
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          source_table: "categories",
          source_column: "parent_id",
          target_table: "categories",
          target_column: "id",
          constraint_name: "fk_parent",
          on_delete: "SET NULL",
          on_update: "NO ACTION",
        },
      ],
    });

    const result = await analyzeTableRelationships("public");
    expect(result).toContain("categories");
    expect(result).toContain("parent_id");
  });

  it("should handle many-to-many junction tables", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        { table_name: "users" },
        { table_name: "roles" },
        { table_name: "user_roles" },
      ],
    });
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          source_table: "user_roles",
          source_column: "user_id",
          target_table: "users",
          target_column: "id",
          constraint_name: "fk_ur_user",
          on_delete: "CASCADE",
          on_update: "NO ACTION",
        },
        {
          source_table: "user_roles",
          source_column: "role_id",
          target_table: "roles",
          target_column: "id",
          constraint_name: "fk_ur_role",
          on_delete: "CASCADE",
          on_update: "NO ACTION",
        },
      ],
    });

    const result = await analyzeTableRelationships("public");
    expect(result).toContain("user_roles");
    expect(result).toContain("users");
    expect(result).toContain("roles");
  });

  it("should handle MySQL driver", async () => {
    mockGetDriverType.mockReturnValue("mysql");
    mockQuery.mockResolvedValueOnce({
      rows: [{ TABLE_NAME: "users" }, { TABLE_NAME: "orders" }],
    });
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          TABLE_NAME: "orders",
          COLUMN_NAME: "user_id",
          REFERENCED_TABLE_NAME: "users",
          REFERENCED_COLUMN_NAME: "id",
          CONSTRAINT_NAME: "fk_user",
          DELETE_RULE: "CASCADE",
          UPDATE_RULE: "NO ACTION",
        },
      ],
    });

    const result = await analyzeTableRelationships("public");
    expect(result).toContain("Table Relationships");
  });

  it("should handle schema with no FK relationships at all", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        { table_name: "users" },
        { table_name: "logs" },
        { table_name: "config" },
      ],
    });
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const result = await analyzeTableRelationships("public");
    expect(result).toContain("Orphan Tables");
    // All tables should be orphans
    expect(result).toContain("users");
    expect(result).toContain("logs");
    expect(result).toContain("config");
  });
});

describe("analyze_connections — MySQL long-running", () => {
  it("should show long-running MySQL queries", async () => {
    mockGetDriverType.mockReturnValue("mysql");
    mockQuery.mockResolvedValueOnce({
      rows: [{ state: "Query", count: "3" }],
    });
    // max_connections
    mockQuery.mockResolvedValueOnce({ rows: [{ max_connections: "151" }] });
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          id: "42",
          user: "app",
          time: "120",
          state: "Sending data",
          info: "SELECT * FROM large_table",
        },
      ],
    });

    const result = await analyzeConnections();
    expect(result).toContain("Long-Running Queries");
    expect(result).toContain("42");
    expect(result).toContain("120");
    expect(result).toContain("Sending data");
  });

  it("should render null INFO column as dash", async () => {
    mockGetDriverType.mockReturnValue("mysql");
    mockQuery.mockResolvedValueOnce({
      rows: [{ state: "Query", count: "1" }],
    });
    // max_connections
    mockQuery.mockResolvedValueOnce({ rows: [{ max_connections: "151" }] });
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          id: "99",
          user: "root",
          time: "45",
          state: "Locked",
          info: null,
        },
      ],
    });

    const result = await analyzeConnections();
    expect(result).toContain("Long-Running Queries");
    expect(result).toContain("99");
    expect(result).not.toContain("null");
    expect(result).toMatch(/\|\s*-\s*\|/);
  });
});

describe("analyze_table_relationships — cycle detection", () => {
  it("should detect a 3-table circular FK dependency (A→B→C→A)", async () => {
    // tables: a, b, c with FKs a→b, b→c, c→a
    mockQuery.mockResolvedValueOnce({
      rows: [{ table_name: "a" }, { table_name: "b" }, { table_name: "c" }],
    });
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          source_table: "a",
          source_column: "b_id",
          target_table: "b",
          target_column: "id",
          constraint_name: "fk_a_b",
          on_delete: "NO ACTION",
          on_update: "NO ACTION",
        },
        {
          source_table: "b",
          source_column: "c_id",
          target_table: "c",
          target_column: "id",
          constraint_name: "fk_b_c",
          on_delete: "NO ACTION",
          on_update: "NO ACTION",
        },
        {
          source_table: "c",
          source_column: "a_id",
          target_table: "a",
          target_column: "id",
          constraint_name: "fk_c_a",
          on_delete: "NO ACTION",
          on_update: "NO ACTION",
        },
      ],
    });

    const result = await analyzeTableRelationships("public");
    expect(result).toContain("Circular FK Dependencies");
    expect(result).toContain("→");
    // All three tables should appear in the cycle output
    expect(result).toMatch(/Circular FK Dependencies[\s\S]*\ba\b[\s\S]*\bb\b/);
    expect(result).toContain("circular FK reference");
  });

  it("should detect a self-referential FK cycle (categories→categories)", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ table_name: "categories" }],
    });
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          source_table: "categories",
          source_column: "parent_id",
          target_table: "categories",
          target_column: "id",
          constraint_name: "fk_self",
          on_delete: "SET NULL",
          on_update: "NO ACTION",
        },
      ],
    });

    const result = await analyzeTableRelationships("public");
    expect(result).toContain("Circular FK Dependencies");
    expect(result).toContain("categories → categories");
  });

  it("should not report circular dependencies when none exist", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ table_name: "users" }, { table_name: "orders" }, { table_name: "items" }],
    });
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          source_table: "orders",
          source_column: "user_id",
          target_table: "users",
          target_column: "id",
          constraint_name: "fk_order_user",
          on_delete: "CASCADE",
          on_update: "NO ACTION",
        },
        {
          source_table: "items",
          source_column: "order_id",
          target_table: "orders",
          target_column: "id",
          constraint_name: "fk_item_order",
          on_delete: "CASCADE",
          on_update: "NO ACTION",
        },
      ],
    });

    const result = await analyzeTableRelationships("public");
    expect(result).not.toContain("Circular FK Dependencies");
  });

  it("should show cascade chain at full depth (4-level chain users→orders→items→line_items)", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        { table_name: "users" },
        { table_name: "orders" },
        { table_name: "items" },
        { table_name: "line_items" },
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
          source_table: "items",
          source_column: "order_id",
          target_table: "orders",
          target_column: "id",
          constraint_name: "fk_items_order",
          on_delete: "CASCADE",
          on_update: "NO ACTION",
        },
        {
          source_table: "line_items",
          source_column: "item_id",
          target_table: "items",
          target_column: "id",
          constraint_name: "fk_line_items_item",
          on_delete: "CASCADE",
          on_update: "NO ACTION",
        },
      ],
    });

    const result = await analyzeTableRelationships("public");
    expect(result).toContain("Cascading Delete Chains");
    // Full chain: users → orders → items → line_items must all appear
    expect(result).toContain("users");
    expect(result).toContain("orders");
    expect(result).toContain("items");
    expect(result).toContain("line_items");
    // Ensure it's not capped at 2 levels — line_items must appear under the cascade section
    const cascadeSection = result.slice(result.indexOf("Cascading Delete Chains"));
    expect(cascadeSection).toContain("line_items");
  });
});
