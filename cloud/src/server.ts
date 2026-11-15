import { loadConfig, ConfigError } from './config/env';
import { runMaintenance } from './db/maintenance';
import { migrateUp } from './db/migrate';
import { createPool } from './db/pool';
import { createApp } from './http/app';
import { createLogger } from './lib/logger';

async function main(): Promise<void> {
  let config;
  try { config = loadConfig(); } catch (err) {
    if (err instanceof ConfigError) { console.error(err.message); process.exit(1); }
    throw err;
  }
  const log = createLogger(config.logLevel);
  const pool = createPool(config);
  pool.on('error', (err) => log.error({ err: err.message }, 'idle database client error'));

  // The schema is brought up to date before the server accepts traffic (advisory-locked, safe with several instances).
  const m = await migrateUp(pool);
  log.info({ applied: m.applied, schemaVersion: m.schemaVersion }, 'database ready');

  const app = await createApp({ config, pool, log });
  const server = app.listen(config.port, config.host, () => log.info({ host: config.host, port: config.port, env: config.env }, 'petali cloud listening'));

  const maintenance = setInterval(() => { runMaintenance(pool).then((r) => log.info(r, 'maintenance done'), (e) => log.error({ err: (e as Error).message }, 'maintenance failed')); }, 6 * 3_600_000);
  maintenance.unref();

  let stopping = false;
  const stop = (signal: string) => {
    if (stopping) return;
    stopping = true;
    log.info({ signal }, 'shutting down');
    clearInterval(maintenance);
    server.close(() => { pool.end().finally(() => process.exit(0)); });
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('SIGINT', () => stop('SIGINT'));
}

main().catch((err) => { console.error('Fatal start-up error:', err instanceof Error ? err.message : err); process.exit(1); });
