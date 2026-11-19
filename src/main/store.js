'use strict';
// Settings and app data, kept in one JSON file in the app's userData folder.
// Writes are debounced and atomic (write a temp file, then rename over the old one).

const fs = require('fs');
const path = require('path');

const isPlainObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);

function merge(target, src) {
  for (const k of Object.keys(src)) {
    if (isPlainObject(src[k]) && isPlainObject(target[k])) merge(target[k], src[k]);
    else target[k] = src[k];
  }
  return target;
}

class Store {
  constructor(file, defaults, { debounceMs = 500 } = {}) {
    this.file = file;
    this.debounceMs = debounceMs;
    this.timer = null;
    this.rev = 0; // bumps on every change (the sync server uses it to tell clients what's new)
    let saved = {};
    try {
      saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) {
      if (e.code !== 'ENOENT') {
        // Keep a copy of an unreadable file instead of silently overwriting it.
        try { fs.copyFileSync(file, `${file}.corrupt-${Date.now()}`); } catch (_) { /* ignore */ }
      }
    }
    this.data = merge(structuredClone(defaults), isPlainObject(saved) ? saved : {});
  }

  get(p) {
    return p.split('.').reduce((o, k) => (o == null ? undefined : o[k]), this.data);
  }

  set(p, value) {
    const keys = p.split('.');
    let o = this.data;
    for (const k of keys.slice(0, -1)) {
      if (!isPlainObject(o[k])) o[k] = {};
      o = o[k];
    }
    o[keys[keys.length - 1]] = value;
    this.save();
  }

  // Writes at most once per debounce window, even while changes keep coming.
  save() {
    this.rev++;
    if (!this.timer) this.timer = setTimeout(() => this.flush(), this.debounceMs);
  }

  flush() {
    clearTimeout(this.timer);
    this.timer = null;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, this.debounceMs > 1000 ? JSON.stringify(this.data) : JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.file);
  }
}

module.exports = { Store };
