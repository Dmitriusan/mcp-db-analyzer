import { describe, it, expect } from "vitest";
import { formatToolError } from "../errors.js";

describe("formatToolError", () => {
  it("should add connection advice for ECONNREFUSED", () => {
    const err = new Error("connect ECONNREFUSED 127.0.0.1:5432");
    const result = formatToolError("inspecting schema", err);
    expect(result).toContain("Error inspecting schema");
    expect(result).toContain("ECONNREFUSED");
    expect(result).toContain("database connection issue");
    expect(result).toContain("DATABASE_URL");
    expect(result).toContain("PGHOST");
  });

  it("should add connection advice for password authentication failed", () => {
    const err = new Error('password authentication failed for user "postgres"');
    const result = formatToolError("analyzing indexes", err);
    expect(result).toContain("database connection issue");
    expect(result).toContain("DATABASE_URL");
  });

  it("should add connection advice for ENOTFOUND", () => {
    const err = new Error("getaddrinfo ENOTFOUND db.example.com");
    const result = formatToolError("analyzing bloat", err);
    expect(result).toContain("database connection issue");
  });

  it("should add connection advice for ETIMEDOUT", () => {
    const err = new Error("connect ETIMEDOUT 10.0.0.1:5432");
    const result = formatToolError("explaining query", err);
    expect(result).toContain("database connection issue");
  });

  it("should add connection advice for MySQL Access denied", () => {
    const err = new Error("Access denied for user 'root'@'localhost'");
    const result = formatToolError("analyzing indexes", err);
    expect(result).toContain("database connection issue");
    expect(result).toContain("MYSQL_HOST");
  });

  it("should add connection advice for SQLITE_CANTOPEN", () => {
    const err = new Error("SQLITE_CANTOPEN: unable to open database file");
    const result = formatToolError("inspecting schema", err);
    expect(result).toContain("database connection issue");
    expect(result).toContain("SQLITE_PATH");
  });

  it("should NOT add connection advice for regular errors", () => {
    const err = new Error("relation 'users' does not exist");
    const result = formatToolError("inspecting schema", err);
    expect(result).toContain("Error inspecting schema");
    expect(result).toContain("relation 'users' does not exist");
    expect(result).not.toContain("database connection issue");
  });

  it("should sanitize credentials from error messages", () => {
    const err = new Error(
      "connect ECONNREFUSED postgresql://admin:s3cret@db.host:5432/mydb"
    );
    const result = formatToolError("inspecting schema", err);
    expect(result).not.toContain("s3cret");
    expect(result).toContain("****:****@");
  });

  it("should handle non-Error objects", () => {
    const result = formatToolError("inspecting schema", "string error");
    expect(result).toContain("Error inspecting schema: string error");
  });

  it("should sanitize password= key-value style credentials", () => {
    const err = new Error(
      "FATAL: password authentication failed host=db.example.com password=s3cr3t dbname=myapp"
    );
    const result = formatToolError("inspecting schema", err);
    expect(result).not.toContain("s3cr3t");
    expect(result).toContain("password=****");
  });

  it("should handle undefined/null errors", () => {
    const result = formatToolError("inspecting schema", undefined);
    expect(result).toContain("Error inspecting schema: undefined");
  });
});
