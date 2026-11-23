'use strict';
// Planner: your plan for the next few days (trips, gym, crimes, boosts, blood bags, notes),
// kept as `planner.items` (synced between your devices, merged item by item) and
// `planner.days` (how many days the plan covers). A removed item stays behind as a small
// { id, deleted: true, at, updatedAt } marker until it's old, so the removal reaches your other
// devices instead of being undone by one that still has the item (syncmerge.mergePlan). Reminders fire here, a set number of
// minutes before an item, like the custom alerts. The projections (bars, restocks) are worked
// out on the page (ui/planner.js, ui/planner-math.js) from data the app already has, so the
// planner makes no API requests of its own.

const { EventEmitter } = require('events');
const { COUNTRIES, METHODS } = require('./travel');

const TYPES = ['trip', 'gym', 'crimes', 'energy', 'nerve', 'blood', 'life', 'note'];
const ENERGY_KINDS = ['xanax', 'refill', 'fhc', 'can', 'custom'];
const NERVE_KINDS = ['refill', 'custom'];
const MAX_ITEMS = 1000;
const KEEP_PAST = 7 * 86400 * 1000;   // done or past items are kept a week, then dropped
const KEEP_GONE = 30 * 86400 * 1000;  // removal markers are kept a month after the removal
const MAX_LATE = 3 * 60 * 1000;       // a reminder more than 3 minutes late (PC asleep) is skipped
const T = 'https://www.torn.com/';
const CODES = new Set(COUNTRIES.map(c => c.code));
const nameOf = code => (COUNTRIES.find(c => c.code === code) || { name: code }).name;

const int = (v, lo, hi, d = 0) => { const n = Math.round(Number(v)); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : d; };
const str = (v, n) => String(v == null ? '' : v).replace(/[\u0000-\u001f]/g, ' ').slice(0, n);

class PlannerFeature extends EventEmitter {
  constructor({ store, notify }) {
    super();
    this.store = store;
    this.notify = notify;
    this.lastPrune = 0;
  }

  all() { return this.store.get('planner.items') || {}; }
  // The plan without removal markers.
  items() { return Object.fromEntries(Object.entries(this.all()).filter(([, it]) => it && !it.deleted)); }
  save(items) { this.store.set('planner.items', items); this.emit('state'); }
  gone(it, now) { return { id: it.id, deleted: true, at: it.at, updatedAt: now }; }

  // A plan item from the page, checked field by field.
  static clean(raw, now = Date.now()) {
    const r = raw && typeof raw === 'object' ? raw : {};
    if (!TYPES.includes(r.type)) throw new Error('Unknown plan item');
    const at = Number(r.at);
    if (!Number.isFinite(at) || at < now - 30 * 86400e3 || at > now + 400 * 86400e3) throw new Error('Pick a time within the plan');
    const it = { type: r.type, at: Math.round(at / 1000) * 1000, note: str(r.note, 300), remind: int(r.remind, -1, 1440, -1), done: !!r.done };
    // Reminder style: '' = the Settings choice for this kind, 'on' = urgent popup, 'off' = normal.
    if (r.urgent === 'on' || r.urgent === 'off') it.urgent = r.urgent;
    if (r.type === 'trip') {
      if (!CODES.has(r.country)) throw new Error('Pick a country');
      it.country = r.country;
      it.method = METHODS.includes(r.method) ? r.method : '';
      it.itemId = int(r.itemId, 0, 1e6, 0);
      it.stay = int(r.stay, 0, 24 * 60, 0);
      // Money to bring (worked out on the page from abroad shop prices + the ticket), for the reminder.
      if (r.bring && typeof r.bring === 'object' && Number(r.bring.total) > 0) it.bring = { total: int(r.bring.total, 0, 1e13, 0), text: str(r.bring.text, 120) };
    } else if (r.type === 'gym' || r.type === 'crimes') {
      it.amount = int(r.amount, 0, 100000, 0); // 0 = all you have
    } else if (r.type === 'energy' || r.type === 'nerve') {
      const kinds = r.type === 'energy' ? ENERGY_KINDS : NERVE_KINDS;
      it.kind = kinds.includes(r.kind) ? r.kind : 'custom';
      it.amount = int(r.amount, 0, 100000, 0);
      if (r.cd === 'drug' || r.cd === 'booster' || r.cd === '') it.cd = r.cd;
      if (r.cdHours !== undefined && r.cdHours !== null && r.cdHours !== '') it.cdHours = Math.max(0, Math.min(48, Number(r.cdHours) || 0));
    } else if (r.type === 'blood') {
      it.count = int(r.count, 1, 50, 1);
    } else if (r.type === 'life') {
      it.amount = int(r.amount, -100000, 100000, 0);
      it.cdHours = Math.max(0, Math.min(24, Number(r.cdHours) || 0));
    }
    return it;
  }

  add(raw) {
    const items = this.items();
    if (Object.keys(items).length >= MAX_ITEMS) throw new Error(`Up to ${MAX_ITEMS} plan items`);
    const id = `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const it = { id, ...PlannerFeature.clean(raw), updatedAt: Date.now() };
    this.save({ ...this.all(), [id]: it });
    return it;
  }

  update(id, patch) {
    const items = this.items();
    const old = items[id];
    if (!old) throw new Error('That plan item is gone (removed on another device?)');
    const it = { id, ...PlannerFeature.clean({ ...old, ...(patch && typeof patch === 'object' ? patch : {}) }), updatedAt: Date.now() };
    this.save({ ...this.all(), [id]: it });
    return it;
  }

  remove(id) {
    const all = { ...this.all() };
    if (!all[id] || all[id].deleted) return;
    all[id] = this.gone(all[id], Date.now());
    this.save(all);
  }

  // Copies every item of one TCT day to another (same times of day). Returns how many.
  copyDay(fromDay, toDay) {
    const DAY = 86400e3;
    const from = Date.parse(`${fromDay}T00:00:00Z`), to = Date.parse(`${toDay}T00:00:00Z`);
    if (!Number.isFinite(from) || !Number.isFinite(to) || from === to) throw new Error('Pick two different days');
    const items = { ...this.all() };
    let n = 0;
    for (const it of Object.values(this.items())) {
      if (it.at < from || it.at >= from + DAY) continue;
      const id = `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}${n}`;
      items[id] = { ...it, id, at: it.at - from + to, done: false, updatedAt: Date.now() };
      n++;
    }
    if (Object.keys(this.items()).length + n > MAX_ITEMS) throw new Error(`Up to ${MAX_ITEMS} plan items`);
    if (n) this.save(items);
    return n;
  }

  clearDay(day) {
    const from = Date.parse(`${day}T00:00:00Z`);
    if (!Number.isFinite(from)) throw new Error('Pick a day');
    const now = Date.now();
    const all = { ...this.all() };
    for (const [id, it] of Object.entries(all)) if (!it.deleted && it.at >= from && it.at < from + 86400e3) all[id] = this.gone(it, now);
    this.save(all);
  }

  // ---- Reminders ----
  title(it) {
    if (it.type === 'trip') return `Trip to ${nameOf(it.country)}`;
    if (it.type === 'gym') return it.amount ? `Gym: ${it.amount} energy` : 'Gym: spend your energy';
    if (it.type === 'crimes') return it.amount ? `Crimes: ${it.amount} nerve` : 'Crimes: spend your nerve';
    if (it.type === 'energy') return { xanax: 'Take a Xanax', refill: 'Energy refill', fhc: 'Use a Feathery Hotel Coupon', can: 'Energy drink' }[it.kind] || `+${it.amount} energy`;
    if (it.type === 'nerve') return it.kind === 'refill' ? 'Nerve refill' : `+${it.amount} nerve`;
    if (it.type === 'blood') return `Fill ${it.count} blood bag${it.count === 1 ? '' : 's'}`;
    if (it.type === 'life') return it.amount >= 0 ? `+${it.amount} life` : `${it.amount} life`;
    return it.note ? it.note.slice(0, 60) : 'Plan note';
  }

  url(it) {
    return { trip: `${T}page.php?sid=travel`, gym: `${T}gym.php`, crimes: `${T}page.php?sid=crimes`, energy: `${T}item.php`, nerve: `${T}points.php`, blood: `${T}hospitalview.php`, life: `${T}item.php#medical-items` }[it.type] || `${T}index.php`;
  }

  tick(now) {
    const items = this.items();
    const fired = this.store.get('planner.fired') || {};
    let firedChanged = false;
    for (const it of Object.values(items)) {
      if (it.done || !(it.remind >= 0)) continue;
      const at = it.at - it.remind * 60000;
      const key = `${it.id}|${it.at}|${it.remind}`;
      if (now < at || fired[key]) continue;
      fired[key] = now;
      firedChanged = true;
      if (now - at > MAX_LATE) continue;
      const when = it.remind ? `in ${it.remind} min (${new Date(it.at).toISOString().slice(11, 16)} TCT)` : 'now';
      // Urgent popup: the item's own choice, else the setting for trips / other plan items.
      const kind = it.urgent === 'on' ? true : it.urgent === 'off' ? false : it.type === 'trip' ? 'trip' : 'plan';
      const bring = it.type === 'trip' && it.bring && it.bring.total ? ` · bring $${it.bring.total.toLocaleString('en-US')}${it.bring.text ? ` (${it.bring.text})` : ''}` : '';
      this.notify(`Plan: ${this.title(it)}`, `${when}${bring}${it.note && it.type !== 'note' ? ` · ${it.note}` : ''}`, this.url(it), kind);
    }
    // Once an hour: forget old reminders and drop items more than a week in the past.
    if (now - this.lastPrune > 3600e3) {
      this.lastPrune = now;
      for (const [k, t] of Object.entries(fired)) if (now - t > KEEP_PAST) { delete fired[k]; firedChanged = true; }
      const all = this.all();
      const keep = Object.fromEntries(Object.entries(all).filter(([, it]) => it && now - it.at < KEEP_PAST && !(it.deleted && now - (it.updatedAt || 0) > KEEP_GONE)));
      if (Object.keys(keep).length !== Object.keys(all).length) { this.save(keep); this.emit('pruned'); }
    }
    if (firedChanged) this.store.set('planner.fired', fired);
  }

  snapshot() {
    return { items: this.items(), days: this.store.get('planner.days') || 3 };
  }
}

module.exports = { PlannerFeature, TYPES };
