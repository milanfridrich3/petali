import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { Writable } from 'node:stream';
import type { Server } from 'node:http';
import { Pool } from 'pg';
import { loadConfig, type Config } from '../src/config/env';
import { migrateUp } from '../src/db/migrate';
import { createApp } from '../src/http/app';
import { createLogger } from '../src/lib/logger';
import { createPasswordHasher } from '../src/modules/auth/passwords';

export const TEST_DATABASE_URL = process.env['TEST_DATABASE_URL'];
if (!TEST_DATABASE_URL) throw new Error('Set TEST_DATABASE_URL to a PostgreSQL database the tests may create schemas in (see cloud/README.md).');

export const STRONG = 'correct horse battery staple';
export type Resp = { status: number; json: any; headers: Headers; text: string };

export type TestEnv = {
  base: string; pool: Pool; config: Config; logLines: string[]; schema: string;
  clock: { now: number; advance(ms: number): void };
  call(method: string, path: string, opts?: { body?: unknown; token?: string; headers?: Record<string, string>; raw?: string }): Promise<Resp>;
  register(email?: string, password?: string, extra?: Record<string, unknown>): Promise<{ user: any; tokens: any; email: string; password: string }>;
  close(): Promise<void>;
};

export async function createTestEnv(overrides: Record<string, string> = {}, appOverrides: { generateId?: () => string } = {}): Promise<TestEnv> {
  const schema = `t_${randomBytes(6).toString('hex')}`;
  const admin = new Pool({ connectionString: TEST_DATABASE_URL, max: 1 });
  await admin.query(`CREATE SCHEMA ${schema}`);
  await admin.end();
  const config = loadConfig({
    NODE_ENV: 'test', DATABASE_URL: TEST_DATABASE_URL, JWT_ACCESS_SECRET: randomBytes(48).toString('base64'), LOG_LEVEL: 'info',
    ARGON2_MEMORY_KIB: '2048', ARGON2_TIME_COST: '1', RATE_LIMIT_REGISTER_MAX: '100000', RATE_LIMIT_LOGIN_MAX: '100000',
    RATE_LIMIT_REFRESH_MAX: '100000', RATE_LIMIT_SENSITIVE_MAX: '100000', RATE_LIMIT_GENERAL_MAX: '1000000', ...overrides,
  });
  const pool = new Pool({ connectionString: TEST_DATABASE_URL, max: 8, options: `-c search_path=${schema}` });
  await migrateUp(pool);
  const logLines: string[] = [];
  const sink = new Writable({ write(chunk, _enc, cb) { logLines.push(String(chunk)); cb(); } });
  const log = createLogger('info', sink);
  const clock = { now: Date.now(), advance(ms: number) { this.now += ms; } };
  const hasher = await createPasswordHasher(config.argon2);
  const app = await createApp({ config, pool, log, hasher, now: () => clock.now, ...appOverrides });
  const server: Server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  let counter = 0;

  const call: TestEnv['call'] = async (method, path, opts = {}) => {
    const headers: Record<string, string> = { ...(opts.headers ?? {}) };
    if (opts.token) headers['authorization'] = `Bearer ${opts.token}`;
    let body: string | undefined;
    if (opts.raw !== undefined) { body = opts.raw; } else if (opts.body !== undefined) { body = JSON.stringify(opts.body); headers['content-type'] ??= 'application/json'; }
    const res = await fetch(base + path, { method, headers, ...(body !== undefined ? { body } : {}) });
    const text = await res.text();
    let json: any = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
    return { status: res.status, json, headers: res.headers, text };
  };

  return {
    base, pool, config, logLines, schema, clock, call,
    async register(email, password = STRONG, extra = {}) {
      counter += 1;
      const e = email ?? `user${counter}-${randomBytes(3).toString('hex')}@example.com`;
      const r = await call('POST', '/v1/auth/register', { body: { email: e, password, ...extra } });
      if (r.status !== 201) throw new Error(`register failed: ${r.status} ${r.text}`);
      return { user: r.json.user, tokens: r.json.tokens, email: e, password };
    },
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await pool.end();
      const a = new Pool({ connectionString: TEST_DATABASE_URL, max: 1 });
      await a.query(`DROP SCHEMA ${schema} CASCADE`);
      await a.end();
    },
  };
}
