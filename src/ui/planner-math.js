'use strict';
// Planner maths (PM): projects energy, nerve and life through a plan, with regen, boosts,
// spending, blood bag fills and cooldowns, and finds what doesn't work (not enough energy, a
// second refill in a day, a drug while the drug cooldown runs, gym while you're abroad…).
// Pure functions, no DOM: the Planner tab (planner.js) calls simulate(); Node tests require it.
//
// Torn facts used (Torn wiki, Nov 2026; regen comes from your own API data when there is any):
// - Bars regenerate on ticks: energy 5 per 15 min (10 min for donators), nerve 1 per 5 min,
//   life 5% of max per 5 min. Nothing regenerates while a bar is at or above its maximum.
// - Filling an empty blood bag costs 30% of max life and adds 1 h of medical cooldown.
// - Energy and nerve refills (points) fill the bar once per TCT day.
// - Xanax: +250 energy and about 6–8 h of drug cooldown. Feathery Hotel Coupon: fills energy,
//   +6 h booster cooldown. Booster cooldown tops out at 24 h (48 h with faction upgrades).
//   A drug can't be taken while the drug cooldown runs.
// - Items can be used anywhere, flying included; no gym or crimes while flying or abroad.

const PM_MIN = 60000;
const PM_HOUR = 3600000;
const PM_DAY = 86400000;
const BLOOD_LIFE = 0.3;     // share of max life one fill takes
const BLOOD_MED_H = 1;      // medical cooldown per fill (hours)
const BOOSTER_CAP_H = 24;   // base maximum booster cooldown

const pmDayStart = t => Math.floor(t / PM_DAY) * PM_DAY;
const pmDayKey = t => new Date(t).toISOString().slice(0, 10);
const pmHM = t => new Date(t).toISOString().slice(11, 16);

// Energy kinds a plan item can use. fill = sets the bar to its maximum.
const ENERGY_KINDS = {
  xanax: { label: 'Xanax', amount: 250, cd: 'drug', cdHours: 8 },
  refill: { label: 'Energy refill (points)', fill: true, daily: 'energy' },
  fhc: { label: 'Feathery Hotel Coupon', fill: true, cd: 'booster', cdHours: 6 },
  can: { label: 'Energy drink', amount: 20, cd: 'booster', cdHours: 2 },
  custom: { label: 'Other energy', amount: 25 },
};
const NERVE_KINDS = {
  refill: { label: 'Nerve refill (points)', fill: true, daily: 'nerve' },
  custom: { label: 'Other nerve', amount: 10 },
};

// One bar's state from the user's API data: { current, maximum, tickAt, fullAt, increment, interval }.
// Missing regen details fall back to Torn's standard rates (energy's interval is worked out from
// when the bar will be full, which also covers donators' faster regen).
function barState(b, kind, now) {
  if (!b || !(b.maximum > 0)) return null;
  const max = b.maximum;
  const cur = Math.max(0, b.current || 0);
  let inc = b.increment > 0 ? b.increment : kind === 'energy' ? 5 : kind === 'nerve' ? 1 : Math.max(1, Math.round(max * 0.05));
  let interval = b.interval > 0 ? b.interval * 1000 : 0;
  if (!interval) {
    interval = (kind === 'energy' ? 15 : 5) * PM_MIN;
    if (kind === 'energy' && cur < max && b.fullAt > b.tickAt && b.tickAt > 0) {
      const ticks = Math.ceil((max - cur) / inc);
      if (ticks > 1) {
        const est = (b.fullAt - b.tickAt) / (ticks - 1);
        interval = Math.abs(est - 10 * PM_MIN) < Math.abs(est - 15 * PM_MIN) ? 10 * PM_MIN : 15 * PM_MIN;
      }
    }
  }
  let nextTick = b.tickAt > 0 ? b.tickAt : now + interval;
  while (nextTick <= now) nextTick += interval;
  return { kind, cur, max, inc, interval, nextTick, wasted: 0, wastedByDay: {}, fullAt: [], points: [[now, cur]] };
}

const copyBar = s => s && { ...s, wastedByDay: { ...s.wastedByDay }, fullAt: [...s.fullAt], points: [] };

// Runs a bar's ticks up to time `to`. Ticks while full are regen lost ("wasted").
function advance(s, to, record = true) {
  if (!s) return;
  while (s.nextTick <= to) {
    if (s.cur < s.max) {
      s.cur = Math.min(s.max, s.cur + s.inc);
      if (record) s.points.push([s.nextTick, s.cur]);
      if (s.cur >= s.max) s.fullAt.push(s.nextTick);
    } else {
      s.wasted += s.inc;
      const k = pmDayKey(s.nextTick);
      s.wastedByDay[k] = (s.wastedByDay[k] || 0) + s.inc;
    }
    s.nextTick += s.interval;
  }
}

// When the bar first holds at least `need` (regen only), or 0 if it never will.
function whenReaches(s, need, limit = 7 * PM_DAY) {
  if (!s) return 0;
  if (s.cur >= need) return s.nextTick - s.interval;
  if (need > s.max) return 0;
  const c = copyBar(s);
  const end = c.nextTick + limit;
  while (c.nextTick <= end) {
    const t = c.nextTick;
    advance(c, t, false);
    if (c.cur >= need) return t;
  }
  return 0;
}

const setBar = (s, t, v) => { if (!s) return; s.cur = Math.max(0, Math.round(v)); s.points.push([t, s.cur]); if (s.cur >= s.max && !s.fullAt.includes(t)) s.fullAt.push(t); };
const snap = bars => Object.fromEntries(Object.entries(bars).map(([k, s]) => [k, s ? { cur: s.cur, max: s.max } : null]));

// Busy windows, { id, from, to, kind: 'flying' | 'abroad' | 'away', name, trip }: no gym or crimes in any of them
// (items are fine, even in the air). name says where you are ("flying to Japan", "in Japan"); trip names the whole trip.
// 'away' = abroad or flying home at a time we can't know (your current trip).
function busyAt(busy, t, kinds) { return busy.find(b => t >= b.from && t < b.to && (!kinds || kinds.includes(b.kind))) || null; }
const busyWord = b => b.name || (b.kind === 'flying' ? 'flying' : b.kind === 'abroad' ? 'abroad' : 'away');

// The plan, projected.
// input: { now, bars: { energy, nerve, life } (user API bars or null), cooldowns: { drug, booster, medical } (end times),
//          refillsUsedToday: { energy, nerve }, items: [plan items], busy: [{ from, to, label, id }], until }
// Returns { results: { id: { before, after, warn: [], info: [], fills } }, bars, cooldowns, summary }.
function simulate(input) {
  const now = input.now;
  const B = input.bars || {};
  const bars = { energy: barState(B.energy, 'energy', now), nerve: barState(B.nerve, 'nerve', now), life: barState(B.life, 'life', now) };
  const cd = { drug: Math.max(now, (input.cooldowns || {}).drug || 0), booster: Math.max(now, (input.cooldowns || {}).booster || 0), medical: Math.max(now, (input.cooldowns || {}).medical || 0) };
  // Cooldown windows over the plan, for the timeline: { drug: [[from, to], ...], ... }.
  const cdSpans = {};
  for (const k of Object.keys(cd)) cdSpans[k] = cd[k] > now ? [[now, cd[k]]] : [];
  const cdSet = (k, from, to) => {
    const sp = cdSpans[k], last = sp[sp.length - 1];
    if (last && from <= last[1]) last[1] = Math.max(last[1], to);
    else sp.push([from, to]);
    cd[k] = to;
  };
  const refills = {}; // "energy|2026-11-18" -> item id
  const today = pmDayKey(now);
  const used = input.refillsUsedToday || {};
  if (used.energy) refills[`energy|${today}`] = 'api';
  if (used.nerve) refills[`nerve|${today}`] = 'api';
  const busy = input.busy || [];
  const results = {};
  const items = (input.items || []).filter(i => i.at >= now).sort((a, b) => a.at - b.at || String(a.id).localeCompare(String(b.id)));
  const all = k => Object.values(bars).forEach(s => advance(s, k));

  for (const it of items) {
    const t = it.at;
    all(t);
    const r = { before: snap(bars), warn: [], info: [] };
    results[it.id] = r;
    const E = bars.energy, N = bars.nerve, L = bars.life;
    const b = busyAt(busy, t);
    if (it.type === 'gym' || it.type === 'crimes') {
      const s = it.type === 'gym' ? E : N;
      const word = it.type === 'gym' ? 'energy' : 'nerve';
      if (b && b.id !== it.id) r.warn.push(`You'll be ${busyWord(b)} then: ${it.type === 'gym' ? 'the gym' : 'crimes'} won't be open to you.`);
      if (!s) { r.info.push(`Add your API key to project your ${word}.`); }
      else {
        const want = it.amount > 0 ? it.amount : s.cur;
        if (it.amount > 0 && s.cur < want) {
          const at = whenReaches(s, want);
          r.warn.push(`Only ${s.cur} ${word} by then, ${want - s.cur} short.${at ? ` You'll have ${want} at ${pmHM(at)}${pmDayKey(at) !== pmDayKey(t) ? ` (${pmDayKey(at).slice(5)})` : ''}.` : want > s.max ? ` That's more than your maximum (${s.max}): add a boost first.` : ''}`);
        }
        if (want <= 0) r.warn.push(`No ${word} to spend then.`);
        const spend = Math.min(s.cur, want);
        r.spent = spend;
        setBar(s, t, s.cur - spend);
      }
    } else if (it.type === 'energy' || it.type === 'nerve') {
      const s = it.type === 'energy' ? E : N;
      const kinds = it.type === 'energy' ? ENERGY_KINDS : NERVE_KINDS;
      const k = kinds[it.kind] || kinds.custom;
      if (k.daily) {
        const key = `${k.daily}|${pmDayKey(t)}`;
        if (refills[key]) r.warn.push(refills[key] === 'api' ? `You've already used today's ${k.daily} refill.` : `That's a second ${k.daily} refill on this day (one per TCT day).`);
        else refills[key] = it.id;
      }
      const cdName = it.cd !== undefined ? it.cd : k.cd || '';
      const cdHours = it.cdHours !== undefined && it.cdHours !== null ? it.cdHours : k.cdHours || 0;
      if (cdName === 'drug' && cd.drug > t) r.warn.push(`Your drug cooldown runs until ${pmHM(cd.drug)}${pmDayKey(cd.drug) !== pmDayKey(t) ? ` (${pmDayKey(cd.drug).slice(5)})` : ''}: no drugs before then.`);
      if (cdName === 'booster' && cd.booster - t >= BOOSTER_CAP_H * PM_HOUR) r.warn.push(`Booster cooldown is full (${Math.round((cd.booster - t) / PM_HOUR)} h) until ${pmHM(cd.booster - BOOSTER_CAP_H * PM_HOUR)}.`);
      if (s) {
        if (k.fill) {
          if (s.cur >= s.max) r.warn.push(`Your ${it.type} is already full then: the ${k.label.toLowerCase()} would be wasted.`);
          else r.info.push(`+${s.max - s.cur} ${it.type}`);
          setBar(s, t, Math.max(s.cur, s.max));
        } else {
          const amt = it.amount > 0 ? it.amount : k.amount || 0;
          setBar(s, t, s.cur + amt);
          r.info.push(`+${amt} ${it.type}`);
        }
      }
      if (cdName && cdHours > 0 && cd[cdName] !== undefined) {
        cdSet(cdName, t, Math.max(cd[cdName], t) + cdHours * PM_HOUR);
        r.info.push(`${cdName} cooldown until ${pmHM(cd[cdName])}${pmDayKey(cd[cdName]) !== pmDayKey(t) ? ` (${pmDayKey(cd[cdName]).slice(5)})` : ''}`);
      }
    } else if (it.type === 'blood') {
      const n = Math.max(1, Math.min(50, it.count || 1));
      if (!L) r.info.push('Add your API key to project your life.');
      else {
        const cost = Math.round(L.max * BLOOD_LIFE);
        const fills = [];
        let at = t;
        for (let i = 0; i < n; i++) {
          // Each fill once life is full again, so no regen is lost.
          if (L.cur < L.max) {
            const full = whenReaches(L, L.max);
            if (!full) break;
            at = Math.max(at, full);
            advance(L, at); // only life: other items in between still see their own moment
          }
          setBar(L, at, L.cur - cost);
          cdSet('medical', at, Math.max(cd.medical, at) + BLOOD_MED_H * PM_HOUR);
          fills.push(at);
        }
        r.fills = fills;
        if (fills.length) {
          r.info.push(`${fills.length} fill${fills.length === 1 ? '' : 's'}, ${fills.length > 1 ? `${pmHM(fills[0])} to ${pmHM(fills[fills.length - 1])}` : pmHM(fills[0])}; −${cost} life each`);
          r.info.push(`medical cooldown until ${pmHM(cd.medical)}${pmDayKey(cd.medical) !== pmDayKey(t) ? ` (${pmDayKey(cd.medical).slice(5)})` : ''}`);
        }
        if (fills.length < n) r.warn.push(`Only ${fills.length} of ${n} fills fit.`);
        const away = fills.map(f => ({ f, w: busyAt(busy, f) })).filter(x => x.w);
        if (away.length) r.warn.push(`${away.length === fills.length ? 'Every fill falls' : `${away.length} fill${away.length === 1 ? '' : 's'} (${away.map(x => pmHM(x.f)).join(', ')}) fall${away.length === 1 ? 's' : ''}`} while you're ${busyWord(away[0].w)}: blood bags are filled at the hospital in Torn.`);
        r.doneAt = fills.length ? fills[fills.length - 1] : t;
      }
    } else if (it.type === 'life') {
      if (L) { setBar(L, t, Math.min(L.cur + (it.amount || 0), Math.max(L.max, L.cur))); r.info.push(`${it.amount >= 0 ? '+' : ''}${it.amount || 0} life`); }
      if (it.cdHours > 0) {
        cdSet('medical', t, Math.max(cd.medical, t) + it.cdHours * PM_HOUR);
        r.info.push(`medical cooldown until ${pmHM(cd.medical)}`);
      }
    } else if (it.type === 'trip') {
      const other = busy.find(x => x.id !== it.id && it.at < x.to && (it.backAt || it.at) > x.from);
      if (other) {
        const span = busy.filter(x => x.id === other.id);
        const from = Math.min(...span.map(x => x.from)), to = Math.max(...span.map(x => x.to));
        r.warn.push(`Overlaps ${other.trip || 'another trip'} (${pmHM(from)}–${pmHM(to)}).`);
      }
    }
    r.after = snap(bars);
  }
  const until = Math.max(input.until || now, now);
  all(until);
  for (const s of Object.values(bars)) if (s) { s.points.push([until, s.cur]); s.points.sort((a, b) => a[0] - b[0]); }
  return { results, bars, cooldowns: cd, cdSpans, until };
}

// A bar's projected value at time t (from the recorded points).
function valueAt(s, t) {
  if (!s) return null;
  let v = s.points.length ? s.points[0][1] : s.cur;
  for (const [pt, pv] of s.points) { if (pt <= t) v = pv; else break; }
  return v;
}

// Points for one day of a bar, as % of its maximum (one axis for all bars), as steps.
function dayPoints(s, from, to) {
  if (!s || !s.max) return [];
  const pct = v => Math.round((v / s.max) * 1000) / 10;
  const out = [[from, pct(valueAt(s, from))]];
  for (const [t, v] of s.points) if (t > from && t < to) out.push([t, pct(v)]);
  out.push([to, pct(valueAt(s, to))]);
  return out;
}

if (typeof module !== 'undefined') {
  module.exports = { PM_MIN, PM_HOUR, PM_DAY, ENERGY_KINDS, NERVE_KINDS, BLOOD_LIFE, BLOOD_MED_H, BOOSTER_CAP_H, pmDayStart, pmDayKey, pmHM, barState, advance, whenReaches, simulate, valueAt, dayPoints };
}
