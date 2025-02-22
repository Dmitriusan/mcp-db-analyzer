import { describe, it, expect } from "vitest";
import { validateLicense, formatUpgradePrompt } from "../license.js";

describe("DB Analyzer license validation", () => {
  it("returns free mode when no key", () => {
    const result = validateLicense(undefined, "db-analyzer");
    expect(result.isPro).toBe(false);
    expect(result.reason).toBe("No license key provided");
  });

  it("returns free mode for empty string", () => {
    const result = validateLicense("", "db-analyzer");
    expect(result.isPro).toBe(false);
  });

  it("returns free mode for invalid key", () => {
    const result = validateLicense("MCPJBS-AAAAA-AAAAA-AAAAA-AAAAA", "db-analyzer");
    expect(result.isPro).toBe(false);
  });

  it("returns free mode for wrong prefix", () => {
    const result = validateLicense("WRONG-AAAAA-AAAAA-AAAAA-AAAAA", "db-analyzer");
    expect(result.isPro).toBe(false);
    expect(result.reason).toContain("missing MCPJBS- prefix");
  });

  it("returns free mode for truncated key", () => {
    const result = validateLicense("MCPJBS-AAAA", "db-analyzer");
    expect(result.isPro).toBe(false);
    expect(result.reason).toContain("too short");
  });
});

describe("DB Analyzer upgrade prompts", () => {
  const proTools = [
    ["analyze_slow_queries", "Slow query analysis"],
    ["analyze_connections", "Connection analysis"],
    ["analyze_table_relationships", "Table relationship analysis"],
    ["suggest_missing_indexes", "Actionable index recommendations"],
  ] as const;

  for (const [tool, desc] of proTools) {
    it(`${tool} prompt includes tool name and pricing`, () => {
      const prompt = formatUpgradePrompt(tool, desc);
      expect(prompt).toContain(`${tool} (Pro Feature)`);
      expect(prompt).toContain("MCP_LICENSE_KEY");
      expect(prompt).toContain("mcpjbs.dev/pricing");
      expect(prompt).toContain("$19/month");
    });
  }
});
