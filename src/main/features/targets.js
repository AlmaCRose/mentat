'use strict';
// A list of players with their status and hospital/jail timers.
// Ported from torn-target-tracker.user.js. One /user/{id}?selections=profile request per
// target, one at a time, through the shared rate-limited queue.

const { EventEmitter } = require('events');

const MAX_TARGETS = 250;

function parseIds(text) {
  const ids = new Set();
  // Profile/attack URLs first, then bare numbers.
  for (const m of String(text).matchAll(/(?:XID|user2ID|ID)=(\d+)/gi)) ids.add(Number(m[1]));
  const rest = String(text).replace(/https?:\/\/\S+/gi, ' ');
  for (const m of rest.matchAll(/\b(\d{1,8})\b/g)) ids.add(Number(m[1]));
  return [...ids].filter(n => n > 0);
}

function idFromUrl(url) {
  const m = /[?&#](?:XID|user2ID)=(\d+)/i.exec(String(url));
  return m ? Number(m[1]) : 0;
}

class TargetsFeature extends EventEmitter {
  constructor({ api, store, notify }) {
    super();
    this.api = api;
    this.store = store;
    this.notify = notify;
    this.inFlight = false;
    this.queueNote = '';
    this.edges = {};
  }

  list() {
    return this.store.get('targets.list') || {};
  }

  save(list) {
    this.store.set('targets.list', list);
    this.emit('state');
  }

  update(id, fn) {
    const list = this.list();
    if (!list[id]) return;
    fn(list[id]);
    this.save(list);
  }

  snapshot() {
    return { targets: Object.values(this.list()), queue: this.queueNote };
  }

  add(text) {
    const ids = parseIds(text);
    const list = this.list();
    let added = 0;
    for (const id of ids) {
      if (list[id]) { list[id].force = true; continue; }
      if (Object.keys(list).length >= MAX_TARGETS) break;
      list[id] = { id, name: '', level: 0, status: null, life: null, lastFetched: 0, force: true, invalid: false, error: '', addedAt: Date.now() };
      added++;
    }
    this.save(list);
    return { added, found: ids.length };
  }

  addFromUrl(url) {
    const id = idFromUrl(url);
    if (!id) return { added: 0, found: 0 };
    return this.add(String(id));
  }

  remove(id) {
    const list = this.list();
    delete list[id];
    delete this.edges[id];
    this.save(list);
  }

  clear() {
    this.edges = {};
    this.save({});
  }

  refresh(id) {
    this.update(id, t => { t.force = true; t.invalid = false; });
  }

  refreshAll() {
    const list = this.list();
    for (const t of Object.values(list)) { t.force = true; t.invalid = false; }
    this.save(list);
  }

  isDue(t, s, now) {
    if (t.invalid) return false;
    if (t.force || !t.lastFetched) return true;
    return s.autoRefresh && now - t.lastFetched >= Math.max(30, s.interval || 120) * 1000;
  }

  tick(now) {
    const s = this.store.get('targets') || {};
    const list = this.list();

    // Hospital/jail timers that ran out locally: notify once, and re-check if auto refresh is on.
    for (const t of Object.values(list)) {
      const st = t.status;
      if (!st) { delete this.edges[t.id]; continue; }
      const free = (st.state === 'Okay' || ((st.state === 'Hospital' || st.state === 'Jail') && st.until > 0 && st.until <= now));
      const prev = this.edges[t.id];
      this.edges[t.id] = free;
      if (prev === false && free) {
        if (s.notify) this.notify(`${t.name || '#' + t.id} is out`, st.state === 'Okay' ? 'Status: Okay' : `${st.state} timer ended`, `https://www.torn.com/profiles.php?XID=${t.id}`);
        if (s.autoRefresh && st.state !== 'Okay') this.update(t.id, x => { x.force = true; });
      }
    }

    let note = '';
    const due = Object.values(this.list()).filter(t => this.isDue(t, s, now))
      .sort((a, b) => ((a.force || !a.lastFetched ? 0 : 1) - (b.force || !b.lastFetched ? 0 : 1)) || (a.lastFetched || 0) - (b.lastFetched || 0));
    if (!this.api.hasKey()) note = '';
    else if (this.inFlight) note = due.length > 1 ? `Refreshing… ${due.length - 1} queued` : 'Refreshing…';
    else if (due.length) {
      this.fetch(due[0].id);
      note = due.length > 1 ? `Refreshing… ${due.length - 1} queued` : 'Refreshing…';
    }
    if (note !== this.queueNote) {
      this.queueNote = note;
      this.emit('state');
    }
  }

  async fetch(id) {
    this.inFlight = true;
    try {
      const d = await this.api.request(`/user/${id}?selections=profile`, { soft: [6, 7], priority: 6 });
      this.emit('profile', id, d); // its picture, for the avatars
      this.update(id, t => {
        t.name = d.name;
        t.level = d.level;
        t.faction = d.faction && d.faction.faction_name ? d.faction.faction_name : '';
        t.status = { state: d.status.state, description: d.status.description, until: (d.status.until || 0) * 1000 };
        t.life = d.life ? { current: d.life.current, maximum: d.life.maximum } : null;
        t.lastAction = d.last_action ? { status: d.last_action.status, relative: d.last_action.relative } : null;
        t.lastFetched = Date.now();
        t.force = false;
        t.invalid = false;
        t.error = '';
      });
    } catch (e) {
      if (e.kind === 'soft') this.update(id, t => { t.invalid = true; t.force = false; t.error = e.message; t.lastFetched = Date.now(); });
      else if (e.kind === 'paused' || e.kind === 'network' || e.kind === 'backoff') { /* the API banner explains it; retry later */ }
    } finally {
      this.inFlight = false;
    }
  }
}

module.exports = { TargetsFeature, parseIds, idFromUrl };
