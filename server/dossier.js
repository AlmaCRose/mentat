'use strict';
// Member dossiers for the shared war page (the user's request, 2026-11-24): one file per member of
// both factions, from the intelligence report's member model (src/ui/intel.js irModel: threat,
// role, war record, chains, momentum, commitment), the research record (war-by-war hits, personal
// stats, Mentat's activity checks) and FFScouter (estimate, growth, activity by 15 minutes).

const sum = xs => xs.reduce((a, b) => a + (Number.isFinite(b) ? b : 0), 0);
const r2 = x => (Number.isFinite(x) ? Math.round(x * 100) / 100 : null);
const PS_KEYS = ['xanax', 'refills', 'ses', 'cans', 'boosters', 'attacksWon', 'attacksLost', 'defendsWon', 'defendsLost', 'elo', 'rwHits', 'respect', 'bestDamage', 'killstreak', 'reviveSkill', 'revives', 'activity', 'streak', 'networth', 'rwWins'];

// Share of time active in each hour of the day (TCT): FFScouter's 15-minute readings first, else
// Mentat's own checks (hour of the week, folded into hours of the day).
function hoursOfDay(ffsMember, own, observed) {
  const by96 = (m, from) => ({ from, h: Array.from({ length: 24 }, (_, h) => { let a = 0, o = 0; for (let s = h * 4; s < h * 4 + 4; s++) { a += m.act[s] || 0; o += (m.obs && m.obs[s]) || 0; } return o ? r2(a / o) : null; }) });
  if (ffsMember && Array.isArray(ffsMember.act) && sum(ffsMember.obs || []) > 0) return by96(ffsMember, 'f');
  // Mentat's activity history (the server's checks, scouting included): 15-minute slots over days
  if (observed && Array.isArray(observed.act) && sum(observed.obs || []) > 0) return by96(observed, 'o');
  if (own && Array.isArray(own.samples) && sum(own.samples) > 0) {
    return { from: 'm', h: Array.from({ length: 24 }, (_, h) => { let a = 0, o = 0; for (let d = 0; d < 7; d++) { a += (own.active && own.active[d * 24 + h]) || 0; o += own.samples[d * 24 + h] || 0; } return o ? r2(a / o) : null; }) };
  }
  return null;
}

// rec: research record; M: irModel result for it; ffs: FFScouter intel shared for it (or null);
// asOf: personal stats up to this moment.
function buildDossiers({ rec, M, ffs = null, asOf = Date.now() }) {
  const wars = ((rec.record && rec.record.wars) || []).filter(w => !w.pending && w.us && w.end && w.end <= asOf);
  const byId = new Map((M.members || []).map(m => [Number(m.id), m]));
  const commitWars = M.commitWars || [];
  return Object.values(rec.members || {}).map(raw => {
    const id = Number(raw.id);
    const m = byId.get(id) || {};
    const list = ((rec.personal && rec.personal[id]) || []).filter(x => x.at <= asOf);
    const last = list[list.length - 1];
    const first = last && list.find(x => last.at - x.at >= 20 * 3600e3) ? list[0] : null;
    const pace = {};
    if (first && last && first !== last) {
      const days = (last.at - first.at) / 86400e3;
      for (const k of ['xanax', 'refills', 'ses', 'cans', 'attacksWon', 'rwHits', 'revives', 'activity']) {
        if (Number.isFinite(last.s[k]) && Number.isFinite(first.s[k])) pace[k] = r2((last.s[k] - first.s[k]) / days);
      }
    }
    const warList = wars.map(w => {
      const row = (w.members || []).find(x => x[0] === id);
      if (!row) return null;
      return { end: w.end, opp: (w.opp && w.opp.name) || '?', won: !!w.winner && w.winner === rec.id, decided: !!w.winner, hits: row[3] || 0, score: r2(row[4] || 0) };
    }).filter(Boolean);
    const c = m.chain || null;
    return {
      id, name: raw.name, level: raw.level, position: raw.position || '', days: raw.days || 0, revivable: !!raw.revivable,
      status: raw.description || raw.state || '', last: raw.last || '', lastAt: raw.lastAt || 0,
      est: m.est || null, growth10: r2(m.growth10), growth4: r2(m.growth4),
      threat: r2(m.threat), role: m.role || '', eligible: m.eligible || 0, active: m.active || 0,
      participation: r2(m.participation), avgWar: r2(m.avgWar), avgActive: r2(m.avgActive), peak: m.peak || 0,
      avgWin: r2(m.avgWin), avgLoss: r2(m.avgLoss), hits: m.hits || 0, score: r2(m.score), share: r2(m.share), perHit: r2(m.perHit),
      consistency: r2(m.consistency), trend: m.trend || '', sitOuts: m.sitOuts || 0,
      chain: c ? Object.fromEntries(Object.entries(c).map(([k, v]) => [k, r2(v)])) : null,
      momentum: m.momentum ? Object.fromEntries(Object.entries(m.momentum).map(([k, v]) => [k, typeof v === 'number' ? r2(v) : v])) : null,
      commit: m.commit ? commitWars.map(w => ({ opp: w.opp, end: w.end, ...(m.commit[w.id] || {}) })).filter(x => x.xan != null || x.hours != null) : [],
      usual: (m.activity && m.activity.usual) || '',
      hours: hoursOfDay(ffs && ffs.members && ffs.members[id], rec.activity && rec.activity[id], rec.observed && rec.observed.members && rec.observed.members[id]),
      wars: warList,
      prior: (m.prior || []).map(p => ({ faction: p.factionName, opp: p.opp, end: p.end, hits: p.attacks })),
      ps: last ? Object.fromEntries(PS_KEYS.filter(k => Number.isFinite(last.s[k])).map(k => [k, last.s[k]])) : null,
      psAt: last ? last.at : 0, pace,
    };
  }).sort((a, b) => (b.threat || 0) - (a.threat || 0) || (b.est || 0) - (a.est || 0));
}

module.exports = { buildDossiers };
