import mysql from "mysql2/promise";
import type { DbAdapter, QueryResult } from "./db.js";
import { getConnectionTimeoutMs } from "./db.js";

function wrapConnectionError(err: unknown): Error {
  const msg = err instanceof Error ? err.message : String(err);
  const sanitized = msg.replace(/\/\/[^@]+@/g, "//****:****@");
  return new Error(
    `Cannot connect to MySQL: ${sanitized}\n\n` +
      `Configure connection using one of:\n` +
      `  DATABASE_URL=mysql://user:pass@host:3306/dbname\n` +
      `  or individual vars: MYSQL_HOST, MYSQL_PORT, MYSQL_DATABASE, MYSQL_USER, MYSQL_PASSWORD`
  );
}

export function createMysqlAdapter(): DbAdapter {
  let pool: mysql.Pool | null = null;

  function getPool(): mysql.Pool {
    if (!pool) {
      const timeoutMs = getConnectionTimeoutMs();
      const uri = process.env.DATABASE_URL;
      if (uri) {
        pool = mysql.createPool({ uri, connectTimeout: timeoutMs });
      } else {
        pool = mysql.createPool({
          host: process.env.MYSQL_HOST || process.env.DB_HOST || "localhost",
          port: parseInt(
            process.env.MYSQL_PORT || process.env.DB_PORT || "3306",
            10
          ),
          database: process.env.MYSQL_DATABASE || process.env.DB_NAME,
          user: process.env.MYSQL_USER || process.env.DB_USER,
          password: process.env.MYSQL_PASSWORD || process.env.DB_PASSWORD,
          connectTimeout: timeoutMs,
        });
      }
    }
    return pool;
  }

  return {
    driver: "mysql" as const,

    async query<T>(sql: string, params?: unknown[]): Promise<QueryResult<T>> {
      let conn: mysql.PoolConnection;
      try {
        conn = await getPool().getConnection();
      } catch (err) {
        throw wrapConnectionError(err);
      }
      try {
        await conn.query("SET SESSION TRANSACTION READ ONLY");
        await conn.beginTransaction();
        try {
          const [rows] = await conn.query(sql, params);
          await conn.rollback();
          return { rows: rows as T[] };
        } catch (err) {
          await conn.rollback();
          throw err;
        }
      } finally {
        conn.release();
      }
    },

    async queryUnsafe<T>(
      sql: string,
      params?: unknown[]
    ): Promise<QueryResult<T>> {
      let conn: mysql.PoolConnection;
      try {
        conn = await getPool().getConnection();
      } catch (err) {
        throw wrapConnectionError(err);
      }
      try {
        const [rows] = await conn.query(sql, params);
        return { rows: rows as T[] };
      } finally {
        conn.release();
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
