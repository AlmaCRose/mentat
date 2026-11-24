'use strict';
// Us vs them for the shared war report page's Comparison tab (the user's request, 2026-11-24).
// From the server's own Oppo Research records (Torn API: basics, members, ranked wars, chains,
// personal stats) plus what a Mentat device with FFScouter Premium shared (the server has no
// FFScouter key): activity by hour of the week, estimated battle stats, members' usual hours.
// Activity: FFScouter first; the server's own 5-minute checks only fill hours FFScouter lacks.

const DAY = 86400e3;
const median = xs => { const s = xs.filter(x => Number.isFinite(x)).sort((a, b) => a - b); if (!s.length) return null; const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const sum = xs => xs.reduce((a, b) => a + (Number.isFinite(b) ? b : 0), 0);
const top5 = xs => { const s = xs.filter(Number.isFinite).sort((a, b) => b - a).slice(0, 5); return s.length ? sum(s) / s.length : null; };

const BS_BUCKETS = [[1e10, '10b+'], [1e9, '1b–10b'], [1e8, '100m–1b'], [1e7, '10m–100m'], [1e6, '1m–10m'], [1e5, '100k–1m'], [1e4, '10k–100k'], [0, 'under 10k']];
const LVL_BUCKETS = [[80, '80–100'], [60, '60–79'], [40, '40–59'], [20, '20–39'], [0, '1–19']];
const bucket = (list, buckets) => buckets.map(([min], i) => list.filter(v => v >= min && (i === 0 || v < buckets[i - 1][0])).length);
const PS = [['xanax', 'Xanax taken'], ['refills', 'Energy refills'], ['ses', 'Stat enhancers used'], ['attacksWon', 'Attacks won'], ['defendsWon', 'Defends won'], ['elo', 'Elo rating'],
  ['rwHits', 'Ranked war hits'], ['revives', 'Revives given'], ['activity', 'Time played'], ['networth', 'Net worth']];

function latestPersonal(rec, id, asOf) {
  const list = ((rec.personal && rec.personal[id]) || []).filter(x => x.at <= asOf);
  if (!list.length) return null;
  const last = list[list.length - 1];
  const first = list.find(x => last.at - x.at >= 20 * 3600e3) ? list[0] : null;
  let xanPace = null;
  if (first && first !== last && Number.isFinite(last.s.xanax) && Number.isFinite(first.s.xanax)) xanPace = (last.s.xanax - first.s.xanax) / ((last.at - first.at) / DAY);
  return { s: last.s, xanPace };
}

// 168 hours (UTC getDay()*24 + hour): average members active, and where each hour came from:
// 'f' FFScouter's scanner; 'o' Mentat's activity history (rec.observed: the server's checks of
// these players, scouting included, so weeks of it before research even starts); 'm' the research
// checks since research started. First that has the hour wins.
function weekCells(rec, shared) {
  const week = shared && Array.isArray(shared.week) ? shared.week : null;
  const ow = rec.observed && rec.observed.week;
  const f = rec.factionHours || { samples: [], active: [] };
  const n = Math.max(1, Object.keys(rec.members || {}).length);
  return Array.from({ length: 168 }, (_, i) => {
    const w = week && week[i];
    if (w && w[1] > 0) return [Math.round((w[0] / w[1]) * 10) / 10, 'f'];
    if (ow && ow.obs && ow.obs[i]) return [Math.round(((ow.act[i] / ow.obs[i]) * n) * 10) / 10, 'o'];
    if (f.samples[i]) return [Math.round(((f.active[i] / f.samples[i]) * n) * 10) / 10, 'm'];
    return null;
  });
}

// One member's 96 quarter-hours of the day from Mentat's activity history, as { act, obs }.
const observedOf = (rec, id) => (rec.observed && rec.observed.members && rec.observed.members[id]) || null;
// Busiest 3 hours from 96 quarter-hour counts (act/obs share)
function usualFrom96(m) {
  if (!m || !Array.isArray(m.act) || sum(m.obs || []) < 8) return null;
  const by = Array.from({ length: 24 }, (_, h) => { let a = 0, o = 0; for (let s = h * 4; s < h * 4 + 4; s++) { a += m.act[s] || 0; o += m.obs[s] || 0; } return o ? a / o : 0; });
  const total = sum(by);
  if (!total) return null;
  let best = 0, at = 0;
  for (let h = 0; h < 24; h++) { const v = by[h] + by[(h + 1) % 24] + by[(h + 2) % 24]; if (v > best) { best = v; at = h; } }
  return [at, (at + 3) % 24, Math.round((best / total) * 100) / 100];
}

// Busiest 3-hour window from Mentat's own per-member activity, if FFScouter didn't give one.
function ownUsualHours(a) {
  if (!a) return null;
  const by = new Array(24).fill(0);
  for (let i = 0; i < 168; i++) by[i % 24] += ((a.actions && a.actions[i]) || 0) + ((a.active && a.active[i]) || 0);
  const total = sum(by);
  if (total < 3) return null;
  let best = 0, at = 0;
  for (let h = 0; h < 24; h++) { const v = by[h] + by[(h + 1) % 24] + by[(h + 2) % 24]; if (v > best) { best = v; at = h; } }
  return [at, (at + 3) % 24, Math.round((best / total) * 100) / 100];
}

function side(rec, shared, now) {
  const members = Object.values(rec.members || {});
  const b = rec.basic || {};
  const stats = (shared && shared.stats) || {};
  const bsOf = m => Number(stats[m.id]) || 0;
  const bs = members.map(bsOf).filter(Boolean);
  // now = the moment the comparison describes (the war's start for a rebuilt one): personal stats,
  // past wars and chains only count what had happened by then.
  const ps = members.map(m => latestPersonal(rec, m.id, now)).filter(Boolean);
  const col = k => ps.map(p => p.s[k]).filter(Number.isFinite);
  const wars = ((rec.history && rec.history.wars) || []).filter(w => w.end && w.end <= now);
  const chains30 = ((rec.history && rec.history.chains) || []).filter(c => c.end && c.end <= now && now - c.end < 30 * DAY);
  const cells = weekCells(rec, shared);
  const uh = (shared && shared.uh) || {};
  return {
    id: rec.id, name: (b.name || rec.name || `Faction ${rec.id}`), tag: b.tag || '',
    members: members.length, capacity: b.capacity || 0, respect: b.respect || 0, rank: b.rank || '', bestChain: b.bestChain || 0, daysOld: b.daysOld || 0,
    wins: wars.filter(w => w.winner === rec.id).length, losses: wars.filter(w => w.winner && w.winner !== rec.id).length,
    chains30: chains30.length, longest30: Math.max(0, ...chains30.map(c => c.length || 0)), respect30: Math.round(sum(chains30.map(c => c.respect || 0))),
    levelMedian: median(members.map(m => m.level)), levels: bucket(members.map(m => m.level || 0), LVL_BUCKETS),
    inactive: members.filter(m => m.lastAt && m.lastAt <= now && now - m.lastAt > 3 * DAY).length,
    revivers: ps.filter(p => (p.s.reviveSkill || 0) >= 50 || (p.s.revives || 0) >= 500).length,
    bs: bs.length ? { total: sum(bs), median: median(bs), top5: top5(bs), known: bs.length, buckets: bucket(bs, BS_BUCKETS) } : null,
    ps: Object.fromEntries(PS.map(([k]) => [k, median(col(k))])), psKnown: ps.length,
    xanPace: median(ps.map(p => p.xanPace)),
    activity: cells,
    activityFrom: { ffsDays: (shared && shared.days) || 0, ffsHours: cells.filter(c => c && c[1] === 'f').length, obsDays: (rec.observed && rec.observed.days) || 0, obsHours: cells.filter(c => c && c[1] === 'o').length, ownHours: cells.filter(c => c && c[1] === 'm').length },
    // Every member, like the Research tab's member dossiers
    dossier: members.map(m => {
      const p = latestPersonal(rec, m.id, now);
      const s = (p && p.s) || {};
      const a = rec.activity && rec.activity[m.id];
      return {
        id: m.id, name: m.name, level: m.level, position: m.position || '', bs: bsOf(m) || null,
        uh: (Array.isArray(uh[m.id]) && uh[m.id]) || usualFrom96(observedOf(rec, m.id)) || ownUsualHours(a),
        online: (o => (o && sum(o.obs) ? Math.round((sum(o.act) / sum(o.obs)) * 100) / 100 : a && sum(a.samples || []) ? Math.round((sum(a.active || []) / sum(a.samples)) * 100) / 100 : null))(observedOf(rec, m.id)),
        lastAt: m.lastAt || 0, xanax: s.xanax, xanPace: p && p.xanPace != null ? Math.round(p.xanPace * 10) / 10 : null,
        refills: s.refills, elo: s.elo, rwHits: s.rwHits, revives: s.revives, streak: s.streak,
      };
    }).sort((x, y) => (y.bs || 0) - (x.bs || 0) || y.level - x.level),
    // Strongest members by FFScouter's estimate, with their usual hours (FFScouter's activity, else ours)
    top: members.filter(m => bsOf(m)).sort((x, y) => bsOf(y) - bsOf(x)).slice(0, 10).map(m => ({
      id: m.id, name: m.name, level: m.level, bs: bsOf(m), position: m.position || '',
      uh: (Array.isArray(uh[m.id]) && uh[m.id]) || usualFrom96(observedOf(rec, m.id)) || ownUsualHours(rec.activity && rec.activity[m.id]),
      uhFrom: Array.isArray(uh[m.id]) ? 'f' : 'm',
    })),
  };
}

// them/us: research records. shared: { [factionId]: FFScouter summary } from a device.
// asOf: rebuild for an earlier moment (the war's start) from what was collected by then. Only
// personal stats, past wars and chains have history; members, faction details, activity and
// FFScouter estimates are as they are now, and the result says so (rebuilt: true).
function buildComparison({ them, us, shared = {}, now = Date.now(), asOf = 0 }) {
  if (!them || !us) return null;
  const made = now;
  if (asOf && asOf < now) now = asOf;
  const T = side(them, shared[them.id], now), U = side(us, shared[us.id], now);
  // Peak and quiet hours for them; our best hours = where we out-number them by the most.
  const hours = T.activity.map((c, i) => ({ i, t: c ? c[0] : null, u: U.activity[i] ? U.activity[i][0] : null }));
  const known = hours.filter(h => h.t != null);
  const peak = [...known].sort((a, b) => b.t - a.t).slice(0, 5).map(h => [h.i, h.t]);
  const quiet = [...known].sort((a, b) => a.t - b.t).slice(0, 5).map(h => [h.i, h.t]);
  const edge = known.filter(h => h.u != null).map(h => [h.i, Math.round((h.u - h.t) * 10) / 10, h.u, h.t]).sort((a, b) => b[1] - a[1]).slice(0, 5);
  const ffsAt = Math.max((shared[them.id] && shared[them.id].at) || 0, (shared[us.id] && shared[us.id].at) || 0);
  return {
    at: made, asOf: now, rebuilt: now < made, them: T, us: U, peak, quiet, edge, ffsAt,
    bsBuckets: BS_BUCKETS.map(b => b[1]), lvlBuckets: LVL_BUCKETS.map(b => b[1]), psRows: PS,
  };
}

module.exports = { buildComparison };
