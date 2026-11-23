'use strict';
// Energy sharing (the user's request, 2026-11-23): members who opt in on the war board share their
// energy bar and drug cooldown with the faction, read from Torn with their own key about once a
// minute while they have Torn open. Torn's API rules: data from a key stays confidential "unless
// permitted by the key owner", so this is opt-in only, with Torn's ToS table shown before it's
// turned on. Readings are kept less than a day (energy.json, so a restart doesn't lose them),
// shown to signed-in members only, and deleted at once when the member turns sharing off.

const path = require('path');
const { Store } = require('../src/main/store');

const KEEP_MS = 24 * 3600e3;
const fail = (status, message) => Object.assign(new Error(message), { status });
const int = (v, lo, hi) => { const n = Math.round(Number(v)); return Number.isFinite(n) && n >= lo && n <= hi ? n : null; };

class EnergyShare {
  constructor({ dataDir }) {
    this.db = new Store(path.join(dataDir, 'energy.json'), { members: {} }, { debounceMs: 5000 });
    this.rev = 0;
  }

  // A member's reading: Torn's energy bar (current, maximum, increment, interval, tick_time,
  // full_time in seconds) and the drug cooldown (seconds left).
  report(pid, name, body, now = Date.now()) {
    const e = body && body.energy;
    const current = int(e && e.current, 0, 100000);
    const maximum = int(e && e.maximum, 1, 100000);
    if (current === null || maximum === null) throw fail(400, 'No energy reading.');
    const m = {
      name: String(name || `#${pid}`).slice(0, 40),
      energy: {
        current, maximum,
        increment: int(e.increment, 0, 1000) || 0,
        interval: int(e.interval, 1, 86400) || 0,
        tick: int(e.tick_time, 0, 86400) || 0,
        full: int(e.full_time, 0, 7 * 86400) || 0,
      },
      drug: int(body.drug, 0, 30 * 86400) || 0,
      at: now,
    };
    this.db.data.members[pid] = m;
    this.db.set('members', this.db.data.members);
    this.rev++;
    return m;
  }

  remove(pid) {
    if (!this.db.data.members[pid]) return false;
    delete this.db.data.members[pid];
    this.db.set('members', this.db.data.members);
    this.rev++;
    return true;
  }

  prune(now = Date.now()) {
    let gone = false;
    for (const [pid, m] of Object.entries(this.db.data.members)) if (now - m.at > KEEP_MS) { delete this.db.data.members[pid]; gone = true; }
    if (gone) { this.db.set('members', this.db.data.members); this.rev++; }
  }

  view(now = Date.now()) {
    this.prune(now);
    return { members: this.db.data.members, keepMs: KEEP_MS };
  }

  flush() { try { this.db.flush(); } catch (e) { /* next time */ } }
}

module.exports = { EnergyShare, KEEP_MS };
