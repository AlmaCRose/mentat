'use strict';
// Custom timer alerts: "tell me N minutes (or seconds) before <timer>", each with its own
// sound and optional desktop popup. Uses only timers the app already tracks (bars,
// cooldowns, travel, hospital, chain, targets, daily reset, abroad restocks), so no extra API
// requests.
//
// Abroad restocks (rule.item = "<country code>:<item id>") come from the travel feature's YATA
// readings and restock analysis (restock.js): 'restock' = the predicted next restock, 'restockleave'
// = when to leave (Travel's flight method) to land just after it, and 'restocked' = an event, not a
// timer: the item's stock went up between two readings.
//
// An alert fires when its moment passes while the app is running, and only for a timer
// that was seen counting down before that moment: opening the app when a timer is already
// inside its warning window doesn't fire (no burst of alerts at launch).

const { EventEmitter } = require('events');

const T = 'https://www.torn.com/';
// key -> label, page to open, and phrasing for "ends" and "N before".
const TIMERS = {
  energy: { label: 'Energy full', url: T + 'gym.php', done: 'Energy is full' },
  nerve: { label: 'Nerve full', url: T + 'page.php?sid=crimes', done: 'Nerve is full' },
  happy: { label: 'Happy full', url: T + 'item.php', done: 'Happy is full' },
  life: { label: 'Life full', url: T + 'item.php#medical-items', done: 'Life is full' },
  drug: { label: 'Drug cooldown', url: T + 'item.php#drugs-items', done: 'Drug cooldown is over' },
  booster: { label: 'Booster cooldown', url: T + 'item.php#boosters-items', done: 'Booster cooldown is over' },
  medical: { label: 'Medical cooldown', url: T + 'item.php#medical-items', done: 'Medical cooldown is over' },
  travel: { label: 'Landing', url: T + 'index.php', done: 'You have landed' },
  hospital: { label: 'Out of hospital / jail', url: T + 'index.php', done: 'You are out' },
  chain: { label: 'Chain timer runs out', url: T + 'factions.php?step=your#/war/chain', done: 'Chain timer ran out' },
  target: { label: 'Target out of hospital / jail', url: '', done: 'is out' },
  enemy: { label: 'War enemy out of hospital', url: '', done: 'is out' },
  warstart: { label: 'Ranked war starts', url: T + 'factions.php?step=your#/war/rank', done: 'Ranked war has started' },
  reset: { label: 'Daily reset (00:00 TCT)', url: T + 'index.php', done: 'Daily reset' },
  restock: { label: 'Abroad restock (predicted)', url: T + 'page.php?sid=travel', done: 'restock due', item: true },
  restockleave: { label: 'Time to leave for an abroad restock', url: T + 'page.php?sid=travel', done: 'Time to leave', item: true },
  restocked: { label: 'Abroad restock seen (stock went up)', url: T + 'page.php?sid=travel', done: 'restocked', item: true, event: true },
};
const ITEM_KEY = /^[a-z]{3}:\d{1,7}$/;
const RESTOCK_FRESH_MS = 10 * 60 * 1000; // a reading older than this is too late to alert on
const RESTOCK_GAP_MS = 15 * 60 * 1000;   // readings further apart than this: don't compare them

// Sounds, played by the tool window (see beep() in app.js). The soft ones are pure tones
// with natural fades, like a struck bell or a plucked string; the classic ones are the
// original electronic beeps. Distinct shapes so you can tell alerts apart.
const SOUNDS = {
  softchime: { label: 'Soft chime', env: 'bell', count: 2, freqs: [1047, 1319], step: 0.22, len: 1.6, partials: [[1, 1, 1], [2, 0.25, 0.5], [3, 0.08, 0.3]] },
  marimba: { label: 'Marimba', env: 'pluck', count: 3, freqs: [523.3, 659.3, 784], step: 0.14, len: 0.6, partials: [[1, 1, 1], [4, 0.18, 0.25], [10, 0.05, 0.1]] },
  harp: { label: 'Harp', env: 'pluck', count: 4, freqs: [392, 493.9, 587.3, 784], step: 0.09, len: 1.4, partials: [[1, 1, 1], [2, 0.35, 0.6], [3, 0.12, 0.4]] },
  glass: { label: 'Glass', env: 'bell', count: 1, freqs: [1568], len: 2, partials: [[1, 1, 1], [2.76, 0.35, 0.5], [5.4, 0.12, 0.3]] },
  doorbell: { label: 'Doorbell', env: 'bell', count: 2, freqs: [659.3, 523.3], step: 0.45, len: 1.4, partials: [[1, 1, 1], [2, 0.2, 0.6]] },
  drop: { label: 'Water drop', env: 'pluck', count: 2, freqs: [1400, 1900], step: 0.16, len: 0.35, glide: 0.55 },
  pad: { label: 'Warm pad', env: 'pad', chord: true, count: 1, freqs: [261.6, 329.6, 392], len: 1.6, partials: [[1, 1, 1], [2, 0.15, 1]] },
  chime: { label: 'Classic chime', count: 2, freqs: [880, 1320], wave: 'sine', len: 0.28, gap: 0.06 },
  bell: { label: 'Classic bell', count: 3, freqs: [1047, 784, 1047], wave: 'triangle', len: 0.3, gap: 0.05 },
  beep: { label: 'Classic beep', count: 1, freqs: [880], wave: 'square', len: 0.25, gap: 0.1 },
  double: { label: 'Classic double beep', count: 2, freqs: [740], wave: 'square', len: 0.15, gap: 0.1 },
  alarm: { label: 'Classic alarm', count: 6, freqs: [988, 740], wave: 'square', len: 0.12, gap: 0.05 },
  rise: { label: 'Classic rising', count: 4, freqs: [523, 659, 784, 1047], wave: 'sine', len: 0.16, gap: 0.03 },
  none: { label: 'No sound', count: 0, freqs: [0] },
};

const MAX_LATE_MS = 3 * 60 * 1000; // e.g. after the PC slept: skip alerts this stale
const ARM_MARGIN_MS = 1500;
const SAME_END_MS = 120 * 1000; // end time drifts a little between refreshes
const MAX_RULES = 50;

const fmtBefore = sec => {
  if (!sec) return 'when it ends';
  if (sec % 60 === 0) return `${sec / 60} min before`;
  if (sec < 60) return `${sec} s before`;
  return `${Math.floor(sec / 60)} min ${sec % 60} s before`;
};
const fmtLeft = sec => (sec >= 120 ? `${Math.round(sec / 60)} min` : `${Math.round(sec)} s`);
const tct = ms => new Date(ms).toISOString().slice(11, 16);

class AlertsFeature extends EventEmitter {
  constructor({ store, notify, user, chain, targets, war, travel }) {
    super();
    this.store = store;
    this.notify = notify;
    this.user = user;
    this.chain = chain;
    this.targets = targets;
    this.war = war || null;
    this.travel = travel || null;
    this.armed = new Map(); // "<rule>|<instance>" -> end time it was armed for
    this.lastEmit = 0;
    this.stockSeen = new Map(); // "<country>:<item>" -> { at, q } (last reading, for 'restocked')
    for (const f of [user, chain, targets, war]) if (f) f.on('state', () => this.emitSoon());
    if (travel) {
      travel.on('readings', () => this.checkRestocks(Date.now()));
      travel.on('state', () => { this.checkRestocks(Date.now()); this.emitSoon(); });
    }
  }

  rules() {
    return this.store.get('alerts.rules') || [];
  }

  saveRules(rules) {
    this.store.set('alerts.rules', rules);
    this.emitSoon(true);
  }

  static clean(r) {
    const timer = TIMERS[r.timer] ? r.timer : null;
    if (!timer) throw new Error('Unknown timer');
    const before = TIMERS[timer].event ? 0 : Math.max(0, Math.min(24 * 3600, Math.round(Number(r.before) || 0)));
    const item = TIMERS[timer].item ? String(r.item || '') : '';
    if (TIMERS[timer].item && !ITEM_KEY.test(item)) throw new Error('Pick an abroad item');
    return {
      ...(item ? { item } : {}),
      timer,
      before,
      sound: SOUNDS[r.sound] ? r.sound : 'softchime',
      desktop: r.desktop !== false,
      urgent: !!r.urgent, // an urgent popup in the middle of the screen (stays until dismissed)
      enabled: r.enabled !== false,
      target: timer === 'target' ? Math.max(0, Math.floor(Number(r.target) || 0)) : 0,
    };
  }

  add(r) {
    const rules = this.rules();
    if (rules.length >= MAX_RULES) throw new Error(`Up to ${MAX_RULES} alerts`);
    const rule = { id: `a${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, ...AlertsFeature.clean(r) };
    this.saveRules([...rules, rule]);
    return rule;
  }

  update(id, patch) {
    const rules = this.rules().map(r => (r.id === id ? { id, ...AlertsFeature.clean({ ...r, ...patch }) } : r));
    for (const k of [...this.armed.keys()]) if (k.startsWith(id + '|')) this.armed.delete(k);
    this.saveRules(rules);
  }

  remove(id) {
    this.saveRules(this.rules().filter(r => r.id !== id));
  }

  // Every running timer: { timer, inst, end, name }.
  instances(now) {
    const out = [];
    const u = this.user.snapshot().data;
    if (u) {
      if (u.bars) {
        for (const k of ['energy', 'nerve', 'happy', 'life']) {
          const b = u.bars[k];
          if (b && b.maximum && b.current < b.maximum && b.fullAt > now) out.push({ timer: k, inst: '', end: b.fullAt });
        }
      }
      if (u.cooldowns) for (const k of ['drug', 'booster', 'medical']) if (u.cooldowns[k] > now) out.push({ timer: k, inst: '', end: u.cooldowns[k] });
      if (u.travel && u.travel.arriveAt > now) out.push({ timer: 'travel', inst: '', end: u.travel.arriveAt, name: u.travel.destination });
      const st = u.status || {};
      if ((st.state === 'Hospital' || st.state === 'Jail') && st.until > now) out.push({ timer: 'hospital', inst: '', end: st.until, name: st.state });
    }
    const c = this.chain.snapshot().chain;
    if (c && !c.noFaction && c.current > 0 && !c.cooldown && c.expiresAt > now && now - c.fetchedAt < 5 * 60 * 1000) {
      out.push({ timer: 'chain', inst: '', end: c.expiresAt, name: `${c.current} hits` });
    }
    for (const t of Object.values(this.targets.list())) {
      const s = t.status;
      if (s && (s.state === 'Hospital' || s.state === 'Jail') && s.until > now) out.push({ timer: 'target', inst: String(t.id), end: s.until, name: t.name || `#${t.id}`, state: s.state });
    }
    if (this.war) {
      const w = this.war.snapshot();
      const e = w.enemy;
      if (e) for (const m of e.members) {
        if ((m.state === 'Hospital' || m.state === 'Jail') && m.until > now) out.push({ timer: 'enemy', inst: String(m.id), end: m.until, name: m.name, state: m.state });
      }
      const r = w.wars && w.wars.ranked;
      if (r && r.start > now) {
        const own = w.own && w.own.id;
        const them = r.factions.find(f => f.id !== own);
        out.push({ timer: 'warstart', inst: String(r.id), end: r.start, name: them ? `vs ${them.name}` : '' });
      }
    }
    const d = new Date(now);
    out.push({ timer: 'reset', inst: '', end: Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1) });
    // Abroad restocks, for the items that have alerts.
    const keys = new Set(this.rules().filter(r => r.timer === 'restock' || r.timer === 'restockleave').map(r => r.item));
    for (const key of keys) {
      const a = this.abroadItem(key);
      const st = a && a.i.stats;
      if (!st || !st.cadence) continue;
      const name = `${a.i.name} in ${a.c.name}`;
      const meta = { name, unc: st.cadence.uncertainty, conf: st.cadence.confidence };
      // Kept for 90 s after it passes, so a "when it happens" alert sees its moment arrive.
      const next = (st.next || []).find(t => t > now - 90000);
      if (next) out.push({ timer: 'restock', inst: key, end: next, ...meta });
      if (this.travel) {
        const method = this.travel.method();
        const fMin = this.travel.flightMinutes(a.c.code, method);
        const delay = landingDelay(st);
        const t = (st.next || []).find(x => x + delay - fMin * 60000 > now - 90000);
        if (t && fMin) out.push({ timer: 'restockleave', inst: key, end: t + delay - fMin * 60000, restockAt: t, method, fMin, ...meta });
      }
    }
    return out;
  }

  // Abroad items that have an alert switched on (Travel reads YATA every 10 s while there are any).
  restockKeys() {
    return new Set(this.rules().filter(r => r.enabled && r.item && TIMERS[r.timer] && TIMERS[r.timer].item).map(r => r.item));
  }

  // An abroad item by "<country>:<item id>": { c, i } from the travel feature's latest readings.
  abroadItem(key) {
    if (!this.travel || !key) return null;
    const [code, id] = String(key).split(':');
    const c = (this.travel.state.countries || []).find(x => x.code === code);
    const i = c && c.items.find(x => x.id === Number(id));
    return i ? { c, i } : null;
  }

  // 'restocked' alerts: the item's stock went up from one reading to the next. Only fresh
  // readings that follow on closely count (not data that arrives after the app was closed).
  checkRestocks(now) {
    const rules = this.rules().filter(r => r.enabled && r.timer === 'restocked');
    const keys = new Set(rules.map(r => r.item));
    for (const key of [...this.stockSeen.keys()]) if (!keys.has(key)) this.stockSeen.delete(key);
    for (const key of keys) {
      const a = this.abroadItem(key);
      if (!a || !a.c.update) continue;
      const prev = this.stockSeen.get(key);
      const q = a.i.quantity;
      if (prev && a.c.update <= prev.at) continue;
      this.stockSeen.set(key, { at: a.c.update, q });
      if (!prev || q <= prev.q || a.c.update - prev.at > RESTOCK_GAP_MS || now - a.c.update > RESTOCK_FRESH_MS) continue;
      const inst = { timer: 'restocked', inst: key, end: a.c.update, name: `${a.i.name} in ${a.c.name}`, q, prevQ: prev.q };
      for (const rule of rules) if (rule.item === key) this.fire(rule, inst, now);
    }
  }

  matches(rule, inst) {
    if (rule.timer !== inst.timer) return false;
    if (TIMERS[rule.timer].item) return rule.item === inst.inst;
    return rule.timer !== 'target' || !rule.target || String(rule.target) === inst.inst;
  }

  tick(now) {
    const rules = this.rules().filter(r => r.enabled && !TIMERS[r.timer].event);
    if (!rules.length) return;
    const insts = this.instances(now);
    for (const rule of rules) {
      for (const inst of insts) {
        if (!this.matches(rule, inst)) continue;
        const key = `${rule.id}|${inst.inst}`;
        const fireAt = inst.end - rule.before * 1000;
        if (now < fireAt - ARM_MARGIN_MS) {
          this.armed.set(key, { end: inst.end, name: inst.name || '', state: inst.state || '' });
          continue;
        }
        const armed = this.armed.get(key);
        if (now >= fireAt && armed && Math.abs(armed.end - inst.end) < SAME_END_MS) {
          this.armed.delete(key);
          if (now - fireAt <= MAX_LATE_MS) this.fire(rule, inst, now);
        }
      }
    }
    // Timers that ended (e.g. cooldown reached zero) fire "when it ends" alerts too: they
    // drop out of instances() at the end, so check armed "before: 0" rules here.
    for (const rule of rules) {
      if (rule.before) continue;
      for (const [key, a] of this.armed) {
        if (!key.startsWith(rule.id + '|') || now < a.end) continue;
        this.armed.delete(key);
        if (now - a.end <= MAX_LATE_MS) {
          const inst = key.split('|')[1];
          this.fire(rule, { timer: rule.timer, inst, end: a.end, name: a.name || (inst ? `#${inst}` : ''), state: a.state }, now);
        }
      }
    }
    // Instances the alert was armed for that vanished early (e.g. you used the energy):
    // forget them so they can't fire later for a different end time.
    for (const [key, a] of this.armed) if (now - a.end > MAX_LATE_MS) this.armed.delete(key);
    if (now - this.lastEmit > 30000) this.emitSoon();
  }

  message(rule, inst, now = Date.now()) {
    const t = TIMERS[rule.timer];
    const left = (inst.end - now) / 1000;
    const ended = !rule.before || left <= 1;
    let title, body;
    if (rule.timer === 'target' || rule.timer === 'enemy') {
      title = ended ? `${inst.name} is out` : `${inst.name} out in ${fmtLeft(left)}`;
      body = `${rule.timer === 'enemy' ? 'War enemy. ' : ''}${inst.state || 'Hospital'} timer ${ended ? 'ended' : `ends at ${tct(inst.end)} TCT`}.`;
    } else if (rule.timer === 'warstart') {
      title = ended ? `Ranked war started ${inst.name}` : `Ranked war ${inst.name} starts in ${fmtLeft(left)}`;
      body = `${ended ? 'Started' : 'Starts'} at ${tct(inst.end)} TCT.`;
    } else if (rule.timer === 'restock') {
      title = ended ? `${inst.name}: restock due now` : `${inst.name} restocks in ${fmtLeft(left)}`;
      body = `Predicted ~${tct(inst.end)} TCT${inst.unc ? ` ±${Math.ceil(inst.unc / 60000)} min` : ''}${inst.conf ? ` (${inst.conf} confidence)` : ''}.`;
    } else if (rule.timer === 'restockleave') {
      title = ended ? `Leave now for ${inst.name}` : `Leave for ${inst.name} in ${fmtLeft(left)}`;
      body = `Leave ${tct(inst.end)} TCT${inst.fMin ? ` (${inst.method === 'Private' ? 'WLT' : inst.method || ''}, ${Math.round(inst.fMin)} min)` : ''} to land just after the ~${tct(inst.restockAt || inst.end)} restock.`;
    } else if (rule.timer === 'restocked') {
      title = `${inst.name} restocked`;
      body = inst.q !== undefined ? `${inst.q} in stock (was ${inst.prevQ}) at the ${tct(inst.end)} TCT reading.` : 'Its stock just went up.';
    } else if (rule.timer === 'chain') {
      title = ended ? 'Chain timer ran out' : `Chain timer: ${fmtLeft(left)} left`;
      body = `${inst.name || 'Chain'}. Hit someone to keep it going.`;
    } else {
      title = ended ? t.done : `${t.label} in ${fmtLeft(left)}`;
      body = `${ended ? 'Ended' : 'At'} ${tct(inst.end)} TCT${inst.name ? ` (${inst.name})` : ''}.`;
    }
    const url = rule.timer === 'target' || rule.timer === 'enemy' ? `https://www.torn.com/profiles.php?XID=${inst.inst}` : t.url;
    return { title, body, url };
  }

  fire(rule, inst, now = Date.now()) {
    const m = this.message(rule, inst, now);
    const vol = this.store.get('alerts.volume');
    const s = SOUNDS[rule.sound] || SOUNDS.softchime;
    if (s.count) this.emit('beep', { ...s, volume: vol === undefined ? 0.6 : vol });
    if (rule.desktop || rule.urgent) this.notify(m.title, m.body, m.url, !!rule.urgent);
    const log = [{ at: now, title: m.title, rule: rule.id }, ...(this.recent || [])].slice(0, 20);
    this.recent = log;
    this.emitSoon(true);
  }

  // "Test" button: the alert as it would look now (sound + popup).
  test(id) {
    const rule = this.rules().find(r => r.id === id);
    if (!rule) return;
    const ab = TIMERS[rule.timer].item ? this.abroadItem(rule.item) : null;
    const inst = this.instances(Date.now()).find(i => this.matches(rule, i))
      || { timer: rule.timer, inst: String(rule.item || rule.target || ''), end: Date.now() + rule.before * 1000, name: ab ? `${ab.i.name} in ${ab.c.name}` : rule.timer === 'target' ? 'Target' : rule.timer === 'enemy' ? 'Enemy' : '' };
    this.fire(rule, inst);
  }

  preview(sound) {
    const s = SOUNDS[sound];
    const vol = this.store.get('alerts.volume');
    if (s && s.count) this.emit('beep', { ...s, volume: vol === undefined ? 0.6 : vol });
  }

  emitSoon(now = false) {
    if (this.emitTimer && !now) return;
    clearTimeout(this.emitTimer);
    this.emitTimer = setTimeout(() => { this.emitTimer = null; this.lastEmit = Date.now(); this.emit('state'); }, now ? 0 : 300);
  }

  // Rules plus the next time each will go off.
  snapshot() {
    const now = Date.now();
    const insts = this.instances(now);
    const rules = this.rules();
    const upcoming = [];
    for (const rule of rules) {
      if (!rule.enabled) continue;
      for (const inst of insts) {
        if (!this.matches(rule, inst)) continue;
        const fireAt = inst.end - rule.before * 1000;
        if (fireAt > now) upcoming.push({ rule: rule.id, timer: rule.timer, name: inst.name || '', fireAt, end: inst.end });
      }
    }
    upcoming.sort((a, b) => a.fireAt - b.fireAt);
    return {
      rules,
      upcoming: upcoming.slice(0, 30),
      recent: this.recent || [],
      timers: Object.fromEntries(Object.entries(TIMERS).map(([k, v]) => [k, v.label])),
      sounds: Object.fromEntries(Object.entries(SOUNDS).map(([k, v]) => [k, v.label])),
      targets: Object.values(this.targets.list()).map(t => ({ id: t.id, name: t.name || `#${t.id}` })),
      itemTimers: Object.keys(TIMERS).filter(k => TIMERS[k].item),
      // Abroad items to pick from, and names for the items alerts already use.
      abroad: this.abroadList(),
    };
  }

  abroadList() {
    const out = [];
    for (const c of (this.travel && this.travel.state.countries) || []) for (const i of c.items) if (i.cost) out.push({ key: `${c.code}:${i.id}`, name: i.name, country: c.name });
    return out.sort((a, b) => a.name.localeCompare(b.name) || a.country.localeCompare(b.country));
  }
}

// How long after a predicted restock to land, so it has happened (same as the page's travel.js).
function landingDelay(st) {
  const cad = st.cadence;
  let d = (cad ? cad.uncertainty : 2 * 60000) + 60000;
  if (st.stay) d = Math.min(d, st.stay * 0.4);
  return Math.max(30000, d);
}

module.exports = { AlertsFeature, TIMERS, SOUNDS, fmtBefore };
