'use strict';
// War claims, also called dibs (the user's request, 2026-11-21): who is going for which enemy,
// from the War tab's Claim button and the war board's Dibs button. Shared with everyone signed in
// to this server. Several people may claim the same enemy; they're listed in the order they
// claimed. Kept in memory only: a restart clears them, which is fine for something this short.
//
// One dib per person at a time (the user's rule, 2026-11-22): claiming someone new moves your dib.
// A dib ends when:
//   - its owner hits that player: read from the faction's attack log (/v2/faction/attacks, needs
//     a key with faction API access) every 15 s while there are dibs;
//   - the server's own member checks see that player land in hospital (anyone's hit);
//   - its owner drops it, or after CLAIM_MS.

const CLAIM_MS = 15 * 60e3;
const MAX_TRACKED = 5000;
const ATTACKS_EVERY = 15e3;
const DENIED_RETRY = 6 * 3600e3;
// Attack results that count as hitting them (losses, stalemates, escapes, timeouts, assists and
// interrupted attacks don't).
const HIT_RESULTS = new Set(['Attacked', 'Mugged', 'Hospitalized', 'Arrested', 'Looted', 'Special', 'Bounty']);

class Claims {
  constructor({ api = null, log = () => {} } = {}) {
    this.api = api;
    this.log = log;
    this.byTarget = new Map(); // enemy id -> [{ by, name, at }] in claim order
    this.seen = new Map(); // enemy id -> last state the server saw ('Okay', 'Hospital'…)
    this.rev = 0;
    this.last = 0; // last attack log read
    this.busy = false;
    this.attackLog = ''; // '' not tried yet, 'ok', 'denied' (key without faction API access)
    this.deniedAt = 0;
  }

  prune(now) {
    for (const [t, list] of this.byTarget) {
      const keep = list.filter(c => now - c.at < CLAIM_MS);
      if (keep.length === list.length) continue;
      this.rev++;
      if (keep.length) this.byTarget.set(t, keep); else this.byTarget.delete(t);
    }
  }

  list(now = Date.now()) {
    this.prune(now);
    const claims = {};
    for (const [t, l] of this.byTarget) claims[t] = l.map(c => ({ by: c.by, name: c.name, at: c.at }));
    // How a dib ends when its owner hits: 'attacks' (attack log) or 'hospital' (no log access).
    return { claims, rev: this.rev, now, expiresAfter: CLAIM_MS, perPlayer: 1, clearOn: this.attackLog === 'denied' ? 'hospital' : 'attacks' };
  }

  drop(pid, id) {
    const list = this.byTarget.get(id) || [];
    const rest = list.filter(c => c.by !== pid);
    if (rest.length === list.length) return false;
    if (rest.length) this.byTarget.set(id, rest); else this.byTarget.delete(id);
    this.rev++;
    return true;
  }

  // on = true: claim (claiming again keeps your place; claiming someone new moves your dib);
  // false: drop your claim.
  set(pid, name, target, on, now = Date.now()) {
    const id = Number(target);
    if (!Number.isInteger(id) || id <= 0) throw Object.assign(new Error('Which player?'), { status: 400 });
    this.prune(now);
    const list = this.byTarget.get(id) || [];
    const had = list.some(c => c.by === pid);
    if (on && !had) {
      for (const t of [...this.byTarget.keys()]) if (t !== id) this.drop(pid, t);
      this.byTarget.set(id, [...(this.byTarget.get(id) || []), { by: pid, name: String(name || `#${pid}`).slice(0, 40), at: now }]);
      this.rev++;
    } else if (!on && had) this.drop(pid, id);
    return this.list(now);
  }

  // The server's own enemy member checks (war 'members' events): an enemy who goes into
  // hospital since the last check was hit, so their claims are done.
  observe(members) {
    for (const m of members || []) {
      const prev = this.seen.get(m.id);
      this.seen.set(m.id, m.state);
      if (m.state === 'Hospital' && prev && prev !== 'Hospital' && this.byTarget.has(m.id)) {
        this.byTarget.delete(m.id);
        this.rev++;
      }
    }
    if (this.seen.size > MAX_TRACKED) this.seen.clear();
  }

  // Attacks from the faction's log: a dib ends when its owner hits that player after dibbing.
  hits(attacks) {
    let n = 0;
    for (const a of attacks || []) {
      if (!a || !a.attacker || !a.defender || !HIT_RESULTS.has(a.result)) continue;
      const list = this.byTarget.get(a.defender.id);
      const mine = list && list.find(c => c.by === a.attacker.id);
      if (mine && (a.ended || a.started || 0) * 1000 >= mine.at - 5e3 && this.drop(a.attacker.id, a.defender.id)) n++;
    }
    return n;
  }

  tick(now = Date.now()) {
    if (!this.api || !this.api.hasKey() || this.busy || !this.byTarget.size) return;
    if (this.attackLog === 'denied' && now - this.deniedAt < DENIED_RETRY) return;
    if (now - this.last < ATTACKS_EVERY) return;
    this.last = now;
    this.busy = true;
    let oldest = now;
    for (const l of this.byTarget.values()) for (const c of l) oldest = Math.min(oldest, c.at);
    const from = Math.floor((oldest - 10e3) / 1000);
    this.api.request(`/v2/faction/attacks?filters=outgoing&limit=100&sort=DESC&from=${from}&timestamp=${Math.floor(now / 1000)}`, { soft: [6, 7, 16], priority: 3 })
      .then(d => { this.attackLog = 'ok'; this.hits(d.attacks); })
      .catch(e => {
        if (e.kind === 'soft') {
          if (this.attackLog !== 'denied') this.log("Dibs: the server's key can't read the faction attack log, so dibs end when the player lands in hospital.");
          this.attackLog = 'denied';
          this.deniedAt = Date.now();
        }
      })
      .finally(() => { this.busy = false; });
  }
}

module.exports = { Claims, CLAIM_MS, HIT_RESULTS };
