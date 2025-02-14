import pg from "pg";
import type { DbAdapter, QueryResult } from "./db.js";

const { Pool } = pg;

function wrapConnectionError(err: unknown): Error {
  const msg = err instanceof Error ? err.message : String(err);
  const sanitized = msg.replace(/\/\/[^@]+@/g, "//****:****@");
  return new Error(
    `Cannot connect to PostgreSQL: ${sanitized}\n\n` +
      `Configure connection using one of:\n` +
      `  DATABASE_URL=postgres://user:pass@host:5432/dbname\n` +
      `  or individual vars: PGHOST, PGPORT, PGDATABASE, PGUSER, PGPASSWORD`
  );
}

export function createPostgresAdapter(): DbAdapter {
  let pool: pg.Pool | null = null;

  function getPool(): pg.Pool {
    if (!pool) {
      const connectionString = process.env.DATABASE_URL;
      if (connectionString) {
        pool = new Pool({ connectionString });
      } else {
        pool = new Pool({
          host: process.env.PGHOST || "localhost",
          port: parseInt(process.env.PGPORT || "5432", 10),
          database: process.env.PGDATABASE || "postgres",
          user: process.env.PGUSER,
          password: process.env.PGPASSWORD,
        });
      }
    }
    return pool;
  }

  return {
    driver: "postgres" as const,

    async query<T>(sql: string, params?: unknown[]): Promise<QueryResult<T>> {
      let client: pg.PoolClient;
      try {
        client = await getPool().connect();
      } catch (err) {
        throw wrapConnectionError(err);
      }
      try {
        await client.query("SET TRANSACTION READ ONLY");
        const result = await client.query<T & pg.QueryResultRow>(sql, params);
        return { rows: result.rows };
      } finally {
        client.release();
      }
    },

    async queryUnsafe<T>(
      sql: string,
      params?: unknown[]
    ): Promise<QueryResult<T>> {
      let client: pg.PoolClient;
      try {
        client = await getPool().connect();
      } catch (err) {
        throw wrapConnectionError(err);
      }
      try {
        const result = await client.query<T & pg.QueryResultRow>(sql, params);
        return { rows: result.rows };
      } finally {
        client.release();
      }
    },

    async close(): Promise<void> {
      if (pool) {
        await pool.end();
        pool = null;
      }
    },
  };
}
