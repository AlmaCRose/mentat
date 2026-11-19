// Browser stand-ins for the Node and Electron modules Mentat's core uses (bundled into
// mentat-core.js by scripts/pack-web.js). Only what the core needs:
//   fs        a small in-memory file system, saved to IndexedDB (loaded before the core starts)
//   path      join / dirname / basename for '/'-separated paths
//   events    EventEmitter
//   electron  safeStorage: the browser has no OS key store, so keys are kept as they are in this
//             site's storage on this device (see the sign-in screen's "What happens to my key?")
//   zlib      gzip through the browser's CompressionStream
//   util      promisify
//   Buffer    the few Buffer methods the core calls (a Uint8Array underneath)

/* eslint-disable no-restricted-globals */
const SHIMS = (() => {
  // ---- Buffer ----
  class Buffer extends Uint8Array {
    static from(x, enc) {
      if (typeof x === 'string') {
        if (enc === 'base64') {
          const bin = atob(x);
          const b = new Buffer(bin.length);
          for (let i = 0; i < bin.length; i++) b[i] = bin.charCodeAt(i);
          return b;
        }
        const u = new TextEncoder().encode(x);
        const b = new Buffer(u.length);
        b.set(u);
        return b;
      }
      const src = x instanceof ArrayBuffer ? new Uint8Array(x) : x;
      const b = new Buffer(src.length);
      b.set(src);
      return b;
    }
    static alloc(n) { return new Buffer(n); }
    static isBuffer(x) { return x instanceof Buffer; }
    static concat(list) {
      const n = list.reduce((s, b) => s + b.length, 0);
      const out = new Buffer(n);
      let at = 0;
      for (const b of list) { out.set(b, at); at += b.length; }
      return out;
    }
    toString(enc) {
      if (enc === 'base64') {
        let s = '';
        for (let i = 0; i < this.length; i += 0x8000) s += String.fromCharCode.apply(null, this.subarray(i, i + 0x8000));
        return btoa(s);
      }
      return new TextDecoder().decode(this);
    }
  }

  // ---- fs: files in memory, kept in IndexedDB ----
  const files = new Map(); // path -> string
  const dirty = new Set();
  let db = null;
  let saveTimer = null;
  const DB = 'mentat-files';
  function openDb() {
    return new Promise((resolve, reject) => {
      const r = indexedDB.open(DB, 1);
      r.onupgradeneeded = () => r.result.createObjectStore('files');
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
  }
  async function load() {
    try {
      db = await openDb();
      await new Promise((resolve, reject) => {
        const tx = db.transaction('files', 'readonly');
        const req = tx.objectStore('files').openCursor();
        req.onsuccess = () => {
          const c = req.result;
          if (!c) return resolve();
          files.set(c.key, c.value);
          c.continue();
        };
        req.onerror = () => reject(req.error);
      });
    } catch (e) {
      console.warn('Mentat: browser storage unavailable; nothing will be kept after closing.', e);
      db = null;
    }
  }
  function persist() {
    saveTimer = null;
    if (!db || !dirty.size) return;
    const tx = db.transaction('files', 'readwrite');
    const st = tx.objectStore('files');
    for (const p of dirty) {
      if (files.has(p)) st.put(files.get(p), p);
      else st.delete(p);
    }
    dirty.clear();
  }
  const touch = p => { dirty.add(p); if (!saveTimer) saveTimer = setTimeout(persist, 1000); };
  const notFound = p => Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' });
  const fs = {
    readFileSync(p) { if (!files.has(p)) throw notFound(p); return files.get(p); },
    writeFileSync(p, data) { files.set(p, typeof data === 'string' ? data : new TextDecoder().decode(data)); touch(p); },
    renameSync(a, b) { if (!files.has(a)) throw notFound(a); files.set(b, files.get(a)); files.delete(a); touch(a); touch(b); },
    copyFileSync(a, b) { if (!files.has(a)) throw notFound(a); files.set(b, files.get(a)); touch(b); },
    existsSync(p) { return files.has(p) || [...files.keys()].some(k => k.startsWith(`${p}/`)); },
    mkdirSync() {},
    unlinkSync(p) { files.delete(p); touch(p); },
    rmSync(p) { for (const k of [...files.keys()]) if (k === p || k.startsWith(`${p}/`)) { files.delete(k); touch(k); } },
    readdirSync(p) { const pre = `${p}/`; return [...new Set([...files.keys()].filter(k => k.startsWith(pre)).map(k => k.slice(pre.length).split('/')[0]))]; },
    statSync(p) { if (!files.has(p)) throw notFound(p); return { size: files.get(p).length, mtimeMs: Date.now(), isDirectory: () => false, isFile: () => true }; },
  };

  // ---- path ----
  const norm = parts => {
    const out = [];
    for (const s of parts.join('/').split('/')) {
      if (!s || s === '.') continue;
      if (s === '..') out.pop(); else out.push(s);
    }
    return `/${out.join('/')}`;
  };
  const path = {
    sep: '/',
    join: (...p) => norm(p),
    resolve: (...p) => norm(p),
    dirname: p => norm([p, '..']),
    basename: (p, ext) => { const b = String(p).split('/').pop(); return ext && b.endsWith(ext) ? b.slice(0, -ext.length) : b; },
    extname: p => { const b = String(p).split('/').pop(); const i = b.lastIndexOf('.'); return i > 0 ? b.slice(i) : ''; },
  };

  // ---- events ----
  class EventEmitter {
    constructor() { this._ev = new Map(); }
    on(n, f) { if (!this._ev) this._ev = new Map(); if (!this._ev.has(n)) this._ev.set(n, []); this._ev.get(n).push(f); return this; }
    addListener(n, f) { return this.on(n, f); }
    once(n, f) { const w = (...a) => { this.off(n, w); f(...a); }; return this.on(n, w); }
    off(n, f) { const l = this._ev && this._ev.get(n); if (l) { const i = l.indexOf(f); if (i >= 0) l.splice(i, 1); } return this; }
    removeListener(n, f) { return this.off(n, f); }
    removeAllListeners(n) { if (!this._ev) return this; if (n === undefined) this._ev.clear(); else this._ev.delete(n); return this; }
    emit(n, ...a) {
      const l = this._ev && this._ev.get(n);
      if (!l || !l.length) { if (n === 'error') throw a[0]; return false; }
      for (const f of [...l]) f.apply(this, a);
      return true;
    }
    listenerCount(n) { const l = this._ev && this._ev.get(n); return l ? l.length : 0; }
    setMaxListeners() { return this; }
  }

  // ---- electron: no OS key store in a browser ----
  const electron = {
    safeStorage: {
      isEncryptionAvailable: () => true,
      encryptString: s => Buffer.from(String(s), 'utf8'),
      decryptString: b => Buffer.from(b).toString('utf8'),
    },
  };

  // ---- zlib, util ----
  const zlib = {
    gzip(buf, cb) {
      new Response(new Blob([buf]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer()
        .then(ab => cb(null, Buffer.from(ab)), e => cb(e));
    },
  };
  const util = { promisify: fn => (...a) => new Promise((res, rej) => fn(...a, (e, v) => (e ? rej(e) : res(v)))) };

  return { fs, path, events: { EventEmitter }, electron, zlib, util, Buffer, load, persistNow: persist };
})();
