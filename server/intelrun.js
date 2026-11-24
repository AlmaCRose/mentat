'use strict';
// The Oppo Research intelligence report (src/ui/intel.js: the Research tab's Report view and the
// My Faction tab) made on the server, for the shared war page (the user's request, 2026-11-24:
// "all of the faction research in this pre war page"). intel.js is the app's own page script; it
// runs here in a sandbox with small stand-ins for the page helpers it uses, so the server's report
// is exactly the app's.

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const FILE = path.join(__dirname, '..', 'src', 'ui', 'intel.js');
const escHtml = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
let loaded = null; // { mtime, api }

function api() {
  const st = fs.statSync(FILE);
  if (loaded && loaded.mtime === st.mtimeMs) return loaded.api;
  const ctx = {
    esc: escHtml,
    num: n => Math.round(Number(n) || 0).toLocaleString('en-US'),
    profileUrl: id => `https://www.torn.com/profiles.php?XID=${Number(id) || 0}`,
    link: (url, html) => `<a href="${escHtml(url)}" target="_blank" rel="noopener noreferrer">${html}</a>`,
    fmtAgo: ms => `${Math.max(0, Math.round((Date.now() - ms) / 3600e3))} h ago`,
    prefs: { get: (k, d) => d, set: () => {} },
    cmd: () => Promise.resolve(null),
    avatar: () => '',
    avatarsOn: () => false,
    S: { features: {}, api: {} },
    console,
  };
  vm.createContext(ctx);
  vm.runInContext(`${fs.readFileSync(FILE, 'utf8')}\n;this.__ir = { irModel, irBody };`, ctx, { filename: 'intel.js' });
  loaded = { mtime: st.mtimeMs, api: ctx.__ir };
  return loaded.api;
}

// One faction's report as HTML (the interactive export's body: sortable, filterable tables).
// rec/us: research records; stats: { id: bs }; ffs: FFScouter intel shared by a device, or null.
function intelHtml({ rec, us = null, stats = {}, ffs = null, snapStats = [], self = false, now = Date.now() }) {
  const { irModel, irBody } = api();
  const st = Object.fromEntries(Object.entries(stats || {}).map(([id, bs]) => [id, { bs }]));
  const M = irModel({ rec, us, stats: st, ffs, snapStats, now, self, by: '', source: null, banner: '' });
  // Two reports share one page (theirs and ours): give each its own table ids, so a filter box
  // filters its own report's table.
  const prefix = self ? 'us' : 'them';
  const html = irBody(M, 'html').replace(/\b(id|data-for|data-count-for)="ir-/g, `$1="${prefix}-ir-`);
  return { html, wars: M.wars.length, level: M.level, model: M };
}

module.exports = { intelHtml };
