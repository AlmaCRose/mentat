'use strict';
/* global S, esc, num, link, profileUrl, fmtAgo, prefs, cmd */
// War intelligence report: an opponent's last 10 ranked wars, each member's war record,
// chain breakdown, momentum (stat snapshots from past dates), commitment during wars,
// activity history (your server's checks and FFScouter's), and a threat model on top.
// One model feeds the screen, the PDF, the interactive .html and the .csv.

const IR_DAY = 86400e3;
const IR_BLOCKS = ['00–02', '02–04', '04–06', '06–08', '08–10', '10–12', '12–14', '14–16', '16–18', '18–20', '20–22', '22–24'];
const IR_DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const IR_DOW = [1, 2, 3, 4, 5, 6, 0];
// Chain attacker columns (main/warchive.js CHAIN_COLS, after the id).
const IR_CH = { respect: 1, best: 2, total: 3, war: 4, hosp: 5, leave: 6, mug: 7, assists: 8, retals: 9, overseas: 10, draws: 11, escapes: 12, losses: 13, bonuses: 14 };

const irSum = xs => xs.reduce((a, b) => a + (Number.isFinite(b) ? b : 0), 0);
const irMean = xs => { const v = xs.filter(Number.isFinite); return v.length ? irSum(v) / v.length : null; };
const irMedian = xs => { const s = xs.filter(Number.isFinite).sort((a, b) => a - b); if (!s.length) return null; const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const irClamp = (x, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, x));
const irCompact = n => {
  if (n == null || !Number.isFinite(n)) return '–';
  const a = Math.abs(n);
  if (a >= 1e12) return `${(n / 1e12).toFixed(2)}t`;
  if (a >= 1e9) return `${(n / 1e9).toFixed(2)}b`;
  if (a >= 1e6) return `${(n / 1e6).toFixed(2)}m`;
  if (a >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return String(Math.round(n));
};
const irF = (x, d = 1) => (x == null || !Number.isFinite(x) ? '–' : x.toFixed(d));
const irP = (x, d = 1) => (x == null || !Number.isFinite(x) ? '–' : `${(x * 100).toFixed(d)}%`);
const irSP = (x, d = 0) => (x == null || !Number.isFinite(x) ? '–' : `${x >= 0 ? '+' : ''}${(x * 100).toFixed(d)}%`);
const irDate = ms => (ms ? new Date(ms).toISOString().slice(0, 10) : '–');
const irTct = ms => `${new Date(ms).toISOString().slice(0, 16).replace('T', ' ')} TCT`;
const irSlotTime = s => `${String(Math.floor(((s % 96) + 96) % 96 / 4)).padStart(2, '0')}:${String((((s % 96) + 96) % 96 % 4) * 15).padStart(2, '0')}`;

// ---------------------------------------------------------------- model
// c: { rec (opponent research record), us (your faction's record or null), stats (FFScouter
//      estimates by id), ffs (FFScouter intel for this faction or null), snapStats, now, by }
function irModel(c) {
  const { rec, stats = {}, ffs = null, snapStats = [], now = Date.now() } = c;
  const record = rec.record || { wars: [], chains: {}, prior: {} };
  const wars = (record.wars || []).filter(w => !w.pending && w.us);
  const pendingWars = (record.wars || []).length - wars.length;
  const roster = Object.values(rec.members || {});
  const current = new Set(roster.map(m => Number(m.id)));

  // ---- Wars ----
  const warRows = wars.map((w, i) => {
    const hrs = Math.max(0.1, (w.end - w.start) / 3600e3);
    const won = !!w.winner && w.winner === rec.id;
    const hits = w.us.attacks || 0;
    const chains = (w.chains || []).map(id => record.chains[id]).filter(Boolean);
    return {
      n: i + 1, id: w.id, opp: (w.opp && w.opp.name) || '?', oppId: w.opp && w.opp.id, start: w.start, end: w.end, hrs, won,
      result: !w.winner ? '–' : won ? 'Win' : 'Loss', forfeit: !!w.forfeit, hits, perHour: hits / hrs, energy: hits * 25,
      score: w.us.score || 0, oppScore: (w.opp && w.opp.score) || 0, oppHits: (w.opp && w.opp.attacks) || 0,
      rankBefore: w.us.rankBefore || '', rankAfter: w.us.rankAfter || '', oppRank: (w.opp && w.opp.rankBefore) || '',
      hitters: (w.members || []).filter(m => m[3] > 0).length, inReport: (w.members || []).length,
      currentHits: irSum((w.members || []).filter(m => current.has(m[0])).map(m => m[3])),
      chainLen: chains.length ? Math.max(...chains.map(ch => ch.chain || 0)) : null, chains: chains.length,
    };
  });
  const totalHits = irSum(warRows.map(w => w.hits));
  const winRows = warRows.filter(w => w.result === 'Win'), lossRows = warRows.filter(w => w.result === 'Loss');
  const avgWin = irMean(winRows.map(w => w.hits)), avgLoss = irMean(lossRows.map(w => w.hits));
  const phWin = irMean(winRows.map(w => w.perHour)), phLoss = irMean(lossRows.map(w => w.perHour));

  // ---- Chains during those wars, per attacker ----
  const chainBy = {};
  const nonBy = {};
  const chainIds = new Set(wars.flatMap(w => w.chains || []));
  for (const cid of chainIds) {
    const ch = record.chains[cid];
    if (!ch) continue;
    for (const a of ch.attackers || []) {
      const t = chainBy[a[0]] || (chainBy[a[0]] = { chains: 0, row: new Array(15).fill(0) });
      t.chains++;
      for (let k = 1; k < 15; k++) t.row[k] += a[k] || 0;
    }
    for (const id of ch.non || []) nonBy[id] = (nonBy[id] || 0) + 1;
  }

  // ---- Activity sources ----
  const obs = rec.observed || null;
  const sources = [];
  if (obs && obs.days) sources.push({ key: 'server', label: 'Your server\'s checks', days: obs.days, from: obs.from, to: obs.to, members: obs.members, week: obs.week, kind: 'server' });
  if (ffs && ffs.days) sources.push({ key: 'ffs', label: 'FFScouter scanner (Premium)', days: ffs.days, from: irDate(ffs.start), to: irDate(ffs.end), members: ffs.members, faction: ffs.faction, kind: 'ffs' });
  const pref = c.source && sources.find(s => s.key === c.source);
  const act = pref || [...sources].sort((a, b) => b.days - a.days)[0] || null;
  const blocksOf = (src, id) => {
    const m = src && src.members && src.members[id];
    if (!m) return null;
    const out = [];
    for (let b = 0; b < 12; b++) {
      let a = 0, o = 0;
      for (let s = b * 8; s < b * 8 + 8; s++) { a += m.act[s] || 0; o += m.obs[s] || 0; }
      out.push(o ? a / o : null);
    }
    const ta = irSum(m.act), to = irSum(m.obs);
    // Usual hours: the busiest 3-hour stretch.
    let best = -1, at = 0;
    for (let s = 0; s < 96; s++) {
      let a = 0, o = 0;
      for (let k = 0; k < 12; k++) { a += m.act[(s + k) % 96] || 0; o += m.obs[(s + k) % 96] || 0; }
      const r = o ? a / o : 0;
      if (r > best) { best = r; at = s; }
    }
    return { blocks: out, share: to ? ta / to : null, usual: to ? `${irSlotTime(at)}–${irSlotTime(at + 12)}` : '' };
  };

  // ---- Snapshots (momentum + commitment) ----
  const si = {};
  snapStats.forEach((k, i) => { si[k] = i; });
  const snapVal = (snap, k) => (snap && snap.v && si[k] != null ? snap.v[si[k]] : null);
  const momentumOf = id => {
    const s = rec.snaps && rec.snaps[id];
    if (!s) return null;
    const keys = Object.keys(s).filter(k => /^\d{4}-\d{2}-\d{2}$/.test(k) && s[k].v).sort();
    if (keys.length < 2) return null;
    const t = k => Date.parse(`${k}T00:00:00Z`);
    const first = keys[0], last = keys[keys.length - 1];
    const weeks = Math.max(1 / 7, (t(last) - t(first)) / (7 * IR_DAY));
    const rate = (k, a, b, w) => { const x = snapVal(s[a], k), y = snapVal(s[b], k); return x != null && y != null ? (y - x) / w : null; };
    const recentKey = [...keys].reverse().find(k => t(last) - t(k) >= 13 * IR_DAY) || first;
    const rWeeks = Math.max(1 / 7, (t(last) - t(recentKey)) / (7 * IR_DAY));
    const m = { weeks, from: first, to: last };
    for (const [k, name] of [['timeplayed', 'hours'], ['xantaken', 'xan'], ['refills', 'refills'], ['energydrinkused', 'cans'], ['statenhancersused', 'se'], ['boostersused', 'boosters'], ['attackswon', 'attacks'], ['rankedwarhits', 'rwhits'], ['revives', 'revives']]) {
      m[name] = rate(k, first, last, weeks);
      m[`${name}Recent`] = rate(k, recentKey, last, rWeeks);
    }
    if (m.hours != null) { m.hours /= 3600; if (m.hoursRecent != null) m.hoursRecent /= 3600; }
    m.streak = snapVal(s[last], 'activestreak');
    m.trend = m.hours && m.hoursRecent != null ? m.hoursRecent / m.hours : null;
    return m;
  };
  const commitWars = wars.slice(0, 3);
  const commitOf = id => {
    const s = rec.snaps && rec.snaps[id];
    if (!s) return null;
    const out = {};
    let any = false;
    for (const w of commitWars) {
      const a = s[`w${w.id}s`], b = s[`w${w.id}e`];
      if (!a || !b || !a.v || !b.v) continue;
      const d = k => { const x = snapVal(a, k), y = snapVal(b, k); return x != null && y != null ? Math.max(0, y - x) : null; };
      out[w.id] = { xan: d('xantaken'), refills: d('refills'), cans: d('energydrinkused'), hours: d('timeplayed') != null ? d('timeplayed') / 3600 : null, rwhits: d('rankedwarhits') };
      any = true;
    }
    return any ? out : null;
  };

  // ---- Members ----
  const DAYMS = IR_DAY;
  const members = roster.map(m => {
    const id = Number(m.id);
    const joinedAt = now - (m.days || 0) * DAYMS;
    const per = [];
    for (const w of wars) {
      const row = (w.members || []).find(x => x[0] === id);
      const eligible = !!row || joinedAt <= w.start + 6 * 3600e3;
      if (!eligible) continue;
      per.push({ war: w.id, hits: row ? row[3] : 0, score: row ? row[4] : 0, won: !!w.winner && w.winner === rec.id, result: !!w.winner, start: w.start });
    }
    const eligible = per.length;
    const active = per.filter(p => p.hits > 0).length;
    const hits = irSum(per.map(p => p.hits));
    const score = irSum(per.map(p => p.score));
    const hitsList = per.map(p => p.hits);
    const mean = eligible ? hits / eligible : 0;
    const sd = eligible > 1 ? Math.sqrt(irSum(hitsList.map(h => (h - mean) ** 2)) / eligible) : 0;
    // Trend: newer half of their wars vs the older half.
    const chrono = [...per].sort((a, b) => a.start - b.start).map(p => p.hits);
    let trend = 'Stable';
    if (chrono.length >= 3) {
      const h = Math.floor(chrono.length / 2);
      const older = irMean(chrono.slice(0, h)), newer = irMean(chrono.slice(chrono.length - h));
      const r = (newer + 1) / (older + 1);
      trend = r > 1.25 ? 'Improving' : r < 0.8 ? 'Declining' : 'Stable';
    }
    const wins = per.filter(p => p.result && p.won), losses = per.filter(p => p.result && !p.won);
    const ch = chainBy[id];
    const est = stats[id] && stats[id].bs ? stats[id].bs : null;
    const g = ffs && ffs.growth && ffs.growth[id];
    const growth10 = g && g.first && g.last && g.last.t - g.first.t > 7 * DAYMS ? g.last.bs / g.first.bs - 1 : null;
    const growth4 = g && g.mid && g.last && g.last.t - g.mid.t > 7 * DAYMS ? g.last.bs / g.mid.bs - 1 : null;
    return {
      id, name: m.name, level: m.level, position: m.position || '', days: m.days || 0, revivable: !!m.revivable, status: m.description || m.state || '',
      lastAt: m.lastAt || 0, est, eligible, active, participation: eligible ? active / eligible : null, noShow: eligible ? 1 - active / eligible : null,
      hits, avgWar: eligible ? hits / eligible : 0, avgActive: active ? hits / active : 0, peak: hitsList.length ? Math.max(...hitsList) : 0,
      avgWin: wins.length ? irMean(wins.map(p => p.hits)) : null, avgLoss: losses.length ? irMean(losses.map(p => p.hits)) : null,
      share: 0, score, perHit: hits ? score / hits : null, consistency: eligible >= 2 && mean > 0 ? irClamp(1 - (sd / mean) / 1.5) : null, trend,
      chain: ch ? { chains: ch.chains, total: ch.row[IR_CH.total], war: ch.row[IR_CH.war], assists: ch.row[IR_CH.assists], retals: ch.row[IR_CH.retals], overseas: ch.row[IR_CH.overseas], losses: ch.row[IR_CH.losses], escapes: ch.row[IR_CH.escapes], hosp: ch.row[IR_CH.hosp], leave: ch.row[IR_CH.leave], mug: ch.row[IR_CH.mug], bonuses: ch.row[IR_CH.bonuses], respect: ch.row[IR_CH.respect], best: ch.row[IR_CH.best] } : null,
      sitOuts: nonBy[id] || 0,
      activity: blocksOf(act, id), momentum: momentumOf(id), commit: commitOf(id), growth10, growth4,
      prior: (record.prior && record.prior[id]) || [],
    };
  });

  // Hit shares are of the current members' hits (what matters for the next war); how much of
  // the faction's output came from people still in it is shown separately.
  const rosterHits = irSum(members.map(m => m.hits));
  for (const m of members) m.share = rosterHits ? m.hits / rosterHits : 0;

  // ---- War threat (0–100) and roles ----
  const maxAvg = Math.max(1, ...members.map(m => m.avgWar));
  const maxShare = Math.max(0.0001, ...members.map(m => m.share));
  for (const m of members) {
    const cap = m.est ? irClamp((Math.log10(m.est) - 4) / 6.5) : null;
    const parts = {
      capability: [0.30, cap == null ? 0.35 : cap], volume: [0.25, m.avgWar / maxAvg], participation: [0.20, m.participation || 0],
      share: [0.10, m.share / maxShare], consistency: [0.10, m.consistency == null ? 0.5 : m.consistency],
      trend: [0.05, m.eligible < 3 ? 0.5 : m.trend === 'Improving' ? 1 : m.trend === 'Stable' ? 0.5 : 0.2],
    };
    m.threat = Math.round(1000 * irSum(Object.values(parts).map(([w, v]) => w * v))) / 10;
    m.threatParts = parts;
  }
  const medActive = irMedian(members.filter(m => m.active).map(m => m.avgActive)) || 0;
  for (const m of members) {
    const p = m.participation || 0;
    if (m.eligible >= 3 && m.active >= 2 && p >= 0.6 && (m.threat >= 70 || (m.share >= 0.10 && m.avgWar >= 40) || (m.share >= 0.05 && m.avgWar >= 70))) m.role = 'Proven Heavy Hitter';
    else if (m.eligible >= 1 && m.eligible <= 2 && m.threat >= 70 && m.avgWar >= 60) m.role = 'Emerging Heavy Hitter';
    else if (m.threat >= 70) m.role = 'Heavy Hitter';
    else if (!m.eligible) m.role = m.prior.length ? 'New (war record elsewhere)' : 'New (no wars yet)';
    else if (!m.active) m.role = 'No Recorded Hits';
    else if (p >= 0.8 && m.active >= 2) m.role = 'Core Regular';
    else if (p >= 0.6) m.role = 'Regular';
    else if (m.avgActive >= Math.max(15, 0.6 * medActive)) m.role = 'Surge Fighter';
    else if (p >= 0.3) m.role = 'Sporadic';
    else m.role = 'Low Participation';
  }
  members.sort((a, b) => b.threat - a.threat);
  const heavy = members.filter(m => /Heavy Hitter/.test(m.role));
  const lowNoShow = members.filter(m => m.role === 'No Recorded Hits' || m.role === 'Low Participation');
  const surge = members.filter(m => m.role === 'Surge Fighter');
  const byHits = [...members].sort((a, b) => b.hits - a.hits);
  const topShare = n => (rosterHits ? irSum(byHits.slice(0, n).map(m => m.hits)) / rosterHits : null);
  const expectedActive = Math.round(irSum(members.filter(m => m.eligible).map(m => m.participation)));
  const dangerousUnreliable = members.filter(m => m.est && m.participation != null && m.participation < 0.5 && m.eligible >= 2).sort((a, b) => b.est - a.est).slice(0, 3);

  // ---- Faction activity per source ----
  const factionActivity = src => {
    if (!src) return null;
    const n = roster.length || 1;
    const slots = new Array(96).fill(null);
    if (src.kind === 'ffs' && src.faction) {
      for (let s = 0; s < 96; s++) { const [v, k] = src.faction.slots[s] || [0, 0]; slots[s] = k ? v / k : null; }
    } else {
      for (let s = 0; s < 96; s++) {
        let a = 0, o = 0;
        for (const id of current) { const m = src.members[id]; if (m) { a += m.act[s] || 0; o += m.obs[s] || 0; } }
        slots[s] = o ? (a / o) * n : null;
      }
    }
    const roll = w => {
      let best = null, worst = null;
      for (let s = 0; s < 96; s++) {
        const vals = [];
        for (let k = 0; k < w; k++) { const v = slots[(s + k) % 96]; if (v != null) vals.push(v); }
        if (vals.length < w / 2) continue;
        const v = irMean(vals);
        if (!best || v > best.v) best = { s, v };
        if (!worst || v < worst.v) worst = { s, v };
      }
      return { best, worst };
    };
    const week = [];
    for (const d of IR_DOW) {
      const row = [];
      for (let h = 0; h < 24; h++) {
        const i = d * 24 + h;
        if (src.kind === 'ffs') { const [v, k] = (src.faction && src.faction.week[i]) || [0, 0]; row.push(k ? v / k : null); } else { const o = src.week ? src.week.obs[i] : 0; row.push(o ? (src.week.act[i] / o) * n : null); }
      }
      week.push(row);
    }
    const vals = slots.filter(v => v != null);
    return { key: src.key, label: src.label, days: src.days, from: src.from, to: src.to, slots, h1: roll(4), h4: roll(16), week, avg: irMean(vals), peak: vals.length ? Math.max(...vals) : null, roster: n };
  };

  // ---- Threat level ----
  const winRate = warRows.filter(w => w.result !== '–').length ? winRows.length / warRows.filter(w => w.result !== '–').length : null;
  const usAvg = c.us && c.us.record ? irMean((c.us.record.wars || []).filter(w => w.us).map(w => w.us.attacks)) : null;
  const theirAvg = irMean(warRows.map(w => w.hits));
  let level = 'UNKNOWN', levelWhy = 'Not enough war history yet.';
  if (c.self) {
    if (winRate != null) {
      level = winRate < 0.3 ? 'POOR' : winRate < 0.55 ? 'FAIR' : winRate < 0.75 ? 'GOOD' : 'STRONG';
      levelWhy = `Won ${winRows.length} of the last ${warRows.filter(w => w.result !== '–').length} ranked wars; ${irF(theirAvg, 0)} hits per war on average.`;
    }
  } else if (theirAvg != null && usAvg) {
    const r = theirAvg / usAvg;
    level = r < 0.6 ? 'LOW' : r < 0.9 ? 'MODERATE' : r < 1.2 ? 'HIGH' : 'SEVERE';
    levelWhy = `Their average war output is ${irP(r, 0)} of yours (${irF(theirAvg, 0)} vs ${irF(usAvg, 0)} hits per war).`;
  } else if (winRate != null) {
    level = winRate < 0.3 ? 'LOW' : winRate < 0.55 ? 'MODERATE' : winRate < 0.75 ? 'HIGH' : 'SEVERE';
    levelWhy = `Based on their win rate (${irP(winRate, 0)} of the last ${warRows.length} wars).`;
  }

  return {
    self: !!c.self, name: rec.name, id: rec.id, tag: (rec.basic && rec.basic.tag) || '', rank: (rec.basic && rec.basic.rank) || '', now, by: c.by || '',
    banner: (rec.basic && rec.basic.bannerImage) || c.banner || '',
    wars: warRows, pendingWars, totalHits, avgHits: theirAvg, peakHits: warRows.length ? Math.max(...warRows.map(w => w.hits)) : null,
    avgWin, avgLoss, phWin, phLoss, persistence: avgWin && avgLoss != null ? avgLoss / avgWin : null, persistenceAdj: phWin && phLoss != null ? phLoss / phWin : null,
    rosterShare: totalHits ? rosterHits / totalHits : null, winRate, wins: winRows.length, losses: lossRows.length, top5: topShare(5), top10: topShare(10), top15: roster.length > 20 ? topShare(15) : null,
    members, heavy, lowNoShow, surge, expectedActive, dangerousUnreliable, level, levelWhy,
    attendance: heavy.length ? irMean(heavy.map(m => m.participation)) : null,
    revivable: members.filter(m => m.revivable).length, rosterSize: roster.length,
    activity: sources.map(factionActivity), mainActivity: act ? act.key : null, activityLabel: act ? act.label : '',
    hasFfs: !!(ffs && ffs.days), hasEst: members.some(m => m.est), hasMomentum: members.some(m => m.momentum), hasCommit: members.some(m => m.commit),
    commitWars: commitWars.map(w => ({ id: w.id, opp: (w.opp && w.opp.name) || '?', end: w.end, won: w.winner === rec.id })),
    chainsAnalysed: chainIds.size, chainsMissing: [...chainIds].filter(id => !record.chains[id]).length,
    joinedElsewhere: members.filter(m => m.prior.length),
  };
}

// ---------------------------------------------------------------- rendering
// mode: 'app' (inside Mentat), 'pdf' (static print), 'html' (interactive export)
const irTh = (label, kind = 'num', title = '') => `<th data-k="${kind}"${title ? ` title="${esc(title)}"` : ''}>${label}</th>`;
const irTd = (v, text, cls = 'num') => `<td class="${cls}" data-v="${v == null || !Number.isFinite(v) ? '' : v}">${text}</td>`;
const irName = (m, mode) => (mode === 'app' ? `${avatar(m.id)}${link(profileUrl(m.id), esc(m.name))}` : `<a href="${profileUrl(m.id)}" target="_blank" rel="noopener">${esc(m.name)}</a>`);
const irRoleCls = r => (/Heavy/.test(r) ? 'r-heavy' : /Core/.test(r) ? 'r-core' : /Surge/.test(r) ? 'r-surge' : /^Regular/.test(r) ? 'r-reg' : /New/.test(r) ? 'r-new' : 'r-low');
const irTable = (id, head, rows, mode, filter = true) => `${filter && mode !== 'pdf' ? `<div class="ir-tools"><input class="ir-filter" data-for="${id}" placeholder="Filter rows… (any text, e.g. a name or role)"><span class="ir-count" data-count-for="${id}"></span></div>` : ''}
  <div class="ir-wrap"><table class="ir-t" id="${id}"><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table></div>`;
const irHeat = v => (v == null ? 'class="ir-hm-empty"' : `style="background:rgba(59,130,246,${(0.08 + Math.min(1, v) * 0.85).toFixed(2)})"`);

function irSlotsSvg(fa, w = 1000, h = 190) {
  const pts = fa.slots.map((v, s) => [s, v]).filter(p => p[1] != null);
  if (pts.length < 2) return '<div class="ir-note">Not enough observations yet.</div>';
  const max = Math.max(...pts.map(p => p[1])) * 1.1 || 1;
  const x = s => 40 + (s / 95) * (w - 50), y = v => h - 24 - (v / max) * (h - 40);
  const grid = [0, 0.25, 0.5, 0.75, 1].map(f => `<line x1="40" x2="${w - 10}" y1="${y(max * f)}" y2="${y(max * f)}" class="ir-grid"/><text x="34" y="${y(max * f) + 4}" class="ir-axis" text-anchor="end">${(max * f).toFixed(1)}</text>`).join('');
  const xs = [0, 16, 32, 48, 64, 80].map(s => `<text x="${x(s)}" y="${h - 6}" class="ir-axis" text-anchor="middle">${irSlotTime(s)}</text>`).join('');
  return `<svg viewBox="0 0 ${w} ${h}" class="ir-svg" preserveAspectRatio="none">${grid}${xs}<polyline class="ir-line" fill="none" points="${pts.map(p => `${x(p[0]).toFixed(1)},${y(p[1]).toFixed(1)}`).join(' ')}"/></svg>`;
}

function irBody(M, mode) {
  const L = M.self
    ? { banner: `War form (last ${M.wars.length} ranked wars)`, threat: 'Impact', threatLong: 'Impact 0–100: estimated stats, hit volume, participation, hit share, consistency, trend', unreliable: 'Strong but unreliable', keyAct: 'Top members’ activity', keyActSub: 'The 10 highest-impact members' }
    : { banner: 'Historical threat assessment', threat: 'Threat', threatLong: 'War Threat 0–100: estimated stats, hit volume, participation, hit share, consistency, trend', unreliable: 'Dangerous but unreliable', keyAct: 'Key threat activity', keyActSub: 'The 10 highest War Threat members' };
  const nm = m => irName(m, mode);
  const tile = (k, v, sub = '') => `<div class="ir-tile"><div class="ir-k">${k}</div><div class="ir-v">${v}</div>${sub ? `<div class="ir-sub">${sub}</div>` : ''}</div>`;
  const sec = (title, sub, body, cls = '') => `<section class="ir-sec ${cls}"><h2>${title}</h2>${sub ? `<div class="ir-subtitle">${sub}</div>` : ''}${body}</section>`;
  const est = m => (m.est ? irCompact(m.est) : '–');
  const ma = M.activity.find(a => a && a.key === M.mainActivity);

  const exec = [
    `${M.wars.length} ranked wars analysed${M.pendingWars ? ` (${M.pendingWars} more still loading)` : ''}. Historical behaviour suggests about <b>${M.expectedActive}</b> current members record hits in a typical war.`,
    M.peakHits != null ? `Hitting power: peak output <b>${num(M.peakHits)}</b> hits in one war; <b>${irF(M.avgWin, 1)}</b> hits on average in wins and <b>${irF(M.avgLoss, 1)}</b> in losses.` : '',
    M.top5 != null ? `Dependency on ${M.self ? "your" : "their"} busiest members: of the hits current members made, the top 5 made <b>${irP(M.top5)}</b>, top 10 <b>${irP(M.top10)}</b>${M.top15 != null ? `, top 15 <b>${irP(M.top15)}</b>` : ''}.` : '',
    M.rosterShare != null ? `Current members made <b>${irP(M.rosterShare)}</b> of the faction's hits in these wars${M.rosterShare < 0.8 ? ', so a good part of ${M.self ? "your" : "their"} past output has left' : ''}.` : '',
    `<b>${M.heavy.length}</b> heavy hitter${M.heavy.length === 1 ? '' : 's'}${M.attendance != null ? ` (average attendance ${irP(M.attendance, 0)})` : ''}, <b>${M.surge.length}</b> surge fighter${M.surge.length === 1 ? '' : 's'}, <b>${M.lowNoShow.length}</b> low / no-show member${M.lowNoShow.length === 1 ? '' : 's'}.`,
    `Revivable now: <b>${M.revivable}</b> of ${M.rosterSize} current members.`,
    M.dangerousUnreliable.length ? `${L.unreliable}: ${M.dangerousUnreliable.map(m => `${esc(m.name)} (${irCompact(m.est)} est., ${irP(m.participation, 0)} participation)`).join('; ')}.` : '',
    M.joinedElsewhere.length ? `<b>${M.joinedElsewhere.length}</b> member${M.joinedElsewhere.length === 1 ? ' has' : 's have'} ranked-war history in other factions (see "Joined from elsewhere").` : '',
    ma ? `Activity (${esc(ma.label)}, ${ma.days} days): busiest hour ${irSlotTime(ma.h1.best.s)}–${irSlotTime(ma.h1.best.s + 4)} TCT, quietest ${irSlotTime(ma.h1.worst.s)}–${irSlotTime(ma.h1.worst.s + 4)} TCT; quietest 4 hours ${irSlotTime(ma.h4.worst.s)}–${irSlotTime(ma.h4.worst.s + 16)} TCT.` : '',
    M.hasEst ? 'Estimated battle stats are FFScouter estimates, not confirmed totals.' : '',
  ].filter(Boolean);

  // ---- Roster ----
  const rosterHead = [irTh('Player', 'text'), irTh('Role', 'text'), irTh(L.threat, 'num', L.threatLong), irTh('Est. stats'), irTh('Lvl'), irTh('Days in faction'),
    irTh('Eligible', 'num', 'Analysed wars they were in the faction for'), irTh('Active', 'num', 'Wars with at least one hit'), irTh('Participation'), irTh('No-show'), irTh('Avg / war'), irTh('Avg / active'), irTh('Hit share'),
    irTh('Score / hit', 'num', 'Ranked war score per hit: higher = better targets'), irTh('Trend', 'text'), irTh('Usual hours (TCT)', 'text'), irTh('Revivable', 'text')].join('');
  const rosterRows = M.members.map(m => `<tr>
    <td>${nm(m)}<div class="ir-mini">${esc(m.position)}</div></td><td><span class="ir-role ${irRoleCls(m.role)}">${esc(m.role)}</span></td>
    ${irTd(m.threat, `<b>${irF(m.threat, 1)}</b>`)}${irTd(m.est, est(m))}${irTd(m.level, m.level)}${irTd(m.days, num(m.days))}
    ${irTd(m.eligible, m.eligible)}${irTd(m.active, m.active)}${irTd(m.participation, irP(m.participation, 0))}${irTd(m.noShow, irP(m.noShow, 0))}
    ${irTd(m.avgWar, irF(m.avgWar))}${irTd(m.avgActive, irF(m.avgActive))}${irTd(m.share, irP(m.share))}${irTd(m.perHit, irF(m.perHit, 2))}
    <td data-v="${m.trend}">${m.trend}</td><td>${m.activity ? m.activity.usual : '–'}</td><td>${m.revivable ? 'Yes' : 'No'}</td></tr>`).join('');

  const core = M.members.filter(m => m.eligible).slice(0, 15);
  const coreRows = core.map(m => `<tr><td>${nm(m)}</td>${irTd(m.est, est(m))}${irTd(m.threat, irF(m.threat, 1))}<td>${esc(m.role)}</td>${irTd(m.participation, irP(m.participation, 0))}<td>${m.revivable ? 'Yes' : 'No'}</td></tr>`).join('');

  const powerRows = M.members.map(m => `<tr><td>${nm(m)}</td>${irTd(m.days, num(m.days))}${irTd(m.peak, m.peak)}${irTd(m.avgWin, irF(m.avgWin))}${irTd(m.avgLoss, irF(m.avgLoss))}${irTd(m.hits, num(m.hits))}${irTd(m.score, irF(m.score, 1))}${irTd(m.consistency, irP(m.consistency, 0))}</tr>`).join('');

  const warRowsH = M.wars.map(w => `<tr>${irTd(w.n, w.n)}<td>${irDate(w.end)}</td><td>${esc(w.opp)}${w.oppRank ? ` <span class="ir-mini">${esc(w.oppRank)}</span>` : ''}</td><td data-v="${w.result}"><span class="ir-res ${w.result === 'Win' ? 'win' : w.result === 'Loss' ? 'loss' : ''}">${w.result}${w.forfeit ? ' (forfeit)' : ''}</span></td>
    ${irTd(w.hrs, irF(w.hrs))}${irTd(w.hits, num(w.hits))}${irTd(w.currentHits, num(w.currentHits))}${irTd(w.perHour, irF(w.perHour))}${irTd(w.energy, num(w.energy))}${irTd(w.hitters, w.hitters)}${irTd(w.chainLen, w.chainLen == null ? '–' : num(w.chainLen))}${irTd(w.score, num(w.score))}${irTd(w.oppScore, num(w.oppScore))}${irTd(w.oppHits, num(w.oppHits))}<td>${esc(w.rankBefore)}${w.rankAfter && w.rankAfter !== w.rankBefore ? ` → ${esc(w.rankAfter)}` : ''}</td></tr>`).join('');

  const chained = M.members.filter(m => m.chain || m.sitOuts);
  const chainRows = chained.map(m => { const c = m.chain || {}; const tot = c.total || 0; return `<tr><td>${nm(m)}</td>${irTd(c.chains || 0, c.chains || 0)}${irTd(m.sitOuts, m.sitOuts)}${irTd(tot, num(tot))}${irTd(c.war, num(c.war || 0))}${irTd(c.assists, num(c.assists || 0))}${irTd(c.retals, num(c.retals || 0))}${irTd(c.overseas, num(c.overseas || 0))}${irTd(c.losses, num(c.losses || 0))}${irTd(c.escapes, num(c.escapes || 0))}${irTd(tot ? c.hosp / tot : null, tot ? irP(c.hosp / tot, 0) : '–')}${irTd(tot ? c.leave / tot : null, tot ? irP(c.leave / tot, 0) : '–')}${irTd(tot ? c.mug / tot : null, tot ? irP(c.mug / tot, 0) : '–')}${irTd(tot ? c.respect / tot : null, tot ? irF(c.respect / tot, 2) : '–')}${irTd(c.best, irF(c.best, 1))}</tr>`; }).join('');

  const mom = M.members.filter(m => m.momentum || m.growth10 != null);
  const momRows = mom.map(m => { const x = m.momentum || {}; return `<tr><td>${nm(m)}</td>${irTd(m.est, est(m))}${irTd(m.growth10, irSP(m.growth10))}${irTd(m.growth4, irSP(m.growth4))}${irTd(x.hours, irF(x.hours))}${irTd(x.hoursRecent, irF(x.hoursRecent))}<td data-v="${x.trend == null ? '' : x.trend}">${x.trend == null ? '–' : x.trend > 1.2 ? '▲ more' : x.trend < 0.8 ? '▼ less' : 'steady'}</td>${irTd(x.xan, irF(x.xan))}${irTd(x.refills, irF(x.refills))}${irTd(x.cans, irF(x.cans))}${irTd(x.se, irF(x.se))}${irTd(x.attacks, irF(x.attacks))}${irTd(x.rwhits, irF(x.rwhits))}${irTd(x.streak, x.streak == null ? '–' : num(x.streak))}${irTd(x.weeks, irF(x.weeks))}</tr>`; }).join('');
  const momFaction = (() => {
    const ms = M.members.map(m => m.momentum).filter(Boolean);
    if (!ms.length) return '';
    const f = k => irSum(ms.map(x => x[k]));
    return `<div class="ir-tiles">${tile('Hours played / week (faction)', irF(f('hours'), 0))}${tile('Last 2 weeks', irF(f('hoursRecent'), 0))}${tile('Xanax / week', irF(f('xan'), 0))}${tile('Refills / week', irF(f('refills'), 0))}${tile('Energy drinks / week', irF(f('cans'), 0))}${tile('Members measured', `${ms.length} / ${M.rosterSize}`)}</div>`;
  })();

  const commitHead = [irTh('Player', 'text'), ...M.commitWars.flatMap(w => [irTh(`Xanax · ${esc(w.opp)}`), irTh('Refills'), irTh('Cans'), irTh('Hours on')])].join('');
  const commitRows = M.members.filter(m => m.commit).map(m => `<tr><td>${nm(m)}</td>${M.commitWars.map(w => { const c = m.commit[w.id] || {}; return `${irTd(c.xan, c.xan == null ? '–' : c.xan)}${irTd(c.refills, c.refills == null ? '–' : c.refills)}${irTd(c.cans, c.cans == null ? '–' : c.cans)}${irTd(c.hours, irF(c.hours))}`; }).join('')}</tr>`).join('');

  const actSecs = M.activity.filter(Boolean).map(a => `
    <h3>${esc(a.label)} · ${a.days} day${a.days === 1 ? '' : 's'} (${esc(a.from)} to ${esc(a.to)})</h3>
    <div class="ir-cols"><table class="ir-t ir-small"><thead><tr><th>Sustained window</th><th>TCT</th><th class="num">Avg active</th><th class="num">Share of roster</th></tr></thead><tbody>
      ${[['Strongest 1 hour', a.h1.best, 4], ['Quietest 1 hour', a.h1.worst, 4], ['Strongest 4 hours', a.h4.best, 16], ['Quietest 4 hours', a.h4.worst, 16]].map(([l, x, w]) => (x ? `<tr><td>${l}</td><td>${irSlotTime(x.s)}–${irSlotTime(x.s + w)}</td><td class="num">${irF(x.v)}</td><td class="num">${irP(x.v / a.roster)}</td></tr>` : '')).join('')}
      <tr><td>Average per 15 minutes</td><td></td><td class="num">${irF(a.avg)}</td><td class="num">${irP(a.avg / a.roster)}</td></tr></tbody></table>
      <div><div class="ir-chart-title">Average members active by 15-minute slot (TCT)</div>${irSlotsSvg(a)}</div></div>
    <div class="ir-chart-title">By day and hour (TCT): average members active</div>
    <table class="ir-hm"><tr><th></th>${Array.from({ length: 24 }, (_, h) => `<th>${h % 2 === 0 ? String(h).padStart(2, '0') : ''}</th>`).join('')}</tr>
      ${a.week.map((row, d) => `<tr><th>${IR_DAYS[d]}</th>${row.map(v => `<td ${irHeat(v == null ? null : v / Math.max(1, a.peak || 1))}>${v == null ? '' : v >= 0.5 ? Math.round(v) : ''}</td>`).join('')}</tr>`).join('')}</table>`).join('');

  const keyThreats = M.members.slice(0, 10);
  const threatHm = `<table class="ir-t ir-hmt"><thead><tr><th>Player</th><th class="num">${L.threat}</th><th class="num">Est. stats</th>${IR_BLOCKS.map(b => `<th>${b}</th>`).join('')}</tr></thead><tbody>
    ${keyThreats.map(m => `<tr><td>${nm(m)}</td><td class="num">${irF(m.threat, 1)}</td><td class="num">${est(m)}</td>${(m.activity ? m.activity.blocks : new Array(12).fill(null)).map(v => `<td ${irHeat(v)}>${v == null ? '' : `${Math.round(v * 100)}%`}</td>`).join('')}</tr>`).join('')}</tbody></table>`;

  const prior = M.joinedElsewhere.map(m => `<tr><td>${nm(m)}</td>${irTd(m.days, num(m.days))}${irTd(m.est, est(m))}<td>${m.prior.map(p => `${esc(p.factionName)} vs ${esc(p.opp)} (${irDate(p.end)}): <b>${p.attacks}</b> hits${p.factionAttacks ? `, ${irP(p.attacks / p.factionAttacks, 0)} of theirs` : ''}`).join('<br>')}</td>${irTd(irMean(m.prior.map(p => p.attacks)), irF(irMean(m.prior.map(p => p.attacks))))}</tr>`).join('');

  return `
  <div class="ir-banner lvl-${M.level.toLowerCase()}"><div>${L.banner}</div><div class="ir-level">${M.level}</div><div class="ir-why">${esc(M.levelWhy)}</div></div>
  <div class="ir-tiles">
    ${tile('Expected active roster', M.expectedActive)}${tile('Avg faction hits / war', irF(M.avgHits))}${tile('Peak faction hits', M.peakHits == null ? '–' : num(M.peakHits))}${tile('Record (last ' + M.wars.length + ')', `${M.wins}–${M.losses}`)}
    ${tile('Avg hits · wins', irF(M.avgWin))}${tile('Avg hits · losses', irF(M.avgLoss))}${tile('Loss persistence', irP(M.persistence), 'losing-war hits ÷ winning-war hits')}${tile('Duration-adjusted', irP(M.persistenceAdj), 'same, per hour of war')}
    ${tile('Top 5 hit share', irP(M.top5), 'of current members’ hits')}${tile('Top 10 hit share', irP(M.top10))}${tile('Top 15 hit share', M.top15 == null ? '–' : irP(M.top15))}${tile('Heavy hitters', `${M.heavy.length}${M.attendance != null ? ` <span class="ir-sub">· ${irP(M.attendance, 0)} attendance</span>` : ''}`)}
    ${tile('Low / no-show members', M.lowNoShow.length)}${tile('Surge fighters', M.surge.length)}${tile('Revivable now', `${M.revivable} / ${M.rosterSize}`)}${tile('Output from current members', irP(M.rosterShare), 'of all hits in these wars; the rest came from people who left')}${tile('Joined with a record elsewhere', M.joinedElsewhere.length)}
  </div>
  ${sec('Executive assessment', '', `<ul class="ir-list">${exec.map(x => `<li>${x}</li>`).join('')}</ul>`)}
  ${M.heavy.length ? sec('Heavy hitters', '', `<div class="ir-heavy">${M.heavy.map(m => `<div class="ir-hh"><b>${nm(m)}</b> · ${esc(m.role)} · ${est(m)} est. · ${irP(m.participation, 0)} attendance · ${irF(m.avgWar)} hits per war · revivable: ${m.revivable ? 'yes' : 'no'}</div>`).join('')}</div>`) : ''}
  ${sec('Core 15', `Highest ${M.self ? 'impact' : 'War Threat'} among members with war history.`, irTable('ir-core', [irTh('Player', 'text'), irTh('Est. stats'), irTh(M.self ? 'Impact' : 'War threat'), irTh('Role', 'text'), irTh('Attendance'), irTh('Revivable', 'text')].join(''), coreRows, mode, false))}
  ${sec('Full current roster', `Sorted by ${M.self ? 'impact' : 'War Threat'}.`+' Eligible = analysed wars they were in the faction for (a hit in a war, or joining before it started, counts). Participation = wars with a hit ÷ eligible wars.', irTable('ir-roster', rosterHead, rosterRows, mode), 'ir-break')}
  ${sec('Hitting power', 'Per member across eligible analysed wars. Zero-hit wars count, to show real output in wins vs losses.', irTable('ir-power', [irTh('Player', 'text'), irTh('Days in faction'), irTh('Peak hits'), irTh('Avg · wins'), irTh('Avg · losses'), irTh('Total hits'), irTh('Total score'), irTh('Consistency', 'num', '100% = the same output every war')].join(''), powerRows, mode))}
  ${sec(`${M.wars.length}-war output matrix`, 'Faction hits include members who have since left; "Current" counts only today\'s members. Attack energy = hits × 25.',
    `${irTable('ir-wars', [irTh('#'), irTh('Ended', 'text'), irTh('Opponent', 'text'), irTh('Result', 'text'), irTh('Hours'), irTh('Faction hits'), irTh('Current members'), irTh('Hits / hour'), irTh('Attack energy'), irTh('Hitters'), irTh('Longest chain'), irTh('Their score'), irTh('Opp. score'), irTh('Opp. hits'), irTh('Rank', 'text')].join(''), warRowsH, mode)}
     <div class="ir-callout"><b>Loss persistence</b> · Winning wars: ${irF(M.avgWin)} avg hits (${irF(M.phWin)} / hour) · Losing wars: ${irF(M.avgLoss)} avg hits (${irF(M.phLoss)} / hour) · Raw: ${irP(M.persistence)} · Duration-adjusted: ${irP(M.persistenceAdj)}. This measures how much output falls when they're losing, not why.</div>`, 'ir-break')}
  ${chainRows ? sec('Chain breakdown during those wars', `${M.chainsAnalysed} chains${M.chainsMissing ? ` (${M.chainsMissing} still loading)` : ''}. From Torn's chain reports: hits by type, assists, retaliations (counter-attacks), hits abroad, and losses. "Sat out" = listed by Torn as a member who didn't attack in that chain.`,
    irTable('ir-chains', [irTh('Player', 'text'), irTh('Chains'), irTh('Sat out'), irTh('Hits'), irTh('War hits'), irTh('Assists'), irTh('Retals'), irTh('Abroad'), irTh('Losses'), irTh('Escapes'), irTh('Hosp %'), irTh('Leave %'), irTh('Mug %'), irTh('Respect / hit'), irTh('Best hit')].join(''), chainRows, mode), 'ir-break') : ''}
  ${momRows ? sec('Momentum', 'How much each member actually plays and uses, from Torn\'s daily stat snapshots weekly over the last 10 weeks (time played, Xanax, refills, energy drinks, stat enhancers). Estimated battle-stat growth is from FFScouter\'s stat history.',
    `${momFaction}${irTable('ir-mom', [irTh('Player', 'text'), irTh('Est. stats'), irTh('Est. growth 10 wk'), irTh('Est. growth 4 wk'), irTh('Hours / week'), irTh('Hours / week (last 2)'), irTh('Trend', 'num'), irTh('Xanax / wk'), irTh('Refills / wk'), irTh('Cans / wk'), irTh('SEs / wk'), irTh('Attacks won / wk'), irTh('RW hits / wk'), irTh('Active streak'), irTh('Weeks')].join(''), momRows, mode)}`, 'ir-break') : ''}
  ${commitRows ? sec('Commitment during recent wars', 'Used between the day before each war started and the day after it ended (daily snapshots, so it can include a little before or after the war).', irTable('ir-commit', commitHead, commitRows, mode)) : ''}
  ${actSecs ? sec('Activity intelligence', 'Share of 15-minute slots in which each member was seen active. "Your server" counts last-action times from its own checks; FFScouter uses its scanner. Neither proves someone was offline.', actSecs, 'ir-break') : ''}
  ${keyThreats.length && keyThreats.some(m => m.activity) ? sec(L.keyAct, `${L.keyActSub}: share of observed 15-minute slots active in each 2-hour block (TCT), from ${esc(M.activityLabel)}.`, threatHm) : ''}
  ${prior ? sec('Joined from elsewhere', 'Current members with ranked-war history in other factions (from every war report your server has archived).', irTable('ir-prior', [irTh('Player', 'text'), irTh('Days here'), irTh('Est. stats'), irTh('Previous wars', 'text'), irTh('Avg hits there')].join(''), prior, mode)) : ''}
  ${sec('Notes', '', `<ul class="ir-list ir-notes">
    <li><b>${M.self ? 'Impact' : 'War Threat'} (0–100)</b> = 30% estimated stats (log scale, 10k → 0, ~30b → 1; unknown counts as 0.35) + 25% hits per eligible war (vs their top member) + 20% participation + 10% hit share + 10% consistency + 5% trend.</li>
    <li><b>Roles.</b> Proven Heavy Hitter: 3+ eligible wars, 2+ active, 60%+ attendance, and threat ≥ 70 or ≥10% hit share with 40+ hits per war or ≥5% with 70+. Emerging: 1–2 eligible wars, threat ≥ 70, 60+ hits per war. Core Regular: 80%+ participation. Regular: 60%+. Surge Fighter: below 60% but hits hard when present. Sporadic: 30–60%. Low Participation: under 30%. New: no analysed wars since joining.</li>
    <li><b>Eligibility</b> uses Torn's days-in-faction, which restarts if someone leaves and rejoins, so any hit (or appearing in a war report) also proves they were there.</li>
    <li><b>Momentum</b> comes from Torn's historical personal stats (one snapshot per day, as of the requested date). Time played is in seconds, shown here as hours.</li>
    <li>Sources: Torn's official API (ranked war and chain reports, faction members, personal stats) and FFScouter (estimated battle stats${M.hasFfs ? ', activity scanner, stat history' : ''}; <a href="https://ffscouter.com" target="_blank" rel="noopener">ffscouter.com</a>). Historical indicators change; use them alongside live status and judgement.</li>
  </ul>`)}`;
}

const IR_DOC_CSS = `
  *{box-sizing:border-box} body{margin:0;font:13px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif;color:#18202c;background:#fff}
  main{max-width:1500px;margin:0 auto;padding:22px 26px 40px}
  h1{font-size:30px;margin:0;letter-spacing:.5px} h1 small{display:block;font-size:22px;color:#9b1c31;letter-spacing:0;margin-top:2px}
  .ir-mark{height:40px;width:auto;float:right;margin:2px 0 0 12px}
  .ir-meta{color:#5b6472;font-size:12px;margin:4px 0 14px}
  .ir-fbanner{display:block;width:auto;max-width:100%;height:auto;border-radius:6px;margin:10px 0 2px}
  h2{font-size:17px;margin:0 0 4px;color:#9b1c31;text-transform:uppercase;letter-spacing:.4px} h3{font-size:14px;margin:14px 0 6px}
  .ir-sec{margin:20px 0}.ir-subtitle,.ir-note{color:#5b6472;font-size:12px;margin-bottom:8px}
  .ir-banner{display:grid;grid-template-columns:1fr 1fr;align-items:center;background:#9b1c31;color:#fff;border-radius:6px;overflow:hidden;margin:6px 0 14px}
  .ir-banner>div{padding:10px 14px;font-weight:600;text-transform:uppercase;font-size:12px}.ir-banner .ir-level{background:#18202c;font-size:18px}
  .ir-banner .ir-why{grid-column:1/3;background:#f4e7ea;color:#18202c;text-transform:none;font-weight:400}
  .lvl-low .ir-level,.lvl-strong .ir-level,.lvl-good .ir-level{background:#166534}.lvl-fair .ir-level{background:#b45309}.lvl-poor .ir-level{background:#7f1d1d}.lvl-moderate .ir-level{background:#18202c}.lvl-high .ir-level{background:#b45309}.lvl-severe .ir-level{background:#7f1d1d}
  .ir-tiles{display:grid;grid-template-columns:repeat(4,1fr);gap:0;border:1px solid #d9dee6;margin:8px 0}
  .ir-tile{padding:8px 10px;border:1px solid #e4e8ee;background:#f4f6f9}.ir-k{font-size:11px;color:#5b6472;font-weight:600}.ir-v{font-size:19px;font-weight:700}.ir-sub{font-size:11px;color:#5b6472;font-weight:400}
  .ir-list{margin:0;padding-left:18px}.ir-list li{margin:3px 0}.ir-notes{font-size:12px}
  .ir-hh{background:#f4e7ea;border-left:4px solid #9b1c31;padding:6px 10px;margin:4px 0}
  .ir-wrap{overflow-x:auto} table.ir-t{border-collapse:collapse;width:100%;font-size:12px}
  .ir-t th{background:#18202c;color:#fff;text-align:left;padding:5px 6px;font-weight:600;white-space:nowrap}
  .ir-t td{padding:4px 6px;border-bottom:1px solid #e4e8ee;vertical-align:top}.ir-t tbody tr:nth-child(even) td{background:#f7f8fa}
  .num{text-align:right;font-variant-numeric:tabular-nums}.ir-mini{font-size:10px;color:#6b7280}
  .ir-role{font-size:11px;padding:1px 6px;border-radius:9px;background:#eef1f5;white-space:nowrap}
  .r-heavy{background:#fde2e2;color:#991b1b}.r-core{background:#e0ecff;color:#1e40af}.r-surge{background:#fff1d6;color:#92400e}.r-reg{background:#e6f4ea;color:#166534}.r-new{background:#ede9fe;color:#5b21b6}.r-low{background:#eef1f5;color:#4b5563}
  .ir-res.win{color:#166534;font-weight:700}.ir-res.loss{color:#991b1b;font-weight:700}
  .ir-callout{background:#f4e7ea;border-left:4px solid #9b1c31;padding:8px 12px;margin-top:8px}
  .ir-cols{display:grid;grid-template-columns:minmax(300px,1fr) 2fr;gap:16px;align-items:start}.ir-small{width:auto}
  .ir-svg{width:100%;height:190px}.ir-grid{stroke:#e4e8ee}.ir-axis{font-size:11px;fill:#6b7280}.ir-line{stroke:#2563eb;stroke-width:2}
  .ir-chart-title{font-size:12px;font-weight:600;margin:8px 0 4px;color:#374151}
  table.ir-hm{border-collapse:collapse;font-size:10px}.ir-hm th{font-weight:600;color:#6b7280;padding:1px 3px}.ir-hm td{width:30px;height:20px;text-align:center;border:1px solid #fff}
  .ir-hm-empty{background:#f3f4f6}.ir-hmt td{text-align:center}
  .ir-tools{display:flex;gap:10px;align-items:center;margin:4px 0 6px}.ir-filter{width:340px;padding:5px 8px;border:1px solid #cbd2dc;border-radius:5px;font:inherit}.ir-count{color:#6b7280;font-size:12px}
  .ir-t th[data-k]{cursor:pointer;user-select:none}.ir-t th.asc::after{content:" ▲"}.ir-t th.desc::after{content:" ▼"}
  .ir-foot{margin-top:24px;color:#9b1c31;font-style:italic;text-align:center;font-size:12px}
  a{color:#1d4ed8;text-decoration:none}
  @media print{.ir-tools{display:none}.ir-break{break-before:page}.ir-sec{break-inside:auto}.ir-t tr{break-inside:avoid}.ir-wrap{overflow:visible} main{max-width:none;padding:0}}
`;

// Sorting and filtering for tables (used in the app and embedded in the exported .html).
function irEnhance(root) {
  const val = td => {
    const v = td.getAttribute('data-v');
    if (v !== null && v !== '' && !isNaN(Number(v))) return Number(v);
    if (v === '') return null;
    return (v !== null ? v : td.textContent).trim().toLowerCase();
  };
  root.addEventListener('click', e => {
    const th = e.target.closest('table.ir-t th[data-k]');
    if (!th) return;
    const table = th.closest('table');
    const idx = [...th.parentNode.children].indexOf(th);
    const dir = th.classList.contains('desc') ? 1 : th.classList.contains('asc') ? -1 : (th.getAttribute('data-k') === 'text' ? 1 : -1);
    table.querySelectorAll('th').forEach(x => x.classList.remove('asc', 'desc'));
    th.classList.add(dir === 1 ? 'asc' : 'desc');
    const body = table.tBodies[0];
    const rows = [...body.rows];
    rows.sort((a, b) => {
      const x = val(a.cells[idx]), y = val(b.cells[idx]);
      if (x === null && y === null) return 0;
      if (x === null) return 1;
      if (y === null) return -1;
      return (x < y ? -1 : x > y ? 1 : 0) * dir;
    });
    rows.forEach(r => body.appendChild(r));
  });
  root.addEventListener('input', e => {
    const f = e.target.closest('.ir-filter');
    if (!f) return;
    const table = document.getElementById(f.getAttribute('data-for'));
    if (!table) return;
    const words = f.value.toLowerCase().split(/\s+/).filter(Boolean);
    let shown = 0;
    for (const r of table.tBodies[0].rows) {
      const t = r.textContent.toLowerCase();
      const ok = words.every(w => t.includes(w));
      r.style.display = ok ? '' : 'none';
      if (ok) shown++;
    }
    const c = document.querySelector(`[data-count-for="${f.getAttribute('data-for')}"]`);
    if (c) c.textContent = words.length ? `${shown} of ${table.tBodies[0].rows.length} rows` : '';
  });
}

// The Mentat symbol for exported reports (embedded, so the files stand alone).
const IR_MARK = 'data:image/png;base64,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';

function irDocument(M, mode) {
  const title = M.self ? `Faction War Performance: ${M.name}` : `Enemy Historical Intelligence: ${M.name}`;
  const head = `<h1>${mode === 'app' ? '' : `<img class="ir-mark" src="${IR_MARK}" alt="Mentat">`}${M.self ? 'FACTION WAR PERFORMANCE REPORT' : 'ENEMY HISTORICAL INTELLIGENCE REPORT'}<small>${esc(M.name)}${M.tag ? ` [${esc(M.tag)}]` : ''}</small></h1>
    ${M.banner && mode !== 'app' && avatarsOn() ? `<img class="ir-fbanner" src="https://factionimages.torn.com/${encodeURIComponent(M.banner)}" alt="">` : ''}
    <div class="ir-meta">${M.wars.length} ranked wars analysed${M.rank ? ` · rank ${esc(M.rank)}` : ''} · ${M.rosterSize} current members · generated ${irTct(M.now)}${M.by ? ` · prepared by ${esc(M.by)}` : ''} · Mentat${mode === 'html' ? ' · click a column heading to sort, type in a box to filter' : ''}</div>`;
  const script = mode === 'html' ? `<script>(${irEnhance.toString()})(document);</script>` : '';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)}</title><style>${IR_DOC_CSS}</style></head>
<body><main>${head}${irBody(M, mode)}<div class="ir-foot">${M.self ? 'FACTION INTERNAL · Historical indicators can change. Use alongside what you know about your members.' : 'CONFIDENTIAL WAR INTELLIGENCE · Historical indicators can change. Use alongside live status, current battle-stat intelligence and officer judgement.'}</div></main>${script}</body></html>`;
}

function irCsv(M) {
  const q = v => (v == null ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  const head = ['id', 'name', 'role', 'war_threat', 'est_battle_stats', 'level', 'days_in_faction', 'eligible_wars', 'active_wars', 'participation', 'no_show', 'avg_hits_per_war', 'avg_hits_when_active',
    'peak_hits', 'avg_hits_wins', 'avg_hits_losses', 'hit_share', 'total_hits', 'total_score', 'score_per_hit', 'consistency', 'trend', 'revivable',
    'chains', 'chain_sat_out', 'chain_hits', 'chain_war_hits', 'assists', 'retaliations', 'hits_abroad', 'losses', 'escapes', 'respect_per_hit',
    'est_growth_10wk', 'est_growth_4wk', 'hours_per_week', 'hours_per_week_last2', 'xanax_per_week', 'refills_per_week', 'cans_per_week', 'se_per_week', 'attacks_won_per_week', 'rw_hits_per_week', 'active_streak',
    'usual_hours_tct', 'active_share', ...IR_BLOCKS.map(b => `active_${b.replace('–', '_')}`), 'wars_elsewhere'];
  const lines = [head.join(',')];
  for (const m of M.members) {
    const c = m.chain || {}, x = m.momentum || {}, a = m.activity || {};
    lines.push([m.id, m.name, m.role, m.threat, m.est, m.level, m.days, m.eligible, m.active, m.participation, m.noShow, m.avgWar, m.avgActive,
      m.peak, m.avgWin, m.avgLoss, m.share, m.hits, m.score, m.perHit, m.consistency, m.trend, m.revivable ? 'yes' : 'no',
      c.chains, m.sitOuts, c.total, c.war, c.assists, c.retals, c.overseas, c.losses, c.escapes, c.total ? c.respect / c.total : null,
      m.growth10, m.growth4, x.hours, x.hoursRecent, x.xan, x.refills, x.cans, x.se, x.attacks, x.rwhits, x.streak,
      a.usual, a.share, ...(a.blocks || new Array(12).fill(null)), m.prior.map(p => `${p.factionName}: ${p.attacks} hits vs ${p.opp}`).join('; ')]
      .map(v => (typeof v === 'number' ? (Number.isInteger(v) ? v : v.toFixed(4)) : v)).map(q).join(','));
  }
  return lines.join('\r\n');
}

// ---------------------------------------------------------------- scouting view
function irScoutView(V, mode = 'app') {
  if (!V || (!V.pool && !V.enabled)) {
    return `<div class="empty">Scouting is off on this PC. It collects activity history and war records for every faction around your rank, so a new opponent already has weeks of history.
      ${V && V.local !== false ? '<div style="margin-top:10px"><button class="primary" data-sc-enable="1">Turn on scouting on this PC</button></div><div class="muted small" style="margin-top:6px">Best run on a sync server (Settings → Data source), which scouts 24/7.</div>' : ''}</div>`;
  }
  const pool = [...(V.pool || [])];
  const sortKey = prefs.get('scout.sort', 'position');
  const dir = prefs.get('scout.dir', 1);
  const ownPos = V.own ? V.own.position : 0;
  const get = {
    position: f => Math.abs((f.position || 0) - ownPos), name: f => (f.name || '').toLowerCase(), members: f => f.members || 0, lastWar: f => f.lastWar || 0,
    wl: f => (f.record ? f.record.wins / Math.max(1, f.record.wins + f.record.losses) : null), avg: f => (f.record ? f.record.avgHits : null),
    hitters: f => (f.record ? f.record.hitters : null), top5: f => (f.record ? f.record.top5 : null), history: f => (f.firstAt ? Date.now() - f.firstAt : 0),
  }[sortKey] || (f => f.position);
  pool.sort((a, b) => { const x = get(a), y = get(b); if (x == null && y == null) return 0; if (x == null) return 1; if (y == null) return -1; return (x < y ? -1 : x > y ? 1 : 0) * dir; });
  const th = (k, l, cls = '') => `<th class="${cls} rs-sort ${sortKey === k ? 'sorted' : ''}" data-sc-sort="${k}">${l}${sortKey === k ? (dir === 1 ? ' ▲' : ' ▼') : ''}</th>`;
  const days = ms => { if (!ms) return '–'; const h = (Date.now() - ms) / 3600e3; return h < 48 ? `${Math.max(0, Math.round(h))} h` : `${Math.round(h / 24)} d`; };
  const groups = (V.groups || []).map(g => `<span class="pill ${g.own ? 'info' : ''}">${esc(g.rank)} · ${g.count}</span>`).join(' ');
  return `<div class="war-card">
      <div class="row between wrap"><div class="war-title">Scouting pool${V.own ? `: around ${esc(V.own.rank)}` : ''}</div>
        <span class="muted small">${V.fromServer ? '<span class="sync-badge">from your server</span> · ' : ''}${pool.length} factions · each checked every ${Math.round((V.interval || 0) / 60000)} min · ${num(V.samplesLastHour || 0)} checks in the last hour · ${V.perMinute}/min budget</span></div>
      <div class="muted small" style="margin-top:4px">Rank groups watched (yours ± ${V.spread}): ${groups || '–'} · ladder ${V.ladderAt ? fmtAgo(V.ladderAt) : 'not read yet'} · ${num(V.indexWars || 0)} ranked wars in the last 30 days indexed${V.indexAt ? ` (${fmtAgo(V.indexAt)})` : ''}</div>
      <div class="muted small">Activity history: ${V.activity ? `${V.activity.days} day${V.activity.days === 1 ? '' : 's'}${V.activity.first ? ` since ${esc(V.activity.first)}` : ''}, ${num(V.activity.players)} players` : '–'} · war archive: ${V.archive ? `${num(V.archive.rankedWars)} war reports, ${num(V.archive.chains)} chain reports` : '–'}${V.pendingReports ? ` · ${num(V.pendingReports)} reports to fetch` : ''}</div>
      ${V.error || V.ladderError ? `<div class="neg small">${esc(V.error || V.ladderError)}</div>` : ''}
      <div class="row wrap" style="gap:8px;margin-top:8px">
        <label class="small">Rank groups either side <select data-sc-spread>${[0, 1, 2, 3, 4].map(n => `<option value="${n}" ${n === V.spread ? 'selected' : ''}>${n}</option>`).join('')}</select></label>
        ${V.local && !V.fromServer ? `<label class="small">Requests / minute <input type="number" min="2" max="15" value="${V.perMinute}" data-sc-rate style="width:60px"></label><button data-sc-enable="0">Turn off on this PC</button>` : ''}
      </div>
    </div>
    <div class="table-wrap"><table class="data rs-table">
      <tr>${th('name', 'Faction')}${th('position', 'Rank')}${th('members', 'Members', 'num')}${th('lastWar', 'Last war')}${th('wl', 'W–L (last 10)', 'num')}${th('avg', 'Avg hits / war', 'num')}${th('hitters', 'Hitters / war', 'num')}${th('top5', 'Top-5 share', 'num')}${th('history', 'Activity history', 'num')}<th></th></tr>
      ${pool.map(f => { const r = f.record; return `<tr>
        <td>${link(`https://www.torn.com/factions.php?step=profile&ID=${f.id}`, esc(f.name || f.id))}${f.running ? ' <span class="pill warn">at war</span>' : ''}</td>
        <td class="small">${esc(f.rank || '')}${f.rank && V.own && f.rank === V.own.rank ? ' <span class="pill info">yours</span>' : ''}</td><td class="num">${f.members || '–'}</td>
        <td class="small">${f.lastWar ? fmtAgo(f.lastWar) : '–'}${r && r.lastOpp ? `<div class="muted small">vs ${esc(r.lastOpp)}</div>` : ''}</td>
        <td class="num">${r && r.wars ? `${r.wins}–${r.losses}` : '<span class="muted small">loading</span>'}</td>
        <td class="num">${r && r.avgHits != null ? Math.round(r.avgHits) : '–'}</td><td class="num">${r && r.hitters != null ? r.hitters.toFixed(1) : '–'}</td>
        <td class="num">${r && r.top5 != null ? `${Math.round(r.top5 * 100)}%` : '–'}</td>
        <td class="num">${f.firstAt ? days(f.firstAt) : '–'}<div class="muted small">${num(f.samples || 0)} checks</div></td>
        <td>${mode === 'app' && S.features.research && S.features.research.canPick === false ? '' : `<button data-sc-research="${f.id}" title="Research this faction: full war record, momentum and activity report">Research</button>`}</td></tr>`; }).join('')}
    </table></div>
    <div class="note">The pool is rebuilt from Torn's rank ladder every day (and after each of your wars), so factions that move up or down join or leave it automatically. Activity history is kept per player, so it follows people between factions.</div>
    ${V.log && V.log.length ? `<div class="note">${V.log.slice().reverse().map(l => `${fmtAgo(l[0])}: ${esc(l[1])}`).join('<br>')}</div>` : ''}`;
}
