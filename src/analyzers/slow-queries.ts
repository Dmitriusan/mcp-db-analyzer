/**
 * Slow query analyzer.
 *
 * Queries pg_stat_statements (if available) for the slowest queries
 * and suggests optimization strategies.
 */

import { query, getDriverType } from "../db.js";

interface StatStatementsRow {
  query: string;
  calls: number;
  total_exec_time: number;
  mean_exec_time: number;
  min_exec_time: number;
  max_exec_time: number;
  rows: number;
}

export async function analyzeSlowQueries(
  schema: string,
  limit: number = 10
): Promise<string> {
  const driver = getDriverType();

  if (driver === "sqlite") {
    return "## Slow Query Analysis\n\nNot available for SQLite — no query statistics tracking.";
  }

  if (driver === "mysql") {
    return analyzeMysqlSlowQueries(limit);
  }

  return analyzePostgresSlowQueries(schema, limit);
}

async function analyzePostgresSlowQueries(
  schema: string,
  limit: number
): Promise<string> {
  // Check if pg_stat_statements is available
  try {
    const extCheck = await query<{ extname: string }>(
      "SELECT extname FROM pg_extension WHERE extname = 'pg_stat_statements'"
    );

    if (extCheck.rows.length === 0) {
      return [
        "## Slow Query Analysis",
        "",
        "**pg_stat_statements extension not installed.**",
        "",
        "To enable slow query tracking:",
        "```sql",
        "CREATE EXTENSION pg_stat_statements;",
        "```",
        "",
        "Also add to `postgresql.conf`:",
        "```",
        "shared_preload_libraries = 'pg_stat_statements'",
        "pg_stat_statements.track = all",
        "```",
        "",
        "Restart PostgreSQL and queries will be tracked automatically.",
      ].join("\n");
    }
  } catch {
    return "## Slow Query Analysis\n\nUnable to check pg_stat_statements. Ensure the database user has permissions.";
  }

  try {
    const result = await query<StatStatementsRow>(
      `SELECT
        query,
        calls,
        total_exec_time,
        mean_exec_time,
        min_exec_time,
        max_exec_time,
        rows
      FROM pg_stat_statements
      WHERE query NOT LIKE '%pg_stat_statements%'
        AND query NOT LIKE 'BEGIN%'
        AND query NOT LIKE 'COMMIT%'
        AND query NOT LIKE 'SET %'
      ORDER BY mean_exec_time DESC
      LIMIT $1`,
      [limit]
    );

    if (result.rows.length === 0) {
      return "## Slow Query Analysis\n\nNo query statistics found. Run some queries first.";
    }

    const sections: string[] = [];
    sections.push("## Slow Query Analysis (by avg execution time)");
    sections.push("");
    sections.push(
      "| # | Avg Time | Total Time | Calls | Avg Rows | Query |"
    );
    sections.push(
      "|---|----------|------------|-------|----------|-------|"
    );

    for (let i = 0; i < result.rows.length; i++) {
      const r = result.rows[i];
      const avgMs = r.mean_exec_time.toFixed(1);
      const totalMs = r.total_exec_time.toFixed(0);
      const truncatedQuery = r.query.length > 80 ? r.query.slice(0, 77) + "..." : r.query;
      const avgRows = Math.round(r.rows / Math.max(r.calls, 1));
      sections.push(
        `| ${i + 1} | ${avgMs}ms | ${totalMs}ms | ${r.calls} | ${avgRows} | \`${truncatedQuery.replace(/\|/g, "\\|")}\` |`
      );
    }

    // Recommendations
    sections.push("");
    sections.push("### Recommendations");

    const highCallSlowQueries = result.rows.filter(
      (r) => r.calls > 100 && r.mean_exec_time > 100
    );
    if (highCallSlowQueries.length > 0) {
      sections.push(
        `- **${highCallSlowQueries.length} high-impact queries** — called >100 times with >100ms avg. Prioritize these for optimization.`
      );
    }

    const seqScanCandidates = result.rows.filter(
      (r) => r.mean_exec_time > 50 && r.rows / Math.max(r.calls, 1) < 10
    );
    if (seqScanCandidates.length > 0) {
      sections.push(
        `- **${seqScanCandidates.length} queries returning few rows but slow** — likely missing indexes. Use \`explain_query\` to check.`
      );
    }

    return sections.join("\n");
  } catch (err) {
    return `## Slow Query Analysis\n\nError querying pg_stat_statements: ${err instanceof Error ? err.message : String(err)}`;
  }
}

async function analyzeMysqlSlowQueries(limit: number): Promise<string> {
  try {
    const result = await query<{
      DIGEST_TEXT: string;
      COUNT_STAR: number;
      SUM_TIMER_WAIT: number;
      AVG_TIMER_WAIT: number;
      SUM_ROWS_EXAMINED: number;
      SUM_ROWS_SENT: number;
    }>(
      `SELECT
        DIGEST_TEXT,
        COUNT_STAR,
        SUM_TIMER_WAIT / 1000000000 as SUM_TIMER_WAIT,
        AVG_TIMER_WAIT / 1000000000 as AVG_TIMER_WAIT,
        SUM_ROWS_EXAMINED,
        SUM_ROWS_SENT
      FROM performance_schema.events_statements_summary_by_digest
      WHERE DIGEST_TEXT IS NOT NULL
        AND DIGEST_TEXT NOT LIKE '%performance_schema%'
      ORDER BY AVG_TIMER_WAIT DESC
      LIMIT ?`,
      [limit]
    );

    if (result.rows.length === 0) {
      return "## Slow Query Analysis\n\nNo query statistics found in performance_schema.";
    }

    const sections: string[] = [];
    sections.push("## Slow Query Analysis (MySQL — by avg execution time)");
    sections.push("");
    sections.push("| # | Avg Time | Total Time | Calls | Query |");
    sections.push("|---|----------|------------|-------|-------|");

    for (let i = 0; i < result.rows.length; i++) {
      const r = result.rows[i];
      const truncated = r.DIGEST_TEXT.length > 80 ? r.DIGEST_TEXT.slice(0, 77) + "..." : r.DIGEST_TEXT;
      sections.push(
        `| ${i + 1} | ${r.AVG_TIMER_WAIT.toFixed(1)}ms | ${r.SUM_TIMER_WAIT.toFixed(0)}ms | ${r.COUNT_STAR} | \`${truncated.replace(/\|/g, "\\|")}\` |`
      );
    }

    return sections.join("\n");
  } catch {
    return "## Slow Query Analysis\n\nUnable to query performance_schema. Ensure it is enabled and the user has SELECT permission.";
  }
}
