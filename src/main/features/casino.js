'use strict';
// The Casino tab's live data: your casino tokens and today's casino streak, Torn's poker tables,
// bookmaker odds (from the Mentat server), and your betting log (gamble.log, synced to your other
// devices). Advice only: nothing here plays or bets for you.
//
// Auto-tracking (optional, beta): with a Full access key saved for it, your Torn log's casino and
// bookie entries are copied into the betting log every 15 minutes. That key stays on this device
// (encrypted), apart from your main key, and is only used for /v2/user/log.

const { EventEmitter } = require('events');
let safeStorage = null;
try { ({ safeStorage } = require('electron')); } catch (e) { /* plain Node */ }
const { KEY_PATTERN } = require('../api');

const CASINO_EVERY = 120e3;
const TABLES_EVERY = 60e3;
const AUTO_EVERY = 15 * 60e3;
const MAX_LOG = 3000;
const GAMES = ['blackjack', 'poker', 'highlow', 'roulette', 'slots', 'keno', 'craps', 'wheel', 'lottery', 'russian', 'bookie', 'other'];
const LOG_CAT = /casino|gambl|bookie|lottery|poker|blackjack|roulette|slots|keno|craps|high.?low|wheel/i;

const money = v => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : null);
const clip = (s, n) => String(s == null ? '' : s).slice(0, n);

// A log entry's game, from its title ("Blackjack win", "Bookie bet placed"...).
function gameOf(title) {
  const t = String(title).toLowerCase();
  if (/blackjack/.test(t)) return 'blackjack';
  if (/poker|hold.?em/.test(t)) return 'poker';
  if (/high.?low/.test(t)) return 'highlow';
  if (/russian/.test(t)) return 'russian';
  if (/roulette/.test(t)) return 'roulette';
  if (/slot/.test(t)) return 'slots';
  if (/keno/.test(t)) return 'keno';
  if (/craps/.test(t)) return 'craps';
  if (/wheel|spin/.test(t)) return 'wheel';
  if (/lotter|ticket/.test(t)) return 'lottery';
  if (/bookie|bet/.test(t)) return 'bookie';
  return 'other';
}
// Money in and out of one log entry. The data fields aren't documented, so this reads the
// common names and leaves `net` empty when it can't tell (you can fill it in by hand).
function moneyOf(entry) {
  const d = entry.data && typeof entry.data === 'object' ? entry.data : {};
  let stake = null, back = null, lost = null;
  for (const [k, v] of Object.entries(d)) {
    if (typeof v !== 'number') continue;
    const key = k.toLowerCase();
    if (/^(bet|bet_amount|stake|amount_bet|wager|cost|price|bet_value)$/.test(key)) stake = (stake || 0) + v;
    else if (/^(won|winnings|win|payout|prize|amount_won|returned|return|money_gained|reward)$/.test(key)) back = (back || 0) + v;
    else if (/^(lost|loss|amount_lost|money_lost)$/.test(key)) lost = (lost || 0) + v;
  }
  const title = String(entry.details && entry.details.title || '').toLowerCase();
  let net = null;
  if (lost != null) { net = -lost; if (stake == null) stake = lost; } else if (stake != null && back != null) net = back - stake;
  else if (stake != null && /lose|lost|loss/.test(title)) net = -stake;
  else if (stake != null && /place|bought|buy|start/.test(title)) net = null; // the result comes in a later entry
  else if (back != null && /win|won/.test(title)) net = back;
  return { stake: money(stake), net: money(net) };
}

class CasinoFeature extends EventEmitter {
  constructor({ api, store, viewing = () => false, server = null }) {
    super();
    this.api = api;
    this.store = store;
    this.viewing = viewing;
    this.server = server; // (method, path) -> the Mentat server's answer (sync.req)
    this.casinoAt = 0;
    this.tablesAt = 0;
    this.autoAt = 0;
    this.busy = new Set();
    this.state = { casino: null, casinoAt: 0, casinoError: '', tables: null, tablesAt: 0, tablesError: '', auto: { lastAt: 0, error: '', imported: 0, cats: [] } };
    api.on('key', () => { this.state.casino = null; this.casinoAt = 0; this.emit('state'); });
  }

  snapshot() {
    return { ...this.state, hasLogKey: !!this.store.get('casino.logKeyEnc'), autoOn: !!this.store.get('casino.auto'), log: this.store.get('gamble.log') || {}, session: this.store.get('gamble.session') || null };
  }

  tick(now) {
    if (this.api.hasKey() && this.viewing('casino')) {
      if (now - this.casinoAt > CASINO_EVERY) this.refreshCasino(now);
      if (now - this.tablesAt > TABLES_EVERY) this.refreshTables(now);
    }
    if (this.store.get('casino.auto') && this.store.get('casino.logKeyEnc') && now - this.autoAt > AUTO_EVERY) this.importLog(now);
  }

  async once(name, fn) {
    if (this.busy.has(name)) return;
    this.busy.add(name);
    try { await fn(); } finally { this.busy.delete(name); this.emit('state'); }
  }

  refreshCasino(now = Date.now()) {
    this.casinoAt = now;
    return this.once('casino', async () => {
      try {
        const d = await this.api.request('/v2/user/casino', { soft: [16], priority: 6 });
        this.state.casino = d && d.casino ? { tokens: Number(d.casino.tokens) || 0, streak: Number(d.casino.streak) || 0 } : null;
        this.state.casinoAt = Date.now();
        this.state.casinoError = '';
      } catch (e) {
        this.state.casinoError = e.kind === 'soft' ? 'Your key can\'t read casino data (needs Limited access).' : e.message;
      }
    });
  }

  refreshTables(now = Date.now()) {
    this.tablesAt = now;
    return this.once('tables', async () => {
      try {
        const d = await this.api.request('/v2/torn/pokertables', { priority: 7 });
        this.state.tables = (d.pokertables || []).map(t => ({ id: t.id, name: clip(t.name, 60), big: t.blinds ? t.blinds.big : 0, small: t.blinds ? t.blinds.small : 0, players: t.players ? t.players.current : 0, max: t.players ? t.players.maximum : 0, speed: t.speed }));
        this.state.tablesAt = Date.now();
        this.state.tablesError = '';
      } catch (e) { this.state.tablesError = e.message; }
    });
  }

  // ---- Bookmaker odds (Mentat server) ----
  async oddsSports() {
    if (!this.server) throw new Error('Sign in to Mentat to load live odds.');
    return this.server('GET', 'odds/sports');
  }
  async oddsTop() {
    if (!this.server) throw new Error('Sign in to Mentat to load live odds.');
    return this.server('GET', 'odds/top');
  }
  async oddsEvents(sport) {
    if (!this.server) throw new Error('Sign in to Mentat to load live odds.');
    return this.server('GET', `odds/events?sport=${encodeURIComponent(String(sport || ''))}`);
  }

  // ---- Betting log ----
  cleanEntry(e, id) {
    const n = v => (v === null || v === '' || v === undefined ? null : Number.isFinite(Number(v)) ? Math.round(Number(v)) : null);
    const out = {
      id, at: Number(e.at) > 0 ? Math.min(Number(e.at), Date.now() + 86400e3) : Date.now(),
      game: GAMES.includes(e.game) ? e.game : 'other',
      stake: n(e.stake), net: n(e.net), note: clip(e.note, 200), src: e.src === 'auto' ? 'auto' : 'manual',
    };
    if (e.odds !== undefined && e.odds !== null && e.odds !== '') { const o = Number(e.odds); if (o > 1 && o < 1000) out.odds = Math.round(o * 1000) / 1000; }
    if (e.title) out.title = clip(e.title, 120);
    if (e.open) out.open = true; // a bookie bet still waiting for its result
    return out;
  }
  saveLog(log) {
    const ids = Object.keys(log);
    if (ids.length > MAX_LOG) {
      ids.sort((a, b) => log[a].at - log[b].at);
      for (const id of ids.slice(0, ids.length - MAX_LOG)) delete log[id];
    }
    this.store.set('gamble.log', log);
    this.emit('state');
  }
  addLog(e) {
    if (!e || typeof e !== 'object') throw new Error('Nothing to add');
    const log = { ...(this.store.get('gamble.log') || {}) };
    const id = `m${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    log[id] = this.cleanEntry({ ...e, src: 'manual' }, id);
    this.saveLog(log);
    return log[id];
  }
  updateLog(id, patch) {
    const log = { ...(this.store.get('gamble.log') || {}) };
    if (!log[id]) throw new Error('That entry is gone');
    const next = { ...log[id], ...patch };
    if (patch && patch.open === false) delete next.open;
    log[id] = this.cleanEntry(next, id);
    this.saveLog(log);
    return log[id];
  }
  removeLog(id) {
    const log = { ...(this.store.get('gamble.log') || {}) };
    delete log[id];
    this.saveLog(log);
  }
  clearLog(which) {
    const log = { ...(this.store.get('gamble.log') || {}) };
    for (const [id, e] of Object.entries(log)) if (which === 'all' || e.src === which) delete log[id];
    this.saveLog(log);
  }
  setSession(s) {
    if (s === null) { this.store.set('gamble.session', null); this.emit('state'); return null; }
    const n = v => (Number.isFinite(Number(v)) && Number(v) >= 0 ? Math.round(Number(v)) : 0);
    const clean = { start: n(s.start), now: n(s.now !== undefined ? s.now : s.start), stopLoss: n(s.stopLoss), target: n(s.target), startedAt: Number(s.startedAt) > 0 ? Number(s.startedAt) : Date.now(), game: GAMES.includes(s.game) ? s.game : 'other' };
    this.store.set('gamble.session', clean);
    this.emit('state');
    return clean;
  }

  // ---- Auto-tracking from your Torn log (Full access key) ----
  getLogKey() {
    const enc = this.store.get('casino.logKeyEnc');
    if (!enc) return '';
    try { return safeStorage.decryptString(Buffer.from(enc, 'base64')); } catch (e) { return ''; }
  }
  async saveLogKey(key) {
    key = String(key || '').trim();
    if (!KEY_PATTERN.test(key)) throw new Error('A Torn API key is 16 letters and numbers.');
    // Check it can read the log (only Full access keys can).
    try { await this.api.request('/v2/user/log?limit=1', { key, priority: 0, soft: [16] }); } catch (e) {
      if (e.kind === 'soft' || e.code === 16) throw new Error('That key can\'t read your log: auto-tracking needs a Full access key.');
      throw e;
    }
    let enc;
    try { enc = safeStorage.encryptString(key).toString('base64'); } catch (e) { throw new Error('Encryption is unavailable, so the key cannot be stored safely.'); }
    this.store.set('casino.logKeyEnc', enc);
    this.store.set('casino.auto', true);
    if (!this.store.get('casino.autoFrom')) this.store.set('casino.autoFrom', Math.floor(Date.now() / 1000) - 7 * 86400); // start with the last week
    this.autoAt = 0;
    this.state.auto.error = '';
    this.emit('state');
    return true;
  }
  removeLogKey() {
    this.store.set('casino.logKeyEnc', '');
    this.store.set('casino.auto', false);
    this.state.auto = { lastAt: 0, error: '', imported: 0, cats: [] };
    this.emit('state');
  }

  importLog(now = Date.now()) {
    this.autoAt = now;
    return this.once('auto', async () => {
      const key = this.getLogKey();
      if (!key) return;
      const st = this.state.auto;
      try {
        if (!st.cats.length) {
          const c = await this.api.request('/v2/torn/logcategories', { key, priority: 8 });
          st.cats = (c.logcategories || []).filter(x => LOG_CAT.test(x.title)).map(x => ({ id: x.id, title: clip(x.title, 60) }));
          if (!st.cats.length) throw new Error('Torn\'s log has no casino or bookie category to read.');
        }
        const from = Number(this.store.get('casino.autoFrom')) || Math.floor(now / 1000) - 7 * 86400;
        const log = { ...(this.store.get('gamble.log') || {}) };
        let added = 0, newest = from;
        for (const cat of st.cats) {
          // Newest first, 100 at a time: page back (to = the oldest second seen) until caught up.
          // Bounds are inclusive, so a second's entries can come twice; the id skips them.
          let to = 0;
          for (let page = 0; page < 10; page++) {
            const d = await this.api.request(`/v2/user/log?cat=${cat.id}&from=${from}&limit=100${to ? `&to=${to}` : ''}`, { key, priority: 8, soft: [16] });
            const list = d.log || [];
            for (const e of list) {
              const id = `log${e.id}`;
              newest = Math.max(newest, Number(e.timestamp) || 0);
              if (log[id]) continue;
              const title = e.details ? e.details.title : '';
              const m = moneyOf(e);
              log[id] = this.cleanEntry({ at: (Number(e.timestamp) || 0) * 1000, game: gameOf(`${title} ${cat.title}`), stake: m.stake, net: m.net, title, src: 'auto' }, id);
              added++;
            }
            if (list.length < 100) break;
            const oldest = Math.min(...list.map(e => Number(e.timestamp) || 0));
            if (!oldest || oldest <= from || (to && oldest >= to)) break;
            to = oldest;
          }
        }
        if (added) this.saveLog(log);
        this.store.set('casino.autoFrom', newest); // inclusive: entries later in the same second still come
        st.lastAt = Date.now();
        st.imported += added;
        st.error = '';
        if (added) this.emit('imported', added);
      } catch (e) {
        st.error = e.kind === 'soft' || e.code === 16 ? 'The saved key can\'t read your log any more (it needs Full access).' : e.message;
        if (e.kind === 'key') this.removeLogKey();
      }
    });
  }
}

module.exports = { CasinoFeature, gameOf, moneyOf, GAMES };
