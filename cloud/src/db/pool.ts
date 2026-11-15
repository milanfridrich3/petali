import { Pool, type PoolClient, type PoolConfig, type QueryResultRow } from 'pg';
import type { Config } from '../config/env';

export type Queryable = {
  query<R extends QueryResultRow = QueryResultRow>(text: string, params?: unknown[]): Promise<{ rows: R[]; rowCount: number | null }>;
};

export function createPool(config: Pick<Config, 'databaseUrl' | 'databaseSsl' | 'dbPoolMax'>, extra: PoolConfig = {}): Pool {
  return new Pool({
    connectionString: config.databaseUrl,
    ssl: config.databaseSsl ? { rejectUnauthorized: true } : undefined,
    max: config.dbPoolMax,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    statement_timeout: 15_000,
    ...extra,
  });
}

// Runs fn inside one transaction (commit on success, rollback on any error).
export async function withTransaction<T>(pool: Pool, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* the original error matters more */ }
    throw err;
  } finally {
    client.release();
  }
}

export const isUniqueViolation = (err: unknown, constraint?: string): boolean => {
  const e = err as { code?: string; constraint?: string } | null;
  return !!e && e.code === '23505' && (constraint === undefined || e.constraint === constraint);
};
