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
