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

/**
 * Detect cycles in the FK dependency graph using iterative DFS.
 * Returns each unique cycle as an ordered list of table names with the
 * first node repeated at the end to show closure (e.g. ["a","b","c","a"]).
 */
function findFkCycles(
  allTables: string[],
  graph: Map<string, TableNode>
): string[][] {
  const visited = new Set<string>();
  const onStack = new Set<string>();
  const stackPath: string[] = [];
  const cycles: string[][] = [];
  const seenCycleKeys = new Set<string>();

  function dfs(node: string): void {
    visited.add(node);
    onStack.add(node);
    stackPath.push(node);

    const nodeData = graph.get(node);
    if (nodeData) {
      for (const fk of nodeData.outgoing) {
        const neighbor = fk.target_table;
        if (onStack.has(neighbor)) {
          // Back edge found — extract the cycle
          const cycleStartIdx = stackPath.indexOf(neighbor);
          if (cycleStartIdx !== -1) {
            const cycleNodes = stackPath.slice(cycleStartIdx);
            // Normalize: rotate so lexicographically smallest node is first
            const minNode = cycleNodes.reduce((a, b) => (a < b ? a : b));
            const minIdx = cycleNodes.indexOf(minNode);
            const normalized = [
              ...cycleNodes.slice(minIdx),
              ...cycleNodes.slice(0, minIdx),
            ];
            const key = normalized.join("\0");
            if (!seenCycleKeys.has(key)) {
              seenCycleKeys.add(key);
              cycles.push([...normalized, normalized[0]]); // close the cycle
            }
          }
        } else if (!visited.has(neighbor)) {
          dfs(neighbor);
        }
      }
    }

    stackPath.pop();
    onStack.delete(node);
  }

  for (const table of allTables) {
    if (!visited.has(table)) {
      dfs(table);
    }
  }

  return cycles;
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

  // Circular FK dependencies
  const cycles = findFkCycles(allTables, graph);
  if (cycles.length > 0) {
    lines.push("### Circular FK Dependencies\n");
    lines.push(
      "These tables form circular foreign key references. Cycles complicate cascade operations, " +
      "schema migrations, and may cause issues with certain ORMs and migration tools:\n"
    );
    for (const cycle of cycles) {
      lines.push(`- ${cycle.join(" → ")}`);
    }
    lines.push(
      "\n**Note**: Circular FKs are sometimes intentional (e.g., a 'current_record' pointer back to a parent). " +
      "Review each cycle to confirm the design is correct.\n"
    );
  }

  // Cascading delete chains
  const cascadeDeletes = foreignKeys.filter(fk => fk.on_delete === "CASCADE");
  if (cascadeDeletes.length > 0) {
    lines.push("### Cascading Delete Chains\n");
    lines.push("Deleting a row from these parent tables will cascade-delete rows in child tables:\n");

    // Build parent→children map for cascade edges only
    const cascadeChildren = new Map<string, string[]>();
    for (const fk of cascadeDeletes) {
      const existing = cascadeChildren.get(fk.target_table) || [];
      if (!existing.includes(fk.source_table)) existing.push(fk.source_table);
      cascadeChildren.set(fk.target_table, existing);
    }

    // Identify root cascade tables: have cascade children but are not cascade children themselves
    const allCascadeChildTables = new Set(cascadeDeletes.map(fk => fk.source_table));
    const cascadeRoots = [...cascadeChildren.keys()].filter(
      t => !allCascadeChildTables.has(t)
    );
    // Fall back to all parents if every parent is also a child (full cycle)
    const parentsToShow =
      cascadeRoots.length > 0 ? cascadeRoots : [...cascadeChildren.keys()];

    // Recursively render the cascade chain under a given parent
    function renderCascadeChain(
      parent: string,
      indent: number,
      visited: Set<string>
    ): void {
      const children = cascadeChildren.get(parent) || [];
      const prefix = "  ".repeat(indent);
      for (const child of children) {
        if (visited.has(child)) {
          lines.push(`${prefix}- **${child}** *(circular)*`);
        } else if (cascadeChildren.has(child)) {
          lines.push(`${prefix}- **${child}** →`);
          renderCascadeChain(child, indent + 1, new Set([...visited, child]));
        } else {
          lines.push(`${prefix}- **${child}**`);
        }
      }
    }

    for (const root of parentsToShow) {
      lines.push(`- **${root}** → cascades to:`);
      renderCascadeChain(root, 1, new Set([root]));
    }
    lines.push("");

    lines.push(
      "**WARNING**: Cascading deletes can cause unexpected data loss. Ensure all CASCADE rules are intentional.\n"
    );
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
  if (cycles.length > 0) {
    issues.push(`${cycles.length} circular FK reference(s) detected — review for unintended schema design`);
  }

  if (issues.length > 0) {
    lines.push("### Recommendations\n");
    for (const issue of issues) {
      lines.push(`- ${issue}`);
    }
  }

  return lines.join("\n");
}
