import { query, getDriverType } from "../db.js";

interface IndexStats {
  table_name: string;
  index_name: string;
  index_size: string;
  idx_scan: string;
  idx_tup_read: string;
  idx_tup_fetch: string;
  index_def: string;
}

interface TableScanStats {
  table_name: string;
  seq_scan: string;
  seq_tup_read: string;
  idx_scan: string;
  n_live_tup: string;
  table_size: string;
}

/**
 * Analyze index usage and find unused indexes.
 */
export async function analyzeIndexUsage(
  schema: string = "public"
): Promise<string> {
  const driver = getDriverType();

  if (driver === "sqlite") {
    return analyzeIndexUsageSqlite();
  }
  if (driver === "mysql") {
    return analyzeIndexUsageMysql(schema);
  }

  const result = await query<IndexStats>(`
    SELECT
      s.relname AS table_name,
      s.indexrelname AS index_name,
      pg_size_pretty(pg_relation_size(s.indexrelid)) AS index_size,
      s.idx_scan::text,
      s.idx_tup_read::text,
      s.idx_tup_fetch::text,
      i.indexdef AS index_def
    FROM pg_stat_user_indexes s
    JOIN pg_indexes i
      ON s.schemaname = i.schemaname
      AND s.relname = i.tablename
      AND s.indexrelname = i.indexname
    WHERE s.schemaname = $1
    ORDER BY s.idx_scan ASC, pg_relation_size(s.indexrelid) DESC
  `, [schema]);

  return formatIndexUsage(result.rows, schema);
}

async function analyzeIndexUsageSqlite(): Promise<string> {
  // SQLite doesn't track index usage stats — list all indexes with their definitions
  const result = await query<{
    tbl_name: string;
    name: string;
    sql: string | null;
  }>(`
    SELECT tbl_name, name, sql FROM sqlite_master
    WHERE type = 'index' AND name NOT LIKE 'sqlite_%'
    ORDER BY tbl_name, name
  `);

  if (result.rows.length === 0) {
    return "No user-created indexes found. SQLite does not track index usage statistics.";
  }

  const lines = [`## Index Usage Analysis (SQLite)\n`];
  lines.push("SQLite does not track index scan statistics. Listing all indexes:\n");
  lines.push("| Table | Index | Definition |");
  lines.push("|-------|-------|------------|");
  for (const idx of result.rows) {
    lines.push(
      `| ${idx.tbl_name} | ${idx.name} | \`${idx.sql || 'auto-index'}\` |`
    );
  }
  lines.push("\n**Tip**: Use `EXPLAIN QUERY PLAN` via the `explain_query` tool to check if indexes are being used.");
  return lines.join("\n");
}

async function analyzeIndexUsageMysql(schema: string): Promise<string> {
  try {
    const result = await query<IndexStats>(`
      SELECT
        s.OBJECT_NAME AS table_name,
        s.INDEX_NAME AS index_name,
        CONCAT(ROUND(stat.STAT_VALUE * @@innodb_page_size / 1024 / 1024, 2), ' MB') AS index_size,
        CAST(s.COUNT_READ AS CHAR) AS idx_scan,
        CAST(s.COUNT_FETCH AS CHAR) AS idx_tup_read,
        CAST(s.COUNT_FETCH AS CHAR) AS idx_tup_fetch,
        CONCAT('INDEX ', s.INDEX_NAME, ' ON ', s.OBJECT_NAME) AS index_def
      FROM performance_schema.table_io_waits_summary_by_index_usage s
      LEFT JOIN mysql.innodb_index_stats stat
        ON stat.database_name = s.OBJECT_SCHEMA
        AND stat.table_name = s.OBJECT_NAME
        AND stat.index_name = s.INDEX_NAME
        AND stat.stat_name = 'size'
      WHERE s.OBJECT_SCHEMA = ?
        AND s.INDEX_NAME IS NOT NULL
      ORDER BY s.COUNT_READ ASC
    `, [schema]);

    return formatIndexUsage(result.rows, schema);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return `## Index Usage Analysis — schema '${schema}'\n\nUnable to query performance_schema. Ensure performance_schema is enabled (it is ON by default in MySQL 5.7+) and the user has SELECT privilege on performance_schema tables.\n\nDetails: ${detail}`;
  }
}

function formatIndexUsage(rows: IndexStats[], schema: string): string {
  if (rows.length === 0) {
    return `No indexes found in schema '${schema}'.`;
  }

  const lines = [`## Index Usage Analysis — schema '${schema}'\n`];

  const unused = rows.filter((r) => r.idx_scan === "0");
  if (unused.length > 0) {
    lines.push(`### Unused Indexes (${unused.length} found)\n`);
    lines.push(
      "These indexes have **zero scans** since the last stats reset. Consider dropping them to save space and speed up writes.\n"
    );
    lines.push("| Table | Index | Size | Definition |");
    lines.push("|-------|-------|------|------------|");
    for (const idx of unused) {
      lines.push(
        `| ${idx.table_name} | ${idx.index_name} | ${idx.index_size} | \`${idx.index_def}\` |`
      );
    }
    lines.push("");
  } else {
    lines.push("### No unused indexes found.\n");
  }

  lines.push("### All Indexes by Scan Count\n");
  lines.push("| Table | Index | Scans | Rows Read | Size |");
  lines.push("|-------|-------|-------|-----------|------|");
  for (const idx of rows) {
    lines.push(
      `| ${idx.table_name} | ${idx.index_name} | ${idx.idx_scan} | ${idx.idx_tup_read} | ${idx.index_size} |`
    );
  }

  return lines.join("\n");
}

/**
 * Find tables that might need indexes based on sequential scan patterns.
 */
export async function findMissingIndexes(
  schema: string = "public"
): Promise<string> {
  const driver = getDriverType();

  if (driver === "sqlite") {
    return "SQLite does not provide sequential scan statistics. Use `explain_query` to analyze specific queries.";
  }
  if (driver === "mysql") {
    return findMissingIndexesMysql(schema);
  }

  const result = await query<TableScanStats>(`
    SELECT
      relname AS table_name,
      seq_scan::text,
      seq_tup_read::text,
      COALESCE(idx_scan, 0)::text AS idx_scan,
      n_live_tup::text,
      pg_size_pretty(pg_table_size(quote_ident(schemaname) || '.' || quote_ident(relname))) AS table_size
    FROM pg_stat_user_tables
    WHERE schemaname = $1
      AND n_live_tup > 1000
      AND seq_scan > COALESCE(idx_scan, 0)
    ORDER BY seq_tup_read DESC
  `, [schema]);

  const lines = formatMissingIndexes(result.rows, schema);

  // PostgreSQL-specific: check for unindexed foreign keys
  const fkResult = await query<{
    table_name: string;
    column_name: string;
    constraint_name: string;
    foreign_table: string;
  }>(`
    SELECT
      kcu.table_name,
      kcu.column_name,
      tc.constraint_name,
      ccu.table_name AS foreign_table
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu
      ON tc.constraint_name = kcu.constraint_name
      AND tc.table_schema = kcu.table_schema
    JOIN information_schema.constraint_column_usage ccu
      ON tc.constraint_name = ccu.constraint_name
      AND tc.table_schema = ccu.table_schema
    WHERE tc.constraint_type = 'FOREIGN KEY'
      AND tc.table_schema = $1
      AND NOT EXISTS (
        SELECT 1 FROM pg_indexes pi
        WHERE pi.schemaname = tc.table_schema
          AND pi.tablename = kcu.table_name
          AND pi.indexdef ~ ('\\m' || kcu.column_name || '\\M')
      )
    ORDER BY kcu.table_name
  `, [schema]);

  if (fkResult.rows.length > 0) {
    lines.push(`\n### Unindexed Foreign Keys (${fkResult.rows.length} found)\n`);
    lines.push(
      "Foreign key columns without indexes cause slow JOINs and cascading deletes.\n"
    );
    lines.push("| Table | Column | FK → | Constraint |");
    lines.push("|-------|--------|------|------------|");
    for (const fk of fkResult.rows) {
      lines.push(
        `| ${fk.table_name} | ${fk.column_name} | ${fk.foreign_table} | ${fk.constraint_name} |`
      );
    }
    lines.push(
      "\n**Fix**: Create an index on each column above:\n```sql\nCREATE INDEX idx_<table>_<column> ON <table> (<column>);\n```"
    );
  }

  return lines.join("\n");
}

async function findMissingIndexesMysql(schema: string): Promise<string> {
  try {
  // MySQL: use information_schema + performance_schema for scan stats
  const result = await query<TableScanStats>(`
    SELECT
      t.TABLE_NAME AS table_name,
      CAST(COALESCE(tio.COUNT_READ, 0) AS CHAR) AS seq_scan,
      CAST(COALESCE(tio.COUNT_FETCH, 0) AS CHAR) AS seq_tup_read,
      CAST(COALESCE(idx.idx_reads, 0) AS CHAR) AS idx_scan,
      CAST(t.TABLE_ROWS AS CHAR) AS n_live_tup,
      CONCAT(ROUND(t.DATA_LENGTH / 1024 / 1024, 2), ' MB') AS table_size
    FROM information_schema.TABLES t
    LEFT JOIN performance_schema.table_io_waits_summary_by_table tio
      ON tio.OBJECT_SCHEMA = t.TABLE_SCHEMA AND tio.OBJECT_NAME = t.TABLE_NAME
    LEFT JOIN (
      SELECT OBJECT_SCHEMA, OBJECT_NAME, SUM(COUNT_READ) AS idx_reads
      FROM performance_schema.table_io_waits_summary_by_index_usage
      WHERE INDEX_NAME IS NOT NULL
      GROUP BY OBJECT_SCHEMA, OBJECT_NAME
    ) idx ON idx.OBJECT_SCHEMA = t.TABLE_SCHEMA AND idx.OBJECT_NAME = t.TABLE_NAME
    WHERE t.TABLE_SCHEMA = ?
      AND t.TABLE_TYPE = 'BASE TABLE'
      AND t.TABLE_ROWS > 1000
    ORDER BY t.TABLE_ROWS DESC
  `, [schema]);

  const lines = formatMissingIndexes(result.rows, schema);

  // MySQL: check for unindexed FK columns
  const fkResult = await query<{
    table_name: string;
    column_name: string;
    constraint_name: string;
    foreign_table: string;
  }>(`
    SELECT
      kcu.TABLE_NAME AS table_name,
      kcu.COLUMN_NAME AS column_name,
      kcu.CONSTRAINT_NAME AS constraint_name,
      kcu.REFERENCED_TABLE_NAME AS foreign_table
    FROM information_schema.KEY_COLUMN_USAGE kcu
    JOIN information_schema.TABLE_CONSTRAINTS tc
      ON tc.CONSTRAINT_NAME = kcu.CONSTRAINT_NAME
      AND tc.TABLE_SCHEMA = kcu.TABLE_SCHEMA
      AND tc.TABLE_NAME = kcu.TABLE_NAME
    WHERE tc.CONSTRAINT_TYPE = 'FOREIGN KEY'
      AND kcu.TABLE_SCHEMA = ?
      AND NOT EXISTS (
        SELECT 1 FROM information_schema.STATISTICS s
        WHERE s.TABLE_SCHEMA = kcu.TABLE_SCHEMA
          AND s.TABLE_NAME = kcu.TABLE_NAME
          AND s.COLUMN_NAME = kcu.COLUMN_NAME
          AND s.INDEX_NAME != kcu.CONSTRAINT_NAME
      )
    ORDER BY kcu.TABLE_NAME
  `, [schema]);

  if (fkResult.rows.length > 0) {
    lines.push(`\n### Unindexed Foreign Keys (${fkResult.rows.length} found)\n`);
    lines.push(
      "Foreign key columns without indexes cause slow JOINs and cascading deletes.\n"
    );
    lines.push("| Table | Column | FK → | Constraint |");
    lines.push("|-------|--------|------|------------|");
    for (const fk of fkResult.rows) {
      lines.push(
        `| ${fk.table_name} | ${fk.column_name} | ${fk.foreign_table} | ${fk.constraint_name} |`
      );
    }
    lines.push(
      "\n**Fix**: Create an index on each column above:\n```sql\nCREATE INDEX idx_<table>_<column> ON <table> (<column>);\n```"
    );
  }

  return lines.join("\n");
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return `## Missing Index Analysis\n\nUnable to query performance_schema. Ensure performance_schema is enabled (it is ON by default in MySQL 5.7+) and the user has SELECT privilege on performance_schema tables.\n\nDetails: ${detail}`;
  }
}

function formatMissingIndexes(rows: TableScanStats[], schema: string): string[] {
  if (rows.length === 0) {
    return [
      "No tables with suspicious sequential scan patterns found. Either all tables are well-indexed or too small to matter.",
    ];
  }

  const lines = [`## Potential Missing Indexes — schema '${schema}'\n`];
  lines.push(
    "Tables with more sequential scans than index scans (and >1000 rows).\n" +
    "High seq_tup_read with low idx_scan suggests missing indexes on commonly queried columns.\n"
  );
  lines.push("| Table | Seq Scans | Seq Rows Read | Index Scans | Rows | Size |");
  lines.push("|-------|-----------|---------------|-------------|------|------|");
  for (const row of rows) {
    lines.push(
      `| ${row.table_name} | ${row.seq_scan} | ${row.seq_tup_read} | ${row.idx_scan} | ${row.n_live_tup} | ${row.table_size} |`
    );
  }

  lines.push("\n### Recommendations\n");
  lines.push(
    "For each table above, check which columns are used in WHERE, JOIN, and ORDER BY clauses. " +
    "Use the `explain_query` tool to analyze specific slow queries against these tables."
  );

  return lines;
}
