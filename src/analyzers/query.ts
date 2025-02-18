import { queryUnsafe, getDriverType } from "../db.js";

interface ExplainNode {
  "Node Type": string;
  "Relation Name"?: string;
  "Alias"?: string;
  "Startup Cost": number;
  "Total Cost": number;
  "Plan Rows": number;
  "Plan Width": number;
  "Actual Startup Time"?: number;
  "Actual Total Time"?: number;
  "Actual Rows"?: number;
  "Actual Loops"?: number;
  "Shared Hit Blocks"?: number;
  "Shared Read Blocks"?: number;
  "Filter"?: string;
  "Rows Removed by Filter"?: number;
  "Index Name"?: string;
  "Index Cond"?: string;
  "Sort Key"?: string[];
  "Sort Method"?: string;
  "Join Type"?: string;
  "Hash Cond"?: string;
  "Merge Cond"?: string;
  Plans?: ExplainNode[];
}

interface ExplainResult {
  Plan: ExplainNode;
  "Planning Time": number;
  "Execution Time": number;
}

/**
 * Run EXPLAIN on a query and return a formatted analysis.
 */
export async function explainQuery(
  sql: string,
  analyze: boolean = false
): Promise<string> {
  // Safety: in ANALYZE mode, only allow pure SELECT statements.
  // EXPLAIN ANALYZE actually executes the query, so we must reject anything
  // that could modify data — including CTEs with write operations.
  if (analyze) {
    const upperSql = sql.trim().toUpperCase();
    const DML_KEYWORDS = ["INSERT", "UPDATE", "DELETE", "DROP", "ALTER", "TRUNCATE", "CREATE", "GRANT", "REVOKE", "COPY"];
    const containsDml = DML_KEYWORDS.some(
      (kw) => upperSql.includes(kw + " ") || upperSql.includes(kw + "\n") || upperSql.includes(kw + "\t") || upperSql.endsWith(kw)
    );
    if (containsDml) {
      return "**Error**: EXPLAIN ANALYZE is only allowed on pure SELECT statements. The query contains write operations that would be executed.";
    }
  }

  const driver = getDriverType();

  if (driver === "sqlite") {
    return explainQuerySqlite(sql);
  }
  if (driver === "mysql") {
    return explainQueryMysql(sql, analyze);
  }

  const explainPrefix = analyze
    ? "EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)"
    : "EXPLAIN (FORMAT JSON)";

  const result = await queryUnsafe<{ "QUERY PLAN": ExplainResult[] }>(
    `${explainPrefix} ${sql}`
  );

  const plan = result.rows[0]?.["QUERY PLAN"]?.[0];
  if (!plan) {
    return "Could not parse query plan.";
  }

  return formatPlan(plan, analyze);
}

async function explainQuerySqlite(sql: string): Promise<string> {
  const result = await queryUnsafe<{
    id: number;
    parent: number;
    notused: number;
    detail: string;
  }>(`EXPLAIN QUERY PLAN ${sql}`);

  if (result.rows.length === 0) {
    return "Could not parse query plan.";
  }

  const lines = ["## Query Plan Analysis (SQLite)\n"];
  lines.push("```");
  for (const row of result.rows) {
    const indent = "  ".repeat(Math.max(0, row.id));
    lines.push(`${indent}${row.detail}`);
  }
  lines.push("```\n");

  // Check for warnings
  const warnings: string[] = [];
  for (const row of result.rows) {
    if (row.detail.includes("SCAN")) {
      const match = row.detail.match(/SCAN (\w+)/);
      if (match) {
        warnings.push(
          `**Full table scan** on \`${match[1]}\`. Consider adding an index on the filtered columns.`
        );
      }
    }
  }

  if (warnings.length > 0) {
    lines.push("### Potential Issues\n");
    for (const w of warnings) {
      lines.push(`- ${w}`);
    }
  }

  return lines.join("\n");
}

async function explainQueryMysql(
  sql: string,
  analyze: boolean
): Promise<string> {
  const prefix = analyze ? "EXPLAIN ANALYZE" : "EXPLAIN FORMAT=JSON";

  if (analyze) {
    // MySQL EXPLAIN ANALYZE returns a text tree, not JSON
    const result = await queryUnsafe<{ EXPLAIN: string }>(
      `${prefix} ${sql}`
    );
    const output = result.rows[0]?.EXPLAIN;
    if (!output) {
      return "Could not parse query plan.";
    }
    const lines = ["## Query Plan Analysis (MySQL EXPLAIN ANALYZE)\n"];
    lines.push("```");
    lines.push(output);
    lines.push("```");
    return lines.join("\n");
  }

  // MySQL EXPLAIN FORMAT=JSON returns a single-column result
  const result = await queryUnsafe<{ EXPLAIN: string }>(
    `${prefix} ${sql}`
  );

  const raw = result.rows[0]?.EXPLAIN;
  if (!raw) {
    return "Could not parse query plan.";
  }

  try {
    const plan = JSON.parse(raw);
    return formatMysqlPlan(plan);
  } catch {
    return `## Query Plan (raw)\n\n\`\`\`json\n${raw}\n\`\`\``;
  }
}

function formatMysqlPlan(plan: Record<string, unknown>): string {
  const lines = ["## Query Plan Analysis (MySQL)\n"];

  const qb = plan.query_block as Record<string, unknown> | undefined;
  if (!qb) {
    lines.push("```json");
    lines.push(JSON.stringify(plan, null, 2));
    lines.push("```");
    return lines.join("\n");
  }

  if (qb.cost_info) {
    const cost = qb.cost_info as Record<string, string>;
    lines.push(`- **Query Cost**: ${cost.query_cost}`);
  }

  lines.push("");
  lines.push("### Plan Details\n");
  lines.push("```json");
  lines.push(JSON.stringify(plan, null, 2));
  lines.push("```");

  // Extract table info for warnings
  const warnings: string[] = [];
  extractMysqlWarnings(plan, warnings);
  if (warnings.length > 0) {
    lines.push("\n### Potential Issues\n");
    for (const w of warnings) {
      lines.push(`- ${w}`);
    }
  }

  return lines.join("\n");
}

function extractMysqlWarnings(
  obj: Record<string, unknown>,
  warnings: string[]
): void {
  if (obj.table) {
    const table = obj.table as Record<string, unknown>;
    const accessType = table.access_type as string | undefined;
    const tableName = table.table_name as string | undefined;
    const rowsExamined = table.rows_examined_per_scan as number | undefined;

    if (accessType === "ALL" && rowsExamined && rowsExamined > 10000) {
      warnings.push(
        `**Full table scan** on \`${tableName}\` (~${rowsExamined} rows). Consider adding an index.`
      );
    }

    if (table.attached_condition) {
      const filtered = table.filtered as number | undefined;
      if (filtered && filtered < 10) {
        warnings.push(
          `**Low selectivity** on \`${tableName}\`: only ${filtered}% of rows match the filter. An index would help.`
        );
      }
    }
  }

  // Recurse into nested objects and arrays
  for (const value of Object.values(obj)) {
    if (Array.isArray(value)) {
      for (const item of value) {
        if (item && typeof item === "object") {
          extractMysqlWarnings(
            item as Record<string, unknown>,
            warnings
          );
        }
      }
    } else if (value && typeof value === "object") {
      extractMysqlWarnings(value as Record<string, unknown>, warnings);
    }
  }
}

function formatPlan(plan: ExplainResult, analyzed: boolean): string {
  const lines: string[] = [];

  lines.push("## Query Plan Analysis\n");

  if (analyzed) {
    lines.push(`- **Planning Time**: ${plan["Planning Time"]} ms`);
    lines.push(`- **Execution Time**: ${plan["Execution Time"]} ms`);
  }

  lines.push(`- **Estimated Total Cost**: ${plan.Plan["Total Cost"]}`);
  lines.push(`- **Estimated Rows**: ${plan.Plan["Plan Rows"]}`);
  lines.push("");

  lines.push("### Plan Tree\n");
  lines.push("```");
  formatNode(plan.Plan, lines, 0);
  lines.push("```\n");

  const warnings = collectWarnings(plan.Plan);
  if (warnings.length > 0) {
    lines.push("### Potential Issues\n");
    for (const w of warnings) {
      lines.push(`- ${w}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

function formatNode(node: ExplainNode, lines: string[], depth: number): void {
  const indent = "  ".repeat(depth);
  let line = `${indent}→ ${node["Node Type"]}`;

  if (node["Relation Name"]) {
    line += ` on ${node["Relation Name"]}`;
    if (node["Alias"] && node["Alias"] !== node["Relation Name"]) {
      line += ` (${node["Alias"]})`;
    }
  }

  if (node["Index Name"]) {
    line += ` using ${node["Index Name"]}`;
  }

  line += ` (cost=${node["Startup Cost"]}..${node["Total Cost"]} rows=${node["Plan Rows"]})`;

  if (node["Actual Total Time"] !== undefined) {
    line += ` (actual time=${node["Actual Startup Time"]}..${node["Actual Total Time"]} rows=${node["Actual Rows"]} loops=${node["Actual Loops"]})`;
  }

  lines.push(line);

  if (node["Filter"]) {
    lines.push(`${indent}  Filter: ${node["Filter"]}`);
    if (node["Rows Removed by Filter"]) {
      lines.push(
        `${indent}  Rows Removed by Filter: ${node["Rows Removed by Filter"]}`
      );
    }
  }

  if (node["Index Cond"]) {
    lines.push(`${indent}  Index Cond: ${node["Index Cond"]}`);
  }

  if (node["Hash Cond"]) {
    lines.push(`${indent}  Hash Cond: ${node["Hash Cond"]}`);
  }

  if (node["Sort Key"]) {
    lines.push(`${indent}  Sort Key: ${node["Sort Key"].join(", ")}`);
  }

  if (node["Shared Hit Blocks"] !== undefined || node["Shared Read Blocks"] !== undefined) {
    lines.push(
      `${indent}  Buffers: shared hit=${node["Shared Hit Blocks"] ?? 0} read=${node["Shared Read Blocks"] ?? 0}`
    );
  }

  if (node.Plans) {
    for (const child of node.Plans) {
      formatNode(child, lines, depth + 1);
    }
  }
}

function collectWarnings(node: ExplainNode): string[] {
  const warnings: string[] = [];

  if (node["Node Type"] === "Seq Scan" && node["Plan Rows"] > 10000) {
    warnings.push(
      `**Sequential Scan** on \`${node["Relation Name"]}\` (~${node["Plan Rows"]} rows). Consider adding an index on the filtered columns.`
    );
  }

  if (
    node["Rows Removed by Filter"] &&
    node["Actual Rows"] !== undefined &&
    node["Rows Removed by Filter"] > node["Actual Rows"] * 10
  ) {
    warnings.push(
      `**High filter ratio** on \`${node["Relation Name"] ?? node["Node Type"]}\`: ${node["Rows Removed by Filter"]} rows removed vs ${node["Actual Rows"]} kept. An index on the filter column would eliminate this.`
    );
  }

  if (
    node["Node Type"] === "Nested Loop" &&
    node["Actual Rows"] !== undefined &&
    node["Actual Rows"] > 10000
  ) {
    warnings.push(
      `**Nested Loop** producing ${node["Actual Rows"]} rows. Consider if a Hash Join or Merge Join would be more efficient.`
    );
  }

  if (node["Sort Method"] === "external merge") {
    warnings.push(
      `**Disk sort** detected. Increase \`work_mem\` or add an index to avoid sorting.`
    );
  }

  if (node.Plans) {
    for (const child of node.Plans) {
      warnings.push(...collectWarnings(child));
    }
  }

  return warnings;
}
