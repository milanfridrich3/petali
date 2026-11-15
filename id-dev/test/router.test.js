import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { matchRoute, safeReturnPath, loginUrl, nextFromSearch, BASE } from '../../id/js/router.js';

const UUID = '3f2b8c1e-5d4a-4e7b-9a10-1c2d3e4f5a6b';
describe('routes', () => {
  it('every required Petali ID URL resolves to its view', () => {
    const want = { '/id': 'dashboard', '/id/': 'dashboard', '/id/login': 'login', '/id/register': 'register', '/id/computers': 'computers', [`/id/computers/${UUID}`]: 'computer', '/id/plant': 'plant', '/id/usage': 'usage', '/id/health': 'health', '/id/reports': 'reports', '/id/settings': 'settings', '/id/more': 'more', '/id/computers/': 'computers' };
    for (const [p, name] of Object.entries(want)) assert.equal(matchRoute(p).name, name, p);
  });
  it('only login and register are public', () => {
    for (const n of ['/id', '/id/computers', '/id/plant', '/id/usage', '/id/health', '/id/reports', '/id/settings', '/id/more']) assert.equal(matchRoute(n).public, false, n);
    assert.equal(matchRoute('/id/login').public, true); assert.equal(matchRoute('/id/register').public, true);
  });
  it('computer ids must be UUIDs; unknown paths are not-found inside the app', () => {
    assert.equal(matchRoute('/id/computers/abc').name, 'notfound'); assert.equal(matchRoute('/id/nothing').name, 'notfound'); assert.equal(matchRoute('/id/computers/x/y').name, 'notfound');
  });
  it('there is no /app route and nothing outside /id is claimed', () => {
    for (const p of ['/app', '/app/login', '/app/dashboard', '/', '/feedback.html', '/idx', '/identity']) assert.equal(matchRoute(p).name, 'outside', p);
  });
});

describe('return paths (open redirect protection)', () => {
  it('accepts internal /id paths', () => {
    assert.equal(safeReturnPath('/id/computers'), '/id/computers'); assert.equal(safeReturnPath('/id'), '/id'); assert.equal(safeReturnPath('/id/'), '/id');
    assert.equal(safeReturnPath(`/id/computers/${UUID}`), `/id/computers/${UUID}`); assert.equal(safeReturnPath('/id/reports?x=1'), '/id/reports?x=1');
  });
  it('rejects everything else', () => {
    const bad = ['https://evil.example/id', '//evil.example', '///evil.example/id', '/\\evil.example', '\\\\evil.example', 'javascript:alert(1)', '/id/../evil', '/id/%2e%2e/evil', '/id/..%2Fevil', '/idx', '/identity', '/app', '/app/dashboard', '/', '', null, undefined, 42, {}, 'id/computers', '/id//evil.example', '/id/%2F%2Fevil.example', '/id/computers\r\nLocation: x', '/id/login', '/id/register', '/id/nothing', 'data:text/html,x', ' /id', '/id/%5Cevil', 'x'.repeat(600)];
    for (const b of bad) assert.equal(safeReturnPath(b), null, String(b));
  });
  it('login URL carries the destination; nextFromSearch falls back to /id', () => {
    assert.equal(loginUrl('/id/computers'), '/id/login?next=%2Fid%2Fcomputers');
    assert.equal(loginUrl('/id'), '/id/login'); assert.equal(loginUrl('https://evil.example'), '/id/login');
    assert.equal(nextFromSearch('?next=%2Fid%2Fcomputers'), '/id/computers'); assert.equal(nextFromSearch('?next=https%3A%2F%2Fevil.example'), BASE); assert.equal(nextFromSearch(''), BASE); assert.equal(nextFromSearch('?next=%2Fid%2Flogin'), BASE);
  });
});
