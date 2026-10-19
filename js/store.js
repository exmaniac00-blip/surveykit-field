// Offline storage: IndexedDB (projects + key/value), with an in-memory backend for tests / private mode.
const DB = 'surveykit-field', VER = 1;

class MemoryBackend {
  constructor() { this.s = { projects: new Map(), kv: new Map() }; }
  async get(store, key) { const v = this.s[store].get(key); return v === undefined ? undefined : structuredClone(v); }
  async put(store, key, val) { this.s[store].set(key, structuredClone(val)); }
  async del(store, key) { this.s[store].delete(key); }
  async keys(store) { return [...this.s[store].keys()]; }
}

class IDBBackend {
  constructor(idb) { this.idb = idb; this.db = null; }
  open() {
    if (this.db) return Promise.resolve(this.db);
    return new Promise((res, rej) => {
      const r = this.idb.open(DB, VER);
      r.onupgradeneeded = () => { for (const s of ['projects', 'kv']) if (!r.result.objectStoreNames.contains(s)) r.result.createObjectStore(s); };
      r.onsuccess = () => { this.db = r.result; res(this.db); };
      r.onerror = () => rej(r.error);
    });
  }
  async tx(store, mode, fn) {
    const db = await this.open();
    return new Promise((res, rej) => {
      const t = db.transaction(store, mode), req = fn(t.objectStore(store));
      t.oncomplete = () => res(req && req.result);
      t.onerror = () => rej(t.error);
    });
  }
  get(store, key) { return this.tx(store, 'readonly', (s) => s.get(key)); }
  put(store, key, val) { return this.tx(store, 'readwrite', (s) => s.put(val, key)); }
  del(store, key) { return this.tx(store, 'readwrite', (s) => s.delete(key)); }
  keys(store) { return this.tx(store, 'readonly', (s) => s.getAllKeys()); }
}

export function openStore(backend) {
  const b = backend || (globalThis.indexedDB ? new IDBBackend(globalThis.indexedDB) : new MemoryBackend());
  return {
    backend: b,
    // project records: {id, session, dirty, updated_at, remote_rev}
    getProject: (id) => b.get('projects', id),
    putProject: (rec) => b.put('projects', rec.id, rec),
    deleteProject: (id) => b.del('projects', id),
    async listProjects() {
      const out = [];
      for (const k of await b.keys('projects')) { const r = await b.get('projects', k); if (r) out.push(r); }
      return out.sort((a, b2) => String(b2.updated_at).localeCompare(String(a.updated_at)));
    },
    async get(key, dflt) { const v = await b.get('kv', key); return v === undefined ? dflt : v; },
    set: (key, val) => b.put('kv', key, val),
  };
}
export { MemoryBackend };
