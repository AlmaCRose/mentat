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

  async fetchYata(now) {
    this.yataInFlight = true;
    this.lastYata = now;
    try {
      const res = await fetch(YATA_URL, { signal: AbortSignal.timeout(20000), headers: { Accept: 'application/json', 'User-Agent': 'Mentat' } });
      if (res.status === 429) throw new Error('YATA rate limit reached');
      if (!res.ok) throw new Error(`YATA returned HTTP ${res.status}`);
      const d = await res.json();
      if (!d || !d.stocks) throw new Error('Unexpected YATA response');
      this.record(d.stocks);
      this.state.error = '';
      this.state.fetchedAt = Date.now();
      this.state.yataTimestamp = (d.timestamp || 0) * 1000;
    } catch (e) {
      this.state.error = e.name === 'TimeoutError' ? 'YATA timed out' : e.message || 'Could not reach YATA';
    } finally {
      this.yataInFlight = false;
      this.rebuild(Date.now());
      this.emit('state');
    }
  }

  record(stocks) {
    const now = Date.now();
    const hc = this.history.data.countries;
    for (const c of COUNTRIES) {
      const s = stocks[c.code];
      if (!s || !Array.isArray(s.stocks)) continue;
      const h = hc[c.code] || (hc[c.code] = { update: 0, items: {}, meta: {} });
      const t = (s.update || 0) * 1000;
      h.latest = s.stocks.map(i => ({ id: i.id, name: i.name, quantity: i.quantity, cost: i.cost }));
      if (t <= h.update) continue; // no new reading for this country
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
    if (!this.remote() && this.store.get('travel.yata') && !this.yataInFlight && now - this.lastYata >= YATA_EVERY) this.fetchYata(now);
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
