/**
 * Connection pool analyzer.
 *
 * Queries pg_stat_activity (PostgreSQL), performance_schema (MySQL),
 * or returns unavailable for SQLite.
 *
 * Detects:
 * - Connection pool utilization
 * - Idle-in-transaction connections (holding locks)
 * - Long-running queries
 * - Blocked connections waiting on locks
 */

import { query, getDriverType } from "../db.js";

export async function analyzeConnections(): Promise<string> {
  const driver = getDriverType();
  if (driver === "sqlite") {
    return "## Connection Analysis\n\nConnection analysis is not available for SQLite (single-process database).";
  }
  if (driver === "mysql") {
    return analyzeMysqlConnections();
  }
  return analyzePostgresConnections();
}

async function analyzePostgresConnections(): Promise<string> {
  const lines: string[] = [`## Connection Analysis (PostgreSQL)\n`];

  // 1. Overall connection summary
  interface ConnSummary {
    state: string;
    count: string;
  }
  const summary = await query<ConnSummary>(
    `SELECT COALESCE(state, 'null') AS state, COUNT(*)::text AS count
     FROM pg_stat_activity
     WHERE backend_type = 'client backend'
     GROUP BY state
     ORDER BY COUNT(*) DESC`
  );

  lines.push("### Connection States\n");
  lines.push("| State | Count |");
  lines.push("|-------|-------|");
  let totalConnections = 0;
  for (const row of summary.rows) {
    lines.push(`| ${row.state} | ${row.count} |`);
    totalConnections += parseInt(row.count, 10);
  }
  lines.push(`| **Total** | **${totalConnections}** |`);
  lines.push("");

  // 2. Max connections limit
  interface MaxConn {
    setting: string;
  }
  const maxConn = await query<MaxConn>(
    `SELECT setting FROM pg_settings WHERE name = 'max_connections'`
  );
  if (maxConn.rows.length > 0) {
    const max = parseInt(maxConn.rows[0].setting, 10);
    const utilization = totalConnections / max;
    lines.push(`**Max connections**: ${max}`);
    lines.push(`**Utilization**: ${(utilization * 100).toFixed(1)}%`);
    if (utilization > 0.8) {
      lines.push(`\n**WARNING**: Connection pool is ${(utilization * 100).toFixed(0)}% utilized. Consider increasing max_connections or using PgBouncer.`);
    }
    lines.push("");
  }

  // 3. Idle-in-transaction (holding locks, blocking others)
  interface IdleTxn {
    pid: string;
    usename: string;
    state: string;
    duration: string;
    query: string;
  }
  const idleTxn = await query<IdleTxn>(
    `SELECT pid::text, usename, state,
            (NOW() - state_change)::text AS duration,
            LEFT(query, 100) AS query
     FROM pg_stat_activity
     WHERE state = 'idle in transaction'
       AND backend_type = 'client backend'
     ORDER BY state_change ASC
     LIMIT 10`
  );
  if (idleTxn.rows.length > 0) {
    lines.push("### Idle-in-Transaction Connections\n");
    lines.push("These connections hold locks and may block other operations.\n");
    lines.push("| PID | User | Duration | Query |");
    lines.push("|-----|------|----------|-------|");
    for (const row of idleTxn.rows) {
      lines.push(`| ${row.pid} | ${row.usename} | ${row.duration} | ${row.query.replace(/\|/g, "\\|")} |`);
    }
    lines.push("");
  }

  // 4. Long-running active queries (> 30 seconds)
  interface LongQuery {
    pid: string;
    usename: string;
    duration: string;
    wait_event_type: string | null;
    query: string;
  }
  const longQueries = await query<LongQuery>(
    `SELECT pid::text, usename,
            (NOW() - query_start)::text AS duration,
            wait_event_type,
            LEFT(query, 120) AS query
     FROM pg_stat_activity
     WHERE state = 'active'
       AND backend_type = 'client backend'
       AND query_start < NOW() - INTERVAL '30 seconds'
       AND pid != pg_backend_pid()
     ORDER BY query_start ASC
     LIMIT 10`
  );
  if (longQueries.rows.length > 0) {
    lines.push("### Long-Running Queries (> 30s)\n");
    lines.push("| PID | User | Duration | Wait | Query |");
    lines.push("|-----|------|----------|------|-------|");
    for (const row of longQueries.rows) {
      lines.push(`| ${row.pid} | ${row.usename} | ${row.duration} | ${row.wait_event_type || "-"} | ${row.query.replace(/\|/g, "\\|")} |`);
    }
    lines.push("");
  }

  // 5. Blocked connections (waiting on locks)
  interface BlockedConn {
    blocked_pid: string;
    blocking_pid: string;
    blocked_query: string;
    blocking_query: string;
  }
  const blocked = await query<BlockedConn>(
    `SELECT blocked.pid::text AS blocked_pid,
            blocking.pid::text AS blocking_pid,
            LEFT(blocked.query, 80) AS blocked_query,
            LEFT(blocking.query, 80) AS blocking_query
     FROM pg_stat_activity blocked
     JOIN pg_locks bl ON bl.pid = blocked.pid AND NOT bl.granted
     JOIN pg_locks gl ON gl.locktype = bl.locktype
       AND gl.database IS NOT DISTINCT FROM bl.database
       AND gl.relation IS NOT DISTINCT FROM bl.relation
       AND gl.page IS NOT DISTINCT FROM bl.page
       AND gl.tuple IS NOT DISTINCT FROM bl.tuple
       AND gl.virtualxid IS NOT DISTINCT FROM bl.virtualxid
       AND gl.transactionid IS NOT DISTINCT FROM bl.transactionid
       AND gl.classid IS NOT DISTINCT FROM bl.classid
       AND gl.objid IS NOT DISTINCT FROM bl.objid
       AND gl.objsubid IS NOT DISTINCT FROM bl.objsubid
       AND gl.pid != bl.pid
       AND gl.granted
     JOIN pg_stat_activity blocking ON blocking.pid = gl.pid
     LIMIT 10`
  );
  if (blocked.rows.length > 0) {
    lines.push("### Blocked Connections\n");
    lines.push("| Blocked PID | Blocking PID | Blocked Query | Blocking Query |");
    lines.push("|-------------|--------------|---------------|----------------|");
    for (const row of blocked.rows) {
      lines.push(`| ${row.blocked_pid} | ${row.blocking_pid} | ${row.blocked_query.replace(/\|/g, "\\|")} | ${row.blocking_query.replace(/\|/g, "\\|")} |`);
    }
    lines.push("");
  }

  // Summary
  const issues: string[] = [];
  if (idleTxn.rows.length > 0) issues.push(`${idleTxn.rows.length} idle-in-transaction connection(s) holding locks`);
  if (longQueries.rows.length > 0) issues.push(`${longQueries.rows.length} long-running query/queries (> 30s)`);
  if (blocked.rows.length > 0) issues.push(`${blocked.rows.length} blocked connection(s) waiting on locks`);

  if (issues.length > 0) {
    lines.push("### Issues\n");
    for (const issue of issues) {
      lines.push(`- ${issue}`);
    }
    lines.push("");
    lines.push("### Recommendations\n");
    if (idleTxn.rows.length > 0) {
      lines.push("- Set `idle_in_transaction_session_timeout` to auto-kill stale transactions");
    }
    if (longQueries.rows.length > 0) {
      lines.push("- Set `statement_timeout` to prevent runaway queries");
    }
    if (blocked.rows.length > 0) {
      lines.push("- Investigate lock contention — consider `pg_terminate_backend()` for blocking PIDs");
    }
  } else {
    lines.push("### No connection issues detected.\n");
  }

  return lines.join("\n");
}

async function analyzeMysqlConnections(): Promise<string> {
  const lines: string[] = [`## Connection Analysis (MySQL)\n`];

  // 1. Process list summary
  interface ProcessSummary {
    state: string;
    count: string;
  }
  const summary = await query<ProcessSummary>(
    `SELECT COALESCE(COMMAND, 'Unknown') AS state, COUNT(*) AS count
     FROM information_schema.PROCESSLIST
     GROUP BY COMMAND
     ORDER BY COUNT(*) DESC`
  );

  lines.push("### Connection States\n");
  lines.push("| State | Count |");
  lines.push("|-------|-------|");
  let total = 0;
  for (const row of summary.rows) {
    lines.push(`| ${row.state} | ${row.count} |`);
    total += parseInt(row.count, 10);
  }
  lines.push(`| **Total** | **${total}** |`);
  lines.push("");

  // 2. Max connections utilization
  try {
    interface MaxConnRow { max_connections: string; }
    const maxConn = await query<MaxConnRow>(`SELECT @@max_connections AS max_connections`);
    if (maxConn.rows.length > 0) {
      const max = parseInt(maxConn.rows[0].max_connections, 10);
      const utilization = total / max;
      lines.push(`**Max connections**: ${max}`);
      lines.push(`**Utilization**: ${(utilization * 100).toFixed(1)}%`);
      if (utilization > 0.8) {
        lines.push(`\n**WARNING**: Connection pool is ${(utilization * 100).toFixed(0)}% utilized. Consider increasing max_connections or using a connection pooler (e.g. ProxySQL).`);
      }
      lines.push("");
    }
  } catch {
    // Supplemental info — skip silently if unavailable
  }

  // 3. Long-running queries
  interface LongQuery {
    id: string;
    user: string;
    time: string;
    state: string;
    info: string | null;
  }
  const longQueries = await query<LongQuery>(
    `SELECT ID AS id, USER AS user, TIME AS time, STATE AS state, LEFT(INFO, 100) AS info
     FROM information_schema.PROCESSLIST
     WHERE COMMAND = 'Query' AND TIME > 30
     ORDER BY TIME DESC
     LIMIT 10`
  );
  if (longQueries.rows.length > 0) {
    lines.push("### Long-Running Queries (> 30s)\n");
    lines.push("| ID | User | Duration (s) | State | Query |");
    lines.push("|-----|------|-------------|-------|-------|");
    for (const row of longQueries.rows) {
      const info = row.info ? row.info.replace(/\|/g, "\\|") : "-";
      lines.push(`| ${row.id} | ${row.user} | ${row.time} | ${row.state} | ${info} |`);
    }
    lines.push("");
  }

  if (longQueries.rows.length === 0) {
    lines.push("### No connection issues detected.\n");
  }

  return lines.join("\n");
}
