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
