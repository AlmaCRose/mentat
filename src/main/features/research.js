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
