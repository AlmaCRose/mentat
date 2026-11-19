'use strict';
// TornTools in the Torn browser (optional). Mentat's own features never change Torn
// pages; this lets you run the TornTools extension you already use in Chrome, as you would
// in Chrome. It works on a COPY of your installed TornTools (Chrome's copy isn't touched):
// - copied from your Chrome profile (source maps and Chrome's signature metadata left out)
// - ext-shim.js is added in front of its background worker and pages, standing in for the
//   two Chrome features Electron lacks (desktop notifications, opening tabs)
// - loaded into the Torn browser's session, so it runs on Torn pages and keeps its own
//   settings and API key there (enter them once in TornTools' settings).

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

const TT_ID = 'hjpaapdjcgbmeikfnahipphknonhlhib'; // TornTools in the Chrome Web Store
const SHIM = path.join(__dirname, 'ext-shim.js');
const BRIDGE = 'https://torndesktop.invalid/*';

function chromeProfiles() {
  const root = path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'User Data');
  try {
    return fs.readdirSync(root, { withFileTypes: true }).filter(d => d.isDirectory() && (d.name === 'Default' || /^Profile \d+$/.test(d.name))).map(d => path.join(root, d.name));
  } catch (e) {
    return [];
  }
}

const versionKey = v => String(v).split(/[._]/).map(n => String(Number(n) || 0).padStart(6, '0')).join('.');

// The newest TornTools installed in any Chrome profile: { version, dir, profile }.
function findInChrome() {
  let best = null;
  for (const p of chromeProfiles()) {
    const base = path.join(p, 'Extensions', TT_ID);
    let versions = [];
    try { versions = fs.readdirSync(base); } catch (e) { continue; }
    for (const v of versions) {
      const dir = path.join(base, v);
      try {
        const m = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
        if (!best || versionKey(m.version) > versionKey(best.version)) best = { version: m.version, dir, profile: path.basename(p) };
      } catch (e) { /* not a complete install */ }
    }
  }
  return best;
}

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    if (e.name === '_metadata' || e.name.endsWith('.map')) continue;
    const s = path.join(src, e.name), d = path.join(dst, e.name);
    if (e.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

class Extensions extends EventEmitter {
  constructor({ store, session, dataDir }) {
    super();
    this.store = store;
    this.session = session;
    this.dir = path.join(dataDir, 'extensions', 'torntools');
    this.loaded = null;
    this.error = '';
  }

  installed() {
    try {
      const m = JSON.parse(fs.readFileSync(path.join(this.dir, 'manifest.json'), 'utf8'));
      return { version: m.version, name: m.name };
    } catch (e) {
      return null;
    }
  }

  status() {
    const chrome = findInChrome();
    const inst = this.installed();
    return {
      enabled: !!this.store.get('extensions.torntools'),
      chrome: chrome ? { version: chrome.version, profile: chrome.profile } : null,
      installed: inst,
      loaded: this.loaded ? { id: this.loaded.id, version: this.loaded.version } : null,
      updateAvailable: !!(chrome && inst && versionKey(chrome.version) > versionKey(inst.version)),
      error: this.error,
    };
  }

  // Copy (or update) TornTools from Chrome and add the compatibility layer.
  install() {
    const src = findInChrome();
    if (!src) throw new Error('TornTools was not found in your Chrome profiles.');
    const tmp = `${this.dir}.new`;
    fs.rmSync(tmp, { recursive: true, force: true });
    copyDir(src.dir, tmp);
    const shim = fs.readFileSync(SHIM, 'utf8');
    const manifest = JSON.parse(fs.readFileSync(path.join(tmp, 'manifest.json'), 'utf8'));
    // Background worker: shim first.
    const bg = manifest.background && manifest.background.service_worker;
    if (bg) {
      const f = path.join(tmp, bg);
      fs.writeFileSync(f, `${shim}\n${fs.readFileSync(f, 'utf8')}`);
    }
    // Extension pages (settings, popup, …): load the shim before their own scripts.
    fs.writeFileSync(path.join(tmp, 'td-shim.js'), shim);
    for (const html of fs.readdirSync(tmp).filter(n => n.endsWith('.html'))) {
      const f = path.join(tmp, html);
      const s = fs.readFileSync(f, 'utf8');
      if (!s.includes('td-shim.js')) fs.writeFileSync(f, s.replace(/<head>/i, '<head><script src="/td-shim.js"></script>'));
    }
    fs.writeFileSync(path.join(tmp, 'TORN-DESKTOP-COPY.txt'), `Copied from Chrome (${src.profile}) TornTools ${src.version} on ${new Date().toISOString()} by Mentat, with ext-shim.js added. Chrome's copy is unchanged.\n`);
    fs.rmSync(this.dir, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(this.dir), { recursive: true });
    fs.renameSync(tmp, this.dir);
    return this.installed();
  }

  // Load the copy into the Torn browser session (at start-up, or when turned on).
  async load() {
    this.error = '';
    if (!this.store.get('extensions.torntools') || !this.installed()) return null;
    try {
      const exts = this.session.extensions || this.session;
      const existing = (exts.getAllExtensions ? exts.getAllExtensions() : []).find(e => e.name === 'TornTools');
      if (existing) exts.removeExtension(existing.id);
      this.loaded = await exts.loadExtension(this.dir, { allowFileAccess: true });
    } catch (e) {
      this.loaded = null;
      this.error = e.message;
    }
    this.emit('state');
    return this.loaded;
  }

  unload() {
    if (!this.loaded) return;
    const exts = this.session.extensions || this.session;
    try { exts.removeExtension(this.loaded.id); } catch (e) { /* already gone */ }
    this.loaded = null;
    this.emit('state');
  }

  remove() {
    this.unload();
    fs.rmSync(this.dir, { recursive: true, force: true });
    this.store.set('extensions.torntools', false);
    this.emit('state');
  }

  // Extension pages (settings, popup) may open in Torn browser tabs.
  isExtensionUrl(u) {
    return !!this.loaded && typeof u === 'string' && u.startsWith(`chrome-extension://${this.loaded.id}/`);
  }

  pageUrl(page) {
    return this.loaded ? `chrome-extension://${this.loaded.id}/${page}` : '';
  }
}

module.exports = { Extensions, BRIDGE, findInChrome };
