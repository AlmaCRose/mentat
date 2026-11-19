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
// The API doesn't say when someone lands, but it gives the destination ("Traveling to
// Mexico" / "Returning to Torn from Mexico") and the plane: private jet = WLT, light
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
  let m = /^Traveling to (.+?)\.?$/i.exec(s);
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
      if (now - this.last.enemy >= this.interval()) return this.fetchEnemy;
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
      history: h && r && h.warId === r.id ? h : null,
    };
  }
}

module.exports = { WarFeature, counts, member };
