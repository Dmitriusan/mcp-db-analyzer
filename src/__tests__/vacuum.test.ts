import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../db.js", () => ({
  query: vi.fn(),
  queryUnsafe: vi.fn(),
  closePool: vi.fn(),
  getDriverType: vi.fn(() => "postgres"),
  initDriver: vi.fn(),
}));

import { query, getDriverType } from "../db.js";
import { analyzeVacuum, analyzeFindings, formatVacuumReport } from "../analyzers/vacuum.js";

const mockQuery = vi.mocked(query);
const mockGetDriverType = vi.mocked(getDriverType);

beforeEach(() => {
  vi.clearAllMocks();
  mockGetDriverType.mockReturnValue("postgres");
});

describe("analyze_vacuum", () => {
  it("should return unsupported message for SQLite", async () => {
    mockGetDriverType.mockReturnValue("sqlite");
    const result = await analyzeVacuum();
    expect(result).toContain("SQLite does not use autovacuum");
  });

  it("should return unsupported message for MySQL", async () => {
    mockGetDriverType.mockReturnValue("mysql");
    const result = await analyzeVacuum();
    expect(result).toContain("MySQL/InnoDB does not use VACUUM");
    expect(result).toContain("OPTIMIZE TABLE");
  });

  it("should return no-tables message for empty schema", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    const result = await analyzeVacuum("empty");
    expect(result).toContain("No user tables found in schema 'empty'");
  });

  it("should detect tables with high dead tuple ratio (>20% critical)", async () => {
    mockQuery
      .mockResolvedValueOnce({
        rows: [
          {
            table_name: "orders",
            n_live_tup: "800",
            n_dead_tup: "500",
            last_vacuum: null,
            last_autovacuum: null,
            last_analyze: null,
            last_autoanalyze: null,
            vacuum_count: "0",
            autovacuum_count: "0",
            analyze_count: "0",
            autoanalyze_count: "0",
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [{ name: "autovacuum", setting: "on" }],
      });

    const result = await analyzeVacuum();
    expect(result).toContain("VACUUM Analysis");
    expect(result).toContain("critical");
    expect(result).toContain("orders");
    expect(result).toContain("38.5%"); // 500/1300
  });

  it("should detect tables with moderate dead tuple ratio (>10% warning)", async () => {
    mockQuery
      .mockResolvedValueOnce({
        rows: [
          {
            table_name: "users",
            n_live_tup: "800",
            n_dead_tup: "100",
            last_vacuum: "2026-03-01",
            last_autovacuum: null,
            last_analyze: "2026-03-01",
            last_autoanalyze: null,
            vacuum_count: "3",
            autovacuum_count: "1",
            analyze_count: "2",
            autoanalyze_count: "1",
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [{ name: "autovacuum", setting: "on" }],
      });

    const result = await analyzeVacuum();
    expect(result).toContain("Warning");
    expect(result).toContain("users");
    expect(result).toContain("11.1%"); // 100/900
  });

  it("should detect disabled autovacuum as critical", async () => {
    mockQuery
      .mockResolvedValueOnce({
        rows: [
          {
            table_name: "products",
            n_live_tup: "100",
            n_dead_tup: "5",
            last_vacuum: "2026-03-01",
            last_autovacuum: null,
            last_analyze: "2026-03-01",
            last_autoanalyze: null,
            vacuum_count: "1",
            autovacuum_count: "0",
            analyze_count: "1",
            autoanalyze_count: "0",
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [{ name: "autovacuum", setting: "off" }],
      });

    const result = await analyzeVacuum();
    expect(result).toContain("Autovacuum is DISABLED");
    expect(result).toContain("Critical");
  });

  it("should detect tables never vacuumed", async () => {
    mockQuery
      .mockResolvedValueOnce({
        rows: [
          {
            table_name: "sessions",
            n_live_tup: "50",
            n_dead_tup: "2",
            last_vacuum: null,
            last_autovacuum: null,
            last_analyze: "2026-03-01",
            last_autoanalyze: null,
            vacuum_count: "0",
            autovacuum_count: "0",
            analyze_count: "1",
            autoanalyze_count: "0",
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [{ name: "autovacuum", setting: "on" }],
      });

    const result = await analyzeVacuum();
    expect(result).toContain("never been vacuumed");
    expect(result).toContain("sessions");
  });

  it("should detect tables never analyzed", async () => {
    mockQuery
      .mockResolvedValueOnce({
        rows: [
          {
            table_name: "logs",
            n_live_tup: "200",
            n_dead_tup: "5",
            last_vacuum: "2026-03-01",
            last_autovacuum: null,
            last_analyze: null,
            last_autoanalyze: null,
            vacuum_count: "2",
            autovacuum_count: "0",
            analyze_count: "0",
            autoanalyze_count: "0",
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [{ name: "autovacuum", setting: "on" }],
      });

    const result = await analyzeVacuum();
    expect(result).toContain("never been analyzed");
    expect(result).toContain("logs");
  });

  it("should report healthy tables with no findings", async () => {
    mockQuery
      .mockResolvedValueOnce({
        rows: [
          {
            table_name: "healthy_table",
            n_live_tup: "1000",
            n_dead_tup: "10",
            last_vacuum: "2026-03-08",
            last_autovacuum: "2026-03-07",
            last_analyze: "2026-03-08",
            last_autoanalyze: "2026-03-07",
            vacuum_count: "5",
            autovacuum_count: "10",
            analyze_count: "5",
            autoanalyze_count: "10",
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          { name: "autovacuum", setting: "on" },
          { name: "autovacuum_vacuum_threshold", setting: "50" },
        ],
      });

    const result = await analyzeVacuum();
    expect(result).toContain("well-maintained");
    expect(result).toContain("healthy_table");
    expect(result).toContain("All Tables");
  });

  it("should display autovacuum configuration settings", async () => {
    mockQuery
      .mockResolvedValueOnce({
        rows: [
          {
            table_name: "t1",
            n_live_tup: "100",
            n_dead_tup: "1",
            last_vacuum: "2026-03-08",
            last_autovacuum: null,
            last_analyze: "2026-03-08",
            last_autoanalyze: null,
            vacuum_count: "1",
            autovacuum_count: "0",
            analyze_count: "1",
            autoanalyze_count: "0",
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          { name: "autovacuum", setting: "on" },
          { name: "autovacuum_vacuum_threshold", setting: "50" },
          { name: "autovacuum_vacuum_scale_factor", setting: "0.2" },
          { name: "autovacuum_naptime", setting: "60" },
        ],
      });

    const result = await analyzeVacuum();
    expect(result).toContain("Autovacuum Configuration");
    expect(result).toContain("autovacuum_vacuum_threshold");
    expect(result).toContain("50");
    expect(result).toContain("autovacuum_naptime");
  });

  it("should show tables needing vacuum in summary table", async () => {
    mockQuery
      .mockResolvedValueOnce({
        rows: [
          {
            table_name: "bloated",
            n_live_tup: "500",
            n_dead_tup: "200",
            last_vacuum: null,
            last_autovacuum: "2026-03-01",
            last_analyze: null,
            last_autoanalyze: null,
            vacuum_count: "0",
            autovacuum_count: "1",
            analyze_count: "0",
            autoanalyze_count: "0",
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [{ name: "autovacuum", setting: "on" }],
      });

    const result = await analyzeVacuum();
    expect(result).toContain("Tables Needing VACUUM");
    expect(result).toContain("bloated");
    expect(result).toContain("28.6%"); // 200/700
  });
});

describe("analyzeFindings", () => {
  it("should not flag tables with low dead tuple count even if ratio is high", () => {
    const findings = analyzeFindings(
      [
        {
          table_name: "tiny",
          n_live_tup: "2",
          n_dead_tup: "3",
          last_vacuum: null,
          last_autovacuum: null,
          last_analyze: null,
          last_autoanalyze: null,
          vacuum_count: "0",
          autovacuum_count: "0",
          analyze_count: "0",
          autoanalyze_count: "0",
        },
      ],
      [{ name: "autovacuum", setting: "on" }]
    );
    // Should have never-vacuumed and never-analyzed warnings, but NOT a high dead tuple critical
    const highDeadFindings = findings.filter(
      (f) => f.message.includes("dead tuples")
    );
    expect(highDeadFindings).toHaveLength(0);
  });

  it("should handle tables with zero tuples", () => {
    const findings = analyzeFindings(
      [
        {
          table_name: "empty",
          n_live_tup: "0",
          n_dead_tup: "0",
          last_vacuum: null,
          last_autovacuum: null,
          last_analyze: null,
          last_autoanalyze: null,
          vacuum_count: "0",
          autovacuum_count: "0",
          analyze_count: "0",
          autoanalyze_count: "0",
        },
      ],
      [{ name: "autovacuum", setting: "on" }]
    );
    // Empty tables should not trigger any findings
    expect(findings).toHaveLength(0);
  });
});

describe("formatVacuumReport", () => {
  it("should include schema name in header", () => {
    const report = formatVacuumReport("myschema", [], [], []);
    expect(report).toContain("schema 'myschema'");
  });

  it("should show findings count summary", () => {
    const findings = [
      {
        severity: "CRITICAL" as const,
        table: "t1",
        message: "High dead tuples",
        recommendation: "VACUUM",
      },
      {
        severity: "WARNING" as const,
        table: "t2",
        message: "Never vacuumed",
        recommendation: "VACUUM",
      },
    ];
    const report = formatVacuumReport("public", [], [], findings);
    expect(report).toContain("1 critical");
    expect(report).toContain("1 warnings");
  });
});

describe("edge cases", () => {
  it("should handle non-numeric tuple counts gracefully", () => {
    const findings = analyzeFindings(
      [
        {
          table_name: "corrupted",
          n_live_tup: "NaN",
          n_dead_tup: "NaN",
          last_vacuum: null,
          last_autovacuum: null,
          last_analyze: null,
          last_autoanalyze: null,
          vacuum_count: "0",
          autovacuum_count: "0",
          analyze_count: "0",
          autoanalyze_count: "0",
        },
      ],
      [{ name: "autovacuum", setting: "on" }]
    );
    // NaN parses to 0, so total=0, no dead tuple findings, no vacuum/analyze findings
    expect(findings.filter(f => f.message.includes("dead tuples"))).toHaveLength(0);
  });

  it("should handle multiple tables with varying severity", async () => {
    mockQuery
      .mockResolvedValueOnce({
        rows: [
          {
            table_name: "critical_table",
            n_live_tup: "1000",
            n_dead_tup: "500",
            last_vacuum: null,
            last_autovacuum: null,
            last_analyze: null,
            last_autoanalyze: null,
            vacuum_count: "0",
            autovacuum_count: "0",
            analyze_count: "0",
            autoanalyze_count: "0",
          },
          {
            table_name: "healthy_table",
            n_live_tup: "10000",
            n_dead_tup: "10",
            last_vacuum: "2026-03-08",
            last_autovacuum: "2026-03-08",
            last_analyze: "2026-03-08",
            last_autoanalyze: "2026-03-08",
            vacuum_count: "5",
            autovacuum_count: "10",
            analyze_count: "5",
            autoanalyze_count: "10",
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [{ name: "autovacuum", setting: "on" }],
      });

    const result = await analyzeVacuum();
    expect(result).toContain("critical_table");
    expect(result).toContain("Tables Needing VACUUM");
    // healthy_table should appear in All Tables but not in warnings
    expect(result).toContain("healthy_table");
    expect(result).toContain("All Tables");
  });

  it("should pass custom schema parameter through", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    const result = await analyzeVacuum("custom_schema");
    expect(result).toContain("custom_schema");
  });
});
