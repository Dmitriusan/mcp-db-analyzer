import { describe, it, expect, vi, beforeEach } from "vitest";

const mockConnect = vi.fn();
const mockEnd = vi.fn();

vi.mock("pg", () => {
  return {
    default: {
      Pool: function MockPool() {
        return { connect: mockConnect, end: mockEnd };
      },
    },
  };
});

import { createPostgresAdapter } from "../db-postgres.js";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("PostgreSQL connection error wrapping", () => {
  it("should wrap ECONNREFUSED with configuration instructions", async () => {
    mockConnect.mockRejectedValueOnce(
      new Error("connect ECONNREFUSED 127.0.0.1:5432")
    );
    const adapter = createPostgresAdapter();

    try {
      await adapter.query("SELECT 1");
      expect.fail("Should have thrown");
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).toContain("Cannot connect to PostgreSQL");
      expect(msg).toContain("ECONNREFUSED");
      expect(msg).toContain("DATABASE_URL=postgres://");
    }
  });

  it("should wrap auth failure with configuration instructions", async () => {
    mockConnect.mockRejectedValueOnce(
      new Error('password authentication failed for user "postgres"')
    );
    const adapter = createPostgresAdapter();

    try {
      await adapter.query("SELECT 1");
      expect.fail("Should have thrown");
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).toContain("Cannot connect to PostgreSQL");
      expect(msg).toContain("password authentication failed");
      expect(msg).toContain("PGUSER, PGPASSWORD");
    }
  });

  it("should sanitize credentials in connection error messages", async () => {
    mockConnect.mockRejectedValueOnce(
      new Error(
        "connection refused to postgres://admin:secret123@db.example.com:5432/mydb"
      )
    );
    const adapter = createPostgresAdapter();

    try {
      await adapter.query("SELECT 1");
      expect.fail("Should have thrown");
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).toContain("Cannot connect to PostgreSQL");
      expect(msg).not.toContain("secret123");
      expect(msg).toContain("****:****@");
    }
  });

  it("should wrap connection errors for queryUnsafe too", async () => {
    mockConnect.mockRejectedValueOnce(
      new Error("connect ECONNREFUSED 127.0.0.1:5432")
    );
    const adapter = createPostgresAdapter();

    try {
      await adapter.queryUnsafe("EXPLAIN SELECT 1");
      expect.fail("Should have thrown");
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).toContain("Cannot connect to PostgreSQL");
      expect(msg).toContain("DATABASE_URL");
    }
  });

  it("should include all relevant env var names in the error", async () => {
    mockConnect.mockRejectedValueOnce(new Error("connect ECONNREFUSED"));
    const adapter = createPostgresAdapter();

    try {
      await adapter.query("SELECT 1");
      expect.fail("Should have thrown");
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).toContain("DATABASE_URL=postgres://");
      expect(msg).toContain("PGHOST");
      expect(msg).toContain("PGPORT");
      expect(msg).toContain("PGDATABASE");
      expect(msg).toContain("PGUSER");
      expect(msg).toContain("PGPASSWORD");
    }
  });
});
