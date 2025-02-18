import { query, getDriverType } from "../db.js";

interface BloatStats {
  table_name: string;
  n_live_tup: string;
  n_dead_tup: string;
  table_size: string;
  last_vacuum: string | null;
  last_autovacuum: string | null;
  last_analyze: string | null;
}

/**
 * Analyze table bloat.
 * PostgreSQL: dead tuple ratios and vacuum history.
 * MySQL: InnoDB fragmentation (DATA_FREE) and table sizes.
 */
export async function analyzeTableBloat(
  schema: string = "public"
): Promise<string> {
  const driver = getDriverType();

  if (driver === "sqlite") {
    return analyzeTableBloatSqlite();
  }
  if (driver === "mysql") {
    return analyzeTableBloatMysql(schema);
  }

  const result = await query<BloatStats>(`
    SELECT
      relname AS table_name,
      n_live_tup::text,
      n_dead_tup::text,
      pg_size_pretty(pg_table_size(quote_ident(schemaname) || '.' || quote_ident(relname))) AS table_size,
      last_vacuum::text,
      last_autovacuum::text,
      last_analyze::text
    FROM pg_stat_user_tables
    WHERE schemaname = $1
    ORDER BY n_dead_tup DESC
  `, [schema]);

  if (result.rows.length === 0) {
    return `No user tables found in schema '${schema}'.`;
  }

  const lines = [`## Table Bloat Analysis — schema '${schema}'\n`];

  const bloated = result.rows.filter((r) => {
    const live = parseInt(r.n_live_tup, 10) || 0;
    const dead = parseInt(r.n_dead_tup, 10) || 0;
    const total = live + dead;
    return total > 0 && (dead / total) > 0.10;
  });

  if (bloated.length > 0) {
    lines.push(`### Tables Needing VACUUM (${bloated.length} found)\n`);
    lines.push(
      "These tables have >10% dead tuples. Run `VACUUM ANALYZE` to reclaim space and update statistics.\n"
    );
    lines.push("| Table | Live Tuples | Dead Tuples | Bloat % | Size | Last Vacuum |");
    lines.push("|-------|-------------|-------------|---------|------|-------------|");
    for (const row of bloated) {
      const live = parseInt(row.n_live_tup, 10) || 0;
      const dead = parseInt(row.n_dead_tup, 10) || 0;
      const total = live + dead;
      const bloatPct = total > 0 ? ((dead / total) * 100).toFixed(1) : "0.0";
      const lastVacuum = row.last_vacuum || row.last_autovacuum || "Never";
      lines.push(
        `| ${row.table_name} | ${row.n_live_tup} | ${row.n_dead_tup} | ${bloatPct}% | ${row.table_size} | ${lastVacuum} |`
      );
    }

    lines.push("\n### Recommended Actions\n");
    for (const row of bloated) {
      lines.push(`\`\`\`sql\nVACUUM ANALYZE ${schema}.${row.table_name};\n\`\`\``);
    }
    lines.push("");
  } else {
    lines.push("### No significant bloat detected.\n");
    lines.push("All tables have <10% dead tuples. Autovacuum appears to be working well.\n");
  }

  lines.push("### All Tables\n");
  lines.push("| Table | Live Tuples | Dead Tuples | Bloat % | Size | Last Vacuum | Last Analyze |");
  lines.push("|-------|-------------|-------------|---------|------|-------------|--------------|");
  for (const row of result.rows) {
    const live = parseInt(row.n_live_tup, 10) || 0;
    const dead = parseInt(row.n_dead_tup, 10) || 0;
    const total = live + dead;
    const bloatPct = total > 0 ? ((dead / total) * 100).toFixed(1) : "0.0";
    const lastVacuum = row.last_vacuum || row.last_autovacuum || "Never";
    const lastAnalyze = row.last_analyze || "Never";
    lines.push(
      `| ${row.table_name} | ${row.n_live_tup} | ${row.n_dead_tup} | ${bloatPct}% | ${row.table_size} | ${lastVacuum} | ${lastAnalyze} |`
    );
  }

  return lines.join("\n");
}

async function analyzeTableBloatSqlite(): Promise<string> {
  // SQLite fragmentation: compare page_count vs freelist_count
  const pageSize = await query<{ page_size: number }>(`PRAGMA page_size`);
  const pageCount = await query<{ page_count: number }>(`PRAGMA page_count`);
  const freelistCount = await query<{ freelist_count: number }>(`PRAGMA freelist_count`);

  const ps = pageSize.rows[0]?.page_size ?? 4096;
  const pc = pageCount.rows[0]?.page_count ?? 0;
  const fc = freelistCount.rows[0]?.freelist_count ?? 0;

  const totalSizeKb = Math.round((pc * ps) / 1024);
  const freeSpaceKb = Math.round((fc * ps) / 1024);
  const fragPct = pc > 0 ? ((fc / pc) * 100).toFixed(1) : "0.0";

  const lines = [`## Table Bloat Analysis (SQLite)\n`];
  lines.push(`- **Database size**: ${totalSizeKb} KB (${pc} pages x ${ps} bytes)`);
  lines.push(`- **Free space**: ${freeSpaceKb} KB (${fc} free pages)`);
  lines.push(`- **Fragmentation**: ${fragPct}%`);
  lines.push("");

  if (fc > 0 && parseFloat(fragPct) > 10) {
    lines.push("### Recommendation\n");
    lines.push("Run `VACUUM` to reclaim free space and defragment the database file.\n");
    lines.push("```sql\nVACUUM;\n```");
  } else {
    lines.push("### No significant fragmentation detected.\n");
  }

  return lines.join("\n");
}

async function analyzeTableBloatMysql(schema: string): Promise<string> {
  const result = await query<{
    table_name: string;
    table_rows: string;
    data_size: string;
    data_free: string;
    frag_pct: string;
  }>(`
    SELECT
      TABLE_NAME AS table_name,
      CAST(TABLE_ROWS AS CHAR) AS table_rows,
      CONCAT(ROUND(DATA_LENGTH / 1024 / 1024, 2), ' MB') AS data_size,
      CONCAT(ROUND(DATA_FREE / 1024 / 1024, 2), ' MB') AS data_free,
      CAST(
        CASE WHEN DATA_LENGTH > 0
          THEN ROUND(DATA_FREE / DATA_LENGTH * 100, 1)
          ELSE 0
        END
      AS CHAR) AS frag_pct
    FROM information_schema.TABLES
    WHERE TABLE_SCHEMA = ?
      AND TABLE_TYPE = 'BASE TABLE'
      AND ENGINE = 'InnoDB'
    ORDER BY DATA_FREE DESC
  `, [schema]);

  if (result.rows.length === 0) {
    return `No InnoDB tables found in schema '${schema}'.`;
  }

  const lines = [`## Table Fragmentation Analysis — schema '${schema}' (MySQL/InnoDB)\n`];

  const fragmented = result.rows.filter(
    (r) => parseFloat(r.frag_pct) > 10
  );

  if (fragmented.length > 0) {
    lines.push(`### Fragmented Tables (${fragmented.length} found)\n`);
    lines.push(
      "These tables have >10% free space (fragmentation). Run `OPTIMIZE TABLE` to reclaim space.\n"
    );
    lines.push("| Table | Rows | Data Size | Free Space | Fragmentation % |");
    lines.push("|-------|------|-----------|------------|-----------------|");
    for (const row of fragmented) {
      lines.push(
        `| ${row.table_name} | ${row.table_rows} | ${row.data_size} | ${row.data_free} | ${row.frag_pct}% |`
      );
    }

    lines.push("\n### Recommended Actions\n");
    for (const row of fragmented) {
      lines.push(`\`\`\`sql\nOPTIMIZE TABLE ${schema}.${row.table_name};\n\`\`\``);
    }
    lines.push("");
  } else {
    lines.push("### No significant fragmentation detected.\n");
    lines.push("All tables have <10% free space. InnoDB is managing space well.\n");
  }

  lines.push("### All Tables\n");
  lines.push("| Table | Rows | Data Size | Free Space | Fragmentation % |");
  lines.push("|-------|------|-----------|------------|-----------------|");
  for (const row of result.rows) {
    lines.push(
      `| ${row.table_name} | ${row.table_rows} | ${row.data_size} | ${row.data_free} | ${row.frag_pct}% |`
    );
  }

  return lines.join("\n");
}
