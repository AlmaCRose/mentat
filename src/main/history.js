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
