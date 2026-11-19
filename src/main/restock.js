'use strict';
// Restock analysis for abroad shop stock, from YATA readings recorded on this PC.
//
// History format per item: runs of equal readings, [firstSeenMs, quantity, lastSeenMs].
// (Older two-element samples [t, q] are read as runs of length one.)
//
// From the runs we measure, per item:
// - restock events: the quantity rose between two readings, so the restock happened in the
//   window [last reading before, first reading after]
// - sell-out events and how long stock lasts after a restock
// - the restock rhythm (cadence): a period P that puts every observed restock window on the
//   same beat. Missed restocks are fine (their gaps are multiples of P).
// Every item in every country has its own restock timer (the user, 2026-11-18), so an item is only
// predicted from its own restocks. Measured on 38 h of real readings (2026-11-18): the timer starts
// when the item SELLS OUT. 63 of 65 items restocked a near-fixed delay after selling out (Cherry
// Blossom 54.9 ± 1.1 min, Pangolin Scales 30.1 ± 0.2 min), while the time from one restock to the
// next varied by hours. So, in order:
// - sell-out timer: restock = when it sold out + the item's own delay. Sold out now: we know when,
//   so this is tight. In stock: when it will sell out comes from how fast it sells, so looser.
// Items that never sell out (always topped up) fall back to:
// - a fixed beat (period + phase) that its restocks line up on, accepted only if the readings
//   agree: YATA is read every ~2 minutes, so a beat where the stock plainly didn't rise counts
//   against it (this stops a short period that happens to fit a handful of restocks);
// - otherwise its typical gap between restocks (timers that drift: "about every 2 h"), with the
//   spread of those gaps as the margin.
// The country's pooled rhythm is still worked out, for the overview only.

const MIN = 60000;
const TOL = 2 * MIN;           // timing slack when checking a restock against a beat
const RATE_WINDOW = 6 * 3600 * 1000;

const median = xs => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

const runOf = s => [s[0], s[1], s[2] === undefined ? s[0] : s[2]];

// Adds one reading to an item's runs. Returns true if anything changed.
function addReading(runs, t, q) {
  const last = runs[runs.length - 1];
  if (last && t <= (last[2] ?? last[0])) return false;
  if (last && last[1] === q) { last[2] = t; return true; }
  runs.push([t, q, t]);
  return true;
}

function analyzeItem(raw, now) {
  const runs = raw.map(runOf);
  const out = {
    readings: runs.length, rate: null, restocks: [], soldOuts: [], size: null, stay: null, staysInStock: false,
    emptyFor: null, zeroSince: null, lastPositive: null, minuteHist: null, lastSeen: runs.length ? runs[runs.length - 1][2] : 0,
  };
  if (!runs.length) return out;

  // Sell rate while in stock (units/min), last few hours.
  let sold = 0, span = 0;
  for (let i = 1; i < runs.length; i++) {
    const [, q0, e0] = runs[i - 1];
    const [s1, q1] = runs[i];
    if (now - s1 > RATE_WINDOW || q0 <= 0 || q1 > q0) continue;
    sold += q0 - q1;
    span += s1 - runs[i - 1][0];
  }
  if (span >= 20 * MIN) out.rate = sold / (span / MIN);

  const restocks = [], soldOuts = [];
  for (let i = 1; i < runs.length; i++) {
    const [, q0, e0] = runs[i - 1];
    const [s1, q1] = runs[i];
    if (q1 > q0) restocks.push({ from: e0, to: s1, before: q0, after: q1 });
    if (q0 > 0 && q1 === 0) soldOuts.push({ from: e0, to: s1 });
  }
  const mid = w => (w.from + w.to) / 2;
  out.restockTotal = restocks.length;
  out.restocks = restocks.slice(-60);
  out.soldOuts = soldOuts.slice(-60);
  out.size = median(restocks.map(r => r.after));

  // How long stock lasts after a restock, and how long it then stays empty.
  const stays = [], empties = [];
  let keptStock = 0;
  for (const r of restocks) {
    const so = soldOuts.find(s => s.from >= r.to);
    const next = restocks.find(x => x.from >= r.to && x !== r);
    if (so && (!next || mid(so) < mid(next))) {
      stays.push(mid(so) - mid(r));
      if (next) empties.push(mid(next) - mid(so));
    } else if (next) keptStock++;
  }
  out.stay = median(stays);
  out.staysInStock = keptStock > stays.length; // usually still in stock at the next restock
  out.emptyFor = median(empties);

  // Minute of the hour (TCT) for restocks pinned down to a 10-minute window.
  const hist = new Array(12).fill(0);
  let pinned = 0;
  for (const r of restocks) {
    if (r.to - r.from > 10 * MIN) continue;
    hist[Math.floor(new Date(mid(r)).getUTCMinutes() / 5)]++;
    pinned++;
  }
  if (pinned) out.minuteHist = hist;

  const last = runs[runs.length - 1];
  if (last[1] === 0) {
    out.zeroSince = last[0];
    if (runs.length > 1) out.lastPositive = runs[runs.length - 2][2];
  }
  return out;
}

// Finds a period P that puts the restock windows on one beat.
// events: [{ from, to }] - each restock happened somewhere inside its window.
// For every candidate P, each window allows a range of beat timings (phases); a sweep finds
// the phase that the most windows agree on. The longest P that (a) fits >= 85% of windows
// and (b) fits clearly better than chance is chosen, so a 30-min rhythm isn't reported as 15
// and wide windows don't make a short period "fit" everything.
const mod = (x, p) => ((x % p) + p) % p;
function fitCadence(events, check = null) {
  const ev = events.filter(e => e.to >= e.from).sort((a, b) => a.from - b.from);
  // Merge overlapping windows (several items restocking at the same moment), then keep the
  // most recent 60 restock moments.
  const all = [];
  for (const e of ev) {
    const last = all[all.length - 1];
    if (last && e.from <= last.to) {
      const from = Math.max(last.from, e.from), to = Math.min(last.to, e.to);
      if (to >= from) { last.from = from; last.to = to; }
      continue;
    }
    all.push({ from: e.from, to: e.to });
  }
  const merged = all.slice(-60);
  const n = merged.length;
  if (n < 2) return null;
  const t0 = merged[0].from;
  // Two consecutive restocks can't be further apart than the outer edges of their windows.
  let maxP = Infinity;
  for (let i = 1; i < n; i++) maxP = Math.min(maxP, merged[i].to - merged[i - 1].from);
  maxP = Math.min(maxP + TOL, 3 * 3600 * 1000);
  const STEP = MIN / 4;

  for (let P = Math.floor(maxP / STEP) * STEP; P >= 5 * MIN; P -= STEP) {
    const pts = [];
    let always = 0, chance = 0;
    for (const e of merged) {
      const lo = e.from - TOL - t0, hi = e.to + TOL - t0;
      chance += Math.min(1, (hi - lo) / P);
      if (hi - lo >= P) { always++; continue; }
      const a = mod(lo, P), b = mod(hi, P);
      if (a <= b) pts.push([a, 1], [b, -1]);
      else pts.push([a, 1], [P, -1], [0, 1], [b, -1]);
    }
    pts.sort((x, y) => x[0] - y[0] || y[1] - x[1]);
    let cur = 0, best = 0, bStart = 0, bEnd = 0, open = false;
    for (const [pos, d] of pts) {
      if (d > 0) {
        cur++;
        if (cur > best) { best = cur; bStart = pos; open = true; }
      } else {
        if (open && cur === best) { bEnd = pos; open = false; }
        cur--;
      }
    }
    if (!pts.length) { bStart = 0; bEnd = P; }
    const fit = best + always;
    const share = fit / n;
    if (fit < 2 || share < 0.85 || share - chance / n < 0.25) continue;
    const phase = (bStart + bEnd) / 2;
    if (check && !check(P, t0 + phase)) continue; // the readings show no restock at too many of its beats
    const lastMid = (merged[n - 1].from + merged[n - 1].to) / 2;
    const k = Math.round((lastMid - t0 - phase) / P);
    const unc = Math.max(MIN / 2, (bEnd - bStart) / 2);
    return {
      period: P,
      anchor: t0 + phase + k * P,
      uncertainty: Math.min(10 * MIN, unc),
      events: fit,
      share,
      confidence: fit >= 6 && share >= 0.9 && unc <= 3 * MIN ? 'high' : fit >= 3 ? 'medium' : 'low',
    };
  }
  return null;
}

// Predicted restock times after `from`, up to `horizon` ms ahead.
function nextRestocks(cad, from, horizon = 8 * 3600 * 1000) {
  if (!cad) return [];
  const out = [];
  let k = Math.ceil((from - cad.anchor) / cad.period);
  if (cad.kind === 'sellout' && k < 0) k = 0; // nothing before the next restock
  for (let t = cad.anchor + k * cad.period; t <= from + horizon; k++, t = cad.anchor + k * cad.period) out.push(t);
  return out;
}

// The sell-out timer: restock = sell-out + the item's delay (see the top of this file).
// Returns a cadence whose anchor is the next restock (nothing before it), period = one full cycle
// (time stock usually lasts + the delay), or null when there's too little to go on.
function selloutCadence(runs, a, now) {
  if (runs.length < 3) return null;
  const ev = [];
  for (let i = 1; i < runs.length; i++) {
    const e0 = runs[i - 1][2], s1 = runs[i][0];
    if (s1 - e0 > 10 * MIN) continue; // only moments pinned down to a few minutes
    const t = (e0 + s1) / 2;
    if (runs[i][1] > runs[i - 1][1]) ev.push({ t, k: 'r', from0: runs[i - 1][1] === 0 });
    if (runs[i - 1][1] > 0 && runs[i][1] === 0) ev.push({ t, k: 's' });
  }
  const delays = [];
  let lastS = null, lastR = null;
  for (const e of ev) {
    if (e.k === 's') { lastS = e.t; continue; }
    if (e.from0 && lastS !== null && (lastR === null || lastS > lastR)) delays.push(e.t - lastS);
    lastR = e.t;
    lastS = null;
  }
  if (delays.length < 3) return null;
  const D = median(delays);
  const spread = median(delays.map(d => Math.abs(d - D)));
  if (D < 2 * MIN || spread > D * 0.5) return null; // not a timer
  a.selloutDelay = { delay: D, spread, events: delays.length }; // kept for the page even when it can't predict now
  const last = runs[runs.length - 1];
  const drain = a.size && a.stay ? a.size / (a.stay / MIN) : a.rate; // units per minute while in stock
  let next, unc = Math.max(MIN, spread * 1.5 + MIN), soldOut = last[1] === 0;
  if (soldOut) {
    const prev = runs[runs.length - 2];
    if (last[0] - prev[2] > 10 * MIN) return null; // don't know when it sold out
    next = (prev[2] + last[0]) / 2 + D;
    if (now > next + 3 * unc + 10 * MIN) return null; // long overdue: the timer isn't behaving
  } else {
    if (!drain) return null;
    const toOut = (last[1] / drain) * MIN;
    next = last[2] + toOut + D;
    unc += toOut * 0.3; // how fast it sells varies
  }
  const lasts = a.stay || (a.size && drain ? (a.size / drain) * MIN : D);
  return {
    kind: 'sellout', anchor: next, period: lasts + D, uncertainty: Math.min(unc, 60 * MIN), delay: D, delaySpread: spread,
    events: delays.length, share: 1, soldOut,
    confidence: soldOut ? (delays.length >= 5 && spread <= 3 * MIN ? 'high' : spread <= 8 * MIN ? 'medium' : 'low') : unc <= 10 * MIN ? 'medium' : 'low',
  };
}

// Do the readings agree with a beat? For each beat inside the readings, look at the readings
// around it: a rise there is a hit; readings on both sides close together with no rise are a miss
// (a restock would have shown, unless the stock was already about full). Accept when at least 60%
// of the beats that could be checked were hits.
function beatsAgree(runs, a, P, anchor) {
  if (runs.length < 2) return true;
  // Only the item's latest restocks are kept: check beats from the oldest of those on.
  const start = a.restockTotal > a.restocks.length ? a.restocks[0].from : runs[0][0];
  const end = runs[runs.length - 1][2];
  const full = a.size ? a.size * 0.9 : Infinity;
  let k = Math.ceil((start - anchor) / P), checked = 0, hits = 0, i = 0;
  for (let B = anchor + k * P; B <= end; k++, B = anchor + k * P) {
    while (i < runs.length - 1 && runs[i + 1][0] <= B - TOL) i++;
    const lo = B - TOL, hi = B + TOL;
    if (a.restocks.some(r => r.to >= lo && r.from <= hi)) { checked++; hits++; continue; }
    // The run holding the moment just before the beat, and the next reading after it.
    const run = runs[i];
    const next = runs[i + 1];
    if (!run || run[0] > lo) continue;
    if (run[1] >= full) continue; // already about full: a restock might not show
    const afterAt = run[2] >= hi ? hi : next ? next[0] : Infinity;
    if (afterAt - Math.min(run[2], lo) > 6 * MIN && run[2] < hi) continue; // a gap in the readings
    checked++;
  }
  return checked < 4 || hits / checked >= 0.6;
}

// A timer that drifts: its typical gap between restocks. Long gaps that are about whole
// multiples of the typical one count as missed restocks. The margin is the spread of the gaps.
function intervalCadence(restocks, now) {
  const mids = restocks.map(r => (r.from + r.to) / 2).sort((x, y) => x - y);
  if (mids.length < 3) return null;
  const gaps = [];
  for (let i = 1; i < mids.length; i++) gaps.push(mids[i] - mids[i - 1]);
  const base = median(gaps);
  if (!base || base < 5 * MIN) return null;
  const norm = gaps.map(g => g / Math.max(1, Math.round(g / base)));
  const period = median(norm);
  const spread = median(norm.map(g => Math.abs(g - period))) || MIN;
  const uncertainty = Math.max(2 * MIN, Math.min(30 * MIN, spread * 1.5));
  const anchor = mids[mids.length - 1];
  // A timer this loose can't be stretched far: no prediction once three beats have gone unseen.
  if (now - anchor > 3 * period + uncertainty) return null;
  return {
    period, anchor, uncertainty, events: mids.length, share: 1, kind: 'interval',
    confidence: mids.length >= 6 && uncertainty <= 5 * MIN ? 'medium' : 'low',
  };
}

// Full analysis for one country: items -> runs. Returns per-item stats with a cadence
// (the item's own if it has one, else the country's) and upcoming restock times.
function analyzeCountry(items, now) {
  const stats = {};
  const pooled = [];
  for (const [id, runs] of Object.entries(items)) {
    const a = analyzeItem(runs, now);
    stats[id] = a;
    pooled.push(...a.restocks);
  }
  const countryCad = fitCadence(pooled);
  for (const [id, a] of Object.entries(stats)) {
    const runs = items[id].map(runOf);
    let own = selloutCadence(runs, a, now);
    if (!own && a.restocks.length >= 3) {
      own = fitCadence(a.restocks, (P, anchor) => beatsAgree(runs, a, P, anchor));
      if (own) own.kind = 'beat';
      else own = intervalCadence(a.restocks, now);
    }
    a.cadence = own ? { ...own, source: 'item' } : null;
    a.next = nextRestocks(a.cadence, now - (a.cadence ? a.cadence.uncertainty : 0)).slice(0, 12);
    a.restockCount = a.restockTotal;
    // Keep the snapshot sent to the UI small.
    a.restocks = a.restocks.slice(-12);
    a.soldOuts = a.soldOuts.slice(-12);
  }
  return { stats, cadence: countryCad, pooledRestocks: pooled.length };
}

module.exports = { addReading, analyzeItem, fitCadence, nextRestocks, analyzeCountry, median, beatsAgree, intervalCadence, selloutCadence };
