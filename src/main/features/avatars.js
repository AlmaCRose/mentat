'use strict';
// Profile pictures for the players Mentat shows (Targets, faction lists, war boards, research).
// Torn gives a full image address with a player's profile (v1 `profile_image`, v2 `profile.image`;
// checked against the live API 2026-11-18), so pictures come from:
//   - profile requests Mentat already makes (Targets, your own profile): free, via put();
//   - a slow background queue for players on screen the page asks about (want()): one
//     /user/{id}?selections=profile every 8 s at the lowest priority, so it never gets in the way.
// Kept on this device in avatars.json: an address for 14 days, "no picture" for 3 days.

const { EventEmitter } = require('events');
const { Store } = require('../store');

const KEEP = 14 * 86400e3;
const KEEP_NONE = 3 * 86400e3;
const DROP = 30 * 86400e3;
const GAP = 8000;        // between background requests (about 7 a minute)
const MAX_QUEUE = 400;
const EMIT_EVERY = 1500; // the page gets new pictures in batches

class AvatarsFeature extends EventEmitter {
  constructor({ api, store, dataDir }) {
    super();
    this.api = api;
    this.store = store;
    this.db = new Store(`${dataDir}/avatars.json`, { p: {} }, { debounceMs: 10000 });
    if (!this.db.data.p || typeof this.db.data.p !== 'object') this.db.data.p = {};
    const now = Date.now();
    for (const [id, e] of Object.entries(this.db.data.p)) if (!Array.isArray(e) || now - e[1] > DROP) delete this.db.data.p[id];
    this.queue = [];
    this.queued = new Set();
    this.inFlight = false;
    this.lastReq = 0;
    this.dirty = false;
    this.lastEmit = 0;
  }

  enabled() { return this.store.get('ui.avatars') !== false; }

  fresh(id, now = Date.now()) {
    const e = this.db.data.p[id];
    return !!e && now - e[1] < (e[0] ? KEEP : KEEP_NONE);
  }

  // A picture seen in a response Mentat made anyway ('' = the player has none).
  put(id, url) {
    id = Number(id);
    if (!(id > 0)) return;
    url = typeof url === 'string' && /^https:\/\/[a-z0-9.-]+\.torn\.com\//i.test(url) ? url : '';
    const old = this.db.data.p[id];
    this.db.data.p[id] = [url, Date.now()];
    this.db.save();
    if (!old || old[0] !== url) this.dirty = true;
  }

  // The page shows these players: fetch the ones without a fresh picture, a few a minute.
  want(ids) {
    if (!this.enabled()) return 0;
    let n = 0;
    for (const raw of Array.isArray(ids) ? ids : []) {
      const id = Number(raw);
      if (!(id > 0) || this.queued.has(id) || this.fresh(id)) continue;
      if (this.queue.length >= MAX_QUEUE) break;
      this.queue.push(id);
      this.queued.add(id);
      n++;
    }
    return n;
  }

  tick(now) {
    if (this.dirty && now - this.lastEmit > EMIT_EVERY) { this.dirty = false; this.lastEmit = now; this.emit('state'); }
    if (!this.enabled() || this.inFlight || !this.queue.length || now - this.lastReq < GAP) return;
    const st = this.api.status();
    // No key, paused, or the key is busy (over half its minute used): pictures wait.
    if (!st.hasKey || st.pausedUntil || st.queued > 2 || st.usedLastMinute > st.maxPerMinute / 2) return;
    const id = this.queue.shift();
    this.queued.delete(id);
    if (this.fresh(id, now)) return;
    this.inFlight = true;
    this.lastReq = now;
    this.api.request(`/user/${id}?selections=profile`, { soft: [6, 7], priority: 9 })
      .then(d => this.put(id, d && d.profile_image))
      .catch(e => { if (e && e.kind === 'soft') this.put(id, ''); /* other errors: asked again later */ })
      .finally(() => { this.inFlight = false; });
  }

  snapshot() {
    const map = {};
    for (const [id, e] of Object.entries(this.db.data.p)) if (e[0]) map[id] = e[0];
    return { enabled: this.enabled(), map, queued: this.queue.length };
  }
}

module.exports = { AvatarsFeature };
