'use strict';
// Archive of finished ranked war reports and chain reports. They never change once a war
// or chain is over, so each is fetched once and kept as a small file:
//   <dataDir>/wars/rw-<id>.json   /v2/faction/{rankedWarId}/rankedwarreport (both sides, every member)
//   <dataDir>/wars/ch-<id>.json   /v2/faction/{chainId}/chainreport (each attacker's breakdown)
// Plus a player index (player id -> ranked wars they appear in), so a member who changed
// factions brings their war record with them.

const fs = require('fs');
const path = require('path');

const s2ms = v => (Number(v) || 0) * 1000;

function compactRanked(r) {
  return {
    id: r.id, start: s2ms(r.start), end: s2ms(r.end), winner: r.winner || 0, forfeit: !!r.forfeit,
    factions: (r.factions || []).map(f => ({
      id: f.id, name: f.name || '', score: f.score || 0, attacks: f.attacks || 0,
      rankBefore: (f.rank && f.rank.before) || '', rankAfter: (f.rank && f.rank.after) || '',
      respect: (f.rewards && f.rewards.respect) || 0, points: (f.rewards && f.rewards.points) || 0,
      // [id, name, level, attacks, score]
      members: (f.members || []).map(m => [m.id, m.name || '', m.level || 0, m.attacks || 0, Math.round((m.score || 0) * 100) / 100]),
    })),
  };
}

// Attacker row: [id, respect total, respect best, attacks total, war, hospitalize, leave, mug,
//                assists, retaliations, overseas, draws, escapes, losses, bonuses]
const CHAIN_COLS = ['respect', 'best', 'total', 'war', 'hosp', 'leave', 'mug', 'assists', 'retals', 'overseas', 'draws', 'escapes', 'losses', 'bonuses'];
function compactChain(c) {
  const d = c.details || {};
  return {
    id: c.id, faction: c.faction_id || 0, start: s2ms(c.start), end: s2ms(c.end),
    chain: d.chain || 0, respect: d.respect || 0, members: d.members || 0, war: d.war || 0, best: d.best || 0,
    attackers: (c.attackers || []).map(a => {
      const r = a.respect || {}, t = a.attacks || {};
      return [a.id, Math.round((r.total || 0) * 100) / 100, Math.round((r.best || 0) * 100) / 100, t.total || 0, t.war || 0, t.hospitalize || 0, t.leave || 0, t.mug || 0,
        t.assists || 0, t.retaliations || 0, t.overseas || 0, t.draws || 0, t.escapes || 0, t.losses || 0, t.bonuses || 0];
    }),
    non: c.non_attackers || [],
  };
}

class WarArchive {
  constructor(dataDir) {
    this.dir = path.join(dataDir, 'wars');
    fs.mkdirSync(this.dir, { recursive: true });
    this.have = new Set();
    try { for (const n of fs.readdirSync(this.dir)) { const m = /^(rw|ch)-(\d+)\.json$/.exec(n); if (m) this.have.add(`${m[1]}-${m[2]}`); } } catch (e) { /* empty */ }
    this.cache = new Map();
    this.players = new Map(); // player id -> [ranked war ids]
    this.indexDirty = false;
    this.loadIndex();
  }

  has(kind, id) { return this.have.has(`${kind}-${id}`); }

  get(kind, id) {
    const k = `${kind}-${id}`;
    if (!this.have.has(k)) return null;
    let v = this.cache.get(k);
    if (!v) {
      try { v = JSON.parse(fs.readFileSync(path.join(this.dir, `${k}.json`), 'utf8')); } catch (e) { this.have.delete(k); return null; }
      this.cache.set(k, v);
      while (this.cache.size > 400) this.cache.delete(this.cache.keys().next().value);
    }
    return v;
  }

  put(kind, id, obj) {
    const k = `${kind}-${id}`;
    const file = path.join(this.dir, `${k}.json`);
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(obj));
    fs.renameSync(`${file}.tmp`, file);
    this.have.add(k);
    this.cache.set(k, obj);
    if (kind === 'rw') this.indexWar(obj);
    return obj;
  }

  indexWar(w) {
    for (const f of w.factions || []) for (const m of f.members || []) {
      const list = this.players.get(m[0]) || [];
      if (!list.includes(w.id)) { list.push(w.id); this.players.set(m[0], list); this.indexDirty = true; }
    }
  }

  loadIndex() {
    const file = path.join(this.dir, 'players-index.json');
    try {
      const d = JSON.parse(fs.readFileSync(file, 'utf8'));
      for (const [id, list] of Object.entries(d)) this.players.set(Number(id), list);
      return;
    } catch (e) { /* rebuild below */ }
    for (const k of this.have) if (k.startsWith('rw-')) { const w = this.get('rw', Number(k.slice(3))); if (w) this.indexWar(w); }
  }

  flush() {
    if (!this.indexDirty) return;
    const file = path.join(this.dir, 'players-index.json');
    try {
      fs.writeFileSync(`${file}.tmp`, JSON.stringify(Object.fromEntries(this.players)));
      fs.renameSync(`${file}.tmp`, file);
      this.indexDirty = false;
    } catch (e) { /* next time */ }
  }

  // A player's ranked wars in factions other than `exceptFaction`, newest first.
  playerWars(pid, exceptFaction, limit = 5) {
    const out = [];
    for (const wid of this.players.get(Number(pid)) || []) {
      const w = this.get('rw', wid);
      if (!w) continue;
      const f = w.factions.find(x => x.members.some(m => m[0] === Number(pid)));
      if (!f || f.id === exceptFaction) continue;
      const m = f.members.find(x => x[0] === Number(pid));
      const opp = w.factions.find(x => x.id !== f.id) || {};
      out.push({ war: w.id, end: w.end, faction: f.id, factionName: f.name, opp: opp.name || '', won: w.winner === f.id, attacks: m[3], score: m[4], factionAttacks: f.attacks });
    }
    return out.sort((a, b) => b.end - a.end).slice(0, limit);
  }

  async fetchRanked(api, id, priority = 9) {
    if (this.has('rw', id)) return this.get('rw', id);
    const d = await api.request(`/v2/faction/${id}/rankedwarreport`, { soft: [6, 7], priority });
    const r = d.rankedwarreport;
    if (!r || !r.end) return null; // still running: nothing to keep yet
    return this.put('rw', id, compactRanked(r));
  }

  async fetchChain(api, id, priority = 9) {
    if (this.has('ch', id)) return this.get('ch', id);
    const d = await api.request(`/v2/faction/${id}/chainreport`, { soft: [6, 7], priority });
    const c = d.chainreport;
    if (!c || !c.end) return null;
    return this.put('ch', id, compactChain(c));
  }

  stats() {
    let rw = 0, ch = 0;
    for (const k of this.have) { if (k.startsWith('rw-')) rw++; else ch++; }
    return { rankedWars: rw, chains: ch, players: this.players.size };
  }
}

module.exports = { WarArchive, compactRanked, compactChain, CHAIN_COLS };
