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
