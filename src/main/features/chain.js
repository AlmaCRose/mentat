'use strict';
// Faction chain timer with audio + desktop alerts at 2:30, 1:30, 1:00 and 0:30.
// Ported from torn-chain-timer.user.js. Uses /v2/faction/chain, /v2/faction/chainreport
// and /v2/faction/members only.

const { EventEmitter } = require('events');

const POLL_ACTIVE_SEC = 10;
const POLL_IDLE_SEC = 60;
const NO_FACTION_SEC = 900;
const REPORT_ACTIVE_SEC = 30;
const REPORT_IDLE_SEC = 600;
const MEMBERS_SEC = 300;
const ALERT_WINDOW_SEC = 3;
const STALE_MS = 300000;

// More beeps, higher pitch, as the timer gets lower.
const ALERTS = [
  { sec: 150, count: 1, freq: 660, len: 0.35, gap: 0.15 },
  { sec: 90, count: 2, freq: 740, len: 0.25, gap: 0.12 },
  { sec: 60, count: 3, freq: 880, len: 0.2, gap: 0.1 },
  { sec: 30, count: 6, freq: 1050, len: 0.12, gap: 0.07 },
];

const fresh = now => `timestamp=${Math.floor(now / 1000)}`;
const isIdError = code => code === 6 || code === 7;
const isActive = (c, now) => !!c && !c.noFaction && c.current > 0 && !c.cooldown && c.expiresAt > now;
const fmt = sec => `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}`;

class ChainFeature extends EventEmitter {
  constructor({ api, store, notify, getMeId }) {
    super();
    this.api = api;
    this.store = store;
    this.notify = notify;
    this.getMeId = getMeId;
    this.inFlight = false;
    this.prevRem = null;
    this.last = { chain: 0, report: 0, members: 0 };
    this.state = { chain: null, report: null, members: null };
    api.on('key', () => this.reset());
  }

  reset() {
    this.state = { chain: null, report: null, members: null };
    this.last = { chain: 0, report: 0, members: 0 };
    this.prevRem = null;
    this.emit('state');
  }

  snapshot() {
    return this.state;
  }

  refresh() {
    this.last.chain = 0;
    this.last.report = 0;
  }

  tick(now) {
    if (!this.api.hasKey() || !this.store.get('chain.enabled')) return;
    this.checkAlerts(now);
    if (this.inFlight) return;
    const job = this.nextJob(now);
    if (!job) return;
    this.inFlight = true;
    job.call(this, now).finally(() => { this.inFlight = false; });
  }

  nextJob(now) {
    const c = this.state.chain;
    const chainEvery = c && c.noFaction ? NO_FACTION_SEC : isActive(c, now) ? POLL_ACTIVE_SEC : POLL_IDLE_SEC;
    if (now - this.last.chain >= chainEvery * 1000) return this.fetchChain;
    if (!c || c.noFaction) return null;
    const reportEvery = isActive(c, now) ? REPORT_ACTIVE_SEC : REPORT_IDLE_SEC;
    if (now - this.last.report >= reportEvery * 1000) return this.fetchReport;
    if (now - this.last.members >= MEMBERS_SEC * 1000) return this.fetchMembers;
    return null;
  }

  async fetchChain(now) {
    this.last.chain = now;
    try {
      // "timestamp" makes the API skip its cache, so a chain hit back to 5:00 shows at once.
      const data = await this.api.request(`/v2/faction/chain?${fresh(now)}`, { soft: [6, 7], priority: 1 });
      const c = data.chain;
      if (!c) return this.setChain({ noFaction: true, fetchedAt: Date.now() });
      // In API v2 "timeout" is seconds left, "cooldown" is the timestamp the cooldown ends.
      const cooldownUntil = (c.cooldown || 0) * 1000;
      this.setChain({
        id: c.id || 0,
        current: c.current || 0,
        max: c.max || 0,
        modifier: c.modifier || 1,
        cooldown: cooldownUntil > now,
        cooldownUntil,
        expiresAt: now + (c.timeout || 0) * 1000,
        fetchedAt: Date.now(),
      });
    } catch (e) {
      if (e.kind === 'soft' && isIdError(e.code)) this.setChain({ noFaction: true, fetchedAt: Date.now() });
    }
  }

  setChain(c) {
    this.state.chain = c;
    this.emit('state');
  }

  // Respect/hit stats for everyone who has hit the current chain. Top 10 and your own row.
  async fetchReport(now) {
    this.last.report = now;
    try {
      const data = await this.api.request(`/v2/faction/chainreport?${fresh(now)}`, { soft: [6, 7, 16], priority: 4 });
      const r = data.chainreport || {};
      const list = (r.attackers || []).map(a => ({
        id: a.id,
        total: (a.respect && a.respect.total) || 0,
        best: (a.respect && a.respect.best) || 0,
        avg: (a.respect && a.respect.average) || 0,
        attacks: (a.attacks && a.attacks.total) || 0,
      })).sort((a, b) => b.total - a.total);
      const meId = this.getMeId();
      const rank = list.findIndex(a => a.id === meId);
      this.state.report = { id: r.id || 0, top: list.slice(0, 10), mine: rank >= 0 ? list[rank] : null, rank: rank + 1, count: list.length, fetchedAt: Date.now() };
    } catch (e) {
      if (e.kind === 'soft') this.state.report = { none: true, fetchedAt: Date.now() };
    }
    this.emit('state');
  }

  // Names for the report (it only has IDs) and who's online right now.
  async fetchMembers(now) {
    this.last.members = now;
    try {
      const data = await this.api.request('/v2/faction/members', { soft: [6, 7, 16], priority: 6 });
      const names = {};
      const online = [];
      for (const m of data.members || []) {
        names[m.id] = m.name;
        const act = m.last_action || {};
        if (act.status !== 'Online' && act.status !== 'Idle') continue;
        const st = m.status || {};
        online.push({ id: m.id, name: m.name, action: act.status, relative: act.relative || '', state: st.state || '', description: st.description || '', until: (st.until || 0) * 1000 });
      }
      online.sort((a, b) => (a.action === b.action ? a.name.localeCompare(b.name) : a.action === 'Online' ? -1 : 1));
      this.state.members = { names, online, total: (data.members || []).length, fetchedAt: Date.now() };
    } catch (e) {
      if (e.kind === 'soft') this.state.members = { names: {}, online: [], total: 0, denied: true, fetchedAt: Date.now() };
    }
    this.emit('state');
  }

  checkAlerts(now) {
    const c = this.state.chain;
    const s = this.store.get('chain') || {};
    if (!isActive(c, now) || now - c.fetchedAt > STALE_MS || c.current < (s.minChain || 0)) {
      this.prevRem = null;
      return;
    }
    const rem = (c.expiresAt - now) / 1000;
    const prev = this.prevRem;
    this.prevRem = rem;
    if (prev === null || !s.alerts) return;
    for (const a of ALERTS) {
      if (!s[`t${a.sec}`]) continue;
      if (prev > a.sec && rem <= a.sec && rem > a.sec - ALERT_WINDOW_SEC) {
        this.emit('beep', { ...a, volume: s.volume });
        if (s.desktop) this.notify(`Chain timer ${fmt(a.sec)}`, `Chain at ${c.current} hits. Hit someone to keep it going.`, '', 'chain');
      }
    }
  }
}

module.exports = { ChainFeature, ALERTS };
