// Account-isolated offline cache (IndexedDB). It holds ONLY the read-only views the app fetched (overview, plant, health, ...), each tagged with
// the account that fetched it, plus two tiny markers. It never holds tokens or passwords. Logout and account switching wipe it.
// If IndexedDB is unavailable (private mode, quota) everything degrades to "no offline copy" - the app still works online.
export const MAX_AGE_MS = 30 * 86_400_000;       // a saved view older than this is not shown any more
const DB = 'petali-id'; const ENTRIES = 'entries'; const META = 'meta';

export function createCache({ indexedDB: idb = typeof indexedDB !== 'undefined' ? indexedDB : null, now = () => Date.now() } = {}) {
  let dbp = null;
  const open = () => {
    if (!idb) return Promise.resolve(null);
    if (!dbp) dbp = new Promise((resolve) => {
      let req; try { req = idb.open(DB, 1); } catch { resolve(null); return; }
      req.onupgradeneeded = () => { const db = req.result; if (!db.objectStoreNames.contains(ENTRIES)) db.createObjectStore(ENTRIES, { keyPath: 'k' }); if (!db.objectStoreNames.contains(META)) db.createObjectStore(META, { keyPath: 'k' }); };
      req.onsuccess = () => resolve(req.result); req.onerror = () => resolve(null); req.onblocked = () => resolve(null);
    });
    return dbp;
  };
  const run = async (store, mode, fn) => {
    const db = await open(); if (!db) return null;
    return new Promise((resolve) => {
      try { const tx = db.transaction(store, mode); const r = fn(tx.objectStore(store)); tx.oncomplete = () => resolve({ value: r ? r.result : undefined }); tx.onerror = () => resolve(null); tx.onabort = () => resolve(null); } catch { resolve(null); }
    });
  };
  const key = (userId, k) => `${userId}|${k}`;
  return {
    async put(userId, k, data) { if (!userId) return false; return !!(await run(ENTRIES, 'readwrite', (s) => s.put({ k: key(userId, k), userId, name: k, savedAt: now(), data }))); },
    async get(userId, k) {
      if (!userId) return null;
      const r = (await run(ENTRIES, 'readonly', (s) => s.get(key(userId, k))))?.value;
      if (!r || r.userId !== userId || typeof r.savedAt !== 'number' || now() - r.savedAt > MAX_AGE_MS) return null;
      return { data: r.data, savedAt: r.savedAt };
    },
    async del(userId, k) { return !!(await run(ENTRIES, 'readwrite', (s) => s.delete(key(userId, k)))); },
    // Removes every saved view (all accounts) and the markers. Used on logout, revoked sessions and account switches.
    async wipeAll() { const a = await run(ENTRIES, 'readwrite', (s) => s.clear()); const b = await run(META, 'readwrite', (s) => s.clear()); return a !== null && b !== null; },
    async getMeta(name) { const r = (await run(META, 'readonly', (s) => s.get(name)))?.value; return r && r.value !== undefined ? r.value : null; },
    async setMeta(name, value) { return !!(await run(META, 'readwrite', (s) => s.put({ k: name, value }))); },
    async delMeta(name) { return !!(await run(META, 'readwrite', (s) => s.delete(name))); },
    async list() { const r = (await run(ENTRIES, 'readonly', (s) => s.getAll()))?.value; return Array.isArray(r) ? r : []; },
  };
}
