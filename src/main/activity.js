'use strict';
// Long-term activity history per player, from faction member checks.
//
// Every check of a faction's members (/v2/faction/{id}/members) gives each member's exact
// last-action time. If it's newer than our previous check of that player, they were active
// in between. So each check tells us, for every member:
//   observed: the 15-minute slots (UTC = TCT) covered since the previous check
//   active:   the slot of their latest action (if inside that window), and "now" if Online
// Stored per player, not per faction, so history follows people who change factions.
//
// Storage: one small binary file per UTC day in <dataDir>/activity/YYYY-MM-DD.bin, sorted
// by player id; each record is 28 bytes (4 id + 12 active bits + 12 observed bits, 96 slots).
// 20,000 players is about 560 KB a day. Today and yesterday stay in memory until the day is over.

const fs = require('fs');
const path = require('path');

const SLOT = 15 * 60e3;
const DAY = 24 * 3600e3;
const SLOTS = 96;
const BYTES = 12;
const REC = 4 + BYTES * 2;
const MAX_GAP = 2 * 3600e3; // a check this long after the previous one only covers the last 2 h
const FIRST_SPAN = SLOT;    // a player's first check covers the last 15 minutes

const dayKey = t => new Date(t).toISOString().slice(0, 10);
const slotOf = t => Math.floor((((t % DAY) + DAY) % DAY) / SLOT);
const bit = (buf, off, s) => (buf[off + (s >> 3)] >> (s & 7)) & 1;
const setBit = (buf, off, s) => { buf[off + (s >> 3)] |= 1 << (s & 7); };

function writeAtomic(file, data) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

class ActivityStore {
  constructor(dataDir, { keepDays = 180 } = {}) {
    this.dir = path.join(dataDir, 'activity');
    fs.mkdirSync(this.dir, { recursive: true });
    this.keepDays = keepDays;
    this.open = new Map();   // day -> Map(id -> Buffer(24)) for days still being written
    this.dirty = new Set();
    this.cache = new Map();  // day -> Map(id -> Buffer) for finished days (small LRU)
    this.prev = new Map();   // id -> [lastCheckAt, lastActionAt]
    this.prunedAt = 0;
    this.rev = 0;
    try {
      const p = JSON.parse(fs.readFileSync(path.join(this.dir, 'prev.json'), 'utf8'));
      for (const [id, v] of Object.entries(p)) this.prev.set(Number(id), v);
    } catch (e) { /* first run */ }
  }

  file(day) { return path.join(this.dir, `${day}.bin`); }

  readFile(day) {
    const m = new Map();
    let buf;
    try { buf = fs.readFileSync(this.file(day)); } catch (e) { return m; }
    for (let o = 0; o + REC <= buf.length; o += REC) m.set(buf.readUInt32LE(o), Buffer.from(buf.subarray(o + 4, o + REC)));
    return m;
  }

  // The records of a day being written (loaded from disk the first time).
  openDay(day) {
    let m = this.open.get(day);
    if (!m) { m = this.readFile(day); this.cache.delete(day); this.open.set(day, m); }
    return m;
  }

  row(day, id) {
    const m = this.openDay(day);
    let r = m.get(id);
    if (!r) { r = Buffer.alloc(BYTES * 2); m.set(id, r); }
    this.dirty.add(day);
    return r;
  }

  markObserved(id, from, to) {
    for (let t = Math.floor(from / SLOT) * SLOT; t <= to; t += SLOT) setBit(this.row(dayKey(t), id), BYTES, slotOf(t));
  }

  markActive(id, t) {
    const r = this.row(dayKey(t), id);
    setBit(r, 0, slotOf(t));
    setBit(r, BYTES, slotOf(t));
  }

  // One check of a faction's members (war.js member() shape: id, last, lastAt).
  observe(members, now) {
    for (const m of members) {
      const id = Number(m.id);
      if (!id) continue;
      const p = this.prev.get(id);
      if (p && now - p[0] < 30e3) continue; // checked moments ago by another feature
      const from = p ? Math.max(p[0], now - MAX_GAP) : now - FIRST_SPAN;
      this.markObserved(id, from, now);
      if (m.lastAt && m.lastAt > from && m.lastAt <= now + 60e3) this.markActive(id, Math.min(m.lastAt, now));
      if (m.last === 'Online') this.markActive(id, now);
      this.prev.set(id, [now, m.lastAt || 0]);
    }
    this.rev++;
  }

  flush(now = Date.now()) {
    for (const day of this.dirty) {
      const m = this.open.get(day);
      if (!m) continue;
      const ids = [...m.keys()].sort((a, b) => a - b);
      const out = Buffer.alloc(ids.length * REC);
      ids.forEach((id, i) => { out.writeUInt32LE(id, i * REC); m.get(id).copy(out, i * REC + 4); });
      try { writeAtomic(this.file(day), out); } catch (e) { continue; }
    }
    this.dirty.clear();
    // Days before yesterday are finished: stop holding them open.
    const keep = new Set([dayKey(now), dayKey(now - DAY)]);
    for (const day of [...this.open.keys()]) if (!keep.has(day)) this.open.delete(day);
    // Previous-check times: only players seen in the last 3 days matter.
    const prev = {};
    for (const [id, v] of this.prev) { if (now - v[0] < 3 * DAY) prev[id] = v; else this.prev.delete(id); }
    try { writeAtomic(path.join(this.dir, 'prev.json'), JSON.stringify(prev)); } catch (e) { /* next time */ }
    if (now - this.prunedAt > 12 * 3600e3) { this.prunedAt = now; this.prune(now); }
  }

  prune(now) {
    const cutoff = dayKey(now - this.keepDays * DAY);
    for (const f of this.days()) if (f < cutoff) { try { fs.unlinkSync(this.file(f)); } catch (e) { /* gone */ } }
  }

  days() {
    let names = [];
    try { names = fs.readdirSync(this.dir); } catch (e) { /* none */ }
    return names.filter(n => /^\d{4}-\d{2}-\d{2}\.bin$/.test(n)).map(n => n.slice(0, 10)).sort();
  }

  // A day's records for reading: open days from memory; finished days are looked up in the
  // raw file (sorted by id) with a binary search, without unpacking every record.
  day(day) {
    if (this.open.has(day)) return this.open.get(day);
    let buf = this.cache.get(day);
    if (!buf) {
      try { buf = fs.readFileSync(this.file(day)); } catch (e) { buf = Buffer.alloc(0); }
      this.cache.set(day, buf);
      while (this.cache.size > 60) this.cache.delete(this.cache.keys().next().value);
    }
    const n = Math.floor(buf.length / REC);
    return {
      get(id) {
        let lo = 0, hi = n - 1;
        while (lo <= hi) {
          const mid = (lo + hi) >> 1;
          const v = buf.readUInt32LE(mid * REC);
          if (v === id) return buf.subarray(mid * REC + 4, mid * REC + REC);
          if (v < id) lo = mid + 1; else hi = mid - 1;
        }
        return undefined;
      },
    };
  }

  // Counts per 15-minute slot of the day (TCT) for each player, between two times:
  //   act[s] = days the player was seen active in slot s, obs[s] = days slot s was observed.
  // Plus a day-of-week x hour grid summed over all the players (for a faction heatmap).
  profile(ids, from, to) {
    const want = [...new Set(ids.map(Number).filter(Boolean))];
    const members = {};
    for (const id of want) members[id] = { act: new Array(SLOTS).fill(0), obs: new Array(SLOTS).fill(0), days: 0 };
    const week = { act: new Array(168).fill(0), obs: new Array(168).fill(0) };
    const all = this.allDays().filter(d => d >= dayKey(from) && d <= dayKey(to));
    let firstDay = '', lastDay = '';
    for (const d of all) {
      const m = this.day(d);
      const dow = new Date(`${d}T00:00:00Z`).getUTCDay();
      let any = false;
      for (const id of want) {
        const r = m.get(id);
        if (!r) continue;
        const p = members[id];
        let seen = false;
        for (let s = 0; s < SLOTS; s++) {
          if (!bit(r, BYTES, s)) continue;
          seen = true;
          p.obs[s]++;
          const h = dow * 24 + (s >> 2);
          week.obs[h]++;
          if (bit(r, 0, s)) { p.act[s]++; week.act[h]++; }
        }
        if (seen) { p.days++; any = true; }
      }
      if (any) { if (!firstDay) firstDay = d; lastDay = d; }
    }
    return { from: firstDay, to: lastDay, days: all.filter(d => d >= firstDay && d <= lastDay).length, members, week };
  }

  // Days on disk plus the ones still being written.
  allDays() {
    return [...new Set([...this.days(), ...this.open.keys()])].sort();
  }

  stats() {
    const days = this.allDays();
    return { days: days.length, first: days[0] || '', players: this.prev.size };
  }
}

module.exports = { ActivityStore, SLOT, SLOTS, dayKey, slotOf };
