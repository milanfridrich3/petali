// Release 1.5.0 has no email service. These tests pin what the web Petali ID says and offers in that situation.
import { JSDOM } from 'jsdom';
import { IDBFactory } from 'fake-indexeddb';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

const dom = new JSDOM('<!doctype html><html><body><div id="app"></div></body></html>', { url: 'https://petali.example/id/login', pretendToBeVisual: true });
for (const k of ['window', 'document', 'history', 'location', 'Element', 'HTMLElement', 'Node']) Object.defineProperty(globalThis, k, { value: dom.window[k], configurable: true, writable: true });
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true, writable: true });
globalThis.indexedDB = new IDBFactory();
const { verificationNotice, EMAIL_CONFIRMATION_AVAILABLE, GOOGLE_REASONS } = await import('../../id/js/views-auth.js');
const ROOT = new URL('../..', import.meta.url).pathname;
const read = (p) => readFileSync(`${ROOT}${p}`, 'utf8');

describe('web Petali ID without an email service', () => {
  it('email confirmation is switched off for this release (one flag to turn it on later)', () => {
    assert.equal(EMAIL_CONFIRMATION_AVAILABLE, false);
  });
  it('after registering, the notice says no email was sent and the status is "Not confirmed yet" (never "sent")', () => {
    const n = verificationNotice({ sent: false, required: false, reason: 'not_configured' });
    assert.match(n.text, /Not confirmed yet/); assert.match(n.text, /no confirmation message was sent/); assert.ok(!/check your inbox|we sent/i.test(n.text));
  });
  it('the persistent banner never offers "Send a new link" while confirmation is unavailable', () => {
    const app = read('id/js/app.js');
    assert.match(app, /if \(!EMAIL_CONFIRMATION_AVAILABLE\) return h\('div', \{ class: 'banner verify-banner' \}/);
    assert.match(app, /Email confirmation is not available yet/);
  });
  it('Google linking message no longer promises a confirmation step that cannot happen', () => {
    assert.match(GOOGLE_REASONS.needs_verification, /not confirmed yet/); assert.match(GOOGLE_REASONS.needs_verification, /not available at the moment/);
    assert.ok(!/then Continue with Google will connect/.test(GOOGLE_REASONS.needs_verification));
  });
  it('the settings page shows "Not confirmed yet" for an unverified account', () => {
    assert.match(read('id/js/views-more.js'), /Not confirmed yet/);
  });
  it('the service worker shell version was bumped for this release build', () => {
    assert.match(read('id/sw.js'), /const VERSION = 'v6-1\.6\.0'/);
  });
});
