export type DriverType = "postgres" | "mysql" | "sqlite";

export interface QueryResult<T> {
  rows: T[];
}

export interface DbAdapter {
  query<T>(sql: string, params?: unknown[]): Promise<QueryResult<T>>;
  queryUnsafe<T>(sql: string, params?: unknown[]): Promise<QueryResult<T>>;
  close(): Promise<void>;
  readonly driver: DriverType;
}

let adapter: DbAdapter | null = null;
let driverType: DriverType = "postgres";
let connectionTimeoutMs: number = 30000;

export function getDriverType(): DriverType {
  return driverType;
}

export function getConnectionTimeoutMs(): number {
  return connectionTimeoutMs;
}

export function setConnectionTimeoutMs(ms: number): void {
  connectionTimeoutMs = ms;
}

export function setAdapter(a: DbAdapter): void {
  adapter = a;
  driverType = a.driver;
}

function getAdapter(): DbAdapter {
  if (!adapter) {
    throw new Error(
      "Database adapter not initialized. Call initDriver() first."
    );
  }
  return adapter;
}

export async function initDriver(driver: DriverType): Promise<void> {
  if (driver === "mysql") {
    const { createMysqlAdapter } = await import("./db-mysql.js");
    setAdapter(createMysqlAdapter());
  } else if (driver === "sqlite") {
    const { createSqliteAdapter } = await import("./db-sqlite.js");
    setAdapter(createSqliteAdapter());
  } else {
    const { createPostgresAdapter } = await import("./db-postgres.js");
    setAdapter(createPostgresAdapter());
  }
}

export async function query<T>(
  sql: string,
  params?: unknown[]
): Promise<QueryResult<T>> {
  return getAdapter().query<T>(sql, params);
}

export async function queryUnsafe<T>(
  sql: string,
  params?: unknown[]
): Promise<QueryResult<T>> {
  return getAdapter().queryUnsafe<T>(sql, params);
}

export async function closePool(): Promise<void> {
  if (adapter) {
    await adapter.close();
    adapter = null;
  }
}
