'use strict';
// War claims (the user's request, 2026-11-21): the War tab's Claim button, shared through the
// Mentat server with everyone signed in to it (server/claims.js). Several people may claim one
// enemy; they show in the order they claimed. Claims come from the Mentat server, not Torn, so
// they don't touch the Torn API limit.
//   While the War tab is on show: every 3 s. During a war otherwise: every 30 s. Else not at all.

const { EventEmitter } = require('events');

const WATCHING_MS = 3000;
const WAR_MS = 30000;

class ClaimsFeature extends EventEmitter {
  constructor({ sync, war, viewing }) {
    super();
    this.sync = sync;
    this.war = war;
    this.viewing = viewing;
    this.state = { claims: {}, fetchedAt: 0, error: '' };
    this.busy = false;
    this.last = 0;
  }

  available() {
    return !!(this.sync && this.sync.signedIn());
  }

  snapshot() {
    const me = (this.sync && this.sync.me) || null;
    return { ...this.state, available: this.available(), me: me ? me.id : 0 };
  }

  tick(now) {
    if (!this.available()) {
      if (this.state.fetchedAt) { this.state = { claims: {}, fetchedAt: 0, error: '' }; this.emit('state'); }
      return;
    }
    const every = this.viewing('war') ? WATCHING_MS : this.war.inWar(now) ? WAR_MS : 0;
    if (!every || this.busy || now - this.last < every) return;
    this.load(now);
  }

  async load(now = Date.now()) {
    this.busy = true;
    this.last = now;
    try {
      this.take(await this.sync.req('GET', 'war/claims'));
    } catch (e) {
      const msg = /404|not found/i.test(e.message) ? 'Your Mentat server needs an update for claims.' : e.message;
      if (msg !== this.state.error) { this.state = { ...this.state, error: msg }; this.emit('state'); }
    } finally {
      this.busy = false;
    }
  }

  take(r) {
    const claims = r && r.claims && typeof r.claims === 'object' ? r.claims : {};
    // The server's clock vs ours, so "2 min ago" reads right on every device.
    const skew = r && r.now ? Date.now() - r.now : 0;
    for (const list of Object.values(claims)) for (const c of list) c.at += skew;
    this.state = { claims, fetchedAt: Date.now(), error: '', expiresAfter: (r && r.expiresAfter) || 0 };
    this.emit('state');
  }

  // Claim (on) or drop your claim (off) on an enemy.
  async set(target, on) {
    if (!this.available()) throw new Error('Sign in to your Mentat server to share claims.');
    const r = await this.sync.req('POST', 'war/claims', { body: { target: Number(target), claim: !!on } });
    this.take(r);
    return this.snapshot();
  }
}

module.exports = { ClaimsFeature };
