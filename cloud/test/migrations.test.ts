import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, copyFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { describe, it, before, after } from 'node:test';
import { Pool } from 'pg';
import { DEFAULT_MIGRATIONS_DIR, loadMigrations, migrateUp, migrationStatus, currentSchemaVersion } from '../src/db/migrate';
import { TEST_DATABASE_URL } from './helpers';

describe('database migrations', () => {
  let admin: Pool; let schema: string; let pool: Pool;
  before(async () => {
    admin = new Pool({ connectionString: TEST_DATABASE_URL, max: 1 });
    schema = `m_${randomBytes(6).toString('hex')}`;
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new Pool({ connectionString: TEST_DATABASE_URL, max: 4, options: `-c search_path=${schema}` });
  });
  after(async () => { await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); });

  it('applies every migration to an empty database and records the schema version', async () => {
    const r = await migrateUp(pool);
    assert.deepEqual(r.applied, loadMigrations().map((m) => m.version));
    assert.equal(await currentSchemaVersion(pool), r.schemaVersion);
    const tables = (await pool.query(`SELECT table_name FROM information_schema.tables WHERE table_schema = $1 ORDER BY 1`, [schema])).rows.map((x) => x.table_name);
    for (const t of ['users', 'sessions', 'account_settings', 'devices', 'security_events', 'login_throttle', 'schema_migrations']) assert.ok(tables.includes(t), `table ${t}`);
  });

  it('running again changes nothing', async () => {
    const r = await migrateUp(pool);
    assert.deepEqual(r.applied, []);
  });

  it('two servers starting at once do not both migrate', async () => {
    const s2 = `m_${randomBytes(6).toString('hex')}`;
    await admin.query(`CREATE SCHEMA ${s2}`);
    const p = () => new Pool({ connectionString: TEST_DATABASE_URL, max: 2, options: `-c search_path=${s2}` });
    const a = p(); const b = p();
    try {
      const [ra, rb] = await Promise.all([migrateUp(a), migrateUp(b)]);
      assert.equal(ra.applied.length + rb.applied.length, loadMigrations().length, 'each migration applied exactly once');
    } finally { await a.end(); await b.end(); await admin.query(`DROP SCHEMA ${s2} CASCADE`); }
  });

  it('status reports applied migrations with matching checksums', async () => {
    const s = await migrationStatus(pool);
    assert.ok(s.every((x) => x.applied && x.checksumOk));
  });

  it('detects a migration file that was edited after it was applied', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'mig-'));
    try {
      for (const m of loadMigrations()) copyFileSync(path.join(DEFAULT_MIGRATIONS_DIR, `${String(m.version).padStart(4, '0')}_${m.name}.sql`), path.join(dir, `${String(m.version).padStart(4, '0')}_${m.name}.sql`));
      writeFileSync(path.join(dir, '0001_initial_schema.sql'), '-- edited\n' + (await import('node:fs')).readFileSync(path.join(DEFAULT_MIGRATIONS_DIR, '0001_initial_schema.sql'), 'utf8'));
      await assert.rejects(migrateUp(pool, dir), /modified after it was applied/);
      assert.equal((await migrationStatus(pool, dir))[0]?.checksumOk, false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('refuses to run against a database that is newer than the code', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'mig-'));
    try { await assert.rejects(migrateUp(pool, dir), /newer than the code/); } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('a failing migration rolls back completely and is not recorded', async () => {
    const s3 = `m_${randomBytes(6).toString('hex')}`;
    await admin.query(`CREATE SCHEMA ${s3}`);
    const p = new Pool({ connectionString: TEST_DATABASE_URL, max: 2, options: `-c search_path=${s3}` });
    const dir = mkdtempSync(path.join(tmpdir(), 'mig-'));
    try {
      writeFileSync(path.join(dir, '0001_bad.sql'), 'CREATE TABLE ok_table (id int); SELECT * FROM table_that_does_not_exist;');
      await assert.rejects(migrateUp(p, dir), /Migration 1 \(bad\) failed/);
      const t = await p.query(`SELECT to_regclass('ok_table') AS t`);
      assert.equal(t.rows[0].t, null, 'nothing half-applied');
      assert.equal((await p.query('SELECT count(*)::int AS n FROM schema_migrations')).rows[0].n, 0);
    } finally { rmSync(dir, { recursive: true, force: true }); await p.end(); await admin.query(`DROP SCHEMA ${s3} CASCADE`); }
  });

  it('rejects badly named migration files', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'mig-'));
    try { writeFileSync(path.join(dir, 'oops.sql'), 'select 1'); assert.throws(() => loadMigrations(dir), /must look like/); } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('schema rules (ownership, uniqueness, timestamps)', () => {
  let admin: Pool; let schema: string; let pool: Pool;
  before(async () => {
    admin = new Pool({ connectionString: TEST_DATABASE_URL, max: 1 });
    schema = `m_${randomBytes(6).toString('hex')}`;
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new Pool({ connectionString: TEST_DATABASE_URL, max: 4, options: `-c search_path=${schema}` });
    await migrateUp(pool);
  });
  after(async () => { await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); });

  const insertUser = (id: string, email: string) => pool.query(`INSERT INTO users (petali_id, email, email_normalized, password_hash) VALUES ($1,$2,$3,'h') RETURNING id`, [id, email, email.toLowerCase()]);

  it('email uniqueness is on the normalized form', async () => {
    await insertUser('PTL-0000-0000-0001', 'A@x.com');
    await assert.rejects(insertUser('PTL-0000-0000-0002', 'a@X.com'), /users_email_normalized_key/);
  });
  it('rejects a malformed Petali ID', async () => {
    await assert.rejects(insertUser('ptl-0000-0000-0003', 'b@x.com'), /users_petali_id_format/);
    await assert.rejects(insertUser('PTL-0000-0000-000I', 'c@x.com'), /users_petali_id_format/);
  });
  it('updated_at moves on update, created_at and id cannot be changed', async () => {
    const u = (await insertUser('PTL-0000-0000-0004', 'd@x.com')).rows[0].id;
    const before = (await pool.query('SELECT created_at, updated_at FROM users WHERE id = $1', [u])).rows[0];
    await new Promise((r) => setTimeout(r, 15));
    await pool.query(`UPDATE users SET display_name = 'D' WHERE id = $1`, [u]);
    const after = (await pool.query('SELECT created_at, updated_at FROM users WHERE id = $1', [u])).rows[0];
    assert.ok(after.updated_at > before.updated_at);
    assert.equal(after.created_at.getTime(), before.created_at.getTime());
    await assert.rejects(pool.query(`UPDATE users SET created_at = now() - interval '1 year' WHERE id = $1`, [u]), /cannot be changed/);
  });
  it('deleting a user removes everything they own (sessions, settings, devices, events)', async () => {
    const u = (await insertUser('PTL-0000-0000-0005', 'e@x.com')).rows[0].id;
    await pool.query(`INSERT INTO account_settings (user_id) VALUES ($1)`, [u]);
    await pool.query(`INSERT INTO devices (user_id, name) VALUES ($1, 'PC')`, [u]);
    await pool.query(`INSERT INTO sessions (user_id, refresh_hash, expires_at, max_expires_at) VALUES ($1, 'h1', now() + interval '1 day', now() + interval '1 day')`, [u]);
    await pool.query(`INSERT INTO security_events (user_id, type) VALUES ($1, 'login')`, [u]);
    await pool.query('DELETE FROM users WHERE id = $1', [u]);
    for (const t of ['account_settings', 'devices', 'sessions', 'security_events']) assert.equal((await pool.query(`SELECT count(*)::int AS n FROM ${t} WHERE user_id = $1`, [u])).rows[0].n, 0, t);
  });
  it('rows cannot point at a user that does not exist', async () => {
    await assert.rejects(pool.query(`INSERT INTO devices (user_id, name) VALUES (gen_random_uuid(), 'x')`), /foreign key/);
    await assert.rejects(pool.query(`INSERT INTO sessions (user_id, refresh_hash, expires_at, max_expires_at) VALUES (gen_random_uuid(), 'h2', now(), now())`), /foreign key/);
  });
  it('refresh hashes are unique and settings must be a JSON object', async () => {
    const u = (await insertUser('PTL-0000-0000-0006', 'f@x.com')).rows[0].id;
    await pool.query(`INSERT INTO sessions (user_id, refresh_hash, expires_at, max_expires_at) VALUES ($1, 'dup', now(), now())`, [u]);
    await assert.rejects(pool.query(`INSERT INTO sessions (user_id, refresh_hash, expires_at, max_expires_at) VALUES ($1, 'dup', now(), now())`, [u]), /sessions_refresh_hash_key/);
    await assert.rejects(pool.query(`INSERT INTO account_settings (user_id, settings) VALUES ($1, '[]'::jsonb)`, [u]), /account_settings_is_object/);
  });
  it('indexes for the hot paths exist', async () => {
    const idx = (await pool.query(`SELECT indexname FROM pg_indexes WHERE schemaname = $1`, [schema])).rows.map((r) => r.indexname);
    for (const i of ['users_petali_id_key', 'users_email_normalized_key', 'sessions_refresh_hash_key', 'sessions_user_active_idx', 'devices_user_id_idx', 'security_events_user_idx']) assert.ok(idx.includes(i), i);
  });
});

describe('migration 0002 (sync) is additive', () => {
  it('upgrades a populated version-1 database without losing or changing any data', async () => {
    const admin = new Pool({ connectionString: TEST_DATABASE_URL, max: 1 });
    const schema = `m_${randomBytes(6).toString('hex')}`;
    await admin.query(`CREATE SCHEMA ${schema}`);
    const pool = new Pool({ connectionString: TEST_DATABASE_URL, max: 2, options: `-c search_path=${schema}` });
    const dir = mkdtempSync(path.join(tmpdir(), 'mig-'));
    try {
      copyFileSync(path.join(DEFAULT_MIGRATIONS_DIR, '0001_initial_schema.sql'), path.join(dir, '0001_initial_schema.sql'));
      assert.deepEqual((await migrateUp(pool, dir)).applied, [1]);
      const u = (await pool.query(`INSERT INTO users (petali_id, email, email_normalized, password_hash) VALUES ('PTL-0000-0000-0001','a@x.com','a@x.com','hash') RETURNING id`)).rows[0].id;
      await pool.query(`INSERT INTO devices (user_id, name, platform) VALUES ($1, 'Old PC', 'win32')`, [u]);
      await pool.query(`INSERT INTO sessions (user_id, refresh_hash, expires_at, max_expires_at) VALUES ($1, 'h', now() + interval '1 day', now() + interval '1 day')`, [u]);
      await pool.query(`INSERT INTO account_settings (user_id, settings) VALUES ($1, '{"language":"cs"}')`, [u]);
      const before = JSON.stringify([(await pool.query('SELECT id, petali_id, email, email_normalized, password_hash, display_name, email_verified_at, email_changed_at, password_changed_at, deletion_requested_at, created_at, updated_at FROM users')).rows, (await pool.query('SELECT * FROM sessions')).rows, (await pool.query('SELECT * FROM account_settings')).rows]);
      const r = await migrateUp(pool);                                   // the full, current set
      assert.deepEqual(r.applied, loadMigrations().map((m) => m.version).filter((v) => v > 1));
      assert.equal(JSON.stringify([(await pool.query('SELECT id, petali_id, email, email_normalized, password_hash, display_name, email_verified_at, email_changed_at, password_changed_at, deletion_requested_at, created_at, updated_at FROM users')).rows, (await pool.query('SELECT * FROM sessions')).rows, (await pool.query('SELECT * FROM account_settings')).rows]), before, 'rows are byte-for-byte the same');
      const d = (await pool.query('SELECT name, platform, epoch, client_device_id, hardware FROM devices')).rows[0];
      assert.deepEqual(d, { name: 'Old PC', platform: 'win32', epoch: 1, client_device_id: null, hardware: null }, 'an existing device gets safe defaults');
      const t = (await pool.query(`SELECT table_name FROM information_schema.tables WHERE table_schema = $1`, [schema])).rows.map((x) => x.table_name);
      assert.ok(t.includes('sync_documents'));
    } finally { rmSync(dir, { recursive: true, force: true }); await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); }
  });
  it('contains no destructive statements', () => {
    for (const m of loadMigrations().filter((x) => x.version > 1)) assert.ok(!/\b(DROP\s+(TABLE|COLUMN|INDEX|CONSTRAINT)|TRUNCATE|DELETE\s+FROM|ALTER\s+TABLE\s+\w+\s+(DROP|RENAME)|ALTER\s+COLUMN)/i.test(m.sql), `${m.name} must be additive only`);
  });
});

describe('migration 0003 (device management) is additive', () => {
  const CID = '11111111-2222-4333-8444-555555555555';
  it('upgrades a populated version-2 (production-shaped) database without losing or changing any data', async () => {
    const admin = new Pool({ connectionString: TEST_DATABASE_URL, max: 1 });
    const schema = `m_${randomBytes(6).toString('hex')}`;
    await admin.query(`CREATE SCHEMA ${schema}`);
    const pool = new Pool({ connectionString: TEST_DATABASE_URL, max: 2, options: `-c search_path=${schema}` });
    const dir = mkdtempSync(path.join(tmpdir(), 'mig-'));
    try {
      for (const f of ['0001_initial_schema.sql', '0002_sync.sql']) copyFileSync(path.join(DEFAULT_MIGRATIONS_DIR, f), path.join(dir, f));
      assert.deepEqual((await migrateUp(pool, dir)).applied, [1, 2]);
      const ua = (await pool.query(`INSERT INTO users (petali_id, email, email_normalized, password_hash) VALUES ('PTL-0000-0000-0001','a@x.com','a@x.com','hash') RETURNING id`)).rows[0].id;
      const ub = (await pool.query(`INSERT INTO users (petali_id, email, email_normalized, password_hash) VALUES ('PTL-0000-0000-0002','b@x.com','b@x.com','hash') RETURNING id`)).rows[0].id;
      // Phase 2 reality: the same installation id can already be registered under two accounts (a computer that switched accounts).
      const da = (await pool.query(`INSERT INTO devices (user_id, name, platform, client_device_id, hardware, last_sync_at) VALUES ($1,'Desk','win32',$2,'{"cpu":"X"}', now()) RETURNING id`, [ua, CID])).rows[0].id;
      await pool.query(`INSERT INTO devices (user_id, name, platform, client_device_id) VALUES ($1,'Desk (b)','win32',$2)`, [ub, CID]);
      await pool.query(`INSERT INTO devices (user_id, name) VALUES ($1,'legacy phase 1 device without client id')`, [ua]);
      await pool.query(`INSERT INTO sessions (user_id, device_id, refresh_hash, expires_at, max_expires_at) VALUES ($1,$2,'h',now() + interval '1 day', now() + interval '1 day')`, [ua, da]);
      await pool.query(`INSERT INTO sync_documents (user_id, device_id, kind, doc_key, data, data_hash, size_bytes, client_updated_at, written_by_device) VALUES ($1,$2,'day','2026-09-01','{"dayKey":"2026-09-01","activeMs":1}','h',40,now(),$2)`, [ua, da]);
      await pool.query(`INSERT INTO sync_documents (user_id, kind, doc_key, data, data_hash, size_bytes, client_updated_at) VALUES ($1,'setting','ui.lang','"cs"','h2',4,now())`, [ua]);
      const snap = async () => JSON.stringify([(await pool.query('SELECT id, petali_id, email, email_normalized, password_hash, display_name, email_verified_at, email_changed_at, password_changed_at, deletion_requested_at, created_at, updated_at FROM users ORDER BY id')).rows, (await pool.query('SELECT * FROM sessions ORDER BY id')).rows, (await pool.query('SELECT * FROM sync_documents ORDER BY id')).rows,
        (await pool.query('SELECT id, user_id, name, platform, app_version, hardware, epoch, client_device_id, last_seen_at, last_sync_at, revoked_at, created_at, updated_at FROM devices ORDER BY id')).rows]);
      const before = await snap();
      const r = await migrateUp(pool);
      assert.deepEqual(r.applied, loadMigrations().map((m) => m.version).filter((v) => v > 2));
      assert.equal(await currentSchemaVersion(pool), 6);
      assert.deepEqual((await pool.query('SELECT password_usable FROM users')).rows.map((x) => x.password_usable), [true, true], 'existing accounts keep password sign-in (migration 0004 default)');
      assert.equal(await snap(), before, 'every pre-existing row and column is byte-for-byte the same');
      const nd = (await pool.query('SELECT name, name_customized, name_updated_at, history_purged_at, revoked_at FROM devices ORDER BY created_at, name')).rows;
      assert.equal(nd.length, 3);
      for (const d of nd) { assert.equal(d.name_customized, false); assert.equal(d.name_updated_at, null); assert.equal(d.history_purged_at, null); assert.equal(d.revoked_at, null); }
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM devices WHERE client_device_id = $1', [CID])).rows[0].n, 2, 'legacy duplicate installation ids survive (no unique index was added)');
      assert.deepEqual((await migrateUp(pool)).applied, [], 'running it again changes nothing');
    } finally { rmSync(dir, { recursive: true, force: true }); await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); }
  });
  it('a purge mark requires a removed device (CHECK), and the new session index exists', async () => {
    const admin = new Pool({ connectionString: TEST_DATABASE_URL, max: 1 });
    const schema = `m_${randomBytes(6).toString('hex')}`;
    await admin.query(`CREATE SCHEMA ${schema}`);
    const pool = new Pool({ connectionString: TEST_DATABASE_URL, max: 2, options: `-c search_path=${schema}` });
    try {
      await migrateUp(pool);
      const u = (await pool.query(`INSERT INTO users (petali_id, email, email_normalized, password_hash) VALUES ('PTL-0000-0000-0009','z@x.com','z@x.com','h') RETURNING id`)).rows[0].id;
      await assert.rejects(pool.query(`INSERT INTO devices (user_id, name, history_purged_at) VALUES ($1,'x', now())`, [u]), /devices_purged_requires_removed/);
      await pool.query(`INSERT INTO devices (user_id, name, revoked_at, history_purged_at) VALUES ($1,'x', now(), now())`, [u]);
      assert.ok((await pool.query(`SELECT indexname FROM pg_indexes WHERE schemaname = $1`, [schema])).rows.some((r) => r.indexname === 'sessions_device_idx'));
    } finally { await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); }
  });
});

describe('migration 0004 (Continue with Google) is additive', () => {
  it('creates external_identities with unique (provider, subject) and one Google identity per user', async () => {
    const admin = new Pool({ connectionString: TEST_DATABASE_URL, max: 1 });
    const schema = `m_${randomBytes(6).toString('hex')}`;
    await admin.query(`CREATE SCHEMA ${schema}`);
    const pool = new Pool({ connectionString: TEST_DATABASE_URL, max: 2, options: `-c search_path=${schema}` });
    try {
      await migrateUp(pool);
      const mk = async (n: number) => (await pool.query(`INSERT INTO users (petali_id, email, email_normalized, password_hash) VALUES ($1,$2,$2,'h') RETURNING id`, [`PTL-0000-0000-000${n}`, `u${n}@x.com`])).rows[0].id;
      const a = await mk(1); const b = await mk(2);
      await pool.query(`INSERT INTO external_identities (user_id, provider, subject, email_at_link) VALUES ($1,'google','sub-1','u1@x.com')`, [a]);
      await assert.rejects(pool.query(`INSERT INTO external_identities (user_id, provider, subject, email_at_link) VALUES ($1,'google','sub-1','u2@x.com')`, [b]), /external_identities_provider_subject_key/);
      await assert.rejects(pool.query(`INSERT INTO external_identities (user_id, provider, subject, email_at_link) VALUES ($1,'google','sub-2','u1@x.com')`, [a]), /external_identities_user_provider_key/);
      await assert.rejects(pool.query(`INSERT INTO external_identities (user_id, provider, subject, email_at_link) VALUES ($1,'facebook','s','x')`, [b]), /external_identities_provider/);
      await pool.query('DELETE FROM users WHERE id = $1', [a]);
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM external_identities')).rows[0].n, 0, 'deleting an account removes its identity');
    } finally { await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); }
  });
});
