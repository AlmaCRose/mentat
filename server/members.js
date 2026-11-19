'use strict';
// Who may use this server, and their sessions.
//
// A member signs in with their own Torn API key. The server asks Torn who the key belongs to
// and which faction they're in, then forgets the key: it is never stored or logged here. In
// return the member gets a session token; the server keeps only its SHA-256 hash.
//
// Let in: members of the server's faction (config access.factionId, by default the faction of
// the server's own key), players on the allow-list, and admins (config access.adminIds, by
// default the server key's own player). Every 30 minutes the faction's member list is checked
// with the server's key (one request); anyone who has left and isn't allowed some other way is
// signed out everywhere. Nothing is removed if that check fails.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const KEY_PATTERN = /^[A-Za-z0-9]{16}$/;
const ROSTER_EVERY = 30 * 60e3;
const SESSION_DAYS = 90;
const MAX_SESSIONS_PER_MEMBER = 12;
const ACCESS_LEVELS = { 1: 'Public', 2: 'Minimal', 3: 'Limited', 4: 'Full' };

const sha = s => crypto.createHash('sha256').update(String(s)).digest('hex');

// One Torn API call with someone else's key, straight to Torn (not the server's own queue, so a
// bad member key can never pause or remove the server's key).
async function tornWithKey(key, pathAndQuery) {
  const sep = pathAndQuery.includes('?') ? '&' : '?';
  const res = await fetch(`https://api.torn.com${pathAndQuery}${sep}key=${encodeURIComponent(key)}&comment=Mentat`, {
    signal: AbortSignal.timeout(15000), headers: { Accept: 'application/json', 'User-Agent': 'Mentat' },
  });
  const d = await res.json();
  if (d && d.error) throw Object.assign(new Error(d.error.error || 'Torn API error'), { tornCode: d.error.code });
  return d;
}

class Members {
  // torn: (key, path) -> data, for member keys (tests pass a fake).
  // serverApi: the server's own TornApi, for the faction roster and allow-list names.
  constructor({ dataDir, cfg, serverApi, log, torn = tornWithKey }) {
    this.file = path.join(dataDir, 'members.json');
    this.cfg = cfg.access || {};
    this.api = serverApi;
    this.log = log;
    this.torn = torn;
    this.owner = null; // { id, name, factionId, factionName } of the server's key
    this.data = { members: {}, sessions: {}, allow: {}, roster: { at: 0, ids: [] }, removed: {} };
    try { this.data = { ...this.data, ...JSON.parse(fs.readFileSync(this.file, 'utf8')) }; } catch (e) { /* first run */ }
    this.attempts = new Map(); // ip -> [times]
    this.allAttempts = [];
    this.rosterInFlight = false;
    this.dirty = false;
  }

  // ---- Settings and roles ----
  factionId() { return Number(this.cfg.factionId) || (this.owner && this.owner.factionId) || 0; }
  factionName() { return (this.owner && Number(this.owner.factionId) === this.factionId() && this.owner.factionName) || ''; }
  adminIds() {
    const ids = (Array.isArray(this.cfg.adminIds) ? this.cfg.adminIds : []).map(Number).filter(Boolean);
    if (this.owner && this.owner.id) ids.push(this.owner.id);
    return new Set(ids);
  }
  isAdmin(pid) { return this.adminIds().has(Number(pid)); }
  isAllowed(pid) { return !!this.data.allow[pid]; }
  role(pid) { return this.isAdmin(pid) ? 'admin' : this.isAllowed(pid) ? 'allowed' : 'member'; }

  setOwner(o) { this.owner = o; }

  save() {
    this.dirty = false;
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }
  flush() { if (this.dirty) this.save(); }
  touch() { this.dirty = true; clearTimeout(this.saveTimer); this.saveTimer = setTimeout(() => this.flush(), 5000); this.saveTimer.unref?.(); }

  // ---- Sign-in ----
  // Too many tries from one address (10 per 10 min) or overall (60 per 10 min) wait a while.
  limited(ip) {
    const now = Date.now();
    const cut = t => t.filter(x => now - x < 10 * 60e3);
    const mine = cut(this.attempts.get(ip) || []);
    this.allAttempts = cut(this.allAttempts);
    if (mine.length >= 10 || this.allAttempts.length >= 60) return true;
    mine.push(now);
    this.allAttempts.push(now);
    this.attempts.set(ip, mine);
    if (this.attempts.size > 5000) this.attempts.clear();
    return false;
  }

  // -> { session, me } or throws { status, code, message }.
  async login(key, { ip = '', device = '' } = {}) {
    const fail = (status, code, message) => Object.assign(new Error(message), { status, code });
    if (this.limited(ip)) throw fail(429, 'too_many', 'Too many sign-in attempts. Wait a few minutes and try again.');
    key = String(key || '').replace(/[^A-Za-z0-9]/g, '');
    if (!KEY_PATTERN.test(key)) throw fail(400, 'bad_key', 'A Torn API key is 16 letters and numbers.');
    if (!this.factionId()) throw fail(503, 'not_ready', 'The server is still starting up. Try again in a minute.');
    let profile;
    try {
      profile = await this.torn(key, '/user/?selections=profile');
    } catch (e) {
      if (e.tornCode === undefined) throw fail(502, 'torn_down', "Couldn't reach Torn to check the key. Try again shortly.");
      throw fail(400, 'torn_error', `Torn says: ${e.message}.`);
    }
    let level = 0;
    try { const info = await this.torn(key, '/key/?selections=info'); level = Number(info.access_level) || 0; } catch (e) { /* older keys: unknown level */ }
    const pid = Number(profile.player_id);
    const f = profile.faction || {};
    const fid = Number(f.faction_id) || 0;
    const ok = fid === this.factionId() || this.isAllowed(pid) || this.isAdmin(pid);
    if (!pid) throw fail(400, 'torn_error', "Torn didn't say whose key this is.");
    if (!ok) {
      this.log(`Sign-in refused: ${profile.name} [${pid}] is not in the faction${fid ? ` (in ${f.faction_name} [${fid}])` : ''}.`);
      throw fail(403, 'not_member', `Mentat on this server is for members of ${this.factionName() || 'its faction'}. If you should have access, ask an officer to add you.`);
    }
    const now = Date.now();
    const m = this.data.members[pid] || { firstSeen: now };
    Object.assign(m, { name: profile.name, level: profile.level, factionId: fid, factionName: f.faction_name || '', position: f.position || '', keyLevel: level, lastLogin: now, lastSeen: now });
    this.data.members[pid] = m;
    delete this.data.removed[pid];
    // A new session; the oldest go once someone has too many devices.
    const session = crypto.randomBytes(32).toString('base64url');
    this.data.sessions[sha(session)] = { pid, created: now, lastSeen: now, device: String(device || '').slice(0, 80) };
    const mine = Object.entries(this.data.sessions).filter(([, s]) => s.pid === pid).sort((a, b) => a[1].lastSeen - b[1].lastSeen);
    while (mine.length > MAX_SESSIONS_PER_MEMBER) delete this.data.sessions[mine.shift()[0]];
    this.save();
    this.log(`Signed in: ${profile.name} [${pid}] (${this.role(pid)}${device ? `, ${String(device).slice(0, 40)}` : ''}).`);
    return { session, me: this.me(pid) };
  }

  me(pid) {
    const m = this.data.members[pid] || {};
    return {
      id: Number(pid), name: m.name || '', factionId: m.factionId || 0, factionName: m.factionName || '', role: this.role(pid),
      keyLevel: m.keyLevel || 0, keyLevelName: ACCESS_LEVELS[m.keyLevel] || 'unknown',
      faction: { id: this.factionId(), name: this.factionName() },
    };
  }

  // The member a session token belongs to, or null. Sessions last 90 days from last use.
  check(token) {
    if (!token) return null;
    const h = sha(token);
    const s = this.data.sessions[h];
    if (!s) return null;
    const now = Date.now();
    if (now - s.lastSeen > SESSION_DAYS * 86400e3) { delete this.data.sessions[h]; this.touch(); return null; }
    if (now - s.lastSeen > 60e3) {
      s.lastSeen = now;
      const m = this.data.members[s.pid];
      if (m) m.lastSeen = now;
      this.touch();
    }
    return { pid: s.pid, hash: h };
  }

  logout(token) {
    const h = sha(token);
    if (this.data.sessions[h]) { delete this.data.sessions[h]; this.save(); }
  }

  revoke(pid, why) {
    let n = 0;
    for (const [h, s] of Object.entries(this.data.sessions)) if (s.pid === Number(pid)) { delete this.data.sessions[h]; n++; }
    if (this.onRevoke) this.onRevoke(Number(pid), why); // e.g. phone alerts: their stored key goes too
    if (n) this.log(`Signed out ${(this.data.members[pid] || {}).name || pid} [${pid}] on ${n} device${n === 1 ? '' : 's'}: ${why}.`);
    return n;
  }

  // ---- Faction roster: who's still in ----
  async tick(now = Date.now()) {
    if (this.rosterInFlight || now - this.data.roster.at < ROSTER_EVERY || !this.factionId() || !this.api) return;
    if (this.owner && Number(this.owner.factionId) !== this.factionId()) return; // the server's key can't see that faction's members
    this.rosterInFlight = true;
    try {
      const d = await this.api.request('/v2/faction/members?striptags=true', { priority: 2 });
      const ids = (d.members || []).map(x => Number(x.id)).filter(Boolean);
      if (!ids.length) return;
      this.data.roster = { at: now, ids };
      const inFaction = new Set(ids);
      let changed = false;
      for (const pid of new Set(Object.values(this.data.sessions).map(s => s.pid))) {
        if (inFaction.has(pid) || this.isAllowed(pid) || this.isAdmin(pid)) continue;
        if (this.revoke(pid, 'no longer in the faction')) { this.data.removed[pid] = now; changed = true; }
      }
      for (const pid of ids) { const m = this.data.members[pid]; if (m && m.factionId !== this.factionId()) { m.factionId = this.factionId(); changed = true; } }
      if (changed) this.save(); else this.touch();
    } catch (e) {
      this.log("Couldn't check the faction's members (nobody signed out):", e.message);
      this.data.roster.at = now - ROSTER_EVERY + 5 * 60e3; // try again in 5 minutes
    } finally {
      this.rosterInFlight = false;
    }
  }

  // ---- Admin: the member list and the allow-list ----
  list() {
    const now = Date.now();
    const sessions = {};
    for (const s of Object.values(this.data.sessions)) (sessions[s.pid] ||= []).push({ device: s.device, lastSeen: s.lastSeen, created: s.created });
    const roster = new Set(this.data.roster.ids);
    const ids = new Set([...Object.keys(this.data.members), ...Object.keys(this.data.allow)].map(Number));
    return {
      faction: { id: this.factionId(), name: this.factionName() }, rosterAt: this.data.roster.at, now,
      members: [...ids].map(pid => {
        const m = this.data.members[pid] || {};
        const a = this.data.allow[pid];
        return {
          id: pid, name: m.name || (a && a.name) || '', role: this.role(pid), inFaction: roster.size ? roster.has(pid) : m.factionId === this.factionId(),
          allowed: !!a, allowedAt: a ? a.at : 0, allowNote: a ? a.note || '' : '', keyLevel: m.keyLevel || 0,
          lastSeen: m.lastSeen || 0, firstSeen: m.firstSeen || 0, devices: (sessions[pid] || []).sort((x, y) => y.lastSeen - x.lastSeen),
          removedAt: this.data.removed[pid] || 0,
        };
      }).sort((x, y) => (y.lastSeen || 0) - (x.lastSeen || 0)),
    };
  }

  async allow(pid, note, by) {
    pid = Number(pid);
    if (!Number.isInteger(pid) || pid <= 0) throw Object.assign(new Error('Enter a player ID.'), { status: 400 });
    let name = (this.data.members[pid] || {}).name || '';
    if (!name && this.api) {
      try { const d = await this.api.request(`/user/${pid}?selections=basic`, { priority: 1 }); name = d.name || ''; } catch (e) { /* keep the ID */ }
    }
    this.data.allow[pid] = { name, note: String(note || '').slice(0, 120), at: Date.now(), by: Number(by) || 0 };
    this.save();
    this.log(`Allow-list: added ${name || 'player'} [${pid}].`);
    return this.list();
  }

  disallow(pid) {
    pid = Number(pid);
    if (!this.data.allow[pid]) return this.list();
    delete this.data.allow[pid];
    // Still in the faction? Then they keep access as a member.
    const roster = new Set(this.data.roster.ids);
    const m = this.data.members[pid] || {};
    const inFaction = roster.size ? roster.has(pid) : m.factionId === this.factionId();
    if (!inFaction && !this.isAdmin(pid)) this.revoke(pid, 'removed from the allow-list');
    this.save();
    this.log(`Allow-list: removed [${pid}].`);
    return this.list();
  }

  signOutEverywhere(pid) {
    this.revoke(pid, 'signed out by an admin');
    this.save();
    return this.list();
  }
}

module.exports = { Members, ACCESS_LEVELS, tornWithKey };
