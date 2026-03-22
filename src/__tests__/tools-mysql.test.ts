/**
 * MySQL-path unit tests for MCP DB Analyzer.
 *
 * The analyzeConnections() and analyzeSlowQueries() functions have
 * entirely different SQL for MySQL vs PostgreSQL. These tests verify
 * the MySQL-specific code paths that had zero coverage.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the db module with MySQL driver
vi.mock("../db.js", () => ({
  query: vi.fn(),
  queryUnsafe: vi.fn(),
  closePool: vi.fn(),
  getDriverType: vi.fn(() => "mysql"),
  initDriver: vi.fn(),
}));

import { query, getDriverType } from "../db.js";
import { analyzeSlowQueries } from "../analyzers/slow-queries.js";
import { analyzeConnections } from "../analyzers/connections.js";
import { analyzeTableBloat } from "../analyzers/bloat.js";
import { listTables, inspectTable } from "../analyzers/schema.js";
import { analyzeIndexUsage, findMissingIndexes } from "../analyzers/indexes.js";
import { suggestMissingIndexes } from "../analyzers/suggestions.js";

const mockQuery = vi.mocked(query);
const mockGetDriverType = vi.mocked(getDriverType);

beforeEach(() => {
  vi.clearAllMocks();
  mockGetDriverType.mockReturnValue("mysql");
});

// --- MySQL Connections ---

describe("analyzeConnections — MySQL path", () => {
  it("returns MySQL connection analysis header", async () => {
    mockQuery
      .mockResolvedValueOnce({
        rows: [
          { state: "Query", count: "5" },
          { state: "Sleep", count: "12" },
          { state: "Daemon", count: "3" },
        ],
      })
      .mockResolvedValueOnce({ rows: [] }); // long-running queries

    const result = await analyzeConnections();
    expect(result).toContain("## Connection Analysis (MySQL)");
    expect(result).toContain("### Connection States");
  });

  it("formats connection state table correctly", async () => {
    mockQuery
      .mockResolvedValueOnce({
        rows: [
          { state: "Query", count: "5" },
          { state: "Sleep", count: "12" },
        ],
      })
      .mockResolvedValueOnce({ rows: [] });

    const result = await analyzeConnections();
    expect(result).toContain("| Query | 5 |");
    expect(result).toContain("| Sleep | 12 |");
    expect(result).toContain("| **Total** | **17** |");
  });

  it("shows long-running queries when found", async () => {
    mockQuery
      .mockResolvedValueOnce({
        rows: [{ state: "Query", count: "3" }],
      })
      .mockResolvedValueOnce({
        rows: [
          { id: "42", user: "app_user", time: "65", state: "executing", info: "SELECT * FROM large_table WHERE status = ?" },
        ],
      });

    const result = await analyzeConnections();
    expect(result).toContain("### Long-Running Queries (> 30s)");
    expect(result).toContain("| 42 | app_user | 65 | executing |");
  });

  it("shows no issues message when no long queries", async () => {
    mockQuery
      .mockResolvedValueOnce({
        rows: [{ state: "Sleep", count: "2" }],
      })
      .mockResolvedValueOnce({ rows: [] });

    const result = await analyzeConnections();
    expect(result).toContain("No connection issues detected");
  });

  it("handles empty process list gracefully", async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    const result = await analyzeConnections();
    expect(result).toContain("## Connection Analysis (MySQL)");
    expect(result).toContain("| **Total** | **0** |");
  });
});

// --- MySQL Slow Queries ---

describe("analyzeSlowQueries — MySQL path", () => {
  it("returns MySQL slow query analysis header", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          DIGEST_TEXT: "SELECT * FROM users WHERE email = ?",
          COUNT_STAR: 150,
          SUM_TIMER_WAIT: 45000,
          AVG_TIMER_WAIT: 300,
          SUM_ROWS_EXAMINED: 15000,
          SUM_ROWS_SENT: 150,
        },
      ],
    });

    const result = await analyzeSlowQueries("public", 10);
    expect(result).toContain("## Slow Query Analysis (MySQL");
    expect(result).toContain("by avg execution time");
  });

  it("formats slow queries table correctly", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          DIGEST_TEXT: "SELECT * FROM users WHERE email = ?",
          COUNT_STAR: 150,
          SUM_TIMER_WAIT: 45000,
          AVG_TIMER_WAIT: 300.5,
          SUM_ROWS_EXAMINED: 15000,
          SUM_ROWS_SENT: 150,
        },
        {
          DIGEST_TEXT: "UPDATE orders SET status = ? WHERE id = ?",
          COUNT_STAR: 50,
          SUM_TIMER_WAIT: 10000,
          AVG_TIMER_WAIT: 200.3,
          SUM_ROWS_EXAMINED: 5000,
          SUM_ROWS_SENT: 0,
        },
      ],
    });

    const result = await analyzeSlowQueries("public", 10);
    expect(result).toContain("| 1 | 300.5ms |");
    expect(result).toContain("| 150 |");
    expect(result).toContain("| 2 | 200.3ms |");
  });

  it("returns no-data message when performance_schema is empty", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const result = await analyzeSlowQueries("public", 10);
    expect(result).toContain("No query statistics found");
    expect(result).toContain("performance_schema");
  });

  it("returns error message when performance_schema query fails", async () => {
    mockQuery.mockRejectedValueOnce(new Error("Access denied"));

    const result = await analyzeSlowQueries("public", 10);
    expect(result).toContain("Unable to query performance_schema");
  });

  it("truncates long DIGEST_TEXT to 80 chars", async () => {
    const longQuery = "SELECT " + "a".repeat(100) + " FROM very_long_table_name WHERE some_condition = ?";
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          DIGEST_TEXT: longQuery,
          COUNT_STAR: 10,
          SUM_TIMER_WAIT: 1000,
          AVG_TIMER_WAIT: 100,
          SUM_ROWS_EXAMINED: 100,
          SUM_ROWS_SENT: 10,
        },
      ],
    });

    const result = await analyzeSlowQueries("public", 10);
    expect(result).toContain("...");
    // Verify truncation — should be 77 chars + "..."
    expect(result).not.toContain(longQuery);
  });

  it("respects the limit parameter", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    await analyzeSlowQueries("public", 5);

    // Verify the limit was passed to the query
    const calls = mockQuery.mock.calls;
    expect(calls[0][1]).toEqual([5]);
  });

  it("escapes pipe characters in query text", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          DIGEST_TEXT: "SELECT col1 | col2 FROM flags",
          COUNT_STAR: 10,
          SUM_TIMER_WAIT: 1000,
          AVG_TIMER_WAIT: 100,
          SUM_ROWS_EXAMINED: 100,
          SUM_ROWS_SENT: 10,
        },
      ],
    });

    const result = await analyzeSlowQueries("public", 10);
    // Pipes should be escaped for markdown table
    expect(result).toContain("\\|");
  });
});

// --- MySQL slow query recommendations ---

describe("analyzeSlowQueries — MySQL recommendations", () => {
  it("detects high-impact queries (>100 calls, >100ms avg)", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          DIGEST_TEXT: "SELECT * FROM orders WHERE user_id = ?",
          COUNT_STAR: 500,
          SUM_TIMER_WAIT: 100000,
          AVG_TIMER_WAIT: 200,
          SUM_ROWS_EXAMINED: 50000,
          SUM_ROWS_SENT: 500,
        },
      ],
    });

    const result = await analyzeSlowQueries("public", 10);
    expect(result).toContain("### Recommendations");
    expect(result).toContain("high-impact queries");
    expect(result).toContain("Prioritize");
  });

  it("detects slow queries returning few rows (missing index candidates)", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          DIGEST_TEXT: "SELECT * FROM users WHERE email = ?",
          COUNT_STAR: 200,
          SUM_TIMER_WAIT: 20000,
          AVG_TIMER_WAIT: 100,
          SUM_ROWS_EXAMINED: 200000,
          SUM_ROWS_SENT: 200, // 1 row per call
        },
      ],
    });

    const result = await analyzeSlowQueries("public", 10);
    expect(result).toContain("### Recommendations");
    expect(result).toContain("few rows but slow");
    expect(result).toContain("missing indexes");
    expect(result).toContain("explain_query");
  });

  it("shows no-critical-patterns message when queries look healthy", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          DIGEST_TEXT: "SELECT id FROM users",
          COUNT_STAR: 10,
          SUM_TIMER_WAIT: 50,
          AVG_TIMER_WAIT: 5,
          SUM_ROWS_EXAMINED: 100,
          SUM_ROWS_SENT: 100,
        },
      ],
    });

    const result = await analyzeSlowQueries("public", 10);
    expect(result).toContain("### Recommendations");
    expect(result).toContain("No critical patterns detected");
  });
});

// --- SQLite fallback (verify routing) ---

describe("driver routing — SQLite fallback", () => {
  it("analyzeConnections returns not-available for SQLite", async () => {
    mockGetDriverType.mockReturnValue("sqlite");
    const result = await analyzeConnections();
    expect(result).toContain("not available for SQLite");
  });

  it("analyzeSlowQueries returns not-available for SQLite", async () => {
    mockGetDriverType.mockReturnValue("sqlite");
    const result = await analyzeSlowQueries("public", 10);
    expect(result).toContain("Not available for SQLite");
  });
});

// --- MySQL performance_schema error handling ---

describe("MySQL performance_schema disabled handling", () => {
  it("analyzeIndexUsage returns helpful error when performance_schema is disabled", async () => {
    mockGetDriverType.mockReturnValue("mysql");
    mockQuery.mockRejectedValueOnce(new Error("Table 'performance_schema.table_io_waits_summary_by_index_usage' doesn't exist"));

    const result = await analyzeIndexUsage("mydb");
    expect(result).toContain("Unable to query performance_schema");
    expect(result).toContain("performance_schema is enabled");
  });

  it("findMissingIndexes returns helpful error when performance_schema is disabled", async () => {
    mockGetDriverType.mockReturnValue("mysql");
    mockQuery.mockRejectedValueOnce(new Error("Access denied for user"));

    const result = await findMissingIndexes("mydb");
    expect(result).toContain("Unable to query performance_schema");
    expect(result).toContain("SELECT privilege");
  });

  it("suggestMissingIndexes returns helpful error when performance_schema is disabled", async () => {
    mockGetDriverType.mockReturnValue("mysql");
    mockQuery.mockRejectedValueOnce(new Error("performance_schema is disabled"));

    const result = await suggestMissingIndexes("mydb");
    expect(result).toContain("Unable to query performance_schema");
    expect(result).toContain("performance_schema is enabled");
  });
});
