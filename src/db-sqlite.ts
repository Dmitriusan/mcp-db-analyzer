import Database from "better-sqlite3";
import type { DbAdapter, QueryResult } from "./db.js";

export function createSqliteAdapter(): DbAdapter {
  let db: Database.Database | null = null;

  function getDb(): Database.Database {
    if (!db) {
      const dbPath =
        process.env.DATABASE_URL ||
        process.env.SQLITE_PATH ||
        process.env.DB_PATH;

      if (!dbPath) {
        throw new Error(
          "SQLite path not configured. Set DATABASE_URL, SQLITE_PATH, or DB_PATH."
        );
      }

      db = new Database(dbPath, { readonly: true });
      db.pragma("journal_mode = WAL");
    }
    return db;
  }

  return {
    driver: "sqlite" as const,

    async query<T>(sql: string, params?: unknown[]): Promise<QueryResult<T>> {
      const stmt = getDb().prepare(sql);
      const rows = params ? stmt.all(...params) : stmt.all();
      return { rows: rows as T[] };
    },

    async queryUnsafe<T>(
      sql: string,
      params?: unknown[]
    ): Promise<QueryResult<T>> {
      const stmt = getDb().prepare(sql);
      const rows = params ? stmt.all(...params) : stmt.all();
      return { rows: rows as T[] };
    },

    async close(): Promise<void> {
      if (db) {
        db.close();
        db = null;
      }
    },
  };
}
