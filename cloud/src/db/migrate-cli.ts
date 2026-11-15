import { loadConfig } from '../config/env';
import { createPool } from './pool';
import { migrateUp, migrationStatus } from './migrate';

async function main(): Promise<void> {
  const cmd = process.argv[2] ?? 'up';
  const config = loadConfig();
  const pool = createPool(config);
  try {
    if (cmd === 'up') {
      const r = await migrateUp(pool);
      console.log(r.applied.length ? `Applied migrations: ${r.applied.join(', ')}` : 'Database is up to date.');
      console.log(`Schema version: ${r.schemaVersion}`);
    } else if (cmd === 'status') {
      for (const s of await migrationStatus(pool)) console.log(`${String(s.version).padStart(4, '0')} ${s.name} ${s.applied ? `applied ${s.appliedAt?.toISOString()}` : 'PENDING'}${s.checksumOk ? '' : '  CHECKSUM MISMATCH'}`);
    } else {
      console.error('Usage: migrate-cli (up|status)');
      process.exitCode = 2;
    }
  } finally {
    await pool.end();
  }
}

main().catch((err) => { console.error(err instanceof Error ? err.message : err); process.exit(1); });
