// Mentat 0.1.33: the core for web browsers. Built by scripts/pack-web.js from src/main; don't edit.
(function () {
'use strict';
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

const Buffer = SHIMS.Buffer;
const BUILTIN = { fs: SHIMS.fs, path: SHIMS.path, events: SHIMS.events, electron: SHIMS.electron, zlib: SHIMS.zlib, util: SHIMS.util };
const DEFS = {
  "core.js": function (module, exports, require) {
'use strict';
// Mentat's core: settings, the features (your status, chain, targets, travel, market, war, oppo
// research, scouting, FFScouter, alerts) and the link to a Mentat server, plus the commands the
// tools page sends. Shared by the Windows app (main.js) and the web app (web/app/), so both
// behave the same; each "host" supplies what differs (windows, notifications, files, links).
//
// host: {
//   store                 settings Store
//   dataDir               folder for the data files
//   version, deviceName   for the server ("Mentat for Windows", "Mentat web")
//   send(channel, data)   updates for the tools page(s)
//   notify(title, body, url, opts)   opts.urgent: middle-of-the-screen popup ({ sound, repeat })
//   openUrl(url, newTab)  a Torn page or a link
//   activity, archive     long-term stores for oppo research (the web app passes empty stand-ins)
//   scoutLocal            this device may scout (Windows app: when turned on)
//   viewing(tab)          is that tab on show (war members and points refresh only then)
//   onSetting(p, value)   after a setting changes (themes, chat window, browser clocks…)
//   onSynced(changed, has) after settings arrive from another device
//   publicExtra()         more settings for the page
//   exportResearch(p), exportIntel(p)   save the oppo research exports
//   activeUrl()           the Torn page on show, for "add this player to targets"
//   extraFeatures         { name: feature } shown to the page like the others (e.g. updates)
//   defaultServer         the Mentat server this build signs in to
// }

const { TornApi } = require('./api');
const { Store } = require('./store');
const { PriceHistory } = require('./history');
const { SyncFeature } = require('./sync');
const { ClaimsFeature } = require('./features/claims');
const { WarReportFeature, discordParts } = require('./features/warreport');
const { UserFeature } = require('./features/user');
const { ChainFeature } = require('./features/chain');
const { TargetsFeature, herePlace } = require('./features/targets');
const { MarketFeature } = require('./features/market');
const { TravelFeature } = require('./features/travel');
const { BazaarFeature } = require('./features/bazaar');
const { FFScouterFeature } = require('./features/ffscouter');
const { AlertsFeature, SOUNDS } = require('./features/alerts');
const { WarFeature } = require('./features/war');
const { ResearchFeature } = require('./features/research');
const { ScoutFeature } = require('./features/scout');
const { CasinoFeature } = require('./features/casino');
const { PlannerFeature } = require('./features/planner');
const { AvatarsFeature } = require('./features/avatars');
const { MuggerFeature } = require('./features/mugger');
const { MuggerDb } = require('./features/muggerdb');
const { SETTABLE, OVERRIDE_PATH, TAB_LAYOUT_DEFAULTS, LIGHT_THEMES, num } = require('./schema');

function createCore(host) {
  const { store, dataDir } = host;
  const send = (channel, data) => host.send(channel, data);
  // kind: which notification this is ('trip', 'energy', 'chain', …; see ui.urgent in schema.js), or
  // true / false when the caller decided itself (a planned item or custom alert with its own choice).
  // Urgent ones go to the middle of the screen and stay until dismissed (popups.js / web host).
  const urgentOpts = () => {
    const s = SOUNDS[store.get('ui.urgentSound')] || SOUNDS.doorbell;
    const vol = store.get('alerts.volume');
    return { urgent: true, sound: s.count ? { ...s, volume: vol === undefined ? 0.6 : vol } : null, repeat: Number(store.get('ui.urgentRepeat')) || 0 };
  };
  const notify = (title, body, url, kind) => {
    const urgent = kind === true || (typeof kind === 'string' && !!(store.get('ui.urgent') || {})[kind]);
    return host.notify(title, body, url, urgent ? urgentOpts() : {});
  };

  // ---- API + features ----
  const api = new TornApi(store);
  const user = new UserFeature({ api, store, notify });
  const chain = new ChainFeature({ api, store, notify, getMeId: () => user.meId() });
  // Your country (abroad or flying out) for the Abroad list, from your own status.
  const targets = new TargetsFeature({ api, store, notify, here: () => herePlace(user.state && user.state.data) });
  const cache = new Store(`${dataDir}/cache.json`, { items: null }, { debounceMs: 5000 });
  const history = new PriceHistory(dataDir);
  const market = new MarketFeature({ api, store, cache, notify, history });
  const travel = new TravelFeature({ api, store, dataDir });
  const bazaar = new BazaarFeature({ store, history });
  market.bazaar = bazaar;
  bazaar.on('summary', () => market.checkAllWatches());
  bazaar.on('listings', id => market.checkWatch(id));
  const war = new WarFeature({ api, store, dataDir });
  // War members and points refresh while their tab is on show (see host.viewing).
  const viewing = host.viewing || (tab => String(store.get('ui.panel') || '').split(':')[0] === tab);
  war.viewing = viewing;
  market.viewing = viewing;
  const { activity, archive } = host;
  const research = new ResearchFeature({ api, store, dataDir, war, activity, archive });
  const scout = new ScoutFeature({ api, store, dataDir, war, activity, archive, research, local: !!host.scoutLocal });
  war.statsWanted = () => research.tracked().length > 0;
  // FFScouter estimates for your targets and for the enemy faction on the War tab.
  const ffscouter = new FFScouterFeature({ store, dataDir, getTargetIds: () => [...new Set([...Object.keys(store.get('targets.list') || {}).map(Number), ...war.enemyIds(), ...research.memberIds(), ...mugger.ffIds()])] });
  let enemyKey = '';
  war.on('state', () => {
    const k = war.enemyIds().join(',');
    if (k && k !== enemyKey) ffscouter.refreshSoon();
    enemyKey = k;
  });
  let researchKey = '';
  research.on('state', () => {
    const k = research.memberIds().sort().join(',');
    if (k && k !== researchKey) ffscouter.refreshSoon();
    researchKey = k;
  });
  // Data source: this device, or a Mentat server that collects 24/7 (see sync.js and server/).
  const sync = new SyncFeature({ store, research, travel, war, history, scout, version: host.version, onSettings: applySynced, defaultServer: host.defaultServer || '', api });
  research.remote = () => sync.covering();
  research.ownerPicks = () => sync.ownerResearchPicks();
  // Abroad stock: this device stops polling YATA only once the server's copy has actually arrived,
  // so a device that can't get it (a failed download, say) still shows live stock.
  travel.remote = () => sync.covering() && sync.hasPulled('travel');
  scout.remote = () => sync.mode() === 'server' && sync.configured();
  user.on('flight', f => { travel.learnFlight(f); sync.markDirty(['travel.learned']); });
  if (host.migrated && host.migrated.length) sync.markDirty(host.migrated); // e.g. the new default theme, to your other devices
  const alerts = new AlertsFeature({ store, notify, user, chain, targets, war, travel });
  travel.watchKeys = () => alerts.restockKeys(); // restock alerts: read YATA every 10 s
  // Casino tab: live odds come from the Mentat server (signed-in members).
  // War claims, shared through the Mentat server (War tab → Claim).
  const claims = new ClaimsFeature({ sync, war, viewing });
  // Post-war report: facts + accolades for Discord (War tab → War report)
  const warreport = new WarReportFeature({ api, war, dataDir });
  const casino = new CasinoFeature({ api, store, viewing, server: (method, p) => { if (!sync.configured()) throw new Error('Sign in to Mentat to load live odds.'); return sync.req(method, p); } });
  casino.on('imported', () => sync.markDirty(['gamble.log']));
  // Planner: your plan for the next few days (synced); reminders fire from here.
  const planner = new PlannerFeature({ store, notify });
  planner.on('pruned', () => sync.markDirty(['planner.items']));
  // Profile pictures: free from the profiles Targets fetches anyway, the rest a few a minute.
  const avatars = new AvatarsFeature({ api, store, dataDir });
  targets.on('profile', (id, d) => avatars.put(id, d && d.profile_image));
  // Mugger: a 90-day market database of bazaar sellers of abroad items (Weav3r; collected by the Mentat
  // server, or here without one), and while you're abroad, where they are, their cash and the fight.
  const muggerDb = new MuggerDb({ dataDir, travel, api }); // bazaar directories with your key when there's no server
  const mugger = new MuggerFeature({ api, store, dataDir, db: muggerDb, user, viewing });
  muggerDb.remote = () => sync.covering() && sync.hasPulled('mugger'); // the server's copy has arrived
  muggerDb.useServer = () => sync.mode() === 'server' && sync.configured();
  sync.muggerDb = muggerDb;
  mugger.extraIds = () => Object.keys(store.get('targets.list') || {}).map(Number);
  mugger.on('profile', (id, d) => avatars.put(id, d && d.profile_image));
  let muggerFfKey = '';
  mugger.on('state', () => {
    const k = mugger.ffIds().join(',');
    if (k && k !== muggerFfKey) ffscouter.refreshSoon();
    muggerFfKey = k;
  });
  user.on('state', () => mugger.emitSoon()); // your trip
  // FFScouter summaries for the team's war report link (its Comparison tab; the user's request,
  // 2026-11-24). The server has no FFScouter key, so the owner's or an admin's device shares what it
  // loaded for the researched factions: activity by hour of the week, estimated battle stats and
  // each member's usual hours. Checked once a minute, sent only when something changed.
  const ffsShare = {
    sent: '', at: 0, pauseUntil: 0, busy: false,
    usual(m) { // busiest 3 hours (TCT) from FFScouter's 96 quarter-hour activity counts
      if (!m || !Array.isArray(m.act)) return null;
      const by = Array.from({ length: 24 }, (_, h) => m.act.slice(h * 4, h * 4 + 4).reduce((a, b) => a + (b || 0), 0));
      const total = by.reduce((a, b) => a + b, 0);
      if (total < 3) return null;
      let best = 0, at = 0;
      for (let h = 0; h < 24; h++) { const v = by[h] + by[(h + 1) % 24] + by[(h + 2) % 24]; if (v > best) { best = v; at = h; } }
      return [at, (at + 3) % 24, Math.round((best / total) * 100) / 100];
    },
    intelTried: new Map(), // faction id -> last background load attempt
    // FFScouter Premium: load the activity history of each researched faction (theirs and ours) in
    // the background, so it's there without opening the Research tab (the user's report,
    // 2026-11-24: the shared report had no FFScouter activity for a new opponent). One faction at a
    // time, refreshed daily; a failed one waits an hour.
    loadIntel(now) {
      const acct = store.get('ffscouter.account') || {};
      const job = ffscouter.intelJob;
      if (!acct.premium || (job && job.running)) return;
      for (const t of research.tracked()) {
        const rec = research.rec(t.id);
        if (!rec || !Object.keys(rec.members || {}).length) continue;
        const have = ffscouter.intel(t.id);
        if (have && now - have.at < 24 * 3600e3) continue;
        if (now - (this.intelTried.get(t.id) || 0) < 3600e3) continue;
        this.intelTried.set(t.id, now);
        ffscouter.loadIntel(t.id, Object.keys(rec.members).map(Number), !!have).catch(() => {});
        return;
      }
    },
    tick(now) {
      if (this.busy || now - this.at < 60e3 || now < this.pauseUntil) return;
      if (ffscouter.hasKey()) { try { this.loadIntel(now); } catch (e) { console.error(e); } }
      if (!sync.signedIn() || sync.mode() !== 'server' || !ffscouter.hasKey()) return;
      this.at = now;
      const stats = ffscouter.stats();
      const factions = research.tracked().map(t => research.rec(t.id)).filter(Boolean).map(rec => {
        const i = ffscouter.intel(rec.id);
        const ids = Object.keys(rec.members || {});
        const st = {}, uh = {};
        for (const id of ids) {
          // The current estimate, else the latest one in FFScouter's stat history
          const g = i && i.growth && i.growth[id];
          if (stats[id] && stats[id].bs) st[id] = stats[id].bs;
          else if (g && g.last && g.last.bs) st[id] = g.last.bs;
          const u = i && i.members ? this.usual(i.members[id]) : null;
          if (u) uh[id] = u;
        }
        // intel: the whole FFScouter intel, so the server's intelligence report and member dossiers
        // match the app's (per-member activity by 15 minutes, estimated-stat growth).
        return { id: rec.id, days: i ? i.days : 0, at: i ? i.at : 0, week: i && i.faction ? i.faction.week : null, stats: st, uh, intel: i || null };
      }).filter(f => f.week || Object.keys(f.stats).length);
      if (!factions.length) return;
      const sig = JSON.stringify(factions);
      if (sig === this.sent) return;
      this.busy = true;
      sync.req('POST', 'research/ffscouter', { body: { factions } })
        .then(() => { this.sent = sig; })
        .catch(e => { this.pauseUntil = Date.now() + (/403|owner and admins|404|not found/i.test(e.message) ? 6 * 3600e3 : 10 * 60e3); })
        .finally(() => { this.busy = false; });
    },
  };
  // FFScouter Premium reminder (the user's request, 2026-11-24): 24 hours before Premium runs out,
  // once across all of the person's devices. The end date comes from any device's key check and is
  // synced (ffscouter.premiumUntil), as is the end date already reminded about
  // (ffscouter.premiumReminded). Whichever device is running when the time comes shows it; if none
  // is, the next one to start does. A device waits until it has the server's synced settings (or
  // 10 minutes, if it can't reach the server), so it doesn't repeat what another device showed.
  const premiumReminder = {
    at: 0, startedAt: Date.now(),
    tick(now) {
      if (now - this.at < 60e3) return;
      this.at = now;
      const acct = store.get('ffscouter.account') || {};
      const synced = Number(store.get('ffscouter.premiumUntil')) || 0;
      const until = Math.max(synced, Number(acct.premiumUntil) || 0);
      if (until !== synced) { store.set('ffscouter.premiumUntil', until); sync.markDirty(['ffscouter.premiumUntil']); }
      if (!until || now < until - 24 * 3600e3) return;
      if ((Number(store.get('ffscouter.premiumReminded')) || 0) >= until) return;
      if (sync.configured() && !sync.settingsFresh() && now - this.startedAt < 10 * 60e3) return;
      store.set('ffscouter.premiumReminded', until);
      sync.markDirty(['ffscouter.premiumReminded']);
      const left = until - now;
      const when = `${new Date(until).toISOString().slice(0, 16).replace('T', ' ')} TCT`;
      const inTime = left >= 3600e3 ? `${Math.round(left / 3600e3)} hours` : `${Math.max(1, Math.round(left / 60e3))} minutes`;
      const title = left > 0 ? `FFScouter Premium ends in ${inTime}` : 'FFScouter Premium has ended';
      const body = `${left > 0 ? 'It runs out' : 'It ran out'} ${when}. Renew at ffscouter.com to keep FFScouter activity history and stat growth in Oppo Research and the team war pages.`;
      // Stays on screen until dismissed (urgent popup), one sound, no repeats.
      host.notify(title, body, 'https://ffscouter.com/premium', { ...urgentOpts(), repeat: 0 });
    },
  };
  const features = { user, chain, research, scout, war, claims, warreport, targets, market, travel, bazaar, ffscouter, alerts, casino, planner, avatars, mugger, sync, ...(host.extraFeatures || {}) };

  // Settings changed on another device (from the Mentat server).
  function applySynced(changed) {
    for (const [u, v] of Object.entries(changed)) {
      if (u === 'war.watchId') { war.watch(v); continue; }
      store.set(u, v);
    }
    const has = pre => Object.keys(changed).some(u => u.startsWith(pre));
    if (has('targets.')) targets.emit('state');
    if (has('alerts.')) alerts.emit('state');
    if (has('market.')) { market.checkAllWatches(); market.emit('state'); }
    if (has('war.')) war.emit('state');
    if (has('research.')) research.emit('state');
    if (has('scout.')) scout.emit('state');
    if (has('travel.')) travel.emit('state');
    if (has('gamble.')) casino.emit('state');
    if (has('planner.')) planner.emit('state');
    if (host.onSynced) host.onSynced(changed, has);
    send('settings', publicSettings());
  }

  for (const [name, f] of Object.entries(features)) f.on('state', () => send('feature', { name, state: f.snapshot() }));
  chain.on('beep', alert => send('beep', alert));
  alerts.on('beep', alert => send('beep', alert));
  api.on('status', () => send('api', api.status()));
  api.on('key', () => send('api', api.status()));

  const ticker = setInterval(() => {
    const now = Date.now();
    for (const f of Object.values(features)) {
      try { f.tick(now); } catch (e) { console.error(e); }
    }
    try { ffsShare.tick(now); } catch (e) { console.error(e); }
    try { premiumReminder.tick(now); } catch (e) { console.error(e); }
  }, 1000);

  // ---- Settings sent to the page (never a key) ----
  function publicSettings() {
    const { learned, capacityApi, lastMethod, ...travelSettings } = store.get('travel');
    const { watch, ...marketSettings } = store.get('market');
    return {
      ui: store.get('ui'), api: { maxPerMinute: store.get('api.maxPerMinute') }, user: store.get('user'), chain: store.get('chain'),
      targets: { autoRefresh: store.get('targets.autoRefresh'), interval: store.get('targets.interval'), notify: store.get('targets.notify') },
      // The War tab's dropdowns (without these they showed their first option after every redraw)
      war: { interval: store.get('war.interval'), live: store.get('war.live') },
      travel: travelSettings, market: marketSettings,
      ffscouter: { intervalHours: store.get('ffscouter.intervalHours') },
      mugger: store.get('mugger'),
      alerts: { volume: store.get('alerts.volume') },
      ...(host.publicExtra ? host.publicExtra() : {}),
    };
  }

  function setSetting(p, value) {
    if (OVERRIDE_PATH.test(p)) {
      if (!num(0, 600)(value)) throw new Error(`Invalid setting ${p}`);
      const key = p.slice('travel.override.'.length);
      const o = { ...store.get('travel.override') };
      if (value > 0) o[key] = value;
      else delete o[key];
      store.set('travel.override', o);
    } else if (p === 'ui.tabLayoutReset') {
      store.set('ui.tabLayout', structuredClone(TAB_LAYOUT_DEFAULTS));
    } else {
      const check = SETTABLE[p];
      if (!check || !check(value)) throw new Error(`Invalid setting ${p}`);
      store.set(p, value);
      if (p === 'market.priceSource') market.checkAllWatches();
      // Picking a theme also makes it the dark or light pick, so "match light/dark mode" has both ready.
      if (p === 'ui.theme') store.set(LIGHT_THEMES.includes(value) ? 'ui.themeLight' : 'ui.themeDark', value);
      if (p.startsWith('scout.')) scout.emit('state');
      if (p.startsWith('planner.')) planner.emit('state');
      if (p === 'ui.avatars') avatars.emit('state');
      if (p.startsWith('mugger.')) { mugger.pool = null; mugger.emitSoon(); }
    }
    if (host.onSetting) host.onSetting(p, value);
    send('settings', publicSettings());
  }

  // ---- Commands from the tools page ----
  const commands = {
    'init': () => ({ api: api.status(), settings: publicSettings(), features: Object.fromEntries(Object.entries(features).map(([n, f]) => [n, f.snapshot()])) }),
    'torn.open': (url, newTab = true) => host.openUrl(String(url || ''), newTab !== false),
    'settings.set': (p, v) => setSetting(String(p), v),
    'key.save': async key => ({ account: await api.saveKey(key) }),
    'key.remove': () => api.clearKey(''),
    'user.refresh': () => user.refresh(),
    'chain.refresh': () => chain.refresh(),
    'targets.add': text => { ffscouter.refreshSoon(); return targets.add(String(text || '')); },
    'targets.addCurrent': () => { ffscouter.refreshSoon(); return targets.addFromUrl(host.activeUrl ? host.activeUrl() : ''); },
    'targets.removeFrom': from => targets.removeFrom(from === 'list' ? 'list' : ''),
    'targets.remove': (id, which) => targets.remove(Number(id), which === 'abroad' ? 'abroad' : 'home'),
    'targets.refresh': id => targets.refresh(Number(id)),
    'targets.refreshAll': () => targets.refreshAll(),
    'targets.clear': which => targets.clear(which === 'abroad' ? 'abroad' : 'home'),
    'ffscouter.saveKey': async (key, acknowledged) => ({ account: await ffscouter.saveKey(key, !!acknowledged) }),
    'ffscouter.removeKey': () => ffscouter.removeKey(''),
    'ffscouter.refresh': () => ffscouter.refreshSoon(true),
    'ffscouter.find': params => ffscouter.findTargets(params && typeof params === 'object' ? params : {}),
    'ffscouter.intel': (fid, ids, force) => ffscouter.loadIntel(Number(fid) || 0, Array.isArray(ids) ? ids.slice(0, 120) : [], !!force),
    'war.refresh': () => war.refresh(),
    'war.watch': id => war.watch(id),
    'war.pin': (id, on) => war.pin(id, !!on),
    'war.reportWars': () => warreport.listWars(),
    'war.report': async (id, opts = {}) => {
      const model = await warreport.build(id, { fresh: !!(opts && opts.fresh) });
      return { model, parts: discordParts(model, { spectators: !!(opts && opts.spectators) }) };
    },
    // The report card as an image on the clipboard (desktop: export.js; the web app has none)
    'war.reportImage': html => (host.copyImage ? host.copyImage(String(html || '')) : { unsupported: true }),
    // A link to the report as a page on the Mentat server, for sharing with the team: it opens at
    // once with no sign-in or API calls (server/warpage.js). The server builds it with its own key.
    'war.reportLink': async id => {
      if (!sync.signedIn()) throw new Error('Team links need the Mentat server: sign in to it first.');
      try {
        return await sync.req('GET', `war/report-link?war=${Number(id) || 0}`);
      } catch (e) {
        if (/404|not found/i.test(e.message)) throw new Error('Your Mentat server needs an update for team links.');
        throw e;
      }
    },
    'war.claim': (id, on) => claims.set(Number(id), !!on),
    'research.watch': id => research.research(id),
    'research.exportIntel': p => {
      if (!p || typeof p !== 'object' || typeof p.pdf !== 'string' || typeof p.html !== 'string') throw new Error('Nothing to export');
      return host.exportIntel({ name: String(p.name || ''), pdf: p.pdf, html: p.html, csv: String(p.csv || '') });
    },
    'research.export': p => {
      if (!p || typeof p !== 'object' || typeof p.overview !== 'string') throw new Error('Nothing to export');
      return host.exportResearch({ mode: p.mode === 'all' ? 'all' : 'image', name: String(p.name || ''), overview: p.overview, report: String(p.report || ''), csv: String(p.csv || ''), data: p.data || null });
    },
    'sync.configure': c => sync.configure(c && typeof c === 'object' ? c : {}),
    'sync.now': () => { sync.nextPoll = 0; return sync.poll(); },
    'sync.upload': () => sync.uploadAll(),
    'sync.forget': () => sync.forget(),
    // Sign in with your Torn key: the server checks you're in the faction (or allow-listed);
    // the key is then saved on this device for your own tools.
    'auth.health': url => sync.health(url ? String(url) : ''),
    'auth.login': async (key, url) => {
      const s = await sync.login({ url: url ? String(url) : '', key: String(key || ''), device: host.deviceName || 'Mentat' });
      let keyError = '';
      try { await api.saveKey(String(key || '').replace(/[^A-Za-z0-9]/g, '')); } catch (e) { keyError = e.message; }
      return { ...s, keyError };
    },
    'auth.logout': () => sync.logout(),
    // Admins: who uses Mentat on the server, the allow-list, signing someone out.
    'members.list': () => sync.req('GET', 'admin/members'),
    'members.allow': (id, note) => sync.req('POST', 'admin/allow', { body: { id: Number(id), note: String(note || '') } }),
    'members.disallow': id => sync.req('POST', 'admin/disallow', { body: { id: Number(id) } }),
    'members.signout': id => sync.req('POST', 'admin/signout', { body: { id: Number(id) } }),
    'alerts.add': rule => alerts.add(rule && typeof rule === 'object' ? rule : {}),
    'alerts.update': (id, patch) => alerts.update(String(id), patch && typeof patch === 'object' ? patch : {}),
    'alerts.remove': id => alerts.remove(String(id)),
    'alerts.test': id => alerts.test(String(id)),
    'alerts.preview': sound => alerts.preview(String(sound)),
    'popup.test': () => notify('Test alert', 'This is how your alerts will look.', 'https://www.torn.com/index.php'),
    'popup.testUrgent': () => notify('Plan: Trip to Japan', 'Test of an urgent popup: in 5 min (14:05 TCT). Snooze or dismiss it.', 'https://www.torn.com/page.php?sid=travel', true),
    'market.catalog': () => market.catalogCompact(),
    'market.live': ids => market.requestLive((Array.isArray(ids) ? ids : [ids]).map(Number).filter(Boolean).slice(0, 25), 5),
    'market.watch.add': (id, below) => market.addWatch(Number(id), Number(below) || 0),
    'market.watch.below': (id, below) => market.setBelow(Number(id), Number(below) || 0),
    'market.watch.remove': id => market.removeWatch(Number(id)),
    'market.points.refresh': () => market.refreshPoints(),
    'market.scan.start': (type, minValue) => market.startScan(String(type), Math.max(0, Number(minValue) || 0)),
    'market.scan.stop': () => market.stopScan(),
    'market.history': id => history.item(Number(id)),
    'market.trends': ids => history.trends((Array.isArray(ids) ? ids : []).map(Number).slice(0, 2000)),
    'bazaar.summary': () => bazaar.summary,
    'bazaar.listings': ids => bazaar.requestListings((Array.isArray(ids) ? ids : [ids]).map(Number).filter(Boolean).slice(0, 10)),
    'bazaar.refresh': () => bazaar.refresh(),
    'travel.refresh': () => travel.refresh(),
    'travel.capacity.refresh': () => travel.refreshCapacity(),
    'travel.stockHistory': (code, id) => travel.stockHistory(String(code), Number(id)),
    'travel.learned.clear': () => { store.set('travel.learned', {}); travel.emit('state'); },
    'casino.refresh': () => { casino.refreshCasino(); casino.refreshTables(); },
    'casino.odds.sports': () => casino.oddsSports(),
    'casino.odds.events': sport => casino.oddsEvents(String(sport || '')),
    'casino.odds.top': () => casino.oddsTop(),
    'avatars.want': ids => avatars.want(ids),
    'casino.log.add': e => casino.addLog(e),
    'casino.log.update': (id, patch) => casino.updateLog(String(id), patch && typeof patch === 'object' ? patch : {}),
    'casino.log.remove': id => casino.removeLog(String(id)),
    'casino.log.clear': which => casino.clearLog(which === 'auto' || which === 'manual' ? which : 'all'),
    'casino.session': s => casino.setSession(s && typeof s === 'object' ? s : null),
    'casino.logKey.save': key => casino.saveLogKey(key),
    'casino.logKey.remove': () => casino.removeLogKey(),
    'casino.log.import': () => casino.importLog(),
    'mugger.scan': () => mugger.scanNow(),
    'mugger.recheck': id => mugger.recheck(Number(id) || 0),
    'mugger.paste': text => mugger.paste(String(text || '').slice(0, 200000)),
    'mugger.pasteClear': () => mugger.pasteClear(),
    'planner.add': it => planner.add(it),
    'planner.update': (id, patch) => planner.update(String(id), patch),
    'planner.remove': id => planner.remove(String(id)),
    'planner.copyDay': (from, to) => planner.copyDay(String(from), String(to)),
    'planner.clearDay': day => planner.clearDay(String(day)),
  };

  // Everything to disk (quitting, or the page going away).
  function flushAll() {
    for (const s of [store, cache, history, travel, war, research, scout, warreport, mugger, muggerDb]) { try { s.flush(); } catch (e) { console.error(e); } }
    try { if (activity) activity.flush(); if (archive) archive.flush(); } catch (e) { /* best effort */ }
    if (ffscouter.intelDb) ffscouter.intelDb.flush();
    sync.flush();
    store.flush();
  }
  function stop() { clearInterval(ticker); }

  return {
    api, features, commands, publicSettings, setSetting, applySynced, flushAll, stop,
    user, chain, targets, market, travel, bazaar, war, research, scout, ffscouter, alerts, casino, mugger, sync, history, cache, premiumReminder,
  };
}

module.exports = { createCore };

  },
  "schema.js": function (module, exports, require) {
'use strict';
// Mentat's settings: defaults, what may be changed and how each value is checked, the tabs, the
// colour themes. Shared by the Windows app, the web app (core.js) and nothing else.

const DEFAULTS = {
  window: { bounds: null, maximized: false },
  browser: { bounds: null, maximized: false },
  chatwin: { bounds: null, bubble: null, onTop: true, minimizeToBubble: true, compact: true, hideInBrowser: true, zoom: 0, emojis: '😂 👍 ❤️ 😭 🙏 🔥 💀 👀 🎉 😅' },
  ui: { panel: 'overview', zoom: 0, openTornOnStart: false, closeToTray: true, trayHintShown: false, clockZone: 'America/New_York', clockThird: false, clock24: true, avatars: true, browserClocks: true, popupStyle: 'app', popupSeconds: 12, popupCorner: 'bottom-right', navLayout: 'top', navCollapsed: false, theme: 'mentat', accent: '' },
  session: { urls: [], active: 0 },
  api: { keyEnc: '', account: null, maxPerMinute: 40 },
  user: {
    interval: 60,
    notify: { energy: true, nerve: true, drug: true, booster: false, medical: false, travel: true, hospital: true, events: true, messages: true },
  },
  chain: { enabled: true, alerts: true, desktop: true, sound: 'soft', volume: 0.6, minChain: 10, t150: true, t90: true, t60: true, t30: true },
  targets: { list: {}, autoRefresh: true, interval: 120, notify: true },
  travel: {
    yata: true, method: 'auto', capacity: 0, sellMode: 'market', feePct: 0,
    book: false, outbound: true,
    restockInterval: 15, restockOffset: 0,
    override: {}, learned: {}, lastMethod: '', capacityApi: null,
  },
  market: { watch: {}, watchInterval: 300, payoutPct: 95, bazaar: true, priceSource: 'both' },
  ffscouter: { keyEnc: '', account: null, acknowledgedAt: 0, stats: {}, intervalHours: 6, premiumUntil: 0, premiumReminded: 0 },
  alerts: { rules: [], volume: 0.6 },
  // live: seconds between enemy refreshes while you watch the War tab during a war (0 = off)
  war: { watchId: 0, interval: 30, pinned: [], live: 3 },
  // Scouting (activity + war records of the factions around your rank). On this PC it's off
  // unless turned on; a sync server always scouts.
  scout: { enabled: false, perMinute: 6, spread: 1 },
  extensions: { torntools: false },
  // Pop-out tabs (popouts.js): open ones, window and bubble places, collapsed / on top.
  popouts: { open: [], bounds: {}, bubble: {}, collapsed: {}, onTop: {}, minimizeToBubble: true },
  // Data source: 'local' (this PC) or 'server' (a Mentat sync server). Secrets are DPAPI-encrypted.
  sync: { mode: 'local', url: '', tokenEnc: '', cfIdEnc: '', cfSecretEnc: '', serverId: '', joinedId: '', settingsRev: 0, dirty: [], deviceId: '' },
};

const TIME_ZONES = new Set(Intl.supportedValuesOf('timeZone'));
// Colour themes (ui/themes.css) and their window background, used before a page draws.
const THEME_BG = {
  mentat: '#17120d',
  dark: '#191919', midnight: '#0f1420', oled: '#000000', slate: '#1c2128', crimson: '#1a1515', amethyst: '#16131e', sepia: '#1d1915',
  light: '#eef0f3', sand: '#f3ece0', paper: '#f3f3f1', frost: '#e9f0f7', sage: '#ecf1ea', rose: '#f6edef', lavender: '#f0eef8', contrast: '#ffffff',
};
const LIGHT_THEMES = ['light', 'sand', 'paper', 'frost', 'sage', 'rose', 'lavender', 'contrast'];
const DARK_THEMES = Object.keys(THEME_BG).filter(k => !LIGHT_THEMES.includes(k));
// Default third clock: New York, or London for people whose local time already is New York.
DEFAULTS.ui.clockZone = Intl.DateTimeFormat().resolvedOptions().timeZone === 'America/New_York' ? 'Europe/London' : 'America/New_York';

// What the UI may change, and how each value is checked.
const bool = v => typeof v === 'boolean';
const num = (lo, hi) => v => typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;
const oneOf = (...xs) => v => xs.includes(v);
const SETTABLE = {
  // A main-bar entry: a tab, or one of its sub-tabs ('market:watch') lifted onto the main bar.
  'ui.panel': v => typeof v === 'string' && /^[a-z]+(:[a-z]+)?$/.test(v) && TABS.includes(v.split(':')[0]),
  // Tab layout (ui/nav.js keeps it tidy): order of main-bar entries, sub-tab order per tab, hidden ones.
  'ui.nav': v => {
    const ids = a => Array.isArray(a) && a.length <= 60 && a.every(x => typeof x === 'string' && /^[a-z]+(:[a-z]+)?$/.test(x));
    return !!v && typeof v === 'object' && !Array.isArray(v) && ids(v.order) && ids(v.hidden)
      && !!v.sub && typeof v.sub === 'object' && !Array.isArray(v.sub) && Object.keys(v.sub).length <= 20
      && Object.entries(v.sub).every(([k, a]) => TABS.includes(k) && ids(a));
  },
  'war.interval': num(15, 300),
  'war.live': v => [0, 3, 5, 10].includes(v),
  'ui.openTornOnStart': bool, 'ui.closeToTray': bool, 'ui.clock24': bool, 'ui.avatars': bool, 'ui.clockThird': bool, 'ui.browserClocks': bool,
  'ui.clockZone': v => typeof v === 'string' && TIME_ZONES.has(v),
  'ui.popupStyle': oneOf('windows', 'app'), 'ui.popupSeconds': num(0, 600),
  'ui.navLayout': oneOf('top', 'side'), 'ui.navCollapsed': bool,
  'ui.tabLayoutReset': bool,
  'ui.theme': oneOf(...Object.keys(THEME_BG)),
  // Match Windows light/dark mode: themeDark and themeLight are the two picks it switches between.
  'ui.themeAuto': bool, 'ui.themeDark': oneOf(...DARK_THEMES), 'ui.themeLight': oneOf(...LIGHT_THEMES),
  'ui.accent': v => v === '' || (typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v)),
  'ui.popupCorner': oneOf('bottom-right', 'top-right', 'bottom-left', 'top-left'),
  'api.maxPerMinute': num(10, 80),
  'user.interval': num(30, 600),
  'chain.enabled': bool, 'chain.alerts': bool, 'chain.desktop': bool,
  'chain.volume': num(0, 1), 'chain.minChain': num(0, 100000),
  'alerts.volume': num(0, 1), 'chain.sound': oneOf('soft', 'classic'),
  'chain.t150': bool, 'chain.t90': bool, 'chain.t60': bool, 'chain.t30': bool,
  'targets.autoRefresh': bool, 'targets.interval': num(3, 3600), 'targets.notify': bool,
  'travel.yata': bool, 'travel.method': oneOf('auto', 'Standard', 'Airstrip', 'Private', 'Business'),
  'travel.capacity': num(0, 500), 'travel.sellMode': oneOf('market', 'live'), 'travel.feePct': num(0, 50),
  'travel.restockInterval': num(5, 240), 'travel.restockOffset': num(0, 239),
  'travel.book': bool, 'travel.outbound': bool,
  'market.watchInterval': num(60, 3600), 'market.payoutPct': num(1, 150),
  'market.bazaar': bool, 'market.priceSource': oneOf('market', 'bazaar', 'both'),
  'ffscouter.intervalHours': num(1, 48),
  'scout.enabled': bool, 'scout.perMinute': num(2, 40), 'scout.spread': num(0, 4),
  'chatwin.emojis': v => typeof v === 'string' && v.length <= 300,
  'popouts.minimizeToBubble': bool,
  'ui.tourDone': bool,
  'updates.auto': bool,
  // Web and phone app: open Torn links in Torn PDA (auto = Android, where it falls back to the browser).
  'ui.pdaLinks': oneOf('auto', 'on', 'off'),
  'chatwin.onTop': bool, 'chatwin.minimizeToBubble': bool, 'chatwin.compact': bool, 'chatwin.hideInBrowser': bool,
};
// Per-tab layout: alignment and width of each tab's content (Settings → Appearance).
const TABS = ['overview', 'chain', 'research', 'faction', 'war', 'targets', 'mugger', 'travel', 'market', 'planner', 'casino', 'alerts', 'settings'];
const TAB_LABELS = {
  overview: 'Overview', chain: 'Chain', targets: 'Targets', faction: 'My Faction', war: 'War', research: 'Oppo Research',
  mugger: 'Mugger', market: 'Market', travel: 'Travel', planner: 'Planner', casino: 'Casino', alerts: 'Alerts', settings: 'Settings',
  'targets:list': 'Targets', 'targets:abroad': 'Abroad',
  'research:overview': 'Research', 'research:report': 'War report', 'research:scout': 'Scouting',
  'travel:timed': 'Timed trips', 'travel:plan': 'Leave now', 'travel:items': 'Abroad items', 'travel:sell': 'Sell abroad', 'travel:flights': 'Flights & settings',
  'casino:blackjack': 'Blackjack', 'casino:poker': 'Poker', 'casino:highlow': 'High-Low', 'casino:games': 'Other games', 'casino:bookie': 'Bookie', 'casino:tracker': 'Tracker',
  'market:lookup': 'Item lookup', 'market:watch': 'Watchlist', 'market:deals': 'Deal finder', 'market:trade': 'Trade calculator',
};
const TAB_LAYOUT_DEFAULTS = {
  overview: { align: 'center', width: 'narrow' }, chain: { align: 'center', width: 'narrow' },
  research: { align: 'center', width: 'wide' }, faction: { align: 'center', width: 'wide' }, war: { align: 'center', width: 'medium' }, targets: { align: 'center', width: 'narrow' }, mugger: { align: 'center', width: 'full' },
  travel: { align: 'center', width: 'full' }, market: { align: 'center', width: 'full' }, planner: { align: 'center', width: 'wide' }, casino: { align: 'center', width: 'wide' },
  alerts: { align: 'center', width: 'medium' }, settings: { align: 'center', width: 'narrow' },
};
DEFAULTS.ui.tabLayout = structuredClone(TAB_LAYOUT_DEFAULTS);
DEFAULTS.ui.themeAuto = false;
DEFAULTS.ui.pdaLinks = 'auto';
DEFAULTS.ui.tourDone = false; // the first-run tour was shown (or skipped)
// First-run setup (ui/setup.js): colours, tab bar, tabs, top bar buttons, starter alerts. Synced,
// so it shows once per person, not once per device.
DEFAULTS.ui.setupDone = false;
// Top bar buttons (and the clocks); false hides one. Ctrl+D and Ctrl+K work either way.
DEFAULTS.ui.buttons = { torn: true, pages: true, chat: true, clocks: true, account: true };
SETTABLE['ui.setupDone'] = bool;
// Condensed tabs: no profile pictures, faction tags or banners in these tabs (right-click a tab,
// or Settings → Customization). Synced, like the rest of the tab layout.
DEFAULTS.ui.condensed = [];
SETTABLE['ui.condensed'] = v => Array.isArray(v) && v.length <= TABS.length && new Set(v).size === v.length && v.every(x => TABS.includes(x));
for (const k of Object.keys(DEFAULTS.ui.buttons)) SETTABLE[`ui.buttons.${k}`] = bool;
DEFAULTS.updates = { auto: true }; // check the Mentat server for new versions (installed copies)
DEFAULTS.ui.themeDark = 'mentat';
DEFAULTS.ui.themeLight = 'sand';
// Tab order and visibility (ui/nav.js). Empty = the default layout.
DEFAULTS.ui.nav = { order: [], sub: {}, hidden: [] };
// Casino tab: your betting log and bankroll session (synced), and auto-tracking from your Torn log
// (its Full access key stays on this device; autoFrom = the newest log entry read, in seconds).
DEFAULTS.gamble = { log: {}, session: null };
DEFAULTS.casino = { logKeyEnc: '', auto: false, autoFrom: 0 };
SETTABLE['casino.auto'] = bool;
// Planner: plan items (synced, merged item by item), how many days the plan covers (synced), and
// which reminders already went off on this device (not synced).
DEFAULTS.planner = { items: {}, days: 3, fired: {} };
SETTABLE['planner.days'] = num(1, 60);
// Mugger (features/mugger.js): the country (auto = your trip's), the cheapest abroad item that counts,
// how many traders to check during a trip, its share of your API calls per minute, your Masterful
// Looting level ('auto' = from your merits) and your weapon's Plunder bonus (%). This device only.
DEFAULTS.mugger = { location: 'auto', minCost: 100000, pool: 60, rate: 20, here: 1, market: 5, looting: 'auto', plunder: 0 };
SETTABLE['mugger.location'] = v => typeof v === 'string' && /^(auto|Mexico|Cayman Islands|Canada|Hawaii|United Kingdom|Argentina|Switzerland|Japan|China|UAE|South Africa)$/.test(v);
SETTABLE['mugger.looting'] = v => v === 'auto' || (Number.isInteger(v) && v >= 0 && v <= 10);
SETTABLE['mugger.plunder'] = v => v === 0 || (Number.isInteger(v) && v >= 20 && v <= 49);
SETTABLE['mugger.minCost'] = v => [50000, 100000, 250000, 500000, 1000000].includes(v);
SETTABLE['mugger.pool'] = v => [20, 40, 60, 100, 150].includes(v);
SETTABLE['mugger.rate'] = v => [10, 20, 30, 45].includes(v);
SETTABLE['mugger.here'] = v => [1, 2, 3].includes(v); // minutes between checks of players in your country
SETTABLE['mugger.market'] = v => [2, 5, 10].includes(v); // minutes between their item market checks
for (const t of TABS) {
  SETTABLE[`ui.tabLayout.${t}.align`] = oneOf('left', 'center', 'right');
  SETTABLE[`ui.tabLayout.${t}.width`] = oneOf('narrow', 'medium', 'wide', 'full');
}
// Flight time overrides: travel.override.<country code>|<method> = minutes (0 removes it).
const OVERRIDE_PATH = /^travel\.override\.(mex|cay|can|haw|uni|arg|swi|jap|chi|uae|sou)\|(Standard|Airstrip|Private|Business)$/;
for (const k of Object.keys(DEFAULTS.user.notify)) SETTABLE[`user.notify.${k}`] = bool;
// Urgent popups (notify.js / popups.js): a large card in the middle of the screen that stays until you
// dismiss or snooze it and repeats its sound. Chosen per kind of notification (all off by default);
// planned items and custom alerts can also choose for themselves. Synced.
DEFAULTS.ui.urgent = { trip: false, plan: false, energy: false, nerve: false, drug: false, booster: false, medical: false, travel: false, hospital: false, events: false, messages: false, chain: false, targets: false, market: false };
DEFAULTS.ui.urgentSound = 'doorbell';
DEFAULTS.ui.urgentRepeat = 30; // seconds between repeats of the sound (0 = once); stops after 10 minutes
for (const k of Object.keys(DEFAULTS.ui.urgent)) SETTABLE[`ui.urgent.${k}`] = bool;
SETTABLE['ui.urgentSound'] = v => typeof v === 'string' && /^[a-z]{1,20}$/.test(v);
SETTABLE['ui.urgentRepeat'] = v => [0, 10, 15, 30, 60, 120].includes(v);

// One-time changes to saved settings. Returns the synced settings it changed (to send to the server).
// 2026-11-18: the Mentat theme became the default; installs still on the old default (Torn Dark,
// the light pick still Daylight) move to it once. A theme someone picked themselves stays.
function migrateSettings(store) {
  const changed = [];
  if (!store.get('ui.themeMentat')) {
    if (store.get('ui.theme') === 'dark') { store.set('ui.theme', 'mentat'); changed.push('ui.theme'); }
    if (store.get('ui.themeDark') === 'dark') { store.set('ui.themeDark', 'mentat'); changed.push('ui.themeDark'); }
    if (store.get('ui.themeLight') === 'light') { store.set('ui.themeLight', 'sand'); changed.push('ui.themeLight'); }
    store.set('ui.themeMentat', true);
  }
  // 2026-11-18: the first-run setup arrived. Someone who already used Mentat here (the tour was
  // shown) has set it up, so it isn't offered to them.
  if (!store.get('ui.setupDone') && store.get('ui.tourDone')) { store.set('ui.setupDone', true); changed.push('ui.setupDone'); }
  return changed;
}

module.exports = {
  DEFAULTS, SETTABLE, TABS, TAB_LABELS, TAB_LAYOUT_DEFAULTS, THEME_BG, LIGHT_THEMES, DARK_THEMES, OVERRIDE_PATH, migrateSettings,
  bool, num, oneOf,
};

  },
  "store.js": function (module, exports, require) {
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

  },
  "api.js": function (module, exports, require) {
'use strict';
// The one and only way the app talks to Torn's API.
//
// Compliance (Torn API rules + "Scripting Abuse" game rule):
// - Requests go only to api.torn.com. Nothing here fetches or reads torn.com pages.
// - Every feature shares one queue, capped well below Torn's 100 requests/min per user
//   (default 40/min, at least 1s apart).
// - Invalid/disabled keys are removed on the first error so they are never retried.
// - Other errors pause all requests for a while instead of retrying straight away.
// - The key is encrypted with Windows DPAPI (Electron safeStorage) and only stored on this PC.

const { EventEmitter } = require('events');
// Electron's safeStorage when running in the app; the sync server passes its key in instead.
let safeStorage = null;
try { ({ safeStorage } = require('electron')); } catch (e) { /* plain Node */ }

const API_BASE = 'https://api.torn.com';
const API_COMMENT = 'Mentat';
const MIN_GAP_MS = 1000;
const TIMEOUT_MS = 15000;
const KEY_PATTERN = /^[A-Za-z0-9]{16}$/;
// "Each user can make up to 100 individual requests per minute across all of their keys"
// (torn.com/api.html). The calls your other Mentat devices and the Mentat server make with your
// key count too (reported by the server, see setOthers), so all of them together stay under this.
const TORN_LIMIT = 100;
const ALL_MENTAT_MAX = 95; // leaves a little room for other tools
const MIN_BUDGET = 5; // this device never stops completely
const OTHERS_FRESH_MS = 150e3; // a report older than this no longer counts

// Errors that mean the key itself is unusable: remove it and stop.
const KEY_ERRORS = {
  1: 'Key is empty',
  2: 'Incorrect key',
  10: 'Key owner is in federal jail',
  13: 'Key disabled due to owner inactivity',
  18: 'Key paused by owner',
};
// Errors that mean "stop for a while" (seconds). Unknown codes back off 5 minutes.
// 16 ("access level too low") is listed as soft by the features that can live without it.
const BACKOFF_ERRORS = { 0: 60, 5: 120, 8: 900, 9: 900, 12: 60, 14: 3600, 15: 60, 16: 300, 17: 60, 24: 900 };

class ApiError extends Error {
  // kind: 'nokey' | 'paused' | 'network' | 'key' | 'soft' | 'backoff'
  constructor(kind, message, code = null) {
    super(message);
    this.kind = kind;
    this.code = code;
  }
}

function fmtDur(sec) {
  sec = Math.max(0, Math.round(sec));
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.round(sec / 60)} min`;
  return `${Math.round(sec / 3600)} h`;
}

class TornApi extends EventEmitter {
  constructor(store, { getKey = null } = {}) {
    super();
    this.store = store;
    this.fixedKey = getKey; // the sync server's key source (no DPAPI there)
    this.queue = [];
    this.log = [];
    this.lastAt = 0;
    this.timer = null;
    this.pausedUntil = 0;
    this.banner = '';
    this.others = null; // { n, detail, at }: calls made elsewhere with this player's key, last minute
  }

  // ---- Key ----
  getKey() {
    if (this.fixedKey) return this.fixedKey() || '';
    const enc = this.store.get('api.keyEnc');
    if (!enc) return '';
    try {
      return safeStorage.decryptString(Buffer.from(enc, 'base64'));
    } catch (e) {
      return '';
    }
  }

  hasKey() {
    if (this.fixedKey) return !!this.fixedKey();
    return !!this.store.get('api.keyEnc');
  }

  // Checks a key with one request before saving it. Returns the account it belongs to.
  async saveKey(key) {
    key = String(key || '').trim();
    if (!KEY_PATTERN.test(key)) throw new Error('A Torn API key is 16 letters and numbers.');
    const me = await this.request('/user/?selections=basic', { key, priority: 0 });
    let access = '';
    try {
      const info = await this.request('/key/?selections=info', { key, priority: 0, soft: [16, 22, 23] });
      access = (info.access_type || '').trim();
    } catch (e) { /* key info is a nice-to-have */ }
    let enc;
    try {
      enc = safeStorage.encryptString(key).toString('base64');
    } catch (e) {
      throw new Error('Windows encryption is unavailable, so the key cannot be stored safely.');
    }
    this.store.set('api.keyEnc', enc);
    this.store.set('api.account', { id: me.player_id, name: me.name, access });
    this.pausedUntil = 0;
    this.setBanner('');
    this.emit('key');
    return this.store.get('api.account');
  }

  clearKey(reason = '') {
    this.store.set('api.keyEnc', '');
    this.store.set('api.account', null);
    this.rejectQueued(new ApiError('nokey', 'No API key'));
    this.setBanner(reason);
    this.emit('key');
  }

  // ---- Status ----
  setBanner(msg) {
    if (msg === this.banner) return;
    this.banner = msg;
    this.emit('status');
  }

  status() {
    const now = Date.now();
    return {
      hasKey: this.hasKey(),
      account: this.store.get('api.account'),
      banner: this.banner,
      pausedUntil: this.pausedUntil > now ? this.pausedUntil : 0,
      usedLastMinute: this.log.filter(t => now - t < 60000).length,
      maxPerMinute: this.maxPerMinute(),
      budget: this.budget(),
      // null until the Mentat server reports; then calls elsewhere and everything together
      others: this.othersFresh() ? this.others.n : null,
      othersDetail: this.othersFresh() ? this.others.detail : null,
      total: this.othersFresh() ? this.others.n + this.log.filter(t => now - t < 60000).length : null,
      tornLimit: TORN_LIMIT,
      queued: this.queue.length,
    };
  }

  // Calls made with this player's key elsewhere in the last minute (other Mentat devices, the
  // Mentat server). This device then uses only what's left under ALL_MENTAT_MAX.
  setOthers(n, detail = null) {
    const v = Math.max(0, Math.round(Number(n) || 0));
    const changed = !this.othersFresh() || this.others.n !== v || JSON.stringify(this.others.detail) !== JSON.stringify(detail);
    this.others = { n: v, detail, at: Date.now() };
    if (changed) { this.emit('status'); this.pump(); }
  }

  othersFresh() {
    return !!this.others && Date.now() - this.others.at < OTHERS_FRESH_MS;
  }

  // Requests this device may make per minute right now.
  budget() {
    const own = this.maxPerMinute();
    if (!this.othersFresh()) return own;
    return Math.max(MIN_BUDGET, Math.min(own, ALL_MENTAT_MAX - this.others.n));
  }

  maxPerMinute() {
    const n = Number(this.store.get('api.maxPerMinute')) || 40;
    return Math.min(80, Math.max(10, n));
  }

  // ---- Requests ----
  // path: e.g. '/user/?selections=bars' or '/v2/faction/chain'
  // soft: error codes the caller handles itself (rejected with kind 'soft', no global effect)
  // priority: lower runs first
  // key: test a key that isn't saved yet
  request(path, { soft = [], priority = 5, key = '' } = {}) {
    if (!key && !this.hasKey()) return Promise.reject(new ApiError('nokey', 'No API key'));
    if (!key && Date.now() < this.pausedUntil) return Promise.reject(new ApiError('paused', 'Requests are paused'));
    return new Promise((resolve, reject) => {
      const job = { path, soft, priority, key, resolve, reject };
      const i = this.queue.findIndex(j => j.priority > priority);
      if (i < 0) this.queue.push(job);
      else this.queue.splice(i, 0, job);
      this.pump();
    });
  }

  pump() {
    if (this.timer || !this.queue.length) return;
    const now = Date.now();
    this.log = this.log.filter(t => now - t < 60000);
    let wait = this.lastAt + MIN_GAP_MS - now;
    const budget = this.budget();
    if (this.log.length >= budget) wait = Math.max(wait, 60000 - (now - this.log[this.log.length - budget]) + 50);
    if (wait > 0) {
      this.timer = setTimeout(() => { this.timer = null; this.pump(); }, wait);
      return;
    }
    const job = this.queue.shift();
    this.log.push(now);
    this.lastAt = now;
    this.run(job);
    this.emit('status');
    this.pump();
  }

  async run(job) {
    // These early exits happen synchronously right after pump() logged the slot, so the
    // slot is handed back: nothing was sent to Torn.
    if (!job.key && Date.now() < this.pausedUntil) { this.log.pop(); return job.reject(new ApiError('paused', 'Requests are paused')); }
    const key = job.key || this.getKey();
    if (!key) { this.log.pop(); return job.reject(new ApiError('nokey', 'No API key')); }
    const sep = job.path.includes('?') ? '&' : '?';
    const url = `${API_BASE}${job.path}${sep}key=${encodeURIComponent(key)}&comment=${API_COMMENT}`;

    let data;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS), headers: { Accept: 'application/json' } });
      data = await res.json();
    } catch (e) {
      const msg = e.name === 'TimeoutError' ? 'The Torn API timed out' : 'Could not reach api.torn.com';
      if (!job.key) this.backoff(30, `${msg}.`);
      return job.reject(new ApiError('network', msg));
    }

    if (data && data.error) {
      const { code, error } = data.error;
      if (job.soft.includes(code)) return job.reject(new ApiError('soft', error, code));
      if (code in KEY_ERRORS) {
        if (!job.key) this.clearKey(`API key removed: ${KEY_ERRORS[code]}. Enter a valid key in Settings to resume.`);
        return job.reject(new ApiError('key', KEY_ERRORS[code], code));
      }
      if (!job.key) this.backoff(BACKOFF_ERRORS[code] ?? 300, `Torn API error ${code} (${error}).`);
      return job.reject(new ApiError('backoff', `Torn API error ${code}: ${error}`, code));
    }

    if (!job.key && this.banner && Date.now() >= this.pausedUntil) this.setBanner('');
    job.resolve(data);
  }

  backoff(secs, msg) {
    this.pausedUntil = Date.now() + secs * 1000;
    this.rejectQueued(new ApiError('paused', 'Requests are paused'));
    this.banner = `${msg} Requests paused for ${fmtDur(secs)}.`;
    this.emit('status');
  }

  rejectQueued(err) {
    const queued = this.queue;
    this.queue = [];
    queued.forEach(j => j.reject(err));
  }
}

module.exports = { TornApi, ApiError, KEY_PATTERN };

  },
  "history.js": function (module, exports, require) {
'use strict';
// Local price history, built from data the app already fetches (no extra requests):
// - Torn's market value for every tradable item, each time the item catalog refreshes
// - The lowest item-market listing, each time an item's listings are fetched
// - The cheapest bazaar price (Weav3r), every 2 hours for all items, and whenever one
//   item's bazaar listings are fetched
// Stored in history.json and bazaar-history.json in the app's data folder.

const path = require('path');
const { Store } = require('./store');

const MV_KEEP = 90 * 86400 * 1000;
const LOW_KEEP = 30 * 86400 * 1000;
const LOW_MIN_GAP = 5 * 60 * 1000;
const LOW_MAX_SAMPLES = 3000;
const BAZ_KEEP = 14 * 86400 * 1000;
const BAZ_ALL_GAP = 2 * 3600 * 1000;
const BAZ_MAX_SAMPLES = 1500;

class PriceHistory {
  constructor(dir) {
    this.store = new Store(path.join(dir, 'history.json'), { mv: {}, low: {} }, { debounceMs: 15000 });
    this.baz = new Store(path.join(dir, 'bazaar-history.json'), { baz: {} }, { debounceMs: 10 * 60 * 1000 });
  }

  // Cheapest bazaar price for every item (from the all-items summary).
  recordBazaar(items, t) {
    const baz = this.baz.data.baz;
    for (const [id, [lowest]] of Object.entries(items)) {
      if (!lowest) continue;
      const s = baz[id] || (baz[id] = []);
      const last = s[s.length - 1];
      if (last && t - last[0] < BAZ_ALL_GAP) continue;
      s.push([t, lowest]);
      while (s.length && (t - s[0][0] > BAZ_KEEP || s.length > BAZ_MAX_SAMPLES)) s.shift();
    }
    this.baz.save();
  }

  // Cheapest bazaar price for one item (from a per-item fetch), at most every 5 minutes.
  recordBazaarOne(id, t, price) {
    if (!price) return;
    const baz = this.baz.data.baz;
    const s = baz[id] || (baz[id] = []);
    const last = s[s.length - 1];
    if (last && t - last[0] < LOW_MIN_GAP) { if (last[1] !== price) s[s.length - 1] = [t, price]; }
    else s.push([t, price]);
    while (s.length && (t - s[0][0] > BAZ_KEEP || s.length > BAZ_MAX_SAMPLES)) s.shift();
    this.baz.save();
  }

  // items: id -> [name, type, marketValue, circulation, tradable]
  recordMarketValues(items, t) {
    const mv = this.store.data.mv;
    for (const [id, it] of Object.entries(items)) {
      if (!it[4] || !it[2]) continue;
      const series = mv[id] || (mv[id] = []);
      const last = series[series.length - 1];
      // Market values change about daily: keep a point when it changes, or every 12h.
      if (last && last[1] === it[2] && t - last[0] < 12 * 3600 * 1000) continue;
      series.push([t, it[2]]);
      while (series.length && t - series[0][0] > MV_KEEP) series.shift();
    }
    this.store.save();
  }

  recordLowest(id, t, price) {
    if (!price) return;
    const low = this.store.data.low;
    const series = low[id] || (low[id] = []);
    const last = series[series.length - 1];
    if (last && t - last[0] < LOW_MIN_GAP && last[1] === price) return;
    if (last && t - last[0] < LOW_MIN_GAP) series[series.length - 1] = [t, price];
    else series.push([t, price]);
    while (series.length && (t - series[0][0] > LOW_KEEP || series.length > LOW_MAX_SAMPLES)) series.shift();
    this.store.save();
  }

  item(id) {
    return { mv: this.store.data.mv[id] || [], low: this.store.data.low[id] || [], baz: this.baz.data.baz[id] || [] };
  }

  // Market value change over a period, as a fraction (0.05 = +5%). null if not enough history.
  mvChange(id, periodMs, now = Date.now()) {
    const s = this.store.data.mv[id];
    if (!s || s.length < 2) return null;
    const cur = s[s.length - 1][1];
    let base = null;
    for (const [t, v] of s) {
      if (now - t >= periodMs) base = v;
      else break;
    }
    if (base === null) return null;
    return base ? (cur - base) / base : null;
  }

  // Change summaries for many items at once (for tables).
  trends(ids, now = Date.now()) {
    const out = {};
    for (const id of ids) {
      const d1 = this.mvChange(id, 86400 * 1000, now);
      const d7 = this.mvChange(id, 7 * 86400 * 1000, now);
      if (d1 !== null || d7 !== null) out[id] = { d1, d7 };
    }
    return out;
  }

  flush() {
    this.store.flush();
    this.baz.flush();
  }
}

module.exports = { PriceHistory };

  },
  "restock.js": function (module, exports, require) {
'use strict';
// Restock analysis for abroad shop stock, from YATA readings recorded on this PC.
//
// History format per item: runs of equal readings, [firstSeenMs, quantity, lastSeenMs].
// (Older two-element samples [t, q] are read as runs of length one.)
//
// From the runs we measure, per item:
// - restock events: the quantity rose between two readings, so the restock happened in the
//   window [last reading before, first reading after]
// - sell-out events and how long stock lasts after a restock
// - the restock rhythm (cadence): a period P that puts every observed restock window on the
//   same beat. Missed restocks are fine (their gaps are multiples of P).
// Every item in every country has its own restock timer (the user, 2026-11-18), so an item is only
// predicted from its own restocks. Measured on 38 h of real readings (2026-11-18): the timer starts
// when the item SELLS OUT. 63 of 65 items restocked a near-fixed delay after selling out (Cherry
// Blossom 54.9 ± 1.1 min, Pangolin Scales 30.1 ± 0.2 min), while the time from one restock to the
// next varied by hours. So, in order:
// - sell-out timer: restock = when it sold out + the item's own delay. Sold out now: we know when,
//   so this is tight. In stock: when it will sell out comes from how fast it sells, so looser.
// Items that never sell out (always topped up) fall back to:
// - a fixed beat (period + phase) that its restocks line up on, accepted only if the readings
//   agree: YATA is read every ~2 minutes, so a beat where the stock plainly didn't rise counts
//   against it (this stops a short period that happens to fit a handful of restocks);
// - otherwise its typical gap between restocks (timers that drift: "about every 2 h"), with the
//   spread of those gaps as the margin.
// The country's pooled rhythm is still worked out, for the overview only.

const MIN = 60000;
const TOL = 2 * MIN;           // timing slack when checking a restock against a beat
const RATE_WINDOW = 6 * 3600 * 1000;

const median = xs => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

const runOf = s => [s[0], s[1], s[2] === undefined ? s[0] : s[2]];

// Adds one reading to an item's runs. Returns true if anything changed.
function addReading(runs, t, q) {
  const last = runs[runs.length - 1];
  if (last && t <= (last[2] ?? last[0])) return false;
  if (last && last[1] === q) { last[2] = t; return true; }
  runs.push([t, q, t]);
  return true;
}

function analyzeItem(raw, now) {
  const runs = raw.map(runOf);
  const out = {
    readings: runs.length, rate: null, restocks: [], soldOuts: [], size: null, stay: null, staysInStock: false,
    emptyFor: null, zeroSince: null, lastPositive: null, minuteHist: null, lastSeen: runs.length ? runs[runs.length - 1][2] : 0,
  };
  if (!runs.length) return out;

  // Sell rate while in stock (units/min), last few hours.
  let sold = 0, span = 0;
  for (let i = 1; i < runs.length; i++) {
    const [, q0, e0] = runs[i - 1];
    const [s1, q1] = runs[i];
    if (now - s1 > RATE_WINDOW || q0 <= 0 || q1 > q0) continue;
    sold += q0 - q1;
    span += s1 - runs[i - 1][0];
  }
  if (span >= 20 * MIN) out.rate = sold / (span / MIN);

  const restocks = [], soldOuts = [];
  for (let i = 1; i < runs.length; i++) {
    const [, q0, e0] = runs[i - 1];
    const [s1, q1] = runs[i];
    if (q1 > q0) restocks.push({ from: e0, to: s1, before: q0, after: q1 });
    if (q0 > 0 && q1 === 0) soldOuts.push({ from: e0, to: s1 });
  }
  const mid = w => (w.from + w.to) / 2;
  out.restockTotal = restocks.length;
  out.restocks = restocks.slice(-60);
  out.soldOuts = soldOuts.slice(-60);
  out.size = median(restocks.map(r => r.after));

  // How long stock lasts after a restock, and how long it then stays empty.
  const stays = [], empties = [];
  let keptStock = 0;
  for (const r of restocks) {
    const so = soldOuts.find(s => s.from >= r.to);
    const next = restocks.find(x => x.from >= r.to && x !== r);
    if (so && (!next || mid(so) < mid(next))) {
      stays.push(mid(so) - mid(r));
      if (next) empties.push(mid(next) - mid(so));
    } else if (next) keptStock++;
  }
  out.stay = median(stays);
  out.staysInStock = keptStock > stays.length; // usually still in stock at the next restock
  out.emptyFor = median(empties);

  // Minute of the hour (TCT) for restocks pinned down to a 10-minute window.
  const hist = new Array(12).fill(0);
  let pinned = 0;
  for (const r of restocks) {
    if (r.to - r.from > 10 * MIN) continue;
    hist[Math.floor(new Date(mid(r)).getUTCMinutes() / 5)]++;
    pinned++;
  }
  if (pinned) out.minuteHist = hist;

  const last = runs[runs.length - 1];
  if (last[1] === 0) {
    out.zeroSince = last[0];
    if (runs.length > 1) out.lastPositive = runs[runs.length - 2][2];
  }
  return out;
}

// Finds a period P that puts the restock windows on one beat.
// events: [{ from, to }] - each restock happened somewhere inside its window.
// For every candidate P, each window allows a range of beat timings (phases); a sweep finds
// the phase that the most windows agree on. The longest P that (a) fits >= 85% of windows
// and (b) fits clearly better than chance is chosen, so a 30-min rhythm isn't reported as 15
// and wide windows don't make a short period "fit" everything.
const mod = (x, p) => ((x % p) + p) % p;
function fitCadence(events, check = null) {
  const ev = events.filter(e => e.to >= e.from).sort((a, b) => a.from - b.from);
  // Merge overlapping windows (several items restocking at the same moment), then keep the
  // most recent 60 restock moments.
  const all = [];
  for (const e of ev) {
    const last = all[all.length - 1];
    if (last && e.from <= last.to) {
      const from = Math.max(last.from, e.from), to = Math.min(last.to, e.to);
      if (to >= from) { last.from = from; last.to = to; }
      continue;
    }
    all.push({ from: e.from, to: e.to });
  }
  const merged = all.slice(-60);
  const n = merged.length;
  if (n < 2) return null;
  const t0 = merged[0].from;
  // Two consecutive restocks can't be further apart than the outer edges of their windows.
  let maxP = Infinity;
  for (let i = 1; i < n; i++) maxP = Math.min(maxP, merged[i].to - merged[i - 1].from);
  maxP = Math.min(maxP + TOL, 3 * 3600 * 1000);
  const STEP = MIN / 4;

  for (let P = Math.floor(maxP / STEP) * STEP; P >= 5 * MIN; P -= STEP) {
    const pts = [];
    let always = 0, chance = 0;
    for (const e of merged) {
      const lo = e.from - TOL - t0, hi = e.to + TOL - t0;
      chance += Math.min(1, (hi - lo) / P);
      if (hi - lo >= P) { always++; continue; }
      const a = mod(lo, P), b = mod(hi, P);
      if (a <= b) pts.push([a, 1], [b, -1]);
      else pts.push([a, 1], [P, -1], [0, 1], [b, -1]);
    }
    pts.sort((x, y) => x[0] - y[0] || y[1] - x[1]);
    let cur = 0, best = 0, bStart = 0, bEnd = 0, open = false;
    for (const [pos, d] of pts) {
      if (d > 0) {
        cur++;
        if (cur > best) { best = cur; bStart = pos; open = true; }
      } else {
        if (open && cur === best) { bEnd = pos; open = false; }
        cur--;
      }
    }
    if (!pts.length) { bStart = 0; bEnd = P; }
    const fit = best + always;
    const share = fit / n;
    if (fit < 2 || share < 0.85 || share - chance / n < 0.25) continue;
    const phase = (bStart + bEnd) / 2;
    if (check && !check(P, t0 + phase)) continue; // the readings show no restock at too many of its beats
    const lastMid = (merged[n - 1].from + merged[n - 1].to) / 2;
    const k = Math.round((lastMid - t0 - phase) / P);
    const unc = Math.max(MIN / 2, (bEnd - bStart) / 2);
    return {
      period: P,
      anchor: t0 + phase + k * P,
      uncertainty: Math.min(10 * MIN, unc),
      events: fit,
      share,
      confidence: fit >= 6 && share >= 0.9 && unc <= 3 * MIN ? 'high' : fit >= 3 ? 'medium' : 'low',
    };
  }
  return null;
}

// Predicted restock times after `from`, up to `horizon` ms ahead.
function nextRestocks(cad, from, horizon = 8 * 3600 * 1000) {
  if (!cad) return [];
  const out = [];
  let k = Math.ceil((from - cad.anchor) / cad.period);
  if (cad.kind === 'sellout' && k < 0) k = 0; // nothing before the next restock
  for (let t = cad.anchor + k * cad.period; t <= from + horizon; k++, t = cad.anchor + k * cad.period) out.push(t);
  return out;
}

// The sell-out timer: restock = sell-out + the item's delay (see the top of this file).
// Returns a cadence whose anchor is the next restock (nothing before it), period = one full cycle
// (time stock usually lasts + the delay), or null when there's too little to go on.
function selloutCadence(runs, a, now) {
  if (runs.length < 3) return null;
  const ev = [];
  for (let i = 1; i < runs.length; i++) {
    const e0 = runs[i - 1][2], s1 = runs[i][0];
    if (s1 - e0 > 10 * MIN) continue; // only moments pinned down to a few minutes
    const t = (e0 + s1) / 2;
    if (runs[i][1] > runs[i - 1][1]) ev.push({ t, k: 'r', from0: runs[i - 1][1] === 0 });
    if (runs[i - 1][1] > 0 && runs[i][1] === 0) ev.push({ t, k: 's' });
  }
  const delays = [];
  let lastS = null, lastR = null;
  for (const e of ev) {
    if (e.k === 's') { lastS = e.t; continue; }
    if (e.from0 && lastS !== null && (lastR === null || lastS > lastR)) delays.push(e.t - lastS);
    lastR = e.t;
    lastS = null;
  }
  if (delays.length < 3) return null;
  const D = median(delays);
  const spread = median(delays.map(d => Math.abs(d - D)));
  if (D < 2 * MIN || spread > D * 0.5) return null; // not a timer
  a.selloutDelay = { delay: D, spread, events: delays.length }; // kept for the page even when it can't predict now
  const last = runs[runs.length - 1];
  const drain = a.size && a.stay ? a.size / (a.stay / MIN) : a.rate; // units per minute while in stock
  let next, unc = Math.max(MIN, spread * 1.5 + MIN), soldOut = last[1] === 0;
  if (soldOut) {
    const prev = runs[runs.length - 2];
    if (last[0] - prev[2] > 10 * MIN) return null; // don't know when it sold out
    next = (prev[2] + last[0]) / 2 + D;
    if (now > next + 3 * unc + 10 * MIN) return null; // long overdue: the timer isn't behaving
  } else {
    if (!drain) return null;
    const toOut = (last[1] / drain) * MIN;
    next = last[2] + toOut + D;
    unc += toOut * 0.3; // how fast it sells varies
  }
  const lasts = a.stay || (a.size && drain ? (a.size / drain) * MIN : D);
  return {
    kind: 'sellout', anchor: next, period: lasts + D, uncertainty: Math.min(unc, 60 * MIN), delay: D, delaySpread: spread,
    events: delays.length, share: 1, soldOut,
    confidence: soldOut ? (delays.length >= 5 && spread <= 3 * MIN ? 'high' : spread <= 8 * MIN ? 'medium' : 'low') : unc <= 10 * MIN ? 'medium' : 'low',
  };
}

// Do the readings agree with a beat? For each beat inside the readings, look at the readings
// around it: a rise there is a hit; readings on both sides close together with no rise are a miss
// (a restock would have shown, unless the stock was already about full). Accept when at least 60%
// of the beats that could be checked were hits.
function beatsAgree(runs, a, P, anchor) {
  if (runs.length < 2) return true;
  // Only the item's latest restocks are kept: check beats from the oldest of those on.
  const start = a.restockTotal > a.restocks.length ? a.restocks[0].from : runs[0][0];
  const end = runs[runs.length - 1][2];
  const full = a.size ? a.size * 0.9 : Infinity;
  let k = Math.ceil((start - anchor) / P), checked = 0, hits = 0, i = 0;
  for (let B = anchor + k * P; B <= end; k++, B = anchor + k * P) {
    while (i < runs.length - 1 && runs[i + 1][0] <= B - TOL) i++;
    const lo = B - TOL, hi = B + TOL;
    if (a.restocks.some(r => r.to >= lo && r.from <= hi)) { checked++; hits++; continue; }
    // The run holding the moment just before the beat, and the next reading after it.
    const run = runs[i];
    const next = runs[i + 1];
    if (!run || run[0] > lo) continue;
    if (run[1] >= full) continue; // already about full: a restock might not show
    const afterAt = run[2] >= hi ? hi : next ? next[0] : Infinity;
    if (afterAt - Math.min(run[2], lo) > 6 * MIN && run[2] < hi) continue; // a gap in the readings
    checked++;
  }
  return checked < 4 || hits / checked >= 0.6;
}

// A timer that drifts: its typical gap between restocks. Long gaps that are about whole
// multiples of the typical one count as missed restocks. The margin is the spread of the gaps.
function intervalCadence(restocks, now) {
  const mids = restocks.map(r => (r.from + r.to) / 2).sort((x, y) => x - y);
  if (mids.length < 3) return null;
  const gaps = [];
  for (let i = 1; i < mids.length; i++) gaps.push(mids[i] - mids[i - 1]);
  const base = median(gaps);
  if (!base || base < 5 * MIN) return null;
  const norm = gaps.map(g => g / Math.max(1, Math.round(g / base)));
  const period = median(norm);
  const spread = median(norm.map(g => Math.abs(g - period))) || MIN;
  const uncertainty = Math.max(2 * MIN, Math.min(30 * MIN, spread * 1.5));
  const anchor = mids[mids.length - 1];
  // A timer this loose can't be stretched far: no prediction once three beats have gone unseen.
  if (now - anchor > 3 * period + uncertainty) return null;
  return {
    period, anchor, uncertainty, events: mids.length, share: 1, kind: 'interval',
    confidence: mids.length >= 6 && uncertainty <= 5 * MIN ? 'medium' : 'low',
  };
}

// Full analysis for one country: items -> runs. Returns per-item stats with a cadence
// (the item's own if it has one, else the country's) and upcoming restock times.
function analyzeCountry(items, now) {
  const stats = {};
  const pooled = [];
  for (const [id, runs] of Object.entries(items)) {
    const a = analyzeItem(runs, now);
    stats[id] = a;
    pooled.push(...a.restocks);
  }
  const countryCad = fitCadence(pooled);
  for (const [id, a] of Object.entries(stats)) {
    const runs = items[id].map(runOf);
    let own = selloutCadence(runs, a, now);
    if (!own && a.restocks.length >= 3) {
      own = fitCadence(a.restocks, (P, anchor) => beatsAgree(runs, a, P, anchor));
      if (own) own.kind = 'beat';
      else own = intervalCadence(a.restocks, now);
    }
    a.cadence = own ? { ...own, source: 'item' } : null;
    a.next = nextRestocks(a.cadence, now - (a.cadence ? a.cadence.uncertainty : 0)).slice(0, 12);
    a.restockCount = a.restockTotal;
    // Keep the snapshot sent to the UI small.
    a.restocks = a.restocks.slice(-12);
    a.soldOuts = a.soldOuts.slice(-12);
  }
  return { stats, cadence: countryCad, pooledRestocks: pooled.length };
}

module.exports = { addReading, analyzeItem, fitCadence, nextRestocks, analyzeCountry, median, beatsAgree, intervalCadence, selloutCadence };

  },
  "syncmerge.js": function (module, exports, require) {
'use strict';
// Shared by the app and the sync server (server/server.js): which settings sync between
// PCs, and how two copies of the collected data are combined.

// Settings that follow you between PCs. Each is synced as one value. Left out on purpose:
// keys (they're encrypted for one PC), window positions, the open tab and zoom, the sync
// settings themselves, and anything that's only a cache.
const SYNC_UNITS = [
  'ui.theme', 'ui.themeAuto', 'ui.themeDark', 'ui.themeLight', 'ui.accent', 'ui.clockZone', 'ui.clockThird', 'ui.clock24', 'ui.browserClocks',
  'ui.popupStyle', 'ui.popupSeconds', 'ui.popupCorner', 'ui.navLayout', 'ui.navCollapsed', 'ui.tabLayout', 'ui.nav', 'ui.condensed',
  'ui.setupDone', 'ui.buttons', 'ui.urgent', 'ui.urgentSound', 'ui.urgentRepeat',
  'user.interval', 'user.notify',
  'chain.enabled', 'chain.alerts', 'chain.desktop', 'chain.sound', 'chain.volume', 'chain.minChain',
  'chain.t150', 'chain.t90', 'chain.t60', 'chain.t30',
  'targets.list', 'targets.autoRefresh', 'targets.interval', 'targets.notify',
  'travel.yata', 'travel.method', 'travel.capacity', 'travel.sellMode', 'travel.feePct', 'travel.book',
  'travel.outbound', 'travel.restockInterval', 'travel.restockOffset',
  'travel.override', 'travel.learned',
  'market.watch', 'market.watchInterval', 'market.payoutPct', 'market.bazaar', 'market.priceSource',
  'alerts.rules', 'alerts.volume',
  'gamble.log', 'gamble.session',
  'planner.items', 'planner.days',
  'war.watchId', 'war.interval', 'war.live', 'war.pinned', 'research.watchId',
  'ffscouter.intervalHours', 'scout.spread',
  // FFScouter Premium's end (from any device's key check) and the end date already reminded about,
  // so the 24-hour reminder shows once across all your devices (core.js premiumReminder).
  'ffscouter.premiumUntil', 'ffscouter.premiumReminded',
  'chatwin.emojis', 'chatwin.onTop', 'chatwin.minimizeToBubble', 'chatwin.compact', 'chatwin.hideInBrowser',
];
const UNIT_SET = new Set(SYNC_UNITS);

// The synced unit a settings path belongs to ('user.notify.energy' -> 'user.notify').
function unitFor(p) {
  p = String(p || '');
  if (p === 'ui.tabLayoutReset') return 'ui.tabLayout';
  return SYNC_UNITS.find(u => p === u || p.startsWith(`${u}.`)) || null;
}

// Collected data that can be pulled from (and uploaded to) a sync server.
// 'scout' is pull-only: the server's scouting view (it never takes a PC's copy).
// mugger: Mugger's market database (features/muggerdb.js), collected by the server; apps only read it.
const DATASETS = ['research', 'war', 'travel', 'prices', 'bazaar', 'scout', 'mugger'];
const PULL_ONLY = new Set(['scout', 'mugger']);

const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);

// Two time series of [time, ...values]: every point from both, oldest first. On the same
// time, b's point wins. Keeps the newest `max` points.
function mergeSeries(a, b, max = 0) {
  if (!Array.isArray(a) || !a.length) return Array.isArray(b) ? b.slice(-max || undefined) : [];
  if (!Array.isArray(b) || !b.length) return a.slice(-max || undefined);
  const byT = new Map();
  for (const p of a) if (Array.isArray(p)) byT.set(p[0], p);
  for (const p of b) if (Array.isArray(p)) byT.set(p[0], p);
  const out = [...byT.values()].sort((x, y) => x[0] - y[0]);
  return max && out.length > max ? out.slice(out.length - max) : out;
}

// id -> series maps (price history).
function mergeSeriesMap(a, b, max) {
  const out = isObj(a) ? a : {};
  if (!isObj(b)) return out;
  for (const [id, s] of Object.entries(b)) out[id] = mergeSeries(out[id], s, max);
  return out;
}

// history.json: { mv, low }
function mergePrices(local, remote) {
  local = isObj(local) ? local : {};
  remote = isObj(remote) ? remote : {};
  local.mv = mergeSeriesMap(local.mv, remote.mv, 1000);
  local.low = mergeSeriesMap(local.low, remote.low, 3000);
  return local;
}

// bazaar-history.json: { baz }
function mergeBazaar(local, remote) {
  local = isObj(local) ? local : {};
  local.baz = mergeSeriesMap(local.baz, isObj(remote) ? remote.baz : null, 1500);
  return local;
}

// war.json: { history: { warId, points, avail }, trips, abroad }
function mergeWar(local, remote) {
  local = isObj(local) ? local : {};
  remote = isObj(remote) ? remote : {};
  const lh = local.history, rh = remote.history;
  if (rh && (!lh || rh.warId > lh.warId)) local.history = rh;
  else if (rh && lh && rh.warId === lh.warId) {
    lh.points = mergeSeries(lh.points, rh.points, 4000);
    lh.avail = mergeSeries(lh.avail, rh.avail, 4000);
  }
  // Travel: the other copy may have caught a departure this one missed.
  local.trips = isObj(local.trips) ? local.trips : {};
  for (const [id, t] of Object.entries(isObj(remote.trips) ? remote.trips : {})) {
    const mine = local.trips[id];
    if (!mine || (mine.desc === t.desc && !mine.departLo && t.departLo)) local.trips[id] = t;
  }
  local.abroad = isObj(local.abroad) ? local.abroad : {};
  for (const [id, a] of Object.entries(isObj(remote.abroad) ? remote.abroad : {})) if (!local.abroad[id]) local.abroad[id] = a;
  return local;
}

// research.json: { factions: { id: record } }. A faction collected in both places keeps
// the copy with more samples (the counts can't be added without counting hours twice).
function mergeResearch(local, remote) {
  local = isObj(local) ? local : {};
  local.factions = isObj(local.factions) ? local.factions : {};
  for (const [id, r] of Object.entries(isObj(remote) && isObj(remote.factions) ? remote.factions : {})) {
    const mine = local.factions[id];
    if (!mine || (r.samples || 0) > (mine.samples || 0) || ((r.samples || 0) === (mine.samples || 0) && (r.lastSample || 0) > (mine.lastSample || 0))) local.factions[id] = r;
  }
  return local;
}

// travel-history.json: { countries: { code: { update, since, latest, items } } }. Keeps
// whichever copy of each country has more readings, then the newest latest stock.
function mergeTravel(local, remote) {
  local = isObj(local) ? local : {};
  local.countries = isObj(local.countries) ? local.countries : {};
  const runs = c => Object.values((c && c.items) || {}).reduce((n, r) => n + (Array.isArray(r) ? r.length : 0), 0);
  for (const [code, c] of Object.entries(isObj(remote) && isObj(remote.countries) ? remote.countries : {})) {
    const mine = local.countries[code];
    if (!mine) { local.countries[code] = c; continue; }
    const keep = runs(c) > runs(mine) ? c : mine;
    const newer = (c.update || 0) > (mine.update || 0) ? c : mine;
    local.countries[code] = { ...keep, latest: newer.latest, update: Math.max(keep.update || 0, newer.update || 0) };
  }
  return local;
}

const MERGE = { research: mergeResearch, war: mergeWar, travel: mergeTravel, prices: mergePrices, bazaar: mergeBazaar };

// Settings collections that are combined (not replaced) the first time a PC joins a
// server, so nothing either side already had is lost.
// Two copies of the plan, merged item by item: the newer edit of each item wins. Removed items are
// kept as { id, deleted: true, at, updatedAt } (planner.js), so a removal on one device isn't
// undone by another device that still has the item.
function mergePlan(a, b) {
  const out = { ...(isObj(a) ? a : {}) };
  for (const [id, it] of Object.entries(isObj(b) ? b : {})) {
    if (!isObj(it)) continue;
    const mine = out[id];
    if (!isObj(mine) || (Number(it.updatedAt) || 0) >= (Number(mine.updatedAt) || 0)) out[id] = it;
  }
  return out;
}

// The plan without what every device drops anyway (planner.js): items a week past their time and
// removal markers a month after the removal. The server uses this too, so its copy doesn't grow.
function prunePlan(items, now = Date.now()) {
  const out = {};
  for (const [id, it] of Object.entries(isObj(items) ? items : {})) {
    if (!isObj(it) || now - (Number(it.at) || 0) >= 7 * 86400e3) continue;
    if (it.deleted && now - (Number(it.updatedAt) || 0) > 30 * 86400e3) continue;
    out[id] = it;
  }
  return out;
}

// Dates that only move forward: the later of the two copies wins.
const LATEST_UNITS = new Set(['ffscouter.premiumUntil', 'ffscouter.premiumReminded']);
const latest = (a, b) => Math.max(Number(a) || 0, Number(b) || 0);

function joinUnit(unit, local, remote) {
  if (LATEST_UNITS.has(unit)) return latest(local, remote);
  if (unit === 'planner.items') return mergePlan(local, remote);
  if (unit === 'targets.list' || unit === 'market.watch' || unit === 'travel.learned' || unit === 'travel.override' || unit === 'gamble.log') {
    return { ...(isObj(local) ? local : {}), ...(isObj(remote) ? remote : {}) };
  }
  if (unit === 'war.pinned') return [...new Set([...(Array.isArray(remote) ? remote : []), ...(Array.isArray(local) ? local : [])])].slice(-500);
  if (unit === 'alerts.rules') {
    const out = Array.isArray(remote) ? [...remote] : [];
    for (const r of Array.isArray(local) ? local : []) if (r && !out.some(x => x && x.id === r.id)) out.push(r);
    return out;
  }
  return remote;
}

// A setting another PC changed, applied here. Targets keep this PC's fresher status
// checks; watched items keep whether this PC already alerted.
function applyUnit(unit, local, remote) {
  if (LATEST_UNITS.has(unit)) return latest(local, remote);
  if (unit === 'targets.list' && isObj(remote)) {
    const out = {};
    for (const [id, t] of Object.entries(remote)) {
      const mine = isObj(local) ? local[id] : null;
      out[id] = mine && (mine.lastFetched || 0) >= ((t && t.lastFetched) || 0) ? mine : t;
    }
    return out;
  }
  if (unit === 'market.watch' && isObj(remote)) {
    const out = {};
    for (const [id, w] of Object.entries(remote)) {
      if (!isObj(w)) continue;
      const mine = isObj(local) ? local[id] : null;
      const { alerted, ...rest } = w;
      // Same alert price: keep this PC's "already alerted" note (a new price clears it).
      out[id] = mine && mine.alerted && mine.below === w.below ? { ...rest, alerted: mine.alerted } : rest;
    }
    return out;
  }
  return remote;
}

module.exports = { SYNC_UNITS, UNIT_SET, unitFor, DATASETS, PULL_ONLY, MERGE, mergeSeries, mergePlan, prunePlan, joinUnit, applyUnit };

  },
  "sync.js": function (module, exports, require) {
'use strict';
// Data source: this PC (default) or a Mentat sync server (server/server.js) that
// collects around the clock. With a server:
// - Oppo research and abroad stock come from the server; this PC stops collecting them
//   (and takes over again if the server can't be reached for 10 minutes).
// - War history and price history are combined with this PC's own.
// - Synced settings (targets, alerts, watched items, appearance...) go both ways.
// Requests go only to the server address you enter, with your access token (and Cloudflare
// Access service token, if you use one). All three are encrypted with Windows (DPAPI).

const zlib = require('zlib');
const { promisify } = require('util');
const { EventEmitter } = require('events');
const { safeStorage } = require('electron');
const { SYNC_UNITS, unitFor, DATASETS, PULL_ONLY, MERGE, joinUnit, applyUnit } = require('./syncmerge');

const gzip = promisify(zlib.gzip);
const STATUS_EVERY = 60e3;
const RETRY_AFTER_ERROR = 30e3;
const PUSH_DELAY = 2500;
const COVER_GRACE = 10 * 60e3; // server unreachable this long -> collect here again
const START_GRACE = 3 * 60e3;  // ...but not in the first minutes after launch
// How often each data set may be downloaded (when the server says it changed).
const PULL_EVERY = { research: 2 * 60e3, war: 60e3, travel: 2 * 60e3, prices: 30 * 60e3, bazaar: 30 * 60e3, scout: 5 * 60e3, mugger: 30 * 60e3 };
// After you pick a faction to research: check every 10 s (for up to 5 minutes) until its first data arrives.
const RESEARCH_WAIT = 5 * 60e3;
const RESEARCH_WAIT_POLL = 10e3;
// Commands that change synced settings (settings.set is handled by path).
const AFTER_COMMAND = {
  'targets.add': ['targets.list'], 'targets.addCurrent': ['targets.list'], 'targets.remove': ['targets.list'], 'targets.clear': ['targets.list'],
  'alerts.add': ['alerts.rules'], 'alerts.update': ['alerts.rules'], 'alerts.remove': ['alerts.rules'],
  'market.watch.add': ['market.watch'], 'market.watch.below': ['market.watch'], 'market.watch.remove': ['market.watch'],
  'war.watch': ['war.watchId'], 'war.pin': ['war.pinned'], 'research.watch': ['research.watchId'],
  'travel.learned.clear': ['travel.learned'],
  'casino.log.add': ['gamble.log'], 'casino.log.update': ['gamble.log'], 'casino.log.remove': ['gamble.log'], 'casino.log.clear': ['gamble.log'],
  'casino.session': ['gamble.session'],
  'planner.add': ['planner.items'], 'planner.update': ['planner.items'], 'planner.remove': ['planner.items'],
  'planner.copyDay': ['planner.items'], 'planner.clearDay': ['planner.items'],
};

const PRIVATE_HOST = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\]|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|[a-z0-9-]+\.local|[a-z0-9-]+)$/i;

function cleanUrl(u) {
  u = String(u || '').trim().replace(/\/+$/, '');
  if (!u) return '';
  let url;
  try { url = new URL(u); } catch (e) { throw new Error('That isn\'t a web address (example: https://example.com/torn-desktop).'); }
  if (url.protocol === 'http:' && !PRIVATE_HOST.test(url.hostname)) throw new Error('Use https:// for a server outside your home network (http:// would send your token unencrypted).');
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('The address must start with https://');
  if (url.username || url.password || url.search || url.hash) throw new Error('Enter just the server address, without a login, ? or #.');
  return url.href.replace(/\/+$/, '');
}

class SyncFeature extends EventEmitter {
  constructor({ store, research, travel, war, history, scout = null, onSettings, version, defaultServer = '', api = null }) {
    super();
    this.store = store;
    // Torn counts every call made with your key, from any device or the server, against one
    // limit. Each status check tells the server how many calls this device made in the last
    // minute; the server answers with the calls made elsewhere (api.setOthers).
    this.api = api;
    if (!this.store.get('sync.deviceId')) this.store.set('sync.deviceId', `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`);
    this.defaultServer = defaultServer; // the server this build signs in to unless another is entered
    this.signedOut = this.store.get('sync.signedOut') || ''; // why a member session ended
    this.me = this.store.get('sync.me') || null;
    this.research = research;
    this.scout = scout;
    this.travel = travel;
    this.war = war;
    this.history = history;
    this.onSettings = onSettings;
    this.version = version;
    this.startedAt = Date.now();
    this.inFlight = false;
    this.nextPoll = 0;
    this.server = null;   // last /status
    this.lastOkAt = 0;
    this.error = '';
    this.pulledRev = {};  // data set -> server rev applied here
    this.pulledAt = {};
    this.pullErrors = {}; // data set -> why its last pull failed (the others still pull)
    this.dirtyAt = 0;
    this.upload = null;   // { running, done, error, at }
    this.dirty = new Set(this.store.get('sync.dirty') || []);
  }

  mode() { return this.store.get('sync.mode') === 'server' ? 'server' : 'local'; }
  url() { return this.store.get('sync.url') || ''; }

  secret(name) {
    const enc = this.store.get(`sync.${name}Enc`);
    if (!enc) return '';
    try { return safeStorage.decryptString(Buffer.from(enc, 'base64')); } catch (e) { return ''; }
  }

  setSecret(name, value) {
    if (!value) { this.store.set(`sync.${name}Enc`, ''); return; }
    let enc;
    try { enc = safeStorage.encryptString(value).toString('base64'); } catch (e) { throw new Error('Windows encryption is unavailable, so the token cannot be stored safely.'); }
    this.store.set(`sync.${name}Enc`, enc);
  }

  configured() { return this.mode() === 'server' && !!this.url() && !!this.store.get('sync.tokenEnc'); }

  // 'token': the server owner's access token. 'session': a member signed in with their Torn key.
  kind() { return this.store.get('sync.kind') === 'session' ? 'session' : 'token'; }
  signedIn() { return this.configured() && !(this.kind() === 'session' && this.signedOut); }

  // ---- Signing in with your own Torn API key ----
  async health(url) {
    url = cleanUrl(url || this.url() || this.defaultServer);
    const res = await fetch(`${url}/api/v1/health`, { headers: { Accept: 'application/json', 'User-Agent': 'Mentat' }, redirect: 'manual', signal: AbortSignal.timeout(15e3) });
    if (!res.ok || !(res.headers.get('content-type') || '').includes('json')) throw new Error("That address isn't a Mentat server.");
    const j = await res.json();
    return { url, faction: j.faction || null, login: !!j.login };
  }

  async login({ url, key, device = '' } = {}) {
    url = cleanUrl(url || this.url() || this.defaultServer);
    if (!url) throw new Error('Enter the Mentat server address.');
    let res;
    try {
      res = await fetch(`${url}/api/v1/login`, {
        method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(30e3),
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': 'Mentat' },
        body: JSON.stringify({ key: String(key || ''), device }),
      });
    } catch (e) {
      throw new Error(e.name === 'TimeoutError' ? 'The Mentat server took too long to answer.' : `Can't reach the Mentat server (${(e.cause && e.cause.code) || e.message}).`);
    }
    if (res.status >= 300 && res.status < 400) throw new Error('That address sends sign-ins to a login page: it needs to be the public Mentat address.');
    let j = null;
    try { j = await res.json(); } catch (e) { /* not JSON */ }
    if (!j) throw new Error(`That address isn't a Mentat server (HTTP ${res.status}).`);
    if (!res.ok) throw Object.assign(new Error(j.error || `The server answered HTTP ${res.status}.`), { code: j.code });
    if (url !== this.url()) this.resetServer();
    this.store.set('sync.url', url);
    this.store.set('sync.mode', 'server');
    this.store.set('sync.kind', 'session');
    this.setSecret('token', j.session);
    this.setSecret('cfId', '');
    this.setSecret('cfSecret', '');
    this.setSignedOut('');
    this.me = j.me || null;
    this.store.set('sync.me', this.me);
    this.error = '';
    this.lastOkAt = 0;
    this.startedAt = Date.now();
    this.nextPoll = 0;
    this.emitState();
    this.poll().catch(() => {});
    return this.snapshot();
  }

  async logout() {
    if (this.kind() === 'session' && this.configured()) { try { await this.req('POST', 'logout', { body: {} }); } catch (e) { /* signed out here anyway */ } }
    this.setSecret('token', '');
    this.store.set('sync.kind', 'session');
    this.setSignedOut('You signed out.');
    this.me = null;
    this.store.set('sync.me', null);
    this.server = null;
    this.lastOkAt = 0;
    this.emitState();
    return this.snapshot();
  }

  setSignedOut(why) {
    this.signedOut = why || '';
    this.store.set('sync.signedOut', this.signedOut);
  }

  // True once this device has the server's copy of a data set (this session).
  hasPulled(name) { return !!this.pulledRev[name]; }

  // True once this device has checked the server's synced settings (this session): what other
  // devices did (e.g. already showed a once-only reminder) is known by then.
  settingsFresh() { return !!this.settingsAt; }

  // True while the server collects research and abroad stock instead of this PC.
  covering(now = Date.now()) {
    if (!this.configured()) return false;
    if (this.lastOkAt) return now - this.lastOkAt < COVER_GRACE;
    return now - this.startedAt < START_GRACE;
  }

  // From Settings. Secrets left blank keep the saved ones ("clear" removes them).
  async configure(c = {}) {
    const mode = c.mode === 'server' ? 'server' : 'local';
    if (mode === 'server') {
      const url = cleanUrl(c.url);
      if (!url) throw new Error('Enter the server address.');
      const token = String(c.token || '').trim();
      if (!token && !this.store.get('sync.tokenEnc')) throw new Error('Enter the access token from the server.');
      if (token && (token.length < 24 || token.length > 200 || /\s/.test(token))) throw new Error('That access token doesn\'t look right (it\'s a long string without spaces).');
      const cfId = String(c.cfId || '').trim();
      const cfSecret = String(c.cfSecret || '').trim();
      if (cfId.length > 200 || cfSecret.length > 200 || /\s/.test(cfId + cfSecret)) throw new Error('Those Cloudflare Access details don\'t look right.');
      if (url !== this.url()) this.resetServer();
      this.store.set('sync.url', url);
      if (token) { this.setSecret('token', token); this.store.set('sync.kind', 'token'); this.setSignedOut(''); }
      if (c.clearCf) { this.setSecret('cfId', ''); this.setSecret('cfSecret', ''); }
      if (cfId) this.setSecret('cfId', cfId);
      if (cfSecret) this.setSecret('cfSecret', cfSecret);
    }
    this.store.set('sync.mode', mode);
    this.error = '';
    this.lastOkAt = 0;
    this.startedAt = Date.now();
    this.nextPoll = 0;
    this.emitState();
    if (mode === 'server') await this.poll();
    return this.snapshot();
  }

  // Forget what came from the previous server (a new address is a different server).
  resetServer() {
    this.store.set('sync.serverId', '');
    this.store.set('sync.settingsRev', 0);
    this.pulledRev = {};
    this.pulledAt = {};
    this.server = null;
  }

  forget() {
    this.store.set('sync.mode', 'local');
    this.store.set('sync.url', '');
    for (const n of ['token', 'cfId', 'cfSecret']) this.setSecret(n, '');
    this.store.set('sync.kind', '');
    this.me = null;
    this.store.set('sync.me', null);
    this.store.set('sync.joinedId', '');
    this.resetServer();
    this.dirty.clear();
    this.store.set('sync.dirty', []);
    this.error = '';
    this.lastOkAt = 0;
    this.emitState();
  }

  // ---- Requests ----
  async req(method, p, { body = null, raw = false } = {}) {
    const headers = { Authorization: `Bearer ${this.secret('token')}`, Accept: 'application/json', 'Accept-Encoding': 'gzip', 'User-Agent': 'Mentat' };
    const cfId = this.secret('cfId'), cfSecret = this.secret('cfSecret');
    if (cfId && cfSecret) { headers['CF-Access-Client-Id'] = cfId; headers['CF-Access-Client-Secret'] = cfSecret; }
    if (p === 'status') {
      headers['X-Mentat-Device'] = this.store.get('sync.deviceId') || '';
      if (this.api) headers['X-Mentat-Used'] = String(this.api.status().usedLastMinute);
    }
    let payload;
    if (body !== null) {
      headers['Content-Type'] = 'application/json';
      payload = Buffer.from(JSON.stringify(body));
      if (payload.length > 32 * 1024) { payload = await gzip(payload); headers['Content-Encoding'] = 'gzip'; }
    }
    let res;
    for (let attempt = 0; ; attempt++) {
      try {
        res = await fetch(`${this.url()}/api/v1/${p}`, { method, headers, body: payload, redirect: 'manual', signal: AbortSignal.timeout(method === 'GET' ? 45e3 : 120e3) });
        break;
      } catch (e) {
        // A connection the server already closed: try a reading request once more.
        if (attempt === 0 && method === 'GET' && e.name !== 'TimeoutError') continue;
        throw new Error(e.name === 'TimeoutError' ? 'The server took too long to answer' : `Can't reach the server (${(e.cause && e.cause.code) || e.message})`);
      }
    }
    if (res.status >= 300 && res.status < 400) throw new Error('The server redirected to a login page: check the Cloudflare Access service token');
    if (res.status === 401) {
      if (this.kind() === 'session') {
        let why = '';
        try { why = (await res.json()).error || ''; } catch (e) { /* no reason given */ }
        this.setSignedOut(why || 'You were signed out.');
        this.emitState();
        throw new Error('Signed out');
      }
      throw new Error('The server rejected the access token');
    }
    if (res.status === 403) throw new Error('Access denied (403): check the Cloudflare Access service token');
    if (res.status === 429) throw new Error('Too many failed attempts: the server is refusing for a few minutes');
    if (!res.ok) throw new Error(`The server answered HTTP ${res.status}`);
    if (raw) return res;
    const type = res.headers.get('content-type') || '';
    if (!type.includes('json')) throw new Error('That address isn\'t a Mentat sync server (it answered with a web page)');
    return res.json();
  }

  // ---- Loop ----
  tick(now) {
    if (this.mode() !== 'server' || !this.signedIn() || this.inFlight) return;
    if (now >= this.nextPoll || (this.dirty.size && now - this.dirtyAt >= PUSH_DELAY && this.lastOkAt)) this.poll().catch(() => {});
  }

  async poll() {
    if (this.inFlight || !this.signedIn()) return this.snapshot();
    this.inFlight = true;
    const now = Date.now();
    try {
      const st = await this.req('GET', 'status');
      if (st.app !== 'torn-desktop-server') throw new Error('That address isn\'t a Mentat sync server');
      if (st.serverId !== this.store.get('sync.serverId')) {
        this.resetServer();
        this.store.set('sync.serverId', st.serverId);
      }
      const wasCovering = this.covering(now);
      this.server = st;
      // Calls made with this player's key elsewhere (older servers don't report them).
      if (this.api && st.usage) this.api.setOthers((st.usage.server || 0) + (st.usage.push || 0) + (st.usage.devices || 0), st.usage);
      this.lastOkAt = Date.now();
      this.error = '';
      await this.syncSettings(st);
      // First time on this server: add what this PC has collected to the server's copy
      // before taking anything from it, so nothing collected here is lost.
      if (st.me) { this.me = st.me; this.store.set('sync.me', st.me); }
      if (this.kind() === 'session' && this.store.get('sync.joinedId') !== st.serverId) this.store.set('sync.joinedId', st.serverId);
      if (this.store.get('sync.joinedId') !== st.serverId) {
        this.upload = { running: true, done: [], error: '', at: Date.now(), auto: true };
        this.emitState();
        await this.sendAll();
        this.upload.running = false;
        this.store.set('sync.joinedId', st.serverId);
        this.pulledRev = {};
      }
      for (const name of DATASETS) {
        if (!st.revs || !st.revs[name] || st.revs[name] === this.pulledRev[name]) continue;
        if (this.pulledRev[name] && now - (this.pulledAt[name] || 0) < PULL_EVERY[name] && !(name === 'research' && this.researchWaiting(now))) continue;
        if (!st.collect || st.collect[name] === false) continue;
        // One data set failing (a bad download, a merge error) must not stop the ones after it.
        try {
          await this.pull(name, st);
          delete this.pullErrors[name];
        } catch (e) {
          if (e.message === 'Signed out') throw e;
          this.pullErrors[name] = e.message || String(e);
          this.pulledAt[name] = Date.now(); // try again after the usual wait, not every poll
        }
      }
      if (!wasCovering) { this.research.emit('state'); this.travel.emit('state'); }
      this.nextPoll = Date.now() + (this.researchWaiting() ? RESEARCH_WAIT_POLL : STATUS_EVERY);
    } catch (e) {
      this.error = e.message;
      if (this.upload && this.upload.running) { this.upload.running = false; this.upload.error = e.message; }
      this.nextPoll = Date.now() + RETRY_AFTER_ERROR;
    } finally {
      this.inFlight = false;
      this.emitState();
    }
    return this.snapshot();
  }

  async pull(name, st) {
    const data = await this.req('GET', `data/${name}`);
    this.pulledRev[name] = st.revs[name];
    this.pulledAt[name] = Date.now();
    if (name === 'scout') { if (this.scout) this.scout.applyRemote(data); }
    else if (name === 'mugger') { if (this.muggerDb) this.muggerDb.applyRemote(data); }
    else if (name === 'research') this.research.applyRemote(data);
    else if (name === 'travel') this.travel.applyRemote(data, st.travel || {});
    else if (name === 'war') {
      this.war.db.data = MERGE.war(this.war.db.data, data);
      this.war.db.save();
      this.war.emit('state');
    } else if (name === 'prices') {
      this.history.store.data = MERGE.prices(this.history.store.data, data);
      this.history.store.save();
    } else if (name === 'bazaar') {
      this.history.baz.data = MERGE.bazaar(this.history.baz.data, data);
      this.history.baz.save();
    }
  }

  // ---- Settings ----
  markDirty(units) {
    if (this.mode() !== 'server') return;
    let added = false;
    for (const u of units) if (u && !this.dirty.has(u)) { this.dirty.add(u); added = true; }
    this.dirtyAt = Date.now();
    if (added) this.store.set('sync.dirty', [...this.dirty]);
  }

  afterCommand(name, args) {
    if (name === 'settings.set') { const u = unitFor(args[0]); if (u) this.markDirty([u]); }
    else if (AFTER_COMMAND[name]) this.markDirty(AFTER_COMMAND[name]);
    // A faction you just picked for research: check the server often until its first data is here.
    if (name === 'research.watch' && Number(args[0]) > 0) this.researchWaitUntil = Date.now() + RESEARCH_WAIT;
  }

  // A member's device (signed in to someone else's server) gets the owner's research picks, since only
  // those are collected. null on the owner's devices, before the first status check, or with no server.
  ownerResearchPicks() {
    if (this.mode() !== 'server' || this.kind() !== 'session' || !this.server) return null;
    const acct = this.server.account;
    if (!acct || !this.me || Number(this.me.id) === Number(acct.id)) return null; // the owner, signed in with their key
    return (this.server.research && this.server.research.tracked) || [];
  }

  // True while a faction you picked has no data on this device yet (for a few minutes after the pick).
  researchWaiting(now = Date.now()) {
    if (!(now < (this.researchWaitUntil || 0))) return false;
    const id = Number(this.store.get('research.watchId')) || 0;
    const rec = id && this.research.rec(id);
    return !!id && !(rec && rec.members && Object.keys(rec.members).length);
  }

  async syncSettings(st) {
    const since = Number(this.store.get('sync.settingsRev')) || 0;
    const first = !since;
    if (st.settingsRev !== since || first) {
      const got = await this.req('GET', `settings?since=${since}`);
      const units = got.units || {};
      if (first && !Object.keys(units).length) {
        // A new server: this PC's settings become the starting point.
        for (const u of SYNC_UNITS) this.dirty.add(u);
      } else {
        const changed = {};
        for (const [u, { v }] of Object.entries(units)) {
          if (!SYNC_UNITS.includes(u) || this.dirty.has(u)) continue;
          const local = this.store.get(u);
          const next = first ? joinUnit(u, local, v) : applyUnit(u, local, v);
          if (first && JSON.stringify(next) !== JSON.stringify(v)) this.dirty.add(u); // this PC added something
          if (JSON.stringify(next) !== JSON.stringify(local)) changed[u] = next;
        }
        // Settings from before the first-run setup existed: this person already uses Mentat
        // elsewhere, so the setup isn't offered on this device either.
        if (first && !('ui.setupDone' in units) && !this.store.get('ui.setupDone')) {
          changed['ui.setupDone'] = true;
          this.dirty.add('ui.setupDone');
        }
        if (Object.keys(changed).length) this.onSettings(changed);
      }
      this.store.set('sync.settingsRev', Number(got.rev) || 0);
    }
    this.settingsAt = Date.now(); // this device has the server's settings (this session)
    if (this.dirty.size) {
      const send = [...this.dirty];
      const units = Object.fromEntries(send.map(u => [u, this.store.get(u) ?? null]));
      await this.req('PUT', 'settings', { body: { units } });
      for (const u of send) this.dirty.delete(u);
      this.store.set('sync.dirty', [...this.dirty]);
    }
  }

  // ---- Send this PC's collected data to the server (to start it off) ----
  async sendAll() {
    const sets = {
      research: () => this.research.db.data, war: () => this.war.db.data, travel: () => this.travel.history.data,
      prices: () => this.history.store.data, bazaar: () => this.history.baz.data,
    };
    for (const name of DATASETS) {
      if (PULL_ONLY.has(name)) continue;
      await this.req('POST', `data/${name}`, { body: sets[name]() });
      this.upload.done.push(name);
      this.emitState();
    }
  }

  async uploadAll() {
    if (!this.configured()) throw new Error('Connect to a server first.');
    if (this.kind() === 'session') throw new Error("Only the server's owner can send data to it.");
    if (this.inFlight || (this.upload && this.upload.running)) return this.snapshot();
    this.inFlight = true;
    this.upload = { running: true, done: [], error: '', at: Date.now() };
    this.emitState();
    try {
      await this.sendAll();
      this.pulledRev = {};
      this.pulledAt = {};
      this.nextPoll = 0;
    } catch (e) {
      this.upload.error = e.message;
    } finally {
      this.upload.running = false;
      this.inFlight = false;
      this.emitState();
    }
    return this.snapshot();
  }

  flush() {
    this.store.set('sync.dirty', [...this.dirty]);
  }

  emitState() {
    this.emit('state');
  }

  snapshot() {
    const s = this.server;
    return {
      mode: this.mode(),
      url: this.url(),
      kind: this.kind(),
      signedIn: this.signedIn(),
      signedOut: this.signedOut,
      me: this.me,
      defaultServer: this.defaultServer,
      hasToken: !!this.store.get('sync.tokenEnc'),
      hasCf: !!this.store.get('sync.cfIdEnc') && !!this.store.get('sync.cfSecretEnc'),
      connected: !!this.lastOkAt && !this.error,
      covering: this.covering(),
      lastOkAt: this.lastOkAt,
      error: this.error,
      busy: this.inFlight,
      pending: this.dirty.size,
      pulled: Object.fromEntries(DATASETS.map(n => [n, { at: this.pulledAt[n] || 0, ok: !!this.pulledRev[n], error: this.pullErrors[n] || '' }])),
      upload: this.upload,
      server: s ? {
        version: s.version, account: s.account, keyOk: s.keyOk, banner: s.api && s.api.banner, maxPerMinute: s.api && s.api.maxPerMinute,
        startedAt: s.startedAt, collect: s.collect, war: s.war, research: s.research, travel: s.travel, bazaar: s.bazaar, prices: s.prices, cloudBackup: s.cloudBackup || null, scout: s.scout || null,
      } : null,
    };
  }
}

module.exports = { SyncFeature, cleanUrl };

  },
  "pages.js": function (module, exports, require) {
'use strict';
// Torn pages for the "Pages" menu. Each opens as a new tab in the Torn browser.
const T = p => `https://www.torn.com/${p}`;

const PAGES = [
  ['You', [
    ['Home', T('index.php')], ['Items', T('item.php')], ['Events', T('events.php')], ['Messages', T('messages.php')],
    ['Personal Stats', T('personalstats.php')], ['Properties', T('properties.php')], ['Education', T('page.php?sid=education')],
  ]],
  ['Train & Earn', [
    ['Gym', T('gym.php')], ['Crimes', T('page.php?sid=crimes')], ['Missions', T('page.php?sid=missions')],
    ['Job / Company', T('companies.php')], ['Racing', T('page.php?sid=racing')], ['Casino', T('casino.php')],
  ]],
  ['Travel', [
    ['Travel Agency', T('travelagency.php')], ['Hospital', T('hospitalview.php')], ['Jail', T('jailview.php')], ['City', T('city.php')],
  ]],
  ['Money & Trading', [
    ['Item Market', T('page.php?sid=ItemMarket')], ['Your Bazaar', T('bazaar.php')], ['Points Market', T('pmarket.php')],
    ['Trades', T('trade.php')], ['Stock Market', T('page.php?sid=stocks')], ['Bank', T('bank.php')], ['Points Store', T('points.php')],
  ]],
  ['Faction & War', [
    ['Your Faction', T('factions.php?step=your')], ['Faction Armory', T('factions.php?step=your#/tab=armoury')],
    ['Bounties', T('bounties.php')], ['Hall of Fame', T('halloffame.php')],
  ]],
  ['Community', [
    ['Forums', T('forums.php')], ['Newspaper', T('newspaper.php')],
  ]],
];

module.exports = { PAGES };

  },
  "features/alerts.js": function (module, exports, require) {
'use strict';
// Custom timer alerts: "tell me N minutes (or seconds) before <timer>", each with its own
// sound and optional desktop popup. Uses only timers the app already tracks (bars,
// cooldowns, travel, hospital, chain, targets, daily reset, abroad restocks), so no extra API
// requests.
//
// Abroad restocks (rule.item = "<country code>:<item id>") come from the travel feature's YATA
// readings and restock analysis (restock.js): 'restock' = the predicted next restock, 'restockleave'
// = when to leave (Travel's flight method) to land just after it, and 'restocked' = an event, not a
// timer: the item's stock went up between two readings.
//
// An alert fires when its moment passes while the app is running, and only for a timer
// that was seen counting down before that moment: opening the app when a timer is already
// inside its warning window doesn't fire (no burst of alerts at launch).

const { EventEmitter } = require('events');

const T = 'https://www.torn.com/';
// key -> label, page to open, and phrasing for "ends" and "N before".
const TIMERS = {
  energy: { label: 'Energy full', url: T + 'gym.php', done: 'Energy is full' },
  nerve: { label: 'Nerve full', url: T + 'page.php?sid=crimes', done: 'Nerve is full' },
  happy: { label: 'Happy full', url: T + 'item.php', done: 'Happy is full' },
  life: { label: 'Life full', url: T + 'item.php#medical-items', done: 'Life is full' },
  drug: { label: 'Drug cooldown', url: T + 'item.php#drugs-items', done: 'Drug cooldown is over' },
  booster: { label: 'Booster cooldown', url: T + 'item.php#boosters-items', done: 'Booster cooldown is over' },
  medical: { label: 'Medical cooldown', url: T + 'item.php#medical-items', done: 'Medical cooldown is over' },
  travel: { label: 'Landing', url: T + 'index.php', done: 'You have landed' },
  hospital: { label: 'Out of hospital / jail', url: T + 'index.php', done: 'You are out' },
  chain: { label: 'Chain timer runs out', url: T + 'factions.php?step=your#/war/chain', done: 'Chain timer ran out' },
  target: { label: 'Target out of hospital / jail', url: '', done: 'is out' },
  enemy: { label: 'War enemy out of hospital', url: '', done: 'is out' },
  warstart: { label: 'Ranked war starts', url: T + 'factions.php?step=your#/war/rank', done: 'Ranked war has started' },
  reset: { label: 'Daily reset (00:00 TCT)', url: T + 'index.php', done: 'Daily reset' },
  restock: { label: 'Abroad restock (predicted)', url: T + 'page.php?sid=travel', done: 'restock due', item: true },
  restockleave: { label: 'Time to leave for an abroad restock', url: T + 'page.php?sid=travel', done: 'Time to leave', item: true },
  restocked: { label: 'Abroad restock seen (stock went up)', url: T + 'page.php?sid=travel', done: 'restocked', item: true, event: true },
};
const ITEM_KEY = /^[a-z]{3}:\d{1,7}$/;
const RESTOCK_FRESH_MS = 10 * 60 * 1000; // a reading older than this is too late to alert on
const RESTOCK_GAP_MS = 15 * 60 * 1000;   // readings further apart than this: don't compare them

// Sounds, played by the tool window (see beep() in app.js). The soft ones are pure tones
// with natural fades, like a struck bell or a plucked string; the classic ones are the
// original electronic beeps. Distinct shapes so you can tell alerts apart.
const SOUNDS = {
  softchime: { label: 'Soft chime', env: 'bell', count: 2, freqs: [1047, 1319], step: 0.22, len: 1.6, partials: [[1, 1, 1], [2, 0.25, 0.5], [3, 0.08, 0.3]] },
  marimba: { label: 'Marimba', env: 'pluck', count: 3, freqs: [523.3, 659.3, 784], step: 0.14, len: 0.6, partials: [[1, 1, 1], [4, 0.18, 0.25], [10, 0.05, 0.1]] },
  harp: { label: 'Harp', env: 'pluck', count: 4, freqs: [392, 493.9, 587.3, 784], step: 0.09, len: 1.4, partials: [[1, 1, 1], [2, 0.35, 0.6], [3, 0.12, 0.4]] },
  glass: { label: 'Glass', env: 'bell', count: 1, freqs: [1568], len: 2, partials: [[1, 1, 1], [2.76, 0.35, 0.5], [5.4, 0.12, 0.3]] },
  doorbell: { label: 'Doorbell', env: 'bell', count: 2, freqs: [659.3, 523.3], step: 0.45, len: 1.4, partials: [[1, 1, 1], [2, 0.2, 0.6]] },
  drop: { label: 'Water drop', env: 'pluck', count: 2, freqs: [1400, 1900], step: 0.16, len: 0.35, glide: 0.55 },
  pad: { label: 'Warm pad', env: 'pad', chord: true, count: 1, freqs: [261.6, 329.6, 392], len: 1.6, partials: [[1, 1, 1], [2, 0.15, 1]] },
  chime: { label: 'Classic chime', count: 2, freqs: [880, 1320], wave: 'sine', len: 0.28, gap: 0.06 },
  bell: { label: 'Classic bell', count: 3, freqs: [1047, 784, 1047], wave: 'triangle', len: 0.3, gap: 0.05 },
  beep: { label: 'Classic beep', count: 1, freqs: [880], wave: 'square', len: 0.25, gap: 0.1 },
  double: { label: 'Classic double beep', count: 2, freqs: [740], wave: 'square', len: 0.15, gap: 0.1 },
  alarm: { label: 'Classic alarm', count: 6, freqs: [988, 740], wave: 'square', len: 0.12, gap: 0.05 },
  rise: { label: 'Classic rising', count: 4, freqs: [523, 659, 784, 1047], wave: 'sine', len: 0.16, gap: 0.03 },
  none: { label: 'No sound', count: 0, freqs: [0] },
};

const MAX_LATE_MS = 3 * 60 * 1000; // e.g. after the PC slept: skip alerts this stale
const ARM_MARGIN_MS = 1500;
const SAME_END_MS = 120 * 1000; // end time drifts a little between refreshes
const MAX_RULES = 50;

const fmtBefore = sec => {
  if (!sec) return 'when it ends';
  if (sec % 60 === 0) return `${sec / 60} min before`;
  if (sec < 60) return `${sec} s before`;
  return `${Math.floor(sec / 60)} min ${sec % 60} s before`;
};
const fmtLeft = sec => (sec >= 120 ? `${Math.round(sec / 60)} min` : `${Math.round(sec)} s`);
const tct = ms => new Date(ms).toISOString().slice(11, 16);

class AlertsFeature extends EventEmitter {
  constructor({ store, notify, user, chain, targets, war, travel }) {
    super();
    this.store = store;
    this.notify = notify;
    this.user = user;
    this.chain = chain;
    this.targets = targets;
    this.war = war || null;
    this.travel = travel || null;
    this.armed = new Map(); // "<rule>|<instance>" -> end time it was armed for
    this.lastEmit = 0;
    this.stockSeen = new Map(); // "<country>:<item>" -> { at, q } (last reading, for 'restocked')
    for (const f of [user, chain, targets, war]) if (f) f.on('state', () => this.emitSoon());
    if (travel) {
      travel.on('readings', () => this.checkRestocks(Date.now()));
      travel.on('state', () => { this.checkRestocks(Date.now()); this.emitSoon(); });
    }
  }

  rules() {
    return this.store.get('alerts.rules') || [];
  }

  saveRules(rules) {
    this.store.set('alerts.rules', rules);
    this.emitSoon(true);
  }

  static clean(r) {
    const timer = TIMERS[r.timer] ? r.timer : null;
    if (!timer) throw new Error('Unknown timer');
    const before = TIMERS[timer].event ? 0 : Math.max(0, Math.min(24 * 3600, Math.round(Number(r.before) || 0)));
    const item = TIMERS[timer].item ? String(r.item || '') : '';
    if (TIMERS[timer].item && !ITEM_KEY.test(item)) throw new Error('Pick an abroad item');
    return {
      ...(item ? { item } : {}),
      timer,
      before,
      sound: SOUNDS[r.sound] ? r.sound : 'softchime',
      desktop: r.desktop !== false,
      urgent: !!r.urgent, // an urgent popup in the middle of the screen (stays until dismissed)
      enabled: r.enabled !== false,
      target: timer === 'target' ? Math.max(0, Math.floor(Number(r.target) || 0)) : 0,
    };
  }

  add(r) {
    const rules = this.rules();
    if (rules.length >= MAX_RULES) throw new Error(`Up to ${MAX_RULES} alerts`);
    const rule = { id: `a${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, ...AlertsFeature.clean(r) };
    this.saveRules([...rules, rule]);
    return rule;
  }

  update(id, patch) {
    const rules = this.rules().map(r => (r.id === id ? { id, ...AlertsFeature.clean({ ...r, ...patch }) } : r));
    for (const k of [...this.armed.keys()]) if (k.startsWith(id + '|')) this.armed.delete(k);
    this.saveRules(rules);
  }

  remove(id) {
    this.saveRules(this.rules().filter(r => r.id !== id));
  }

  // Every running timer: { timer, inst, end, name }.
  instances(now) {
    const out = [];
    const u = this.user.snapshot().data;
    if (u) {
      if (u.bars) {
        for (const k of ['energy', 'nerve', 'happy', 'life']) {
          const b = u.bars[k];
          if (b && b.maximum && b.current < b.maximum && b.fullAt > now) out.push({ timer: k, inst: '', end: b.fullAt });
        }
      }
      if (u.cooldowns) for (const k of ['drug', 'booster', 'medical']) if (u.cooldowns[k] > now) out.push({ timer: k, inst: '', end: u.cooldowns[k] });
      if (u.travel && u.travel.arriveAt > now) out.push({ timer: 'travel', inst: '', end: u.travel.arriveAt, name: u.travel.destination });
      const st = u.status || {};
      if ((st.state === 'Hospital' || st.state === 'Jail') && st.until > now) out.push({ timer: 'hospital', inst: '', end: st.until, name: st.state });
    }
    const c = this.chain.snapshot().chain;
    if (c && !c.noFaction && c.current > 0 && !c.cooldown && c.expiresAt > now && now - c.fetchedAt < 5 * 60 * 1000) {
      out.push({ timer: 'chain', inst: '', end: c.expiresAt, name: `${c.current} hits` });
    }
    for (const t of Object.values(this.targets.list())) {
      const s = t.status;
      if (s && (s.state === 'Hospital' || s.state === 'Jail') && s.until > now) out.push({ timer: 'target', inst: String(t.id), end: s.until, name: t.name || `#${t.id}`, state: s.state });
    }
    if (this.war) {
      const w = this.war.snapshot();
      const e = w.enemy;
      if (e) for (const m of e.members) {
        if ((m.state === 'Hospital' || m.state === 'Jail') && m.until > now) out.push({ timer: 'enemy', inst: String(m.id), end: m.until, name: m.name, state: m.state });
      }
      const r = w.wars && w.wars.ranked;
      if (r && r.start > now) {
        const own = w.own && w.own.id;
        const them = r.factions.find(f => f.id !== own);
        out.push({ timer: 'warstart', inst: String(r.id), end: r.start, name: them ? `vs ${them.name}` : '' });
      }
    }
    const d = new Date(now);
    out.push({ timer: 'reset', inst: '', end: Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1) });
    // Abroad restocks, for the items that have alerts.
    const keys = new Set(this.rules().filter(r => r.timer === 'restock' || r.timer === 'restockleave').map(r => r.item));
    for (const key of keys) {
      const a = this.abroadItem(key);
      const st = a && a.i.stats;
      if (!st || !st.cadence) continue;
      const name = `${a.i.name} in ${a.c.name}`;
      const meta = { name, unc: st.cadence.uncertainty, conf: st.cadence.confidence };
      // Kept for 90 s after it passes, so a "when it happens" alert sees its moment arrive.
      const next = (st.next || []).find(t => t > now - 90000);
      if (next) out.push({ timer: 'restock', inst: key, end: next, ...meta });
      if (this.travel) {
        const method = this.travel.method();
        const fMin = this.travel.flightMinutes(a.c.code, method);
        const delay = landingDelay(st);
        const t = (st.next || []).find(x => x + delay - fMin * 60000 > now - 90000);
        if (t && fMin) out.push({ timer: 'restockleave', inst: key, end: t + delay - fMin * 60000, restockAt: t, method, fMin, ...meta });
      }
    }
    return out;
  }

  // Abroad items that have an alert switched on (Travel reads YATA every 10 s while there are any).
  restockKeys() {
    return new Set(this.rules().filter(r => r.enabled && r.item && TIMERS[r.timer] && TIMERS[r.timer].item).map(r => r.item));
  }

  // An abroad item by "<country>:<item id>": { c, i } from the travel feature's latest readings.
  abroadItem(key) {
    if (!this.travel || !key) return null;
    const [code, id] = String(key).split(':');
    const c = (this.travel.state.countries || []).find(x => x.code === code);
    const i = c && c.items.find(x => x.id === Number(id));
    return i ? { c, i } : null;
  }

  // 'restocked' alerts: the item's stock went up from one reading to the next. Only fresh
  // readings that follow on closely count (not data that arrives after the app was closed).
  checkRestocks(now) {
    const rules = this.rules().filter(r => r.enabled && r.timer === 'restocked');
    const keys = new Set(rules.map(r => r.item));
    for (const key of [...this.stockSeen.keys()]) if (!keys.has(key)) this.stockSeen.delete(key);
    for (const key of keys) {
      const a = this.abroadItem(key);
      if (!a || !a.c.update) continue;
      const prev = this.stockSeen.get(key);
      const q = a.i.quantity;
      if (prev && a.c.update <= prev.at) continue;
      this.stockSeen.set(key, { at: a.c.update, q });
      if (!prev || q <= prev.q || a.c.update - prev.at > RESTOCK_GAP_MS || now - a.c.update > RESTOCK_FRESH_MS) continue;
      const inst = { timer: 'restocked', inst: key, end: a.c.update, name: `${a.i.name} in ${a.c.name}`, q, prevQ: prev.q };
      for (const rule of rules) if (rule.item === key) this.fire(rule, inst, now);
    }
  }

  matches(rule, inst) {
    if (rule.timer !== inst.timer) return false;
    if (TIMERS[rule.timer].item) return rule.item === inst.inst;
    return rule.timer !== 'target' || !rule.target || String(rule.target) === inst.inst;
  }

  tick(now) {
    const rules = this.rules().filter(r => r.enabled && !TIMERS[r.timer].event);
    if (!rules.length) return;
    const insts = this.instances(now);
    for (const rule of rules) {
      for (const inst of insts) {
        if (!this.matches(rule, inst)) continue;
        const key = `${rule.id}|${inst.inst}`;
        const fireAt = inst.end - rule.before * 1000;
        if (now < fireAt - ARM_MARGIN_MS) {
          this.armed.set(key, { end: inst.end, name: inst.name || '', state: inst.state || '' });
          continue;
        }
        const armed = this.armed.get(key);
        if (now >= fireAt && armed && Math.abs(armed.end - inst.end) < SAME_END_MS) {
          this.armed.delete(key);
          if (now - fireAt <= MAX_LATE_MS) this.fire(rule, inst, now);
        }
      }
    }
    // Timers that ended (e.g. cooldown reached zero) fire "when it ends" alerts too: they
    // drop out of instances() at the end, so check armed "before: 0" rules here.
    for (const rule of rules) {
      if (rule.before) continue;
      for (const [key, a] of this.armed) {
        if (!key.startsWith(rule.id + '|') || now < a.end) continue;
        this.armed.delete(key);
        if (now - a.end <= MAX_LATE_MS) {
          const inst = key.split('|')[1];
          this.fire(rule, { timer: rule.timer, inst, end: a.end, name: a.name || (inst ? `#${inst}` : ''), state: a.state }, now);
        }
      }
    }
    // Instances the alert was armed for that vanished early (e.g. you used the energy):
    // forget them so they can't fire later for a different end time.
    for (const [key, a] of this.armed) if (now - a.end > MAX_LATE_MS) this.armed.delete(key);
    if (now - this.lastEmit > 30000) this.emitSoon();
  }

  message(rule, inst, now = Date.now()) {
    const t = TIMERS[rule.timer];
    const left = (inst.end - now) / 1000;
    const ended = !rule.before || left <= 1;
    let title, body;
    if (rule.timer === 'target' || rule.timer === 'enemy') {
      title = ended ? `${inst.name} is out` : `${inst.name} out in ${fmtLeft(left)}`;
      body = `${rule.timer === 'enemy' ? 'War enemy. ' : ''}${inst.state || 'Hospital'} timer ${ended ? 'ended' : `ends at ${tct(inst.end)} TCT`}.`;
    } else if (rule.timer === 'warstart') {
      title = ended ? `Ranked war started ${inst.name}` : `Ranked war ${inst.name} starts in ${fmtLeft(left)}`;
      body = `${ended ? 'Started' : 'Starts'} at ${tct(inst.end)} TCT.`;
    } else if (rule.timer === 'restock') {
      title = ended ? `${inst.name}: restock due now` : `${inst.name} restocks in ${fmtLeft(left)}`;
      body = `Predicted ~${tct(inst.end)} TCT${inst.unc ? ` ±${Math.ceil(inst.unc / 60000)} min` : ''}${inst.conf ? ` (${inst.conf} confidence)` : ''}.`;
    } else if (rule.timer === 'restockleave') {
      title = ended ? `Leave now for ${inst.name}` : `Leave for ${inst.name} in ${fmtLeft(left)}`;
      body = `Leave ${tct(inst.end)} TCT${inst.fMin ? ` (${inst.method === 'Private' ? 'WLT' : inst.method || ''}, ${Math.round(inst.fMin)} min)` : ''} to land just after the ~${tct(inst.restockAt || inst.end)} restock.`;
    } else if (rule.timer === 'restocked') {
      title = `${inst.name} restocked`;
      body = inst.q !== undefined ? `${inst.q} in stock (was ${inst.prevQ}) at the ${tct(inst.end)} TCT reading.` : 'Its stock just went up.';
    } else if (rule.timer === 'chain') {
      title = ended ? 'Chain timer ran out' : `Chain timer: ${fmtLeft(left)} left`;
      body = `${inst.name || 'Chain'}. Hit someone to keep it going.`;
    } else {
      title = ended ? t.done : `${t.label} in ${fmtLeft(left)}`;
      body = `${ended ? 'Ended' : 'At'} ${tct(inst.end)} TCT${inst.name ? ` (${inst.name})` : ''}.`;
    }
    const url = rule.timer === 'target' || rule.timer === 'enemy' ? `https://www.torn.com/profiles.php?XID=${inst.inst}` : t.url;
    return { title, body, url };
  }

  fire(rule, inst, now = Date.now()) {
    const m = this.message(rule, inst, now);
    const vol = this.store.get('alerts.volume');
    const s = SOUNDS[rule.sound] || SOUNDS.softchime;
    if (s.count) this.emit('beep', { ...s, volume: vol === undefined ? 0.6 : vol });
    if (rule.desktop || rule.urgent) this.notify(m.title, m.body, m.url, !!rule.urgent);
    const log = [{ at: now, title: m.title, rule: rule.id }, ...(this.recent || [])].slice(0, 20);
    this.recent = log;
    this.emitSoon(true);
  }

  // "Test" button: the alert as it would look now (sound + popup).
  test(id) {
    const rule = this.rules().find(r => r.id === id);
    if (!rule) return;
    const ab = TIMERS[rule.timer].item ? this.abroadItem(rule.item) : null;
    const inst = this.instances(Date.now()).find(i => this.matches(rule, i))
      || { timer: rule.timer, inst: String(rule.item || rule.target || ''), end: Date.now() + rule.before * 1000, name: ab ? `${ab.i.name} in ${ab.c.name}` : rule.timer === 'target' ? 'Target' : rule.timer === 'enemy' ? 'Enemy' : '' };
    this.fire(rule, inst);
  }

  preview(sound) {
    const s = SOUNDS[sound];
    const vol = this.store.get('alerts.volume');
    if (s && s.count) this.emit('beep', { ...s, volume: vol === undefined ? 0.6 : vol });
  }

  emitSoon(now = false) {
    if (this.emitTimer && !now) return;
    clearTimeout(this.emitTimer);
    this.emitTimer = setTimeout(() => { this.emitTimer = null; this.lastEmit = Date.now(); this.emit('state'); }, now ? 0 : 300);
  }

  // Rules plus the next time each will go off.
  snapshot() {
    const now = Date.now();
    const insts = this.instances(now);
    const rules = this.rules();
    const upcoming = [];
    for (const rule of rules) {
      if (!rule.enabled) continue;
      for (const inst of insts) {
        if (!this.matches(rule, inst)) continue;
        const fireAt = inst.end - rule.before * 1000;
        if (fireAt > now) upcoming.push({ rule: rule.id, timer: rule.timer, name: inst.name || '', fireAt, end: inst.end });
      }
    }
    upcoming.sort((a, b) => a.fireAt - b.fireAt);
    return {
      rules,
      upcoming: upcoming.slice(0, 30),
      recent: this.recent || [],
      timers: Object.fromEntries(Object.entries(TIMERS).map(([k, v]) => [k, v.label])),
      sounds: Object.fromEntries(Object.entries(SOUNDS).map(([k, v]) => [k, v.label])),
      targets: Object.values(this.targets.list()).map(t => ({ id: t.id, name: t.name || `#${t.id}` })),
      itemTimers: Object.keys(TIMERS).filter(k => TIMERS[k].item),
      // Abroad items to pick from, and names for the items alerts already use.
      abroad: this.abroadList(),
    };
  }

  abroadList() {
    const out = [];
    for (const c of (this.travel && this.travel.state.countries) || []) for (const i of c.items) if (i.cost) out.push({ key: `${c.code}:${i.id}`, name: i.name, country: c.name });
    return out.sort((a, b) => a.name.localeCompare(b.name) || a.country.localeCompare(b.country));
  }
}

// How long after a predicted restock to land, so it has happened (same as the page's travel.js).
function landingDelay(st) {
  const cad = st.cadence;
  let d = (cad ? cad.uncertainty : 2 * 60000) + 60000;
  if (st.stay) d = Math.min(d, st.stay * 0.4);
  return Math.max(30000, d);
}

module.exports = { AlertsFeature, TIMERS, SOUNDS, fmtBefore };

  },
  "features/avatars.js": function (module, exports, require) {
'use strict';
// Profile pictures for the players Mentat shows (Targets, faction lists, war boards, research).
// Torn gives a full image address with a player's profile (v1 `profile_image`, v2 `profile.image`;
// checked against the live API 2026-11-18), so pictures come from:
//   - profile requests Mentat already makes (Targets, your own profile): free, via put();
//   - a slow background queue for players on screen the page asks about (want()): one
//     /user/{id}?selections=profile every 8 s at the lowest priority, so it never gets in the way.
// Kept on this device in avatars.json: an address for 14 days, "no picture" for 3 days.

const { EventEmitter } = require('events');
const { Store } = require('../store');

const KEEP = 14 * 86400e3;
const KEEP_NONE = 3 * 86400e3;
const DROP = 30 * 86400e3;
const GAP = 8000;        // between background requests (about 7 a minute)
const MAX_QUEUE = 400;
const EMIT_EVERY = 1500; // the page gets new pictures in batches

class AvatarsFeature extends EventEmitter {
  constructor({ api, store, dataDir }) {
    super();
    this.api = api;
    this.store = store;
    this.db = new Store(`${dataDir}/avatars.json`, { p: {} }, { debounceMs: 10000 });
    if (!this.db.data.p || typeof this.db.data.p !== 'object') this.db.data.p = {};
    const now = Date.now();
    for (const [id, e] of Object.entries(this.db.data.p)) if (!Array.isArray(e) || now - e[1] > DROP) delete this.db.data.p[id];
    this.queue = [];
    this.queued = new Set();
    this.inFlight = false;
    this.lastReq = 0;
    this.dirty = false;
    this.lastEmit = 0;
  }

  enabled() { return this.store.get('ui.avatars') !== false; }

  fresh(id, now = Date.now()) {
    const e = this.db.data.p[id];
    return !!e && now - e[1] < (e[0] ? KEEP : KEEP_NONE);
  }

  // A picture seen in a response Mentat made anyway ('' = the player has none).
  put(id, url) {
    id = Number(id);
    if (!(id > 0)) return;
    url = typeof url === 'string' && /^https:\/\/[a-z0-9.-]+\.torn\.com\//i.test(url) ? url : '';
    const old = this.db.data.p[id];
    this.db.data.p[id] = [url, Date.now()];
    this.db.save();
    if (!old || old[0] !== url) this.dirty = true;
  }

  // The page shows these players: fetch the ones without a fresh picture, a few a minute.
  want(ids) {
    if (!this.enabled()) return 0;
    let n = 0;
    for (const raw of Array.isArray(ids) ? ids : []) {
      const id = Number(raw);
      if (!(id > 0) || this.queued.has(id) || this.fresh(id)) continue;
      if (this.queue.length >= MAX_QUEUE) break;
      this.queue.push(id);
      this.queued.add(id);
      n++;
    }
    return n;
  }

  tick(now) {
    if (this.dirty && now - this.lastEmit > EMIT_EVERY) { this.dirty = false; this.lastEmit = now; this.emit('state'); }
    if (!this.enabled() || this.inFlight || !this.queue.length || now - this.lastReq < GAP) return;
    const st = this.api.status();
    // No key, paused, or the key is busy (over half its minute used): pictures wait.
    if (!st.hasKey || st.pausedUntil || st.queued > 2 || st.usedLastMinute > st.maxPerMinute / 2) return;
    const id = this.queue.shift();
    this.queued.delete(id);
    if (this.fresh(id, now)) return;
    this.inFlight = true;
    this.lastReq = now;
    this.api.request(`/user/${id}?selections=profile`, { soft: [6, 7], priority: 9 })
      .then(d => this.put(id, d && d.profile_image))
      .catch(e => { if (e && e.kind === 'soft') this.put(id, ''); /* other errors: asked again later */ })
      .finally(() => { this.inFlight = false; });
  }

  snapshot() {
    const map = {};
    for (const [id, e] of Object.entries(this.db.data.p)) if (e[0]) map[id] = e[0];
    return { enabled: this.enabled(), map, queued: this.queue.length };
  }
}

module.exports = { AvatarsFeature };

  },
  "features/bazaar.js": function (module, exports, require) {
'use strict';
// Bazaar prices from Weav3r (https://weav3r.dev), a community service that tracks player
// bazaars. The official Torn API has no per-item bazaar prices.
// - All items at once: GET /api/marketplace -> cheapest bazaar price, bazaar average and
//   number of bazaars for every item (one ~200 KB request, every 10 minutes).
// - One item's listings: GET /api/marketplace/{id} -> bazaars selling it, cheapest first
//   (on demand, cached for 2 minutes).
// No key or personal data is sent. Can be turned off in Settings.

const { EventEmitter } = require('events');

const BASE = 'https://weav3r.dev/api/marketplace';
const SUMMARY_EVERY = 10 * 60 * 1000;
const SUMMARY_MIN_MANUAL = 60 * 1000;
const LISTING_AGE = 2 * 60 * 1000;
const LISTING_KEEP = 30 * 60 * 1000;
const MAX_PENDING = 6;

async function getJson(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(20000), headers: { Accept: 'application/json', 'User-Agent': 'Mentat' } });
  if (res.status === 429) throw new Error('Weav3r rate limit reached');
  if (!res.ok) throw new Error(`Weav3r returned HTTP ${res.status}`);
  return res.json();
}

class BazaarFeature extends EventEmitter {
  constructor({ store, history }) {
    super();
    this.store = store;
    this.history = history;
    this.summary = { fetchedAt: 0, items: {} }; // id -> [lowest, average, bazaars]
    this.summaryInFlight = false;
    this.lastSummary = 0;
    this.error = '';
    this.listings = new Map(); // id -> { fetchedAt, average, total, listings: [...] }
    this.pending = new Set();
    this.emitTimer = null;
  }

  enabled() {
    return this.store.get('market.bazaar') !== false;
  }

  lowest(id) {
    const s = this.summary.items[id];
    const l = this.listings.get(Number(id));
    // A fresh per-item fetch beats the 10-minute summary.
    if (l && l.listings.length && (!this.summary.fetchedAt || l.fetchedAt > this.summary.fetchedAt)) return l.listings[0].price;
    return s && s[0] ? s[0] : 0;
  }

  async fetchSummary(now) {
    this.summaryInFlight = true;
    this.lastSummary = now;
    try {
      const d = await getJson(BASE);
      const items = {};
      for (const it of d.items || []) {
        if (!(it.item_id > 0)) continue;
        items[it.item_id] = [it.lowest_price || 0, it.bazaar_average || 0, it.total_bazaars || 0];
      }
      this.summary = { fetchedAt: Date.now(), items };
      this.error = '';
      this.history.recordBazaar(items, Date.now());
      this.emit('summary');
    } catch (e) {
      this.error = e.name === 'TimeoutError' ? 'Weav3r timed out' : e.message || 'Could not reach Weav3r';
    } finally {
      this.summaryInFlight = false;
      this.emitSoon();
    }
  }

  refresh() {
    if (Date.now() - this.lastSummary >= SUMMARY_MIN_MANUAL) this.lastSummary = 0;
  }

  // Bazaar listings for some items (cheapest first). Returns how many were queued.
  requestListings(ids) {
    if (!this.enabled()) return { queued: 0 };
    const now = Date.now();
    let queued = 0;
    for (const raw of ids) {
      const id = Number(raw);
      if (!id || this.pending.has(id) || this.pending.size >= MAX_PENDING) continue;
      const l = this.listings.get(id);
      if (l && now - l.fetchedAt < LISTING_AGE) continue;
      this.pending.add(id);
      queued++;
      this.fetchListings(id);
    }
    if (queued) this.emitSoon();
    return { queued };
  }

  async fetchListings(id) {
    try {
      const d = await getJson(`${BASE}/${id}`);
      const listings = (d.listings || []).map(l => ({
        player: l.player_id, name: l.player_name, quantity: l.quantity, price: l.price,
        checked: (l.last_checked || 0) * 1000, updated: (l.content_updated || 0) * 1000,
      })).sort((a, b) => a.price - b.price);
      this.listings.set(id, { fetchedAt: Date.now(), average: d.bazaar_average || 0, total: d.total_count || listings.length, listings: listings.slice(0, 25) });
      if (listings.length) this.history.recordBazaarOne(id, Date.now(), listings[0].price);
      this.emit('listings', id);
    } catch (e) {
      this.listings.set(id, { fetchedAt: Date.now(), average: 0, total: 0, listings: [], error: e.message });
    } finally {
      this.pending.delete(id);
      this.emitSoon();
    }
  }

  tick(now) {
    if (!this.enabled()) return;
    if (!this.summaryInFlight && now - this.lastSummary >= SUMMARY_EVERY) this.fetchSummary(now);
    for (const [id, l] of this.listings) if (now - l.fetchedAt > LISTING_KEEP) this.listings.delete(id);
  }

  emitSoon() {
    if (this.emitTimer) return;
    this.emitTimer = setTimeout(() => { this.emitTimer = null; this.emit('state'); }, 200);
  }

  // The full summary is large, so the UI fetches it with a command when summaryAt changes.
  snapshot() {
    return {
      enabled: this.enabled(),
      summaryAt: this.summary.fetchedAt,
      error: this.error,
      listings: Object.fromEntries(this.listings),
      pending: [...this.pending],
    };
  }
}

module.exports = { BazaarFeature };

  },
  "features/casino.js": function (module, exports, require) {
'use strict';
// The Casino tab's live data: your casino tokens and today's casino streak, Torn's poker tables,
// bookmaker odds (from the Mentat server), and your betting log (gamble.log, synced to your other
// devices). Advice only: nothing here plays or bets for you.
//
// Auto-tracking (optional, beta): with a Full access key saved for it, your Torn log's casino and
// bookie entries are copied into the betting log every 15 minutes. That key stays on this device
// (encrypted), apart from your main key, and is only used for /v2/user/log.

const { EventEmitter } = require('events');
let safeStorage = null;
try { ({ safeStorage } = require('electron')); } catch (e) { /* plain Node */ }
const { KEY_PATTERN } = require('../api');

const CASINO_EVERY = 120e3;
const TABLES_EVERY = 60e3;
const AUTO_EVERY = 15 * 60e3;
const MAX_LOG = 3000;
const GAMES = ['blackjack', 'poker', 'highlow', 'roulette', 'slots', 'keno', 'craps', 'wheel', 'lottery', 'russian', 'bookie', 'other'];
const LOG_CAT = /casino|gambl|bookie|lottery|poker|blackjack|roulette|slots|keno|craps|high.?low|wheel/i;

const money = v => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : null);
const clip = (s, n) => String(s == null ? '' : s).slice(0, n);

// A log entry's game, from its title ("Blackjack win", "Bookie bet placed"...).
function gameOf(title) {
  const t = String(title).toLowerCase();
  if (/blackjack/.test(t)) return 'blackjack';
  if (/poker|hold.?em/.test(t)) return 'poker';
  if (/high.?low/.test(t)) return 'highlow';
  if (/russian/.test(t)) return 'russian';
  if (/roulette/.test(t)) return 'roulette';
  if (/slot/.test(t)) return 'slots';
  if (/keno/.test(t)) return 'keno';
  if (/craps/.test(t)) return 'craps';
  if (/wheel|spin/.test(t)) return 'wheel';
  if (/lotter|ticket/.test(t)) return 'lottery';
  if (/bookie|bet/.test(t)) return 'bookie';
  return 'other';
}
// Money in and out of one log entry. The data fields aren't documented, so this reads the
// common names and leaves `net` empty when it can't tell (you can fill it in by hand).
function moneyOf(entry) {
  const d = entry.data && typeof entry.data === 'object' ? entry.data : {};
  let stake = null, back = null, lost = null;
  for (const [k, v] of Object.entries(d)) {
    if (typeof v !== 'number') continue;
    const key = k.toLowerCase();
    if (/^(bet|bet_amount|stake|amount_bet|wager|cost|price|bet_value)$/.test(key)) stake = (stake || 0) + v;
    else if (/^(won|winnings|win|payout|prize|amount_won|returned|return|money_gained|reward)$/.test(key)) back = (back || 0) + v;
    else if (/^(lost|loss|amount_lost|money_lost)$/.test(key)) lost = (lost || 0) + v;
  }
  const title = String(entry.details && entry.details.title || '').toLowerCase();
  let net = null;
  if (lost != null) { net = -lost; if (stake == null) stake = lost; } else if (stake != null && back != null) net = back - stake;
  else if (stake != null && /lose|lost|loss/.test(title)) net = -stake;
  else if (stake != null && /place|bought|buy|start/.test(title)) net = null; // the result comes in a later entry
  else if (back != null && /win|won/.test(title)) net = back;
  return { stake: money(stake), net: money(net) };
}

class CasinoFeature extends EventEmitter {
  constructor({ api, store, viewing = () => false, server = null }) {
    super();
    this.api = api;
    this.store = store;
    this.viewing = viewing;
    this.server = server; // (method, path) -> the Mentat server's answer (sync.req)
    this.casinoAt = 0;
    this.tablesAt = 0;
    this.autoAt = 0;
    this.busy = new Set();
    this.state = { casino: null, casinoAt: 0, casinoError: '', tables: null, tablesAt: 0, tablesError: '', auto: { lastAt: 0, error: '', imported: 0, cats: [] } };
    api.on('key', () => { this.state.casino = null; this.casinoAt = 0; this.emit('state'); });
  }

  snapshot() {
    return { ...this.state, hasLogKey: !!this.store.get('casino.logKeyEnc'), autoOn: !!this.store.get('casino.auto'), log: this.store.get('gamble.log') || {}, session: this.store.get('gamble.session') || null };
  }

  tick(now) {
    if (this.api.hasKey() && this.viewing('casino')) {
      if (now - this.casinoAt > CASINO_EVERY) this.refreshCasino(now);
      if (now - this.tablesAt > TABLES_EVERY) this.refreshTables(now);
    }
    if (this.store.get('casino.auto') && this.store.get('casino.logKeyEnc') && now - this.autoAt > AUTO_EVERY) this.importLog(now);
  }

  async once(name, fn) {
    if (this.busy.has(name)) return;
    this.busy.add(name);
    try { await fn(); } finally { this.busy.delete(name); this.emit('state'); }
  }

  refreshCasino(now = Date.now()) {
    this.casinoAt = now;
    return this.once('casino', async () => {
      try {
        const d = await this.api.request('/v2/user/casino', { soft: [16], priority: 6 });
        this.state.casino = d && d.casino ? { tokens: Number(d.casino.tokens) || 0, streak: Number(d.casino.streak) || 0 } : null;
        this.state.casinoAt = Date.now();
        this.state.casinoError = '';
      } catch (e) {
        this.state.casinoError = e.kind === 'soft' ? 'Your key can\'t read casino data (needs Limited access).' : e.message;
      }
    });
  }

  refreshTables(now = Date.now()) {
    this.tablesAt = now;
    return this.once('tables', async () => {
      try {
        const d = await this.api.request('/v2/torn/pokertables', { priority: 7 });
        this.state.tables = (d.pokertables || []).map(t => ({ id: t.id, name: clip(t.name, 60), big: t.blinds ? t.blinds.big : 0, small: t.blinds ? t.blinds.small : 0, players: t.players ? t.players.current : 0, max: t.players ? t.players.maximum : 0, speed: t.speed }));
        this.state.tablesAt = Date.now();
        this.state.tablesError = '';
      } catch (e) { this.state.tablesError = e.message; }
    });
  }

  // ---- Bookmaker odds (Mentat server) ----
  async oddsSports() {
    if (!this.server) throw new Error('Sign in to Mentat to load live odds.');
    return this.server('GET', 'odds/sports');
  }
  async oddsTop() {
    if (!this.server) throw new Error('Sign in to Mentat to load live odds.');
    return this.server('GET', 'odds/top');
  }
  async oddsEvents(sport) {
    if (!this.server) throw new Error('Sign in to Mentat to load live odds.');
    return this.server('GET', `odds/events?sport=${encodeURIComponent(String(sport || ''))}`);
  }

  // ---- Betting log ----
  cleanEntry(e, id) {
    const n = v => (v === null || v === '' || v === undefined ? null : Number.isFinite(Number(v)) ? Math.round(Number(v)) : null);
    const out = {
      id, at: Number(e.at) > 0 ? Math.min(Number(e.at), Date.now() + 86400e3) : Date.now(),
      game: GAMES.includes(e.game) ? e.game : 'other',
      stake: n(e.stake), net: n(e.net), note: clip(e.note, 200), src: e.src === 'auto' ? 'auto' : 'manual',
    };
    if (e.odds !== undefined && e.odds !== null && e.odds !== '') { const o = Number(e.odds); if (o > 1 && o < 1000) out.odds = Math.round(o * 1000) / 1000; }
    if (e.title) out.title = clip(e.title, 120);
    if (e.open) out.open = true; // a bookie bet still waiting for its result
    return out;
  }
  saveLog(log) {
    const ids = Object.keys(log);
    if (ids.length > MAX_LOG) {
      ids.sort((a, b) => log[a].at - log[b].at);
      for (const id of ids.slice(0, ids.length - MAX_LOG)) delete log[id];
    }
    this.store.set('gamble.log', log);
    this.emit('state');
  }
  addLog(e) {
    if (!e || typeof e !== 'object') throw new Error('Nothing to add');
    const log = { ...(this.store.get('gamble.log') || {}) };
    const id = `m${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    log[id] = this.cleanEntry({ ...e, src: 'manual' }, id);
    this.saveLog(log);
    return log[id];
  }
  updateLog(id, patch) {
    const log = { ...(this.store.get('gamble.log') || {}) };
    if (!log[id]) throw new Error('That entry is gone');
    const next = { ...log[id], ...patch };
    if (patch && patch.open === false) delete next.open;
    log[id] = this.cleanEntry(next, id);
    this.saveLog(log);
    return log[id];
  }
  removeLog(id) {
    const log = { ...(this.store.get('gamble.log') || {}) };
    delete log[id];
    this.saveLog(log);
  }
  clearLog(which) {
    const log = { ...(this.store.get('gamble.log') || {}) };
    for (const [id, e] of Object.entries(log)) if (which === 'all' || e.src === which) delete log[id];
    this.saveLog(log);
  }
  setSession(s) {
    if (s === null) { this.store.set('gamble.session', null); this.emit('state'); return null; }
    const n = v => (Number.isFinite(Number(v)) && Number(v) >= 0 ? Math.round(Number(v)) : 0);
    const clean = { start: n(s.start), now: n(s.now !== undefined ? s.now : s.start), stopLoss: n(s.stopLoss), target: n(s.target), startedAt: Number(s.startedAt) > 0 ? Number(s.startedAt) : Date.now(), game: GAMES.includes(s.game) ? s.game : 'other' };
    this.store.set('gamble.session', clean);
    this.emit('state');
    return clean;
  }

  // ---- Auto-tracking from your Torn log (Full access key) ----
  getLogKey() {
    const enc = this.store.get('casino.logKeyEnc');
    if (!enc) return '';
    try { return safeStorage.decryptString(Buffer.from(enc, 'base64')); } catch (e) { return ''; }
  }
  async saveLogKey(key) {
    key = String(key || '').trim();
    if (!KEY_PATTERN.test(key)) throw new Error('A Torn API key is 16 letters and numbers.');
    // Check it can read the log (only Full access keys can).
    try { await this.api.request('/v2/user/log?limit=1', { key, priority: 0, soft: [16] }); } catch (e) {
      if (e.kind === 'soft' || e.code === 16) throw new Error('That key can\'t read your log: auto-tracking needs a Full access key.');
      throw e;
    }
    let enc;
    try { enc = safeStorage.encryptString(key).toString('base64'); } catch (e) { throw new Error('Encryption is unavailable, so the key cannot be stored safely.'); }
    this.store.set('casino.logKeyEnc', enc);
    this.store.set('casino.auto', true);
    if (!this.store.get('casino.autoFrom')) this.store.set('casino.autoFrom', Math.floor(Date.now() / 1000) - 7 * 86400); // start with the last week
    this.autoAt = 0;
    this.state.auto.error = '';
    this.emit('state');
    return true;
  }
  removeLogKey() {
    this.store.set('casino.logKeyEnc', '');
    this.store.set('casino.auto', false);
    this.state.auto = { lastAt: 0, error: '', imported: 0, cats: [] };
    this.emit('state');
  }

  importLog(now = Date.now()) {
    this.autoAt = now;
    return this.once('auto', async () => {
      const key = this.getLogKey();
      if (!key) return;
      const st = this.state.auto;
      try {
        if (!st.cats.length) {
          const c = await this.api.request('/v2/torn/logcategories', { key, priority: 8 });
          st.cats = (c.logcategories || []).filter(x => LOG_CAT.test(x.title)).map(x => ({ id: x.id, title: clip(x.title, 60) }));
          if (!st.cats.length) throw new Error('Torn\'s log has no casino or bookie category to read.');
        }
        const from = Number(this.store.get('casino.autoFrom')) || Math.floor(now / 1000) - 7 * 86400;
        const log = { ...(this.store.get('gamble.log') || {}) };
        let added = 0, newest = from;
        for (const cat of st.cats) {
          // Newest first, 100 at a time: page back (to = the oldest second seen) until caught up.
          // Bounds are inclusive, so a second's entries can come twice; the id skips them.
          let to = 0;
          for (let page = 0; page < 10; page++) {
            const d = await this.api.request(`/v2/user/log?cat=${cat.id}&from=${from}&limit=100${to ? `&to=${to}` : ''}`, { key, priority: 8, soft: [16] });
            const list = d.log || [];
            for (const e of list) {
              const id = `log${e.id}`;
              newest = Math.max(newest, Number(e.timestamp) || 0);
              if (log[id]) continue;
              const title = e.details ? e.details.title : '';
              const m = moneyOf(e);
              log[id] = this.cleanEntry({ at: (Number(e.timestamp) || 0) * 1000, game: gameOf(`${title} ${cat.title}`), stake: m.stake, net: m.net, title, src: 'auto' }, id);
              added++;
            }
            if (list.length < 100) break;
            const oldest = Math.min(...list.map(e => Number(e.timestamp) || 0));
            if (!oldest || oldest <= from || (to && oldest >= to)) break;
            to = oldest;
          }
        }
        if (added) this.saveLog(log);
        this.store.set('casino.autoFrom', newest); // inclusive: entries later in the same second still come
        st.lastAt = Date.now();
        st.imported += added;
        st.error = '';
        if (added) this.emit('imported', added);
      } catch (e) {
        st.error = e.kind === 'soft' || e.code === 16 ? 'The saved key can\'t read your log any more (it needs Full access).' : e.message;
        if (e.kind === 'key') this.removeLogKey();
      }
    });
  }
}

module.exports = { CasinoFeature, gameOf, moneyOf, GAMES };

  },
  "features/chain.js": function (module, exports, require) {
'use strict';
// Faction chain timer with audio + desktop alerts at 2:30, 1:30, 1:00 and 0:30.
// Ported from torn-chain-timer.user.js. Uses /v2/faction/chain, /v2/faction/chainreport
// and /v2/faction/members only.

const { EventEmitter } = require('events');

const POLL_ACTIVE_SEC = 10;
const POLL_IDLE_SEC = 60;
const NO_FACTION_SEC = 900;
const REPORT_ACTIVE_SEC = 30;
const REPORT_IDLE_SEC = 600;
const MEMBERS_SEC = 300;
const ALERT_WINDOW_SEC = 3;
const STALE_MS = 300000;

// More beeps, higher pitch, as the timer gets lower.
const ALERTS = [
  { sec: 150, count: 1, freq: 660, len: 0.35, gap: 0.15 },
  { sec: 90, count: 2, freq: 740, len: 0.25, gap: 0.12 },
  { sec: 60, count: 3, freq: 880, len: 0.2, gap: 0.1 },
  { sec: 30, count: 6, freq: 1050, len: 0.12, gap: 0.07 },
];

const fresh = now => `timestamp=${Math.floor(now / 1000)}`;
const isIdError = code => code === 6 || code === 7;
const isActive = (c, now) => !!c && !c.noFaction && c.current > 0 && !c.cooldown && c.expiresAt > now;
const fmt = sec => `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}`;

class ChainFeature extends EventEmitter {
  constructor({ api, store, notify, getMeId }) {
    super();
    this.api = api;
    this.store = store;
    this.notify = notify;
    this.getMeId = getMeId;
    this.inFlight = false;
    this.prevRem = null;
    this.last = { chain: 0, report: 0, members: 0 };
    this.state = { chain: null, report: null, members: null };
    api.on('key', () => this.reset());
  }

  reset() {
    this.state = { chain: null, report: null, members: null };
    this.last = { chain: 0, report: 0, members: 0 };
    this.prevRem = null;
    this.emit('state');
  }

  snapshot() {
    return this.state;
  }

  refresh() {
    this.last.chain = 0;
    this.last.report = 0;
  }

  tick(now) {
    if (!this.api.hasKey() || !this.store.get('chain.enabled')) return;
    this.checkAlerts(now);
    if (this.inFlight) return;
    const job = this.nextJob(now);
    if (!job) return;
    this.inFlight = true;
    job.call(this, now).finally(() => { this.inFlight = false; });
  }

  nextJob(now) {
    const c = this.state.chain;
    const chainEvery = c && c.noFaction ? NO_FACTION_SEC : isActive(c, now) ? POLL_ACTIVE_SEC : POLL_IDLE_SEC;
    if (now - this.last.chain >= chainEvery * 1000) return this.fetchChain;
    if (!c || c.noFaction) return null;
    const reportEvery = isActive(c, now) ? REPORT_ACTIVE_SEC : REPORT_IDLE_SEC;
    if (now - this.last.report >= reportEvery * 1000) return this.fetchReport;
    if (now - this.last.members >= MEMBERS_SEC * 1000) return this.fetchMembers;
    return null;
  }

  async fetchChain(now) {
    this.last.chain = now;
    try {
      // "timestamp" makes the API skip its cache, so a chain hit back to 5:00 shows at once.
      const data = await this.api.request(`/v2/faction/chain?${fresh(now)}`, { soft: [6, 7], priority: 1 });
      const c = data.chain;
      if (!c) return this.setChain({ noFaction: true, fetchedAt: Date.now() });
      // In API v2 "timeout" is seconds left, "cooldown" is the timestamp the cooldown ends.
      const cooldownUntil = (c.cooldown || 0) * 1000;
      this.setChain({
        id: c.id || 0,
        current: c.current || 0,
        max: c.max || 0,
        modifier: c.modifier || 1,
        cooldown: cooldownUntil > now,
        cooldownUntil,
        expiresAt: now + (c.timeout || 0) * 1000,
        fetchedAt: Date.now(),
      });
    } catch (e) {
      if (e.kind === 'soft' && isIdError(e.code)) this.setChain({ noFaction: true, fetchedAt: Date.now() });
    }
  }

  setChain(c) {
    this.state.chain = c;
    this.emit('state');
  }

  // Respect/hit stats for everyone who has hit the current chain. Top 10 and your own row.
  async fetchReport(now) {
    this.last.report = now;
    try {
      const data = await this.api.request(`/v2/faction/chainreport?${fresh(now)}`, { soft: [6, 7, 16], priority: 4 });
      const r = data.chainreport || {};
      const list = (r.attackers || []).map(a => ({
        id: a.id,
        total: (a.respect && a.respect.total) || 0,
        best: (a.respect && a.respect.best) || 0,
        avg: (a.respect && a.respect.average) || 0,
        attacks: (a.attacks && a.attacks.total) || 0,
      })).sort((a, b) => b.total - a.total);
      const meId = this.getMeId();
      const rank = list.findIndex(a => a.id === meId);
      this.state.report = { id: r.id || 0, top: list.slice(0, 10), mine: rank >= 0 ? list[rank] : null, rank: rank + 1, count: list.length, fetchedAt: Date.now() };
    } catch (e) {
      if (e.kind === 'soft') this.state.report = { none: true, fetchedAt: Date.now() };
    }
    this.emit('state');
  }

  // Names for the report (it only has IDs) and who's online right now.
  async fetchMembers(now) {
    this.last.members = now;
    try {
      const data = await this.api.request('/v2/faction/members', { soft: [6, 7, 16], priority: 6 });
      const names = {};
      const online = [];
      for (const m of data.members || []) {
        names[m.id] = m.name;
        const act = m.last_action || {};
        if (act.status !== 'Online' && act.status !== 'Idle') continue;
        const st = m.status || {};
        online.push({ id: m.id, name: m.name, action: act.status, relative: act.relative || '', state: st.state || '', description: st.description || '', until: (st.until || 0) * 1000 });
      }
      online.sort((a, b) => (a.action === b.action ? a.name.localeCompare(b.name) : a.action === 'Online' ? -1 : 1));
      this.state.members = { names, online, total: (data.members || []).length, fetchedAt: Date.now() };
    } catch (e) {
      if (e.kind === 'soft') this.state.members = { names: {}, online: [], total: 0, denied: true, fetchedAt: Date.now() };
    }
    this.emit('state');
  }

  checkAlerts(now) {
    const c = this.state.chain;
    const s = this.store.get('chain') || {};
    if (!isActive(c, now) || now - c.fetchedAt > STALE_MS || c.current < (s.minChain || 0)) {
      this.prevRem = null;
      return;
    }
    const rem = (c.expiresAt - now) / 1000;
    const prev = this.prevRem;
    this.prevRem = rem;
    if (prev === null || !s.alerts) return;
    for (const a of ALERTS) {
      if (!s[`t${a.sec}`]) continue;
      if (prev > a.sec && rem <= a.sec && rem > a.sec - ALERT_WINDOW_SEC) {
        this.emit('beep', { ...a, volume: s.volume });
        if (s.desktop) this.notify(`Chain timer ${fmt(a.sec)}`, `Chain at ${c.current} hits. Hit someone to keep it going.`, '', 'chain');
      }
    }
  }
}

module.exports = { ChainFeature, ALERTS };

  },
  "features/claims.js": function (module, exports, require) {
'use strict';
// War claims (the user's request, 2026-11-21): the War tab's Claim button, shared through the
// Mentat server with everyone signed in to it (server/claims.js). Several people may claim one
// enemy; they show in the order they claimed. Claims come from the Mentat server, not Torn, so
// they don't touch the Torn API limit.
//   While the War tab is on show: every 3 s. During a war otherwise: every 30 s. Else not at all.

const { EventEmitter } = require('events');

const WATCHING_MS = 3000;
const WAR_MS = 30000;

class ClaimsFeature extends EventEmitter {
  constructor({ sync, war, viewing }) {
    super();
    this.sync = sync;
    this.war = war;
    this.viewing = viewing;
    this.state = { claims: {}, fetchedAt: 0, error: '' };
    this.busy = false;
    this.last = 0;
  }

  available() {
    return !!(this.sync && this.sync.signedIn());
  }

  snapshot() {
    const me = (this.sync && this.sync.me) || null;
    return { ...this.state, available: this.available(), me: me ? me.id : 0 };
  }

  tick(now) {
    if (!this.available()) {
      if (this.state.fetchedAt) { this.state = { claims: {}, fetchedAt: 0, error: '' }; this.emit('state'); }
      return;
    }
    const every = this.viewing('war') ? WATCHING_MS : this.war.inWar(now) ? WAR_MS : 0;
    if (!every || this.busy || now - this.last < every) return;
    this.load(now);
  }

  async load(now = Date.now()) {
    this.busy = true;
    this.last = now;
    try {
      this.take(await this.sync.req('GET', 'war/claims'));
    } catch (e) {
      const msg = /404|not found/i.test(e.message) ? 'Your Mentat server needs an update for claims.' : e.message;
      if (msg !== this.state.error) { this.state = { ...this.state, error: msg }; this.emit('state'); }
    } finally {
      this.busy = false;
    }
  }

  take(r) {
    const claims = r && r.claims && typeof r.claims === 'object' ? r.claims : {};
    // The server's clock vs ours, so "2 min ago" reads right on every device.
    const skew = r && r.now ? Date.now() - r.now : 0;
    for (const list of Object.values(claims)) for (const c of list) c.at += skew;
    this.state = { claims, fetchedAt: Date.now(), error: '', expiresAfter: (r && r.expiresAfter) || 0 };
    this.emit('state');
  }

  // Claim (on) or drop your claim (off) on an enemy.
  async set(target, on) {
    if (!this.available()) throw new Error('Sign in to your Mentat server to share claims.');
    const r = await this.sync.req('POST', 'war/claims', { body: { target: Number(target), claim: !!on } });
    this.take(r);
    return this.snapshot();
  }
}

module.exports = { ClaimsFeature };

  },
  "features/ffscouter.js": function (module, exports, require) {
'use strict';
// FFScouter integration (https://ffscouter.com): fair-fight and battle stat estimates for
// your targets, and FFScouter's target finder.
//
// - Uses YOUR FFScouter key (a Torn API key you registered at ffscouter.com). It's stored
//   encrypted like the Torn key and only ever sent to ffscouter.com.
// - Requests go to ffscouter.com, never api.torn.com, so they don't use your Torn API budget.
// - Estimates change slowly: each target is refreshed every 6 hours by default, all of them
//   in one request (up to 205 players per request).
// - FFScouter asks tools to credit them, link their data policy where the key is entered,
//   and not share keys or resell data. See Settings > Integrations.

const path = require('path');
const { EventEmitter } = require('events');
const { safeStorage } = require('electron');
const { Store } = require('../store');

const DAY_S = 86400;
const INTEL_GAP = 1100; // FFScouter allows 60 player-activity requests a minute
const GROWTH_DAYS = 70;
const sleep = ms => new Promise(r => setTimeout(r, ms));

const BASE = 'https://ffscouter.com/api/v1';
const KEY_PATTERN = /^[A-Za-z0-9]{16}$/;
const BATCH = 205;
const KEY_ERRORS = { 2: 'Invalid key format', 6: 'Key not registered at ffscouter.com', 4010: 'Your account is banned from FFScouter', 4011: 'Your faction is banned from FFScouter' };

class FFScouterError extends Error {
  constructor(message, code, retryAfter) {
    super(message);
    this.code = code;
    this.retryAfter = retryAfter;
  }
}

async function call(path, params) {
  const qs = new URLSearchParams(params).toString();
  const res = await fetch(`${BASE}/${path}?${qs}`, { signal: AbortSignal.timeout(20000), headers: { Accept: 'application/json', 'User-Agent': 'Mentat' } });
  let data = null;
  try { data = await res.json(); } catch (e) { /* non-JSON error page */ }
  if (!res.ok || (data && data.error)) {
    throw new FFScouterError((data && data.error) || `FFScouter returned HTTP ${res.status}`, data && data.code, data && data.retry_after_seconds);
  }
  return data;
}

class FFScouterFeature extends EventEmitter {
  constructor({ store, getTargetIds, dataDir = null }) {
    super();
    this.store = store;
    this.getTargetIds = getTargetIds;
    // Activity history and estimated-stat growth for researched factions (Premium), kept
    // out of settings.json because it's bulky. Only on this PC: it uses your FFScouter key.
    this.intelDb = dataDir ? new Store(path.join(dataDir, 'ffscouter-intel.json'), { factions: {} }, { debounceMs: 5000 }) : null;
    this.intelJob = null;
    this.inFlight = false;
    this.pausedUntil = 0;
    this.error = '';
    this.soonAt = 0;
    this.finder = { results: [], params: null, fetchedAt: 0, error: '', loading: false };
  }

  // ---- Key ----
  getKey() {
    const enc = this.store.get('ffscouter.keyEnc');
    if (!enc) return '';
    try { return safeStorage.decryptString(Buffer.from(enc, 'base64')); } catch (e) { return ''; }
  }

  hasKey() {
    return !!this.store.get('ffscouter.keyEnc');
  }

  async saveKey(key, acknowledged) {
    key = String(key || '').trim();
    if (!acknowledged) throw new Error('Please confirm you have read FFScouter\'s current data policy.');
    if (!KEY_PATTERN.test(key)) throw new Error('An FFScouter key is your 16-character Torn API key registered at ffscouter.com.');
    const info = await call('check-key', { key });
    if (!info.is_registered) throw new Error('That key isn\'t registered with FFScouter yet. Sign up at ffscouter.com first.');
    let enc;
    try { enc = safeStorage.encryptString(key).toString('base64'); } catch (e) { throw new Error('Windows encryption is unavailable, so the key cannot be stored safely.'); }
    this.store.set('ffscouter.keyEnc', enc);
    this.store.set('ffscouter.account', { premium: !!info.is_premium, premiumUntil: (info.premium_expires_at || 0) * 1000, policyUpdate: !!info.policy_update_required, checkedAt: Date.now() });
    this.store.set('ffscouter.acknowledgedAt', Date.now());
    this.error = '';
    this.pausedUntil = 0;
    this.soonAt = Date.now();
    this.emit('state');
    return this.store.get('ffscouter.account');
  }

  removeKey(reason = '') {
    this.store.set('ffscouter.keyEnc', '');
    this.store.set('ffscouter.account', null);
    this.error = reason;
    this.emit('state');
  }

  handleError(e) {
    if (e.code in KEY_ERRORS) {
      this.removeKey(`FFScouter key removed: ${KEY_ERRORS[e.code]}.`);
      return;
    }
    const wait = e.code === 21 ? Math.max(15, e.retryAfter || 60) : 300;
    this.pausedUntil = Date.now() + wait * 1000;
    this.error = `${e.name === 'TimeoutError' ? 'FFScouter timed out' : e.message}. Retrying in ${Math.ceil(wait / 60)} min.`;
  }

  // ---- Estimates for targets ----
  stats() {
    return this.store.get('ffscouter.stats') || {};
  }

  // Ask for a refresh soon (e.g. after adding targets). Coalesces into one request.
  refreshSoon(all = false) {
    if (all) {
      const s = this.stats();
      for (const v of Object.values(s)) v.fetchedAt = 0;
      this.store.set('ffscouter.stats', s);
    }
    this.soonAt = Date.now() + 3000;
  }

  async fetchStats(ids) {
    this.inFlight = true;
    try {
      const key = this.getKey();
      const s = this.stats();
      for (let i = 0; i < ids.length; i += BATCH) {
        const chunk = ids.slice(i, i + BATCH);
        const data = await call('get-stats', { key, targets: chunk.join(',') });
        const now = Date.now();
        for (const p of data || []) {
          s[p.player_id] = {
            ff: p.fair_fight ?? null,
            bs: p.bs_estimate ?? null,
            bsHuman: p.bs_estimate_human || '',
            source: p.source || '',
            updated: (p.last_updated || 0) * 1000,
            distribution: p.distribution && p.distribution.distribution_human ? p.distribution.distribution_human : '',
            fetchedAt: now,
          };
        }
        for (const id of chunk) if (!s[id]) s[id] = { ff: null, bs: null, fetchedAt: now };
      }
      // Keep estimates only for current targets (and recent finder results).
      const keep = new Set([...this.getTargetIds().map(String), ...this.finder.results.map(r => String(r.id))]);
      for (const id of Object.keys(s)) if (!keep.has(id)) delete s[id];
      this.store.set('ffscouter.stats', s);
      this.error = '';
    } catch (e) {
      this.handleError(e);
    } finally {
      this.inFlight = false;
      this.emit('state');
    }
  }

  // Premium can start or lapse after the key was saved: ask FFScouter again every 6 hours (one
  // check-key call), so activity history isn't skipped on an old answer (the user's report,
  // 2026-11-24: the app still said "not Premium" a week after a check).
  async checkAccount() {
    this.accountBusy = true;
    try {
      const info = await call('check-key', { key: this.getKey() });
      const was = this.store.get('ffscouter.account') || {};
      this.store.set('ffscouter.account', { ...was, premium: !!info.is_premium, premiumUntil: (info.premium_expires_at || 0) * 1000, policyUpdate: !!info.policy_update_required, checkedAt: Date.now() });
      this.emit('account');
      this.emit('state');
    } catch (e) {
      if (e.code in KEY_ERRORS) this.handleError(e);
      // Otherwise try again at the next 6-hour mark
      const was = this.store.get('ffscouter.account') || {};
      this.store.set('ffscouter.account', { ...was, checkedAt: Date.now() });
    } finally {
      this.accountBusy = false;
    }
  }

  tick(now) {
    if (!this.hasKey() || this.inFlight || now < this.pausedUntil) return;
    // Every 6 hours with Premium; every hour without, so a renewal is picked up soon.
    const acct = this.store.get('ffscouter.account') || {};
    if (!this.accountBusy && now - (acct.checkedAt || 0) > (acct.premium ? 6 : 1) * 3600e3) { this.checkAccount(); return; }
    const every = Math.max(1, Number(this.store.get('ffscouter.intervalHours')) || 6) * 3600 * 1000;
    const s = this.stats();
    const due = this.getTargetIds().filter(id => !s[id] || now - (s[id].fetchedAt || 0) >= every);
    if (!due.length) return;
    // New targets: wait a few seconds so several adds share one request.
    if (this.soonAt && now < this.soonAt) return;
    this.soonAt = 0;
    this.fetchStats(due);
  }

  // ---- Target finder ----
  async findTargets(p) {
    if (!this.hasKey()) throw new Error('Add your FFScouter key in Settings first.');
    const params = { key: this.getKey(), limit: 50 };
    const int = (v, lo, hi) => { const n = Math.round(Number(v)); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : null; };
    if (p.preset === 'respect' || p.preset === 'level') params.preset = p.preset;
    else {
      const minlevel = int(p.minlevel, 1, 100), maxlevel = int(p.maxlevel, 1, 100);
      if (minlevel) params.minlevel = minlevel;
      if (maxlevel) params.maxlevel = maxlevel;
      const minff = Number(p.minff), maxff = Number(p.maxff);
      if (minff >= 1) params.minff = minff;
      if (maxff >= 1) params.maxff = maxff;
      params.inactiveonly = p.inactiveonly ? 1 : 0;
      params.factionless = p.factionless ? 1 : 0;
    }
    this.finder.loading = true;
    this.emit('state');
    try {
      const data = await call('get-targets', params);
      this.finder.results = (data.targets || []).map(t => ({
        id: t.player_id, name: t.name, level: t.level, ff: t.fair_fight ?? null, bs: t.bs_estimate ?? null,
        bsHuman: t.bs_estimate_human || '', lastAction: (t.last_action || 0) * 1000, source: t.source || '',
      }));
      this.finder.error = '';
    } catch (e) {
      this.finder.results = [];
      this.finder.error = e.code === 17 ? 'No targets matched those filters.' : e.message;
      if (e.code in KEY_ERRORS) this.handleError(e);
    } finally {
      this.finder.loading = false;
      this.finder.fetchedAt = Date.now();
      this.finder.params = { ...p };
      this.emit('state');
    }
  }

  // ---- Activity history + stat growth for a faction (Premium) ----
  intel(fid) {
    return (this.intelDb && this.intelDb.get('factions') || {})[fid] || null;
  }

  async loadIntel(fid, memberIds, force = false) {
    fid = Number(fid);
    if (!this.hasKey()) throw new Error('Add your FFScouter key in Settings first.');
    if (!this.intelDb) throw new Error('Not available here.');
    const acct = this.store.get('ffscouter.account') || {};
    if (!acct.premium) throw new Error('FFScouter activity history needs FFScouter Premium.');
    const have = this.intel(fid);
    if (!force && have && Date.now() - have.at < 12 * 3600e3) return have;
    if (this.intelJob && this.intelJob.running) return null;
    const ids = [...new Set((memberIds || []).map(Number).filter(Boolean))];
    const job = this.intelJob = { fid, running: true, done: 0, total: 1 + ids.length * 4, error: '', startedAt: Date.now() };
    this.emit('state');
    const key = this.getKey();
    const end = Math.floor(Date.now() / 1000 / 900) * 900;
    const ask = async (p, params) => {
      for (let tries = 0; ; tries++) {
        await sleep(INTEL_GAP);
        try { return await call(p, { key, ...params }); } catch (e) {
          if (e.code === 20 && tries < 3) { await sleep(Math.max(5, e.retryAfter || 15) * 1000); continue; }
          throw e;
        }
      }
    };
    // Longest window FFScouter has (5000 buckets of 15 min is ~52 days); shorter if tracking began later.
    const ranged = async (p, params) => {
      for (const days of [52, 28, 14, 7]) {
        try { return { days, data: await ask(p, { ...params, start: end - days * DAY_S, end, bucket: 900 }) }; } catch (e) { if (e.code !== 35) throw e; }
      }
      return { days: 0, data: { buckets: [] } };
    };
    const out = { at: Date.now(), days: 0, start: 0, end: end * 1000, faction: null, members: {}, growth: {} };
    try {
      const f = await ranged('activity/faction', { faction_id: fid });
      job.done++;
      const slots = Array.from({ length: 96 }, () => [0, 0]);
      const week = Array.from({ length: 168 }, () => [0, 0]);
      for (const b of f.data.buckets || []) {
        const v = Number(b.active_players ?? b.activity_score) || 0;
        const d = new Date(b.ts * 1000);
        const s = d.getUTCHours() * 4 + Math.floor(d.getUTCMinutes() / 15);
        slots[s][0] += v; slots[s][1]++;
        const h = d.getUTCDay() * 24 + d.getUTCHours();
        week[h][0] += v; week[h][1]++;
      }
      out.days = f.days;
      out.start = (end - f.days * DAY_S) * 1000;
      out.faction = { slots, week, memberCount: (f.data.meta && f.data.meta.member_count) || ids.length };
      for (const id of ids) {
        const p = await ranged('activity/player', { target: id });
        job.done++;
        const act = new Array(96).fill(0), obs = new Array(96).fill(0);
        const days = new Set();
        for (const b of p.data.buckets || []) {
          const d = new Date(b.ts * 1000);
          const s = d.getUTCHours() * 4 + Math.floor(d.getUTCMinutes() / 15);
          obs[s]++;
          if ((Number(b.activity_score) || 0) > 0) { act[s]++; days.add(d.toISOString().slice(0, 10)); }
        }
        out.members[id] = { act, obs, days: p.days, activeDays: days.size };
        // Estimated battle stats then and now: growth over 10 weeks and over the last 4.
        const g = {};
        const at = async (from, sort) => {
          const h = await ask('get-stats-history', { target: id, from, to: end, sort, limit: 1 });
          const x = (h.history || [])[0];
          return x && x.bs_estimate ? { t: x.timestamp * 1000, bs: x.bs_estimate } : null;
        };
        try {
          g.first = await at(end - GROWTH_DAYS * DAY_S, 'asc'); job.done++;
          g.mid = await at(end - 28 * DAY_S, 'asc'); job.done++;
          g.last = await at(end - GROWTH_DAYS * DAY_S, 'desc'); job.done++;
        } catch (e) { if (e.code in KEY_ERRORS || e.code === 19) throw e; job.done += 3; }
        out.growth[id] = g;
        if (job.done % 8 === 0) this.emit('state');
      }
      const all = this.intelDb.get('factions') || {};
      all[fid] = out;
      // Keep the 6 most recent factions.
      for (const k of Object.keys(all).sort((a, b) => all[b].at - all[a].at).slice(6)) delete all[k];
      this.intelDb.set('factions', all);
      return out;
    } catch (e) {
      job.error = e.code === 19 ? 'FFScouter Premium is needed for activity history.' : e.message;
      if (e.code === 19) this.store.set('ffscouter.account', { ...acct, premium: false });
      if (e.code in KEY_ERRORS) this.handleError(e);
      throw new Error(job.error);
    } finally {
      job.running = false;
      this.emit('state');
    }
  }

  snapshot() {
    return {
      intelJob: this.intelJob,
      intel: this.intelDb ? this.intelDb.get('factions') || {} : {},
      hasKey: this.hasKey(),
      account: this.store.get('ffscouter.account'),
      error: this.error,
      pausedUntil: this.pausedUntil > Date.now() ? this.pausedUntil : 0,
      stats: this.stats(),
      finder: this.finder,
    };
  }
}

module.exports = { FFScouterFeature };

  },
  "features/market.js": function (module, exports, require) {
'use strict';
// Item prices and trading data, all from the official Torn API (public-level data):
// - Item catalog with Torn's market value for every item: /v2/torn/items (one request, cached 6h)
// - Live item market listings for one item: /v2/market/{id}/itemmarket (globally cached by Torn)
// - Points market: /v2/market/pointsmarket
// The travel planner reads prices from here too.

const { EventEmitter } = require('events');

const CATALOG_MAX_AGE = 6 * 3600 * 1000;
const LIVE_MIN_AGE = 60 * 1000;          // never re-fetch one item's listings more often than this
const LIVE_KEEP = 30 * 60 * 1000;        // drop live results older than this from the snapshot
const POINTS_AGE = 5 * 60 * 1000;        // points market refresh while the Market panel is open
const MAX_QUEUED_LIVE = 25;

const marketUrl = id => `https://www.torn.com/page.php?sid=ItemMarket#/market/view=search&itemID=${id}`;

class MarketFeature extends EventEmitter {
  constructor({ api, store, cache, notify, history }) {
    super();
    this.api = api;
    this.store = store;
    this.cache = cache;
    this.notify = notify;
    this.history = history;
    this.bazaar = null;         // set by main.js (BazaarFeature)
    this.scan = null;           // { type, ids, queue, startedAt }
    this.catalogInFlight = false;
    this.catalogTriedAt = 0;
    this.live = new Map();      // id -> { fetchedAt, lowest, average, listings, next }
    this.pending = new Set();   // ids queued for a live fetch
    this.points = null;
    this.pointsInFlight = false;
    this.emitTimer = null;
  }

  // ---- Catalog ----
  catalog() {
    return this.cache.get('items') || null;
  }

  // Map for the UI: id -> [name, type, marketValue, circulation, tradable, shops]
  catalogCompact() {
    const c = this.catalog();
    if (!c) return { fetchedAt: 0, items: {} };
    return { fetchedAt: c.fetchedAt, items: c.items };
  }

  item(id) {
    const c = this.catalog();
    return c ? c.items[id] || null : null;
  }

  marketValue(id) {
    const it = this.item(id);
    return it ? it[2] : 0;
  }

  async fetchCatalog(now) {
    this.catalogInFlight = true;
    this.catalogTriedAt = now;
    try {
      const d = await this.api.request('/v2/torn/items', { priority: 7 });
      const items = {};
      // id -> [name, type, marketValue, circulation, tradable, shops]
      // shops: [[country, shop, buyPrice, sellPrice], ...] (where Torn shops sell/buy it)
      for (const it of d.items || []) {
        const v = it.value || {};
        const shops = (v.shops || []).map(sh => [sh.country, sh.shop, sh.buy_price || 0, sh.sell_price || 0]);
        items[it.id] = [it.name, it.type, v.market_price || 0, it.circulation || 0, !!it.is_tradable, shops];
      }
      this.cache.set('items', { fetchedAt: Date.now(), items });
      this.history.recordMarketValues(items, Date.now());
      this.emitSoon();
    } catch (e) { /* the API banner explains errors; retried after 10 min */ }
    finally { this.catalogInFlight = false; }
  }

  // ---- Live listings ----
  requestLive(ids, priority = 7) {
    const now = Date.now();
    let queued = 0;
    for (const raw of ids) {
      const id = Number(raw);
      if (!id || this.pending.has(id)) continue;
      const l = this.live.get(id);
      if (l && now - l.fetchedAt < Math.max(LIVE_MIN_AGE, l.next ? l.next - l.fetchedAt : 0)) continue;
      if (this.pending.size >= MAX_QUEUED_LIVE) break;
      this.pending.add(id);
      queued++;
      this.fetchLive(id, priority);
    }
    if (queued) this.emitSoon();
    return { queued };
  }

  async fetchLive(id, priority) {
    try {
      const d = await this.api.request(`/v2/market/${id}/itemmarket?limit=20`, { priority, soft: [6, 7] });
      const m = d.itemmarket || {};
      const listings = (m.listings || []).map(l => ({ price: l.price, amount: l.amount })).sort((a, b) => a.price - b.price);
      this.live.set(id, {
        fetchedAt: Date.now(),
        lowest: listings.length ? listings[0].price : 0,
        average: (m.item && m.item.average_price) || 0,
        listings: listings.slice(0, 8),
        next: m.cache_delay ? Date.now() + m.cache_delay * 1000 : 0,
      });
      this.history.recordLowest(id, Date.now(), listings.length ? listings[0].price : 0);
      this.checkWatch(id);
    } catch (e) {
      if (e.kind === 'soft') this.live.set(id, { fetchedAt: Date.now(), lowest: 0, average: 0, listings: [], error: e.message });
    } finally {
      this.pending.delete(id);
      this.emitSoon();
    }
  }

  // ---- Watchlist + price alerts ----
  watch() {
    return this.store.get('market.watch') || {};
  }

  addWatch(id, below) {
    id = Number(id);
    if (!id) return;
    const w = this.watch();
    w[id] = { id, below: Number(below) > 0 ? Number(below) : 0, lastCheck: 0 };
    this.store.set('market.watch', w);
    this.requestLive([id], 6);
    this.emitSoon();
  }

  setBelow(id, below) {
    const w = this.watch();
    if (!w[id]) return;
    w[id].below = Number(below) > 0 ? Number(below) : 0;
    delete w[id].alerted;
    this.store.set('market.watch', w);
    this.checkWatch(Number(id));
    this.emitSoon();
  }

  removeWatch(id) {
    const w = this.watch();
    delete w[id];
    this.store.set('market.watch', w);
    this.emitSoon();
  }

  // Cheapest price for an item from the chosen source: item market, bazaars, or both.
  lowestFor(id) {
    const src = this.store.get('market.priceSource') || 'both';
    const l = this.live.get(id);
    const market = src !== 'bazaar' && l && l.lowest ? l.lowest : 0;
    const baz = src !== 'market' && this.bazaar && this.bazaar.enabled() ? this.bazaar.lowest(id) : 0;
    if (market && (!baz || market <= baz)) return { price: market, where: 'item market' };
    if (baz) return { price: baz, where: 'a bazaar' };
    return { price: 0, where: '' };
  }

  // Alert when the price first drops to the target, or drops further after that. The price
  // last alerted on is saved, so restarting the app doesn't repeat alerts for the same deal.
  checkWatch(id) {
    const all = this.watch();
    const w = all[id];
    if (!w || !w.below) return;
    const { price, where } = this.lowestFor(id);
    if (!price) return;
    const alerted = w.alerted || 0;
    if (price > w.below) {
      if (alerted) {
        delete w.alerted;
        this.store.set('market.watch', all);
      }
      return;
    }
    if (alerted && price >= alerted) return;
    w.alerted = price;
    this.store.set('market.watch', all);
    const it = this.item(id);
    const name = it ? it[0] : `Item ${id}`;
    this.notify(`${name}: $${price.toLocaleString('en-US')} in ${where}`, `At or below your $${w.below.toLocaleString('en-US')} target.`, marketUrl(id), 'market');
  }

  checkAllWatches() {
    for (const id of Object.keys(this.watch())) this.checkWatch(Number(id));
  }

  // ---- Points market ----
  async fetchPoints() {
    this.pointsInFlight = true;
    try {
      const d = await this.api.request('/v2/market/pointsmarket', { priority: 7 });
      const list = (d.pointsmarket || []).map(p => ({ cost: p.cost, quantity: p.quantity })).sort((a, b) => a.cost - b.cost);
      this.points = { fetchedAt: Date.now(), lowest: list.length ? list[0].cost : 0, listings: list.slice(0, 5) };
    } catch (e) {
      this.points = { fetchedAt: Date.now(), lowest: 0, listings: [], error: e.message };
    } finally {
      this.pointsInFlight = false;
      this.emitSoon();
    }
  }

  refreshPoints() {
    this.points = this.points ? { ...this.points, fetchedAt: 0 } : null;
  }

  // ---- Deal scanner: live listings for every tradable item of one type ('*' = all types) ----
  // Items worth at least minValue only. Most valuable first, so the biggest deals show early.
  startScan(type, minValue = 0) {
    const c = this.catalog();
    if (!c) return { total: 0 };
    const ids = Object.entries(c.items)
      .filter(([, it]) => (type === '*' || it[1] === type) && it[4] && it[2] > 0 && it[2] >= minValue)
      .sort((a, b) => b[1][2] - a[1][2])
      .map(([id]) => Number(id));
    this.scan = { type, ids, queue: [...ids], startedAt: Date.now() };
    this.emitSoon();
    return { total: ids.length };
  }

  stopScan() {
    if (this.scan) this.scan.queue = [];
    this.emitSoon();
  }

  // ---- Loop ----
  tick(now) {
    if (!this.api.hasKey()) return;
    const c = this.catalog();
    if (!this.catalogInFlight && (!c || now - c.fetchedAt > CATALOG_MAX_AGE) && now - this.catalogTriedAt > 10 * 60 * 1000) this.fetchCatalog(now);

    const every = Math.max(60, Number(this.store.get('market.watchInterval')) || 300) * 1000;
    const w = this.watch();
    // Watched items need item market requests only when the item market is a price source;
    // bazaar prices come from the Weav3r summary (no Torn requests).
    if (this.store.get('market.priceSource') !== 'bazaar') {
      const due = Object.keys(w).map(Number).filter(id => {
        const l = this.live.get(id);
        return !l || now - l.fetchedAt >= every;
      });
      if (due.length) this.requestLive(due, 6);
    }

    const looking = this.viewing ? this.viewing('market') : this.store.get('ui.panel') === 'market';
    if (looking && !this.pointsInFlight && (!this.points || now - this.points.fetchedAt >= POINTS_AGE)) this.fetchPoints();

    // Feed the scan a few items at a time so other features keep their share of requests.
    // The scan only uses ~80% of the per-minute budget, leaving room for everything else.
    if (this.scan && this.scan.queue.length && this.pending.size < 3) {
      const st = this.api.status();
      if (st.usedLastMinute < st.maxPerMinute * 0.8) this.requestLive(this.scan.queue.splice(0, 3 - this.pending.size), 8);
    }

    const keep = new Set(this.scan ? this.scan.ids : []);
    for (const [id, l] of this.live) if (now - l.fetchedAt > LIVE_KEEP && !w[id] && !keep.has(id)) this.live.delete(id);
  }

  emitSoon() {
    if (this.emitTimer) return;
    this.emitTimer = setTimeout(() => { this.emitTimer = null; this.emit('state'); }, 200);
  }

  snapshot() {
    const c = this.catalog();
    return {
      catalogAt: c ? c.fetchedAt : 0,
      catalogCount: c ? Object.keys(c.items).length : 0,
      watch: Object.values(this.watch()),
      live: Object.fromEntries(this.live),
      pending: [...this.pending],
      points: this.points,
      scan: this.scan ? { type: this.scan.type, ids: this.scan.ids, left: this.scan.queue.length, startedAt: this.scan.startedAt } : null,
    };
  }
}

module.exports = { MarketFeature, marketUrl };

  },
  "features/mugger.js": function (module, exports, require) {
'use strict';
// Mugger: who is worth mugging where you are abroad, and can you take them.
//
// The user's rules (2026-11-24): only players ABROAD matter (in Torn they can bank their money);
// players who buy costly items abroad carry cash; bazaar and item market sales made while they are
// abroad go to their cash on hand (wiki "Mug": "the money from the purchase is deposited into their
// wallet"). Restocks of thousands of items are several trips put in at once, not one.
//
// 1. Market database (muggerdb.js): bazaar sellers of abroad items and how their stock moves, 90
//    days, collected every 30 minutes by the Mentat server (or this device without one). No Torn API.
// 2. Your trip (Torn API with YOUR key on this device, never the server's — the user's rule,
//    2026-11-24 — and ONLY while you are flying out or abroad): the best `mugger.pool` traders for
//    that country from the database plus your Targets/Abroad lists, one /user/{id}?selections=profile
//    each; players in your country again every `mugger.here` minutes (1 by default, the user's
//    request 2026-11-24), those flying there every 3, the rest every 20. For each
//    player near you, once per trip: their job (/v2 job: a 7★ Clothing Store cuts mugs by 75%) and
//    travel record (/v2 personalstats cat=travel, plus items/trips a week ago); their trading stats
//    (/v2 personalstats cat=trading) every `mugger.market` minutes (5 by default) while they are in your country: item market
//    revenue since the first reading this trip = money into their wallet. Your battle stats once per
//    trip, your merits once a day. FFScouter: core.js adds the players near you to the FFScouter list,
//    which fetches each once and not again within 6 hours, so once per person per trip.
// 3. Bazaar sales near you: the items those players sell are re-read from Weav3r every 5 minutes.
// 4. Possible mug protection (the user's request 2026-11-25): anyone seen in hospital in your trip's
//    country is flagged for 12 hours from that sighting ("Mugged by" in the reason confirms it), and
//    the travel record adds their fights lost abroad since yesterday (defendslostabroad, by day, no country).
//
// Mug size (Torn wiki "Mug", pasted by the user 2026-11-24): 5% of cash on hand, rolled up to 10%
// (low values favoured), × (1 + Masterful Looting (5% a level, up to +50%) + Plunder (+20% to 49%),
// additive); a 7★ Clothing Store employee loses 75% less; after a mug the rest of their wallet is
// protected, the protection decaying to nothing over 12 hours.

const path = require('path');
const { EventEmitter } = require('events');
const { Store } = require('../store');
const { COUNTRIES } = require('./travel');
const { parseTrip, flightRange, COUNTRY_BY_NAME } = require('./war');
const { traderInfo, scores, rankTraders, TRADE_QTY } = require('./muggerdb');

const FLYING_EVERY = 3 * 60e3;
const FAR_EVERY = 20 * 60e3;
const RECORD_EVERY = 12 * 3600e3;
const MERITS_EVERY = 24 * 3600e3;
const TYPES_EVERY = 7 * 86400e3;
const RETRY = 2 * 60e3;
const WEEK = 7 * 86400e3;
const PLAYER_KEEP = 14 * 86400e3;
const COUNTRY_STATS = { mex: 'mexico', cay: 'cayman_islands', can: 'canada', haw: 'hawaii', uni: 'united_kingdom', arg: 'argentina', swi: 'switzerland', jap: 'japan', chi: 'china', uae: 'united_arab_emirates', sou: 'south_africa' };
const MUG = { base: [0.05, 0.10], lootingPerLevel: 0.05, clothing: 0.25 };

const PROTECT = 12 * 3600e3; // a mug protects what is left for 12 hours (Torn wiki "Mug")
const SAME_STAY = 25 * 60e3; // two hospital sightings this close together are one stay
// A hospital stay another player caused (only those can be a mug). Seen live 2026-11-25: "Mugged by X",
// "Hospitalized by X"; self-inflicted ones read like "Suffering from an acute hemolytic transfusion reaction",
// "Severe emesis following Ipecac Syrup ingestion", "Got a nasty surprise in the post."
const BY_PLAYER = /^(Mugged|Hospitali[sz]ed|Attacked) by /i;
const DAY = 86400e3;

const countryOf = name => COUNTRY_BY_NAME.get(String(name || '').trim().replace(/\.$/, '').toLowerCase()) || null;

// A hospital stay abroad reads like "In a Swiss hospital for 23 mins"; one in Torn "In hospital for ...".
// The abroad wording isn't confirmed against a live answer yet: without a match, the last country seen stands.
const HOSPITAL_ADJ = { mexican: 'Mexico', caymanian: 'Cayman Islands', canadian: 'Canada', hawaiian: 'Hawaii', british: 'United Kingdom', english: 'United Kingdom', argentinian: 'Argentina', argentine: 'Argentina', swiss: 'Switzerland', japanese: 'Japan', chinese: 'China', emirati: 'UAE', 'south african': 'South Africa' };
function hospitalCountry(desc) {
  const m = /^In an? (.+?) hospital\b/i.exec(String(desc || '').trim());
  if (!m) return '';
  const adj = HOSPITAL_ADJ[m[1].toLowerCase()];
  const c = countryOf(adj || m[1]);
  return c ? c.name : '';
}

// ---- A pasted list of the people in your country (the user's request 2026-11-25) ----
// You copy Torn's People list yourself (Mentat never reads Torn's pages) and paste it on the Mugger page.
// Copied with links, the page turns it into "Name [id]" lines; as plain text, names are matched against
// the market database, then looked up with Torn's player search (your key). Words that are clearly
// not names (the list's own labels, countries) are skipped.
const PASTE_MAX = 300;
const LOOKUP_MAX = 100;
const NOT_NAMES = new Set(('level lvl status okay hospital hospitalized traveling travelling abroad jail jailed attack attacks mug ' +
  'name names faction factions icons icon life online offline idle people page pages next prev previous last first show all sort ' +
  'by rank age days day hours hrs hour mins min minutes seconds secs ago user users profile list the and for from with you your ' +
  'mexico cayman islands canada hawaii united kingdom argentina switzerland japan china uae arab emirates south africa torn city ' +
  'returning flying landing landed bazaar shop market donator member members company none').split(' '));
function parsePeople(text) {
  const s = String(text || '');
  const ids = new Map(); // id -> name
  for (const m of s.matchAll(/([A-Za-z0-9_-]{1,20})\s*\[(\d{1,8})\]/g)) ids.set(Number(m[2]), m[1]);
  for (const m of s.matchAll(/(?:XID|user2ID)=(\d{1,8})/gi)) if (!ids.has(Number(m[1]))) ids.set(Number(m[1]), '');
  const rest = s.replace(/https?:\/\/\S+/gi, ' ').replace(/(?:XID|user2ID)=\d{1,8}/gi, ' ').replace(/[A-Za-z0-9_-]{1,20}\s*\[\d{1,8}\]/g, ' ');
  const nameLike = [...new Set((rest.match(/[A-Za-z0-9_-]+/g) || []).filter(w => /[A-Za-z]/.test(w) && w.length >= 3 && w.length <= 20 && !NOT_NAMES.has(w.toLowerCase())))];
  // Only a bare list of numbers is a list of IDs; numbers among words are levels, life and so on.
  if (!/[A-Za-z]/.test(rest)) for (const m of rest.matchAll(/\b\d{1,8}\b/g)) ids.set(Number(m[0]), '');
  const named = new Set([...ids.values()].filter(Boolean).map(n => n.toLowerCase()));
  return { ids: [...ids].filter(([id]) => id > 0).map(([id, name]) => ({ id, name })), names: nameLike.filter(n => !named.has(n.toLowerCase())) };
}

// Where a player is: place = country name or 'Torn'; kind = here | flying | hospital | jail | away.
function placeOf(st, lastIn) {
  st = st || {};
  const desc = String(st.description || '');
  if (st.state === 'Okay') return { place: 'Torn', kind: 'here' };
  if (st.state === 'Abroad') {
    const m = /^In (.+?)\.?$/i.exec(desc.trim());
    const c = m && countryOf(m[1]);
    return { place: c ? c.name : (m ? m[1] : ''), kind: 'here' };
  }
  if (st.state === 'Traveling') {
    const t = parseTrip(desc);
    if (!t || !t.country) return { place: '', kind: 'flying' };
    return t.back ? { place: 'Torn', kind: 'flying', from: t.country.name } : { place: t.country.name, kind: 'flying', from: 'Torn' };
  }
  if (st.state === 'Hospital') return { place: hospitalCountry(desc) || lastIn || 'Torn', kind: 'hospital' };
  if (st.state === 'Jail') return { place: 'Torn', kind: 'jail' };
  return { place: '', kind: 'away' };
}

// Your trip: flying out to a country, or there. null in Torn or on the way home.
function myTrip(u) {
  if (!u) return null;
  const st = u.status || {};
  const tr = u.travel;
  const dest = tr && tr.destination && tr.destination !== 'Torn' ? tr.destination : '';
  let country = '';
  if (st.state === 'Traveling') country = dest;
  else if (st.state === 'Abroad') country = dest || placeOf(st).place;
  else if (st.state === 'Hospital' && dest) country = dest;
  const c = countryOf(country);
  if (!c) return null;
  // The trip's identity: Torn's own departure time (whole seconds). Not departedAt, which is corrected
  // for clock skew on every status poll and so moved by milliseconds each time, making every poll a "new
  // trip" that threw away the checks so far (seen 2026-11-25 on a Hawaii trip: never got past ~19 of 150).
  const departed = tr && tr.departed ? Number(tr.departed) : 0;
  return { country: c.name, flying: st.state === 'Traveling', departed, key: `${c.name}|${departed || 'x'}` };
}

class MuggerFeature extends EventEmitter {
  constructor({ api, store, dataDir, db, user, viewing = () => false }) {
    super();
    this.api = api;
    this.store = store;
    this.mdb = db; // the market database (muggerdb.js)
    this.user = user;
    this.viewing = viewing;
    this.db = new Store(path.join(dataDir, 'mugger.json'), { trip: null, players: {}, me: null, merits: null, types: null }, { debounceMs: 20000 });
    this.extraIds = () => []; // your Targets and Abroad lists (core.js)
    this.inFlight = false;
    this.calls = [];
    this.pool = null;
    this.emitTimer = null;
    db.on('state', () => this.emitSoon());
    db.on('live', () => this.emitSoon());
    db.on('scanned', () => { this.pool = null; this.emitSoon(); });
  }

  // ---- Settings ----
  minCost() { return Math.max(10000, Number(this.store.get('mugger.minCost')) || 100000); }
  poolSize() { return Math.min(150, Math.max(10, Number(this.store.get('mugger.pool')) || 60)); }
  rate() { return Math.min(60, Math.max(5, Number(this.store.get('mugger.rate')) || 20)); }
  // Minutes between checks of players in your country (1-3).
  hereEvery() { return Math.min(3, Math.max(1, Number(this.store.get('mugger.here')) || 1)) * 60e3; }
  // Minutes between item market checks of players in your country (2-10).
  marketEvery() { return Math.min(10, Math.max(2, Number(this.store.get('mugger.market')) || 5)) * 60e3; }
  lootingAuto() { const v = this.store.get('mugger.looting'); return v === 'auto' || v === undefined || v === null; }
  // Masterful Looting level: from your merits (auto) or set by hand.
  looting() {
    if (this.lootingAuto()) { const m = this.db.data.merits; return m && Number.isFinite(m.looting) ? m.looting : 0; }
    return Math.min(10, Math.max(0, Number(this.store.get('mugger.looting')) || 0));
  }
  plunder() { return Math.min(49, Math.max(0, Number(this.store.get('mugger.plunder')) || 0)); }
  mult() { return 1 + this.looting() * MUG.lootingPerLevel + this.plunder() / 100; }

  // Your trip. If Torn's answer lacks the departure time (e.g. after landing), the trip to the same
  // country already under way carries on instead of starting over.
  trip() {
    const t = myTrip(this.user.state && this.user.state.data);
    const d = this.db.data.trip;
    if (t && !t.departed && d && d.country === t.country && d.departed && Date.now() - d.departed * 1000 < 12 * 3600e3) return { ...t, departed: d.departed, key: d.key };
    return t;
  }

  // The country on show: your choice, else your trip's, else the last one you went to.
  location() {
    const v = String(this.store.get('mugger.location') || 'auto');
    if (v !== 'auto' && countryOf(v)) return countryOf(v).name;
    const t = this.trip();
    if (t) return t.country;
    const last = this.db.data.trip;
    return last && last.country ? last.country : 'Mexico';
  }

  // Live (Torn API) only for the country of your trip.
  live() {
    const t = this.trip();
    return !!t && t.country === this.location();
  }

  // ---- What the market database says about a seller (no API; muggerdb.js traderInfo) ----
  sellerInfo(pid, items, country, now = Date.now()) {
    return traderInfo(this.mdb.seller(pid), items, country, this.minCost(), now);
  }

  // Bazaar sales since a time (at most 3× the abroad price each), database + watched readings.
  bazaarSold(info, since, items) {
    let value = 0, units = 0;
    for (const e of info.raw.ev) {
      if (e[0] < since || e[2] >= 0) continue;
      const m = items.get(e[1]);
      value += -e[2] * Math.min(e[3], m ? m.cost * 3 : e[3]);
      units += -e[2];
    }
    return { value, units };
  }

  // ---- Scores: for the country and overall, each 0-100 (muggerdb.js scores) ----
  score(info, rec, cash, country) {
    return scores(info, rec, cash, country);
  }

  // Items a trip: their last week's pace, else their average, else your capacity (the page says so).
  // Their carrying capacity, estimated (the user's rules, 2026-11-25): 15 always (5 base + 10 from a
  // Private Island airstrip, WLT stock or a Business Class Ticket); faction excursion upgrades +10 (only
  // your own faction's upgrades are in the API, so assumed maxed); a large suitcase +3 (the standard
  // 28-item setup); a Cruise Line job +2 from 3★, +5 at 10★ (from their job). No Smuggling For Beginners
  // book (unlikely); the 7★ Flower/Toy Shop bonus is for flowers and plushies only, so not counted.
  capacityOf(p) {
    const parts = [[15, 'base + airstrip/WLT/ticket'], [10, 'faction excursions (assumed maxed)'], [3, 'large suitcase (assumed)']];
    const j = p && p.job && !p.job.error ? p.job : null;
    const cruise = j && j.cruise ? (j.rating >= 10 ? 5 : j.rating >= 3 ? 2 : 0) : 0;
    if (cruise) parts.push([cruise, `${j.rating}★ Cruise Line`]);
    return { n: parts.reduce((a, x) => a + x[0], 0), text: parts.map(x => `${x[0]} ${x[1]}`).join(' + '), jobKnown: !!j };
  }

  // Items a trip: a trader flying out goes for a full load (the user's rule, 2026-11-25): their estimated
  // capacity, or their own average a trip if that's higher (a book, say).
  perTrip(rec, p = null) {
    let own = null;
    if (rec && rec.week && rec.week.trips > 0 && rec.week.items > 0) own = { n: rec.week.items / rec.week.trips, basis: 'their last week' };
    else if (rec && rec.now && rec.now.trips > 0 && rec.now.items > 0) own = { n: rec.now.items / rec.now.trips, basis: 'their average' };
    const cap = this.capacityOf(p);
    if (own && own.n > cap.n) return { n: own.n, basis: `a full load (${own.basis}: ${Math.round(own.n)} a trip, above the ${cap.n} estimated)`, cap };
    return { n: cap.n, basis: `a full load (${cap.n} = ${cap.text}${cap.jobKnown ? '' : '; job not checked yet'})`, cap };
  }

  // What they trade from a country: what they've listed (more than 5 at once) or restocked in the last
  // 90 days, and what Torn's bazaar directory says their bazaar specialises in. Most first.
  tradesFrom(info, country) {
    if (!info) return [];
    const out = new Map();
    for (const x of info.hist || []) if (x.countries.includes(country)) out.set(x.id, { ...x });
    for (const x of info.items) if (x.countries.includes(country) && !out.has(x.id)) out.set(x.id, { ...x });
    for (const x of info.spec || []) if (x.countries.includes(country) && !out.has(x.id)) out.set(x.id, { ...x, q: x.customers });
    return [...out.values()].sort((a, b) => b.q - a.q);
  }

  // Cash a trip takes: a full load × the abroad price of what they've traded most from this country.
  // No record of them trading anything from it: not known. No guessing (the user's rule, 2026-11-25).
  tripCash(info, rec, country, p = null) {
    const local = this.tradesFrom(info, country);
    if (!local.length) return null;
    const staple = local[0];
    const pt = this.perTrip(rec, p);
    return { amount: pt.n * staple.cost, items: pt.n, basis: pt.basis, name: staple.name, cost: staple.cost, local: true, why: 'what they have sold most from there' };
  }

  tripUnknown(info, country) {
    return info && !this.tradesFrom(info, country).length ? `No record in the market database of them selling anything from ${country}, so what they buy there (and the money it takes) isn't known.` : '';
  }

  // Cash on hand now, estimated (live only): the money for the trip while they're still flying out,
  // plus bazaar and item market sales since they left Torn.
  cashNow(p, info, rec, country, items) {
    if (!p || !p.place) return null;
    const out = { since: p.awaySince || 0, trip: 0, bazaar: 0, bazaarUnits: 0, market: 0, total: 0 };
    if (p.place.kind === 'flying' && p.place.place === country) {
      const tc = this.tripCash(info, rec, country, p);
      if (tc) out.trip = tc.amount;
      else out.tripUnknown = this.tripUnknown(info, country);
    }
    if (info && out.since) { const b = this.bazaarSold(info, out.since, items); out.bazaar = b.value; out.bazaarUnits = b.units; }
    const t0 = p.trade0, t1 = p.trade;
    if (t0 && t1 && !t1.error && !t0.error) out.market = Math.max(0, (t1.revenue - t0.revenue) - (t1.fees - t0.fees));
    out.total = out.trip + out.bazaar + out.market;
    return out;
  }

  // What a mug takes from that cash (wiki formula), with the 7★ Clothing Store cut.
  mugTake(cash, p) {
    if (!cash || !(cash.total > 0)) return null;
    const clothing = !!(p && p.job && p.job.clothing && p.job.rating >= 7);
    const k = this.mult() * (clothing ? MUG.clothing : 1);
    return { lo: cash.total * MUG.base[0] * k, hi: cash.total * MUG.base[1] * k, pctLo: MUG.base[0] * k, pctHi: MUG.base[1] * k, clothing };
  }

  // ---- The traders for a country: best from the database, plus your lists ----
  candidates(country) {
    const best = rankTraders(this.mdb, country, this.minCost(), this.poolSize(), pid => this.record(pid)).map(x => x.id);
    const extra = (this.extraIds() || []).map(Number).filter(Boolean);
    return [...new Set([...best, ...extra])];
  }

  record(pid) {
    const p = this.db.data.players[pid];
    return p && p.rec && !p.rec.error ? p.rec : null;
  }

  // Possible mug protection: seen in hospital in this country within the last 12 hours.
  protection(p, country, now = Date.now()) {
    const h = p && p.hosp;
    if (!h || h.place !== country || now - h.at >= PROTECT || !BY_PLAYER.test(h.text || '')) return null;
    return { at: h.at, seen: h.seen, ends: h.at + PROTECT, place: h.place, text: h.text, mugged: !!h.mugged, now: !!(p.place && p.place.kind === 'hospital') };
  }

  // Mugged in this country within 12 hours (the hospital reason said so): what they had left is
  // protected, so they come off the list into the Mug protected box and aren't checked again until the
  // protection ends (the user's request, 2026-11-25).
  muggedHere(p, country, now = Date.now()) {
    const pr = this.protection(p, country, now);
    return pr && pr.mugged ? pr : null;
  }

  near(p, country) {
    return !!(p && p.place && p.place.place === country && ['here', 'flying', 'hospital'].includes(p.place.kind));
  }

  // ---- The pasted People list: kept for this trip; once you've landed, only these are checked ----
  pasteFor(trip, create = false) {
    const p = this.db.data.paste;
    if (p && trip && p.trip === trip.key) return p;
    if (!create || !trip) return null;
    return (this.db.data.paste = { trip: trip.key, country: trip.country, at: Date.now(), ids: [], names: {}, left: [], lookups: [], notFound: [], lookupRetryAt: 0 });
  }

  pasteActive(trip) {
    const p = this.pasteFor(trip);
    return !!(p && !trip.flying && (p.ids.length || p.lookups.length));
  }

  pasteAdd(ps, id, name) {
    id = Number(id);
    if (!Number.isInteger(id) || id <= 0 || ps.ids.includes(id) || ps.ids.length >= PASTE_MAX) return false;
    ps.ids.push(id);
    if (name) ps.names[id] = String(name).slice(0, 30);
    ps.left = ps.left.filter(x => x.id !== id);
    return true;
  }

  paste(text) {
    const trip = this.trip();
    if (!trip) return { error: "Paste Torn's People list once you're abroad." };
    const { ids, names } = parsePeople(text);
    if (!ids.length && !names.length) return { error: 'No players found in that text.' };
    const ps = this.pasteFor(trip, true);
    ps.at = Date.now();
    const known = new Map(this.mdb.nameIndex());
    for (const [pid, p] of Object.entries(this.db.data.players)) if (p.name) known.set(String(p.name).toLowerCase(), Number(pid));
    let added = 0, byName = 0;
    for (const x of ids) if (this.pasteAdd(ps, x.id, x.name)) added++;
    for (const n of names) {
      const id = known.get(n.toLowerCase());
      if (id) { if (this.pasteAdd(ps, id, n)) { added++; byName++; } } else if (!ps.lookups.includes(n) && !ps.notFound.includes(n)) ps.lookups.push(n);
    }
    ps.lookups = ps.lookups.slice(0, LOOKUP_MAX);
    this.pool = null;
    this.db.save();
    this.emitSoon();
    return { added, byName, lookups: ps.lookups.length, total: ps.ids.length };
  }

  // Players from a list on a Torn page (right-click "Add all players in this list to Mugger", main.js, the
  // user's request 2026-11-25): onto the pasted list for this trip, exactly as a paste with links.
  addPlayers(players) {
    const trip = this.trip();
    if (!trip) return { error: 'Mugger adds players once you are flying out or abroad.' };
    const ps = this.pasteFor(trip, true);
    ps.at = Date.now();
    let added = 0;
    for (const x of players || []) if (this.pasteAdd(ps, x.id, x.name)) added++;
    this.pool = null;
    this.db.save();
    this.emitSoon();
    return { added, total: ps.ids.length, full: ps.ids.length >= PASTE_MAX, country: trip.country, landed: !trip.flying };
  }

  pasteClear() {
    this.db.data.paste = null;
    this.pool = null;
    this.db.save();
    this.emitSoon();
  }

  // A name from a plain-text paste: Torn's player search (your key), exact name only.
  async fetchLookup(name, trip) {
    const ps = this.pasteFor(trip);
    if (!ps) return;
    const drop = () => { ps.lookups = ps.lookups.filter(n => n !== name); };
    try {
      const d = await this.api.request(`/v2/user/search?name=${encodeURIComponent(name)}`, { soft: [6, 7, 16], priority: 8 });
      const hit = (d.search || []).find(u => u && String(u.name || '').toLowerCase() === name.toLowerCase());
      drop();
      if (hit && this.pasteAdd(ps, hit.id, hit.name)) this.pool = null;
      else if (!hit) ps.notFound = [...ps.notFound, name].slice(-60);
    } catch (e) {
      if (e.kind === 'soft') { drop(); ps.notFound = [...ps.notFound, name].slice(-60); } else ps.lookupRetryAt = Date.now() + RETRY;
    }
  }

  // ---- Torn API jobs during your trip ----
  nextJob(now, trip) {
    const d = this.db.data;
    if (!d.me || d.me.trip !== trip.key) return { kind: 'mystats' };
    if (this.lootingAuto() && (!d.merits || now - d.merits.at >= MERITS_EVERY) && !(d.merits && d.merits.retryAt > now)) return { kind: 'merits' };
    if ((!d.types || !d.types.cruise || now - d.types.at >= TYPES_EVERY) && !(d.types && d.types.retryAt > now)) return { kind: 'types' };
    const ps = this.pasteFor(trip);
    if (ps && ps.lookups.length && !(ps.lookupRetryAt > now)) return { kind: 'lookup', name: ps.lookups[0] };
    let best = null;
    const consider = (pri, job) => { if (!best || pri < best.pri) best = { ...job, pri }; };
    for (const id of this.pool || []) {
      const p = d.players[id];
      if (p && p.retryAt > now) continue;
      if (this.muggedHere(p, trip.country, now)) continue; // mug protected: not checked again for now
      if (p && p.invalid && now - p.at < 86400e3) continue;
      const checked = p && p.tripKey === trip.key ? p.at : 0;
      if (!checked) { consider(-3e12, { kind: 'profile', id }); continue; }
      const near = this.near(p, trip.country);
      if (near) {
        if (!p.job || p.job.trip !== trip.key) { consider(-2e12, { kind: 'job', id }); continue; }
        if (!p.rec || now - p.rec.at >= RECORD_EVERY) { consider(-2e12 + 1, { kind: 'record', id }); continue; }
        // Item market: as overdue as a location check would be (it used to wait for every location check,
        // so with many players near you it never came round).
        if (p.place.kind === 'here' && (!p.trade || now - p.trade.at >= this.marketEvery())) consider(p.trade ? -(now - p.trade.at - this.marketEvery()) : -1e12, { kind: 'trading', id });
      }
      const every = !near ? FAR_EVERY : p.place.kind === 'flying' ? FLYING_EVERY : this.hereEvery();
      const due = every - (now - checked);
      if (due <= 0) consider(due, { kind: 'profile', id });
    }
    return best;
  }

  async runJob(job, trip) {
    this.inFlight = true;
    this.calls.push(Date.now());
    try {
      const run = { mystats: () => this.fetchMyStats(trip), merits: () => this.fetchMerits(), types: () => this.fetchTypes(), profile: () => this.fetchProfile(job.id, trip), job: () => this.fetchJob(job.id, trip), record: () => this.fetchRecord(job.id, trip), trading: () => this.fetchTrading(job.id, trip), lookup: () => this.fetchLookup(job.name, trip) }[job.kind];
      await run();
    } finally {
      this.inFlight = false;
      this.db.save();
      if (job.kind === 'profile') this.updateWatch(trip);
      this.emitSoon();
    }
  }

  player(id) {
    const ps = this.db.data.players;
    return ps[id] || (ps[id] = { id });
  }

  async fetchMyStats(trip) {
    try {
      const d = await this.api.request('/v2/user/battlestats', { soft: [16], priority: 7 });
      const b = d.battlestats || {};
      const v = k => (b[k] && b[k].value) || 0;
      const total = (typeof b.total === 'number' ? b.total : 0) || v('strength') + v('defense') + v('speed') + v('dexterity');
      this.db.data.me = { trip: trip.key, total, strength: v('strength'), defense: v('defense'), speed: v('speed'), dexterity: v('dexterity'), at: Date.now() };
    } catch (e) {
      this.db.data.me = { trip: trip.key, denied: e.kind === 'soft', error: e.message, at: Date.now() };
    }
  }

  async fetchMerits() {
    try {
      const mine = await this.api.request('/v2/user/merits', { soft: [16], priority: 8 });
      const all = await this.api.request('/v2/torn/merits', { soft: [16], priority: 8 });
      const def = ((all && all.merits) || []).find(m => /masterful looting/i.test(m.name || ''));
      const up = def && ((mine && mine.merits && mine.merits.upgrades) || []).find(u => u.id === def.id);
      this.db.data.merits = { looting: def ? (up ? up.level : 0) : null, at: Date.now() };
    } catch (e) {
      this.db.data.merits = { ...(this.db.data.merits || { looting: null, at: 0 }), retryAt: Date.now() + (e.kind === 'soft' ? 86400e3 : RETRY) };
    }
  }

  // Company type ids named like "Clothing Store" (for the 75% cut).
  async fetchTypes() {
    try {
      const d = await this.api.request('/v2/torn/companies', { soft: [16], priority: 8 });
      const ids = [], cruise = [];
      const walk = (o, key) => {
        if (!o || typeof o !== 'object') return;
        if (Array.isArray(o)) { o.forEach(x => walk(x)); return; }
        if (typeof o.name === 'string' && /clothing/i.test(o.name)) { const id = Number(o.id ?? key); if (Number.isFinite(id)) ids.push(id); }
        if (typeof o.name === 'string' && /cruise/i.test(o.name)) { const id = Number(o.id ?? key); if (Number.isFinite(id)) cruise.push(id); }
        for (const [k, v] of Object.entries(o)) if (v && typeof v === 'object') walk(v, k);
      };
      walk(d);
      this.db.data.types = { clothing: [...new Set(ids)], cruise: [...new Set(cruise)], at: Date.now() };
    } catch (e) {
      this.db.data.types = { ...(this.db.data.types || { clothing: [], at: 0 }), retryAt: Date.now() + RETRY };
    }
  }

  async fetchProfile(id, trip) {
    const p = this.player(id);
    const now = Date.now();
    try {
      const d = await this.api.request(`/user/${id}?selections=profile`, { soft: [6, 7], priority: 8 });
      this.emit('profile', id, d);
      const st = d.status || {};
      const same = p.tripKey === trip.key;
      const prev = same ? p.place : null;
      const prevAt = same ? p.at : 0;
      const wasHosp = !!(p.place && p.place.kind === 'hospital');
      if (!same) Object.assign(p, { tripKey: trip.key, awaySince: 0, trade0: null, trade: null, flight: null });
      p.name = d.name || p.name || '';
      p.level = d.level || 0;
      p.age = d.age || 0;
      p.faction = d.faction && d.faction.faction_name ? { id: d.faction.faction_id, name: d.faction.faction_name } : null;
      p.status = { state: st.state || '', description: st.description || '', details: String(st.details || '').replace(/<[^>]*>/g, ''), until: (st.until || 0) * 1000, plane: st.plane_image_type || '' };
      p.life = d.life ? { current: d.life.current, maximum: d.life.maximum } : null;
      p.lastAction = d.last_action ? { status: d.last_action.status || '', at: (d.last_action.timestamp || 0) * 1000 } : null;
      p.invalid = false;
      p.retryAt = 0;
      const inCountry = st.state === 'Abroad' ? placeOf(st).place : '';
      if (inCountry) p.lastIn = inCountry;
      else if (st.state !== 'Hospital') p.lastIn = '';
      p.place = placeOf(st, p.lastIn);
      this.trackFlight(p, prev, prevAt, now);
      // Away from Torn since: the departure we saw, else the first time we saw them away this trip.
      const away = p.place.place && p.place.place !== 'Torn';
      if (away && !p.awaySince) p.awaySince = p.flight && p.flight.departLo ? Math.round((p.flight.departLo + p.flight.departHi) / 2) : now;
      if (!away) p.awaySince = 0;
      // In hospital abroad: maybe mugged, and then what they had left is protected for up to 12 hours.
      // Kept across trips from the first sighting of the stay; a "Mugged by" reason confirms it.
      if (p.place.kind === 'hospital' && p.place.place && p.place.place !== 'Torn' && BY_PLAYER.test(p.status.details)) {
        const h = p.hosp;
        const cont = wasHosp && h && h.place === p.place.place && now - h.seen < SAME_STAY;
        p.hosp = { at: cont ? h.at : now, seen: now, place: p.place.place, text: p.status.details, mugged: /mugg/i.test(p.status.details) || !!(cont && h.mugged) };
      }
      delete p.mugged;
      p.at = now;
      // On the pasted list but no longer in (or flying to) this country: off the list.
      const ps = this.pasteFor(trip);
      if (ps && ps.ids.includes(Number(id)) && !this.near(p, trip.country)) {
        ps.ids = ps.ids.filter(x => x !== Number(id));
        ps.left = [{ id: Number(id), name: p.name, at: now, to: p.place.kind === 'flying' ? p.place.place : (p.place.place || '') }, ...ps.left].slice(0, 30);
        this.pool = null;
      }
    } catch (e) {
      if (e.kind === 'soft') {
        p.invalid = true; p.at = now; p.error = e.message;
        const ps = this.pasteFor(trip);
        if (ps && ps.ids.includes(Number(id))) { ps.ids = ps.ids.filter(x => x !== Number(id)); ps.notFound = [...ps.notFound, `#${id}`].slice(-60); this.pool = null; }
      } else p.retryAt = now + RETRY;
    }
  }

  async fetchJob(id, trip) {
    const p = this.player(id);
    try {
      const d = await this.api.request(`/v2/user/${id}/job`, { soft: [6, 7, 16], priority: 8 });
      const j = d.job || null;
      const types = (this.db.data.types && this.db.data.types.clothing) || [];
      p.job = j && j.type === 'company'
        ? { trip: trip.key, company: j.name || '', typeId: j.type_id, rating: j.rating || 0, clothing: types.includes(Number(j.type_id)), cruise: ((this.db.data.types && this.db.data.types.cruise) || []).includes(Number(j.type_id)) }
        : { trip: trip.key, company: '', job: j ? String(j.name || '') : '', rating: 0, clothing: false };
    } catch (e) {
      if (e.kind === 'soft') p.job = { trip: trip.key, error: e.message }; else p.retryAt = Date.now() + RETRY;
    }
  }

  // Travel record: trips and items bought abroad (all time, per country) and a week ago.
  async fetchRecord(id, trip) {
    const p = this.player(id);
    try {
      const d = await this.api.request(`/v2/user/${id}/personalstats?cat=travel`, { soft: [6, 7, 16], priority: 8 });
      const t = (d.personalstats && d.personalstats.travel) || {};
      const per = {};
      for (const c of COUNTRIES) per[c.name] = Number(t[COUNTRY_STATS[c.code]]) || 0;
      const rec = { trip: trip.key, at: Date.now(), now: { trips: Number(t.total) || 0, items: Number(t.items_bought) || 0, defendsLost: Number(t.defends_lost) || 0, attacksWon: Number(t.attacks_won) || 0 }, per, favourite: '', week: null };
      let n = 0;
      for (const [name, v] of Object.entries(per)) if (v > n) { n = v; rec.favourite = name; }
      try {
        const ts = Math.floor((Date.now() - WEEK) / 1000);
        const w = await this.api.request(`/v2/user/${id}/personalstats?stat=itemsboughtabroad,traveltimes&timestamp=${ts}`, { soft: [6, 7, 16], priority: 9 });
        const then = {};
        for (const x of w.personalstats || []) if (x && x.name) then[x.name] = Number(x.value) || 0;
        if ('itemsboughtabroad' in then || 'traveltimes' in then) rec.week = { items: Math.max(0, rec.now.items - (then.itemsboughtabroad || 0)), trips: Math.max(0, rec.now.trips - (then.traveltimes || 0)) };
      } catch (e) { rec.weekError = e.message; }
      // Fights lost abroad since yesterday (Torn keeps this by day, without the country): a mug is one.
      try {
        const ts = Math.floor((Date.now() - DAY) / 1000);
        const y = await this.api.request(`/v2/user/${id}/personalstats?stat=defendslostabroad&timestamp=${ts}`, { soft: [6, 7, 16], priority: 9 });
        const x = (y.personalstats || []).find(s => s && s.name === 'defendslostabroad');
        if (x) rec.lostAbroad = { n: Math.max(0, rec.now.defendsLost - (Number(x.value) || 0)), since: ts * 1000 };
      } catch (e) { rec.lostError = e.message; }
      p.rec = rec;
    } catch (e) {
      if (e.kind === 'soft') p.rec = { trip: trip.key, at: Date.now(), error: e.message }; else p.retryAt = Date.now() + RETRY;
    }
  }

  // Trading stats. The first reading this trip is the baseline: item market revenue (less fees)
  // added since went into their wallet while they were away.
  async fetchTrading(id, trip) {
    const p = this.player(id);
    try {
      const d = await this.api.request(`/v2/user/${id}/personalstats?cat=trading`, { soft: [6, 7, 16], priority: 8 });
      const t = (d.personalstats && d.personalstats.trading) || {};
      const im = t.item_market || {}, bz = t.bazaar || {};
      const r = { at: Date.now(), revenue: Number(im.revenue) || 0, fees: Number(im.fees) || 0, imSales: Number(im.sales) || 0, bzSales: Number(bz.sales) || 0, bzCustomers: Number(bz.customers) || 0 };
      if (!p.trade0 || p.trade0.trip !== trip.key) p.trade0 = { ...r, trip: trip.key };
      p.trade = r;
    } catch (e) {
      if (e.kind === 'soft') p.trade = { at: Date.now(), error: e.message }; else p.retryAt = Date.now() + RETRY;
    }
  }

  // Landing window for someone flying (as on the War tab): the departure is caught when they switch
  // to Traveling between two checks; flight times from the travel table.
  trackFlight(p, prev, prevAt, now) {
    const st = p.status;
    if (st.state !== 'Traveling') { p.flight = null; return; }
    const t = parseTrip(st.description);
    if (!t || !t.country) { p.flight = null; return; }
    if (!p.flight || p.flight.desc !== st.description) {
      const seen = prev && prev.kind !== 'flying' && prevAt && now - prevAt < 25 * 60e3;
      p.flight = { desc: st.description, departLo: seen ? prevAt : 0, departHi: now };
    }
    const plane = ['private_jet', 'light_aircraft', 'airliner'].includes(st.plane) ? st.plane : '';
    const f = flightRange(t.country, plane, this.store.get('travel.learned') || {});
    p.flight.landLo = p.flight.departLo ? p.flight.departLo + f.lo * 0.75 * 0.97 : 0; // a travel book can cut 25%
    p.flight.landHi = p.flight.departHi + f.hi;
  }

  // ---- Ticks ----
  tick(now) {
    this.mdb.tick(now); // the market database collects whether or not you travel
    const trip = this.trip();
    const d = this.db.data;
    if (trip && (!d.trip || d.trip.key !== trip.key)) { d.trip = { ...trip, startedAt: now }; this.pool = null; this.db.save(); }
    if (!trip) {
      if (this.mdb.watchIds.size) this.mdb.watch([]);
      this.pool = null;
      return;
    }
    // Flying out: the best traders for the country. Landed with a pasted People list: only those people.
    const mode = this.pasteActive(trip) ? 'paste' : 'pool';
    if (!this.pool || this.poolMode !== mode || now - (this.poolAt || 0) > 5 * 60e3) {
      this.pool = mode === 'paste' ? [...this.pasteFor(trip).ids] : this.candidates(trip.country);
      this.poolMode = mode;
      this.poolAt = now;
      this.prune(now);
      this.updateWatch(trip);
    }
    if (!this.api.hasKey() || this.inFlight) return;
    this.calls = this.calls.filter(t => now - t < 60e3);
    if (this.calls.length >= this.rate()) return;
    const job = this.nextJob(now, trip);
    if (job) this.runJob(job, trip).catch(() => {});
  }

  // Re-read the bazaars of the players near you every 5 minutes (the items they hold most of).
  updateWatch(trip) {
    const items = this.mdb.items();
    const want = new Map();
    for (const id of this.pool || []) {
      const p = this.db.data.players[id];
      if (!p || p.tripKey !== trip.key || !this.near(p, trip.country)) continue;
      const info = this.sellerInfo(id, items, trip.country);
      for (const i of info ? info.items.slice(0, 2) : []) want.set(i.id, (want.get(i.id) || 0) + i.q * i.cost);
    }
    this.mdb.watch([...want.entries()].sort((a, b) => b[1] - a[1]).map(e => e[0]));
  }

  prune(now) {
    const keep = new Set((this.pool || []).map(String));
    for (const [id, p] of Object.entries(this.db.data.players)) if (!keep.has(id) && now - (p.at || 0) > PLAYER_KEEP) delete this.db.data.players[id];
  }

  // FFScouter: the players near you this trip (fetched once each; see the top).
  ffIds() {
    const trip = this.trip();
    if (!trip) return [];
    return (this.pool || []).filter(id => { const p = this.db.data.players[id]; return p && p.tripKey === trip.key && this.near(p, trip.country) && !this.muggedHere(p, trip.country); }).slice(0, 150);
  }

  // Check where they are again now (keeps what this trip has learned about them).
  recheck(id) {
    for (const [pid, p] of Object.entries(this.db.data.players)) {
      if (id && Number(pid) !== id) continue;
      if (p.at) p.at = 1;
      p.retryAt = 0;
    }
    this.poolAt = 0;
    this.db.save();
    this.emitSoon();
  }

  emitSoon() {
    if (this.emitTimer) return;
    this.emitTimer = setTimeout(() => { this.emitTimer = null; this.emit('state'); }, 400);
  }

  // ---- For the page ----
  snapshot() {
    const now = Date.now();
    const country = this.location();
    const trip = this.trip();
    const live = this.live();
    const items = this.mdb.items();
    const players = this.db.data.players;
    this.listed = new Set((this.extraIds() || []).map(Number));
    const rows = [];
    const mugged = [];
    const places = {};
    let checked = 0;
    if (live) {
      for (const id of this.pool || []) {
        const p = players[id];
        const pr = this.muggedHere(p, country, now);
        if (pr) { mugged.push({ id, name: p.name || '', level: p.level || 0, at: pr.at, ends: pr.ends, text: pr.text, inHospital: pr.now }); continue; }
        if (!p || p.tripKey !== trip.key || !p.at) continue;
        checked++;
        if (p.place && p.place.place && p.place.place !== 'Torn') {
          const k = `${p.place.place}${p.place.kind === 'flying' ? '|flying' : ''}`;
          places[k] = (places[k] || 0) + 1;
        }
        if (!this.near(p, country)) continue;
        const info = this.sellerInfo(id, items, country, now);
        const rec = p.rec && !p.rec.error ? p.rec : null;
        rows.push(this.row(id, p, info, rec, this.cashNow(p, info, rec, country, items), country, true));
      }
    } else {
      for (const id of this.candidates(country).slice(0, 40)) {
        const p = players[id] || null;
        rows.push(this.row(id, p, this.sellerInfo(id, items, country, now), this.record(id), null, country, false));
      }
    }
    rows.sort((a, b) => b.score.total - a.score.total);
    return {
      country, live, trip,
      choice: String(this.store.get('mugger.location') || 'auto'),
      db: { ...this.mdb.stats(), scan: this.mdb.scan, remote: this.mdb.remote(), watching: [...this.mdb.watchIds].map(i => (items.get(i) || {}).name || `#${i}`) },
      pool: (this.pool || []).length, checked, places, rows, mugged: mugged.sort((a, b) => b.at - a.at),
      poolMode: live ? this.poolMode || 'pool' : 'pool',
      paste: (() => {
        const ps = trip ? this.pasteFor(trip) : null;
        if (!ps) return null;
        return { count: ps.ids.length, active: this.pasteActive(trip), at: ps.at, lookups: ps.lookups.length, notFound: ps.notFound.slice(-8), notFoundCount: ps.notFound.length, left: ps.left.slice(0, 6), leftCount: ps.left.length, traders: ps.ids.filter(id => this.mdb.seller(id)).length };
      })(),
      me: this.db.data.me,
      mug: { looting: this.looting(), lootingAuto: this.lootingAuto(), merits: this.db.data.merits, plunder: this.plunder(), mult: this.mult() },
      settings: { minCost: this.minCost(), pool: this.poolSize(), rate: this.rate(), here: this.hereEvery() / 60e3, market: this.marketEvery() / 60e3, looting: this.lootingAuto() ? 'auto' : this.looting(), plunder: this.plunder() },
      countries: COUNTRIES.map(c => c.name),
    };
  }

  row(id, p, info, rec, cash, country, live) {
    const pt = this.perTrip(rec, p);
    const restock = info && info.ev.filter(e => e.dq > TRADE_QTY).slice(-1)[0];
    return {
      id, name: (p && p.name) || (info && info.name) || '', live,
      level: p ? p.level : 0, age: p ? p.age : 0, faction: p ? p.faction : null,
      status: live ? p.status : null, place: live ? p.place : null, flight: live ? p.flight : null,
      life: live ? p.life : null, lastAction: live ? p.lastAction : null, checkedAt: live ? p.at : 0,
      awaySince: live ? p.awaySince : 0, protect: live ? this.protection(p, country) : null, job: p ? p.job : null,
      listed: this.listed.has(id),
      market: info && {
        items: info.items.slice(0, 8), small: info.small.slice(0, 6), small30: info.small30, spec: info.spec.slice(0, 4), specCustomers: info.specCustomers, busiest: info.busiest, income: info.income, bulk: info.bulk, bazaar: info.bazaar, value: info.value, listed: info.listed, r30: info.r30, rc30: info.rc30, s30: info.s30, sv30: info.sv30,
        active: info.active, days: info.days, first: info.first, ev: info.ev, sellsHere: info.sellsHere, rc30Here: info.rc30Here, r30Here: info.r30Here,
        lastRestock: restock ? { ...restock, trips: pt && pt.n ? restock.dq / pt.n : null } : null,
      },
      rec, perTrip: pt, tripCash: this.tripCash(info, rec, country, p), tripUnknown: this.tripUnknown(info, country), cash, take: live ? this.mugTake(cash, p) : null,
      trade: live && p.trade && !p.trade.error ? { since: p.trade0 ? p.trade0.at : 0, at: p.trade.at } : null,
      ...(() => { const sc = this.score(info, rec, cash, country); return { score: sc.here, overall: sc.all }; })(),
    };
  }

  flush() { this.db.flush(); }
}

module.exports = { MuggerFeature, placeOf, myTrip, MUG, parsePeople };

  },
  "features/muggerdb.js": function (module, exports, require) {
'use strict';
// Mugger's market database: who sells abroad items in their bazaars, and how their stock moves.
// Runs on the Mentat server around the clock (data set "mugger", pulled by the apps), or on a device
// that has no server copy. Keeps 90 days (the user's request, 2026-11-24).
//
// Source: Weav3r (https://weav3r.dev, no key), one request per 100 bazaar listings of an item:
// GET /api/marketplace/{itemId}[?page=N] -> 100 bazaars a page, cheapest first: { listings: [{ player_id,
// player_name, quantity, price, content_updated, last_checked }], total_count, has_more }. Weav3r
// re-checks each bazaar every 5-15 minutes. Its docs (TornW3B API, pasted by the user 2026-11-25): full
// listings are limited per IP to 10 a minute, or 25 with a registered Torn key (X-API-Key header; an
// unknown key gets 401); over the limit it answers 429 with Retry-After, or (as seen) the 10-row "filler"
// shape without sellers. The server sends its own key (registered there by the user, who OK'd sending it
// to weav3r.dev) and reads every page; without a key: one page per item, slower. A list that isn't
// complete (more pages unread, or an answer without sellers) never marks anyone as sold out.
// Every 30 minutes this reads every abroad shop item (YATA's list, via the travel feature) that costs
// at least $50,000 abroad: one request every 6 s with the key (in practice it still switched to sellerless
// answers at one per 3 s, 2026-11-25), every 7 s without; a sellerless answer slows the pace by half (up to
// 20 s, remembered), clean passes speed it back up.
//
// Per seller:  n name · f first seen · l last seen listing anything
//   items { itemId: [quantity, price, contentUpdated, seenAt] }   what they list now
//   days  { 'YYYY-MM-DD' (UTC): { itemId: [restockUnits, restockCost, soldUnits, soldValue, smallRestockUnits] } }
//         90 days, per item (so scores can be per country); restocks of 5 or fewer go only in
//         smallRestockUnits. Days kept before 2026-11-25 hold one total for all items (dayItems: item 0).
//         restockCost = units × abroad shop price; soldValue = units × their price (at most 3× the
//         abroad price: some bazaars "list" at prices nobody pays, e.g. a $20B Jackhammer)
//   ev    [[time, itemId, quantityChange, price, gone?]]   the last 3 days, for "sold since they left"
// A restock is a quantity going up by more than TRADE_QTY between two readings. Players put several trips' worth in at once,
// so a restock is NOT one trip (mugger.js divides by their items per trip).
//
// Torn's bazaar directories (with the collector's own key: the server's, or yours without a server),
// every 12 hours: /v2/market/{item}/bazaar for each of those items (the top 10 bazaars specialising in
// it, with weekly customers; checked 2026-11-25: Xanax had 10, 32-4,050 customers a week) and
// /v2/market/bazaar (weekly top-10 lists: busiest, top grossing, bulk …). Bazaar ids are their owners'
// player ids. About 73 calls per 12 hours, at the lowest priority.
//
// The device also "watches" a few items while you are abroad (the items the players near you sell),
// reading them every 5 minutes; those readings live in memory (`live`) on top of the database, so a
// server copy arriving doesn't hide them.

const path = require('path');
const { EventEmitter } = require('events');
const { Store } = require('../store');

const WEAV3R = 'https://weav3r.dev/api/marketplace';
const COLLECT_MIN = 50000;
const SCAN_EVERY = 30 * 60e3;
const GAP = 7000; // without a key (Weav3r: 10 a minute)
const GAP_KEY = 6000; // with the registered key (Weav3r says 25 a minute; 20 was too many in practice)
const GAP_MAX = 20000; // the slowest the learned pace goes
const MAX_PAGES = 4; // 400 bazaars: Xanax has ~240
const KEY_OFF = 3600e3; // Weav3r didn't know the key: go without it for an hour
const DIR_EVERY = 12 * 3600e3;
const ANON_PAUSE = 2 * 60e3; // Weav3r answered without sellers: wait, try once more, else stop this scan
const LIMIT_PAUSE = 60e3;
const LIMIT_TRIES = 3;
const KEEP_DAYS = 90;
const EV_KEEP = 3 * 86400e3;
const WATCH_EVERY = 5 * 60e3;
const WATCH_MAX = 10;
const PRICE_CAP = 3;
// Selling one or two of an item is no sign of trips (the user's rule, 2026-11-24): only more than 5 of
// an item counts as trading (stock now, a restock). Smaller ones are still recorded and shown, just not
// counted. Sales of any size still count as cash on hand.
const TRADE_QTY = 5;

const sleep = ms => new Promise(r => setTimeout(r, ms));
const dayKey = t => new Date(t).toISOString().slice(0, 10);

async function getJson(url, key = '') {
  const headers = { Accept: 'application/json', 'User-Agent': 'Mentat' };
  if (key) headers['X-API-Key'] = key;
  const res = await fetch(url, { signal: AbortSignal.timeout(20000), headers });
  if (res.status === 429) throw Object.assign(new Error('Weav3r rate limit reached'), { retryAfter: Number(res.headers && res.headers.get ? res.headers.get('retry-after') : 0) || 0 });
  if (res.status === 401 && key) throw Object.assign(new Error('Weav3r does not know the key'), { badKey: true });
  if (!res.ok) throw new Error(`Weav3r returned HTTP ${res.status}`);
  return res.json();
}

// Abroad shop items from the travel feature: id -> { id, name, cost (cheapest), countries }.
function abroadItems(travel) {
  const out = new Map();
  for (const c of (travel && travel.state.countries) || []) {
    for (const i of c.items || []) {
      if (!(i.cost > 0)) continue;
      const e = out.get(i.id) || { id: i.id, name: i.name, cost: i.cost, countries: [] };
      e.cost = Math.min(e.cost, i.cost);
      if (!e.countries.includes(c.name)) e.countries.push(c.name);
      out.set(i.id, e);
    }
  }
  return out;
}

class MuggerDb extends EventEmitter {
  constructor({ dataDir, travel, api = null, key = () => '', log = () => {} }) {
    super();
    this.key = key; // the registered Torn key for Weav3r (the server's own; '' elsewhere)
    this.keyOffUntil = 0;
    this.gapKey = GAP_KEY;
    this.api = api; // Torn API for the bazaar directories (server key, or yours without a server)
    this.dirBusy = false;
    this.dirIndex = null; // pid -> { spec: { itemId: weeklyCustomers }, name, busiest, income, bulk }
    this.travel = travel;
    this.log = log;
    this.db = new Store(path.join(dataDir, 'mugger-db.json'), { v: 1, lastScan: 0, scans: [], itemsSeen: [], sellers: {}, dir: { at: 0, items: {}, weekly: null } }, { debounceMs: 60000 });
    this.remote = () => false; // a Mentat server collects instead (set by core.js)
    // A Mentat server is set up: it reads the directories with its own key, so a member's device never
    // spends theirs on it, even before the server's copy has arrived (core.js).
    this.useServer = () => false;
    this.gap = GAP; // between Weav3r requests (tests set 0)
    this.scan = { running: false, done: 0, total: 0, error: '' };
    this.lastReq = 0;
    this.busy = Promise.resolve();
    this.limits = 0;
    this.watchIds = new Set();
    this.watchAt = {};
    this.live = {}; // pid -> { items: { id: [q, p, upd, seen] }, ev: [...] } from watched items
  }

  items() { return abroadItems(this.travel); }

  // One Weav3r request at a time, at least `gap` apart (scans and watches share it).
  keyNow() { return Date.now() >= this.keyOffUntil ? String(this.key() || '') : ''; }
  // The pace: the base gap, or slower if Weav3r has answered without sellers lately (db.data.pace).
  gapNow() {
    const base = this.keyNow() ? this.gapKey : this.gap;
    return base ? Math.max(base, Math.min(GAP_MAX, Number(this.db.data.pace) || 0)) : 0;
  }
  slower() { if (this.gap) { this.db.data.pace = Math.min(GAP_MAX, Math.round(this.gapNow() * 1.5)); this.db.save(); } }
  faster() { if (this.db.data.pace) { const p = Math.round(this.db.data.pace * 0.9); this.db.data.pace = p <= (this.keyNow() ? this.gapKey : this.gap) ? 0 : p; this.db.save(); } }

  request(url) {
    const run = async () => {
      const wait = this.lastReq + this.gapNow() - Date.now();
      if (wait > 0) await sleep(wait);
      for (;;) {
        this.lastReq = Date.now();
        const key = this.keyNow();
        try { return await getJson(url, key); } catch (e) {
          if (e.badKey) { this.keyOffUntil = Date.now() + KEY_OFF; this.log('Mugger: Weav3r does not know the server key (register it at weav3r.dev); reading without it for an hour.'); continue; }
          if (!/rate limit/i.test(e.message) || ++this.limits > LIMIT_TRIES) throw e;
          this.scan.error = 'Weav3r asked to slow down; waiting';
          this.emit('state');
          await sleep(this.gap ? Math.max(LIMIT_PAUSE, (e.retryAfter || 0) * 1000) : 0);
          this.scan.error = '';
        }
      }
    };
    const p = this.busy.then(run, run);
    this.busy = p.catch(() => {});
    return p;
  }

  // One item's bazaars, cheapest first: every page with the key, the first 100 without. complete = all of
  // them were read. Listings without a seller (an answer in the anonymous shape) are left out, and then
  // the list doesn't count as complete either.
  async readItem(id) {
    const listings = [];
    const pages = this.keyNow() ? MAX_PAGES : 1;
    for (let page = 1; page <= pages; page++) {
      if (page > 1 && !this.keyNow()) return { listings, complete: false }; // the key went off: first page only
      const d = await this.request(page === 1 ? `${WEAV3R}/${id}` : `${WEAV3R}/${id}?page=${page}`);
      const all = Array.isArray(d.listings) ? d.listings : [];
      const mine = all.filter(l => Number(l.player_id) > 0);
      listings.push(...mine);
      if (all.length && !mine.length) return { listings, anon: page === 1, complete: false };
      if (mine.length !== all.length || d.has_more === undefined) return { listings, complete: false };
      if (!d.has_more) return { listings, complete: true };
    }
    return { listings, complete: false };
  }

  // ---- The 30-minute scan ----
  async runScan() {
    const items = [...this.items().values()].filter(i => i.cost >= COLLECT_MIN).sort((a, b) => b.cost - a.cost);
    const scan = this.scan = { running: true, done: 0, total: items.length, error: '', startedAt: Date.now() };
    this.limits = 0;
    this.db.data.lastScan = Date.now();
    this.emit('state');
    const sellers = this.db.data.sellers;
    const known = new Set(this.db.data.itemsSeen || []);
    const started = Date.now();
    let errors = 0, listings = 0;
    let anonStop = false, slowed = 0;
    for (const item of items) {
      if (anonStop) break;
      try {
        let r = await this.readItem(item.id);
        if (r.anon) {
          // No sellers in the answer: over Weav3r's limit. Slow down, wait, try once more, else stop.
          this.slower();
          slowed++;
          scan.error = 'Weav3r is answering without sellers; slowing down and waiting 2 minutes';
          this.emit('state');
          await sleep(this.gap ? ANON_PAUSE : 0);
          r = await this.readItem(item.id);
          if (r.anon) { this.slower(); scan.error = 'Weav3r answered without sellers: stopped this read, trying again at the next one'; errors++; anonStop = true; }
          else scan.error = '';
        }
        for (const l of r.listings) this.record(sellers, item, l, { known: known.has(item.id), started });
        listings += r.listings.length;
        if (r.complete) {
          this.sweep(sellers, item, started);
          known.add(item.id);
        }
      } catch (e) {
        errors++;
        scan.error = e.name === 'TimeoutError' ? 'Weav3r timed out' : e.message || 'Could not reach Weav3r';
        if (/rate limit/i.test(scan.error)) break; // the next scan tries again
      }
      scan.done++;
      if (scan.done % 5 === 0) this.emit('state');
    }
    this.prune(Date.now());
    this.db.data.itemsSeen = [...known];
    this.db.data.scans = [...(this.db.data.scans || []), { at: started, took: Date.now() - started, items: scan.done, of: items.length, listings, sellers: Object.keys(sellers).length, errors, pace: Math.round(this.gapNow() / 1000) }].slice(-60);
    this.db.save();
    scan.running = false;
    if (anonStop) this.log && this.log(`Mugger: Weav3r answered without sellers; stopped this read, trying again in 30 minutes (pace now ${Math.round(this.gapNow() / 1000)} s).`);
    else if (!slowed) this.faster();
    else this.log && this.log(`Mugger: Weav3r asked for a slower pace; now one request every ${Math.round(this.gapNow() / 1000)} s.`);
    if (!errors) scan.error = '';
    this.emit('state');
    this.emit('scanned');
  }

  // A complete list without someone who had this item: it sold out (or was taken down).
  sweep(sellers, item, started) {
    for (const s of Object.values(sellers)) {
      const it = s.items[item.id];
      if (it && it[3] < started) {
        if (it[0] > 0) this.change(s, Date.now(), item, -it[0], it[1], 1);
        delete s.items[item.id];
      }
    }
  }

  // One listing { player_id, player_name, quantity, price, content_updated }.
  record(sellers, item, l, { known, started }) {
    const pid = Number(l.player_id);
    if (!pid) return;
    const now = Date.now();
    const s = sellers[pid] || (sellers[pid] = { n: '', f: now, l: now, items: {}, days: {}, ev: [] });
    s.n = l.player_name || s.n;
    s.l = now;
    const upd = (Number(l.content_updated) || 0) * 1000;
    const q = Number(l.quantity) || 0, p = Number(l.price) || 0;
    const it = s.items[item.id];
    if (it && it[0] !== q) this.change(s, upd > it[2] ? upd : now, item, q - it[0], p || it[1]);
    // A seller we knew adding an item we've read before: a restock (a new seller's stock isn't one).
    else if (!it && known && s.f < started && q > 0) this.change(s, upd || now, item, q, p);
    s.items[item.id] = [q, p, upd, now];
    if (q > 0) noteHistory(s, item.id, now, q);
  }

  change(s, t, item, dq, price, gone = 0) {
    s.ev.push([t, item.id, dq, price, gone]);
    let day = s.days[dayKey(t)];
    if (!day) day = s.days[dayKey(t)] = {};
    else if (Array.isArray(day)) day = s.days[dayKey(t)] = { 0: day }; // an old all-items total
    const d = day[item.id] || (day[item.id] = [0, 0, 0, 0, 0]);
    if (dq > TRADE_QTY) { d[0] += dq; d[1] += dq * item.cost; } else if (dq > 0) { d[4] = (d[4] || 0) + dq; } else { d[2] += -dq; d[3] += -dq * Math.min(price, item.cost * PRICE_CAP); }
  }

  prune(now) {
    const oldest = dayKey(now - KEEP_DAYS * 86400e3);
    for (const [pid, s] of Object.entries(this.db.data.sellers)) {
      s.ev = s.ev.filter(e => now - e[0] < EV_KEEP);
      for (const k of Object.keys(s.days)) if (k < oldest) delete s.days[k];
      for (const [id, h] of Object.entries(s.h || {})) if (now - h[1] > KEEP_DAYS * 86400e3) delete s.h[id];
      if (!Object.keys(s.items).length && !Object.keys(s.days).length && !Object.keys(s.h || {}).length) delete this.db.data.sellers[pid];
    }
  }

  // ---- Watched items (while you're abroad) ----
  watch(ids) {
    this.watchIds = new Set([...ids].map(Number).filter(Boolean).slice(0, WATCH_MAX));
  }

  async readWatched(item) {
    this.watchAt[item.id] = Date.now();
    try {
      const r = await this.readItem(item.id);
      const started = this.watchAt[item.id];
      const seen = new Set();
      for (const l of r.listings) {
        const pid = Number(l.player_id);
        if (!pid) continue;
        seen.add(pid);
        const base = this.db.data.sellers[pid];
        const lv = this.live[pid] || (this.live[pid] = { items: {}, ev: [] });
        const prev = lv.items[item.id] || (base && base.items[item.id]);
        const q = Number(l.quantity) || 0, p = Number(l.price) || 0, upd = (Number(l.content_updated) || 0) * 1000;
        if (prev && prev[0] !== q) lv.ev.push([upd > prev[2] ? upd : Date.now(), item.id, q - prev[0], p || prev[1], 0]);
        lv.items[item.id] = [q, p, upd, Date.now()];
      }
      if (r.complete) {
        for (const [pid, lv] of Object.entries(this.live)) {
          const prev = lv.items[item.id];
          if (prev && prev[3] < started && !seen.has(Number(pid))) {
            if (prev[0] > 0) lv.ev.push([Date.now(), item.id, -prev[0], prev[1], 1]);
            delete lv.items[item.id];
          }
        }
        // Someone who had it in the database and not now.
        for (const [pid, s] of Object.entries(this.db.data.sellers)) {
          if (!s.items[item.id] || seen.has(Number(pid)) || (this.live[pid] && (this.live[pid].ev.some(e => e[1] === item.id && e[4]) || this.live[pid].items[item.id]))) continue;
          const lv = this.live[pid] || (this.live[pid] = { items: {}, ev: [] });
          if (s.items[item.id][0] > 0) lv.ev.push([Date.now(), item.id, -s.items[item.id][0], s.items[item.id][1], 1]);
        }
      }
      this.emit('live');
    } catch (e) { /* tried again in 5 minutes */ }
  }

  // ---- Reading ----
  // A seller's listings and recent changes: the database with the watched readings on top.
  seller(pid) {
    const s = this.db.data.sellers[pid];
    const lv = this.live[pid];
    const dir = this.dirOf(pid);
    if (!s && !lv && !dir) return null;
    const items = { ...(s ? s.items : {}), ...(lv ? lv.items : {}) };
    const now = Date.now();
    // A change both the watch and a scan saw (same item and amount within 30 minutes) counts once.
    const base = s ? s.ev : [];
    const extra = lv ? lv.ev.filter(e => now - e[0] < EV_KEEP && !base.some(b => b[1] === e[1] && b[2] === e[2] && Math.abs(b[0] - e[0]) < 30 * 60e3)) : [];
    const ev = [...base, ...extra].sort((a, b) => a[0] - b[0]);
    if (s && !s.h) backfillHistory(s);
    return { name: s ? s.n : '', first: s ? s.f : 0, items, days: s ? s.days : {}, ev, dir, h: s ? s.h : {} };
  }

  sellerIds() { return [...new Set([...Object.keys(this.db.data.sellers), ...Object.keys(this.index())].map(Number))]; }

  // ---- Torn's bazaar directories ----
  index() {
    if (this.dirIndex) return this.dirIndex;
    const out = {};
    const d = this.db.data.dir || {};
    const at = pid => out[pid] || (out[pid] = { spec: {}, name: '', busiest: 0, income: 0, bulk: 0 });
    for (const [id, x] of Object.entries(d.items || {})) for (const [pid, customers, , name] of x.list || []) { const e = at(pid); e.spec[id] = customers; e.name = e.name || name; }
    const w = d.weekly;
    if (w) for (const [k, field] of [['busiest', 'busiest'], ['top_grossing', 'income'], ['bulk', 'bulk']]) for (const [pid, n, name] of w[k] || []) { const e = at(pid); e[field] = n; e.name = e.name || name; }
    return (this.dirIndex = out);
  }
  dirOf(pid) { return this.index()[pid] || null; }

  // Trader names (lower case) -> player id, from the listings and the directories; rebuilt every 10 minutes.
  nameIndex() {
    if (this.nameIdx && Date.now() - this.nameIdxAt < 10 * 60e3) return this.nameIdx;
    const m = new Map();
    for (const [pid, e] of Object.entries(this.index())) if (e && e.name) m.set(String(e.name).toLowerCase(), Number(pid));
    for (const [pid, s] of Object.entries(this.db.data.sellers || {})) if (s && s.n) m.set(String(s.n).toLowerCase(), Number(pid));
    this.nameIdx = m;
    this.nameIdxAt = Date.now();
    return m;
  }

  async readDirectories() {
    this.dirBusy = true;
    const d = this.db.data.dir || (this.db.data.dir = { at: 0, items: {}, weekly: null });
    d.at = Date.now(); // also stops a second run while this one goes
    try {
      const items = [...this.items().values()].filter(i => i.cost >= COLLECT_MIN);
      const fresh = {};
      for (const item of items) {
        try {
          const r = await this.api.request(`/v2/market/${item.id}/bazaar`, { soft: [6, 7, 16], priority: 9 });
          const list = ((r.bazaar && r.bazaar.specialized) || []).map(b => [Number(b.id), Number(b.weekly_customers) || 0, !!b.is_open, String(b.name || '')]).filter(b => b[0] > 0);
          fresh[item.id] = { at: Date.now(), list };
        } catch (e) { if (e.kind === 'paused' || e.kind === 'nokey' || e.kind === 'key') throw e; }
      }
      if (Object.keys(fresh).length) d.items = fresh;
      const w = await this.api.request('/v2/market/bazaar', { soft: [6, 7, 16], priority: 9 });
      const b = w.bazaar || {};
      const rows = (list, field) => (list || []).map(x => [Number(x.id), Number(x[field]) || 0, String(x.name || '')]).filter(x => x[0] > 0);
      d.weekly = { at: Date.now(), busiest: rows(b.busiest, 'weekly_customers'), top_grossing: rows(b.top_grossing, 'weekly_income'), bulk: rows(b.bulk, 'bulk_sales') };
      this.dirIndex = null;
      this.db.save();
      this.emit('state');
    } catch (e) {
      d.at = Date.now() - DIR_EVERY + 30 * 60e3; // try again in 30 minutes
    } finally {
      this.dirBusy = false;
    }
  }

  stats() {
    const ds = new Set();
    for (const s of Object.values(this.db.data.sellers)) for (const k of Object.keys(s.days)) ds.add(k);
    const scans = this.db.data.scans || [];
    const dir = this.db.data.dir || {};
    return { dirAt: dir.at || 0, dirBazaars: Object.keys(this.index()).length, sellers: Object.keys(this.db.data.sellers).length, days: ds.size, oldest: [...ds].sort()[0] || '', lastScan: this.db.data.lastScan || 0, last: scans[scans.length - 1] || null };
  }

  // ---- Ticks ----
  tick(now) {
    const haveItems = this.travel && this.travel.state.countries.some(c => c.items && c.items.length);
    if (!haveItems) return;
    if (!this.remote() && !this.scan.running && now - (this.db.data.lastScan || 0) >= SCAN_EVERY) {
      this.runScan().catch(e => { this.scan.running = false; this.scan.error = e.message; this.log('Mugger scan:', e.message); });
    }
    const dir = this.db.data.dir || {};
    if (this.api && this.api.hasKey() && !this.remote() && !this.useServer() && !this.dirBusy && now - (dir.at || 0) >= DIR_EVERY) this.readDirectories().catch(() => { this.dirBusy = false; });
    if (this.watchIds.size && !this.watching) {
      const items = this.items();
      const due = [...this.watchIds].map(id => items.get(id)).filter(i => i && now - (this.watchAt[i.id] || 0) >= WATCH_EVERY);
      if (due.length) {
        this.watching = true;
        (async () => { for (const i of due) await this.readWatched(i); })().finally(() => { this.watching = false; });
      }
    }
  }

  // The server's copy replaces this device's (the server collects around the clock).
  applyRemote(data) {
    if (!data || typeof data !== 'object' || !data.sellers) return;
    this.db.data = { v: 1, lastScan: 0, scans: [], itemsSeen: [], dir: { at: 0, items: {}, weekly: null }, ...data };
    this.dirIndex = null;
    this.db.save();
    this.emit('state');
  }

  flush() { this.db.flush(); }
}

// ---- Analysis shared by the app (mugger.js), the server's route for the Mugger userscript, and
// (copied) the userscript itself ----
const clamp = x => Math.max(0, Math.min(1, Number.isFinite(x) ? x : 0));
const log10 = x => (x > 0 ? Math.log10(x) : 0);

function traderInfo(s, items, country, minCost, now = Date.now()) {
  if (!s) return null;
  const here = id => { const m = items.get(Number(id)); return !!m && m.countries.includes(country); };
  const list = [], small = [];
  let value = 0, valueHere = 0, units = 0, listed = 0;
  for (const [id, it] of Object.entries(s.items)) {
    const meta = items.get(Number(id));
    if (!meta || !(it[0] > 0) || meta.cost < minCost) continue;
    // 5 or fewer: shown, but not counted as trading.
    if (it[0] <= TRADE_QTY) { small.push({ id: Number(id), name: meta.name, q: it[0], price: it[1], cost: meta.cost, countries: meta.countries, upd: it[2], small: true }); continue; }
    value += it[0] * meta.cost;
    if (meta.countries.includes(country)) valueHere += it[0] * meta.cost;
    listed += it[0] * it[1];
    units += it[0];
    list.push({ id: Number(id), name: meta.name, q: it[0], price: it[1], cost: meta.cost, countries: meta.countries, upd: it[2] });
  }
  list.sort((a, b) => b.q * b.cost - a.q * a.cost);
  // The last 30 days, per item (item 0 = totals from before they were kept per item: overall only).
  const from30 = dayKey(now - 30 * 86400e3);
  let r30 = 0, rc30 = 0, s30 = 0, sv30 = 0, small30 = 0, rc30Here = 0, r30Here = 0, active = 0, days = 0;
  for (const [k, day] of Object.entries(s.days || {})) {
    days++;
    if (k < from30) continue;
    let any = false;
    for (const [id, d] of Object.entries(dayItems(day))) {
      r30 += d[0]; rc30 += d[1]; s30 += d[2]; sv30 += d[3]; small30 += d[4] || 0;
      if (d[0] || d[2]) any = true;
      if (Number(id) && here(id)) { rc30Here += d[1]; r30Here += d[0]; }
    }
    if (any) active++;
  }
  // Torn's bazaar directory: abroad items their bazaar specialises in (weekly customers), weekly lists.
  const dir = s.dir || null;
  const spec = [];
  for (const [id, customers] of Object.entries((dir && dir.spec) || {})) {
    const meta = items.get(Number(id));
    if (meta && meta.cost >= minCost) spec.push({ id: Number(id), name: meta.name, customers, cost: meta.cost, countries: meta.countries });
  }
  spec.sort((a, b) => b.customers - a.customers);
  const specCustomers = spec.reduce((a, x) => a + x.customers, 0);
  const specHere = spec.filter(x => x.countries.includes(country)).reduce((a, x) => a + x.customers, 0);
  const sellsHere = list.some(i => i.countries.includes(country)) || spec.some(i => i.countries.includes(country));
  // Every change is listed; restocks of 5 or fewer are marked small (not counted as trips).
  const ev = (s.ev || []).slice(-15).map(e => { const m = items.get(e[1]); return { at: e[0], id: e[1], name: m ? m.name : `#${e[1]}`, dq: e[2], price: e[3], cost: m ? m.cost : 0, gone: !!e[4], small: e[2] > 0 && e[2] <= TRADE_QTY, here: !!m && m.countries.includes(country) }; });
  return {
    name: s.name || (dir && dir.name) || '', bazaar: dir ? dir.name : '', spec, specCustomers, specHere,
    busiest: dir ? dir.busiest : 0, income: dir ? dir.income : 0, bulk: dir ? dir.bulk : 0, first: s.first,
    items: list, small, value, valueHere, listed, units, r30, rc30, r30Here, rc30Here, s30, sv30, small30, active, days, sellsHere, ev, raw: s,
    hist: tradeHistory(s, items),
  };
}
// Every abroad item a seller has listed in the last 90 days (from 2026-11-25): s.h = { itemId: [firstSeen,
// lastSeen, mostListed] }. What they trade from a country is judged from this, their restocks and Torn's
// bazaar directory, not only what's in their bazaar right now (the user's rule, 2026-11-25).
function noteHistory(s, id, t, q) {
  const hs = s.h || (s.h = {});
  const h = hs[id];
  hs[id] = h ? [Math.min(h[0], t), Math.max(h[1], t), Math.max(h[2], q)] : [t, t, q];
}
// Sellers saved before s.h existed: fill it from what's kept (listings now, per-item days, recent changes).
function backfillHistory(s) {
  if (s.h) return;
  s.h = {};
  for (const [id, it] of Object.entries(s.items || {})) if (it[0] > 0) noteHistory(s, Number(id), it[3] || it[2] || s.l || Date.now(), it[0]);
  for (const [k, day] of Object.entries(s.days || {})) {
    const t = Date.parse(`${k}T12:00:00Z`) || Date.now();
    for (const [id, d] of Object.entries(dayItems(day))) if (Number(id) && (d[0] || d[2])) noteHistory(s, Number(id), t, Math.max(d[0], d[2]));
  }
  for (const e of s.ev || []) if (e[2]) noteHistory(s, e[1], e[0], Math.abs(e[2]));
}
// What a seller has traded, item by item: the most they've listed at once and their restocks (90 days).
// Only more than TRADE_QTY counts as trading (the user's rule, 2026-11-24).
function tradeHistory(s, items) {
  const out = new Map();
  for (const [id, h] of Object.entries(s.h || {})) out.set(Number(id), { most: h[2], restocked: 0, last: h[1] });
  for (const [k, day] of Object.entries(s.days || {})) {
    for (const [id, d] of Object.entries(dayItems(day))) {
      if (!Number(id) || !d[0]) continue;
      const e = out.get(Number(id)) || { most: 0, restocked: 0, last: 0 };
      e.restocked += d[0];
      out.set(Number(id), e);
    }
  }
  const list = [];
  for (const [id, e] of out) {
    const m = items.get(id);
    if (!m || (e.most <= TRADE_QTY && !e.restocked)) continue;
    list.push({ id, name: m.name, cost: m.cost, countries: m.countries, q: Math.max(e.most, e.restocked), last: e.last });
  }
  return list.sort((a, b) => b.q - a.q);
}
// A day's totals by item: { itemId: [restockUnits, restockCost, soldUnits, soldValue, smallRestockUnits] }.
// Days saved before 2026-11-25 hold one total for all items: item 0.
const dayItems = day => (Array.isArray(day) ? { 0: day } : day || {});

// Two scores (the user's request, 2026-11-25), each 0-100:
// For this country: Trading (up to 30): restocks in the last 30 days of items sold here, at abroad prices,
//   per week ($1M = 0 … $1B = 30). Stock (10): those items in their bazaar now. Bazaar activity (10):
//   weekly customers in Torn's bazaar directory for items sold here they specialise in (2,000 = 10).
//   Fits here (15): sells or specialises in something sold here (15), else it's where they travel most
//   (10), else they have trips here (5). Travel (15): items bought abroad last week × their share of
//   trips that go here (1,500 = 15). Cash (20): estimated cash on hand ($1M = 0 … $1B = 20), while you're there.
// Overall: the same parts over every abroad item (the busiest-bazaars list counts too), without fit,
//   scaled from 85 to 100.
function scores(info, rec, cash, country) {
  const H = { trading: 0, stock: 0, activity: 0, fit: 0, travel: 0, cash: 0 };
  const A = { trading: 0, stock: 0, activity: 0, travel: 0, cash: 0 };
  const per = rec && rec.per ? rec.per : null;
  const tripsHere = per ? per[country] || 0 : 0;
  if (info) {
    H.trading = 30 * clamp((log10(info.rc30Here / (30 / 7)) - 6) / 3);
    H.stock = 10 * clamp((log10(info.valueHere) - 6) / 3);
    H.activity = 10 * clamp(log10(1 + (info.specHere || 0)) / log10(2001));
    A.trading = 30 * clamp((log10(info.rc30 / (30 / 7)) - 6) / 3);
    A.stock = 10 * clamp((log10(info.value) - 6) / 3);
    const abroad = info.items.length || (info.spec && info.spec.length);
    A.activity = 10 * clamp(log10(1 + Math.max(info.specCustomers || 0, abroad ? info.busiest || 0 : 0)) / log10(2001));
  }
  H.fit = info && info.sellsHere ? 15 : rec && rec.favourite === country ? 10 : tripsHere > 0 ? 5 : 0;
  if (rec && rec.week) {
    const share = per && rec.now && rec.now.trips > 0 ? tripsHere / rec.now.trips : 0;
    H.travel = 15 * clamp(log10(1 + rec.week.items * share) / log10(1501));
    A.travel = 15 * clamp(log10(1 + rec.week.items) / log10(1501));
  }
  if (cash) H.cash = A.cash = 20 * clamp((log10(cash.total) - 6) / 3);
  const sum = p => Object.values(p).reduce((a, x) => a + x, 0);
  return { here: { total: Math.round(sum(H)), parts: H }, all: { total: Math.round(sum(A) * 100 / 85), parts: A } };
}

// Linked to the country: sells or specialises in something sold there, or has trips there.
const linked = (info, rec, country) => !!(info && info.sellsHere) || !!(rec && rec.per && rec.per[country] > 0);

// Everyone the database knows as a trader, with both scores (no travel record or cash unless given).
function allTraders(mdb, country, minCost, recordOf = () => null) {
  const items = mdb.items();
  const out = [];
  for (const pid of mdb.sellerIds()) {
    const info = traderInfo(mdb.seller(pid), items, country, minCost);
    if (!info || (!info.items.length && !info.rc30 && !info.spec.length)) continue;
    const rec = recordOf(pid);
    const sc = scores(info, rec, null, country);
    out.push({ id: pid, info, here: sc.here.total, all: sc.all.total, linked: linked(info, rec, country) });
  }
  return out;
}

// The pool for a country: two thirds the best for this country (linked to it), the rest the best
// overall not already in, so a big trader who happens to be there can still be found.
function rankTraders(mdb, country, minCost, n, recordOf = () => null) {
  const all = allTraders(mdb, country, minCost, recordOf);
  const byHere = all.filter(x => x.linked && x.here > 0).sort((a, b) => b.here - a.here).slice(0, Math.ceil(n * 2 / 3));
  const taken = new Set(byHere.map(x => x.id));
  const byAll = all.filter(x => !taken.has(x.id) && x.all > 0).sort((a, b) => b.all - a.all).slice(0, n - byHere.length);
  return [...byHere, ...byAll];
}

module.exports = { MuggerDb, abroadItems, dayKey, dayItems, COLLECT_MIN, TRADE_QTY, traderInfo, scores, linked, allTraders, rankTraders };

  },
  "features/planner.js": function (module, exports, require) {
'use strict';
// Planner: your plan for the next few days (trips, gym, crimes, boosts, blood bags, notes),
// kept as `planner.items` (synced between your devices, merged item by item) and
// `planner.days` (how many days the plan covers). A removed item stays behind as a small
// { id, deleted: true, at, updatedAt } marker until it's old, so the removal reaches your other
// devices instead of being undone by one that still has the item (syncmerge.mergePlan). Reminders fire here, a set number of
// minutes before an item, like the custom alerts. The projections (bars, restocks) are worked
// out on the page (ui/planner.js, ui/planner-math.js) from data the app already has, so the
// planner makes no API requests of its own.

const { EventEmitter } = require('events');
const { COUNTRIES, METHODS } = require('./travel');

const TYPES = ['trip', 'gym', 'crimes', 'energy', 'nerve', 'blood', 'life', 'note'];
const ENERGY_KINDS = ['xanax', 'refill', 'fhc', 'can', 'custom'];
const NERVE_KINDS = ['refill', 'custom'];
const MAX_ITEMS = 1000;
const KEEP_PAST = 7 * 86400 * 1000;   // done or past items are kept a week, then dropped
const KEEP_GONE = 30 * 86400 * 1000;  // removal markers are kept a month after the removal
const MAX_LATE = 3 * 60 * 1000;       // a reminder more than 3 minutes late (PC asleep) is skipped
const T = 'https://www.torn.com/';
const CODES = new Set(COUNTRIES.map(c => c.code));
const nameOf = code => (COUNTRIES.find(c => c.code === code) || { name: code }).name;

const int = (v, lo, hi, d = 0) => { const n = Math.round(Number(v)); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : d; };
const str = (v, n) => String(v == null ? '' : v).replace(/[\u0000-\u001f]/g, ' ').slice(0, n);

class PlannerFeature extends EventEmitter {
  constructor({ store, notify }) {
    super();
    this.store = store;
    this.notify = notify;
    this.lastPrune = 0;
  }

  all() { return this.store.get('planner.items') || {}; }
  // The plan without removal markers.
  items() { return Object.fromEntries(Object.entries(this.all()).filter(([, it]) => it && !it.deleted)); }
  save(items) { this.store.set('planner.items', items); this.emit('state'); }
  gone(it, now) { return { id: it.id, deleted: true, at: it.at, updatedAt: now }; }

  // A plan item from the page, checked field by field.
  static clean(raw, now = Date.now()) {
    const r = raw && typeof raw === 'object' ? raw : {};
    if (!TYPES.includes(r.type)) throw new Error('Unknown plan item');
    const at = Number(r.at);
    if (!Number.isFinite(at) || at < now - 30 * 86400e3 || at > now + 400 * 86400e3) throw new Error('Pick a time within the plan');
    const it = { type: r.type, at: Math.round(at / 1000) * 1000, note: str(r.note, 300), remind: int(r.remind, -1, 1440, -1), done: !!r.done };
    // Reminder style: '' = the Settings choice for this kind, 'on' = urgent popup, 'off' = normal.
    if (r.urgent === 'on' || r.urgent === 'off') it.urgent = r.urgent;
    if (r.type === 'trip') {
      if (!CODES.has(r.country)) throw new Error('Pick a country');
      it.country = r.country;
      it.method = METHODS.includes(r.method) ? r.method : '';
      it.itemId = int(r.itemId, 0, 1e6, 0);
      it.stay = int(r.stay, 0, 24 * 60, 0);
      // Money to bring (worked out on the page from abroad shop prices + the ticket), for the reminder.
      if (r.bring && typeof r.bring === 'object' && Number(r.bring.total) > 0) it.bring = { total: int(r.bring.total, 0, 1e13, 0), text: str(r.bring.text, 120) };
    } else if (r.type === 'gym' || r.type === 'crimes') {
      it.amount = int(r.amount, 0, 100000, 0); // 0 = all you have
    } else if (r.type === 'energy' || r.type === 'nerve') {
      const kinds = r.type === 'energy' ? ENERGY_KINDS : NERVE_KINDS;
      it.kind = kinds.includes(r.kind) ? r.kind : 'custom';
      it.amount = int(r.amount, 0, 100000, 0);
      if (r.cd === 'drug' || r.cd === 'booster' || r.cd === '') it.cd = r.cd;
      if (r.cdHours !== undefined && r.cdHours !== null && r.cdHours !== '') it.cdHours = Math.max(0, Math.min(48, Number(r.cdHours) || 0));
    } else if (r.type === 'blood') {
      it.count = int(r.count, 1, 50, 1);
    } else if (r.type === 'life') {
      it.amount = int(r.amount, -100000, 100000, 0);
      it.cdHours = Math.max(0, Math.min(24, Number(r.cdHours) || 0));
    }
    return it;
  }

  add(raw) {
    const items = this.items();
    if (Object.keys(items).length >= MAX_ITEMS) throw new Error(`Up to ${MAX_ITEMS} plan items`);
    const id = `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const it = { id, ...PlannerFeature.clean(raw), updatedAt: Date.now() };
    this.save({ ...this.all(), [id]: it });
    return it;
  }

  update(id, patch) {
    const items = this.items();
    const old = items[id];
    if (!old) throw new Error('That plan item is gone (removed on another device?)');
    const it = { id, ...PlannerFeature.clean({ ...old, ...(patch && typeof patch === 'object' ? patch : {}) }), updatedAt: Date.now() };
    this.save({ ...this.all(), [id]: it });
    return it;
  }

  remove(id) {
    const all = { ...this.all() };
    if (!all[id] || all[id].deleted) return;
    all[id] = this.gone(all[id], Date.now());
    this.save(all);
  }

  // Copies every item of one TCT day to another (same times of day). Returns how many.
  copyDay(fromDay, toDay) {
    const DAY = 86400e3;
    const from = Date.parse(`${fromDay}T00:00:00Z`), to = Date.parse(`${toDay}T00:00:00Z`);
    if (!Number.isFinite(from) || !Number.isFinite(to) || from === to) throw new Error('Pick two different days');
    const items = { ...this.all() };
    let n = 0;
    for (const it of Object.values(this.items())) {
      if (it.at < from || it.at >= from + DAY) continue;
      const id = `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}${n}`;
      items[id] = { ...it, id, at: it.at - from + to, done: false, updatedAt: Date.now() };
      n++;
    }
    if (Object.keys(this.items()).length + n > MAX_ITEMS) throw new Error(`Up to ${MAX_ITEMS} plan items`);
    if (n) this.save(items);
    return n;
  }

  clearDay(day) {
    const from = Date.parse(`${day}T00:00:00Z`);
    if (!Number.isFinite(from)) throw new Error('Pick a day');
    const now = Date.now();
    const all = { ...this.all() };
    for (const [id, it] of Object.entries(all)) if (!it.deleted && it.at >= from && it.at < from + 86400e3) all[id] = this.gone(it, now);
    this.save(all);
  }

  // ---- Reminders ----
  title(it) {
    if (it.type === 'trip') return `Trip to ${nameOf(it.country)}`;
    if (it.type === 'gym') return it.amount ? `Gym: ${it.amount} energy` : 'Gym: spend your energy';
    if (it.type === 'crimes') return it.amount ? `Crimes: ${it.amount} nerve` : 'Crimes: spend your nerve';
    if (it.type === 'energy') return { xanax: 'Take a Xanax', refill: 'Energy refill', fhc: 'Use a Feathery Hotel Coupon', can: 'Energy drink' }[it.kind] || `+${it.amount} energy`;
    if (it.type === 'nerve') return it.kind === 'refill' ? 'Nerve refill' : `+${it.amount} nerve`;
    if (it.type === 'blood') return `Fill ${it.count} blood bag${it.count === 1 ? '' : 's'}`;
    if (it.type === 'life') return it.amount >= 0 ? `+${it.amount} life` : `${it.amount} life`;
    return it.note ? it.note.slice(0, 60) : 'Plan note';
  }

  url(it) {
    return { trip: `${T}page.php?sid=travel`, gym: `${T}gym.php`, crimes: `${T}page.php?sid=crimes`, energy: `${T}item.php`, nerve: `${T}points.php`, blood: `${T}hospitalview.php`, life: `${T}item.php#medical-items` }[it.type] || `${T}index.php`;
  }

  tick(now) {
    const items = this.items();
    const fired = this.store.get('planner.fired') || {};
    let firedChanged = false;
    for (const it of Object.values(items)) {
      if (it.done || !(it.remind >= 0)) continue;
      const at = it.at - it.remind * 60000;
      const key = `${it.id}|${it.at}|${it.remind}`;
      if (now < at || fired[key]) continue;
      fired[key] = now;
      firedChanged = true;
      if (now - at > MAX_LATE) continue;
      const when = it.remind ? `in ${it.remind} min (${new Date(it.at).toISOString().slice(11, 16)} TCT)` : 'now';
      // Urgent popup: the item's own choice, else the setting for trips / other plan items.
      const kind = it.urgent === 'on' ? true : it.urgent === 'off' ? false : it.type === 'trip' ? 'trip' : 'plan';
      const bring = it.type === 'trip' && it.bring && it.bring.total ? ` · bring $${it.bring.total.toLocaleString('en-US')}${it.bring.text ? ` (${it.bring.text})` : ''}` : '';
      this.notify(`Plan: ${this.title(it)}`, `${when}${bring}${it.note && it.type !== 'note' ? ` · ${it.note}` : ''}`, this.url(it), kind);
    }
    // Once an hour: forget old reminders and drop items more than a week in the past.
    if (now - this.lastPrune > 3600e3) {
      this.lastPrune = now;
      for (const [k, t] of Object.entries(fired)) if (now - t > KEEP_PAST) { delete fired[k]; firedChanged = true; }
      const all = this.all();
      const keep = Object.fromEntries(Object.entries(all).filter(([, it]) => it && now - it.at < KEEP_PAST && !(it.deleted && now - (it.updatedAt || 0) > KEEP_GONE)));
      if (Object.keys(keep).length !== Object.keys(all).length) { this.save(keep); this.emit('pruned'); }
    }
    if (firedChanged) this.store.set('planner.fired', fired);
  }

  snapshot() {
    return { items: this.items(), days: this.store.get('planner.days') || 3 };
  }
}

module.exports = { PlannerFeature, TYPES };

  },
  "features/research.js": function (module, exports, require) {
'use strict';
// Oppo research: from the moment a war is announced (and through the war), collect what
// the official API shows about the enemy faction, and about yours for comparison:
//   members        /v2/faction/{id}/members every 5 min (shares the War tab's checks)
//                  -> activity by hour of the week, per member and per faction
//   faction        /v2/faction/{id}/basic every 6 h
//   track record   /v2/faction/{id}/rankedwars and /chains every 12 h
//   personal stats /v2/user/{id}/personalstats?cat=popular once a day per member, one
//                  request every few seconds at low priority -> training, combat, revives,
//                  activity time, and daily rates once there are two days of samples
// Battle stat estimates come from FFScouter (your key) like the War tab's.
// Also: any faction you choose to research by ID, and always your own faction (My Faction tab).
//
// War record (for the report): the last 10 ranked war reports (every member's hits and
// score), the chains run during each war with each attacker's breakdown, members' war
// records in other factions, and long-term activity from the activity store (fed by these
// checks and by scouting). Momentum: daily personal-stat snapshots from past dates
// (/v2/user/{id}/personalstats?stat=...&timestamp=) once a week back 10 weeks, plus the
// days around each of the last 3 wars. Past snapshots never change, so each is fetched once.

const path = require('path');
const { EventEmitter } = require('events');
const { Store } = require('../store');
const { member } = require('./war');

const MIN = 60e3, HOUR = 3600e3, DAY = 24 * HOUR;
const SAMPLE_EVERY = 5 * MIN;
const BASIC_EVERY = 6 * HOUR;
const HISTORY_EVERY = 12 * HOUR;
const PERSONAL_EVERY = 20 * HOUR;
const PERSONAL_GAP = 6000; // between personal stats requests
const SERIES_KEEP = 14 * DAY;
const PERSONAL_KEEP = 10; // samples per member
const MAX_FACTIONS = 4;
const KEEP_AFTER_WAR = 2 * DAY;

// Personal stats worth comparing (from the public "popular" set).
const PICKS = {
  xanax: 'drugs.xanax', refills: 'other.refills.energy', ses: 'items.used.stat_enhancers', cans: 'items.used.energy_drinks',
  boosters: 'items.used.boosters', attacksWon: 'attacking.attacks.won', attacksLost: 'attacking.attacks.lost',
  defendsWon: 'attacking.defends.won', defendsLost: 'attacking.defends.lost', elo: 'attacking.elo',
  rwHits: 'attacking.faction.ranked_war_hits', respect: 'attacking.faction.respect', bestDamage: 'attacking.damage.best',
  killstreak: 'attacking.killstreak.best', reviveSkill: 'hospital.reviving.skill', revives: 'hospital.reviving.revives',
  activity: 'other.activity.time', streak: 'other.activity.streak.current', networth: 'networth.total', rwWins: 'other.ranked_war_wins',
};
// Historical snapshot stats (v2 names; at most 10 per request). timeplayed is seconds active.
const SNAP_STATS = ['timeplayed', 'xantaken', 'refills', 'energydrinkused', 'statenhancersused', 'boostersused', 'attackswon', 'rankedwarhits', 'activestreak', 'revives'];
const SNAP_WEEKS = 10;
const SNAP_GAP = 3000;
const RECORD_GAP = 2500;
const RECORD_EVERY = 6 * HOUR;
const RECORD_WARS = 10;
const COMMIT_WARS = 3;
const OBSERVED_EVERY = 30 * MIN;
const OBSERVED_DAYS = 120;
const dayKey = t => new Date(t).toISOString().slice(0, 10);
// Weekly anchors: Mondays 00:00 UTC, newest first, plus today.
function snapAnchors(now) {
  const d = new Date(now);
  const monday = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - ((d.getUTCDay() + 6) % 7) * DAY;
  const out = [{ key: dayKey(now), ts: now, today: true }];
  for (let i = 0; i < SNAP_WEEKS; i++) { const t = monday - i * 7 * DAY; if (dayKey(t) !== out[0].key) out.push({ key: dayKey(t), ts: t + 3600e3 }); }
  return out;
}
const pick = (obj, p) => p.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
const hourOfWeek = t => { const d = new Date(t); return d.getUTCDay() * 24 + d.getUTCHours(); };
const zeros = () => new Array(168).fill(0);

class ResearchFeature extends EventEmitter {
  constructor({ api, store, dataDir, war, activity = null, archive = null }) {
    super();
    this.api = api;
    this.store = store;
    this.war = war;
    this.activity = activity;
    this.archive = archive;
    this.lastRecordReq = 0;
    this.lastSnap = 0;
    this.db = new Store(path.join(dataDir, 'research.json'), { factions: {} }, { debounceMs: 30000 });
    this.inFlight = false;
    this.lastPersonal = 0;
    this.lastEmit = 0;
    // True while a sync server collects instead of this PC (set by main.js).
    this.remote = () => false;
    // On a member's device (signed in to someone else's server): the factions the server owner picked
    // (only the owner's pick is researched). null on your own server or without one (set by core.js).
    this.ownerPicks = () => null;
    // Share the War tab's member checks instead of fetching again.
    war.on('members', (fid, members, now) => { if (this.tracked().some(t => t.id === fid)) this.recordMembers(fid, members, now); });
  }

  flush() {
    this.db.flush();
  }

  factions() {
    return this.db.get('factions') || {};
  }

  rec(id) {
    const all = this.factions();
    return all[id] || null;
  }

  save(rec) {
    const all = this.factions();
    all[rec.id] = rec;
    this.db.set('factions', all);
  }

  // Which factions are being researched now: the war opponent (from the moment a war is
  // announced), a faction you picked, and yours for comparison.
  tracked() {
    const out = [];
    const w = this.war.snapshot();
    const now = Date.now();
    const picks = this.remote() ? this.ownerPicks() : null;
    const manual = picks ? 0 : Number(this.store.get('research.watchId')) || 0;
    if (manual) out.push({ id: manual, why: 'picked by you' });
    if (picks) for (const p of picks) if (p.why === 'picked by you' && p.id) out.push({ id: p.id, name: p.name || '', why: 'picked by the server owner' });
    const r = w.wars && w.wars.ranked;
    const own = w.own && w.own.id;
    if (r && own && (!r.end || now - r.end < KEEP_AFTER_WAR)) {
      const them = r.factions.find(f => f.id !== own);
      if (them && !out.some(o => o.id === them.id)) out.push({ id: them.id, name: them.name, why: r.start > now ? 'announced ranked war' : r.end ? 'recent ranked war' : 'ranked war' });
    }
    if (w.wars && own) {
      for (const x of [...w.wars.raids, ...w.wars.territory]) {
        if (x.end) continue;
        const them = x.factions.find(f => f.id !== own);
        if (them && !out.some(o => o.id === them.id)) out.push({ id: them.id, name: them.name, why: 'raid / territory war' });
      }
    }
    // Your own faction is always tracked: the My Faction tab, and the comparison here.
    if (own) out.push({ id: own, name: w.own.name, why: 'your faction', own: true });
    return out;
  }

  research(id) {
    this.store.set('research.watchId', Math.max(0, Math.floor(Number(id) || 0)));
    this.emit('state');
  }

  ensureRec(t, now) {
    let rec = this.rec(t.id);
    if (!rec) {
      rec = {
        id: t.id, name: t.name || `Faction ${t.id}`, own: !!t.own, startedAt: now, why: t.why,
        basic: null, basicAt: 0, history: null, historyAt: 0, lastSample: 0, samples: 0,
        members: {}, activity: {}, factionHours: { samples: zeros(), active: zeros(), actions: zeros() },
        series: [], personal: {}, personalAt: {},
      };
      this.save(rec);
      this.prune(now);
    }
    rec.why = t.why;
    return rec;
  }

  // Keep the most recent few factions.
  prune(now) {
    const all = this.factions();
    const live = new Set(this.tracked().map(t => String(t.id)));
    const ids = Object.keys(all).sort((a, b) => (all[b].lastSample || all[b].startedAt) - (all[a].lastSample || all[a].startedAt));
    for (const id of ids.slice(MAX_FACTIONS)) if (!live.has(id)) delete all[id];
    this.db.set('factions', all);
  }

  tick(now) {
    if (this.remote()) {
      if (now - this.lastEmit > 60000) { this.lastEmit = now; this.emit('state'); }
      return;
    }
    if (!this.api.hasKey()) return;
    const tracked = this.tracked();
    if (!tracked.length) return;
    if (now - this.lastEmit > 60000) { this.lastEmit = now; this.emit('state'); }
    if (this.inFlight) return;
    for (const t of tracked) {
      const rec = this.ensureRec(t, now);
      if (now - rec.lastSample >= SAMPLE_EVERY) return this.run(() => this.fetchMembers(rec, now));
      // Also early (at most every 10 min) for records saved before the faction images were kept.
      const noImages = rec.basic && rec.basic.bannerImage === undefined && now - rec.basicAt >= 10 * 60e3;
      if (now - rec.basicAt >= BASIC_EVERY || noImages) return this.run(() => this.fetchBasic(rec, now));
      if (now - rec.historyAt >= HISTORY_EVERY) return this.run(() => this.fetchHistory(rec, now));
    }
    // War record pieces (reports, chain lists, chain reports), one at a time.
    if (this.archive && now - this.lastRecordReq >= RECORD_GAP) {
      for (const t of tracked) {
        const rec = this.rec(t.id);
        if (!rec || !rec.history) continue;
        const job = this.recordJob(rec, now);
        // Show what's in so far (at most once a minute while the rest loads).
        if (job && rec.recordDirty && now - ((rec.record && rec.record.at) || 0) >= 60e3) this.buildRecord(rec, now);
        if (job) { this.lastRecordReq = now; return this.run(job); }
        if (!rec.record || now - (rec.record.at || 0) >= RECORD_EVERY || rec.recordDirty) this.buildRecord(rec, now);
      }
    }
    if (this.activity) {
      for (const t of tracked) {
        const rec = this.rec(t.id);
        if (rec && Object.keys(rec.members).length && (!rec.observed || now - rec.observed.at >= OBSERVED_EVERY)) this.buildObserved(rec, now);
      }
    }
    // Momentum snapshots: the opponent first, then your faction.
    if (now - this.lastSnap >= SNAP_GAP) {
      const job = this.snapJob(tracked, now);
      if (job) { this.lastSnap = now; return this.run(job); }
    }
    // Personal stats: one member at a time, oldest first, across all tracked factions.
    if (now - this.lastPersonal < PERSONAL_GAP) return;
    let next = null;
    for (const t of tracked) {
      const rec = this.rec(t.id);
      if (!rec) continue;
      for (const id of Object.keys(rec.members)) {
        const at = rec.personalAt[id] || 0;
        if (now - at >= PERSONAL_EVERY && (!next || at < next.at)) next = { rec, id, at };
      }
    }
    if (next) { this.lastPersonal = now; this.run(() => this.fetchPersonal(next.rec, next.id, now)); }
  }

  run(fn) {
    this.inFlight = true;
    fn().catch(() => {}).finally(() => { this.inFlight = false; });
  }

  async fetchMembers(rec, now) {
    rec.lastSample = now; // also when it fails, so a broken faction isn't retried every second
    try {
      const d = await this.api.request(`/v2/faction/${rec.id}/members?striptags=true`, { soft: [6, 7], priority: 8 });
      this.recordMembers(rec.id, (d.members || []).map(member), now);
    } catch (e) {
      if (e.kind === 'soft') { rec.error = 'Faction not found'; this.save(rec); }
    }
  }

  // One sample of everyone's status: presence (online now) and last-action times.
  recordMembers(fid, members, now) {
    if (this.remote()) return;
    const rec = this.rec(fid);
    if (!rec) return;
    if (this.activity) this.activity.observe(members, now); // long-term history, every check
    if (rec.lastSampleAt && now - rec.lastSampleAt < SAMPLE_EVERY - 15000) return; // War tab polls faster
    rec.lastSampleAt = now;
    rec.lastSample = now;
    rec.samples = (rec.samples || 0) + 1;
    rec.error = '';
    const h = hourOfWeek(now);
    let online = 0, idle = 0;
    const seen = new Set();
    for (const m of members) {
      seen.add(String(m.id));
      rec.members[m.id] = { id: m.id, name: m.name, level: m.level, position: m.position, days: m.days, state: m.state, description: m.description, last: m.last, lastAt: m.lastAt, revivable: m.revivable };
      const a = rec.activity[m.id] || (rec.activity[m.id] = { samples: zeros(), active: zeros(), actions: zeros(), lastAction: 0 });
      const active = m.last === 'Online' || (m.lastAt && now - m.lastAt < 5 * MIN);
      if (m.last === 'Online') online++;
      else if (m.last === 'Idle') idle++;
      a.samples[h]++;
      rec.factionHours.samples[h]++;
      if (active) { a.active[h]++; rec.factionHours.active[h]++; }
      // Last-action times reveal activity between samples too (one per distinct time).
      if (m.lastAt && m.lastAt > (a.lastAction || 0) + MIN) {
        a.lastAction = m.lastAt;
        const ah = hourOfWeek(m.lastAt);
        a.actions[ah]++;
        rec.factionHours.actions[ah]++;
      }
    }
    // People who left the faction.
    for (const id of Object.keys(rec.members)) if (!seen.has(id)) delete rec.members[id];
    rec.series.push([now, online, idle, members.length]);
    while (rec.series.length && now - rec.series[0][0] > SERIES_KEEP) rec.series.shift();
    if (!rec.name || /^Faction \d+$/.test(rec.name)) {
      const t = this.tracked().find(x => x.id === fid);
      if (t && t.name) rec.name = t.name;
    }
    this.save(rec);
    this.emit('state');
  }

  async fetchBasic(rec, now) {
    rec.basicAt = now;
    try {
      const d = await this.api.request(`/v2/faction/${rec.id}/basic`, { soft: [6, 7], priority: 8 });
      const b = d.basic || {};
      rec.basic = {
        name: b.name, tag: b.tag, respect: b.respect || 0, members: b.members || 0, capacity: b.capacity || 0, daysOld: b.days_old || 0,
        bestChain: b.best_chain || 0, rank: b.rank ? `${b.rank.name || ''} ${b.rank.division || ''}`.trim() : '', wins: b.rank ? b.rank.wins || 0 : 0,
        enlisted: b.is_enlisted, leader: b.leader_id, coLeader: b.co_leader_id,
        tagImage: typeof b.tag_image === 'string' ? b.tag_image : '', bannerImage: typeof b.banner_image === 'string' ? b.banner_image : '', // file names (ui: factionTagUrl/factionBannerUrl)
      };
      if (b.name) rec.name = b.name;
    } catch (e) { /* try again later */ }
    this.save(rec);
    this.emit('state');
  }

  async fetchHistory(rec, now) {
    rec.historyAt = now;
    const h = { wars: [], chains: [] };
    try {
      const d = await this.api.request(`/v2/faction/${rec.id}/rankedwars?limit=20`, { soft: [6, 7], priority: 9 });
      h.wars = (d.rankedwars || []).map(w => ({
        id: w.id, start: (w.start || 0) * 1000, end: (w.end || 0) * 1000, target: w.target || 0, winner: w.winner || 0,
        factions: (w.factions || []).map(f => ({ id: f.id, name: f.name, score: f.score || 0, chain: f.chain || 0 })),
      }));
    } catch (e) { /* none */ }
    try {
      const d = await this.api.request(`/v2/faction/${rec.id}/chains?limit=100&sort=DESC`, { soft: [6, 7], priority: 9 });
      h.chains = (d.chains || []).map(c => ({ length: c.chain || 0, respect: c.respect || 0, start: (c.start || 0) * 1000, end: (c.end || 0) * 1000 }));
    } catch (e) { /* none */ }
    rec.history = h;
    this.save(rec);
    this.emit('state');
  }

  async fetchPersonal(rec, id, now) {
    rec.personalAt[id] = now;
    try {
      const d = await this.api.request(`/v2/user/${id}/personalstats?cat=popular`, { soft: [6, 7], priority: 9 });
      const ps = d.personalstats || {};
      const s = {};
      for (const [k, p] of Object.entries(PICKS)) { const v = pick(ps, p); if (typeof v === 'number') s[k] = v; }
      const list = rec.personal[id] || (rec.personal[id] = []);
      list.push({ at: now, s });
      while (list.length > PERSONAL_KEEP) list.shift();
    } catch (e) { /* skip this member for now */ }
    this.save(rec);
    if (Date.now() - this.lastEmit > 5000) { this.lastEmit = Date.now(); this.emit('state'); }
  }

  // ---- War record ----
  recordWars(rec) {
    return ((rec.history && rec.history.wars) || []).filter(w => w.end).sort((a, b) => b.start - a.start).slice(0, RECORD_WARS);
  }

  recordJob(rec, now) {
    const bad = rec.recordBad || (rec.recordBad = []);
    const lists = rec.chainLists || (rec.chainLists = {});
    const wars = this.recordWars(rec);
    for (const w of wars) {
      if (this.archive.has('rw', w.id) || bad.includes(`rw${w.id}`)) continue;
      return async () => {
        try { if (!(await this.archive.fetchRanked(this.api, w.id, 9))) bad.push(`rw${w.id}`); } catch (e) { if (e.kind === 'soft') bad.push(`rw${w.id}`); else throw e; }
        rec.recordDirty = true;
        this.save(rec);
      };
    }
    for (const w of wars) {
      if (lists[w.id]) continue;
      return async () => {
        const from = Math.floor((w.start - 2 * DAY) / 1000), to = Math.floor((w.end + HOUR) / 1000);
        try {
          const d = await this.api.request(`/v2/faction/${rec.id}/chains?from=${from}&to=${to}&limit=100`, { soft: [6, 7], priority: 9 });
          lists[w.id] = (d.chains || []).filter(c => c.start * 1000 < w.end && (c.end || 0) * 1000 > w.start).map(c => c.id);
        } catch (e) { if (e.kind === 'soft') lists[w.id] = []; else throw e; }
        rec.recordDirty = true;
        this.save(rec);
      };
    }
    for (const w of wars) {
      for (const cid of lists[w.id] || []) {
        if (this.archive.has('ch', cid) || bad.includes(`ch${cid}`)) continue;
        return async () => {
          try { if (!(await this.archive.fetchChain(this.api, cid, 9))) bad.push(`ch${cid}`); } catch (e) { if (e.kind === 'soft') bad.push(`ch${cid}`); else throw e; }
          rec.recordDirty = true;
          this.save(rec);
        };
      }
    }
    return null;
  }

  buildRecord(rec, now) {
    const wars = [];
    const chains = {};
    for (const w of this.recordWars(rec)) {
      const r = this.archive.get('rw', w.id);
      const lists = (rec.chainLists && rec.chainLists[w.id]) || [];
      for (const cid of lists) { const c = this.archive.get('ch', cid); if (c) chains[cid] = c; }
      if (!r) { wars.push({ id: w.id, start: w.start, end: w.end, winner: w.winner, pending: true, chains: lists }); continue; }
      const f = r.factions.find(x => x.id === rec.id) || { members: [] };
      const o = r.factions.find(x => x.id !== rec.id) || {};
      wars.push({
        id: r.id, start: r.start, end: r.end, winner: r.winner, forfeit: r.forfeit, chains: lists,
        us: { score: f.score, attacks: f.attacks, rankBefore: f.rankBefore, rankAfter: f.rankAfter, respect: f.respect, points: f.points },
        opp: { id: o.id, name: o.name, score: o.score, attacks: o.attacks, rankBefore: o.rankBefore, rankAfter: o.rankAfter, members: (o.members || []).length },
        members: f.members, // [id, name, level, attacks, score]
      });
    }
    // Current members' ranked wars in other factions (from every report on record).
    const prior = {};
    for (const id of Object.keys(rec.members)) { const p = this.archive.playerWars(Number(id), rec.id, 5); if (p.length) prior[id] = p; }
    rec.record = { at: now, wars, chains, prior };
    rec.recordDirty = false;
    this.save(rec);
    this.emit('state');
  }

  buildObserved(rec, now) {
    const ids = Object.keys(rec.members).map(Number);
    const p = this.activity.profile(ids, now - OBSERVED_DAYS * DAY, now);
    rec.observed = { at: now, from: p.from, to: p.to, days: p.days, members: p.members, week: p.week };
    this.save(rec);
  }

  // ---- Momentum snapshots ----
  snapDates(rec, now) {
    const dates = snapAnchors(now);
    {
      const wars = this.recordWars(rec).slice(0, COMMIT_WARS);
      for (const w of wars) {
        dates.push({ key: `w${w.id}s`, ts: w.start - HOUR, war: w.id });
        dates.push({ key: `w${w.id}e`, ts: Math.min(now, w.end + DAY), war: w.id });
      }
    }
    return dates;
  }

  snapJob(tracked, now) {
    const order = [...tracked].sort((a, b) => (a.own ? 1 : 0) - (b.own ? 1 : 0));
    for (const t of order) {
      const rec = this.rec(t.id);
      if (!rec || !Object.keys(rec.members).length) continue;
      const snaps = rec.snaps || (rec.snaps = {});
      const dates = this.snapDates(rec, now);
      for (const d of dates) {
        for (const id of Object.keys(rec.members)) {
          const s = snaps[id] || (snaps[id] = {});
          const have = s[d.key];
          // Today's snapshot is refreshed once a day; past ones are final.
          if (have && !(d.today && now - (have.at || 0) >= 20 * HOUR)) continue;
          return () => this.fetchSnap(rec, Number(id), d, now);
        }
      }
    }
    return null;
  }

  async fetchSnap(rec, id, d, now) {
    const s = (rec.snaps[id] = rec.snaps[id] || {});
    try {
      const r = await this.api.request(`/v2/user/${id}/personalstats?stat=${SNAP_STATS.join(',')}&timestamp=${Math.floor(d.ts / 1000)}`, { soft: [6, 7, 16], priority: 9 });
      const v = {};
      for (const x of r.personalstats || []) if (x && x.name) v[x.name] = x.value;
      s[d.key] = { at: now, v: SNAP_STATS.map(k => (typeof v[k] === 'number' ? v[k] : null)) };
    } catch (e) {
      if (e.kind === 'soft') s[d.key] = { at: now, v: null };
      else throw e;
    }
    // Drop snapshots that are no longer needed (old weeks, wars no longer among the last 3, people who left).
    const keep = new Set(this.snapDates(rec, now).map(x => x.key));
    for (const pid of Object.keys(rec.snaps)) {
      if (!rec.members[pid]) { delete rec.snaps[pid]; continue; }
      for (const k of Object.keys(rec.snaps[pid])) if (!keep.has(k)) delete rec.snaps[pid][k];
    }
    this.save(rec);
    if (Date.now() - this.lastEmit > 10000) { this.lastEmit = Date.now(); this.emit('state'); }
  }

  snapQueue(rec, now = Date.now()) {
    if (!rec || !Object.keys(rec.members).length) return 0;
    let n = 0;
    const dates = this.snapDates(rec, now);
    for (const id of Object.keys(rec.members)) for (const d of dates) { const h = rec.snaps && rec.snaps[id] && rec.snaps[id][d.key]; if (!h) n++; }
    return n;
  }

  // The sync server's research replaces this PC's copy (the server collects 24/7).
  applyRemote(data) {
    this.db.data = { factions: (data && data.factions) || {} };
    this.db.save();
    this.lastEmit = Date.now();
    this.emit('state');
  }

  // Member IDs being researched (for FFScouter estimates).
  memberIds() {
    const ids = [];
    for (const t of this.tracked()) { const r = this.rec(t.id); if (r) ids.push(...Object.keys(r.members).map(Number)); }
    return ids;
  }

  snapshot() {
    const tracked = this.tracked();
    const recs = {};
    for (const t of tracked) { const r = this.rec(t.id); if (r) recs[t.id] = r; }
    const queue = tracked.reduce((n, t) => { const r = this.rec(t.id); return n + (r ? Object.keys(r.members).filter(id => Date.now() - (r.personalAt[id] || 0) >= PERSONAL_EVERY).length : 0); }, 0);
    const snapQueue = tracked.reduce((n, t) => n + this.snapQueue(this.rec(t.id)), 0);
    return {
      fromServer: this.remote(), canPick: !(this.remote() && this.ownerPicks()), tracked, factions: recs, watchId: Number(this.store.get('research.watchId')) || 0, personalQueue: queue, personalGapSec: PERSONAL_GAP / 1000,
      snapStats: SNAP_STATS, snapQueue, snapGapSec: SNAP_GAP / 1000, snapWeeks: SNAP_WEEKS,
    };
  }
}

module.exports = { ResearchFeature, PICKS, hourOfWeek, SNAP_STATS };

  },
  "features/scout.js": function (module, exports, require) {
'use strict';
// Scouting: activity history and war records for every faction you could be matched with,
// collected long before a war is announced.
//
//   Ladder     /v2/torn/factionhof?cat=rank, once a day: every faction's rank and position.
//              The pool is your rank group plus `scout.spread` groups either side, so it
//              follows factions as they move up and down (and you, after each war).
//   War index  /v2/faction/warfareranked, every 2 h: all ranked wars of the last 30 days.
//              Factions in those groups that warred recently are the realistic opponents.
//   Sampling   /v2/faction/{id}/members for each pool faction in rotation -> ActivityStore
//              (per player, 15-minute slots). The interval grows with the pool to fit the budget.
//   Records    each pool faction's last 10 ranked war reports -> WarArchive (once each).
//
// Requests are low priority and limited to `scout.perMinute`, so everything else comes first.

const path = require('path');
const { EventEmitter } = require('events');
const { Store } = require('../store');
const { member } = require('./war');

const MIN = 60e3, HOUR = 3600e3, DAY = 24 * HOUR;
const LADDER_EVERY = DAY;
const INDEX_EVERY = 2 * HOUR;
const INDEX_DAYS = 30;
const LIST_EVERY = 7 * DAY;
const WARS_PER_FACTION = 10;
// Activity checks, ladder and index share the queue with research's background work (9);
// pool war reports come last (10). Live features (war, research checks) always go first.
const PRIORITY = 9;
const REPORT_PRIORITY = 10;
const MIN_INTERVAL = 10 * MIN, MAX_INTERVAL = 3 * HOUR;
const VIEW_EVERY = 5 * MIN;

class ScoutFeature extends EventEmitter {
  constructor({ api, store, dataDir, war, activity, archive, research = null, local = true }) {
    super();
    this.api = api;
    this.store = store;
    this.war = war;
    this.activity = activity;
    this.archive = archive;
    this.research = research;
    this.local = local; // on a PC: off unless turned on; on the server: on
    this.db = new Store(path.join(dataDir, 'scout.json'), {
      ladder: null, index: { at: 0, full: false, wars: {} }, pool: { at: 0, ids: [], meta: {} },
      sampled: {}, lists: {}, summaries: {}, log: [],
    }, { debounceMs: 60000 });
    this.inFlight = false;
    this.lastReq = 0;
    this.turn = 0;
    this.error = '';
    this.remote = () => false;
    this.remoteView = null;
    this.viewRev = 0;
    this.viewAt = 0;
    this.lastEmit = 0;
  }

  flush() { this.db.flush(); }
  enabled() { return this.local ? !!this.store.get('scout.enabled') : this.store.get('scout.enabled') !== false; }
  perMinute() {
    const n = Number(this.store.get('scout.perMinute')) || (this.local ? 6 : 25);
    return Math.max(2, Math.min(this.local ? 15 : 40, n));
  }
  spread() { return Math.max(0, Math.min(4, Math.floor(Number(this.store.get('scout.spread') ?? 1)))); }
  get d() { return this.db.data; }

  logLine(msg) {
    const l = this.d.log;
    l.push([Date.now(), msg]);
    while (l.length > 30) l.shift();
  }

  // ---- Loop ----
  tick(now) {
    if (this.remote()) return;
    if (!this.enabled() || !this.api.hasKey() || this.inFlight) return;
    const own = this.war.state && this.war.state.own;
    if (!own || !own.id) return;
    if (now - this.lastReq < 60e3 / this.perMinute()) return;
    const L = this.d.ladder;
    const ownWarEnded = (() => { const r = this.war.ranked && this.war.ranked(); return r && r.end && L && r.end > L.at; })();
    if (!L || now - L.at >= LADDER_EVERY || L.ownId !== own.id || L.spread !== this.spread() || ownWarEnded) return this.run(() => this.scanLadder(own, now));
    if (now - this.d.index.at >= INDEX_EVERY) return this.run(() => this.scanIndex(now));
    if (!this.d.pool.at || this.d.pool.at < Math.max(L.at, this.d.index.at)) this.buildPool(own, now);
    // Three turns in four sample activity; the fourth (or any idle turn) fills war records.
    this.turn = (this.turn + 1) % 4;
    const sample = this.nextSample(own, now);
    if (sample && (this.turn !== 0 || !this.nextRecordJob())) return this.run(() => this.sampleFaction(sample, now));
    const job = this.nextRecordJob();
    if (job) return this.run(job);
    if (sample) return this.run(() => this.sampleFaction(sample, now));
  }

  run(fn) {
    this.inFlight = true;
    this.lastReq = Date.now();
    fn().then(() => { this.error = ''; }).catch(e => { if (e && e.kind !== 'paused' && e.kind !== 'nokey') this.error = e.message || String(e); })
      .finally(() => {
        this.inFlight = false;
        this.db.save();
        const now = Date.now();
        if (now - this.viewAt >= VIEW_EVERY) { this.viewAt = now; this.viewRev++; }
        if (now - this.lastEmit > 30e3) { this.lastEmit = now; this.emit('state'); }
      });
  }

  // ---- Ladder: rank groups around yours ----
  async scanLadder(own, now) {
    const spread = this.spread();
    const groups = []; // [{rank, from, to, count}] in ladder order (best first)
    const factions = [];
    let ownIdx = -1, ownPos = 0, ownRank = '';
    for (let offset = 0, page = 0; page < 400; page++, offset += 100) {
      const d = await this.api.request(`/v2/torn/factionhof?cat=rank&limit=100&offset=${offset}`, { soft: [6, 7], priority: PRIORITY });
      const list = d.factionhof || [];
      for (const f of list) {
        const rank = String(f.rank || 'Unranked');
        let g = groups[groups.length - 1];
        if (!g || g.rank !== rank) { g = { rank, from: f.position, to: f.position, count: 0 }; groups.push(g); }
        g.to = f.position;
        g.count++;
        if (f.id === own.id) { ownIdx = groups.length - 1; ownPos = f.position; ownRank = rank; }
        factions.push({ id: f.id, name: f.name || '', members: f.members || 0, position: f.position, rank, g: groups.length - 1 });
      }
      // Stop once we're past your group plus `spread` more groups below it.
      if (list.length < 100) break;
      if (ownIdx >= 0 && groups.length - 1 > ownIdx + spread) break;
    }
    if (ownIdx < 0) {
      this.d.ladder = { at: now, ownId: own.id, spread, own: null, groups: [], factions: [], error: 'Your faction isn\'t on the rank ladder yet (unranked?).' };
      this.logLine('Ladder: your faction is not ranked yet');
      return;
    }
    const lo = Math.max(0, ownIdx - spread), hi = ownIdx + spread;
    const prevPool = new Set(this.d.pool.ids);
    this.d.ladder = {
      at: now, ownId: own.id, spread, error: '',
      own: { id: own.id, name: own.name || '', position: ownPos, rank: ownRank },
      groups: groups.slice(lo, hi + 1).map(g => ({ ...g, own: g.rank === ownRank })),
      factions: factions.filter(f => f.g >= lo && f.g <= hi && f.id !== own.id).map(({ g, ...f }) => f),
    };
    this.d.pool.at = 0; // rebuild with the new ladder
    this.buildPool(own, now);
    const added = this.d.pool.ids.filter(id => !prevPool.has(id)).length;
    const dropped = [...prevPool].filter(id => !this.d.pool.ids.includes(id)).length;
    this.logLine(`Ladder: ${ownRank} #${ownPos}; pool ${this.d.pool.ids.length}${prevPool.size ? ` (+${added} / -${dropped})` : ''}`);
  }

  // ---- War index: every ranked war of the last 30 days ----
  async scanIndex(now) {
    const ix = this.d.index;
    const oldest = now - INDEX_DAYS * DAY;
    // Rescan from just before the last scan, or from the oldest war still running then.
    let from = ix.full ? ix.at - 6 * HOUR : oldest;
    for (const w of Object.values(ix.wars)) if (!w[1] && w[0] * 1000 < from) from = w[0] * 1000;
    from = Math.max(oldest, from);
    let to = Math.floor(now / 1000);
    const seen = new Set();
    for (let page = 0; page < 80; page++) {
      const d = await this.api.request(`/v2/faction/warfareranked?limit=100&sort=DESC&from=${Math.floor(from / 1000)}&to=${to}`, { soft: [6, 7], priority: PRIORITY });
      const list = d.warfareranked || [];
      let fresh = 0, minStart = to;
      for (const w of list) {
        minStart = Math.min(minStart, w.start || to);
        if (seen.has(w.id)) continue;
        seen.add(w.id);
        fresh++;
        const fs = w.factions || [];
        ix.wars[w.id] = [w.start || 0, w.end || 0, (fs[0] && fs[0].id) || 0, (fs[1] && fs[1].id) || 0, w.winner || 0];
      }
      if (list.length < 100 || !fresh || minStart * 1000 <= from) break;
      to = minStart;
    }
    for (const [id, w] of Object.entries(ix.wars)) if (w[0] * 1000 < now - 45 * DAY) delete ix.wars[id];
    ix.at = now;
    ix.full = true;
    this.d.pool.at = 0;
  }

  // ---- Pool ----
  buildPool(own, now) {
    const L = this.d.ladder;
    if (!L || !L.own) { this.d.pool = { at: now, ids: [], meta: {} }; return; }
    const recent = new Map(); // faction id -> last war end (or start if running)
    for (const [wid, w] of Object.entries(this.d.index.wars)) {
      const t = (w[1] || w[0]) * 1000;
      for (const f of [w[2], w[3]]) if (f && now - t < INDEX_DAYS * DAY && (!recent.has(f) || recent.get(f).t < t)) recent.set(f, { t, war: Number(wid), running: !w[1] });
    }
    let cands = L.factions;
    if (this.d.index.full) cands = cands.filter(f => recent.has(f.id));
    // Keep the closest factions if the pool is bigger than the budget allows at the longest interval.
    const cap = Math.floor(this.perMinute() * 0.75 * (MAX_INTERVAL / MIN));
    cands = [...cands].sort((a, b) => Math.abs(a.position - L.own.position) - Math.abs(b.position - L.own.position)).slice(0, cap);
    const meta = {};
    for (const f of cands) meta[f.id] = { ...f, lastWar: recent.has(f.id) ? recent.get(f.id).t : 0, running: recent.has(f.id) && recent.get(f.id).running };
    this.d.pool = { at: now, ids: cands.map(f => f.id), meta };
    // Factions that left the pool: forget their bookkeeping after 30 days (their members'
    // activity history stays in the activity store, and their reports in the archive).
    for (const key of ['sampled', 'lists', 'summaries']) {
      for (const id of Object.keys(this.d[key])) {
        if (meta[id] || Number(id) === own.id) continue;
        const s = this.d.sampled[id];
        if (!s || now - s[1] > 30 * DAY) delete this.d[key][id];
      }
    }
  }

  interval() {
    const n = this.d.pool.ids.length + 1; // + your own faction
    const perMin = this.perMinute() * 0.75;
    return Math.min(MAX_INTERVAL, Math.max(MIN_INTERVAL, Math.ceil(n / perMin) * MIN));
  }

  researching() {
    try { return new Set(this.research ? this.research.tracked().map(t => t.id) : []); } catch (e) { return new Set(); }
  }

  nextSample(own, now) {
    const every = this.interval();
    const busy = this.researching(); // research checks those every 5 minutes already
    let best = null, bestAt = Infinity;
    for (const id of [own.id, ...this.d.pool.ids]) {
      if (busy.has(id)) continue;
      const s = this.d.sampled[id];
      const at = s ? s[1] : 0;
      if (now - at >= every && at < bestAt) { best = id; bestAt = at; }
    }
    return best;
  }

  async sampleFaction(fid, now) {
    const s = this.d.sampled[fid] || (this.d.sampled[fid] = [now, 0, 0]);
    s[1] = now;
    try {
      const d = await this.api.request(`/v2/faction/${fid}/members?striptags=true`, { soft: [6, 7], priority: PRIORITY });
      const members = (d.members || []).map(member);
      this.activity.observe(members, now);
      s[2]++;
      const m = this.d.pool.meta[fid];
      if (m) m.members = members.length;
    } catch (e) {
      if (e.kind === 'soft') { delete this.d.pool.meta[fid]; this.d.pool.ids = this.d.pool.ids.filter(x => x !== fid); }
      else throw e;
    }
  }

  // ---- War records for pool factions ----
  warsOf(fid) {
    const ids = new Set((this.d.lists[fid] && this.d.lists[fid].wars) || []);
    for (const [wid, w] of Object.entries(this.d.index.wars)) if (w[1] && (w[2] === fid || w[3] === fid)) ids.add(Number(wid));
    return [...ids].map(id => [id, this.d.index.wars[id]]).sort((a, b) => b[0] - a[0]).map(x => x[0]).slice(0, WARS_PER_FACTION);
  }

  nextRecordJob() {
    const now = Date.now();
    for (const fid of this.d.pool.ids) {
      const l = this.d.lists[fid];
      if (!l || now - l.at >= LIST_EVERY) return () => this.fetchList(fid, now);
      for (const wid of this.warsOf(fid)) {
        if (this.archive.has('rw', wid) || (l.bad || []).includes(wid)) continue;
        return () => this.fetchReport(fid, wid);
      }
      if (!this.d.summaries[fid] || this.d.summaries[fid].stale) this.summarize(fid);
    }
    return null;
  }

  async fetchList(fid, now) {
    const l = this.d.lists[fid] || (this.d.lists[fid] = { at: 0, wars: [], bad: [] });
    l.at = now;
    try {
      const d = await this.api.request(`/v2/faction/${fid}/rankedwars?limit=${WARS_PER_FACTION}`, { soft: [6, 7], priority: REPORT_PRIORITY });
      l.wars = (d.rankedwars || []).filter(w => w.end).map(w => w.id);
      for (const w of d.rankedwars || []) {
        const fs = w.factions || [];
        if (!this.d.index.wars[w.id] && w.end) this.d.index.wars[w.id] = [w.start || 0, w.end || 0, (fs[0] && fs[0].id) || 0, (fs[1] && fs[1].id) || 0, w.winner || 0];
      }
    } catch (e) { if (e.kind !== 'soft') throw e; }
    this.markStale(fid);
  }

  async fetchReport(fid, wid) {
    try {
      const r = await this.archive.fetchRanked(this.api, wid, REPORT_PRIORITY);
      if (!r) { const l = this.d.lists[fid]; if (l) (l.bad || (l.bad = [])).push(wid); return; }
      for (const f of r.factions) this.markStale(f.id);
    } catch (e) {
      if (e.kind === 'soft') { const l = this.d.lists[fid]; if (l) (l.bad || (l.bad = [])).push(wid); } else throw e;
    }
  }

  markStale(fid) { if (this.d.summaries[fid]) this.d.summaries[fid].stale = true; else if (this.d.pool.meta[fid]) this.d.summaries[fid] = { stale: true }; }

  // A faction's record from its archived reports: what the scouting table shows.
  summarize(fid) {
    const wars = this.warsOf(fid).map(id => this.archive.get('rw', id)).filter(Boolean);
    const out = { stale: false, wars: wars.length, wins: 0, losses: 0, hits: [], winHits: [], lossHits: [], hitters: [], top5: [], perHour: [], lastOpp: '', lastEnd: 0 };
    for (const w of wars) {
      const f = w.factions.find(x => x.id === fid);
      const o = w.factions.find(x => x.id !== fid);
      if (!f) continue;
      const won = w.winner === fid;
      if (w.winner) { if (won) out.wins++; else out.losses++; }
      out.hits.push(f.attacks);
      (won ? out.winHits : out.lossHits).push(f.attacks);
      out.hitters.push(f.members.filter(m => m[3] > 0).length);
      const top = f.members.map(m => m[3]).sort((a, b) => b - a).slice(0, 5).reduce((a, b) => a + b, 0);
      out.top5.push(f.attacks ? top / f.attacks : 0);
      const hrs = Math.max(1, (w.end - w.start) / HOUR);
      out.perHour.push(f.attacks / hrs);
      if (w.end > out.lastEnd) { out.lastEnd = w.end; out.lastOpp = (o && o.name) || ''; }
    }
    const avg = xs => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
    this.d.summaries[fid] = {
      stale: false, wars: out.wars, wins: out.wins, losses: out.losses, avgHits: avg(out.hits), avgWin: avg(out.winHits), avgLoss: avg(out.lossHits),
      hitters: avg(out.hitters), top5: avg(out.top5), perHour: avg(out.perHour), lastOpp: out.lastOpp, lastEnd: out.lastEnd,
    };
  }

  // ---- What the app shows (and what the sync server sends) ----
  view() {
    const d = this.d;
    const L = d.ladder;
    const now = Date.now();
    const hourAgo = now - HOUR;
    let samplesLastHour = 0;
    for (const s of Object.values(d.sampled)) if (s[1] >= hourAgo) samplesLastHour++;
    let pending = 0;
    for (const fid of d.pool.ids) for (const wid of this.warsOf(fid)) if (!this.archive.has('rw', wid)) pending++;
    return {
      at: now, enabled: this.enabled(), local: this.local, perMinute: this.perMinute(), spread: this.spread(), error: this.error,
      own: L && L.own, ladderAt: L ? L.at : 0, ladderError: L ? L.error || '' : '', groups: L ? L.groups : [],
      indexAt: d.index.at, indexWars: Object.keys(d.index.wars).length,
      interval: this.interval(), samplesLastHour, pendingReports: pending,
      activity: this.activity.stats(), archive: this.archive.stats(),
      pool: d.pool.ids.map(id => {
        const m = d.pool.meta[id] || {};
        const s = d.sampled[id];
        return { id, name: m.name, rank: m.rank, position: m.position, members: m.members, lastWar: m.lastWar, running: !!m.running, firstAt: s ? s[0] : 0, sampledAt: s ? s[1] : 0, samples: s ? s[2] : 0, record: d.summaries[id] && d.summaries[id].wars != null ? d.summaries[id] : null };
      }),
      log: d.log.slice(-12),
    };
  }

  // Sync server: a lightweight, slowly-changing copy of the view for the app.
  get sync() {
    const self = this;
    return { get data() { return self.view(); }, get rev() { return self.viewRev; } };
  }

  applyRemote(view) {
    this.remoteView = view || null;
    this.emit('state');
  }

  snapshot() {
    if (this.remote()) return { ...(this.remoteView || {}), fromServer: true };
    return { ...this.view(), fromServer: false };
  }
}

module.exports = { ScoutFeature };

  },
  "features/targets.js": function (module, exports, require) {
'use strict';
// A list of players with their status and hospital/jail timers.
// Ported from torn-target-tracker.user.js. One /user/{id}?selections=profile request per
// target, one at a time, through the shared rate-limited queue.

const { EventEmitter } = require('events');

const MAX_TARGETS = 250;

function parseIds(text) {
  const ids = new Set();
  // Profile/attack URLs first, then bare numbers.
  for (const m of String(text).matchAll(/(?:XID|user2ID|ID)=(\d+)/gi)) ids.add(Number(m[1]));
  const rest = String(text).replace(/https?:\/\/\S+/gi, ' ');
  for (const m of rest.matchAll(/\b(\d{1,8})\b/g)) ids.add(Number(m[1]));
  return [...ids].filter(n => n > 0);
}

function idFromUrl(url) {
  const m = /[?&#](?:XID|user2ID)=(\d+)/i.exec(String(url));
  return m ? Number(m[1]) : 0;
}

// ---- Where a player is (the Abroad list) ----
// From Torn's status text: "In Japan" while abroad; flying "Traveling from Torn to Japan" /
// "Traveling from Japan to Torn" (older wording: "Traveling to Japan", "Returning to Torn from Japan").
const norm = s => String(s || '').trim().replace(/\.$/, '').toLowerCase();
const sameCountry = (a, b) => !!a && !!b && norm(a) === norm(b);
function countryIn(st) {
  if (!st || st.state !== 'Abroad') return '';
  const m = /^In (.+?)\.?$/i.exec(String(st.description || '').trim());
  return m ? m[1] : '';
}
function returningFrom(st) {
  if (!st || st.state !== 'Traveling') return '';
  const s = String(st.description || '').trim();
  const m = /^Traveling from (.+?) to Torn\.?$/i.exec(s) || /^Returning to Torn from (.+?)\.?$/i.exec(s);
  return m ? m[1] : '';
}
// Your country for the Abroad list: where you are abroad, or where you're flying to. '' in Torn
// (or on the way home). `u` is the user feature's data.
function herePlace(u) {
  if (!u) return '';
  const st = u.status || {};
  const tr = u.travel;
  const dest = tr && tr.destination && tr.destination !== 'Torn' ? tr.destination : '';
  if (st.state === 'Abroad') return dest || countryIn(st);
  if (st.state === 'Traveling') return dest;
  return '';
}
// Each entry is on the Targets list (home, the default) and/or the Abroad list (abroad: true).
const onList = (t, which) => (which === 'abroad' ? !!t.abroad : t.home !== false);

class TargetsFeature extends EventEmitter {
  constructor({ api, store, notify, here = () => '' }) {
    super();
    this.api = api;
    this.store = store;
    this.notify = notify;
    this.here = here; // your country for the Abroad list ('' in Torn)
    this.inFlight = false;
    this.queueNote = '';
    this.edges = {};
    this.lastHere = null;
    this.left = { country: '', count: 0, names: [] }; // who left your country (removed from Abroad)
  }

  list() {
    return this.store.get('targets.list') || {};
  }

  save(list) {
    this.store.set('targets.list', list);
    this.emit('state');
  }

  update(id, fn) {
    const list = this.list();
    if (!list[id]) return;
    fn(list[id]);
    this.save(list);
  }

  snapshot() {
    return { targets: Object.values(this.list()), queue: this.queueNote, here: this.here(), left: this.left };
  }

  add(text) {
    const ids = parseIds(text);
    const list = this.list();
    // Entries are keyed by player ID, so nobody is ever listed twice: someone already on the list
    // is only checked again (and counted as `already`).
    let added = 0, already = 0;
    for (const id of ids) {
      if (list[id]) {
        list[id].force = true;
        if (list[id].home === false) { list[id].home = true; added++; } else already++; // was only on the Abroad list
        continue;
      }
      if (Object.keys(list).length >= MAX_TARGETS) break;
      list[id] = { id, name: '', level: 0, status: null, life: null, lastFetched: 0, force: true, invalid: false, error: '', addedAt: Date.now() };
      added++;
    }
    this.save(list);
    return { added, already, found: ids.length };
  }

  // Players from a list on a Torn page (right-click "Add all players in this list", main.js), with
  // the name and level the list showed so they read right before their first refresh. `from` marks
  // them ('list') so they can be removed together; players already on the list keep their own
  // entry and aren't marked. which = 'home' (Targets) or 'abroad' (the Abroad list).
  addPlayers(players, from = '', which = 'home') {
    const list = this.list();
    let added = 0, full = false;
    for (const p of players) {
      const id = Number(p && p.id);
      if (!Number.isInteger(id) || id <= 0) continue;
      const t = list[id];
      if (t) {
        t.force = true;
        if (!onList(t, which)) { if (which === 'abroad') t.abroad = true; else t.home = true; added++; }
        continue;
      }
      if (Object.keys(list).length >= MAX_TARGETS) { full = true; break; }
      const base = { id, name: String(p.name || '').slice(0, 40), level: Math.max(0, Math.min(100, Number(p.level) || 0)), status: null, life: null, lastFetched: 0, force: true, invalid: false, error: '', addedAt: Date.now() };
      list[id] = which === 'abroad' ? { ...base, home: false, abroad: true } : { ...base, from };
      added++;
    }
    this.save(list);
    return { added, found: players.length, full };
  }

  // Take an entry off one list; it's deleted once it's on neither.
  drop(list, id, which) {
    const t = list[id];
    if (!t) return false;
    if (which === 'abroad') t.abroad = false; else t.home = false;
    if (!t.abroad && t.home === false) { delete list[id]; delete this.edges[id]; }
    return true;
  }

  removeFrom(from) {
    const list = this.list();
    let removed = 0;
    for (const [id, t] of Object.entries(list)) if (from && t.from === from && onList(t, 'home') && this.drop(list, id, 'home')) removed++;
    this.save(list);
    return { removed };
  }

  addFromUrl(url) {
    const id = idFromUrl(url);
    if (!id) return { added: 0, found: 0 };
    return this.add(String(id));
  }

  remove(id, which = 'home') {
    const list = this.list();
    this.drop(list, id, which === 'abroad' ? 'abroad' : 'home');
    this.save(list);
  }

  clear(which = 'home') {
    const list = this.list();
    for (const [id, t] of Object.entries(list)) if (onList(t, which)) this.drop(list, id, which);
    this.save(list);
  }

  refresh(id) {
    this.update(id, t => { t.force = true; t.invalid = false; });
  }

  refreshAll() {
    const list = this.list();
    for (const t of Object.values(list)) { t.force = true; t.invalid = false; }
    this.save(list);
  }

  isDue(t, s, now) {
    if (t.invalid) return false;
    if (t.force || !t.lastFetched) return true;
    // As short as 3 s (the user's request, 2026-11-21); each refresh is one request per target, so the
    // Targets tab shows the calls a minute this costs. The shared queue still keeps to your limit.
    return s.autoRefresh && now - t.lastFetched >= Math.max(3, s.interval || 120) * 1000;
  }

  tick(now) {
    const s = this.store.get('targets') || {};
    // You arrived somewhere (or set off): check everyone on the Abroad list again.
    const here = this.here();
    if (here !== this.lastHere) {
      if (this.lastHere !== null && here) {
        const all = this.list();
        for (const t of Object.values(all)) if (t.abroad) t.force = true;
        this.save(all);
      }
      if (!sameCountry(here, this.left.country)) this.left = { country: here, count: 0, names: [] };
      this.lastHere = here;
      this.emit('state');
    }
    const list = this.list();

    // Hospital/jail timers that ran out locally: notify once, and re-check if auto refresh is on.
    for (const t of Object.values(list)) {
      const st = t.status;
      if (!st) { delete this.edges[t.id]; continue; }
      const free = (st.state === 'Okay' || ((st.state === 'Hospital' || st.state === 'Jail') && st.until > 0 && st.until <= now));
      const prev = this.edges[t.id];
      this.edges[t.id] = free;
      if (prev === false && free) {
        if (s.notify) this.notify(`${t.name || '#' + t.id} is out`, st.state === 'Okay' ? 'Status: Okay' : `${st.state} timer ended`, `https://www.torn.com/profiles.php?XID=${t.id}`, 'targets');
        if (s.autoRefresh && st.state !== 'Okay') this.update(t.id, x => { x.force = true; });
      }
    }

    let note = '';
    const due = Object.values(this.list()).filter(t => this.isDue(t, s, now))
      .sort((a, b) => ((a.force || !a.lastFetched ? 0 : 1) - (b.force || !b.lastFetched ? 0 : 1)) || (a.lastFetched || 0) - (b.lastFetched || 0));
    if (!this.api.hasKey()) note = '';
    else if (this.inFlight) note = due.length > 1 ? `Refreshing… ${due.length - 1} queued` : 'Refreshing…';
    else if (due.length) {
      this.fetch(due[0].id);
      note = due.length > 1 ? `Refreshing… ${due.length - 1} queued` : 'Refreshing…';
    }
    if (note !== this.queueNote) {
      this.queueNote = note;
      this.emit('state');
    }
  }

  async fetch(id) {
    this.inFlight = true;
    try {
      const d = await this.api.request(`/user/${id}?selections=profile`, { soft: [6, 7], priority: 6 });
      this.emit('profile', id, d); // its picture, for the avatars
      let leaving = false;
      this.update(id, t => {
        t.name = d.name;
        t.level = d.level;
        t.faction = d.faction && d.faction.faction_name ? d.faction.faction_name : '';
        t.status = { state: d.status.state, description: d.status.description, until: (d.status.until || 0) * 1000 };
        t.life = d.life ? { current: d.life.current, maximum: d.life.maximum } : null;
        t.lastAction = d.last_action ? { status: d.last_action.status, relative: d.last_action.relative } : null;
        t.lastFetched = Date.now();
        t.force = false;
        t.invalid = false;
        t.error = '';
        // Where they are: the country they were last seen in (a hospital stay abroad keeps it).
        const was = t.lastIn || '';
        const nowIn = countryIn(t.status);
        if (nowIn) t.lastIn = nowIn;
        else if (t.status.state !== 'Hospital') t.lastIn = '';
        // Left the country you're in: off the Abroad list (the user's rule, 2026-11-21).
        const here = this.here();
        if (t.abroad && here && t.status.state !== 'Hospital' && !sameCountry(nowIn, here)
          && (sameCountry(was, here) || sameCountry(returningFrom(t.status), here))) leaving = true;
      });
      if (leaving) {
        const list = this.list();
        const t = list[id];
        if (t && this.drop(list, id, 'abroad')) {
          const here = this.here();
          if (!sameCountry(this.left.country, here)) this.left = { country: here, count: 0, names: [] };
          this.left = { country: here, count: this.left.count + 1, names: [t.name || `#${id}`, ...this.left.names].slice(0, 5) };
          this.save(list);
        }
      }
    } catch (e) {
      if (e.kind === 'soft') this.update(id, t => { t.invalid = true; t.force = false; t.error = e.message; t.lastFetched = Date.now(); });
      else if (e.kind === 'paused' || e.kind === 'network' || e.kind === 'backoff') { /* the API banner explains it; retry later */ }
    } finally {
      this.inFlight = false;
    }
  }
}

module.exports = { TargetsFeature, parseIds, idFromUrl, herePlace, countryIn };

  },
  "features/travel.js": function (module, exports, require) {
'use strict';
// Travel planning data:
// - Abroad shop stock from YATA's public export (https://yata.yt/api/v1/travel/export/),
//   polled every 2 minutes (one small request covers all countries). Readings are kept
//   locally for 4 days so the app can learn each item's restock rhythm (see restock.js).
// - Your carry capacity from /v2/user/travelinventory (Limited key).
// - Flight times: standard table, replaced by your own measured flights as you travel.
//
// YATA is the only non-Torn service this module contacts, and it never receives your key.

const path = require('path');
const { EventEmitter } = require('events');
const { Store } = require('../store');
const { addReading, analyzeCountry } = require('../restock');

const YATA_URL = 'https://yata.yt/api/v1/travel/export/';
const YATA_EVERY = 2 * 60 * 1000;
// While you have a restock alert on, this device reads YATA every 10 s itself (also when a sync
// server collects stock), so restocks of the items you watch show up within seconds. YATA's own
// data comes from players in each country and is usually under a minute old. After an error
// (e.g. YATA's rate limit) it waits the normal 2 minutes before trying again.
const YATA_FAST = 10 * 1000;
const YATA_BACKOFF = 2 * 60 * 1000;
const YATA_MIN_MANUAL = 30 * 1000;
const HISTORY_KEEP = 4 * 86400 * 1000;
const CAPACITY_EVERY = 6 * 3600 * 1000;

// "Private" is the WLT benefit (that's how the Travel Agent and the API name it).
const METHODS = ['Standard', 'Airstrip', 'Private', 'Business'];
// One-way flight minutes for Standard / Airstrip / WLT / Business, and the Standard ticket
// price, from the Torn wiki Travel page (Nov 2026). Real flights vary by up to 3%; the app
// also measures your own flights and prefers those. Airstrip and WLT flights are free;
// Business Class uses one Business Class Ticket.
const COUNTRIES = [
  { code: 'mex', name: 'Mexico', times: [24, 17, 12, 7], ticket: 6500 },
  { code: 'cay', name: 'Cayman Islands', times: [33, 23, 17, 10], ticket: 10000 },
  { code: 'can', name: 'Canada', times: [39, 27, 19, 12], ticket: 9000 },
  { code: 'haw', name: 'Hawaii', times: [127, 89, 63, 38], ticket: 11000 },
  { code: 'uni', name: 'United Kingdom', times: [151, 106, 75, 45], ticket: 18000 },
  { code: 'arg', name: 'Argentina', times: [158, 111, 79, 47], ticket: 21000 },
  { code: 'swi', name: 'Switzerland', times: [166, 116, 83, 50], ticket: 27000 },
  { code: 'jap', name: 'Japan', times: [213, 149, 107, 64], ticket: 32000 },
  { code: 'chi', name: 'China', times: [229, 160, 114, 69], ticket: 35000 },
  { code: 'uae', name: 'UAE', times: [257, 180, 128, 77], ticket: 32000 },
  { code: 'sou', name: 'South Africa', times: [282, 197, 141, 85], ticket: 40000 },
];
const BY_NAME = Object.fromEntries(COUNTRIES.map(c => [c.name, c]));

class TravelFeature extends EventEmitter {
  constructor({ api, store, dataDir, capacity = true }) {
    super();
    this.capacity = capacity; // the sync server has no use for your carry capacity
    // True while a sync server polls YATA instead of this PC (set by main.js).
    this.remote = () => false;
    // Abroad items with restock alerts ("<code>:<id>"), set by core.js; any = poll YATA fast.
    this.watchKeys = () => null;
    this.yataErrorAt = 0;
    this.lastStateEmit = 0;
    this.lastStocks = null; // the last YATA export this device read (re-applied over a server copy)
    this.api = api;
    this.store = store;
    this.history = new Store(path.join(dataDir, 'travel-history.json'), { countries: {} }, { debounceMs: 120000 });
    this.yataInFlight = false;
    this.lastYata = 0;
    this.capInFlight = false;
    this.lastCapacityTry = 0;
    this.state = { fetchedAt: 0, error: '', countries: [] };
    this.rebuild(Date.now());
  }

  // ---- Flights measured from your own travel ----
  learnFlight({ destination, method, minutes }) {
    const c = BY_NAME[destination];
    method = METHODS.find(m => String(method).toLowerCase().startsWith(m.toLowerCase())) || '';
    if (!c || !method || !(minutes > 3 && minutes < 400)) return;
    this.store.set(`travel.learned.${c.code}|${method}`, Math.round(minutes * 10) / 10);
    this.store.set('travel.lastMethod', method);
    this.emit('state');
  }

  // ---- YATA ----
  refresh() {
    if (Date.now() - this.lastYata >= YATA_MIN_MANUAL) this.lastYata = 0;
  }

  // Restock alerts want fast readings: the watched items, or null.
  fastKeys() {
    const k = this.watchKeys();
    return k && k.size && this.store.get('travel.yata') ? k : null;
  }

  async fetchYata(now) {
    this.yataInFlight = true;
    this.lastYata = now;
    const watched = this.fastKeys();
    const before = watched ? this.quantities(watched) : '';
    try {
      const res = await fetch(YATA_URL, { signal: AbortSignal.timeout(20000), headers: { Accept: 'application/json', 'User-Agent': 'Mentat' } });
      if (res.status === 429) throw new Error('YATA rate limit reached');
      if (!res.ok) throw new Error(`YATA returned HTTP ${res.status}`);
      const d = await res.json();
      if (!d || !d.stocks) throw new Error('Unexpected YATA response');
      this.record(d.stocks);
      this.lastStocks = d.stocks;
      this.state.error = '';
      this.state.fetchedAt = Date.now();
      this.state.yataTimestamp = (d.timestamp || 0) * 1000;
    } catch (e) {
      this.yataErrorAt = Date.now();
      this.state.error = e.name === 'TimeoutError' ? 'YATA timed out' : e.message || 'Could not reach YATA';
    } finally {
      this.yataInFlight = false;
      this.rebuild(Date.now());
      this.state.fast = !!watched;
      // Restock alerts look at every reading; the page is redrawn only when a watched item changed
      // (or every 2 minutes as before), so a fast poll doesn't redraw Travel every 10 s.
      this.emit('readings');
      const t = Date.now();
      if (!watched || this.quantities(watched) !== before || this.state.error || t - this.lastStateEmit >= YATA_EVERY) {
        this.lastStateEmit = t;
        this.emit('state');
      }
    }
  }

  // The watched items' latest quantities, as one comparable string.
  quantities(keys) {
    const out = [];
    for (const key of keys) {
      const [code, id] = key.split(':');
      const c = this.state.countries.find(x => x.code === code);
      const i = c && c.items.find(x => x.id === Number(id));
      out.push(`${key}=${i ? i.quantity : '-'}`);
    }
    return out.join(',');
  }

  record(stocks) {
    const now = Date.now();
    const hc = this.history.data.countries;
    for (const c of COUNTRIES) {
      const s = stocks[c.code];
      if (!s || !Array.isArray(s.stocks)) continue;
      const h = hc[c.code] || (hc[c.code] = { update: 0, items: {}, meta: {} });
      const t = (s.update || 0) * 1000;
      if (t < h.update) continue; // older than what's here (e.g. a server copy that arrived since)
      h.latest = s.stocks.map(i => ({ id: i.id, name: i.name, quantity: i.quantity, cost: i.cost }));
      if (t === h.update) continue; // no new reading for this country
      h.update = t;
      if (!h.since) h.since = t;
      for (const i of s.stocks) {
        // Runs of equal readings: [firstSeen, quantity, lastSeen] (see restock.js).
        const runs = h.items[i.id] || (h.items[i.id] = []);
        addReading(runs, t, i.quantity);
        while (runs.length && now - (runs[0][2] ?? runs[0][0]) > HISTORY_KEEP) runs.shift();
      }
      if (now - h.since > HISTORY_KEEP) h.since = now - HISTORY_KEEP;
    }
    this.history.save();
  }

  rebuild(now) {
    const hc = this.history.data.countries;
    this.state.countries = COUNTRIES.map(c => {
      const h = hc[c.code];
      if (!h || !h.latest) return { code: c.code, name: c.name, update: 0, items: [] };
      const a = analyzeCountry(h.items, now);
      return {
        code: c.code,
        name: c.name,
        update: h.update,
        since: h.since || 0,
        cadence: a.cadence,
        restocksSeen: a.pooledRestocks,
        items: h.latest.map(i => ({ ...i, stats: a.stats[i.id] || null })),
      };
    });
  }

  // The sync server's stock history replaces this PC's copy (it polls YATA 24/7).
  applyRemote(data, meta = {}) {
    this.history.data = { countries: (data && data.countries) || {} };
    // Fresher readings this device took itself (fast polling for restock alerts) stay on top.
    if (this.lastStocks && this.fastKeys()) this.record(this.lastStocks);
    this.history.save();
    if (meta.fetchedAt) this.state.fetchedAt = meta.fetchedAt;
    if (meta.yataTimestamp) this.state.yataTimestamp = meta.yataTimestamp;
    this.state.error = meta.error || '';
    this.rebuild(Date.now());
    this.emit('state');
  }

  // Stock readings as chart points (each run drawn from its first to its last reading).
  stockHistory(code, id) {
    const h = this.history.data.countries[code];
    const runs = h && h.items[id] ? h.items[id] : [];
    const pts = [];
    for (const r of runs) {
      pts.push([r[0], r[1]]);
      if (r[2] !== undefined && r[2] !== r[0]) pts.push([r[2], r[1]]);
    }
    return pts;
  }

  // The flight method Travel uses (auto = your last flight's) and one-way minutes for it: your
  // override, else your measured flight, else the wiki table (−25% with the travel book). Same rules
  // as the page's travelModel; used by restock alerts ("time to leave").
  method() {
    const m = this.store.get('travel.method');
    return METHODS.includes(m) ? m : this.store.get('travel.lastMethod') || 'Standard';
  }

  flightMinutes(code, method = this.method()) {
    const key = `${code}|${method}`;
    const o = this.store.get('travel.override') || {};
    if (o[key]) return o[key];
    const l = this.store.get('travel.learned') || {};
    if (l[key]) return l[key];
    const c = COUNTRIES.find(x => x.code === code);
    return c ? c.times[Math.max(0, METHODS.indexOf(method))] * (this.store.get('travel.book') ? 0.75 : 1) : 0;
  }

  // ---- Capacity ----
  async fetchCapacity(now) {
    this.capInFlight = true;
    this.lastCapacityTry = now;
    try {
      const d = await this.api.request('/v2/user/travelinventory', { soft: [16], priority: 7 });
      const cap = (d.travelinventory && d.travelinventory.capacity) || {};
      this.store.set('travel.capacityApi', { base: cap.base || 0, special: cap.special || 0, fetchedAt: Date.now() });
    } catch (e) {
      if (e.kind === 'soft') this.store.set('travel.capacityApi', { denied: true, fetchedAt: Date.now() });
    } finally {
      this.capInFlight = false;
      this.emit('state');
    }
  }

  refreshCapacity() {
    this.lastCapacityTry = 0;
    this.store.set('travel.capacityApi', null);
  }

  tick(now) {
    const fast = !!this.fastKeys() && now - this.yataErrorAt >= YATA_BACKOFF;
    if ((fast || !this.remote()) && this.store.get('travel.yata') && !this.yataInFlight && now - this.lastYata >= (fast ? YATA_FAST : YATA_EVERY)) this.fetchYata(now);
    const cap = this.store.get('travel.capacityApi');
    if (this.capacity && this.api.hasKey() && !this.capInFlight && (!cap || now - cap.fetchedAt > CAPACITY_EVERY) && now - this.lastCapacityTry > 10 * 60 * 1000) this.fetchCapacity(now);
  }

  snapshot() {
    return {
      ...this.state,
      fromServer: this.remote(),
      countriesMeta: COUNTRIES,
      methods: METHODS,
      learned: this.store.get('travel.learned') || {},
      lastMethod: this.store.get('travel.lastMethod') || '',
      capacityApi: this.store.get('travel.capacityApi'),
    };
  }

  flush() {
    this.history.flush();
  }
}

module.exports = { TravelFeature, COUNTRIES, METHODS };

  },
  "features/user.js": function (module, exports, require) {
'use strict';
// Your own status: bars, cooldowns, travel, refills and unread notifications.
// One v1 request per interval (default 60s). Timers are kept as absolute end times, so the
// UI counts down and desktop alerts fire locally without any extra requests.

const { EventEmitter } = require('events');

const FULL = '/user/?selections=basic,bars,cooldowns,travel,refills,notifications,timestamp';
const BASIC = '/user/?selections=basic,timestamp';
const LIMITED_RETRY_MS = 3600 * 1000;
const ARM_MS = 5000;

class UserFeature extends EventEmitter {
  constructor({ api, store, notify }) {
    super();
    this.api = api;
    this.store = store;
    this.notify = notify;
    this.inFlight = false;
    this.lastAttempt = 0;
    this.limitedAt = 0;
    this.edges = {};
    this.state = { data: null, limited: false, fetchedAt: 0, error: '' };
    api.on('key', () => this.reset());
  }

  reset() {
    this.state = { data: null, limited: false, fetchedAt: 0, error: '' };
    this.edges = {};
    this.lastAttempt = 0;
    this.limitedAt = 0;
    this.emit('state');
  }

  snapshot() {
    return this.state;
  }

  meId() {
    return this.state.data ? this.state.data.me.id : (this.store.get('api.account') || {}).id || 0;
  }

  refresh() {
    this.lastAttempt = 0;
  }

  tick(now) {
    if (!this.api.hasKey()) return;
    this.checkAlerts(now);
    const every = Math.max(30, Number(this.store.get('user.interval')) || 60) * 1000;
    if (this.inFlight || now - this.lastAttempt < every) return;
    this.fetch(now);
  }

  async fetch(now) {
    this.inFlight = true;
    this.lastAttempt = now;
    const limited = this.limitedAt && now - this.limitedAt < LIMITED_RETRY_MS;
    try {
      const data = await this.api.request(limited ? BASIC : FULL, { soft: [16], priority: 3 });
      this.apply(data, !!limited);
    } catch (e) {
      if (e.kind === 'soft' && e.code === 16) {
        // Public key: only basic info is allowed. Try again with that straight away.
        this.limitedAt = now;
        this.lastAttempt = 0;
      } else if (e.kind !== 'paused' && e.kind !== 'nokey') {
        this.state.error = e.message;
        this.emit('state');
      }
    } finally {
      this.inFlight = false;
    }
  }

  apply(d, limited) {
    // Torn's clock and this PC's clock differ by a second or so. Timers come back as "seconds
    // left", so anchor them to the local time the response arrived; absolute server times
    // (status.until) are shifted by the measured offset. Otherwise a cooldown that is already
    // over can look like it ends a moment from now and then "end" on the next tick.
    const at = Date.now();
    const skew = d.timestamp ? d.timestamp * 1000 - at : 0;
    const local = t => (t ? t * 1000 - skew : 0);
    const bar = b => b && {
      current: b.current || 0,
      maximum: b.maximum || 0,
      tickAt: at + (b.ticktime || 0) * 1000,
      fullAt: at + (b.fulltime || 0) * 1000,
      increment: b.increment || 0, // per tick (the Planner projects bars with these)
      interval: b.interval || 0,   // seconds between ticks
    };
    const s = d.status || {};
    const cd = d.cooldowns || {};
    const tr = d.travel;
    const rf = d.refills;
    const n = d.notifications;
    const prev = this.state.data;

    // Measure real flight times for the travel planner (outbound flights only: on the way
    // home the API says "Torn" and not where you flew from).
    if (tr && tr.destination && tr.destination !== 'Torn' && tr.departed && tr.timestamp > tr.departed && tr.method) {
      const key = `${tr.departed}`;
      if (key !== this.lastFlightKey) {
        this.lastFlightKey = key;
        this.emit('flight', { destination: tr.destination, method: tr.method, minutes: (tr.timestamp - tr.departed) / 60 });
      }
    }

    this.state = {
      limited,
      fetchedAt: Date.now(),
      error: '',
      data: {
        me: { id: d.player_id || 0, name: d.name || '', level: d.level || 0 },
        status: { state: s.state || '', description: s.description || '', details: s.details || '', color: s.color || '', until: local(s.until) },
        bars: limited ? null : { energy: bar(d.energy), nerve: bar(d.nerve), happy: bar(d.happy), life: bar(d.life) },
        cooldowns: limited ? null : { drug: at + (cd.drug || 0) * 1000, booster: at + (cd.booster || 0) * 1000, medical: at + (cd.medical || 0) * 1000 },
        travel: tr && tr.destination ? { destination: tr.destination, method: tr.method || '', arriveAt: at + (tr.time_left || 0) * 1000, departedAt: local(tr.departed), departed: tr.departed || 0 } : null,
        refills: rf ? { energy: !!rf.energy_refill_used, nerve: !!rf.nerve_refill_used, token: !!rf.token_refill_used } : null,
        notifications: n ? { messages: n.messages || 0, events: n.events || 0, awards: n.awards || 0 } : null,
      },
    };

    // New events/messages since the last check.
    const on = this.store.get('user.notify') || {};
    const pn = prev && prev.notifications;
    const nn = this.state.data.notifications;
    if (pn && nn) {
      if (on.events && nn.events > pn.events) this.notify('Torn: new events', `${nn.events} unread event${nn.events === 1 ? '' : 's'}`, 'https://www.torn.com/events.php', 'events');
      if (on.messages && nn.messages > pn.messages) this.notify('Torn: new messages', `${nn.messages} unread message${nn.messages === 1 ? '' : 's'}`, 'https://www.torn.com/messages.php', 'messages');
    }
    this.checkAlerts(Date.now());
    this.emit('state');
  }

  // Fires once when a timer runs out, and only for a timer that was seen actually counting
  // down (more than ARM_MS left). Timers that are already over, or within a moment of it,
  // when the app starts never alert.
  timer(name, endAt, now, fire) {
    if (endAt > now) {
      if (endAt - now > ARM_MS) this.edges[name] = true;
      return;
    }
    if (this.edges[name]) {
      this.edges[name] = false;
      fire();
    }
  }

  checkAlerts(now) {
    const d = this.state.data;
    if (!d) return;
    const on = this.store.get('user.notify') || {};
    const ping = (flag, title, body, url) => () => on[flag] && this.notify(title, body, url, flag);

    if (d.bars) {
      const fullAt = b => (!b || b.current >= b.maximum ? 0 : b.fullAt);
      this.timer('energy', fullAt(d.bars.energy), now, ping('energy', 'Energy full', `${d.bars.energy.maximum} energy`, 'https://www.torn.com/gym.php'));
      this.timer('nerve', fullAt(d.bars.nerve), now, ping('nerve', 'Nerve full', `${d.bars.nerve.maximum} nerve`, 'https://www.torn.com/page.php?sid=crimes'));
    }
    if (d.cooldowns) {
      this.timer('drug', d.cooldowns.drug, now, ping('drug', 'Drug cooldown over', 'You can take another drug.', 'https://www.torn.com/item.php'));
      this.timer('booster', d.cooldowns.booster, now, ping('booster', 'Booster cooldown over', 'You can use another booster.', 'https://www.torn.com/item.php'));
      this.timer('medical', d.cooldowns.medical, now, ping('medical', 'Medical cooldown over', 'You can use medical items again.', 'https://www.torn.com/item.php'));
    }
    this.timer('landed', d.travel ? d.travel.arriveAt : 0, now, ping('travel', 'Landed', d.travel ? `You have arrived in ${d.travel.destination}.` : 'You have landed.', 'https://www.torn.com/index.php'));
    const st = d.status;
    const locked = st.state === 'Hospital' || st.state === 'Jail';
    this.timer('released', locked ? st.until : 0, now, ping('hospital', st.state === 'Jail' ? 'Out of jail' : 'Out of hospital', 'Your timer has run out.', 'https://www.torn.com/index.php'));
  }
}

module.exports = { UserFeature };

  },
  "features/war.js": function (module, exports, require) {
'use strict';
// War tools: your faction's current wars (ranked, raids, territory) with live scores, and a
// status board for the enemy faction's members (and your own). Official API v2 only:
//   /v2/faction/basic          your faction (once in a while)
//   /v2/faction/wars           wars + scores (every 30 s in a war, 5 min otherwise)
//   /v2/faction/{id}/members   enemy members' status (every war.interval s)
//   /v2/faction/members        your members' status
//   /v2/faction/{id}/basic     a watched faction's name/rank (once)
// Outside a war, members are only fetched while the War tab is open.

const path = require('path');
const { EventEmitter } = require('events');
const { Store } = require('../store');
const { COUNTRIES, METHODS } = require('./travel');

// ---- Travel estimates for other players ----
// The API doesn't say when someone lands, but it gives the destination ("Traveling from Torn
// to Mexico" / "Traveling from Mexico to Torn"; older wording "Traveling to Mexico" /
// "Returning to Torn from Mexico") and the plane: private jet = WLT, light
// aircraft = Airstrip, airliner = Standard or Business class. With the wiki flight times
// (or your own measured ones) that gives the flight length; the departure is caught when
// someone switches to Traveling between two checks. Flights vary ±3%, and a travel book
// can make them up to 25% shorter, so the earliest landing allows for that.
const PLANE_METHODS = { private_jet: ['Private'], light_aircraft: ['Airstrip'], airliner: ['Business', 'Standard'] };
const COUNTRY_BY_NAME = new Map(COUNTRIES.map(c => [c.name.toLowerCase(), c]));
COUNTRY_BY_NAME.set('united arab emirates', COUNTRY_BY_NAME.get('uae'));
COUNTRY_BY_NAME.set('cayman', COUNTRY_BY_NAME.get('cayman islands'));
function parseTrip(desc) {
  const s = String(desc || '').trim();
  // Torn's wording since 2026 (seen in war data 2026-11-21): "Traveling from Torn to Japan",
  // "Traveling from Japan to Torn". The flight's country is the end that isn't Torn.
  let m = /^Traveling from (.+?) to (.+?)\.?$/i.exec(s);
  if (m) {
    const back = m[2].toLowerCase() === 'torn';
    return { country: COUNTRY_BY_NAME.get((back ? m[1] : m[2]).toLowerCase()), back };
  }
  m = /^Traveling to (.+?)\.?$/i.exec(s);
  if (m) return { country: COUNTRY_BY_NAME.get(m[1].toLowerCase()), back: false };
  m = /^Returning to Torn from (.+?)\.?$/i.exec(s);
  if (m) return { country: COUNTRY_BY_NAME.get(m[1].toLowerCase()), back: true };
  return null;
}
function flightRange(country, plane, learned) {
  const methods = PLANE_METHODS[plane] || METHODS;
  const mins = methods.map(meth => (learned && learned[`${country.code}|${meth}`]) || country.times[METHODS.indexOf(meth)]);
  return { lo: Math.min(...mins) * 60e3, hi: Math.max(...mins) * 60e3 * 1.03, methods };
}
const METHOD_LABEL = { Private: 'WLT', Airstrip: 'Airstrip', Standard: 'Standard', Business: 'Business' };

const SEC = 1000;
const BASIC_EVERY = 6 * 3600 * SEC;
const WARS_ACTIVE = 30 * SEC;
const WARS_IDLE = 300 * SEC;
const UPCOMING_WINDOW = 24 * 3600 * SEC; // poll faster this close to a ranked war start
const MAX_POINTS = 4000;
const NO_FACTION = [6, 7];

const fresh = now => `timestamp=${Math.floor(now / 1000)}`;

function member(m) {
  const st = m.status || {};
  const la = m.last_action || {};
  return {
    id: m.id,
    name: m.name || `#${m.id}`,
    level: m.level || 0,
    position: m.position || '',
    days: m.days_in_faction || 0,
    revivable: !!m.is_revivable,
    reviveSetting: m.revive_setting && m.revive_setting !== 'Unknown' ? m.revive_setting : '', // own faction, with permissions
    earlyDischarge: !!m.has_early_discharge,
    onWall: !!m.is_on_wall,
    state: st.state || '',
    description: st.description || '',
    details: st.details || '',
    until: (st.until || 0) * 1000,
    color: st.color || '',
    plane: st.plane_image_type || '',
    last: la.status || 'Offline',
    lastAt: (la.timestamp || 0) * 1000,
    lastRel: la.relative || '',
  };
}

// Counts used for the summary tiles and the availability chart.
function counts(members, now) {
  const c = { total: members.length, okay: 0, hospital: 0, jail: 0, travel: 0, abroad: 0, other: 0, online: 0, idle: 0, out5: 0, out15: 0, land15: 0 };
  for (const m of members) if (m.trip && m.trip.seen && m.trip.landHi - now <= 15 * 60e3) c.land15++;
  for (const m of members) {
    if (m.last === 'Online') c.online++;
    else if (m.last === 'Idle') c.idle++;
    if (m.state === 'Okay') c.okay++;
    else if (m.state === 'Hospital') {
      c.hospital++;
      if (m.until - now <= 5 * 60 * SEC) c.out5++;
      if (m.until - now <= 15 * 60 * SEC) c.out15++;
    } else if (m.state === 'Jail') c.jail++;
    else if (m.state === 'Traveling') c.travel++;
    else if (m.state === 'Abroad') c.abroad++;
    else c.other++;
  }
  return c;
}

class WarFeature extends EventEmitter {
  constructor({ api, store, dataDir }) {
    super();
    this.api = api;
    this.store = store;
    this.db = new Store(path.join(dataDir, 'war.json'), { history: null, trips: {}, abroad: {} }, { debounceMs: 15000 });
    this.lastSeen = new Map(); // member id -> { state, desc, at } from the previous check
    this.inFlight = false;
    this.last = { basic: 0, wars: 0, enemy: 0, ours: 0, enemyBasic: 0, enemyChain: 0, myStats: 0 };
    this.state = { own: null, noFaction: false, wars: null, enemy: null, ours: null, enemyChain: null, myStats: null, error: '' };
    api.on('key', () => this.reset());
  }

  reset() {
    this.last = { basic: 0, wars: 0, enemy: 0, ours: 0, enemyBasic: 0, enemyChain: 0, myStats: 0 };
    this.state = { own: null, noFaction: false, wars: null, enemy: null, ours: null, enemyChain: null, myStats: null, error: '' };
    this.emit('state');
  }

  // Pinned members (any faction): shown in their own list above the board.
  pinned() {
    return (this.store.get('war.pinned') || []).map(Number).filter(Boolean);
  }

  pin(id, on) {
    id = Math.floor(Number(id) || 0);
    if (!id) return;
    const set = new Set(this.pinned());
    if (on) set.add(id); else set.delete(id);
    this.store.set('war.pinned', [...set].slice(-500));
    this.emit('state');
  }

  flush() {
    this.db.flush();
  }

  refresh() {
    this.last = { ...this.last, wars: 0, enemy: 0, ours: 0, enemyChain: 0 };
  }

  // Watch a faction by ID (0 = follow your current war automatically).
  watch(id) {
    this.store.set('war.watchId', Math.max(0, Math.floor(Number(id) || 0)));
    this.state.enemy = null;
    this.state.enemyChain = null;
    this.last.enemy = 0;
    this.last.enemyBasic = 0;
    this.last.enemyChain = 0;
    this.emit('state');
  }

  interval() {
    return Math.max(15, Math.min(300, Number(this.store.get('war.interval')) || 30)) * SEC;
  }

  // Live mode (the user's request, 2026-11-21): during a war, while the War tab is on show (tools
  // window or a pop-out), the enemy's members refresh every war.live seconds (one request each,
  // with the cache-bypassing timestamp). 0 = off. Everything else keeps the normal interval.
  liveOn(now = Date.now()) {
    return !!(Number(this.store.get('war.live')) > 0 && this.inWar(now) && this.viewing && this.viewing('war'));
  }

  memberInterval(now = Date.now()) {
    if (!this.liveOn(now)) return this.interval();
    return Math.min(this.interval(), Math.max(3, Number(this.store.get('war.live'))) * SEC);
  }

  ranked() {
    return this.state.wars && this.state.wars.ranked;
  }

  // Ranked war phase: 'upcoming' (start in the future), 'active', 'ended' or null.
  phase(now = Date.now()) {
    const r = this.ranked();
    if (!r) return null;
    if (r.end && r.end <= now) return 'ended';
    if (r.start > now) return 'upcoming';
    return 'active';
  }

  inWar(now = Date.now()) {
    const p = this.phase(now);
    if (p === 'active') return true;
    const w = this.state.wars;
    return !!w && (w.raids.some(x => !x.end) || w.territory.some(x => !x.end));
  }

  // Which faction the enemy board shows, and why.
  enemyTarget() {
    const watch = Number(this.store.get('war.watchId')) || 0;
    if (watch) return { id: watch, source: 'watch' };
    const own = this.state.own && this.state.own.id;
    const w = this.state.wars;
    if (!w || !own) return null;
    const other = list => (list || []).find(f => f.id !== own);
    const r = w.ranked;
    if (r && (!r.end || Date.now() - r.end < 6 * 3600 * SEC)) {
      const f = other(r.factions);
      if (f) return { id: f.id, name: f.name, source: 'ranked' };
    }
    for (const x of w.raids) if (!x.end) { const f = other(x.factions); if (f) return { id: f.id, name: f.name, source: 'raid' }; }
    for (const x of w.territory) if (!x.end) { const f = other(x.factions); if (f) return { id: f.id, name: f.name, source: 'territory' }; }
    return null;
  }

  tick(now) {
    if (!this.api.hasKey() || this.inFlight) return;
    const job = this.nextJob(now);
    if (!job) return;
    this.inFlight = true;
    job.call(this, now).finally(() => { this.inFlight = false; });
  }

  nextJob(now) {
    if (now - this.last.basic >= (this.state.noFaction ? 3600 * SEC : BASIC_EVERY)) return this.fetchBasic;
    if (this.state.noFaction && !this.store.get('war.watchId')) return null;
    const p = this.phase(now);
    const r = this.ranked();
    const soon = p === 'upcoming' && r.start - now < UPCOMING_WINDOW;
    const warsEvery = this.inWar(now) || soon ? WARS_ACTIVE : WARS_IDLE;
    if (!this.state.noFaction && now - this.last.wars >= warsEvery) return this.fetchWars;
    // The War tab is open in the tools window or a pop-out window (main.js sets viewing).
    const looking = this.viewing ? this.viewing('war') : this.store.get('ui.panel') === 'war';
    // During a war (ranked, raid or territory) and the 24 hours before a ranked war, every
    // war refresh runs in the background whatever tab you're on (or if the window is closed
    // to the tray). Otherwise members/chains are only fetched while the War tab is open.
    const busy = this.inWar(now) || soon;
    const target = this.enemyTarget();
    if (target && (busy || looking)) {
      if (now - this.last.enemyBasic >= BASIC_EVERY && target.source === 'watch') return this.fetchEnemyBasic;
      if (now - this.last.enemy >= this.memberInterval(now)) return this.fetchEnemy;
      // The enemy's chain: as often as members during a war, less when just looking.
      if (now - this.last.enemyChain >= (busy ? this.interval() : 120 * SEC)) return this.fetchEnemyChain;
    }
    if (!this.state.noFaction && (busy || looking) && now - this.last.ours >= Math.max(60 * SEC, this.interval() * 2)) return this.fetchOurs;
    // Your own battle stats, to colour the enemy's estimated stats (Limited key).
    const statsEvery = this.state.myStats && this.state.myStats.denied ? 6 * 3600 * SEC : 30 * 60 * SEC;
    // (Oppo research also uses them while it's collecting.)
    const wanted = busy || looking || (this.statsWanted && this.statsWanted());
    if (wanted && now - this.last.myStats >= statsEvery) return this.fetchMyStats;
    return null;
  }

  async fetchEnemyChain(now) {
    this.last.enemyChain = now;
    const t = this.enemyTarget();
    if (!t) return;
    try {
      const d = await this.api.request(`/v2/faction/${t.id}/chain?${fresh(now)}`, { soft: [6, 7], priority: 3 });
      const c = d.chain || {};
      const cooldownUntil = (c.cooldown || 0) * 1000;
      this.state.enemyChain = {
        factionId: t.id, current: c.current || 0, max: c.max || 0, modifier: c.modifier || 1,
        expiresAt: now + (c.timeout || 0) * 1000, cooldown: cooldownUntil > now, cooldownUntil, fetchedAt: Date.now(),
      };
    } catch (e) {
      if (e.kind === 'soft') this.state.enemyChain = { factionId: t.id, current: 0, fetchedAt: Date.now(), none: true };
    }
    this.emit('state');
  }

  async fetchMyStats(now) {
    this.last.myStats = now;
    try {
      const d = await this.api.request('/v2/user/battlestats', { soft: [16], priority: 6 });
      const b = d.battlestats || {};
      const v = k => (b[k] && b[k].value) || 0;
      const total = b.total || v('strength') + v('defense') + v('speed') + v('dexterity');
      this.state.myStats = { total, strength: v('strength'), defense: v('defense'), speed: v('speed'), dexterity: v('dexterity'), fetchedAt: Date.now() };
    } catch (e) {
      if (e.kind === 'soft') this.state.myStats = { denied: true, fetchedAt: Date.now() };
    }
    this.emit('state');
  }

  async fetchBasic(now) {
    this.last.basic = now;
    try {
      const d = await this.api.request('/v2/faction/basic', { soft: NO_FACTION, priority: 5 });
      const b = d.basic || {};
      if (!b.id) { this.state.noFaction = true; this.state.own = null; }
      else {
        this.state.noFaction = false;
        this.state.own = { id: b.id, name: b.name || '', tag: b.tag || '', tagImage: b.tag_image || '', bannerImage: b.banner_image || '', rank: b.rank ? `${b.rank.name || ''} ${b.rank.division || ''}`.trim() : '', members: b.members || 0, respect: b.respect || 0 };
      }
    } catch (e) {
      if (e.kind === 'soft' && NO_FACTION.includes(e.code)) { this.state.noFaction = true; this.state.own = null; }
      else if (e.kind !== 'paused' && e.kind !== 'nokey') this.state.error = e.message;
    }
    this.emit('state');
  }

  async fetchWars(now) {
    this.last.wars = now;
    try {
      const d = await this.api.request(`/v2/faction/wars?${fresh(now)}`, { soft: NO_FACTION, priority: 2 });
      const w = d.wars || {};
      const ms = v => (v ? v * 1000 : 0);
      const fac = f => ({ id: f.id, name: f.name || `#${f.id}`, score: f.score || 0, chain: f.chain || 0, aggressor: !!f.is_aggressor });
      const r = w.ranked;
      this.state.wars = {
        ranked: r ? { id: r.war_id, start: ms(r.start), end: ms(r.end), target: r.target || 0, winner: r.winner || 0, factions: (r.factions || []).map(fac) } : null,
        raids: (w.raids || []).map(x => ({ id: x.war_id, start: ms(x.start), end: ms(x.end), factions: (x.factions || []).map(fac) })),
        territory: (w.territory || []).map(x => ({ id: x.war_id, territory: x.territory || '', start: ms(x.start), end: ms(x.end), target: x.target || 0, winner: x.winner || 0, factions: (x.factions || []).map(fac) })),
        pacts: (d.pacts || []).map(p => ({ id: p.faction_id, name: p.faction_name, until: ms(p.until) })),
        fetchedAt: Date.now(),
      };
      this.state.error = '';
      this.recordScore(now);
    } catch (e) {
      if (e.kind === 'soft' && NO_FACTION.includes(e.code)) this.state.noFaction = true;
      else if (e.kind !== 'paused' && e.kind !== 'nokey') this.state.error = e.message;
    }
    this.emit('state');
  }

  history() {
    return this.db.get('history');
  }

  // Score over time for the ranked war (kept per war; a new war starts a new history).
  recordScore(now) {
    const r = this.ranked();
    const own = this.state.own;
    if (!r || !own || r.start > now) return;
    const us = r.factions.find(f => f.id === own.id);
    const them = r.factions.find(f => f.id !== own.id);
    if (!us || !them) return;
    let h = this.history();
    if (!h || h.warId !== r.id) h = { warId: r.id, points: [], avail: [] };
    const last = h.points[h.points.length - 1];
    if (r.end && last && last[0] >= r.end) return;
    if (!last || last[1] !== us.score || last[2] !== them.score || now - last[0] > 10 * 60 * SEC) {
      h.points.push([now, us.score, them.score, r.target]);
      if (h.points.length > MAX_POINTS) h.points.splice(0, h.points.length - MAX_POINTS);
      this.db.set('history', h);
    }
  }

  async fetchEnemyBasic(now) {
    this.last.enemyBasic = now;
    const t = this.enemyTarget();
    if (!t) return;
    try {
      const d = await this.api.request(`/v2/faction/${t.id}/basic`, { soft: [6, 7], priority: 5 });
      const b = d.basic || {};
      this.enemyInfo = { id: t.id, name: b.name || '', tag: b.tag || '', tagImage: b.tag_image || '', bannerImage: b.banner_image || '', rank: b.rank ? `${b.rank.name || ''} ${b.rank.division || ''}`.trim() : '', respect: b.respect || 0, members: b.members || 0, bestChain: b.best_chain || 0 };
    } catch (e) {
      if (e.kind === 'soft') this.enemyInfo = { id: t.id, name: '', error: 'Faction not found' };
    }
    this.emit('state');
  }

  async fetchEnemy(now) {
    this.last.enemy = now;
    const t = this.enemyTarget();
    if (!t) return;
    try {
      const d = await this.api.request(`/v2/faction/${t.id}/members?striptags=true&${fresh(now)}`, { soft: [6, 7], priority: 2 });
      const members = (d.members || []).map(member);
      this.trackTravel(members, now);
      this.emit('members', t.id, members, now);
      const info = this.enemyInfo && this.enemyInfo.id === t.id ? this.enemyInfo : null;
      this.state.enemy = { id: t.id, name: (info && info.name) || t.name || `Faction ${t.id}`, source: t.source, info, members, counts: counts(members, now), fetchedAt: Date.now(), error: members.length ? '' : 'No members found' };
      this.recordAvailability(now, this.state.enemy.counts);
    } catch (e) {
      if (e.kind === 'soft') this.state.enemy = { id: t.id, name: t.name || `Faction ${t.id}`, source: t.source, members: [], counts: counts([], now), fetchedAt: Date.now(), error: 'Faction not found' };
      else if (e.kind !== 'paused' && e.kind !== 'nokey') this.state.error = e.message;
    }
    this.emit('state');
  }

  // Enemy availability over the war: okay / in hospital / online.
  recordAvailability(now, c) {
    const r = this.ranked();
    if (!r || this.phase(now) !== 'active') return;
    const h = this.history();
    if (!h || h.warId !== r.id) return;
    const last = h.avail[h.avail.length - 1];
    if (last && now - last[0] < 60 * SEC) return;
    h.avail.push([now, c.okay, c.hospital, c.online + c.idle, c.travel + c.abroad]);
    if (h.avail.length > MAX_POINTS) h.avail.splice(0, h.avail.length - MAX_POINTS);
    this.db.set('history', h);
  }

  async fetchOurs(now) {
    this.last.ours = now;
    try {
      const d = await this.api.request(`/v2/faction/members?striptags=true&${fresh(now)}`, { soft: [6, 7, 16], priority: 4 });
      const members = (d.members || []).map(member);
      this.trackTravel(members, now);
      if (this.state.own) this.emit('members', this.state.own.id, members, now);
      this.state.ours = { members, counts: counts(members, now), fetchedAt: Date.now() };
    } catch (e) {
      if (e.kind === 'soft') this.state.ours = { members: [], counts: counts([], now), fetchedAt: Date.now(), denied: true };
    }
    this.emit('state');
  }

  // Landing estimates for travellers (see the note at the top). Adds to each member:
  //   trip: { country, back, methods, landLo, landHi, seen }  while flying
  //   abroadSince: time they were first seen abroad after a flight we watched
  trackTravel(members, now) {
    const trips = this.db.get('trips') || {};
    const abroad = this.db.get('abroad') || {};
    const learned = this.store.get('travel.learned') || {};
    let changed = false;
    for (const m of members) {
      const prev = this.lastSeen.get(m.id);
      if (m.state === 'Traveling') {
        let t = trips[m.id];
        if (!t || t.desc !== m.description) {
          // A switch we saw: they left between the previous check and this one.
          const seen = prev && prev.state !== 'Traveling' && now - prev.at < 10 * 60e3;
          t = { desc: m.description, plane: m.plane, departLo: seen ? prev.at : 0, departHi: now };
          trips[m.id] = t;
          changed = true;
        }
        const p = parseTrip(m.description);
        if (p && p.country) {
          const f = flightRange(p.country, m.plane || t.plane, learned);
          const seen = !!t.departLo;
          const mid = seen ? (t.departLo + t.departHi) / 2 : 0;
          // One likely landing per possible method (an airliner could be Business or Standard).
          const options = seen ? f.methods.map(meth => ({ method: METHOD_LABEL[meth], at: mid + ((learned[`${p.country.code}|${meth}`]) || p.country.times[METHODS.indexOf(meth)]) * 60e3 })) : [];
          m.trip = {
            country: p.country.name, back: p.back, methods: f.methods.map(x => METHOD_LABEL[x]),
            // Earliest allows for a travel book (−25%); latest for the slowest likely method.
            landLo: seen ? t.departLo + f.lo * 0.75 * 0.97 : now,
            landHi: t.departHi + f.hi,
            options,
            // Soonest likely landing (used for sorting and "back next").
            expected: options.length ? Math.min(...options.map(o => o.at)) : 0,
            seen,
          };
        }
        if (abroad[m.id]) { delete abroad[m.id]; changed = true; }
      } else {
        if (trips[m.id]) {
          if (m.state === 'Abroad' && trips[m.id].departLo) { abroad[m.id] = { desc: m.description, since: now }; }
          delete trips[m.id];
          changed = true;
        }
        if (m.state === 'Abroad' && abroad[m.id] && abroad[m.id].desc === m.description) m.abroadSince = abroad[m.id].since;
        else if (abroad[m.id] && m.state !== 'Abroad') { delete abroad[m.id]; changed = true; }
      }
      this.lastSeen.set(m.id, { state: m.state, desc: m.description, at: now });
    }
    if (changed) { this.db.set('trips', trips); this.db.set('abroad', abroad); }
  }

  // IDs on the enemy board (for FFScouter estimates).
  enemyIds() {
    return this.state.enemy ? this.state.enemy.members.map(m => m.id) : [];
  }

  snapshot() {
    const h = this.history();
    const r = this.ranked();
    return {
      ...this.state,
      phase: this.phase(),
      target: this.enemyTarget(),
      watchId: Number(this.store.get('war.watchId')) || 0,
      pinned: this.pinned(),
      enemyChain: this.state.enemyChain && this.enemyTarget() && this.state.enemyChain.factionId === this.enemyTarget().id ? this.state.enemyChain : null,
      interval: this.interval() / SEC,
      live: this.liveOn() ? this.memberInterval() / SEC : 0, // seconds between enemy refreshes in live mode
      history: h && r && h.warId === r.id ? h : null,
    };
  }
}

module.exports = { WarFeature, counts, member, parseTrip, flightRange, COUNTRY_BY_NAME };

  },
  "features/warreport.js": function (module, exports, require) {
'use strict';
// Post-war report (the user's request, 2026-11-21): the facts of a finished ranked war plus fun
// accolades, as Discord-ready text (and an image, drawn by the War tab). Sources, all official:
//   /v2/faction/{warId}/rankedwarreport  result, score, hits, rank, rewards, every member (public key)
//   /v2/faction/chains + /v2/faction/{chainId}/chainreport  your chains during the war (public):
//        each attacker's respect (best single hit), mugs, hospitalisations, assists, retaliations,
//        overseas hits, draws, escapes, losses, chain bonus hits
//   /v2/faction/attacks?from&to  every attack in the war. Needs a key with faction API access;
//        without it those accolades are left out and the report says so.
//   Mentat's own score history for the war (lead changes, biggest lead, comebacks).
// Accolades only go to someone who did the thing (a count above zero). Built reports are kept
// (war-reports.json), so opening one again costs nothing.

const { EventEmitter } = require('events');
const { Store } = require('../store');

const PRIORITY = 7;
const MAX_ATTACK_PAGES = 80; // 8,000 attacks
const SUCCESS = new Set(['Attacked', 'Mugged', 'Hospitalized', 'Arrested', 'Looted', 'Special', 'Bounty']);
const DISCORD_LIMIT = 1900; // Discord's message limit is 2,000 characters; keep some room

const num = n => Math.round(Number(n) || 0).toLocaleString('en-US');
const pts = n => (Math.round((Number(n) || 0) * 100) / 100).toLocaleString('en-US', { maximumFractionDigits: 2 });
const s2ms = s => (s ? Number(s) * 1000 : 0);
function dur(ms) {
  const m = Math.round(ms / 60000);
  const d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60), mm = m % 60;
  return d ? `${d}d ${h}h ${mm}m` : h ? `${h}h ${mm}m` : `${mm}m`;
}
const tct = ms => new Date(ms).toISOString().slice(11, 16);

// ---- The report, from data already fetched ----
// report: the API's rankedwarreport. chains: chainreport objects (API shape) during the war.
// attacks: the war's attacks (API shape), or null when the key can't read them. history:
// Mentat's { warId, points: [[t, ours, theirs, target]] } for this war, if any.
function buildModel({ report, ownId, chains = [], attacks = null, history = null, builtAt = Date.now() }) {
  const r = report;
  const facs = r.factions || [];
  const usF = facs.find(f => f.id === ownId) || facs[0];
  const themF = facs.find(f => f !== usF) || {};
  const side = f => ({
    id: f.id, name: f.name || `Faction ${f.id}`, score: f.score || 0, attacks: f.attacks || 0,
    rankBefore: (f.rank && f.rank.before) || '', rankAfter: (f.rank && f.rank.after) || '',
    respect: (f.rewards && f.rewards.respect) || 0, points: (f.rewards && f.rewards.points) || 0,
    items: ((f.rewards && f.rewards.items) || []).map(i => ({ name: i.name, quantity: i.quantity || 1 })),
    members: (f.members || []).map(m => ({ id: m.id, name: m.name || `#${m.id}`, level: m.level || 0, attacks: m.attacks || 0, score: Number(m.score) || 0 })),
  });
  const us = side(usF), them = side(themF);
  const names = new Map([...us.members, ...them.members].map(m => [m.id, m.name]));
  const nameOf = id => names.get(id) || `#${id}`;
  const start = s2ms(r.start), end = s2ms(r.end);
  const accolades = [];
  // Winners of one accolade: everyone tied for the best value (at most 3).
  const award = (key, emoji, title, blurb, rows, value, text, { min = 0, low = false } = {}) => {
    const scored = rows.map(x => ({ x, v: value(x) })).filter(o => Number.isFinite(o.v) && (low ? true : o.v > min));
    if (!scored.length) return;
    const best = low ? Math.min(...scored.map(o => o.v)) : Math.max(...scored.map(o => o.v));
    const winners = scored.filter(o => o.v === best).slice(0, 3).map(o => ({ id: o.x.id, name: o.x.name || nameOf(o.x.id), value: o.v, text: text(o.x, o.v) }));
    accolades.push({ key, emoji, title, blurb, winners });
  };

  // From the war report (always there)
  const hitters = us.members.filter(m => m.attacks > 0);
  award('mvp', '🏆', 'MVP', 'most war score', us.members, m => m.score, (m, v) => `${pts(v)} pts`);
  award('workhorse', '🔨', 'Workhorse', 'most war hits', us.members, m => m.attacks, (m, v) => `${num(v)} hits`);
  award('sharpshooter', '🎯', 'Sharpshooter', 'best score per hit (5+ hits)', us.members.filter(m => m.attacks >= 5), m => Math.round(m.score / m.attacks * 100) / 100, (m, v) => `${pts(v)} pts a hit`);
  const levels = hitters.map(m => m.level).sort((a, b) => a - b);
  const medianLevel = levels.length ? levels[Math.floor(levels.length / 2)] : 0;
  award('mighty', '🐜', 'Small but Mighty', 'lowest level to put up a top-10 score',
    [...hitters].sort((a, b) => b.score - a.score).slice(0, 10).filter(m => m.level < medianLevel), m => m.level, (m, v) => `level ${v}, ${pts(m.score)} pts`, { low: true });

  // From your chains during the war
  const agg = new Map(); // id -> summed counts
  let longest = null, bonusList = [];
  const chainList = [];
  for (const c of chains) {
    const d = c.details || {};
    if (!longest || (d.chain || 0) > longest.chain) longest = { id: c.id, chain: d.chain || 0, respect: d.respect || 0, start: s2ms(c.start), end: s2ms(c.end) };
    for (const b of c.bonuses || []) bonusList.push({ id: b.attacker_id, chain: b.chain, respect: b.respect });
    chainList.push({
      id: c.id, chain: d.chain || 0, respect: Math.round((d.respect || 0) * 100) / 100, start: s2ms(c.start), end: s2ms(c.end),
      war: d.war || 0, members: d.members || (c.attackers || []).length, best: d.best || 0,
      bonuses: (c.bonuses || []).map(b => ({ id: b.attacker_id, name: nameOf(b.attacker_id), chain: b.chain, respect: b.respect })),
    });
    for (const a of c.attackers || []) {
      const t = a.attacks || {}, rs = a.respect || {};
      const o = agg.get(a.id) || { id: a.id, best: 0, respect: 0, mug: 0, hospitalize: 0, leave: 0, war: 0, assists: 0, retaliations: 0, overseas: 0, draws: 0, escapes: 0, losses: 0, bonuses: 0, total: 0 };
      o.best = Math.max(o.best, rs.best || 0);
      o.respect += rs.total || 0;
      for (const k of ['mug', 'hospitalize', 'leave', 'war', 'assists', 'retaliations', 'overseas', 'draws', 'escapes', 'losses', 'bonuses', 'total']) o[k] += t[k] || 0;
      agg.set(a.id, o);
    }
  }
  const chainRows = [...agg.values()]; // names come from the war report (nameOf)
  award('heavy', '💥', 'Heavy Hitter', 'biggest single hit (respect)', chainRows, o => Math.round(o.best * 100) / 100, (o, v) => `${pts(v)} respect in one hit`);
  const bigBonus = bonusList.sort((a, b) => b.respect - a.respect)[0];
  award('bonus', '🎁', 'Bonus Hunter', 'most chain bonus hits', chainRows, o => o.bonuses, (o, v) => `${v} bonus hit${v === 1 ? '' : 's'}${bigBonus && bigBonus.id === o.id ? ` (incl. hit #${num(bigBonus.chain)} for ${num(bigBonus.respect)} respect)` : ''}`);
  award('pickpocket', '💰', 'Pickpocket', 'most mugs', chainRows, o => o.mug, (o, v) => `${v} mug${v === 1 ? '' : 's'}`);
  award('hospital', '🏥', 'Hospital Director', 'most hospitalisations', chainRows, o => o.hospitalize, (o, v) => `${v} sent to hospital`);
  award('assists', '🤝', 'Team Player', 'most assists', chainRows, o => o.assists, (o, v) => `${v} assist${v === 1 ? '' : 's'}`);
  award('payback', '😤', 'Payback', 'most retaliations', chainRows, o => o.retaliations, (o, v) => `${v} retal${v === 1 ? '' : 's'}`);
  award('globetrotter', '✈️', 'Globetrotter', 'most overseas hits', chainRows, o => o.overseas, (o, v) => `${v} hit${v === 1 ? '' : 's'} abroad`);
  award('peacemaker', '🕊️', 'Peacemaker', 'most draws', chainRows, o => o.draws, (o, v) => `${v} stalemate${v === 1 ? '' : 's'}`);
  award('character', '🩹', 'Character Building', 'most losses (it builds character)', chainRows, o => o.losses, (o, v) => `${v} L${v === 1 ? '' : 's'}`);

  // From the attack log (faction API access)
  let attackStats = null;
  if (Array.isArray(attacks)) {
    const fid = a => (a && a.faction && a.faction.id) || 0;
    const war = attacks.filter(a => a.is_ranked_war);
    const out = war.filter(a => fid(a.attacker) === us.id);
    const inc = war.filter(a => fid(a.defender) === us.id && fid(a.attacker) !== us.id);
    const won = out.filter(a => SUCCESS.has(a.result)).sort((a, b) => a.started - b.started);
    const byAttacker = new Map();
    for (const a of won) { const l = byAttacker.get(a.attacker.id) || []; l.push(a); byAttacker.set(a.attacker.id, l); }
    const people = [...byAttacker.entries()].map(([id, list]) => ({ id, name: list[0].attacker.name, list }));
    if (won.length) {
      const f = won[0], l = won[won.length - 1];
      accolades.push({ key: 'first', emoji: '🩸', title: 'First Blood', blurb: 'first war hit', winners: [{ id: f.attacker.id, name: f.attacker.name, value: f.started, text: `on ${f.defender.name} at ${tct(s2ms(f.started))} TCT` }] });
      accolades.push({ key: 'closer', emoji: '🔚', title: 'The Closer', blurb: 'last war hit', winners: [{ id: l.attacker.id, name: l.attacker.name, value: l.started, text: `on ${l.defender.name} at ${tct(s2ms(l.started))} TCT` }] });
    }
    award('owl', '🦉', 'Night Owl', 'most war hits 00:00–06:00 TCT', people, p => p.list.filter(a => new Date(s2ms(a.started)).getUTCHours() < 6).length, (p, v) => `${v} hits after midnight`);
    award('speed', '⚡', 'Speed Demon', 'most war hits in one hour', people, p => {
      let best = 0, i = 0;
      for (let j = 0; j < p.list.length; j++) { while (p.list[j].started - p.list[i].started > 3600) i++; best = Math.max(best, j - i + 1); }
      return best;
    }, (p, v) => `${v} hits in an hour`);
    award('slayer', '🗡️', 'Giant Slayer', 'beat the biggest level gap', people, p => Math.max(0, ...p.list.map(a => (a.defender.level || 0) - (a.attacker.level || 0))), (p, v) => {
      const a = p.list.reduce((x, y) => ((y.defender.level || 0) - (y.attacker.level || 0) > (x.defender.level || 0) - (x.attacker.level || 0) ? y : x));
      return `level ${a.attacker.level} beat level ${a.defender.level} ${a.defender.name}`;
    });
    award('ninja', '🥷', 'Ninja', 'most stealthed war hits', people, p => p.list.filter(a => a.is_stealthed).length, (p, v) => `${v} stealthed`);
    // Incoming: who held off the enemy, and who spent the war in hospital
    const defenders = new Map();
    for (const a of inc) {
      const o = defenders.get(a.defender.id) || { id: a.defender.id, name: a.defender.name, held: 0, hospital: 0 };
      if (SUCCESS.has(a.result)) o.hospital++;
      else if (a.result !== 'Assist' && a.result !== 'None') o.held++;
      defenders.set(a.defender.id, o);
    }
    award('wall', '🧱', 'Brick Wall', 'most enemy attacks held off', [...defenders.values()], o => o.held, (o, v) => `${v} attack${v === 1 ? '' : 's'} survived`);
    award('flyer', '🛌', 'Frequent Flyer', 'most trips to hospital (thanks for tanking)', [...defenders.values()], o => o.hospital, (o, v) => `${v} trip${v === 1 ? '' : 's'} to hospital`);
    // The enemy we hit the most
    const bags = new Map();
    for (const a of won) { const o = bags.get(a.defender.id) || { id: a.defender.id, name: a.defender.name, n: 0 }; o.n++; bags.set(a.defender.id, o); }
    const bag = [...bags.values()].sort((a, b) => b.n - a.n)[0];
    // War hits per hour of the war: [our successful hits, their attacks on us]
    const hours = Math.max(1, Math.ceil((end - start) / 3600e3));
    const byHour = Array.from({ length: Math.min(hours, 24 * 14) }, () => [0, 0]);
    const slot = a => Math.floor((s2ms(a.started) - start) / 3600e3);
    for (const a of won) { const h = slot(a); if (byHour[h]) byHour[h][0]++; }
    for (const a of inc) { const h = slot(a); if (byHour[h]) byHour[h][1]++; }
    const results = {};
    for (const a of out) results[a.result || 'None'] = (results[a.result || 'None'] || 0) + 1;
    attackStats = {
      outgoing: out.length, won: won.length, incoming: inc.length, enemyHospitalised: won.filter(a => a.result === 'Hospitalized').length,
      incomingWon: inc.filter(a => SUCCESS.has(a.result)).length,
      punchingBag: bag ? { id: bag.id, name: bag.name, hits: bag.n } : null,
      bags: [...bags.values()].sort((a, b) => b.n - a.n).slice(0, 10).map(b => ({ id: b.id, name: b.name, hits: b.n })),
      byHour, results,
    };
  }

  // Score history from Mentat (lead changes, biggest lead, comeback)
  let timeline = null;
  if (history && history.warId === r.id && Array.isArray(history.points) && history.points.length > 1) {
    let changes = 0, lastSign = 0, bestLead = 0, worst = 0, bestAt = 0, worstAt = 0;
    for (const [t, a, b] of history.points) {
      const d = a - b;
      const s = Math.sign(d);
      if (s && lastSign && s !== lastSign) changes++;
      if (s) lastSign = s;
      if (d > bestLead) { bestLead = d; bestAt = t; }
      if (d < worst) { worst = d; worstAt = t; }
    }
    // The score line itself, thinned to at most ~400 points (the last one always kept), for the
    // shared report page's chart.
    const pts2 = history.points.filter(p => !end || p[0] <= end + 120e3);
    const step = Math.max(1, Math.ceil(pts2.length / 400));
    const line = pts2.filter((p, i) => i % step === 0 || i === pts2.length - 1).map(p => [p[0], p[1], p[2]]);
    timeline = { leadChanges: changes, biggestLead: bestLead, biggestLeadAt: bestAt, biggestDeficit: -worst, biggestDeficitAt: worstAt, samples: history.points.length, line };
  }

  const won = r.winner === us.id;
  return {
    builtAt,
    war: { id: r.id, start, end, duration: end - start, forfeit: !!r.forfeit, won, winner: r.winner, margin: us.score - them.score },
    us: { ...us, members: undefined }, them: { ...them, members: undefined },
    top: [...us.members].sort((a, b) => b.score - a.score || b.attacks - a.attacks),
    spectators: us.members.filter(m => m.attacks === 0).map(m => ({ id: m.id, name: m.name, level: m.level })),
    hitters: hitters.length, members: us.members.length,
    enemyTop: [...them.members].sort((a, b) => b.score - a.score).slice(0, 3),
    enemyMembers: [...them.members].sort((a, b) => b.score - a.score || b.attacks - a.attacks),
    longestChain: longest, chainCount: chains.length,
    chains: chainList.sort((a, b) => a.start - b.start),
    chainStats: chainRows.map(o => ({ ...o, name: nameOf(o.id), respect: Math.round(o.respect * 100) / 100, best: Math.round(o.best * 100) / 100 })),
    attackStats, timeline, accolades,
    sources: { chains: chains.length, attacks: Array.isArray(attacks) ? attacks.length : null, history: !!timeline },
  };
}

// ---- Discord text: parts of at most DISCORD_LIMIT characters, split between sections ----
function discordParts(m, { spectators = false, topN = 10 } = {}) {
  const res = m.war.forfeit ? (m.war.won ? 'Victory (they forfeited)' : 'Defeat (forfeit)') : m.war.won ? 'Victory!' : 'Defeat';
  const sections = [];
  const head = [`## ⚔️ ${m.us.name} vs ${m.them.name} — ${res}`,
    `**${num(m.us.score)} – ${num(m.them.score)}** · ${dur(m.war.duration)} · ranked war #${m.war.id}`,
    `Hits: ${num(m.us.attacks)} ours, ${num(m.them.attacks)} theirs · ${m.hitters}/${m.members} of us landed a hit`];
  if (m.us.rankBefore || m.us.rankAfter) head.push(`Rank: ${m.us.rankBefore || '?'} → ${m.us.rankAfter || '?'}`);
  const rewards = [m.us.respect ? `${num(m.us.respect)} respect` : '', m.us.points ? `${num(m.us.points)} points` : '', ...m.us.items.map(i => `${i.quantity > 1 ? `${i.quantity}× ` : ''}${i.name}`)].filter(Boolean);
  if (rewards.length) head.push(`Rewards: ${rewards.join(', ')}`);
  if (m.timeline) {
    const t = m.timeline;
    const bits = [`${t.leadChanges} lead change${t.leadChanges === 1 ? '' : 's'}`];
    if (t.biggestLead > 0) bits.push(`biggest lead ${num(t.biggestLead)}`);
    if (t.biggestDeficit > 0) bits.push(`${m.war.won ? 'came back from' : 'trailed by up to'} ${num(t.biggestDeficit)}`);
    head.push(`Swing: ${bits.join(' · ')}`);
  }
  if (m.longestChain && m.longestChain.chain) head.push(`Longest chain: ${num(m.longestChain.chain)} hits (${num(m.longestChain.respect)} respect)`);
  sections.push(head.join('\n'));

  const top = m.top.filter(x => x.attacks > 0).slice(0, topN);
  if (top.length) {
    const w = Math.min(18, Math.max(...top.map(x => x.name.length)));
    const rows = top.map((x, i) => `${String(i + 1).padStart(2)}. ${x.name.slice(0, w).padEnd(w)}  ${pts(x.score).padStart(8)} pts  ${String(x.attacks).padStart(4)} hits`);
    sections.push(`**Top scorers**\n\`\`\`\n${rows.join('\n')}\n\`\`\``);
  }
  if (m.accolades.length) {
    sections.push(`**🏅 Accolades**\n${m.accolades.map(a => `${a.emoji} **${a.title}** — ${a.winners.map(w => `${w.name} (${w.text})`).join(', ')}`).join('\n')}`);
  }
  const theirs = [];
  if (m.enemyTop[0]) theirs.push(`Their MVP: ${m.enemyTop[0].name} (${pts(m.enemyTop[0].score)} pts)`);
  if (m.attackStats && m.attackStats.punchingBag) theirs.push(`Punching bag: ${m.attackStats.punchingBag.name} (hit ${m.attackStats.punchingBag.hits}×)`);
  if (theirs.length) sections.push(`**😈 Their side** — ${theirs.join(' · ')}`);
  if (spectators && m.spectators.length) sections.push(`**🍿 Watched from the stands** — ${m.spectators.map(s => s.name).join(', ')}`);
  sections.push('-# Built with Mentat');

  // Pack sections into parts under the limit; a section that's too long on its own is cut by lines.
  const parts = [];
  let cur = '';
  const push = s => { if (cur && (cur + '\n\n' + s).length > DISCORD_LIMIT) { parts.push(cur); cur = s; } else cur = cur ? `${cur}\n\n${s}` : s; };
  for (const s of sections) {
    if (s.length <= DISCORD_LIMIT) { push(s); continue; }
    let chunk = '';
    for (const line of s.split('\n')) {
      if ((chunk + '\n' + line).length > DISCORD_LIMIT) { push(chunk); chunk = line; } else chunk = chunk ? `${chunk}\n${line}` : line;
    }
    if (chunk) push(chunk);
  }
  if (cur) parts.push(cur);
  return parts;
}

// ---- The feature: fetch, build, keep ----
class WarReportFeature extends EventEmitter {
  constructor({ api, war, dataDir }) {
    super();
    this.api = api;
    this.war = war;
    this.store = new Store(`${dataDir}/war-reports.json`, { reports: {} }, { debounceMs: 2000 });
    this.state = { building: 0, progress: '', error: '', wars: null };
  }

  snapshot() {
    return { ...this.state, built: Object.keys(this.store.get('reports') || {}).map(Number) };
  }

  tick() {}

  ownId() {
    return (this.war.state.own && this.war.state.own.id) || 0;
  }

  set(patch) {
    this.state = { ...this.state, ...patch };
    this.emit('state');
  }

  // Your faction's recent ranked wars, newest first.
  async listWars() {
    const d = await this.api.request('/v2/faction/rankedwars?limit=20&sort=DESC', { soft: [6, 7, 16], priority: 3 });
    const own = this.ownId();
    const wars = (d.rankedwars || []).map(w => {
      const fs = w.factions || [];
      const them = fs.find(f => f.id !== own) || {};
      const us = fs.find(f => f.id === own) || {};
      return { id: w.id, start: s2ms(w.start), end: s2ms(w.end), winner: w.winner || 0, us: us.score || 0, them: them.score || 0, opponent: them.name || '' };
    });
    this.set({ wars });
    return wars;
  }

  // A kept report, or null.
  get(warId) {
    return (this.store.get('reports') || {})[Number(warId)] || null;
  }

  // The report for one war: kept, or built now. fresh = build again. Asking again while it's
  // being built waits for that build instead of starting another.
  build(warId, opts = {}) {
    const id = Number(warId);
    this.pending = this.pending || new Map();
    if (this.pending.has(id)) return this.pending.get(id);
    const p = this.buildNow(id, opts).finally(() => this.pending.delete(id));
    this.pending.set(id, p);
    return p;
  }

  async buildNow(id, { fresh = false } = {}) {
    if (!Number.isInteger(id) || id <= 0) throw new Error('Which war?');
    const kept = (this.store.get('reports') || {})[id];
    if (kept && !fresh) return kept;
    const own = this.ownId();
    if (!own) throw new Error('Your faction is still loading; try again in a moment.');
    this.set({ building: id, progress: 'War report…', error: '' });
    try {
      const d = await this.api.request(`/v2/faction/${id}/rankedwarreport`, { soft: [6, 7], priority: PRIORITY });
      const report = d.rankedwarreport;
      if (!report || !report.end) throw new Error("That war hasn't finished (Torn makes its report when it ends).");
      if (!(report.factions || []).some(f => f.id === own)) throw new Error("Your faction wasn't in that war.");
      // Your chains during the war
      this.set({ progress: 'Chains…' });
      const c = await this.api.request(`/v2/faction/chains?from=${report.start - 86400}&to=${report.end + 3600}&limit=100`, { soft: [6, 7], priority: PRIORITY });
      const during = (c.chains || []).filter(x => x.end >= report.start && x.start <= report.end);
      const chains = [];
      for (const [i, ch] of during.entries()) {
        this.set({ progress: `Chain reports ${i + 1}/${during.length}…` });
        try { const cr = await this.api.request(`/v2/faction/${ch.id}/chainreport`, { soft: [6, 7], priority: PRIORITY }); if (cr.chainreport) chains.push(cr.chainreport); } catch (e) { /* skip one */ }
      }
      // Every attack in the war (faction API access only)
      let attacks = [];
      let from = report.start;
      const seen = new Set();
      for (let page = 0; page < MAX_ATTACK_PAGES; page++) {
        this.set({ progress: `Attacks ${attacks.length ? `(${num(attacks.length)})` : ''}…` });
        let a;
        try {
          a = await this.api.request(`/v2/faction/attacks?from=${from}&to=${report.end}&limit=100&sort=ASC`, { soft: [6, 7, 16], priority: PRIORITY });
        } catch (e) {
          if (e.kind === 'soft') { attacks = null; break; } // no faction API access
          throw e;
        }
        const list = (a.attacks || []).filter(x => !seen.has(x.id));
        for (const x of list) seen.add(x.id);
        attacks.push(...list);
        if ((a.attacks || []).length < 100 || !list.length) break;
        from = Math.max(from, ...list.map(x => x.started));
      }
      const history = this.war.history ? this.war.history() : null;
      const model = buildModel({ report, ownId: own, chains, attacks, history });
      const all = this.store.get('reports') || {};
      all[id] = model;
      // Keep the 20 newest
      const keep = Object.keys(all).map(Number).sort((a, b) => b - a).slice(0, 20);
      this.store.set('reports', Object.fromEntries(keep.map(k => [k, all[k]])));
      this.set({ building: 0, progress: '' });
      return model;
    } catch (e) {
      this.set({ building: 0, progress: '', error: e.message });
      throw e;
    }
  }

  flush() { this.store.flush(); }
}

module.exports = { WarReportFeature, buildModel, discordParts };

  },
};
const CACHE = {};
function load(id) {
  if (CACHE[id]) return CACHE[id].exports;
  const module = { exports: {} };
  CACHE[id] = module;
  const dir = id.includes('/') ? id.slice(0, id.lastIndexOf('/')) : '';
  const req = name => {
    if (BUILTIN[name]) return BUILTIN[name];
    const parts = (dir ? dir.split('/') : []).concat(name.split('/'));
    const out = [];
    for (const p of parts) { if (p === '.' || !p) continue; if (p === '..') out.pop(); else out.push(p); }
    return load(out.join('/') + '.js');
  };
  DEFS[id].call(module.exports, module, module.exports, req);
  return module.exports;
}
window.Mentat = { version: "0.1.33", load: SHIMS.load, persistNow: SHIMS.persistNow, require: load, Buffer };
})();
