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

// ---- Where a player is (the Abroad list) ----
// From Torn's status text: "In Japan" while abroad; flying "Traveling from Torn to Japan" /
// "Traveling from Japan to Torn" (older wording: "Traveling to Japan", "Returning to Torn from Japan").
const norm = s => String(s || '').trim().replace(/\.$/, '').toLowerCase();
const sameCountry = (a, b) => !!a && !!b && norm(a) === norm(b);
function countryIn(st) {
  if (!st || st.state !== 'Abroad') return '';
  const m = /^In (.+?)\.?$/i.exec(String(st.description || '').trim());
  return m ? m[1] : '';
}
function returningFrom(st) {
  if (!st || st.state !== 'Traveling') return '';
  const s = String(st.description || '').trim();
  const m = /^Traveling from (.+?) to Torn\.?$/i.exec(s) || /^Returning to Torn from (.+?)\.?$/i.exec(s);
  return m ? m[1] : '';
}
// Your country for the Abroad list: where you are abroad, or where you're flying to. '' in Torn
// (or on the way home). `u` is the user feature's data.
function herePlace(u) {
  if (!u) return '';
  const st = u.status || {};
  const tr = u.travel;
  const dest = tr && tr.destination && tr.destination !== 'Torn' ? tr.destination : '';
  if (st.state === 'Abroad') return dest || countryIn(st);
  if (st.state === 'Traveling') return dest;
  return '';
}
// Each entry is on the Targets list (home, the default) and/or the Abroad list (abroad: true).
const onList = (t, which) => (which === 'abroad' ? !!t.abroad : t.home !== false);

class TargetsFeature extends EventEmitter {
  constructor({ api, store, notify, here = () => '' }) {
    super();
    this.api = api;
    this.store = store;
    this.notify = notify;
    this.here = here; // your country for the Abroad list ('' in Torn)
    this.inFlight = false;
    this.queueNote = '';
    this.edges = {};
    this.lastHere = null;
    this.left = { country: '', count: 0, names: [] }; // who left your country (removed from Abroad)
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
    return { targets: Object.values(this.list()), queue: this.queueNote, here: this.here(), left: this.left };
  }

  add(text) {
    const ids = parseIds(text);
    const list = this.list();
    // Entries are keyed by player ID, so nobody is ever listed twice: someone already on the list
    // is only checked again (and counted as `already`).
    let added = 0, already = 0;
    for (const id of ids) {
      if (list[id]) {
        list[id].force = true;
        if (list[id].home === false) { list[id].home = true; added++; } else already++; // was only on the Abroad list
        continue;
      }
      if (Object.keys(list).length >= MAX_TARGETS) break;
      list[id] = { id, name: '', level: 0, status: null, life: null, lastFetched: 0, force: true, invalid: false, error: '', addedAt: Date.now() };
      added++;
    }
    this.save(list);
    return { added, already, found: ids.length };
  }

  // Players from a list on a Torn page (right-click "Add all players in this list", main.js), with
  // the name and level the list showed so they read right before their first refresh. `from` marks
  // them ('list') so they can be removed together; players already on the list keep their own
  // entry and aren't marked. which = 'home' (Targets) or 'abroad' (the Abroad list).
  addPlayers(players, from = '', which = 'home') {
    const list = this.list();
    let added = 0, full = false;
    for (const p of players) {
      const id = Number(p && p.id);
      if (!Number.isInteger(id) || id <= 0) continue;
      const t = list[id];
      if (t) {
        t.force = true;
        if (!onList(t, which)) { if (which === 'abroad') t.abroad = true; else t.home = true; added++; }
        continue;
      }
      if (Object.keys(list).length >= MAX_TARGETS) { full = true; break; }
      const base = { id, name: String(p.name || '').slice(0, 40), level: Math.max(0, Math.min(100, Number(p.level) || 0)), status: null, life: null, lastFetched: 0, force: true, invalid: false, error: '', addedAt: Date.now() };
      list[id] = which === 'abroad' ? { ...base, home: false, abroad: true } : { ...base, from };
      added++;
    }
    this.save(list);
    return { added, found: players.length, full };
  }

  // Take an entry off one list; it's deleted once it's on neither.
  drop(list, id, which) {
    const t = list[id];
    if (!t) return false;
    if (which === 'abroad') t.abroad = false; else t.home = false;
    if (!t.abroad && t.home === false) { delete list[id]; delete this.edges[id]; }
    return true;
  }

  removeFrom(from) {
    const list = this.list();
    let removed = 0;
    for (const [id, t] of Object.entries(list)) if (from && t.from === from && onList(t, 'home') && this.drop(list, id, 'home')) removed++;
    this.save(list);
    return { removed };
  }

  addFromUrl(url) {
    const id = idFromUrl(url);
    if (!id) return { added: 0, found: 0 };
    return this.add(String(id));
  }

  remove(id, which = 'home') {
    const list = this.list();
    this.drop(list, id, which === 'abroad' ? 'abroad' : 'home');
    this.save(list);
  }

  clear(which = 'home') {
    const list = this.list();
    for (const [id, t] of Object.entries(list)) if (onList(t, which)) this.drop(list, id, which);
    this.save(list);
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
    // You arrived somewhere (or set off): check everyone on the Abroad list again.
    const here = this.here();
    if (here !== this.lastHere) {
      if (this.lastHere !== null && here) {
        const all = this.list();
        for (const t of Object.values(all)) if (t.abroad) t.force = true;
        this.save(all);
      }
      if (!sameCountry(here, this.left.country)) this.left = { country: here, count: 0, names: [] };
      this.lastHere = here;
      this.emit('state');
    }
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
      let leaving = false;
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
        // Where they are: the country they were last seen in (a hospital stay abroad keeps it).
        const was = t.lastIn || '';
        const nowIn = countryIn(t.status);
        if (nowIn) t.lastIn = nowIn;
        else if (t.status.state !== 'Hospital') t.lastIn = '';
        // Left the country you're in: off the Abroad list (the user's rule, 2026-11-21).
        const here = this.here();
        if (t.abroad && here && t.status.state !== 'Hospital' && !sameCountry(nowIn, here)
          && (sameCountry(was, here) || sameCountry(returningFrom(t.status), here))) leaving = true;
      });
      if (leaving) {
        const list = this.list();
        const t = list[id];
        if (t && this.drop(list, id, 'abroad')) {
          const here = this.here();
          if (!sameCountry(this.left.country, here)) this.left = { country: here, count: 0, names: [] };
          this.left = { country: here, count: this.left.count + 1, names: [t.name || `#${id}`, ...this.left.names].slice(0, 5) };
          this.save(list);
        }
      }
    } catch (e) {
      if (e.kind === 'soft') this.update(id, t => { t.invalid = true; t.force = false; t.error = e.message; t.lastFetched = Date.now(); });
      else if (e.kind === 'paused' || e.kind === 'network' || e.kind === 'backoff') { /* the API banner explains it; retry later */ }
    } finally {
      this.inFlight = false;
    }
  }
}

module.exports = { TargetsFeature, parseIds, idFromUrl, herePlace, countryIn };
