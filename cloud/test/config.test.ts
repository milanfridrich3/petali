import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ConfigError, loadConfig } from '../src/config/env';

const good = { DATABASE_URL: 'postgres://u:p@localhost/db', JWT_ACCESS_SECRET: 'k3Jf9sLq0Zx7VbN2mQw8TyUi5OpAsDfGhJk1LzXc' };

describe('configuration', () => {
  it('loads with only the required values and safe defaults', () => {
    const c = loadConfig(good);
    assert.equal(c.port, 8787); assert.equal(c.host, '127.0.0.1'); assert.equal(c.trustProxy, 0);
    assert.equal(c.accessTokenTtlSeconds, 900); assert.equal(c.argon2.memoryCost, 19456); assert.equal(c.argon2.timeCost, 2);
  });
  it('refuses to start without a database URL or a secret', () => {
    assert.throws(() => loadConfig({ JWT_ACCESS_SECRET: good.JWT_ACCESS_SECRET }), ConfigError);
    assert.throws(() => loadConfig({ DATABASE_URL: good.DATABASE_URL }), /JWT_ACCESS_SECRET/);
  });
  it('refuses short and placeholder secrets', () => {
    assert.throws(() => loadConfig({ ...good, JWT_ACCESS_SECRET: 'short' }), /at least 32/);
    assert.throws(() => loadConfig({ ...good, JWT_ACCESS_SECRET: 'change-me-change-me-change-me-change-me' }), /placeholder/);
  });
  it('production refuses weakened password hashing and low-variety secrets', () => {
    assert.throws(() => loadConfig({ ...good, NODE_ENV: 'production', ARGON2_MEMORY_KIB: '2048' }), /production requires/);
    assert.throws(() => loadConfig({ ...good, NODE_ENV: 'production', JWT_ACCESS_SECRET: 'a'.repeat(40) }), /variety/);
    assert.doesNotThrow(() => loadConfig({ ...good, NODE_ENV: 'production' }));
  });
  it('rejects out-of-range and non-numeric values with a readable message', () => {
    assert.throws(() => loadConfig({ ...good, PORT: '99999' }), /PORT/);
    assert.throws(() => loadConfig({ ...good, ACCESS_TOKEN_TTL_SECONDS: 'abc' }), /ACCESS_TOKEN_TTL_SECONDS/);
    assert.throws(() => loadConfig({ ...good, DATABASE_SSL: 'maybe' }), /DATABASE_SSL/);
  });
  it('the error message never contains the secret', () => {
    try { loadConfig({ ...good, JWT_ACCESS_SECRET: 'tooshort-but-secret' }); assert.fail('should throw'); } catch (e) { assert.ok(!String((e as Error).message).includes('tooshort-but-secret')); }
  });
});
