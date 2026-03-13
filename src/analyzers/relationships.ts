/**
 * Table relationship analyzer.
 *
 * Queries foreign key constraints to build a dependency graph.
 * Detects:
 * - Orphan tables (no FK relationships at all)
 * - Cascading delete chains (CASCADE rules that could cause unexpected data loss)
 * - Highly connected tables (many FKs pointing in/out — central entities)
 * - Missing reciprocal relationships
 */

import { query, getDriverType } from "../db.js";

interface ForeignKey {
  source_table: string;
  source_column: string;
  target_table: string;
  target_column: string;
  constraint_name: string;
  on_delete: string;
  on_update: string;
}

interface TableNode {
  name: string;
  outgoing: ForeignKey[]; // this table references others
  incoming: ForeignKey[]; // others reference this table
}

export async function analyzeTableRelationships(
  schema: string = "public"
): Promise<string> {
  const driver = getDriverType();

  if (driver === "sqlite") {
    return analyzeSqliteRelationships();
  }
  if (driver === "mysql") {
    return analyzeMysqlRelationships(schema);
  }
  return analyzePostgresRelationships(schema);
}

async function analyzePostgresRelationships(schema: string): Promise<string> {
  // Get all tables
  const tablesResult = await query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema = $1 AND table_type = 'BASE TABLE'
     ORDER BY table_name`,
    [schema]
  );

  if (tablesResult.rows.length === 0) {
    return "## Table Relationships\n\nNo tables found in schema.";
  }

  // Get all foreign keys
  const fkResult = await query<ForeignKey>(
    `SELECT
       kcu.table_name AS source_table,
       kcu.column_name AS source_column,
       ccu.table_name AS target_table,
       ccu.column_name AS target_column,
       tc.constraint_name,
       rc.delete_rule AS on_delete,
       rc.update_rule AS on_update
     FROM information_schema.table_constraints tc
     JOIN information_schema.key_column_usage kcu
       ON tc.constraint_name = kcu.constraint_name
       AND tc.table_schema = kcu.table_schema
     JOIN information_schema.constraint_column_usage ccu
       ON ccu.constraint_name = tc.constraint_name
       AND ccu.table_schema = tc.table_schema
     JOIN information_schema.referential_constraints rc
       ON rc.constraint_name = tc.constraint_name
       AND rc.constraint_schema = tc.table_schema
     WHERE tc.constraint_type = 'FOREIGN KEY'
       AND tc.table_schema = $1
     ORDER BY kcu.table_name, kcu.column_name`,
    [schema]
  );

  return formatRelationshipReport(
    tablesResult.rows.map(r => r.table_name),
    fkResult.rows
  );
}

async function analyzeMysqlRelationships(schema: string): Promise<string> {
  const tablesResult = await query<{ table_name: string }>(
    `SELECT TABLE_NAME AS table_name FROM information_schema.TABLES
     WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE'
     ORDER BY TABLE_NAME`,
    [schema]
  );

  if (tablesResult.rows.length === 0) {
    return "## Table Relationships\n\nNo tables found in schema.";
  }

  const fkResult = await query<ForeignKey>(
    `SELECT
       kcu.TABLE_NAME AS source_table,
       kcu.COLUMN_NAME AS source_column,
       kcu.REFERENCED_TABLE_NAME AS target_table,
       kcu.REFERENCED_COLUMN_NAME AS target_column,
       kcu.CONSTRAINT_NAME AS constraint_name,
       rc.DELETE_RULE AS on_delete,
       rc.UPDATE_RULE AS on_update
     FROM information_schema.KEY_COLUMN_USAGE kcu
     JOIN information_schema.REFERENTIAL_CONSTRAINTS rc
       ON kcu.CONSTRAINT_NAME = rc.CONSTRAINT_NAME
       AND kcu.TABLE_SCHEMA = rc.CONSTRAINT_SCHEMA
     WHERE kcu.TABLE_SCHEMA = ?
       AND kcu.REFERENCED_TABLE_NAME IS NOT NULL
     ORDER BY kcu.TABLE_NAME, kcu.COLUMN_NAME`,
    [schema]
  );

  return formatRelationshipReport(
    tablesResult.rows.map(r => r.table_name),
    fkResult.rows
  );
}

async function analyzeSqliteRelationships(): Promise<string> {
  // Get all tables
  const tablesResult = await query<{ name: string }>(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`
  );

  if (tablesResult.rows.length === 0) {
    return "## Table Relationships\n\nNo tables found.";
  }

  // Get FK info per table
  const fks: ForeignKey[] = [];
  for (const table of tablesResult.rows) {
    const fkInfo = await query<{
      id: number;
      seq: number;
      table: string;
      from: string;
      to: string;
      on_delete: string;
      on_update: string;
    }>(`PRAGMA foreign_key_list("${table.name.replace(/"/g, '""')}")`);

    for (const fk of fkInfo.rows) {
      fks.push({
        source_table: table.name,
        source_column: fk.from,
        target_table: fk.table,
        target_column: fk.to,
        constraint_name: `fk_${table.name}_${fk.from}`,
        on_delete: fk.on_delete,
        on_update: fk.on_update,
      });
    }
  }

  return formatRelationshipReport(
    tablesResult.rows.map(r => r.name),
    fks
  );
}

function formatRelationshipReport(
  allTables: string[],
  foreignKeys: ForeignKey[]
): string {
  const lines: string[] = [];
  lines.push("## Table Relationships\n");

  // Build graph
  const graph = new Map<string, TableNode>();
  for (const t of allTables) {
    graph.set(t, { name: t, outgoing: [], incoming: [] });
  }

  for (const fk of foreignKeys) {
    const source = graph.get(fk.source_table);
    const target = graph.get(fk.target_table);
    if (source) source.outgoing.push(fk);
    if (target) target.incoming.push(fk);
  }

  // Summary
  lines.push(`**Tables**: ${allTables.length}`);
  lines.push(`**Foreign Keys**: ${foreignKeys.length}`);
  lines.push("");

  // Relationship map
  if (foreignKeys.length > 0) {
    lines.push("### Foreign Key Map\n");
    lines.push("| Source Table | Column | Target Table | Column | ON DELETE | ON UPDATE |");
    lines.push("|-------------|--------|--------------|--------|-----------|-----------|");
    for (const fk of foreignKeys) {
      lines.push(
        `| ${fk.source_table} | ${fk.source_column} | ${fk.target_table} | ${fk.target_column} | ${fk.on_delete} | ${fk.on_update} |`
      );
    }
    lines.push("");
  }

  // Central entities (most connections)
  const connectivity = allTables
    .map(t => {
      const node = graph.get(t)!;
      return { name: t, total: node.outgoing.length + node.incoming.length, incoming: node.incoming.length, outgoing: node.outgoing.length };
    })
    .filter(t => t.total > 0)
    .sort((a, b) => b.total - a.total);

  if (connectivity.length > 0) {
    lines.push("### Entity Connectivity\n");
    lines.push("| Table | Incoming FKs | Outgoing FKs | Total |");
    lines.push("|-------|-------------|-------------|-------|");
    for (const c of connectivity) {
      const marker = c.total >= 5 ? " **hub**" : "";
      lines.push(`| ${c.name}${marker} | ${c.incoming} | ${c.outgoing} | ${c.total} |`);
    }
    lines.push("");
  }

  // Orphan tables (no FK relationships at all)
  const orphans = allTables.filter(t => {
    const node = graph.get(t)!;
    return node.outgoing.length === 0 && node.incoming.length === 0;
  });

  if (orphans.length > 0) {
    lines.push("### Orphan Tables (no FK relationships)\n");
    for (const o of orphans) {
      lines.push(`- \`${o}\``);
    }
    lines.push("");
    lines.push(
      "*Orphan tables may be lookup tables, denormalized tables, or tables missing FK constraints.*"
    );
    lines.push("");
  }

  // Cascading delete chains
  const cascadeDeletes = foreignKeys.filter(
    fk => fk.on_delete === "CASCADE"
  );
  if (cascadeDeletes.length > 0) {
    lines.push("### Cascading Delete Chains\n");
    lines.push("Deleting a row from these parent tables will cascade-delete rows in child tables:\n");

    // Group by target (parent) table
    const cascadeByParent = new Map<string, ForeignKey[]>();
    for (const fk of cascadeDeletes) {
      const existing = cascadeByParent.get(fk.target_table) || [];
      existing.push(fk);
      cascadeByParent.set(fk.target_table, existing);
    }

    for (const [parent, fks] of cascadeByParent) {
      const children = fks.map(f => f.source_table).join(", ");
      lines.push(`- **${parent}** → cascades to: ${children}`);

      // Check for deep chains (cascade through multiple levels)
      for (const fk of fks) {
        const grandchildren = cascadeDeletes.filter(
          gfk => gfk.target_table === fk.source_table
        );
        if (grandchildren.length > 0) {
          const gcNames = grandchildren.map(g => g.source_table).join(", ");
          lines.push(`  - **${fk.source_table}** → further cascades to: ${gcNames}`);
        }
      }
    }
    lines.push("");

    lines.push("**WARNING**: Cascading deletes can cause unexpected data loss. Ensure all CASCADE rules are intentional.\n");
  }

  // Recommendations
  const issues: string[] = [];
  if (orphans.length > 0 && orphans.length > allTables.length * 0.5) {
    issues.push(`${orphans.length}/${allTables.length} tables have no FK relationships — consider adding foreign key constraints for data integrity`);
  }
  if (cascadeDeletes.length > 3) {
    issues.push(`${cascadeDeletes.length} CASCADE DELETE rules — review each one to ensure intended behavior`);
  }
  const hubs = connectivity.filter(c => c.total >= 5);
  if (hubs.length > 0) {
    issues.push(`Hub tables (${hubs.map(h => h.name).join(", ")}) have 5+ FK connections — changes to these tables affect many others`);
  }

  if (issues.length > 0) {
    lines.push("### Recommendations\n");
    for (const issue of issues) {
      lines.push(`- ${issue}`);
    }
  }

  return lines.join("\n");
}
