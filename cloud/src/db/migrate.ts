import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { Pool } from 'pg';

// Plain SQL migrations: files named NNNN_description.sql in ./migrations, applied in order, each in its own
// transaction. What was applied is recorded in schema_migrations together with a checksum, so
//   - re-running is a no-op,
//   - an already applied file that was edited afterwards is detected (never silently ignored),
//   - two servers starting at once cannot both migrate (advisory lock).
// There are no "down" migrations on purpose: production rollbacks are done by restoring a backup or by a new forward migration.
export type MigrationFile = { version: number; name: string; sql: string; checksum: string };
export type MigrationStatus = { version: number; name: string; applied: boolean; appliedAt: Date | null; checksumOk: boolean };

const LOCK_KEY = 726_001;   // arbitrary, fixed: "petali migrations"
export const DEFAULT_MIGRATIONS_DIR = path.join(__dirname, 'migrations');

export function loadMigrations(dir = DEFAULT_MIGRATIONS_DIR): MigrationFile[] {
  const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  const seen = new Set<number>();
  return files.map((f) => {
    const m = /^(\d{4})_([a-z0-9_]+)\.sql$/.exec(f);
    if (!m) throw new Error(`Migration file name must look like 0001_name.sql: ${f}`);
    const version = Number(m[1]);
    if (seen.has(version)) throw new Error(`Two migrations share version ${version}`);
    seen.add(version);
    const sql = readFileSync(path.join(dir, f), 'utf8');
    return { version, name: m[2] as string, sql, checksum: createHash('sha256').update(sql).digest('hex') };
  });
}

const ENSURE_TABLE = `CREATE TABLE IF NOT EXISTS schema_migrations (
  version integer PRIMARY KEY, name text NOT NULL, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`;

export async function migrateUp(pool: Pool, dir = DEFAULT_MIGRATIONS_DIR): Promise<{ applied: number[]; schemaVersion: number }> {
  const migrations = loadMigrations(dir);
  const client = await pool.connect();
  const applied: number[] = [];
  try {
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_KEY]);
    await client.query(ENSURE_TABLE);
    const done = new Map<number, string>();
    for (const r of (await client.query<{ version: number; checksum: string }>('SELECT version, checksum FROM schema_migrations')).rows) done.set(r.version, r.checksum);
    for (const v of done.keys()) {
      if (!migrations.some((m) => m.version === v)) throw new Error(`Database has migration ${v} that this build does not know (database is newer than the code)`);
    }
    for (const m of migrations) {
      const known = done.get(m.version);
      if (known !== undefined) {
        if (known !== m.checksum) throw new Error(`Migration ${m.version} (${m.name}) was modified after it was applied; add a new migration instead`);
        continue;
      }
      try {
        await client.query('BEGIN');
        await client.query(m.sql);
        await client.query('INSERT INTO schema_migrations (version, name, checksum) VALUES ($1, $2, $3)', [m.version, m.name, m.checksum]);
        await client.query('COMMIT');
        applied.push(m.version);
      } catch (err) {
        try { await client.query('ROLLBACK'); } catch { /* keep the original error */ }
        throw new Error(`Migration ${m.version} (${m.name}) failed: ${(err as Error).message}`);
      }
    }
    const schemaVersion = migrations.length ? Math.max(...migrations.map((m) => m.version)) : 0;
    return { applied, schemaVersion };
  } finally {
    try { await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]); } catch { /* connection is released anyway */ }
    client.release();
  }
}

export async function migrationStatus(pool: Pool, dir = DEFAULT_MIGRATIONS_DIR): Promise<MigrationStatus[]> {
  const migrations = loadMigrations(dir);
  await pool.query(ENSURE_TABLE);
  const rows = (await pool.query<{ version: number; checksum: string; applied_at: Date }>('SELECT version, checksum, applied_at FROM schema_migrations')).rows;
  const byVersion = new Map(rows.map((r) => [r.version, r]));
  return migrations.map((m) => {
    const r = byVersion.get(m.version);
    return { version: m.version, name: m.name, applied: !!r, appliedAt: r ? r.applied_at : null, checksumOk: !r || r.checksum === m.checksum };
  });
}

export async function currentSchemaVersion(pool: Pool): Promise<number> {
  const r = await pool.query<{ v: number | null }>('SELECT max(version) AS v FROM schema_migrations');
  return r.rows[0]?.v ?? 0;
}
