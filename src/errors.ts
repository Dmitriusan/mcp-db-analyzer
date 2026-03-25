/**
 * Format tool errors with connection-specific guidance when applicable.
 * Sanitizes credentials from error messages.
 */
export function formatToolError(context: string, err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  // Sanitize URL-style credentials (postgresql://user:pass@host) and
  // key-value style passwords (password=secret) used by libpq and JDBC.
  const sanitized = msg
    .replace(/\/\/[^@]+@/g, "//****:****@")
    .replace(/\bpassword\s*=\s*\S+/gi, "password=****");
  const isConnectionError =
    /ECONNREFUSED|ENOTFOUND|ETIMEDOUT|EHOSTUNREACH|getaddrinfo|connect ECONNRESET|password authentication failed|Access denied|no pg_hba\.conf|connection refused|Connection lost|SQLITE_CANTOPEN/i.test(
      msg
    );
  if (isConnectionError) {
    return `Error ${context}: ${sanitized}\n\nThis looks like a database connection issue. Check your configuration:\n- Set DATABASE_URL environment variable with a valid connection string\n- Or use driver-specific variables (PGHOST, MYSQL_HOST, SQLITE_PATH)\n- Ensure the database server is running and accessible`;
  }
  return `Error ${context}: ${sanitized}`;
}
