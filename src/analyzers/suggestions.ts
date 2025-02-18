import { query, getDriverType } from "../db.js";

interface SeqScanTable {
  table_name: string;
  seq_scan: string;
  idx_scan: string;
  n_live_tup: string;
  table_size: string;
}

interface UnusedIndex {
  table_name: string;
  index_name: string;
  index_size: string;
  index_def: string;
}

/**
 * Suggest missing indexes by analyzing scan patterns,
 * and cross-reference with unused indexes that waste resources.
 */
export async function suggestMissingIndexes(
  schema: string = "public"
): Promise<string> {
  const driver = getDriverType();

  if (driver === "sqlite") {
    return suggestMissingIndexesSqlite();
  }
  if (driver === "mysql") {
    return suggestMissingIndexesMysql(schema);
  }

  const needsIndex = await query<SeqScanTable>(`
    SELECT
      relname AS table_name,
      seq_scan::text,
      COALESCE(idx_scan, 0)::text AS idx_scan,
      n_live_tup::text,
      pg_size_pretty(pg_table_size(quote_ident(schemaname) || '.' || quote_ident(relname))) AS table_size
    FROM pg_stat_user_tables
    WHERE schemaname = $1
      AND seq_scan > 1000
      AND COALESCE(idx_scan, 0) = 0
    ORDER BY seq_scan DESC
  `, [schema]);

  const unused = await query<UnusedIndex>(`
    SELECT
      s.relname AS table_name,
      s.indexrelname AS index_name,
      pg_size_pretty(pg_relation_size(s.indexrelid)) AS index_size,
      i.indexdef AS index_def
    FROM pg_stat_user_indexes s
    JOIN pg_indexes i
      ON s.schemaname = i.schemaname
      AND s.relname = i.tablename
      AND s.indexrelname = i.indexname
    WHERE s.schemaname = $1
      AND s.idx_scan = 0
      AND s.indexrelname NOT LIKE '%_pkey'
    ORDER BY pg_relation_size(s.indexrelid) DESC
  `, [schema]);

  return formatSuggestions(needsIndex.rows, unused.rows, schema);
}

async function suggestMissingIndexesSqlite(): Promise<string> {
  // Find tables with no indexes
  const tables = await query<{ name: string }>(`
    SELECT name FROM sqlite_master
    WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
    ORDER BY name
  `);

  const tablesWithoutIndexes: { table_name: string; row_count: string }[] = [];

  for (const table of tables.rows) {
    const indexes = await query<{ name: string }>(`
      SELECT name FROM sqlite_master
      WHERE type = 'index' AND tbl_name = ? AND name NOT LIKE 'sqlite_%'
    `, [table.name]);

    if (indexes.rows.length === 0) {
      const countResult = await query<{ cnt: number }>(
        `SELECT count(*) as cnt FROM "${table.name}"`
      );
      const cnt = countResult.rows[0]?.cnt ?? 0;
      if (cnt > 100) {
        tablesWithoutIndexes.push({
          table_name: table.name,
          row_count: String(cnt),
        });
      }
    }
  }

  const lines = [`## Index Suggestions (SQLite)\n`];

  if (tablesWithoutIndexes.length > 0) {
    lines.push(`### Tables Without Indexes (${tablesWithoutIndexes.length} found)\n`);
    lines.push("| Table | Rows |");
    lines.push("|-------|------|");
    for (const t of tablesWithoutIndexes) {
      lines.push(`| ${t.table_name} | ${t.row_count} |`);
    }
    lines.push("\n**Tip**: Use `explain_query` to check which queries do full table scans.");
  } else {
    lines.push("All tables with >100 rows have at least one index.\n");
  }

  lines.push("\n**Note**: SQLite does not track scan statistics. Use `EXPLAIN QUERY PLAN` to identify slow queries.");
  return lines.join("\n");
}

async function suggestMissingIndexesMysql(schema: string): Promise<string> {
  try {
    // Tables with no indexes beyond PRIMARY
    const needsIndex = await query<SeqScanTable>(`
      SELECT
        t.TABLE_NAME AS table_name,
        CAST(COALESCE(tio.COUNT_READ, 0) AS CHAR) AS seq_scan,
        '0' AS idx_scan,
        CAST(t.TABLE_ROWS AS CHAR) AS n_live_tup,
        CONCAT(ROUND(t.DATA_LENGTH / 1024 / 1024, 2), ' MB') AS table_size
      FROM information_schema.TABLES t
      LEFT JOIN performance_schema.table_io_waits_summary_by_table tio
        ON tio.OBJECT_SCHEMA = t.TABLE_SCHEMA AND tio.OBJECT_NAME = t.TABLE_NAME
      WHERE t.TABLE_SCHEMA = ?
        AND t.TABLE_TYPE = 'BASE TABLE'
        AND t.TABLE_ROWS > 1000
        AND NOT EXISTS (
          SELECT 1 FROM information_schema.STATISTICS s
          WHERE s.TABLE_SCHEMA = t.TABLE_SCHEMA
            AND s.TABLE_NAME = t.TABLE_NAME
            AND s.INDEX_NAME != 'PRIMARY'
        )
      ORDER BY t.TABLE_ROWS DESC
    `, [schema]);

    // Unused non-primary indexes
    const unused = await query<UnusedIndex>(`
      SELECT
        s.OBJECT_NAME AS table_name,
        s.INDEX_NAME AS index_name,
        CONCAT(ROUND(COALESCE(ist.STAT_VALUE, 0) * @@innodb_page_size / 1024 / 1024, 2), ' MB') AS index_size,
        CONCAT('INDEX ', s.INDEX_NAME, ' ON ', s.OBJECT_NAME) AS index_def
      FROM performance_schema.table_io_waits_summary_by_index_usage s
      LEFT JOIN mysql.innodb_index_stats ist
        ON ist.database_name = s.OBJECT_SCHEMA
        AND ist.table_name = s.OBJECT_NAME
        AND ist.index_name = s.INDEX_NAME
        AND ist.stat_name = 'size'
      WHERE s.OBJECT_SCHEMA = ?
        AND s.INDEX_NAME IS NOT NULL
        AND s.INDEX_NAME != 'PRIMARY'
        AND (s.COUNT_READ = 0 OR s.COUNT_READ IS NULL)
      ORDER BY COALESCE(ist.STAT_VALUE, 0) DESC
    `, [schema]);

    return formatSuggestions(needsIndex.rows, unused.rows, schema);
  } catch {
    return "## Index Suggestions\n\nUnable to query performance_schema. Ensure performance_schema is enabled (it is ON by default in MySQL 5.7+) and the user has SELECT privilege on performance_schema tables.";
  }
}

function formatSuggestions(
  needsIndex: SeqScanTable[],
  unused: UnusedIndex[],
  schema: string
): string {
  const lines = [`## Index Suggestions — schema '${schema}'\n`];

  if (needsIndex.length > 0) {
    lines.push(`### Tables Missing Indexes (${needsIndex.length} found)\n`);
    lines.push(
      "These tables have high scan counts with no non-primary indexes. They may be full-table-scanned on every query.\n"
    );
    lines.push("| Table | Seq Scans | Index Scans | Rows | Size |");
    lines.push("|-------|-----------|-------------|------|------|");
    for (const row of needsIndex) {
      lines.push(
        `| ${row.table_name} | ${row.seq_scan} | ${row.idx_scan} | ${row.n_live_tup} | ${row.table_size} |`
      );
    }

    lines.push("\n**Next step**: Use `explain_query` to analyze your most common queries against these tables, then create indexes on the columns used in WHERE and JOIN clauses.\n");
  } else {
    lines.push("### No critically unindexed tables found.\n");
  }

  if (unused.length > 0) {
    lines.push(`### Unused Indexes (${unused.length} found)\n`);
    lines.push(
      "These non-primary-key indexes have zero scans. They slow down writes and waste storage.\n"
    );
    lines.push("| Table | Index | Size | Definition |");
    lines.push("|-------|-------|------|------------|");
    for (const idx of unused) {
      lines.push(
        `| ${idx.table_name} | ${idx.index_name} | ${idx.index_size} | \`${idx.index_def}\` |`
      );
    }

    lines.push("\n**Recommended**: Drop unused indexes after confirming with your team:\n");
    for (const idx of unused) {
      lines.push(`\`\`\`sql\nDROP INDEX ${idx.index_name} ON ${schema}.${idx.table_name};\n\`\`\``);
    }
  } else {
    lines.push("### No unused indexes found.\n");
  }

  return lines.join("\n");
}
