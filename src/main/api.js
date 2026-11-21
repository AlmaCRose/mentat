'use strict';
// The one and only way the app talks to Torn's API.
//
// Compliance (Torn API rules + "Scripting Abuse" game rule):
// - Requests go only to api.torn.com. Nothing here fetches or reads torn.com pages.
// - Every feature shares one queue, capped well below Torn's 100 requests/min per user
//   (default 40/min, at least 1s apart).
// - Invalid/disabled keys are removed on the first error so they are never retried.
// - Other errors pause all requests for a while instead of retrying straight away.
// - The key is encrypted with Windows DPAPI (Electron safeStorage) and only stored on this PC.

const { EventEmitter } = require('events');
// Electron's safeStorage when running in the app; the sync server passes its key in instead.
let safeStorage = null;
try { ({ safeStorage } = require('electron')); } catch (e) { /* plain Node */ }

const API_BASE = 'https://api.torn.com';
const API_COMMENT = 'Mentat';
const MIN_GAP_MS = 1000;
const TIMEOUT_MS = 15000;
const KEY_PATTERN = /^[A-Za-z0-9]{16}$/;
// "Each user can make up to 100 individual requests per minute across all of their keys"
// (torn.com/api.html). The calls your other Mentat devices and the Mentat server make with your
// key count too (reported by the server, see setOthers), so all of them together stay under this.
const TORN_LIMIT = 100;
const ALL_MENTAT_MAX = 95; // leaves a little room for other tools
const MIN_BUDGET = 5; // this device never stops completely
const OTHERS_FRESH_MS = 150e3; // a report older than this no longer counts

// Errors that mean the key itself is unusable: remove it and stop.
const KEY_ERRORS = {
  1: 'Key is empty',
  2: 'Incorrect key',
  10: 'Key owner is in federal jail',
  13: 'Key disabled due to owner inactivity',
  18: 'Key paused by owner',
};
// Errors that mean "stop for a while" (seconds). Unknown codes back off 5 minutes.
// 16 ("access level too low") is listed as soft by the features that can live without it.
const BACKOFF_ERRORS = { 0: 60, 5: 120, 8: 900, 9: 900, 12: 60, 14: 3600, 15: 60, 16: 300, 17: 60, 24: 900 };

class ApiError extends Error {
  // kind: 'nokey' | 'paused' | 'network' | 'key' | 'soft' | 'backoff'
  constructor(kind, message, code = null) {
    super(message);
    this.kind = kind;
    this.code = code;
  }
}

function fmtDur(sec) {
  sec = Math.max(0, Math.round(sec));
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.round(sec / 60)} min`;
  return `${Math.round(sec / 3600)} h`;
}

class TornApi extends EventEmitter {
  constructor(store, { getKey = null } = {}) {
    super();
    this.store = store;
    this.fixedKey = getKey; // the sync server's key source (no DPAPI there)
    this.queue = [];
    this.log = [];
    this.lastAt = 0;
    this.timer = null;
    this.pausedUntil = 0;
    this.banner = '';
    this.others = null; // { n, detail, at }: calls made elsewhere with this player's key, last minute
  }

  // ---- Key ----
  getKey() {
    if (this.fixedKey) return this.fixedKey() || '';
    const enc = this.store.get('api.keyEnc');
    if (!enc) return '';
    try {
      return safeStorage.decryptString(Buffer.from(enc, 'base64'));
    } catch (e) {
      return '';
    }
  }

  hasKey() {
    if (this.fixedKey) return !!this.fixedKey();
    return !!this.store.get('api.keyEnc');
  }

  // Checks a key with one request before saving it. Returns the account it belongs to.
  async saveKey(key) {
    key = String(key || '').trim();
    if (!KEY_PATTERN.test(key)) throw new Error('A Torn API key is 16 letters and numbers.');
    const me = await this.request('/user/?selections=basic', { key, priority: 0 });
    let access = '';
    try {
      const info = await this.request('/key/?selections=info', { key, priority: 0, soft: [16, 22, 23] });
      access = (info.access_type || '').trim();
    } catch (e) { /* key info is a nice-to-have */ }
    let enc;
    try {
      enc = safeStorage.encryptString(key).toString('base64');
    } catch (e) {
      throw new Error('Windows encryption is unavailable, so the key cannot be stored safely.');
    }
    this.store.set('api.keyEnc', enc);
    this.store.set('api.account', { id: me.player_id, name: me.name, access });
    this.pausedUntil = 0;
    this.setBanner('');
    this.emit('key');
    return this.store.get('api.account');
  }

  clearKey(reason = '') {
    this.store.set('api.keyEnc', '');
    this.store.set('api.account', null);
    this.rejectQueued(new ApiError('nokey', 'No API key'));
    this.setBanner(reason);
    this.emit('key');
  }

  // ---- Status ----
  setBanner(msg) {
    if (msg === this.banner) return;
    this.banner = msg;
    this.emit('status');
  }

  status() {
    const now = Date.now();
    return {
      hasKey: this.hasKey(),
      account: this.store.get('api.account'),
      banner: this.banner,
      pausedUntil: this.pausedUntil > now ? this.pausedUntil : 0,
      usedLastMinute: this.log.filter(t => now - t < 60000).length,
      maxPerMinute: this.maxPerMinute(),
      budget: this.budget(),
      // null until the Mentat server reports; then calls elsewhere and everything together
      others: this.othersFresh() ? this.others.n : null,
      othersDetail: this.othersFresh() ? this.others.detail : null,
      total: this.othersFresh() ? this.others.n + this.log.filter(t => now - t < 60000).length : null,
      tornLimit: TORN_LIMIT,
      queued: this.queue.length,
    };
  }

  // Calls made with this player's key elsewhere in the last minute (other Mentat devices, the
  // Mentat server). This device then uses only what's left under ALL_MENTAT_MAX.
  setOthers(n, detail = null) {
    const v = Math.max(0, Math.round(Number(n) || 0));
    const changed = !this.othersFresh() || this.others.n !== v || JSON.stringify(this.others.detail) !== JSON.stringify(detail);
    this.others = { n: v, detail, at: Date.now() };
    if (changed) { this.emit('status'); this.pump(); }
  }

  othersFresh() {
    return !!this.others && Date.now() - this.others.at < OTHERS_FRESH_MS;
  }

  // Requests this device may make per minute right now.
  budget() {
    const own = this.maxPerMinute();
    if (!this.othersFresh()) return own;
    return Math.max(MIN_BUDGET, Math.min(own, ALL_MENTAT_MAX - this.others.n));
  }

  maxPerMinute() {
    const n = Number(this.store.get('api.maxPerMinute')) || 40;
    return Math.min(80, Math.max(10, n));
  }

  // ---- Requests ----
  // path: e.g. '/user/?selections=bars' or '/v2/faction/chain'
  // soft: error codes the caller handles itself (rejected with kind 'soft', no global effect)
  // priority: lower runs first
  // key: test a key that isn't saved yet
  request(path, { soft = [], priority = 5, key = '' } = {}) {
    if (!key && !this.hasKey()) return Promise.reject(new ApiError('nokey', 'No API key'));
    if (!key && Date.now() < this.pausedUntil) return Promise.reject(new ApiError('paused', 'Requests are paused'));
    return new Promise((resolve, reject) => {
      const job = { path, soft, priority, key, resolve, reject };
      const i = this.queue.findIndex(j => j.priority > priority);
      if (i < 0) this.queue.push(job);
      else this.queue.splice(i, 0, job);
      this.pump();
    });
  }

  pump() {
    if (this.timer || !this.queue.length) return;
    const now = Date.now();
    this.log = this.log.filter(t => now - t < 60000);
    let wait = this.lastAt + MIN_GAP_MS - now;
    const budget = this.budget();
    if (this.log.length >= budget) wait = Math.max(wait, 60000 - (now - this.log[this.log.length - budget]) + 50);
    if (wait > 0) {
      this.timer = setTimeout(() => { this.timer = null; this.pump(); }, wait);
      return;
    }
    const job = this.queue.shift();
    this.log.push(now);
    this.lastAt = now;
    this.run(job);
    this.emit('status');
    this.pump();
  }

  async run(job) {
    // These early exits happen synchronously right after pump() logged the slot, so the
    // slot is handed back: nothing was sent to Torn.
    if (!job.key && Date.now() < this.pausedUntil) { this.log.pop(); return job.reject(new ApiError('paused', 'Requests are paused')); }
    const key = job.key || this.getKey();
    if (!key) { this.log.pop(); return job.reject(new ApiError('nokey', 'No API key')); }
    const sep = job.path.includes('?') ? '&' : '?';
    const url = `${API_BASE}${job.path}${sep}key=${encodeURIComponent(key)}&comment=${API_COMMENT}`;

    let data;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS), headers: { Accept: 'application/json' } });
      data = await res.json();
    } catch (e) {
      const msg = e.name === 'TimeoutError' ? 'The Torn API timed out' : 'Could not reach api.torn.com';
      if (!job.key) this.backoff(30, `${msg}.`);
      return job.reject(new ApiError('network', msg));
    }

    if (data && data.error) {
      const { code, error } = data.error;
      if (job.soft.includes(code)) return job.reject(new ApiError('soft', error, code));
      if (code in KEY_ERRORS) {
        if (!job.key) this.clearKey(`API key removed: ${KEY_ERRORS[code]}. Enter a valid key in Settings to resume.`);
        return job.reject(new ApiError('key', KEY_ERRORS[code], code));
      }
      if (!job.key) this.backoff(BACKOFF_ERRORS[code] ?? 300, `Torn API error ${code} (${error}).`);
      return job.reject(new ApiError('backoff', `Torn API error ${code}: ${error}`, code));
    }

    if (!job.key && this.banner && Date.now() >= this.pausedUntil) this.setBanner('');
    job.resolve(data);
  }

  backoff(secs, msg) {
    this.pausedUntil = Date.now() + secs * 1000;
    this.rejectQueued(new ApiError('paused', 'Requests are paused'));
    this.banner = `${msg} Requests paused for ${fmtDur(secs)}.`;
    this.emit('status');
  }

  rejectQueued(err) {
    const queued = this.queue;
    this.queue = [];
    queued.forEach(j => j.reject(err));
  }
}

module.exports = { TornApi, ApiError, KEY_PATTERN };
