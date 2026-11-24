'use strict';
// FFScouter integration (https://ffscouter.com): fair-fight and battle stat estimates for
// your targets, and FFScouter's target finder.
//
// - Uses YOUR FFScouter key (a Torn API key you registered at ffscouter.com). It's stored
//   encrypted like the Torn key and only ever sent to ffscouter.com.
// - Requests go to ffscouter.com, never api.torn.com, so they don't use your Torn API budget.
// - Estimates change slowly: each target is refreshed every 6 hours by default, all of them
//   in one request (up to 205 players per request).
// - FFScouter asks tools to credit them, link their data policy where the key is entered,
//   and not share keys or resell data. See Settings > Integrations.

const path = require('path');
const { EventEmitter } = require('events');
const { safeStorage } = require('electron');
const { Store } = require('../store');

const DAY_S = 86400;
const INTEL_GAP = 1100; // FFScouter allows 60 player-activity requests a minute
const GROWTH_DAYS = 70;
const sleep = ms => new Promise(r => setTimeout(r, ms));

const BASE = 'https://ffscouter.com/api/v1';
const KEY_PATTERN = /^[A-Za-z0-9]{16}$/;
const BATCH = 205;
const KEY_ERRORS = { 2: 'Invalid key format', 6: 'Key not registered at ffscouter.com', 4010: 'Your account is banned from FFScouter', 4011: 'Your faction is banned from FFScouter' };

class FFScouterError extends Error {
  constructor(message, code, retryAfter) {
    super(message);
    this.code = code;
    this.retryAfter = retryAfter;
  }
}

async function call(path, params) {
  const qs = new URLSearchParams(params).toString();
  const res = await fetch(`${BASE}/${path}?${qs}`, { signal: AbortSignal.timeout(20000), headers: { Accept: 'application/json', 'User-Agent': 'Mentat' } });
  let data = null;
  try { data = await res.json(); } catch (e) { /* non-JSON error page */ }
  if (!res.ok || (data && data.error)) {
    throw new FFScouterError((data && data.error) || `FFScouter returned HTTP ${res.status}`, data && data.code, data && data.retry_after_seconds);
  }
  return data;
}

class FFScouterFeature extends EventEmitter {
  constructor({ store, getTargetIds, dataDir = null }) {
    super();
    this.store = store;
    this.getTargetIds = getTargetIds;
    // Activity history and estimated-stat growth for researched factions (Premium), kept
    // out of settings.json because it's bulky. Only on this PC: it uses your FFScouter key.
    this.intelDb = dataDir ? new Store(path.join(dataDir, 'ffscouter-intel.json'), { factions: {} }, { debounceMs: 5000 }) : null;
    this.intelJob = null;
    this.inFlight = false;
    this.pausedUntil = 0;
    this.error = '';
    this.soonAt = 0;
    this.finder = { results: [], params: null, fetchedAt: 0, error: '', loading: false };
  }

  // ---- Key ----
  getKey() {
    const enc = this.store.get('ffscouter.keyEnc');
    if (!enc) return '';
    try { return safeStorage.decryptString(Buffer.from(enc, 'base64')); } catch (e) { return ''; }
  }

  hasKey() {
    return !!this.store.get('ffscouter.keyEnc');
  }

  async saveKey(key, acknowledged) {
    key = String(key || '').trim();
    if (!acknowledged) throw new Error('Please confirm you have read FFScouter\'s current data policy.');
    if (!KEY_PATTERN.test(key)) throw new Error('An FFScouter key is your 16-character Torn API key registered at ffscouter.com.');
    const info = await call('check-key', { key });
    if (!info.is_registered) throw new Error('That key isn\'t registered with FFScouter yet. Sign up at ffscouter.com first.');
    let enc;
    try { enc = safeStorage.encryptString(key).toString('base64'); } catch (e) { throw new Error('Windows encryption is unavailable, so the key cannot be stored safely.'); }
    this.store.set('ffscouter.keyEnc', enc);
    this.store.set('ffscouter.account', { premium: !!info.is_premium, premiumUntil: (info.premium_expires_at || 0) * 1000, policyUpdate: !!info.policy_update_required, checkedAt: Date.now() });
    this.store.set('ffscouter.acknowledgedAt', Date.now());
    this.error = '';
    this.pausedUntil = 0;
    this.soonAt = Date.now();
    this.emit('state');
    return this.store.get('ffscouter.account');
  }

  removeKey(reason = '') {
    this.store.set('ffscouter.keyEnc', '');
    this.store.set('ffscouter.account', null);
    this.error = reason;
    this.emit('state');
  }

  handleError(e) {
    if (e.code in KEY_ERRORS) {
      this.removeKey(`FFScouter key removed: ${KEY_ERRORS[e.code]}.`);
      return;
    }
    const wait = e.code === 21 ? Math.max(15, e.retryAfter || 60) : 300;
    this.pausedUntil = Date.now() + wait * 1000;
    this.error = `${e.name === 'TimeoutError' ? 'FFScouter timed out' : e.message}. Retrying in ${Math.ceil(wait / 60)} min.`;
  }

  // ---- Estimates for targets ----
  stats() {
    return this.store.get('ffscouter.stats') || {};
  }

  // Ask for a refresh soon (e.g. after adding targets). Coalesces into one request.
  refreshSoon(all = false) {
    if (all) {
      const s = this.stats();
      for (const v of Object.values(s)) v.fetchedAt = 0;
      this.store.set('ffscouter.stats', s);
    }
    this.soonAt = Date.now() + 3000;
  }

  async fetchStats(ids) {
    this.inFlight = true;
    try {
      const key = this.getKey();
      const s = this.stats();
      for (let i = 0; i < ids.length; i += BATCH) {
        const chunk = ids.slice(i, i + BATCH);
        const data = await call('get-stats', { key, targets: chunk.join(',') });
        const now = Date.now();
        for (const p of data || []) {
          s[p.player_id] = {
            ff: p.fair_fight ?? null,
            bs: p.bs_estimate ?? null,
            bsHuman: p.bs_estimate_human || '',
            source: p.source || '',
            updated: (p.last_updated || 0) * 1000,
            distribution: p.distribution && p.distribution.distribution_human ? p.distribution.distribution_human : '',
            fetchedAt: now,
          };
        }
        for (const id of chunk) if (!s[id]) s[id] = { ff: null, bs: null, fetchedAt: now };
      }
      // Keep estimates only for current targets (and recent finder results).
      const keep = new Set([...this.getTargetIds().map(String), ...this.finder.results.map(r => String(r.id))]);
      for (const id of Object.keys(s)) if (!keep.has(id)) delete s[id];
      this.store.set('ffscouter.stats', s);
      this.error = '';
    } catch (e) {
      this.handleError(e);
    } finally {
      this.inFlight = false;
      this.emit('state');
    }
  }

  // Premium can start or lapse after the key was saved: ask FFScouter again every 6 hours (one
  // check-key call), so activity history isn't skipped on an old answer (the user's report,
  // 2026-11-24: the app still said "not Premium" a week after a check).
  async checkAccount() {
    this.accountBusy = true;
    try {
      const info = await call('check-key', { key: this.getKey() });
      const was = this.store.get('ffscouter.account') || {};
      this.store.set('ffscouter.account', { ...was, premium: !!info.is_premium, premiumUntil: (info.premium_expires_at || 0) * 1000, policyUpdate: !!info.policy_update_required, checkedAt: Date.now() });
      this.emit('account');
      this.emit('state');
    } catch (e) {
      if (e.code in KEY_ERRORS) this.handleError(e);
      // Otherwise try again at the next 6-hour mark
      const was = this.store.get('ffscouter.account') || {};
      this.store.set('ffscouter.account', { ...was, checkedAt: Date.now() });
    } finally {
      this.accountBusy = false;
    }
  }

  tick(now) {
    if (!this.hasKey() || this.inFlight || now < this.pausedUntil) return;
    // Every 6 hours with Premium; every hour without, so a renewal is picked up soon.
    const acct = this.store.get('ffscouter.account') || {};
    if (!this.accountBusy && now - (acct.checkedAt || 0) > (acct.premium ? 6 : 1) * 3600e3) { this.checkAccount(); return; }
    const every = Math.max(1, Number(this.store.get('ffscouter.intervalHours')) || 6) * 3600 * 1000;
    const s = this.stats();
    const due = this.getTargetIds().filter(id => !s[id] || now - (s[id].fetchedAt || 0) >= every);
    if (!due.length) return;
    // New targets: wait a few seconds so several adds share one request.
    if (this.soonAt && now < this.soonAt) return;
    this.soonAt = 0;
    this.fetchStats(due);
  }

  // ---- Target finder ----
  async findTargets(p) {
    if (!this.hasKey()) throw new Error('Add your FFScouter key in Settings first.');
    const params = { key: this.getKey(), limit: 50 };
    const int = (v, lo, hi) => { const n = Math.round(Number(v)); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : null; };
    if (p.preset === 'respect' || p.preset === 'level') params.preset = p.preset;
    else {
      const minlevel = int(p.minlevel, 1, 100), maxlevel = int(p.maxlevel, 1, 100);
      if (minlevel) params.minlevel = minlevel;
      if (maxlevel) params.maxlevel = maxlevel;
      const minff = Number(p.minff), maxff = Number(p.maxff);
      if (minff >= 1) params.minff = minff;
      if (maxff >= 1) params.maxff = maxff;
      params.inactiveonly = p.inactiveonly ? 1 : 0;
      params.factionless = p.factionless ? 1 : 0;
    }
    this.finder.loading = true;
    this.emit('state');
    try {
      const data = await call('get-targets', params);
      this.finder.results = (data.targets || []).map(t => ({
        id: t.player_id, name: t.name, level: t.level, ff: t.fair_fight ?? null, bs: t.bs_estimate ?? null,
        bsHuman: t.bs_estimate_human || '', lastAction: (t.last_action || 0) * 1000, source: t.source || '',
      }));
      this.finder.error = '';
    } catch (e) {
      this.finder.results = [];
      this.finder.error = e.code === 17 ? 'No targets matched those filters.' : e.message;
      if (e.code in KEY_ERRORS) this.handleError(e);
    } finally {
      this.finder.loading = false;
      this.finder.fetchedAt = Date.now();
      this.finder.params = { ...p };
      this.emit('state');
    }
  }

  // ---- Activity history + stat growth for a faction (Premium) ----
  intel(fid) {
    return (this.intelDb && this.intelDb.get('factions') || {})[fid] || null;
  }

  async loadIntel(fid, memberIds, force = false) {
    fid = Number(fid);
    if (!this.hasKey()) throw new Error('Add your FFScouter key in Settings first.');
    if (!this.intelDb) throw new Error('Not available here.');
    const acct = this.store.get('ffscouter.account') || {};
    if (!acct.premium) throw new Error('FFScouter activity history needs FFScouter Premium.');
    const have = this.intel(fid);
    if (!force && have && Date.now() - have.at < 12 * 3600e3) return have;
    if (this.intelJob && this.intelJob.running) return null;
    const ids = [...new Set((memberIds || []).map(Number).filter(Boolean))];
    const job = this.intelJob = { fid, running: true, done: 0, total: 1 + ids.length * 4, error: '', startedAt: Date.now() };
    this.emit('state');
    const key = this.getKey();
    const end = Math.floor(Date.now() / 1000 / 900) * 900;
    const ask = async (p, params) => {
      for (let tries = 0; ; tries++) {
        await sleep(INTEL_GAP);
        try { return await call(p, { key, ...params }); } catch (e) {
          if (e.code === 20 && tries < 3) { await sleep(Math.max(5, e.retryAfter || 15) * 1000); continue; }
          throw e;
        }
      }
    };
    // Longest window FFScouter has (5000 buckets of 15 min is ~52 days); shorter if tracking began later.
    const ranged = async (p, params) => {
      for (const days of [52, 28, 14, 7]) {
        try { return { days, data: await ask(p, { ...params, start: end - days * DAY_S, end, bucket: 900 }) }; } catch (e) { if (e.code !== 35) throw e; }
      }
      return { days: 0, data: { buckets: [] } };
    };
    const out = { at: Date.now(), days: 0, start: 0, end: end * 1000, faction: null, members: {}, growth: {} };
    try {
      const f = await ranged('activity/faction', { faction_id: fid });
      job.done++;
      const slots = Array.from({ length: 96 }, () => [0, 0]);
      const week = Array.from({ length: 168 }, () => [0, 0]);
      for (const b of f.data.buckets || []) {
        const v = Number(b.active_players ?? b.activity_score) || 0;
        const d = new Date(b.ts * 1000);
        const s = d.getUTCHours() * 4 + Math.floor(d.getUTCMinutes() / 15);
        slots[s][0] += v; slots[s][1]++;
        const h = d.getUTCDay() * 24 + d.getUTCHours();
        week[h][0] += v; week[h][1]++;
      }
      out.days = f.days;
      out.start = (end - f.days * DAY_S) * 1000;
      out.faction = { slots, week, memberCount: (f.data.meta && f.data.meta.member_count) || ids.length };
      for (const id of ids) {
        const p = await ranged('activity/player', { target: id });
        job.done++;
        const act = new Array(96).fill(0), obs = new Array(96).fill(0);
        const days = new Set();
        for (const b of p.data.buckets || []) {
          const d = new Date(b.ts * 1000);
          const s = d.getUTCHours() * 4 + Math.floor(d.getUTCMinutes() / 15);
          obs[s]++;
          if ((Number(b.activity_score) || 0) > 0) { act[s]++; days.add(d.toISOString().slice(0, 10)); }
        }
        out.members[id] = { act, obs, days: p.days, activeDays: days.size };
        // Estimated battle stats then and now: growth over 10 weeks and over the last 4.
        const g = {};
        const at = async (from, sort) => {
          const h = await ask('get-stats-history', { target: id, from, to: end, sort, limit: 1 });
          const x = (h.history || [])[0];
          return x && x.bs_estimate ? { t: x.timestamp * 1000, bs: x.bs_estimate } : null;
        };
        try {
          g.first = await at(end - GROWTH_DAYS * DAY_S, 'asc'); job.done++;
          g.mid = await at(end - 28 * DAY_S, 'asc'); job.done++;
          g.last = await at(end - GROWTH_DAYS * DAY_S, 'desc'); job.done++;
        } catch (e) { if (e.code in KEY_ERRORS || e.code === 19) throw e; job.done += 3; }
        out.growth[id] = g;
        if (job.done % 8 === 0) this.emit('state');
      }
      const all = this.intelDb.get('factions') || {};
      all[fid] = out;
      // Keep the 6 most recent factions.
      for (const k of Object.keys(all).sort((a, b) => all[b].at - all[a].at).slice(6)) delete all[k];
      this.intelDb.set('factions', all);
      return out;
    } catch (e) {
      job.error = e.code === 19 ? 'FFScouter Premium is needed for activity history.' : e.message;
      if (e.code === 19) this.store.set('ffscouter.account', { ...acct, premium: false });
      if (e.code in KEY_ERRORS) this.handleError(e);
      throw new Error(job.error);
    } finally {
      job.running = false;
      this.emit('state');
    }
  }

  snapshot() {
    return {
      intelJob: this.intelJob,
      intel: this.intelDb ? this.intelDb.get('factions') || {} : {},
      hasKey: this.hasKey(),
      account: this.store.get('ffscouter.account'),
      error: this.error,
      pausedUntil: this.pausedUntil > Date.now() ? this.pausedUntil : 0,
      stats: this.stats(),
      finder: this.finder,
    };
  }
}

module.exports = { FFScouterFeature };
