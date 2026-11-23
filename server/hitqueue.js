'use strict';
// Hit queue (the user's request, 2026-11-22): who hits the chain next, shared with everyone signed
// in to this server and shown by the war board userscript (web/pda/mentat-war.user.js). Each entry
// is a member and, if they like, the player they'll hit (anyone, in the enemy faction or not).
//
// Times: everyone hits when the chain timer shows `hitAt` (2:00 by default) and each hit refills
// the timer to `refill`, so the first person hits in (timer − hitAt) and each next one
// (refill − hitAt) later. Everything is worked out again from the live timer, so a hit that lands
// early or late moves everyone after it.
//
// The refill isn't taken on trust: it starts at 5:00 (what the faction plays to) and is replaced
// by the highest timer seen just after hits. The server reads the chain from Torn every few
// seconds while the queue is in use, and when the count goes up it reads the chain report
// (/v2/faction/chainreport, public key, includes the running chain) to see who hit: their first
// entry comes off the queue.
//
// Kept in hitqueue.json so a restart in the middle of a chain keeps the queue.

const path = require('path');
const { Store } = require('../src/main/store');

const SEC = 1000;
const DEFAULT_HIT_AT = 120;
const DEFAULT_REFILL = 300;
const MAX_ENTRIES = 60;
const MAX_PER_PLAYER = 3;
const ENTRY_MS = 3 * 3600 * SEC; // an entry nobody acted on for 3 hours is dropped
const RECENT = 12;
const fail = (status, message) => Object.assign(new Error(message), { status });
const fresh = now => `timestamp=${Math.floor(now / 1000)}`;

// When each place in the queue hits (ms), from the chain as last read. Shared with the
// userscript (it has a copy, so its times tick between reads).
//   chain: { current, timeout (s at fetchedAt), fetchedAt, cooldownUntil }
// Returns { running, times: [ms|null], step (s), firstIn (s) }. Without a running chain the
// times are null and `after` gives seconds after the first hit instead.
function estimate(chain, hitAt, refill, count, now = Date.now()) {
  const step = Math.max(1, refill - hitAt);
  const left = chain && chain.current > 0 && chain.timeout > 0 && !(chain.cooldownUntil > now)
    ? chain.timeout - (now - chain.fetchedAt) / SEC : 0;
  const running = left > 0;
  const firstIn = running ? Math.max(0, left - hitAt) : 0;
  const times = [];
  const after = [];
  for (let i = 0; i < count; i++) {
    after.push(i * step);
    times.push(running ? now + (firstIn + i * step) * SEC : null);
  }
  return { running, left: Math.max(0, left), times, after, step, firstIn };
}

class HitQueue {
  constructor({ dataDir, api, log = () => {}, nameOf = () => '' }) {
    this.api = api;
    this.log = log;
    this.nameOf = nameOf;
    this.db = new Store(path.join(dataDir, 'hitqueue.json'), {
      seq: 0, entries: [], hitAt: DEFAULT_HIT_AT, hitAtBy: '', refills: [], paces: [], recent: [],
      // Chain leads (the user's rule, 2026-11-22): the owner, server admins and members whose
      // faction position is ticked here set the hit speed. Torn's API doesn't give the order of
      // a faction's positions, so the owner ticks them (Settings on the war board).
      leadPositions: [],
      // Chain subleads (the user's rule, 2026-11-22: Admin > Chain Lead > Chain Sublead): players
      // a chain lead added by name. They get the queue powers but can't add or remove subleads.
      subleads: [], // [{ id, name, addedBy, at }]
    }, { debounceMs: 1000 });
    this.chain = null; // last /v2/faction/chain reading
    this.report = null; // { id, hits: { pid: successful hits } } from the last chain report
    this.targets = new Map(); // player id -> { name, level, state, description, until, fetchedAt }
    this.viewers = new Map(); // pid -> { name, at }
    this.last = { chain: 0, report: 0, target: 0 };
    this.busy = false;
    this.rev = 0;
    this.noFaction = false;
  }

  get entries() { return this.db.data.entries; }
  save() { this.rev++; this.db.set('entries', this.db.data.entries); }

  refill() {
    const seen = this.db.data.refills;
    if (!seen.length) return DEFAULT_REFILL;
    // Readings come a few seconds after the hit, so the highest is closest; round up to 10 s.
    return Math.ceil(Math.max(...seen) / 10) * 10;
  }

  // ---- What people do ----
  // addedBy: the chain lead's name when a lead put someone else in the queue.
  join(pid, name, { target = 0, note = '', addedBy = '' } = {}, now = Date.now()) {
    this.prune(now);
    const t = Number(target) || 0;
    if (t && (!Number.isInteger(t) || t <= 0 || t > 1e8)) throw fail(400, 'That player ID doesn\'t look right.');
    if (this.entries.length >= MAX_ENTRIES) throw fail(429, 'The queue is full.');
    if (this.entries.filter(e => e.by === pid).length >= MAX_PER_PLAYER) throw fail(429, addedBy ? `${name || `#${pid}`} is already in the queue ${MAX_PER_PLAYER} times.` : `You're already in the queue ${MAX_PER_PLAYER} times.`);
    const e = { id: ++this.db.data.seq, by: pid, name: String(name || `#${pid}`).slice(0, 40), target: t, note: String(note || '').slice(0, 60), at: now };
    if (addedBy) e.addedBy = String(addedBy).slice(0, 40);
    this.entries.push(e);
    if (t) this.last.target = 0; // look the target up soon
    this.save();
    return e;
  }

  find(id) {
    const e = this.entries.find(x => x.id === Number(id));
    if (!e) throw fail(404, 'That entry has already gone.');
    return e;
  }

  // Leave the queue, or mark your hit done (the chain report usually does that by itself).
  remove(pid, id, { admin = false, how = 'left', now = Date.now() } = {}) {
    const e = this.find(id);
    if (e.by !== pid && !admin) throw fail(403, 'Only they (or a chain lead) can take them off the queue.');
    this.entries.splice(this.entries.indexOf(e), 1);
    if (how === 'done') this.noteHit(e.by, e.name, e.target, null, 'marked', now);
    this.save();
    return e;
  }

  // Someone at the front who hasn't hit while the timer ran past their turn: anyone can move
  // them off so the next person goes. Only the first entry, and only once it's overdue.
  skip(pid, name, id, now = Date.now()) {
    const e = this.find(id);
    if (this.entries[0] !== e) throw fail(400, 'Only the first person in the queue can be skipped.');
    const est = estimate(this.chain, this.db.data.hitAt, this.refill(), 1, now);
    if (est.running && est.left > this.db.data.hitAt - 30) throw fail(400, 'They still have time: wait until the timer is 30 seconds past their turn.');
    this.entries.shift();
    this.noteHit(e.by, e.name, e.target, null, `skipped by ${String(name || `#${pid}`).slice(0, 40)}`, now);
    this.save();
    return e;
  }

  // Swap your entry with the one behind it (letting someone go first), or move it up when the
  // one in front is also yours.
  // Set, change or clear (0) the target on a queue spot: your own, or anyone's for chain
  // subleads and up (the user's rule, 2026-11-22).
  setTarget(pid, id, target, { lead = false } = {}) {
    const e = this.find(id);
    if (e.by !== pid && !lead) throw fail(403, 'Only they (or a chain sublead or above) can change their target.');
    const t = Number(target) || 0;
    if (t && (!Number.isInteger(t) || t <= 0 || t > 1e8)) throw fail(400, 'That player ID doesn\'t look right.');
    e.target = t;
    if (t) this.last.target = 0; // look the new target up soon
    this.save();
    return e;
  }

  later(pid, id) {
    const e = this.find(id);
    if (e.by !== pid) throw fail(403, 'You can only move your own place.');
    const i = this.entries.indexOf(e);
    if (i >= this.entries.length - 1) throw fail(400, 'You\'re already last.');
    [this.entries[i], this.entries[i + 1]] = [this.entries[i + 1], this.entries[i]];
    this.save();
  }

  setLeadPositions(list) {
    const clean = [...new Set((Array.isArray(list) ? list : []).map(x => String(x || '').trim().slice(0, 40)).filter(Boolean))].slice(0, 30);
    this.db.set('leadPositions', clean);
    this.rev++;
    return clean;
  }

  addSublead(id, name, addedBy, now = Date.now()) {
    const pid = Number(id);
    if (!Number.isInteger(pid) || pid <= 0) throw fail(400, 'Which player?');
    const list = this.db.data.subleads;
    if (list.some(x => x.id === pid)) throw fail(400, `${name || `#${pid}`} is already a chain sublead.`);
    if (list.length >= 50) throw fail(429, 'There are already 50 chain subleads.');
    list.push({ id: pid, name: String(name || `#${pid}`).slice(0, 40), addedBy: String(addedBy || '').slice(0, 40), at: now });
    this.db.set('subleads', list);
    this.rev++;
  }

  removeSublead(id) {
    const pid = Number(id);
    const list = this.db.data.subleads;
    if (!list.some(x => x.id === pid)) throw fail(404, 'They are not a chain sublead.');
    this.db.set('subleads', list.filter(x => x.id !== pid));
    this.rev++;
  }

  isSublead(pid) {
    return this.db.data.subleads.some(x => x.id === Number(pid));
  }

  isLeadPosition(position) {
    const p = String(position || '').trim().toLowerCase();
    return !!p && this.db.data.leadPositions.some(x => x.toLowerCase() === p);
  }

  setHitAt(pid, name, sec) {
    const s = Math.round(Number(sec));
    if (!Number.isFinite(s) || s < 30 || s > 270) throw fail(400, 'Pick a time between 0:30 and 4:30.');
    this.db.data.hitAt = s;
    this.db.data.hitAtBy = String(name || `#${pid}`).slice(0, 40);
    this.db.set('hitAt', s);
    this.rev++;
  }

  noteHit(by, name, target, chainNo, how, now, timerAt = null) {
    const r = this.db.data.recent;
    r.unshift({ by, name: name || this.nameOf(by) || `#${by}`, target: target || 0, chain: chainNo, how, at: now, timerAt });
    r.splice(RECENT);
    this.db.set('recent', r);
  }

  prune(now) {
    const keep = this.entries.filter(e => now - e.at < ENTRY_MS);
    if (keep.length !== this.entries.length) { this.db.data.entries = keep; this.save(); }
  }

  seen(pid, name, now = Date.now()) {
    this.viewers.set(pid, { name, at: now });
  }

  watching(now = Date.now()) {
    const out = [];
    for (const [pid, v] of this.viewers) {
      if (now - v.at > 30 * SEC) this.viewers.delete(pid);
      else out.push({ id: pid, name: v.name });
    }
    return out;
  }

  active(now = Date.now()) {
    return this.entries.length > 0 || this.watching(now).length > 0;
  }

  // ---- Reading Torn ----
  tick(now = Date.now()) {
    if (this.busy || !this.api.hasKey()) return;
    this.prune(now);
    if (!this.active(now)) return;
    const job = this.nextJob(now);
    if (!job) return;
    this.busy = true;
    job.call(this, now).catch(e => this.log('Hit queue:', e.message)).finally(() => { this.busy = false; });
  }

  nextJob(now) {
    if (this.noFaction && now - this.last.chain < 15 * 60 * SEC) return null;
    // Every 5 s; every 3 s when someone's turn is close or overdue.
    const est = estimate(this.chain, this.db.data.hitAt, this.refill(), 1, now);
    const close = est.running && est.left < this.db.data.hitAt + 20;
    if (now - this.last.chain >= (close ? 3 : 5) * SEC) return this.readChain;
    // A starting baseline for who has hit, so the first hit we see can be put to a name.
    if (!this.report && this.chain && this.chain.current > 0 && now - this.last.report >= 30 * SEC) return this.readReport;
    const due = this.entries.find(e => e.target && (!this.targets.has(e.target) || now - this.targets.get(e.target).fetchedAt > 30 * SEC));
    if (due && now - this.last.target >= 2 * SEC) return () => this.readTarget(due.target, now);
    return null;
  }

  async readChain(now) {
    this.last.chain = now;
    let d;
    try {
      d = await this.api.request(`/v2/faction/chain?${fresh(now)}`, { soft: [6, 7], priority: 1 });
    } catch (e) {
      if (e.kind === 'soft') { this.noFaction = true; this.chain = null; }
      return;
    }
    this.noFaction = false;
    const c = d.chain || {};
    const at = Date.now();
    const next = { id: c.id || 0, current: c.current || 0, max: c.max || 0, timeout: c.timeout || 0, modifier: c.modifier || 1, cooldownUntil: (c.cooldown || 0) * SEC, fetchedAt: at };
    const prev = this.chain;
    this.chain = next;
    this.rev++;
    if (!prev || next.id !== prev.id) { this.report = null; return; }
    const gained = next.current - prev.current;
    if (gained <= 0 || next.timeout <= 0) return;
    // The timer just after hits: the refill. And when exactly one hit landed between two
    // readings, where the timer was when it landed (the pace people really keep).
    const refills = this.db.data.refills;
    refills.push(next.timeout);
    refills.splice(0, Math.max(0, refills.length - 8));
    this.db.set('refills', refills);
    if (gained === 1) {
      const hitTime = at - (this.refill() - next.timeout) * SEC;
      const timerAt = prev.timeout - (hitTime - prev.fetchedAt) / SEC;
      if (timerAt > 0 && timerAt <= this.refill()) {
        const p = this.db.data.paces;
        p.push(Math.round(timerAt));
        p.splice(0, Math.max(0, p.length - 10));
        this.db.set('paces', p);
        this.lastTimerAt = Math.round(timerAt);
      }
    } else this.lastTimerAt = null;
    await this.readReport(Date.now(), next.current);
  }

  // Who hit since the last report: anyone whose successful attacks (leave, mug, hospitalize)
  // went up. Their first entry in the queue is done.
  async readReport(now, chainNo = 0) {
    this.last.report = now;
    let d;
    try {
      d = await this.api.request(`/v2/faction/chainreport?${fresh(now)}`, { soft: [6, 7, 16], priority: 2 });
    } catch (e) {
      return;
    }
    const r = d.chainreport || {};
    if (!this.chain || r.id !== this.chain.id) return; // an older chain's report
    const hits = {};
    for (const a of r.attackers || []) {
      const x = a.attacks || {};
      hits[a.id] = (x.leave || 0) + (x.mug || 0) + (x.hospitalize || 0);
    }
    const before = this.report && this.report.id === r.id ? this.report.hits : null;
    this.report = { id: r.id, hits };
    if (!before) return;
    let changed = false;
    for (const [id, n] of Object.entries(hits)) {
      const pid = Number(id);
      if (n <= (before[id] || 0)) continue;
      const i = this.entries.findIndex(e => e.by === pid);
      const e = i >= 0 ? this.entries.splice(i, 1)[0] : null;
      if (e) changed = true;
      this.noteHit(pid, e ? e.name : '', e ? e.target : 0, chainNo || null, e ? (i === 0 ? 'hit' : 'hit (jumped the queue)') : 'hit (not queued)', now, this.lastTimerAt);
    }
    if (changed) this.save();
    this.rev++;
  }

  async readTarget(id, now) {
    this.last.target = now;
    try {
      const d = await this.api.request(`/v2/user/${id}/basic?striptags=true&${fresh(now)}`, { soft: [6, 7], priority: 6 });
      const p = d.profile || {};
      const st = p.status || {};
      this.targets.set(id, { name: p.name || '', level: p.level || 0, state: st.state || '', description: st.description || '', until: (st.until || 0) * SEC, fetchedAt: Date.now() });
    } catch (e) {
      if (e.kind === 'soft') this.targets.set(id, { name: '', missing: true, fetchedAt: Date.now() });
    }
    if (this.targets.size > 500) this.targets.clear();
    this.rev++;
  }

  // ---- For the board ----
  view(now = Date.now()) {
    this.prune(now);
    const paces = this.db.data.paces;
    return {
      rev: this.rev,
      hitAt: this.db.data.hitAt,
      hitAtBy: this.db.data.hitAtBy,
      leadPositions: this.db.data.leadPositions,
      subleads: this.db.data.subleads,
      refill: this.refill(),
      refillSeen: this.db.data.refills.length > 0,
      pace: paces.length ? Math.round(paces.reduce((a, b) => a + b, 0) / paces.length) : null,
      paceCount: paces.length,
      chain: this.chain,
      noFaction: this.noFaction,
      entries: this.entries.map(e => ({ ...e, targetInfo: e.target ? this.targets.get(e.target) || null : null })),
      recent: this.db.data.recent,
      watching: this.watching(now),
    };
  }

  flush() { try { this.db.flush(); } catch (e) { /* next time */ } }
}

module.exports = { HitQueue, estimate, DEFAULT_HIT_AT, DEFAULT_REFILL };
