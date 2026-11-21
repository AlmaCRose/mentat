'use strict';
// War claims (the user's request, 2026-11-21): who is going for which enemy, from the War tab's
// Claim button. Shared with everyone signed in to this server. Several people may claim the same
// enemy; they're listed in the order they claimed. A claim ends when its owner drops it, when the
// server's own member checks see that enemy land in hospital (the hit happened), or after
// CLAIM_MS. Kept in memory only: a restart clears them, which is fine for something this short.

const CLAIM_MS = 15 * 60e3;
const MAX_PER_PLAYER = 30;
const MAX_TRACKED = 5000;

class Claims {
  constructor() {
    this.byTarget = new Map(); // enemy id -> [{ by, name, at }] in claim order
    this.seen = new Map(); // enemy id -> last state the server saw ('Okay', 'Hospital'…)
    this.rev = 0;
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
    return { claims, rev: this.rev, now, expiresAfter: CLAIM_MS };
  }

  // on = true: claim (claiming again keeps your place); false: drop your claim.
  set(pid, name, target, on, now = Date.now()) {
    const id = Number(target);
    if (!Number.isInteger(id) || id <= 0) throw Object.assign(new Error('Which player?'), { status: 400 });
    this.prune(now);
    const list = this.byTarget.get(id) || [];
    const had = list.some(c => c.by === pid);
    if (on && !had) {
      let mine = 0;
      for (const l of this.byTarget.values()) mine += l.filter(c => c.by === pid).length;
      if (mine >= MAX_PER_PLAYER) throw Object.assign(new Error(`You already have ${MAX_PER_PLAYER} claims; drop some first.`), { status: 429 });
      this.byTarget.set(id, [...list, { by: pid, name: String(name || `#${pid}`).slice(0, 40), at: now }]);
      this.rev++;
    } else if (!on && had) {
      const rest = list.filter(c => c.by !== pid);
      if (rest.length) this.byTarget.set(id, rest); else this.byTarget.delete(id);
      this.rev++;
    }
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
}

module.exports = { Claims, CLAIM_MS };
