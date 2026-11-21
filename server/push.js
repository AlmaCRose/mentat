'use strict';
// Phone alerts while Mentat is closed (opt-in, per member). A member who turns them on in the web or
// phone app sends their push subscription, their Torn API key and which alerts they want. The key
// is stored encrypted (AES-256-GCM, with a secret that lives outside the data folder, so it's never
// in a backup) and used only to read that member's own bars, cooldowns and travel: once a minute, or
// every 15 s while a chain is close to timing out. Alerts go out as Web Push notifications (VAPID,
// RFC 8291 encryption) at the moment they're due. Turning the alerts off, signing out everywhere or
// leaving the faction deletes the key.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const POLL = 60e3;
const POLL_CHAIN = 15e3;
const CHAIN_WARN = 90; // seconds left on the chain timer
const DEFAULT_PREFS = { travel: true, chain: true, energy: true, nerve: true, life: false, drug: true, booster: false, medical: false };
const PREF_KEYS = Object.keys(DEFAULT_PREFS);
const KEY_PATTERN = /^[A-Za-z0-9]{16}$/;
const b64u = b => Buffer.from(b).toString('base64url');

// ---- Web Push (RFC 8291 payload encryption, RFC 8292 VAPID) ----
function encrypt(payload, sub, { salt = crypto.randomBytes(16), sender = null } = {}) {
  const uaPublic = Buffer.from(sub.keys.p256dh, 'base64url');
  const authSecret = Buffer.from(sub.keys.auth, 'base64url');
  const ecdh = crypto.createECDH('prime256v1');
  if (sender) ecdh.setPrivateKey(sender); else ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const shared = ecdh.computeSecret(uaPublic);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]);
  const ikm = Buffer.from(crypto.hkdfSync('sha256', shared, authSecret, keyInfo, 32));
  const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const body = Buffer.concat([cipher.update(Buffer.concat([Buffer.from(payload), Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const header = Buffer.alloc(21);
  salt.copy(header, 0);
  header.writeUInt32BE(4096, 16);
  header.writeUInt8(asPublic.length, 20);
  return Buffer.concat([header, asPublic, body]);
}

// The VAPID key pair comes from the push secret, so it stays the same across restarts.
function vapidFrom(secret) {
  const d = Buffer.from(crypto.hkdfSync('sha256', secret, Buffer.alloc(0), Buffer.from('mentat vapid'), 32));
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.setPrivateKey(d);
  const pub = ecdh.getPublicKey();
  const key = crypto.createPrivateKey({ format: 'jwk', key: { kty: 'EC', crv: 'P-256', d: b64u(d), x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33)) } });
  return { publicKey: b64u(pub), key };
}

function vapidHeader(vapid, endpoint, subject) {
  const aud = new URL(endpoint).origin;
  const enc = o => b64u(JSON.stringify(o));
  const unsigned = `${enc({ typ: 'JWT', alg: 'ES256' })}.${enc({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: subject })}`;
  const sig = crypto.sign('sha256', Buffer.from(unsigned), { key: vapid.key, dsaEncoding: 'ieee-p1363' });
  return `vapid t=${unsigned}.${b64u(sig)}, k=${vapid.publicKey}`;
}

class Push {
  constructor({ dataDir, secret, subject, log, members }) {
    this.file = path.join(dataDir, 'push.json');
    this.log = log;
    this.members = members;
    this.subject = subject || 'mailto:admin@example.com'; // set publicUrl in config.json
    this.enabled = !!secret && secret.length >= 16;
    this.data = { members: {} };
    if (!this.enabled) return;
    const s = Buffer.from(secret);
    this.vapid = vapidFrom(s);
    this.aes = Buffer.from(crypto.hkdfSync('sha256', s, Buffer.alloc(0), Buffer.from('mentat key store'), 32));
    try { this.data = { members: {}, ...JSON.parse(fs.readFileSync(this.file, 'utf8')) }; } catch (e) { /* none yet */ }
    this.state = {}; // pid -> { nextPoll, due: [{ at, id, title, body, url, tag }], sent: Set, chainArmed }
  }

  save() {
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  sealKey(key) {
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', this.aes, iv);
    const enc = Buffer.concat([c.update(key, 'utf8'), c.final()]);
    return b64u(Buffer.concat([iv, c.getAuthTag(), enc]));
  }

  openKey(sealed) {
    const b = Buffer.from(sealed, 'base64url');
    const d = crypto.createDecipheriv('aes-256-gcm', this.aes, b.subarray(0, 12));
    d.setAuthTag(b.subarray(12, 28));
    return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8');
  }

  config(pid) {
    const m = this.data.members[pid];
    return { available: this.enabled, publicKey: this.enabled ? this.vapid.publicKey : '', on: !!m, devices: m ? m.subs.length : 0, prefs: { ...DEFAULT_PREFS, ...(m ? m.prefs : {}) } };
  }

  cleanPrefs(p) {
    const out = {};
    for (const k of PREF_KEYS) out[k] = p && typeof p[k] === 'boolean' ? p[k] : DEFAULT_PREFS[k];
    return out;
  }

  // A member turns phone alerts on (or adds a device): their key must be their own.
  async subscribe(pid, body, torn) {
    if (!this.enabled) throw Object.assign(new Error('Phone alerts aren\'t set up on this server.'), { status: 503 });
    const sub = body && body.subscription;
    if (!sub || typeof sub.endpoint !== 'string' || !/^https:\/\//.test(sub.endpoint) || !sub.keys || typeof sub.keys.p256dh !== 'string' || typeof sub.keys.auth !== 'string') {
      throw Object.assign(new Error('That browser didn\'t give a push subscription.'), { status: 400 });
    }
    const key = String(body.key || '').replace(/[^A-Za-z0-9]/g, '');
    if (!KEY_PATTERN.test(key)) throw Object.assign(new Error('Your API key is needed for alerts while Mentat is closed.'), { status: 400 });
    const me = await torn(key, '/user/?selections=basic', pid);
    if (Number(me.player_id) !== Number(pid)) throw Object.assign(new Error('That API key belongs to someone else.'), { status: 403 });
    const m = this.data.members[pid] || { subs: [], prefs: { ...DEFAULT_PREFS }, since: Date.now() };
    m.keyEnc = this.sealKey(key);
    m.prefs = this.cleanPrefs({ ...m.prefs, ...(body.prefs || {}) });
    m.subs = m.subs.filter(s => s.endpoint !== sub.endpoint);
    m.subs.push({ endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth }, device: String(body.device || '').slice(0, 60), at: Date.now() });
    m.subs = m.subs.slice(-6);
    m.error = '';
    this.data.members[pid] = m;
    this.state[pid] = null; // poll soon
    this.save();
    this.log(`Phone alerts on for ${me.name} [${pid}] (${m.subs.length} device${m.subs.length === 1 ? '' : 's'}).`);
    return this.config(pid);
  }

  setPrefs(pid, prefs) {
    const m = this.data.members[pid];
    if (!m) return this.config(pid);
    m.prefs = this.cleanPrefs({ ...m.prefs, ...(prefs || {}) });
    this.save();
    return this.config(pid);
  }

  // Off on one device (endpoint) or everywhere; with no devices left the key is deleted.
  unsubscribe(pid, endpoint, why = 'turned off') {
    const m = this.data.members[pid];
    if (!m) return this.config(pid);
    m.subs = endpoint ? m.subs.filter(s => s.endpoint !== endpoint) : [];
    if (!m.subs.length) {
      delete this.data.members[pid];
      delete this.state[pid];
      this.log(`Phone alerts off for [${pid}] (${why}); key deleted.`);
    }
    this.save();
    return this.config(pid);
  }

  async send(pid, msg) {
    const m = this.data.members[pid];
    if (!m) return 0;
    const payload = JSON.stringify(msg);
    let sent = 0;
    for (const s of [...m.subs]) {
      try {
        const res = await fetch(s.endpoint, {
          method: 'POST', signal: AbortSignal.timeout(15000), body: encrypt(payload, s),
          headers: { 'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream', TTL: String(msg.ttl || 3600), Urgency: msg.urgent ? 'high' : 'normal', Authorization: vapidHeader(this.vapid, s.endpoint, this.subject) },
        });
        if (res.status === 404 || res.status === 410) { this.unsubscribe(pid, s.endpoint, 'device gone'); continue; }
        if (res.ok) sent++;
        else this.log(`Push to [${pid}] failed: HTTP ${res.status}`);
      } catch (e) { this.log(`Push to [${pid}] failed: ${e.message}`); }
    }
    return sent;
  }

  test(pid) {
    return this.send(pid, { title: 'Mentat', body: 'Phone alerts are working.', url: '/app/', tag: 'mentat-test' });
  }

  // ---- Watching each member's own status ----
  async poll(pid, now, torn) {
    const m = this.data.members[pid];
    const st = this.state[pid] || (this.state[pid] = { due: [], sent: new Set(), chainArmed: true });
    st.nextPoll = now + POLL;
    let key;
    try { key = this.openKey(m.keyEnc); } catch (e) { this.unsubscribe(pid, null, "the stored key couldn't be read"); return; }
    let u;
    try {
      u = await torn(key, '/v2/user?selections=bars,cooldowns,travel', pid);
    } catch (e) {
      if ([2, 10, 13, 18].includes(e.tornCode)) {
        await this.send(pid, { title: 'Mentat', body: 'Phone alerts stopped: Torn no longer accepts your API key. Turn them on again in Mentat with a working key.', url: '/app/' });
        this.unsubscribe(pid, null, `Torn rejected the key (${e.message})`);
      } else { m.error = e.message; st.nextPoll = now + 5 * 60e3; }
      return;
    }
    const p = m.prefs;
    const due = [];
    const at = s => now + Math.max(0, Number(s) || 0) * 1000;
    const tr = u.travel;
    if (p.travel && tr && tr.time_left > 0) due.push({ at: at(tr.time_left), id: `travel:${tr.arrival_at}`, title: `Landed in ${tr.destination}`, body: 'Your flight has landed.', url: 'https://www.torn.com/index.php', urgent: true });
    const bars = u.bars || {};
    for (const [k, label, url] of [['energy', 'Energy', 'https://www.torn.com/gym.php'], ['nerve', 'Nerve', 'https://www.torn.com/page.php?sid=crimes'], ['life', 'Life', 'https://www.torn.com/index.php']]) {
      const b = bars[k];
      if (p[k] && b && b.current < b.maximum && b.full_time > 0) due.push({ at: at(b.full_time), id: `${k}:${Math.round((now / 1000 + b.full_time) / 60)}`, title: `${label} is full`, body: `${label} ${b.maximum}/${b.maximum}.`, url });
    }
    const cd = u.cooldowns || {};
    for (const [k, label] of [['drug', 'Drug'], ['booster', 'Booster'], ['medical', 'Medical']]) {
      if (p[k] && cd[k] > 0) due.push({ at: at(cd[k]), id: `${k}:${Math.round((now / 1000 + cd[k]) / 60)}`, title: `${label} cooldown is over`, body: `You can use a ${k} item again.`, url: 'https://www.torn.com/item.php' });
    }
    st.due = due;
    // Chain: one warning each time the timer runs low; re-armed when a hit resets it.
    const c = bars.chain;
    if (c && c.current >= 10 && c.timeout > 0) {
      if (c.timeout > CHAIN_WARN + 20) st.chainArmed = true;
      if (p.chain && st.chainArmed && c.timeout <= CHAIN_WARN) {
        st.chainArmed = false;
        await this.send(pid, { title: `Chain ${c.current}: ${c.timeout}s left`, body: 'Hit someone to keep the chain going.', url: 'https://www.torn.com/factions.php?step=your#/war/chain', tag: 'mentat-chain', urgent: true, ttl: 120 });
      }
      if (c.timeout < 300) st.nextPoll = now + POLL_CHAIN;
    }
  }

  // Every second from the server: poll who's due, send alerts that are due now.
  async tick(now, torn) {
    if (!this.enabled || this.ticking) return;
    this.ticking = true;
    try {
      for (const pid of Object.keys(this.data.members)) {
        const st = this.state[pid];
        if (!st || now >= st.nextPoll) await this.poll(pid, now, torn);
        const s = this.state[pid];
        if (!s) continue;
        for (const d of s.due) {
          if (d.at > now || s.sent.has(d.id)) continue;
          s.sent.add(d.id);
          await this.send(pid, { title: d.title, body: d.body, url: d.url, tag: d.id.split(':')[0], urgent: d.urgent });
        }
        s.due = s.due.filter(d => !s.sent.has(d.id));
        if (s.sent.size > 200) s.sent = new Set([...s.sent].slice(-100));
      }
    } finally {
      this.ticking = false;
    }
  }
}

module.exports = { Push, encrypt, vapidFrom, vapidHeader, DEFAULT_PREFS };
