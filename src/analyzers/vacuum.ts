import { query, getDriverType } from "../db.js";

interface VacuumStats {
  table_name: string;
  n_live_tup: string;
  n_dead_tup: string;
  last_vacuum: string | null;
  last_autovacuum: string | null;
  last_analyze: string | null;
  last_autoanalyze: string | null;
  vacuum_count: string;
  autovacuum_count: string;
  analyze_count: string;
  autoanalyze_count: string;
}

interface AutovacuumSetting {
  name: string;
  setting: string;
}

export interface VacuumFinding {
  severity: "CRITICAL" | "WARNING" | "INFO";
  table: string | null;
  message: string;
  recommendation: string;
}

/**
 * Analyze PostgreSQL VACUUM maintenance status.
 *
 * Checks dead tuple ratios, vacuum staleness, autovacuum configuration,
 * and identifies tables that need manual VACUUM attention.
 * PostgreSQL only — returns unsupported message for MySQL/SQLite.
 */
export async function analyzeVacuum(
  schema: string = "public"
): Promise<string> {
  const driver = getDriverType();

  if (driver === "sqlite") {
    return "## VACUUM Analysis\n\nSQLite does not use autovacuum in the same way as PostgreSQL. Run `VACUUM` manually to defragment the database file.";
  }
  if (driver === "mysql") {
    return "## VACUUM Analysis\n\nMySQL/InnoDB does not use VACUUM. Use `OPTIMIZE TABLE` to reclaim space from fragmented tables. See the `analyze_table_bloat` tool for fragmentation analysis.";
  }

  // Get table vacuum stats
  const stats = await query<VacuumStats>(`
    SELECT
      relname AS table_name,
      n_live_tup::text,
      n_dead_tup::text,
      last_vacuum::text,
      last_autovacuum::text,
      last_analyze::text,
      last_autoanalyze::text,
      vacuum_count::text,
      autovacuum_count::text,
      analyze_count::text,
      autoanalyze_count::text
    FROM pg_stat_user_tables
    WHERE schemaname = $1
    ORDER BY n_dead_tup DESC
  `, [schema]);

  if (stats.rows.length === 0) {
    return `No user tables found in schema '${schema}'.`;
  }

  // Get autovacuum settings
  const settings = await query<AutovacuumSetting>(`
    SELECT name, setting
    FROM pg_settings
    WHERE name LIKE 'autovacuum%'
    ORDER BY name
  `);

  const findings = analyzeFindings(stats.rows, settings.rows);
  return formatVacuumReport(schema, stats.rows, settings.rows, findings);
}

export function analyzeFindings(
  tables: VacuumStats[],
  settings: AutovacuumSetting[]
): VacuumFinding[] {
  const findings: VacuumFinding[] = [];

  // Check autovacuum enabled
  const avEnabled = settings.find((s) => s.name === "autovacuum");
  if (avEnabled && avEnabled.setting === "off") {
    findings.push({
      severity: "CRITICAL",
      table: null,
      message: "Autovacuum is DISABLED globally",
      recommendation:
        "Enable autovacuum immediately: ALTER SYSTEM SET autovacuum = on; SELECT pg_reload_conf();",
    });
  }

  for (const row of tables) {
    const live = parseInt(row.n_live_tup, 10) || 0;
    const dead = parseInt(row.n_dead_tup, 10) || 0;
    const total = live + dead;
    const deadRatio = total > 0 ? dead / total : 0;

    // High dead tuple ratio (>20% = critical, >10% = warning)
    if (deadRatio > 0.20 && dead > 100) {
      findings.push({
        severity: "CRITICAL",
        table: row.table_name,
        message: `${(deadRatio * 100).toFixed(1)}% dead tuples (${dead} dead / ${total} total)`,
        recommendation: `Run: VACUUM ANALYZE ${row.table_name};`,
      });
    } else if (deadRatio > 0.10 && dead > 50) {
      findings.push({
        severity: "WARNING",
        table: row.table_name,
        message: `${(deadRatio * 100).toFixed(1)}% dead tuples (${dead} dead / ${total} total)`,
        recommendation: `Run: VACUUM ANALYZE ${row.table_name};`,
      });
    }

    // Never vacuumed
    const vacuumCount = parseInt(row.vacuum_count, 10) || 0;
    const autovacuumCount = parseInt(row.autovacuum_count, 10) || 0;
    if (vacuumCount === 0 && autovacuumCount === 0 && total > 0) {
      findings.push({
        severity: "WARNING",
        table: row.table_name,
        message: "Table has never been vacuumed (manual or auto)",
        recommendation: `Run: VACUUM ANALYZE ${row.table_name};`,
      });
    }

    // Never analyzed
    const analyzeCount = parseInt(row.analyze_count, 10) || 0;
    const autoanalyzeCount = parseInt(row.autoanalyze_count, 10) || 0;
    if (analyzeCount === 0 && autoanalyzeCount === 0 && total > 0) {
      findings.push({
        severity: "INFO",
        table: row.table_name,
        message: "Table has never been analyzed — query planner statistics may be stale",
        recommendation: `Run: ANALYZE ${row.table_name};`,
      });
    }
  }

  return findings;
}

export function formatVacuumReport(
  schema: string,
  tables: VacuumStats[],
  settings: AutovacuumSetting[],
  findings: VacuumFinding[]
): string {
  const lines: string[] = [`## VACUUM Analysis — schema '${schema}'\n`];

  // Findings summary
  const critical = findings.filter((f) => f.severity === "CRITICAL");
  const warnings = findings.filter((f) => f.severity === "WARNING");
  const info = findings.filter((f) => f.severity === "INFO");

  if (findings.length === 0) {
    lines.push("### All tables are well-maintained.\n");
    lines.push(
      "No vacuum issues detected. Autovacuum appears to be working correctly.\n"
    );
  } else {
    lines.push(
      `### Findings: ${critical.length} critical, ${warnings.length} warnings, ${info.length} info\n`
    );

    if (critical.length > 0) {
      lines.push("#### Critical Issues\n");
      for (const f of critical) {
        const prefix = f.table ? `**${f.table}**: ` : "";
        lines.push(`- ${prefix}${f.message}`);
        lines.push(`  > ${f.recommendation}\n`);
      }
    }

    if (warnings.length > 0) {
      lines.push("#### Warnings\n");
      for (const f of warnings) {
        const prefix = f.table ? `**${f.table}**: ` : "";
        lines.push(`- ${prefix}${f.message}`);
        lines.push(`  > ${f.recommendation}\n`);
      }
    }

    if (info.length > 0) {
      lines.push("#### Info\n");
      for (const f of info) {
        const prefix = f.table ? `**${f.table}**: ` : "";
        lines.push(`- ${prefix}${f.message}`);
        lines.push(`  > ${f.recommendation}\n`);
      }
    }
  }

  // Tables needing vacuum (>10% dead tuples)
  const needsVacuum = tables.filter((t) => {
    const live = parseInt(t.n_live_tup, 10) || 0;
    const dead = parseInt(t.n_dead_tup, 10) || 0;
    const total = live + dead;
    return total > 0 && dead / total > 0.10;
  });

  if (needsVacuum.length > 0) {
    lines.push(`### Tables Needing VACUUM (${needsVacuum.length})\n`);
    lines.push("| Table | Dead Tuples | Dead % | Last Vacuum | Last Autovacuum |");
    lines.push("|-------|-------------|--------|-------------|-----------------|");
    for (const row of needsVacuum) {
      const live = parseInt(row.n_live_tup, 10) || 0;
      const dead = parseInt(row.n_dead_tup, 10) || 0;
      const total = live + dead;
      const deadPct = total > 0 ? ((dead / total) * 100).toFixed(1) : "0.0";
      lines.push(
        `| ${row.table_name} | ${dead} | ${deadPct}% | ${row.last_vacuum || "Never"} | ${row.last_autovacuum || "Never"} |`
      );
    }
    lines.push("");
  }

  // All tables overview
  lines.push("### All Tables\n");
  lines.push(
    "| Table | Live | Dead | Dead % | Vacuum Count | Autovacuum Count | Last Vacuum | Last Analyze |"
  );
  lines.push(
    "|-------|------|------|--------|--------------|------------------|-------------|--------------|"
  );
  for (const row of tables) {
    const live = parseInt(row.n_live_tup, 10) || 0;
    const dead = parseInt(row.n_dead_tup, 10) || 0;
    const total = live + dead;
    const deadPct = total > 0 ? ((dead / total) * 100).toFixed(1) : "0.0";
    const lastVac = row.last_vacuum || row.last_autovacuum || "Never";
    const lastAn = row.last_analyze || row.last_autoanalyze || "Never";
    lines.push(
      `| ${row.table_name} | ${live} | ${dead} | ${deadPct}% | ${row.vacuum_count} | ${row.autovacuum_count} | ${lastVac} | ${lastAn} |`
    );
  }

  // Autovacuum settings
  if (settings.length > 0) {
    lines.push("\n### Autovacuum Configuration\n");
    lines.push("| Setting | Value |");
    lines.push("|---------|-------|");
    for (const s of settings) {
      lines.push(`| ${s.name} | ${s.setting} |`);
    }
  }

  return lines.join("\n");
}
