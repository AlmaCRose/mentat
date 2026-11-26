'use strict';
// Data source: this PC (default) or a Mentat sync server (server/server.js) that
// collects around the clock. With a server:
// - Oppo research and abroad stock come from the server; this PC stops collecting them
//   (and takes over again if the server can't be reached for 10 minutes).
// - War history and price history are combined with this PC's own.
// - Synced settings (targets, alerts, watched items, appearance...) go both ways.
// Requests go only to the server address you enter, with your access token (and Cloudflare
// Access service token, if you use one). All three are encrypted with Windows (DPAPI).

const zlib = require('zlib');
const { promisify } = require('util');
const { EventEmitter } = require('events');
const { safeStorage } = require('electron');
const { SYNC_UNITS, unitFor, DATASETS, PULL_ONLY, MERGE, joinUnit, applyUnit } = require('./syncmerge');

const gzip = promisify(zlib.gzip);
const STATUS_EVERY = 60e3;
const RETRY_AFTER_ERROR = 30e3;
const PUSH_DELAY = 2500;
const COVER_GRACE = 10 * 60e3; // server unreachable this long -> collect here again
const START_GRACE = 3 * 60e3;  // ...but not in the first minutes after launch
// How often each data set may be downloaded (when the server says it changed).
const PULL_EVERY = { research: 2 * 60e3, war: 60e3, travel: 2 * 60e3, prices: 30 * 60e3, bazaar: 30 * 60e3, scout: 5 * 60e3, mugger: 30 * 60e3 };
// After you pick a faction to research: check every 10 s (for up to 5 minutes) until its first data arrives.
const RESEARCH_WAIT = 5 * 60e3;
const RESEARCH_WAIT_POLL = 10e3;
// Commands that change synced settings (settings.set is handled by path).
const AFTER_COMMAND = {
  'targets.add': ['targets.list'], 'targets.addCurrent': ['targets.list'], 'targets.remove': ['targets.list'], 'targets.clear': ['targets.list'],
  'alerts.add': ['alerts.rules'], 'alerts.update': ['alerts.rules'], 'alerts.remove': ['alerts.rules'],
  'market.watch.add': ['market.watch'], 'market.watch.below': ['market.watch'], 'market.watch.remove': ['market.watch'],
  'war.watch': ['war.watchId'], 'war.pin': ['war.pinned'], 'research.watch': ['research.watchId'],
  'travel.learned.clear': ['travel.learned'],
  'casino.log.add': ['gamble.log'], 'casino.log.update': ['gamble.log'], 'casino.log.remove': ['gamble.log'], 'casino.log.clear': ['gamble.log'],
  'casino.session': ['gamble.session'],
  'planner.add': ['planner.items'], 'planner.update': ['planner.items'], 'planner.remove': ['planner.items'],
  'planner.copyDay': ['planner.items'], 'planner.clearDay': ['planner.items'],
};

const PRIVATE_HOST = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\]|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|[a-z0-9-]+\.local|[a-z0-9-]+)$/i;

function cleanUrl(u) {
  u = String(u || '').trim().replace(/\/+$/, '');
  if (!u) return '';
  let url;
  try { url = new URL(u); } catch (e) { throw new Error('That isn\'t a web address (example: https://example.com/torn-desktop).'); }
  if (url.protocol === 'http:' && !PRIVATE_HOST.test(url.hostname)) throw new Error('Use https:// for a server outside your home network (http:// would send your token unencrypted).');
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('The address must start with https://');
  if (url.username || url.password || url.search || url.hash) throw new Error('Enter just the server address, without a login, ? or #.');
  return url.href.replace(/\/+$/, '');
}

class SyncFeature extends EventEmitter {
  constructor({ store, research, travel, war, history, scout = null, onSettings, version, defaultServer = '', api = null }) {
    super();
    this.store = store;
    // Torn counts every call made with your key, from any device or the server, against one
    // limit. Each status check tells the server how many calls this device made in the last
    // minute; the server answers with the calls made elsewhere (api.setOthers).
    this.api = api;
    if (!this.store.get('sync.deviceId')) this.store.set('sync.deviceId', `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`);
    this.defaultServer = defaultServer; // the server this build signs in to unless another is entered
    this.signedOut = this.store.get('sync.signedOut') || ''; // why a member session ended
    this.me = this.store.get('sync.me') || null;
    this.research = research;
    this.scout = scout;
    this.travel = travel;
    this.war = war;
    this.history = history;
    this.onSettings = onSettings;
    this.version = version;
    this.startedAt = Date.now();
    this.inFlight = false;
    this.nextPoll = 0;
    this.server = null;   // last /status
    this.lastOkAt = 0;
    this.error = '';
    this.pulledRev = {};  // data set -> server rev applied here
    this.pulledAt = {};
    this.pullErrors = {}; // data set -> why its last pull failed (the others still pull)
    this.dirtyAt = 0;
    this.upload = null;   // { running, done, error, at }
    this.dirty = new Set(this.store.get('sync.dirty') || []);
  }

  mode() { return this.store.get('sync.mode') === 'server' ? 'server' : 'local'; }
  url() { return this.store.get('sync.url') || ''; }

  secret(name) {
    const enc = this.store.get(`sync.${name}Enc`);
    if (!enc) return '';
    try { return safeStorage.decryptString(Buffer.from(enc, 'base64')); } catch (e) { return ''; }
  }

  setSecret(name, value) {
    if (!value) { this.store.set(`sync.${name}Enc`, ''); return; }
    let enc;
    try { enc = safeStorage.encryptString(value).toString('base64'); } catch (e) { throw new Error('Windows encryption is unavailable, so the token cannot be stored safely.'); }
    this.store.set(`sync.${name}Enc`, enc);
  }

  configured() { return this.mode() === 'server' && !!this.url() && !!this.store.get('sync.tokenEnc'); }

  // 'token': the server owner's access token. 'session': a member signed in with their Torn key.
  kind() { return this.store.get('sync.kind') === 'session' ? 'session' : 'token'; }
  signedIn() { return this.configured() && !(this.kind() === 'session' && this.signedOut); }

  // ---- Signing in with your own Torn API key ----
  async health(url) {
    url = cleanUrl(url || this.url() || this.defaultServer);
    const res = await fetch(`${url}/api/v1/health`, { headers: { Accept: 'application/json', 'User-Agent': 'Mentat' }, redirect: 'manual', signal: AbortSignal.timeout(15e3) });
    if (!res.ok || !(res.headers.get('content-type') || '').includes('json')) throw new Error("That address isn't a Mentat server.");
    const j = await res.json();
    return { url, faction: j.faction || null, login: !!j.login };
  }

  async login({ url, key, device = '' } = {}) {
    url = cleanUrl(url || this.url() || this.defaultServer);
    if (!url) throw new Error('Enter the Mentat server address.');
    let res;
    try {
      res = await fetch(`${url}/api/v1/login`, {
        method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(30e3),
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': 'Mentat' },
        body: JSON.stringify({ key: String(key || ''), device }),
      });
    } catch (e) {
      throw new Error(e.name === 'TimeoutError' ? 'The Mentat server took too long to answer.' : `Can't reach the Mentat server (${(e.cause && e.cause.code) || e.message}).`);
    }
    if (res.status >= 300 && res.status < 400) throw new Error('That address sends sign-ins to a login page: it needs to be the public Mentat address.');
    let j = null;
    try { j = await res.json(); } catch (e) { /* not JSON */ }
    if (!j) throw new Error(`That address isn't a Mentat server (HTTP ${res.status}).`);
    if (!res.ok) throw Object.assign(new Error(j.error || `The server answered HTTP ${res.status}.`), { code: j.code });
    if (url !== this.url()) this.resetServer();
    this.store.set('sync.url', url);
    this.store.set('sync.mode', 'server');
    this.store.set('sync.kind', 'session');
    this.setSecret('token', j.session);
    this.setSecret('cfId', '');
    this.setSecret('cfSecret', '');
    this.setSignedOut('');
    this.me = j.me || null;
    this.store.set('sync.me', this.me);
    this.error = '';
    this.lastOkAt = 0;
    this.startedAt = Date.now();
    this.nextPoll = 0;
    this.emitState();
    this.poll().catch(() => {});
    return this.snapshot();
  }

  async logout() {
    if (this.kind() === 'session' && this.configured()) { try { await this.req('POST', 'logout', { body: {} }); } catch (e) { /* signed out here anyway */ } }
    this.setSecret('token', '');
    this.store.set('sync.kind', 'session');
    this.setSignedOut('You signed out.');
    this.me = null;
    this.store.set('sync.me', null);
    this.server = null;
    this.lastOkAt = 0;
    this.emitState();
    return this.snapshot();
  }

  setSignedOut(why) {
    this.signedOut = why || '';
    this.store.set('sync.signedOut', this.signedOut);
  }

  // True once this device has the server's copy of a data set (this session).
  hasPulled(name) { return !!this.pulledRev[name]; }

  // True once this device has checked the server's synced settings (this session): what other
  // devices did (e.g. already showed a once-only reminder) is known by then.
  settingsFresh() { return !!this.settingsAt; }

  // True while the server collects research and abroad stock instead of this PC.
  covering(now = Date.now()) {
    if (!this.configured()) return false;
    if (this.lastOkAt) return now - this.lastOkAt < COVER_GRACE;
    return now - this.startedAt < START_GRACE;
  }

  // From Settings. Secrets left blank keep the saved ones ("clear" removes them).
  async configure(c = {}) {
    const mode = c.mode === 'server' ? 'server' : 'local';
    if (mode === 'server') {
      const url = cleanUrl(c.url);
      if (!url) throw new Error('Enter the server address.');
      const token = String(c.token || '').trim();
      if (!token && !this.store.get('sync.tokenEnc')) throw new Error('Enter the access token from the server.');
      if (token && (token.length < 24 || token.length > 200 || /\s/.test(token))) throw new Error('That access token doesn\'t look right (it\'s a long string without spaces).');
      const cfId = String(c.cfId || '').trim();
      const cfSecret = String(c.cfSecret || '').trim();
      if (cfId.length > 200 || cfSecret.length > 200 || /\s/.test(cfId + cfSecret)) throw new Error('Those Cloudflare Access details don\'t look right.');
      if (url !== this.url()) this.resetServer();
      this.store.set('sync.url', url);
      if (token) { this.setSecret('token', token); this.store.set('sync.kind', 'token'); this.setSignedOut(''); }
      if (c.clearCf) { this.setSecret('cfId', ''); this.setSecret('cfSecret', ''); }
      if (cfId) this.setSecret('cfId', cfId);
      if (cfSecret) this.setSecret('cfSecret', cfSecret);
    }
    this.store.set('sync.mode', mode);
    this.error = '';
    this.lastOkAt = 0;
    this.startedAt = Date.now();
    this.nextPoll = 0;
    this.emitState();
    if (mode === 'server') await this.poll();
    return this.snapshot();
  }

  // Forget what came from the previous server (a new address is a different server).
  resetServer() {
    this.store.set('sync.serverId', '');
    this.store.set('sync.settingsRev', 0);
    this.pulledRev = {};
    this.pulledAt = {};
    this.server = null;
  }

  forget() {
    this.store.set('sync.mode', 'local');
    this.store.set('sync.url', '');
    for (const n of ['token', 'cfId', 'cfSecret']) this.setSecret(n, '');
    this.store.set('sync.kind', '');
    this.me = null;
    this.store.set('sync.me', null);
    this.store.set('sync.joinedId', '');
    this.resetServer();
    this.dirty.clear();
    this.store.set('sync.dirty', []);
    this.error = '';
    this.lastOkAt = 0;
    this.emitState();
  }

  // ---- Requests ----
  async req(method, p, { body = null, raw = false } = {}) {
    const headers = { Authorization: `Bearer ${this.secret('token')}`, Accept: 'application/json', 'Accept-Encoding': 'gzip', 'User-Agent': 'Mentat' };
    const cfId = this.secret('cfId'), cfSecret = this.secret('cfSecret');
    if (cfId && cfSecret) { headers['CF-Access-Client-Id'] = cfId; headers['CF-Access-Client-Secret'] = cfSecret; }
    if (p === 'status') {
      headers['X-Mentat-Device'] = this.store.get('sync.deviceId') || '';
      if (this.api) headers['X-Mentat-Used'] = String(this.api.status().usedLastMinute);
    }
    let payload;
    if (body !== null) {
      headers['Content-Type'] = 'application/json';
      payload = Buffer.from(JSON.stringify(body));
      if (payload.length > 32 * 1024) { payload = await gzip(payload); headers['Content-Encoding'] = 'gzip'; }
    }
    let res;
    for (let attempt = 0; ; attempt++) {
      try {
        res = await fetch(`${this.url()}/api/v1/${p}`, { method, headers, body: payload, redirect: 'manual', signal: AbortSignal.timeout(method === 'GET' ? 45e3 : 120e3) });
        break;
      } catch (e) {
        // A connection the server already closed: try a reading request once more.
        if (attempt === 0 && method === 'GET' && e.name !== 'TimeoutError') continue;
        throw new Error(e.name === 'TimeoutError' ? 'The server took too long to answer' : `Can't reach the server (${(e.cause && e.cause.code) || e.message})`);
      }
    }
    if (res.status >= 300 && res.status < 400) throw new Error('The server redirected to a login page: check the Cloudflare Access service token');
    if (res.status === 401) {
      if (this.kind() === 'session') {
        let why = '';
        try { why = (await res.json()).error || ''; } catch (e) { /* no reason given */ }
        this.setSignedOut(why || 'You were signed out.');
        this.emitState();
        throw new Error('Signed out');
      }
      throw new Error('The server rejected the access token');
    }
    if (res.status === 403) throw new Error('Access denied (403): check the Cloudflare Access service token');
    if (res.status === 429) throw new Error('Too many failed attempts: the server is refusing for a few minutes');
    if (!res.ok) throw new Error(`The server answered HTTP ${res.status}`);
    if (raw) return res;
    const type = res.headers.get('content-type') || '';
    if (!type.includes('json')) throw new Error('That address isn\'t a Mentat sync server (it answered with a web page)');
    return res.json();
  }

  // A request whose answer the caller reads whatever its status (the War board tab, which shows the
  // server's own messages: "not your entry", a 400 for a bad target, …). Never throws for HTTP
  // errors: { status, json }; status 0 = the server couldn't be reached.
  async call(method, p, body = null) {
    if (!this.signedIn()) return { status: 401, json: { error: "Sign in to your faction's Mentat server first: Settings → Data source." } };
    const headers = { Authorization: `Bearer ${this.secret('token')}`, Accept: 'application/json', 'User-Agent': 'Mentat' };
    const cfId = this.secret('cfId'), cfSecret = this.secret('cfSecret');
    if (cfId && cfSecret) { headers['CF-Access-Client-Id'] = cfId; headers['CF-Access-Client-Secret'] = cfSecret; }
    if (body !== null) headers['Content-Type'] = 'application/json';
    let res;
    try {
      res = await fetch(`${this.url()}/api/v1/${p}`, { method, headers, body: body !== null ? JSON.stringify(body) : undefined, redirect: 'manual', signal: AbortSignal.timeout(20e3) });
    } catch (e) {
      return { status: 0, json: { error: e.name === 'TimeoutError' ? 'The Mentat server took too long to answer.' : "Can't reach the Mentat server." } };
    }
    let json = null;
    try { json = await res.json(); } catch (e) { /* not JSON */ }
    if (res.status === 401 && this.kind() === 'session') {
      this.setSignedOut((json && json.error) || 'You were signed out.');
      this.emitState();
    }
    if (res.status >= 300 && res.status < 400) return { status: 403, json: { error: 'The server redirected to a login page: check the Cloudflare Access service token.' } };
    if (res.status === 404 && !(json && json.error)) return { status: 404, json: { error: 'Your Mentat server needs an update for the war board.' } };
    return { status: res.status, json };
  }

  // ---- Loop ----
  tick(now) {
    if (this.mode() !== 'server' || !this.signedIn() || this.inFlight) return;
    if (now >= this.nextPoll || (this.dirty.size && now - this.dirtyAt >= PUSH_DELAY && this.lastOkAt)) this.poll().catch(() => {});
  }

  async poll() {
    if (this.inFlight || !this.signedIn()) return this.snapshot();
    this.inFlight = true;
    const now = Date.now();
    try {
      const st = await this.req('GET', 'status');
      if (st.app !== 'torn-desktop-server') throw new Error('That address isn\'t a Mentat sync server');
      if (st.serverId !== this.store.get('sync.serverId')) {
        this.resetServer();
        this.store.set('sync.serverId', st.serverId);
      }
      const wasCovering = this.covering(now);
      this.server = st;
      // Calls made with this player's key elsewhere (older servers don't report them).
      if (this.api && st.usage) this.api.setOthers((st.usage.server || 0) + (st.usage.push || 0) + (st.usage.devices || 0), st.usage);
      this.lastOkAt = Date.now();
      this.error = '';
      await this.syncSettings(st);
      // First time on this server: add what this PC has collected to the server's copy
      // before taking anything from it, so nothing collected here is lost.
      if (st.me) { this.me = st.me; this.store.set('sync.me', st.me); }
      if (this.kind() === 'session' && this.store.get('sync.joinedId') !== st.serverId) this.store.set('sync.joinedId', st.serverId);
      if (this.store.get('sync.joinedId') !== st.serverId) {
        this.upload = { running: true, done: [], error: '', at: Date.now(), auto: true };
        this.emitState();
        await this.sendAll();
        this.upload.running = false;
        this.store.set('sync.joinedId', st.serverId);
        this.pulledRev = {};
      }
      for (const name of DATASETS) {
        if (!st.revs || !st.revs[name] || st.revs[name] === this.pulledRev[name]) continue;
        if (this.pulledRev[name] && now - (this.pulledAt[name] || 0) < PULL_EVERY[name] && !(name === 'research' && this.researchWaiting(now))) continue;
        if (!st.collect || st.collect[name] === false) continue;
        // One data set failing (a bad download, a merge error) must not stop the ones after it.
        try {
          await this.pull(name, st);
          delete this.pullErrors[name];
        } catch (e) {
          if (e.message === 'Signed out') throw e;
          this.pullErrors[name] = e.message || String(e);
          this.pulledAt[name] = Date.now(); // try again after the usual wait, not every poll
        }
      }
      if (!wasCovering) { this.research.emit('state'); this.travel.emit('state'); }
      this.nextPoll = Date.now() + (this.researchWaiting() ? RESEARCH_WAIT_POLL : STATUS_EVERY);
    } catch (e) {
      this.error = e.message;
      if (this.upload && this.upload.running) { this.upload.running = false; this.upload.error = e.message; }
      this.nextPoll = Date.now() + RETRY_AFTER_ERROR;
    } finally {
      this.inFlight = false;
      this.emitState();
    }
    return this.snapshot();
  }

  async pull(name, st) {
    const data = await this.req('GET', `data/${name}`);
    this.pulledRev[name] = st.revs[name];
    this.pulledAt[name] = Date.now();
    if (name === 'scout') { if (this.scout) this.scout.applyRemote(data); }
    else if (name === 'mugger') { if (this.muggerDb) this.muggerDb.applyRemote(data); }
    else if (name === 'research') this.research.applyRemote(data);
    else if (name === 'travel') this.travel.applyRemote(data, st.travel || {});
    else if (name === 'war') {
      this.war.db.data = MERGE.war(this.war.db.data, data);
      this.war.db.save();
      this.war.emit('state');
    } else if (name === 'prices') {
      this.history.store.data = MERGE.prices(this.history.store.data, data);
      this.history.store.save();
    } else if (name === 'bazaar') {
      this.history.baz.data = MERGE.bazaar(this.history.baz.data, data);
      this.history.baz.save();
    }
  }

  // ---- Settings ----
  markDirty(units) {
    if (this.mode() !== 'server') return;
    let added = false;
    for (const u of units) if (u && !this.dirty.has(u)) { this.dirty.add(u); added = true; }
    this.dirtyAt = Date.now();
    if (added) this.store.set('sync.dirty', [...this.dirty]);
  }

  afterCommand(name, args) {
    if (name === 'settings.set') { const u = unitFor(args[0]); if (u) this.markDirty([u]); }
    else if (AFTER_COMMAND[name]) this.markDirty(AFTER_COMMAND[name]);
    // A faction you just picked for research: check the server often until its first data is here.
    if (name === 'research.watch' && Number(args[0]) > 0) this.researchWaitUntil = Date.now() + RESEARCH_WAIT;
  }

  // A member's device (signed in to someone else's server) gets the owner's research picks, since only
  // those are collected. null on the owner's devices, before the first status check, or with no server.
  ownerResearchPicks() {
    if (this.mode() !== 'server' || this.kind() !== 'session' || !this.server) return null;
    const acct = this.server.account;
    if (!acct || !this.me || Number(this.me.id) === Number(acct.id)) return null; // the owner, signed in with their key
    return (this.server.research && this.server.research.tracked) || [];
  }

  // True while a faction you picked has no data on this device yet (for a few minutes after the pick).
  researchWaiting(now = Date.now()) {
    if (!(now < (this.researchWaitUntil || 0))) return false;
    const id = Number(this.store.get('research.watchId')) || 0;
    const rec = id && this.research.rec(id);
    return !!id && !(rec && rec.members && Object.keys(rec.members).length);
  }

  async syncSettings(st) {
    const since = Number(this.store.get('sync.settingsRev')) || 0;
    const first = !since;
    if (st.settingsRev !== since || first) {
      const got = await this.req('GET', `settings?since=${since}`);
      const units = got.units || {};
      if (first && !Object.keys(units).length) {
        // A new server: this PC's settings become the starting point.
        for (const u of SYNC_UNITS) this.dirty.add(u);
      } else {
        const changed = {};
        for (const [u, { v }] of Object.entries(units)) {
          if (!SYNC_UNITS.includes(u) || this.dirty.has(u)) continue;
          const local = this.store.get(u);
          const next = first ? joinUnit(u, local, v) : applyUnit(u, local, v);
          if (first && JSON.stringify(next) !== JSON.stringify(v)) this.dirty.add(u); // this PC added something
          if (JSON.stringify(next) !== JSON.stringify(local)) changed[u] = next;
        }
        // Settings from before the first-run setup existed: this person already uses Mentat
        // elsewhere, so the setup isn't offered on this device either.
        if (first && !('ui.setupDone' in units) && !this.store.get('ui.setupDone')) {
          changed['ui.setupDone'] = true;
          this.dirty.add('ui.setupDone');
        }
        if (Object.keys(changed).length) this.onSettings(changed);
      }
      this.store.set('sync.settingsRev', Number(got.rev) || 0);
    }
    this.settingsAt = Date.now(); // this device has the server's settings (this session)
    if (this.dirty.size) {
      const send = [...this.dirty];
      const units = Object.fromEntries(send.map(u => [u, this.store.get(u) ?? null]));
      await this.req('PUT', 'settings', { body: { units } });
      for (const u of send) this.dirty.delete(u);
      this.store.set('sync.dirty', [...this.dirty]);
    }
  }

  // ---- Send this PC's collected data to the server (to start it off) ----
  async sendAll() {
    const sets = {
      research: () => this.research.db.data, war: () => this.war.db.data, travel: () => this.travel.history.data,
      prices: () => this.history.store.data, bazaar: () => this.history.baz.data,
    };
    for (const name of DATASETS) {
      if (PULL_ONLY.has(name)) continue;
      await this.req('POST', `data/${name}`, { body: sets[name]() });
      this.upload.done.push(name);
      this.emitState();
    }
  }

  async uploadAll() {
    if (!this.configured()) throw new Error('Connect to a server first.');
    if (this.kind() === 'session') throw new Error("Only the server's owner can send data to it.");
    if (this.inFlight || (this.upload && this.upload.running)) return this.snapshot();
    this.inFlight = true;
    this.upload = { running: true, done: [], error: '', at: Date.now() };
    this.emitState();
    try {
      await this.sendAll();
      this.pulledRev = {};
      this.pulledAt = {};
      this.nextPoll = 0;
    } catch (e) {
      this.upload.error = e.message;
    } finally {
      this.upload.running = false;
      this.inFlight = false;
      this.emitState();
    }
    return this.snapshot();
  }

  flush() {
    this.store.set('sync.dirty', [...this.dirty]);
  }

  emitState() {
    this.emit('state');
  }

  snapshot() {
    const s = this.server;
    return {
      mode: this.mode(),
      url: this.url(),
      kind: this.kind(),
      signedIn: this.signedIn(),
      signedOut: this.signedOut,
      me: this.me,
      defaultServer: this.defaultServer,
      hasToken: !!this.store.get('sync.tokenEnc'),
      hasCf: !!this.store.get('sync.cfIdEnc') && !!this.store.get('sync.cfSecretEnc'),
      connected: !!this.lastOkAt && !this.error,
      covering: this.covering(),
      lastOkAt: this.lastOkAt,
      error: this.error,
      busy: this.inFlight,
      pending: this.dirty.size,
      pulled: Object.fromEntries(DATASETS.map(n => [n, { at: this.pulledAt[n] || 0, ok: !!this.pulledRev[n], error: this.pullErrors[n] || '' }])),
      upload: this.upload,
      server: s ? {
        version: s.version, account: s.account, keyOk: s.keyOk, banner: s.api && s.api.banner, maxPerMinute: s.api && s.api.maxPerMinute,
        startedAt: s.startedAt, collect: s.collect, war: s.war, research: s.research, travel: s.travel, bazaar: s.bazaar, prices: s.prices, cloudBackup: s.cloudBackup || null, scout: s.scout || null,
      } : null,
    };
  }
}

module.exports = { SyncFeature, cleanUrl };
