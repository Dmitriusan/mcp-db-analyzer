import { query, getDriverType } from "../db.js";

interface ColumnInfo {
  column_name: string;
  data_type: string;
  is_nullable: string;
  column_default: string | null;
  character_maximum_length: number | null;
  ordinal_position: number;
}

interface ConstraintInfo {
  constraint_name: string;
  constraint_type: string;
  columns: string[];
  foreign_table: string | null;
  foreign_columns: string[] | null;
}

/**
 * List all user tables with row estimates and sizes.
 */
export async function listTables(schema: string = "public"): Promise<string> {
  const driver = getDriverType();

  if (driver === "sqlite") {
    return listTablesSqlite();
  }
  if (driver === "mysql") {
    return listTablesMysql(schema);
  }

  const result = await query<{
    table_name: string;
    table_schema: string;
    row_estimate: string;
    total_size: string;
  }>(`
    SELECT
      t.table_name,
      t.table_schema,
      COALESCE(s.n_live_tup, 0)::text AS row_estimate,
      pg_size_pretty(pg_total_relation_size(quote_ident(t.table_schema) || '.' || quote_ident(t.table_name))) AS total_size
    FROM information_schema.tables t
    LEFT JOIN pg_stat_user_tables s
      ON s.schemaname = t.table_schema AND s.relname = t.table_name
    WHERE t.table_schema = $1
      AND t.table_type = 'BASE TABLE'
    ORDER BY COALESCE(s.n_live_tup, 0) DESC
  `, [schema]);

  return formatTableList(result.rows, schema);
}

async function listTablesMysql(schema: string): Promise<string> {
  const result = await query<{
    table_name: string;
    table_schema: string;
    row_estimate: string;
    total_size: string;
  }>(`
    SELECT
      TABLE_NAME AS table_name,
      TABLE_SCHEMA AS table_schema,
      CAST(TABLE_ROWS AS CHAR) AS row_estimate,
      CONCAT(
        ROUND((DATA_LENGTH + INDEX_LENGTH) / 1024 / 1024, 2),
        ' MB'
      ) AS total_size
    FROM information_schema.TABLES
    WHERE TABLE_SCHEMA = ?
      AND TABLE_TYPE = 'BASE TABLE'
    ORDER BY TABLE_ROWS DESC
  `, [schema]);

  return formatTableList(result.rows, schema);
}

async function listTablesSqlite(): Promise<string> {
  const result = await query<{ name: string }>(`
    SELECT name FROM sqlite_master
    WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
    ORDER BY name
  `);

  if (result.rows.length === 0) {
    return `No tables found in database.`;
  }

  const lines = [`## Tables in schema 'main'\n`];
  lines.push("| Table | Rows (est.) | Total Size |");
  lines.push("|-------|-------------|------------|");
  for (const row of result.rows) {
    // SQLite doesn't have built-in row count or size — use count
    // Escape embedded double-quote characters so table names like `weird"table` don't
    // break the identifier quoting (same convention used in inspectTableSqlite).
    const escapedName = row.name.replace(/"/g, '""');
    const countResult = await query<{ cnt: number }>(
      `SELECT count(*) as cnt FROM "${escapedName}"`
    );
    const cnt = countResult.rows[0]?.cnt ?? 0;
    lines.push(`| ${row.name} | ${cnt} | - |`);
  }
  return lines.join("\n");
}

function formatTableList(
  rows: { table_name: string; row_estimate: string; total_size: string }[],
  schema: string
): string {
  if (rows.length === 0) {
    return `No tables found in schema '${schema}'.`;
  }

  const lines = [`## Tables in schema '${schema}'\n`];
  lines.push("| Table | Rows (est.) | Total Size |");
  lines.push("|-------|-------------|------------|");
  for (const row of rows) {
    lines.push(`| ${row.table_name} | ${row.row_estimate} | ${row.total_size} |`);
  }
  return lines.join("\n");
}

/**
 * Get detailed schema information for a specific table.
 */
export async function inspectTable(
  tableName: string,
  schema: string = "public"
): Promise<string> {
  const driver = getDriverType();

  if (driver === "sqlite") {
    return inspectTableSqlite(tableName);
  }

  // Columns — information_schema works for both PG and MySQL
  const colResult = await query<ColumnInfo>(`
    SELECT column_name, data_type, is_nullable, column_default,
           character_maximum_length, ordinal_position
    FROM information_schema.columns
    WHERE table_schema = ${driver === "mysql" ? "?" : "$1"}
      AND table_name = ${driver === "mysql" ? "?" : "$2"}
    ORDER BY ordinal_position
  `, [schema, tableName]);

  if (colResult.rows.length === 0) {
    return `Table '${schema}.${tableName}' not found.`;
  }

  const lines = [`## Table: ${schema}.${tableName}\n`];

  // Stats — driver-specific
  if (driver === "mysql") {
    const statsResult = await query<{
      row_estimate: string;
      total_size: string;
      table_size: string;
      index_size: string;
    }>(`
      SELECT
        CAST(TABLE_ROWS AS CHAR) AS row_estimate,
        CONCAT(ROUND((DATA_LENGTH + INDEX_LENGTH) / 1024 / 1024, 2), ' MB') AS total_size,
        CONCAT(ROUND(DATA_LENGTH / 1024 / 1024, 2), ' MB') AS table_size,
        CONCAT(ROUND(INDEX_LENGTH / 1024 / 1024, 2), ' MB') AS index_size
      FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
    `, [schema, tableName]);
    const stats = statsResult.rows[0];
    if (stats) {
      lines.push(`- **Rows (est.)**: ${stats.row_estimate}`);
      lines.push(`- **Total size**: ${stats.total_size}`);
      lines.push(`- **Table size**: ${stats.table_size}`);
      lines.push(`- **Index size**: ${stats.index_size}`);
      lines.push("");
    }
  } else {
    const statsResult = await query<{
      row_estimate: string;
      total_size: string;
      table_size: string;
      index_size: string;
    }>(`
      SELECT
        COALESCE(n_live_tup, 0)::text AS row_estimate,
        pg_size_pretty(pg_total_relation_size(quote_ident($1) || '.' || quote_ident($2))) AS total_size,
        pg_size_pretty(pg_table_size(quote_ident($1) || '.' || quote_ident($2))) AS table_size,
        pg_size_pretty(pg_indexes_size(quote_ident($1) || '.' || quote_ident($2))) AS index_size
      FROM pg_stat_user_tables
      WHERE schemaname = $1 AND relname = $2
    `, [schema, tableName]);
    const stats = statsResult.rows[0];
    if (stats) {
      lines.push(`- **Rows (est.)**: ${stats.row_estimate}`);
      lines.push(`- **Total size**: ${stats.total_size}`);
      lines.push(`- **Table size**: ${stats.table_size}`);
      lines.push(`- **Index size**: ${stats.index_size}`);
      lines.push("");
    }
  }

  // Columns
  lines.push("### Columns\n");
  lines.push("| # | Column | Type | Nullable | Default |");
  lines.push("|---|--------|------|----------|---------|");
  for (const col of colResult.rows) {
    const type = col.character_maximum_length
      ? `${col.data_type}(${col.character_maximum_length})`
      : col.data_type;
    lines.push(
      `| ${col.ordinal_position} | ${col.column_name} | ${type} | ${col.is_nullable} | ${col.column_default ?? "-"} |`
    );
  }

  // Constraints — information_schema works for both, but FK detection differs
  if (driver === "mysql") {
    const constraintResult = await query<{
      constraint_name: string;
      constraint_type: string;
      column_name: string;
      foreign_table_name: string | null;
      foreign_column_name: string | null;
    }>(`
      SELECT
        tc.CONSTRAINT_NAME AS constraint_name,
        tc.CONSTRAINT_TYPE AS constraint_type,
        kcu.COLUMN_NAME AS column_name,
        kcu.REFERENCED_TABLE_NAME AS foreign_table_name,
        kcu.REFERENCED_COLUMN_NAME AS foreign_column_name
      FROM information_schema.TABLE_CONSTRAINTS tc
      JOIN information_schema.KEY_COLUMN_USAGE kcu
        ON tc.CONSTRAINT_NAME = kcu.CONSTRAINT_NAME
        AND tc.TABLE_SCHEMA = kcu.TABLE_SCHEMA
        AND tc.TABLE_NAME = kcu.TABLE_NAME
      WHERE tc.TABLE_SCHEMA = ? AND tc.TABLE_NAME = ?
      ORDER BY tc.CONSTRAINT_TYPE, tc.CONSTRAINT_NAME
    `, [schema, tableName]);

    appendConstraints(constraintResult.rows, lines);
  } else {
    const constraintResult = await query<{
      constraint_name: string;
      constraint_type: string;
      column_name: string;
      foreign_table_name: string | null;
      foreign_column_name: string | null;
    }>(`
      SELECT
        tc.constraint_name,
        tc.constraint_type,
        kcu.column_name,
        ccu.table_name AS foreign_table_name,
        ccu.column_name AS foreign_column_name
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu
        ON tc.constraint_name = kcu.constraint_name
        AND tc.table_schema = kcu.table_schema
      LEFT JOIN information_schema.constraint_column_usage ccu
        ON tc.constraint_name = ccu.constraint_name
        AND tc.table_schema = ccu.table_schema
        AND tc.constraint_type = 'FOREIGN KEY'
      WHERE tc.table_schema = $1 AND tc.table_name = $2
      ORDER BY tc.constraint_type, tc.constraint_name
    `, [schema, tableName]);

    appendConstraints(constraintResult.rows, lines);
  }

  return lines.join("\n");
}

async function inspectTableSqlite(tableName: string): Promise<string> {
  // Escape double-quote characters so a table name containing `"` (e.g. `weird"table`)
  // does not break the PRAGMA queries or the row-count SELECT.
  const escaped = tableName.replace(/"/g, '""');

  const cols = await query<{
    cid: number;
    name: string;
    type: string;
    notnull: number;
    dflt_value: string | null;
    pk: number;
  }>(`PRAGMA table_info("${escaped}")`);

  if (cols.rows.length === 0) {
    return `Table '${tableName}' not found.`;
  }

  const lines = [`## Table: main.${tableName}\n`];

  // Row count
  const countResult = await query<{ cnt: number }>(
    `SELECT count(*) as cnt FROM "${escaped}"`
  );
  lines.push(`- **Rows**: ${countResult.rows[0]?.cnt ?? 0}`);
  lines.push("");

  lines.push("### Columns\n");
  lines.push("| # | Column | Type | Nullable | Default | PK |");
  lines.push("|---|--------|------|----------|---------|-----|");
  for (const col of cols.rows) {
    lines.push(
      `| ${col.cid + 1} | ${col.name} | ${col.type || 'ANY'} | ${col.notnull ? 'NO' : 'YES'} | ${col.dflt_value ?? '-'} | ${col.pk ? 'YES' : '-'} |`
    );
  }

  // Foreign keys
  const fks = await query<{
    id: number;
    seq: number;
    table: string;
    from: string;
    to: string;
  }>(`PRAGMA foreign_key_list("${escaped}")`);

  if (fks.rows.length > 0) {
    lines.push("\n### Foreign Keys\n");
    lines.push("| Column | References |");
    lines.push("|--------|------------|");
    for (const fk of fks.rows) {
      lines.push(`| ${fk.from} | ${fk.table}(${fk.to}) |`);
    }
  }

  // Indexes
  const indexes = await query<{
    seq: number;
    name: string;
    unique: number;
  }>(`PRAGMA index_list("${escaped}")`);

  if (indexes.rows.length > 0) {
    lines.push("\n### Indexes\n");
    lines.push("| Name | Unique | Columns |");
    lines.push("|------|--------|---------|");
    for (const idx of indexes.rows) {
      const idxCols = await query<{ seqno: number; name: string }>(
        `PRAGMA index_info("${idx.name.replace(/"/g, '""')}")`
      );
      const colNames = idxCols.rows.map(c => c.name).join(", ");
      lines.push(`| ${idx.name} | ${idx.unique ? 'YES' : 'NO'} | ${colNames} |`);
    }
  }

  return lines.join("\n");
}

function appendConstraints(
  rows: {
    constraint_name: string;
    constraint_type: string;
    column_name: string;
    foreign_table_name: string | null;
    foreign_column_name: string | null;
  }[],
  lines: string[]
): void {
  const constraintMap = new Map<string, ConstraintInfo>();
  for (const row of rows) {
    let c = constraintMap.get(row.constraint_name);
    if (!c) {
      c = {
        constraint_name: row.constraint_name,
        constraint_type: row.constraint_type,
        columns: [],
        foreign_table: row.foreign_table_name,
        foreign_columns: row.foreign_column_name ? [] : null,
      };
      constraintMap.set(row.constraint_name, c);
    }
    c.columns.push(row.column_name);
    if (row.foreign_column_name) {
      c.foreign_columns?.push(row.foreign_column_name);
    }
  }

  if (constraintMap.size > 0) {
    lines.push("\n### Constraints\n");
    lines.push("| Name | Type | Columns | References |");
    lines.push("|------|------|---------|------------|");
    for (const c of constraintMap.values()) {
      const ref = c.foreign_table
        ? `${c.foreign_table}(${c.foreign_columns?.join(", ")})`
        : "-";
      lines.push(
        `| ${c.constraint_name} | ${c.constraint_type} | ${c.columns.join(", ")} | ${ref} |`
      );
    }
  }
}
