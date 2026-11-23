'use strict';
// Item prices and trading data, all from the official Torn API (public-level data):
// - Item catalog with Torn's market value for every item: /v2/torn/items (one request, cached 6h)
// - Live item market listings for one item: /v2/market/{id}/itemmarket (globally cached by Torn)
// - Points market: /v2/market/pointsmarket
// The travel planner reads prices from here too.

const { EventEmitter } = require('events');

const CATALOG_MAX_AGE = 6 * 3600 * 1000;
const LIVE_MIN_AGE = 60 * 1000;          // never re-fetch one item's listings more often than this
const LIVE_KEEP = 30 * 60 * 1000;        // drop live results older than this from the snapshot
const POINTS_AGE = 5 * 60 * 1000;        // points market refresh while the Market panel is open
const MAX_QUEUED_LIVE = 25;

const marketUrl = id => `https://www.torn.com/page.php?sid=ItemMarket#/market/view=search&itemID=${id}`;

class MarketFeature extends EventEmitter {
  constructor({ api, store, cache, notify, history }) {
    super();
    this.api = api;
    this.store = store;
    this.cache = cache;
    this.notify = notify;
    this.history = history;
    this.bazaar = null;         // set by main.js (BazaarFeature)
    this.scan = null;           // { type, ids, queue, startedAt }
    this.catalogInFlight = false;
    this.catalogTriedAt = 0;
    this.live = new Map();      // id -> { fetchedAt, lowest, average, listings, next }
    this.pending = new Set();   // ids queued for a live fetch
    this.points = null;
    this.pointsInFlight = false;
    this.emitTimer = null;
  }

  // ---- Catalog ----
  catalog() {
    return this.cache.get('items') || null;
  }

  // Map for the UI: id -> [name, type, marketValue, circulation, tradable, shops]
  catalogCompact() {
    const c = this.catalog();
    if (!c) return { fetchedAt: 0, items: {} };
    return { fetchedAt: c.fetchedAt, items: c.items };
  }

  item(id) {
    const c = this.catalog();
    return c ? c.items[id] || null : null;
  }

  marketValue(id) {
    const it = this.item(id);
    return it ? it[2] : 0;
  }

  async fetchCatalog(now) {
    this.catalogInFlight = true;
    this.catalogTriedAt = now;
    try {
      const d = await this.api.request('/v2/torn/items', { priority: 7 });
      const items = {};
      // id -> [name, type, marketValue, circulation, tradable, shops]
      // shops: [[country, shop, buyPrice, sellPrice], ...] (where Torn shops sell/buy it)
      for (const it of d.items || []) {
        const v = it.value || {};
        const shops = (v.shops || []).map(sh => [sh.country, sh.shop, sh.buy_price || 0, sh.sell_price || 0]);
        items[it.id] = [it.name, it.type, v.market_price || 0, it.circulation || 0, !!it.is_tradable, shops];
      }
      this.cache.set('items', { fetchedAt: Date.now(), items });
      this.history.recordMarketValues(items, Date.now());
      this.emitSoon();
    } catch (e) { /* the API banner explains errors; retried after 10 min */ }
    finally { this.catalogInFlight = false; }
  }

  // ---- Live listings ----
  requestLive(ids, priority = 7) {
    const now = Date.now();
    let queued = 0;
    for (const raw of ids) {
      const id = Number(raw);
      if (!id || this.pending.has(id)) continue;
      const l = this.live.get(id);
      if (l && now - l.fetchedAt < Math.max(LIVE_MIN_AGE, l.next ? l.next - l.fetchedAt : 0)) continue;
      if (this.pending.size >= MAX_QUEUED_LIVE) break;
      this.pending.add(id);
      queued++;
      this.fetchLive(id, priority);
    }
    if (queued) this.emitSoon();
    return { queued };
  }

  async fetchLive(id, priority) {
    try {
      const d = await this.api.request(`/v2/market/${id}/itemmarket?limit=20`, { priority, soft: [6, 7] });
      const m = d.itemmarket || {};
      const listings = (m.listings || []).map(l => ({ price: l.price, amount: l.amount })).sort((a, b) => a.price - b.price);
      this.live.set(id, {
        fetchedAt: Date.now(),
        lowest: listings.length ? listings[0].price : 0,
        average: (m.item && m.item.average_price) || 0,
        listings: listings.slice(0, 8),
        next: m.cache_delay ? Date.now() + m.cache_delay * 1000 : 0,
      });
      this.history.recordLowest(id, Date.now(), listings.length ? listings[0].price : 0);
      this.checkWatch(id);
    } catch (e) {
      if (e.kind === 'soft') this.live.set(id, { fetchedAt: Date.now(), lowest: 0, average: 0, listings: [], error: e.message });
    } finally {
      this.pending.delete(id);
      this.emitSoon();
    }
  }

  // ---- Watchlist + price alerts ----
  watch() {
    return this.store.get('market.watch') || {};
  }

  addWatch(id, below) {
    id = Number(id);
    if (!id) return;
    const w = this.watch();
    w[id] = { id, below: Number(below) > 0 ? Number(below) : 0, lastCheck: 0 };
    this.store.set('market.watch', w);
    this.requestLive([id], 6);
    this.emitSoon();
  }

  setBelow(id, below) {
    const w = this.watch();
    if (!w[id]) return;
    w[id].below = Number(below) > 0 ? Number(below) : 0;
    delete w[id].alerted;
    this.store.set('market.watch', w);
    this.checkWatch(Number(id));
    this.emitSoon();
  }

  removeWatch(id) {
    const w = this.watch();
    delete w[id];
    this.store.set('market.watch', w);
    this.emitSoon();
  }

  // Cheapest price for an item from the chosen source: item market, bazaars, or both.
  lowestFor(id) {
    const src = this.store.get('market.priceSource') || 'both';
    const l = this.live.get(id);
    const market = src !== 'bazaar' && l && l.lowest ? l.lowest : 0;
    const baz = src !== 'market' && this.bazaar && this.bazaar.enabled() ? this.bazaar.lowest(id) : 0;
    if (market && (!baz || market <= baz)) return { price: market, where: 'item market' };
    if (baz) return { price: baz, where: 'a bazaar' };
    return { price: 0, where: '' };
  }

  // Alert when the price first drops to the target, or drops further after that. The price
  // last alerted on is saved, so restarting the app doesn't repeat alerts for the same deal.
  checkWatch(id) {
    const all = this.watch();
    const w = all[id];
    if (!w || !w.below) return;
    const { price, where } = this.lowestFor(id);
    if (!price) return;
    const alerted = w.alerted || 0;
    if (price > w.below) {
      if (alerted) {
        delete w.alerted;
        this.store.set('market.watch', all);
      }
      return;
    }
    if (alerted && price >= alerted) return;
    w.alerted = price;
    this.store.set('market.watch', all);
    const it = this.item(id);
    const name = it ? it[0] : `Item ${id}`;
    this.notify(`${name}: $${price.toLocaleString('en-US')} in ${where}`, `At or below your $${w.below.toLocaleString('en-US')} target.`, marketUrl(id), 'market');
  }

  checkAllWatches() {
    for (const id of Object.keys(this.watch())) this.checkWatch(Number(id));
  }

  // ---- Points market ----
  async fetchPoints() {
    this.pointsInFlight = true;
    try {
      const d = await this.api.request('/v2/market/pointsmarket', { priority: 7 });
      const list = (d.pointsmarket || []).map(p => ({ cost: p.cost, quantity: p.quantity })).sort((a, b) => a.cost - b.cost);
      this.points = { fetchedAt: Date.now(), lowest: list.length ? list[0].cost : 0, listings: list.slice(0, 5) };
    } catch (e) {
      this.points = { fetchedAt: Date.now(), lowest: 0, listings: [], error: e.message };
    } finally {
      this.pointsInFlight = false;
      this.emitSoon();
    }
  }

  refreshPoints() {
    this.points = this.points ? { ...this.points, fetchedAt: 0 } : null;
  }

  // ---- Deal scanner: live listings for every tradable item of one type ('*' = all types) ----
  // Items worth at least minValue only. Most valuable first, so the biggest deals show early.
  startScan(type, minValue = 0) {
    const c = this.catalog();
    if (!c) return { total: 0 };
    const ids = Object.entries(c.items)
      .filter(([, it]) => (type === '*' || it[1] === type) && it[4] && it[2] > 0 && it[2] >= minValue)
      .sort((a, b) => b[1][2] - a[1][2])
      .map(([id]) => Number(id));
    this.scan = { type, ids, queue: [...ids], startedAt: Date.now() };
    this.emitSoon();
    return { total: ids.length };
  }

  stopScan() {
    if (this.scan) this.scan.queue = [];
    this.emitSoon();
  }

  // ---- Loop ----
  tick(now) {
    if (!this.api.hasKey()) return;
    const c = this.catalog();
    if (!this.catalogInFlight && (!c || now - c.fetchedAt > CATALOG_MAX_AGE) && now - this.catalogTriedAt > 10 * 60 * 1000) this.fetchCatalog(now);

    const every = Math.max(60, Number(this.store.get('market.watchInterval')) || 300) * 1000;
    const w = this.watch();
    // Watched items need item market requests only when the item market is a price source;
    // bazaar prices come from the Weav3r summary (no Torn requests).
    if (this.store.get('market.priceSource') !== 'bazaar') {
      const due = Object.keys(w).map(Number).filter(id => {
        const l = this.live.get(id);
        return !l || now - l.fetchedAt >= every;
      });
      if (due.length) this.requestLive(due, 6);
    }

    const looking = this.viewing ? this.viewing('market') : this.store.get('ui.panel') === 'market';
    if (looking && !this.pointsInFlight && (!this.points || now - this.points.fetchedAt >= POINTS_AGE)) this.fetchPoints();

    // Feed the scan a few items at a time so other features keep their share of requests.
    // The scan only uses ~80% of the per-minute budget, leaving room for everything else.
    if (this.scan && this.scan.queue.length && this.pending.size < 3) {
      const st = this.api.status();
      if (st.usedLastMinute < st.maxPerMinute * 0.8) this.requestLive(this.scan.queue.splice(0, 3 - this.pending.size), 8);
    }

    const keep = new Set(this.scan ? this.scan.ids : []);
    for (const [id, l] of this.live) if (now - l.fetchedAt > LIVE_KEEP && !w[id] && !keep.has(id)) this.live.delete(id);
  }

  emitSoon() {
    if (this.emitTimer) return;
    this.emitTimer = setTimeout(() => { this.emitTimer = null; this.emit('state'); }, 200);
  }

  snapshot() {
    const c = this.catalog();
    return {
      catalogAt: c ? c.fetchedAt : 0,
      catalogCount: c ? Object.keys(c.items).length : 0,
      watch: Object.values(this.watch()),
      live: Object.fromEntries(this.live),
      pending: [...this.pending],
      points: this.points,
      scan: this.scan ? { type: this.scan.type, ids: this.scan.ids, left: this.scan.queue.length, startedAt: this.scan.startedAt } : null,
    };
  }
}

module.exports = { MarketFeature, marketUrl };
