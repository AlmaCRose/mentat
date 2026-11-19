'use strict';
/* global irModel, irBody, irDocument, irCsv, irEnhance, irScoutView, S, $, panel, esc, num, cmd, money, signClass, tct, ago, fmtAgo, link, profileUrl, prefs, lineChart, CHART_COLORS,
   estBand, ratioText, renderSafe */
// Oppo research: the enemy faction (from the moment a war is announced) compared with yours.

const RS_DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const RS_DAY_INDEX = [1, 2, 3, 4, 5, 6, 0]; // UTC getDay() order for Mon..Sun
const compact = n => {
  if (n == null || !Number.isFinite(n)) return '–';
  const a = Math.abs(n);
  if (a >= 1e12) return `${(n / 1e12).toFixed(2)}t`;
  if (a >= 1e9) return `${(n / 1e9).toFixed(2)}b`;
  if (a >= 1e6) return `${(n / 1e6).toFixed(a >= 1e8 ? 0 : 1)}m`;
  if (a >= 1e4) return `${(n / 1e3).toFixed(0)}k`;
  return num(Math.round(n));
};
const median = xs => { const s = xs.filter(x => Number.isFinite(x)).sort((a, b) => a - b); if (!s.length) return null; const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const sum = xs => xs.reduce((a, b) => a + (Number.isFinite(b) ? b : 0), 0);

// Latest personal stats and a per-day pace (needs two samples ~a day apart).
function personal(rec, id) {
  const list = (rec.personal && rec.personal[id]) || [];
  if (!list.length) return null;
  const last = list[list.length - 1];
  const first = list.find(x => last.at - x.at >= 20 * 3600e3) ? list[0] : null;
  const pace = {};
  if (first && first !== last) {
    const days = (last.at - first.at) / 86400e3;
    for (const k of ['xanax', 'refills', 'ses', 'cans', 'attacksWon', 'rwHits', 'revives', 'activity']) {
      if (Number.isFinite(last.s[k]) && Number.isFinite(first.s[k])) pace[k] = (last.s[k] - first.s[k]) / days;
    }
  }
  return { s: last.s, at: last.at, pace, days: first ? (last.at - first.at) / 86400e3 : 0 };
}

// Typical active hours (TCT) for one member: the busiest 3-hour window across the week.
function usualHours(a) {
  if (!a) return null;
  const byHour = new Array(24).fill(0);
  for (let i = 0; i < 168; i++) byHour[i % 24] += (a.actions[i] || 0) + (a.active[i] || 0);
  const total = sum(byHour);
  if (total < 3) return null;
  let best = 0, at = 0;
  for (let h = 0; h < 24; h++) { const v = byHour[h] + byHour[(h + 1) % 24] + byHour[(h + 2) % 24]; if (v > best) { best = v; at = h; } }
  return { from: at, to: (at + 3) % 24, share: best / total };
}

// Average members active per hour of the week (Mon..Sun × 0..23 TCT).
// factionHours counts one sample per member per check, so active/samples is the share of
// members online; times the member count gives how many were online on average.
function hourGrid(rec) {
  const f = rec.factionHours;
  const n = Math.max(1, Object.keys(rec.members).length);
  return RS_DAY_INDEX.map(d => Array.from({ length: 24 }, (_, h) => {
    const i = d * 24 + h;
    return f.samples[i] ? { avg: (f.active[i] / f.samples[i]) * n, samples: f.samples[i] / n, actions: f.actions[i] } : null;
  }));
}

function heatmap(rec, label, maxAvg) {
  const g = hourGrid(rec);
  const cell = (v, d, h) => {
    if (!v) return `<td class="hm-empty" title="${RS_DAYS[d]} ${String(h).padStart(2, '0')}:00 TCT: no samples yet"></td>`;
    const pct = maxAvg ? Math.min(1, v.avg / maxAvg) : 0;
    return `<td style="background:color-mix(in srgb, var(--blue) ${Math.round(6 + pct * 84)}%, var(--bg-2))" title="${esc(label)} · ${RS_DAYS[d]} ${String(h).padStart(2, '0')}:00 TCT: ${v.avg.toFixed(1)} online on average (${Math.round(v.samples)} checks)">${v.avg >= 0.5 ? Math.round(v.avg) : ''}</td>`;
  };
  return `<table class="heatmap"><tr><th></th>${Array.from({ length: 24 }, (_, h) => `<th>${h % 3 === 0 ? String(h).padStart(2, '0') : ''}</th>`).join('')}</tr>
    ${g.map((row, d) => `<tr><th>${RS_DAYS[d]}</th>${row.map((v, h) => cell(v, d, h)).join('')}</tr>`).join('')}</table>`;
}

const avgAt = (rec, i) => (rec.factionHours.samples[i] ? (rec.factionHours.active[i] / rec.factionHours.samples[i]) * Math.max(1, Object.keys(rec.members).length) : null);
const hourLabel = i => `${RS_DAYS[RS_DAY_INDEX.indexOf(Math.floor(i / 24))]} ${String(i % 24).padStart(2, '0')}:00`;

// Stat spread: counts per range, both factions, side by side.
const BS_BUCKETS = [[1e10, '10b+'], [1e9, '1b–10b'], [1e8, '100m–1b'], [1e7, '10m–100m'], [1e6, '1m–10m'], [1e5, '100k–1m'], [1e4, '10k–100k'], [0, 'under 10k']];
const LVL_BUCKETS = [[80, '80–100'], [60, '60–79'], [40, '40–59'], [20, '20–39'], [0, '1–19']];
function butterfly(rows, themLabel, usLabel) {
  const max = Math.max(1, ...rows.map(r => Math.max(r.them, r.us)));
  return `<table class="butterfly"><tr><th class="num">${esc(themLabel)}</th><th></th><th>${esc(usLabel)}</th></tr>
    ${rows.map(r => `<tr><td class="bf-left"><span class="bf-n">${r.them || ''}</span><span class="bf-bar them" style="width:${(r.them / max) * 82}%"></span></td>
      <td class="bf-label">${esc(r.label)}</td>
      <td class="bf-right"><span class="bf-bar us" style="width:${(r.us / max) * 82}%"></span><span class="bf-n">${r.us || ''}</span></td></tr>`).join('')}</table>`;
}

const PS_ROWS = [
  ['xanax', 'Xanax taken'], ['refills', 'Energy refills'], ['ses', 'Stat enhancers used'], ['cans', 'Energy drinks'], ['boosters', 'Boosters used'],
  ['attacksWon', 'Attacks won'], ['attacksLost', 'Attacks lost'], ['defendsWon', 'Defends won'], ['defendsLost', 'Defends lost'], ['elo', 'Elo rating'],
  ['rwHits', 'Ranked war hits'], ['respect', 'Respect earned'], ['bestDamage', 'Best damage'], ['killstreak', 'Best kill streak'],
  ['reviveSkill', 'Revive skill'], ['revives', 'Revives given'], ['activity', 'Time played'], ['streak', 'Login streak (days)'],
  ['networth', 'Net worth'], ['rwWins', 'Ranked war wins'],
];
const PACE_ROWS = [['xanax', 'Xanax / day'], ['refills', 'Energy refills / day'], ['ses', 'Stat enhancers / day'], ['cans', 'Energy drinks / day'], ['attacksWon', 'Attacks won / day'], ['rwHits', 'Ranked war hits / day'], ['activity', 'Time played / day']];
const fmtPs = (k, v) => (v == null ? '–' : k === 'activity' ? `${compact(v / 3600)} h` : k === 'networth' ? money(v, true) : k === 'elo' || k === 'reviveSkill' ? num(Math.round(v)) : compact(v));

let rsLastKey = '';
const rsAutoIntel = new Set();

function renderResearch() {
  const el = panel('research');
  if (!el || !el.classList.contains('active')) return;
  const R = S.features.research;
  const view = navView('research');
  const views = navSubnav('research', 'rs-view', 'margin:0');
  if (view === 'scout') {
    const key = `scout|${navSig()}|${JSON.stringify(S.features.scout || null).length}|${(S.features.scout || {}).at || 0}|${prefs.get('scout.sort', 'position')}|${prefs.get('scout.dir', 1)}`;
    if (key === rsLastKey && el.firstChild) return;
    rsLastKey = key;
    el.innerHTML = `<div class="toolbar">${views}</div>${irScoutView(S.features.scout)}`;
    return;
  }
  if (!S.api.hasKey && !(R && R.fromServer)) { rsLastKey = ''; el.innerHTML = `<div class="toolbar">${views}</div><div class="empty">Add your Torn API key in Settings to use Oppo research.</div>`; return; }
  if (!R) { el.innerHTML = '<div class="empty">Loading…</div>'; return; }
  const targets = R.tracked.filter(t => !t.own);
  const ownT = R.tracked.find(t => t.own);
  const sel = targets.find(t => t.id === Number(prefs.get('research.sel', 0))) || targets[0];
  const them = sel && R.factions[sel.id];
  const us = ownT && R.factions[ownT.id];
  const ffs = S.features.ffscouter || {};
  const stats = ffs.stats || {};
  const mine = (S.features.war && S.features.war.myStats && S.features.war.myStats.total) || 0;
  const head = `<div class="toolbar">
      ${views}
      ${targets.length > 1 ? `<div class="subnav" style="margin:0">${targets.map(t => `<button data-rs-sel="${t.id}" class="${sel && t.id === sel.id ? 'active' : ''}">${esc((R.factions[t.id] && R.factions[t.id].name) || t.name || t.id)}</button>`).join('')}</div>` : ''}
      <span class="spacer"></span>
      ${them && view === 'overview' ? `<button data-rs-export="image" title="Copy a one-card summary image to paste into Discord">Copy overview image</button>
      <button class="primary" data-rs-export="all" title="Save the full report (.html, opens in any browser), the overview image (.png) and the member table (.csv)">Export report…</button>` : ''}
      ${them && view === 'report' ? '<button class="primary" data-ir-export title="Save the report as a PDF, plus an interactive .html (sortable, filterable tables) and a .csv">Export PDF + HTML…</button>' : ''}
      <form class="row" data-rs-form><input name="fid" type="number" min="1" placeholder="Faction ID" style="width:110px" value="${R.watchId || ''}"><button>Research faction</button>${R.watchId ? '<button type="button" data-rs-watch="0">Stop</button>' : ''}</form>
    </div>`;
  const top = them ? factionBanner(them.basic && them.basic.bannerImage, 'fbanner-top') : '';
  if (view === 'report' && them) { renderReport(el, top + head, { R, sel, them, us, ffs, stats }); return; }
  rsLastKey = '';
  if (!them) {
    el.innerHTML = `${head}<div class="empty">No research running. It starts by itself as soon as your faction's next war is announced (it collects in the background until the war is over). You can also research any faction by ID above.</div>`;
    return;
  }
  const v = researchView({ R, sel, them, us, ffs, stats, mine, board: prefs.get('research.board', 'them'), sortKey: prefs.get('research.sort', 'stats'), dir: prefs.get('research.dir', -1) });
  el.innerHTML = top + head + v.html;
  drawOnlineChart($('#rs-online'), v);
}

function drawOnlineChart(host, v, width) {
  if (!host) return;
  if (width) host.style.width = `${width}px`;
  lineChart(host, { series: v.series, yFmt: x => String(Math.round(x)), yZero: true, empty: 'Builds up as checks come in (every 5 minutes).' });
}

// Everything the research screen and the export show, built once. exportMode leaves out
// the app's controls and includes both factions' dossiers.
function researchView({ R, sel, them, us, ffs, stats, mine, board, sortKey, dir, exportMode = false }) {
  const tm = Object.values(them.members);
  const um = us ? Object.values(us.members) : [];
  const tName = them.name || sel.name, uName = (us && us.name) || 'You';
  const hours = (Date.now() - them.startedAt) / 3600e3;
  const coverage = them.factionHours.samples.filter(Boolean).length;
  const psDone = tm.filter(m => them.personal[m.id] && them.personal[m.id].length).length;

  // ---- Faction vs faction ----
  const b = them.basic || {}, ub = (us && us.basic) || {};
  const wl = rec => { const ws = (rec && rec.history && rec.history.wars) || []; const w = ws.filter(x => x.winner === rec.id).length; return ws.length ? `${w}–${ws.filter(x => x.winner && x.winner !== rec.id).length}` : '–'; };
  const chains30 = rec => ((rec && rec.history && rec.history.chains) || []).filter(c => Date.now() - c.end < 30 * 86400e3);
  const facRows = [
    ['Respect', b.respect, ub.respect, compact], ['Rank', b.rank, ub.rank, v => esc(v || '–')], ['Members', b.members ? `${b.members} / ${b.capacity}` : tm.length, ub.members ? `${ub.members} / ${ub.capacity}` : um.length, v => esc(String(v))],
    ['Best chain', b.bestChain, ub.bestChain, num], ['Faction age (days)', b.daysOld, ub.daysOld, num],
    ['Last 20 ranked wars (W–L)', wl(them), wl(us), v => v], ['Chains in the last 30 days', chains30(them).length, chains30(us).length, num],
    ['Longest chain, last 30 days', Math.max(0, ...chains30(them).map(c => c.length)), Math.max(0, ...chains30(us).map(c => c.length)), num],
  ];

  // ---- Stat spread ----
  const bsOf = m => (stats[m.id] && stats[m.id].bs) || 0;
  const tBs = tm.map(bsOf).filter(Boolean), uBs = um.map(bsOf).filter(Boolean);
  const bucket = (list, buckets) => buckets.map(([min], i) => list.filter(v => v >= min && (i === 0 || v < buckets[i - 1][0])).length);
  const tb = bucket(tBs, BS_BUCKETS), ubk = bucket(uBs, BS_BUCKETS);
  const statRows = BS_BUCKETS.map(([, label], i) => ({ label, them: tb[i], us: ubk[i] }));
  const top5 = l => { const s = [...l].sort((a, c) => c - a).slice(0, 5); return s.length ? sum(s) / s.length : null; };
  const tl = bucket(tm.map(m => m.level), LVL_BUCKETS), ul = bucket(um.map(m => m.level), LVL_BUCKETS);
  const lvlRows = LVL_BUCKETS.map(([, label], i) => ({ label, them: tl[i], us: ul[i] }));
  const bandsVsMe = mine ? tm.reduce((acc, m) => { const v = bsOf(m); if (!v) return acc; const r = v / mine; acc[r > 1.1 ? 'stronger' : r >= 0.9 ? 'even' : 'weaker']++; return acc; }, { weaker: 0, even: 0, stronger: 0 }) : null;

  // ---- Activity ----
  const tAvg = Array.from({ length: 168 }, (_, i) => avgAt(them, i));
  const uAvg = Array.from({ length: 168 }, (_, i) => (us ? avgAt(us, i) : null));
  const maxAvg = Math.max(1, ...tAvg.filter(v => v != null), ...uAvg.filter(v => v != null));
  const ranked = tAvg.map((v, i) => ({ i, v })).filter(x => x.v != null);
  const peak = [...ranked].sort((a, c) => c.v - a.v).slice(0, 5);
  const quiet = [...ranked].sort((a, c) => a.v - c.v).slice(0, 5);
  const edge = ranked.filter(x => uAvg[x.i] != null).map(x => ({ i: x.i, d: uAvg[x.i] - x.v, u: uAvg[x.i], t: x.v })).sort((a, c) => c.d - a.d).slice(0, 5);
  const inactive = tm.filter(m => m.lastAt && Date.now() - m.lastAt > 3 * 86400e3).length;

  // ---- Personal stats ----
  const tP = tm.map(m => personal(them, m.id)).filter(Boolean), uP = um.map(m => personal(us, m.id)).filter(Boolean);
  const col = (list, k) => list.map(p => p.s[k]).filter(v => Number.isFinite(v));
  const paceCol = (list, k) => list.map(p => p.pace[k]).filter(v => Number.isFinite(v));
  const revivers = list => list.filter(p => (p.s.reviveSkill || 0) >= 50 || (p.s.revives || 0) >= 500).length;

  // ---- Dossiers ----
  const dossierRows = rec => {
    const rows = Object.values(rec.members).map(m => {
      const a = rec.activity[m.id];
      const p = personal(rec, m.id);
      const onlinePct = a ? (sum(a.active) / Math.max(1, sum(a.samples))) : null;
      return { m, p, uh: usualHours(a), onlinePct, bs: bsOf(m) };
    });
    const sv = {
      name: r => r.m.name.toLowerCase(), level: r => r.m.level, stats: r => r.bs || null, online: r => r.onlinePct, last: r => r.m.lastAt,
      xanax: r => r.p && r.p.s.xanax, refills: r => r.p && r.p.s.refills, pace: r => r.p && r.p.pace.xanax, elo: r => r.p && r.p.s.elo,
      rw: r => r.p && r.p.s.rwHits, revives: r => r.p && r.p.s.revives, streak: r => r.p && r.p.s.streak,
    };
    const get = sv[sortKey] || sv.stats;
    rows.sort((x, y) => { const a = get(x), c = get(y); if (a == null && c == null) return 0; if (a == null) return 1; if (c == null) return -1; return (a < c ? -1 : a > c ? 1 : 0) * dir; });
    return rows;
  };
  const th = (k, l, cls = '') => (exportMode ? `<th class="${cls}">${l}</th>`
    : `<th class="${cls} rs-sort ${sortKey === k ? 'sorted' : ''}" data-rs-sort="${k}">${l}${sortKey === k ? (dir === 1 ? ' ▲' : ' ▼') : ''}</th>`);
  const dossierTable = rec => `<div class="table-wrap"><table class="data rs-table">
      <tr>${th('name', 'Member')}${th('level', 'Lvl', 'num')}${th('stats', 'Est. stats', 'num')}<th>Usual hours</th>${th('online', 'Online', 'num')}${th('last', 'Last seen')}${th('xanax', 'Xanax', 'num')}${th('pace', 'Xan/day', 'num')}${th('refills', 'Refills', 'num')}${th('elo', 'Elo', 'num')}${th('rw', 'RW hits', 'num')}${th('revives', 'Revives', 'num')}${th('streak', 'Streak', 'num')}</tr>
      ${dossierRows(rec).map(r => { const band = r.bs && mine ? estBand(r.bs, mine) : null; return `<tr>
        <td>${avatar(r.m.id)}${link(profileUrl(r.m.id), esc(r.m.name))}<div class="muted small">${esc(r.m.position || '')}</div></td>
        <td class="num">${r.m.level}</td>
        <td class="num">${r.bs ? `<span class="est ${band ? band.cls : ''}" title="${band ? `${ratioText(band.ratio)} of yours` : ''}">${compact(r.bs)}</span>` : '<span class="muted">–</span>'}</td>
        <td>${r.uh ? `${String(r.uh.from).padStart(2, '0')}–${String(r.uh.to).padStart(2, '0')} TCT <span class="muted small">(${Math.round(r.uh.share * 100)}%)</span>` : '<span class="muted small">collecting</span>'}</td>
        <td class="num">${r.onlinePct == null ? '–' : `${Math.round(r.onlinePct * 100)}%`}</td>
        <td>${r.m.lastAt ? (exportMode ? `${new Date(r.m.lastAt).toISOString().slice(5, 16).replace('T', ' ')} TCT` : fmtAgo(r.m.lastAt)) : '–'}</td>
        <td class="num">${r.p ? compact(r.p.s.xanax) : '–'}</td>
        <td class="num">${r.p && Number.isFinite(r.p.pace.xanax) ? r.p.pace.xanax.toFixed(1) : '–'}</td>
        <td class="num">${r.p ? compact(r.p.s.refills) : '–'}</td>
        <td class="num">${r.p ? num(r.p.s.elo || 0) : '–'}</td>
        <td class="num">${r.p ? compact(r.p.s.rwHits) : '–'}</td>
        <td class="num">${r.p ? compact(r.p.s.revives) : '–'}</td>
        <td class="num">${r.p ? num(r.p.s.streak || 0) : '–'}</td></tr>`; }).join('')}
    </table></div>`;

  const html = `
    <div class="war-card">
      ${exportMode ? factionBanner(b.bannerImage) : ''}<div class="row between wrap"><div class="war-title">Researching ${factionTag(b.tagImage)}${link(`https://www.torn.com/factions.php?step=profile&ID=${them.id}`, esc(tName))}${b.tag ? ` <span class="muted">[${esc(b.tag)}]</span>` : ''}</div>
        <span class="muted small">${esc(sel.why)} · collecting for ${hours >= 48 ? `${(hours / 24).toFixed(1)} days` : `${hours.toFixed(1)} h`} · ${num(them.samples || 0)} checks (every 5 min) · activity map ${Math.round(coverage / 1.68)}% filled · personal stats ${psDone}/${tm.length}${R.personalQueue ? ` (${R.personalQueue} to fetch, one every ${R.personalGapSec} s)` : ''}${R.fromServer && !exportMode ? ' · <span class="sync-badge" title="Collected by your sync server (Settings → Data source)">from your server</span>' : ''}</span></div>
      ${them.error ? `<div class="neg small">${esc(them.error)}</div>` : ''}
    </div>

    <div class="cols2">
      <div><h3>${esc(tName)} vs ${esc(uName)}</h3>
        <table class="data"><tr><th></th><th class="num">Them</th><th class="num">You</th></tr>
          ${facRows.map(([l, a, c, f]) => `<tr><td>${l}</td><td class="num">${a == null || a === '' ? '–' : f(a)}</td><td class="num">${c == null || c === '' ? '–' : f(c)}</td></tr>`).join('')}</table></div>
      <div><h3>Estimated battle stats</h3>
        ${ffs.hasKey ? `${butterfly(statRows, tName, uName)}
          <table class="data" style="margin-top:6px"><tr><th></th><th class="num">Them</th><th class="num">You</th></tr>
            <tr><td>Total</td><td class="num">${compact(sum(tBs))}</td><td class="num">${compact(sum(uBs))}</td></tr>
            <tr><td>Median member</td><td class="num">${compact(median(tBs))}</td><td class="num">${compact(median(uBs))}</td></tr>
            <tr><td>Top 5 average</td><td class="num">${compact(top5(tBs))}</td><td class="num">${compact(top5(uBs))}</td></tr>
            <tr><td>Estimates available</td><td class="num">${tBs.length}/${tm.length}</td><td class="num">${uBs.length}/${um.length}</td></tr></table>
          ${bandsVsMe ? `<div class="note">Against your own ${compact(mine)}: <span class="est est-b2">${bandsVsMe.weaker} weaker</span> <span class="est est-b0">${bandsVsMe.even} within 10%</span> <span class="est est-h2">${bandsVsMe.stronger} stronger</span></div>` : ''}`
          : '<div class="note">Add your FFScouter key in Settings to compare estimated battle stats.</div>'}
        <h3>Levels</h3>${butterfly(lvlRows, tName, uName)}</div>
    </div>

    <h3>Activity (online by hour, TCT)</h3>
    <div class="note" style="margin-top:0">Average members online in each hour of the week, from checks every 5 minutes plus their last-action times. Fills in over a week; darker = more online. Hover a cell for details.</div>
    <div class="cols2">
      <div><div class="chart-title">${esc(tName)}</div>${heatmap(them, tName, maxAvg)}</div>
      <div><div class="chart-title">${esc(uName)}</div>${us ? heatmap(us, uName, maxAvg) : '<div class="muted small">Your faction loads with the research.</div>'}</div>
    </div>
    <div class="grid3" style="margin:8px 0">
      <div class="stat"><div class="k">Their peak hours</div><div class="small">${peak.map(x => `${hourLabel(x.i)} <b>${x.v.toFixed(1)}</b>`).join('<br>') || 'collecting…'}</div></div>
      <div class="stat"><div class="k">Their quietest hours</div><div class="small">${quiet.map(x => `${hourLabel(x.i)} <b>${x.v.toFixed(1)}</b>`).join('<br>') || 'collecting…'}</div></div>
      <div class="stat"><div class="k">Your best hours (you vs them online)</div><div class="small">${edge.map(x => `${hourLabel(x.i)} <b class="${signClass(x.d)}">${x.d >= 0 ? '+' : ''}${x.d.toFixed(1)}</b> <span class="muted">(${x.u.toFixed(1)} vs ${x.t.toFixed(1)})</span>`).join('<br>') || 'collecting…'}</div></div>
    </div>
    <div class="note">${inactive} of ${tm.length} members haven't been active for 3+ days.</div>
    <div class="chart-title">Online now and over time</div><div id="rs-online"></div>

    <h3>Personal stats (public)</h3>
    ${tP.length ? `<table class="data"><tr><th></th><th class="num">Their median</th><th class="num">Your median</th><th class="num">Their best</th><th class="num">Your best</th><th class="num">Their total</th></tr>
      ${PS_ROWS.map(([k, l]) => { const a = col(tP, k), c = col(uP, k); const ma = median(a), mc = median(c); return `<tr><td>${l}</td><td class="num">${fmtPs(k, ma)}</td><td class="num ${ma != null && mc != null ? signClass(mc - ma) : ''}">${fmtPs(k, mc)}</td><td class="num">${fmtPs(k, a.length ? Math.max(...a) : null)}</td><td class="num">${fmtPs(k, c.length ? Math.max(...c) : null)}</td><td class="num">${k === 'elo' || k === 'reviveSkill' || k === 'streak' ? '' : fmtPs(k, sum(a))}</td></tr>`; }).join('')}
      <tr><td>Revivers (skill 50+ or 500+ revives)</td><td class="num">${revivers(tP)}</td><td class="num">${revivers(uP)}</td><td></td><td></td><td></td></tr>
    </table>
    <h3>Training &amp; activity pace</h3>
    ${tP.some(p => Object.keys(p.pace).length) ? `<table class="data"><tr><th></th><th class="num">Their median / day</th><th class="num">Your median / day</th><th class="num">Their faction / day</th><th class="num">Your faction / day</th></tr>
      ${PACE_ROWS.map(([k, l]) => { const a = paceCol(tP, k), c = paceCol(uP, k); const f = v => (v == null ? '–' : k === 'activity' ? `${(v / 3600).toFixed(1)} h` : v.toFixed(1)); return `<tr><td>${l}</td><td class="num">${f(median(a))}</td><td class="num">${f(median(c))}</td><td class="num">${a.length ? f(sum(a)) : '–'}</td><td class="num">${c.length ? f(sum(c)) : '–'}</td></tr>`; }).join('')}</table>
      <div class="note">From the change between personal-stats samples at least a day apart.</div>`
      : '<div class="note">Pace needs two personal-stats samples a day apart. Check back tomorrow.</div>'}`
    : `<div class="note">Fetching members' public personal stats, one every ${R.personalGapSec} s (${psDone}/${tm.length} so far).</div>`}

    <h3>Track record</h3>
    <div class="cols2">
      <div><div class="chart-title">Ranked wars</div>
        ${them.history && them.history.wars.length ? `<table class="data"><tr><th>Ended</th><th>Opponent</th><th class="num">Score</th><th>Result</th></tr>
          ${them.history.wars.slice(0, 12).map(w => { const me = w.factions.find(f => f.id === them.id) || {}; const op = w.factions.find(f => f.id !== them.id) || {}; return `<tr><td>${w.end ? new Date(w.end).toISOString().slice(0, 10) : 'running'}</td><td>${esc(op.name || '?')}</td><td class="num">${num(me.score || 0)} – ${num(op.score || 0)}</td><td>${!w.winner ? '–' : w.winner === them.id ? '<span class="pill ok">Won</span>' : '<span class="pill bad">Lost</span>'}</td></tr>`; }).join('')}</table>` : '<div class="muted small">No ranked wars on record yet (or still loading).</div>'}</div>
      <div><div class="chart-title">Chains</div>
        ${them.history && them.history.chains.length ? (() => { const cs = them.history.chains; const last30 = chains30(them); return `<table class="data">
          <tr><td>Chains on record</td><td class="num">${cs.length}</td></tr>
          <tr><td>Last 30 days</td><td class="num">${last30.length}</td></tr>
          <tr><td>Longest (all shown)</td><td class="num">${num(Math.max(...cs.map(c => c.length)))}</td></tr>
          <tr><td>Average length (last 30 days)</td><td class="num">${last30.length ? num(Math.round(sum(last30.map(c => c.length)) / last30.length)) : '–'}</td></tr>
          <tr><td>Respect (last 30 days)</td><td class="num">${compact(sum(last30.map(c => c.respect)))}</td></tr>
          <tr><td>Most recent</td><td class="num">${num(cs[0].length)} · ${fmtAgo(cs[0].end)}</td></tr></table>`; })() : '<div class="muted small">No chains on record yet (or still loading).</div>'}</div>
    </div>

    <h3>Member dossiers</h3>
    ${exportMode
      ? `<div class="chart-title">${esc(tName)}</div>${dossierTable(them)}${us ? `<div class="chart-title" style="margin-top:14px">${esc(uName)}</div>${dossierTable(us)}` : ''}`
      : `<div class="toolbar"><div class="subnav" style="margin:0"><button data-rs-board="them" class="${board !== 'us' ? 'active' : ''}">${esc(tName)}</button>${us ? `<button data-rs-board="us" class="${board === 'us' ? 'active' : ''}">${esc(uName)}</button>` : ''}</div></div>
        ${dossierTable(board === 'us' && us ? us : them)}`}
    <div class="note">Everything here comes from Torn's official API (public data) and FFScouter estimates. Research starts when a war is announced and keeps collecting in the background until two days after it ends.</div>`;

  const series = [{ name: `${tName} online`, points: them.series.map(p => [p[0], p[1] + p[2]]), color: CHART_COLORS[1] }];
  if (us) series.push({ name: `${uName} online`, points: us.series.map(p => [p[0], p[1] + p[2]]), color: CHART_COLORS[0] });

  // Headline facts for the overview image.
  const threats = tm.filter(m => bsOf(m)).sort((a, c) => bsOf(c) - bsOf(a)).slice(0, 5)
    .map(m => ({ name: m.name, level: m.level, bs: bsOf(m), band: mine ? estBand(bsOf(m), mine) : null, uh: usualHours(them.activity[m.id]) }));
  const last = them.series[them.series.length - 1];
  const model = {
    tName, uName, tag: b.tag || '', id: them.id, why: sel.why, hours, samples: them.samples || 0, coverage, psDone, members: tm.length, usMembers: um.length,
    respect: [b.respect, ub.respect], rank: [b.rank, ub.rank], bestChain: [b.bestChain, ub.bestChain], wl: [wl(them), wl(us)],
    chains30: [chains30(them).length, chains30(us).length], longest30: [Math.max(0, ...chains30(them).map(c => c.length)), Math.max(0, ...chains30(us).map(c => c.length))],
    bsTotal: [sum(tBs), sum(uBs)], bsMedian: [median(tBs), median(uBs)], bsTop5: [top5(tBs), top5(uBs)], bsKnown: [tBs.length, uBs.length], hasStats: !!ffs.hasKey,
    bandsVsMe, mine, peak, quiet, edge, inactive, onlineNow: last ? last[1] + last[2] : null,
    xanMedian: [median(col(tP, 'xanax')), median(col(uP, 'xanax'))], eloMedian: [median(col(tP, 'elo')), median(col(uP, 'elo'))],
    rwMedian: [median(col(tP, 'rwHits')), median(col(uP, 'rwHits'))], revivers: [revivers(tP), revivers(uP)],
    xanPace: [median(paceCol(tP, 'xanax')), median(paceCol(uP, 'xanax'))], threats,
  };
  return { html, series, model, them, us };
}

// ---- War report (ui/intel.js) ----
// One report model for a faction record (the opponent, or your own faction with self: true).
function reportModel(c) {
  const rec = c.them;
  const ffsI = ((c.ffs && c.ffs.intel) || {})[rec.id] || null;
  const acct = S.api.account;
  return irModel({
    rec, us: c.us || null, stats: c.stats, ffs: ffsI, snapStats: c.R.snapStats || [], now: Date.now(), self: !!c.self,
    by: acct ? `${acct.name} [${acct.id}]` : '', source: prefs.get(c.self ? 'intel.source.self' : 'intel.source', '') || null,
    // Your banner from the War tab's faction details when the research record hasn't fetched it.
    banner: c.self && S.features.war && S.features.war.own && S.features.war.own.id === rec.id ? S.features.war.own.bannerImage || '' : '',
  });
}

// FFScouter Premium: load its activity history and stat growth once per session per faction.
function autoIntel(rec, ffs) {
  const acct = ffs.account || {};
  const have = (ffs.intel || {})[rec.id];
  const job = ffs.intelJob && ffs.intelJob.fid === rec.id ? ffs.intelJob : null;
  if (ffs.hasKey && acct.premium && !have && !(job && job.running) && !rsAutoIntel.has(rec.id) && Object.keys(rec.members).length) {
    rsAutoIntel.add(rec.id);
    cmd('ffscouter.intel', rec.id, Object.keys(rec.members).map(Number), false).catch(() => {});
  }
}

// A cheap fingerprint of everything a report shows: re-render only when it changes, so the
// reader's sorting and filters stay put.
function reportKey(rec, R, ffs, c, self) {
  const ffsI = (ffs.intel || {})[rec.id];
  const job = ffs.intelJob && ffs.intelJob.fid === rec.id ? ffs.intelJob : null;
  const snapN = Object.values(rec.snaps || {}).reduce((n, x) => n + Object.keys(x).length, 0);
  return [self ? 'self' : 'report', rec.id, (rec.record || {}).at || 0, (rec.observed || {}).at || 0, snapN, R.snapQueue, ffsI ? ffsI.at : 0,
    job ? `${job.done}/${job.running}/${job.error}` : '', Object.keys(c.stats).length, prefs.get(self ? 'intel.source.self' : 'intel.source', ''),
    S.api.hasKey, Object.keys(rec.members).length].join('|');
}

// Status lines, FFScouter loader and activity-source picker above a report.
function reportStatus(rec, R, ffs, M, self) {
  const acct = ffs.account || {};
  const ffsI = (ffs.intel || {})[rec.id] || null;
  const job = ffs.intelJob && ffs.intelJob.fid === rec.id ? ffs.intelJob : null;
  const wars = ((rec.record || {}).wars || []).length;
  const status = [
    `War reports: ${M.wars.length}/${wars || 10}${M.pendingWars ? ' (loading)' : ''}`,
    `chains: ${M.chainsAnalysed - M.chainsMissing}/${M.chainsAnalysed}`,
    `momentum snapshots: ${R.snapQueue ? `${num(R.snapQueue)} to fetch (one every ${R.snapGapSec} s)` : 'complete'}`,
    `activity: ${rec.observed && rec.observed.days ? `${rec.observed.days} days from your ${R.fromServer ? 'server' : 'checks'}` : 'none from your checks yet'}`,
  ].join(' · ');
  const ffsLine = !ffs.hasKey ? 'Add your FFScouter key in Settings for estimated stats.'
    : !acct.premium ? 'FFScouter Premium adds up to 52 days of scanner activity and estimated stat growth.'
      : job && job.running ? `FFScouter: loading activity and stat history ${job.done}/${job.total}…`
        : `${ffsI ? `FFScouter activity: ${ffsI.days} days, loaded ${fmtAgo(ffsI.at)}.` : 'FFScouter activity not loaded yet.'}${job && job.error ? ` <span class="neg">${esc(job.error)}</span>` : ''} <button data-ir-ffs="${rec.id}">${ffsI ? 'Reload' : 'Load'} FFScouter activity + stat growth</button>`;
  const srcs = M.activity.filter(Boolean);
  return `<div class="war-card"><div class="row between wrap"><div class="war-title">${self ? 'My faction' : 'War report'}: ${factionTag(rec.basic && rec.basic.tagImage)}${link(`https://www.torn.com/factions.php?step=profile&ID=${rec.id}`, esc(M.name))}</div>
      <span class="muted small">${status}${R.fromServer ? ' · <span class="sync-badge">from your server</span>' : ''}</span></div>
      <div class="muted small" style="margin-top:4px">${ffsLine}</div>
      ${srcs.length > 1 ? `<div class="small" style="margin-top:6px">Activity source for member heatmaps: <select data-ir-source="${self ? 'self' : ''}">${srcs.map(x => `<option value="${x.key}" ${M.mainActivity === x.key ? 'selected' : ''}>${esc(x.label)} (${x.days} days)</option>`).join('')}</select></div>` : ''}
    </div>`;
}

function renderReport(el, head, c) {
  const { R, them, ffs } = c;
  autoIntel(them, ffs);
  const key = `${navSig()}|${reportKey(them, R, ffs, c, false)}|${(them.basic && them.basic.bannerImage) || ''}|${avatarsOn()}`;
  if (key === rsLastKey && el.querySelector('.ir-body')) return;
  rsLastKey = key;
  const M = reportModel(c);
  const wars = ((them.record || {}).wars || []).length;
  el.innerHTML = `${head}${reportStatus(them, R, ffs, M, false)}
    ${M.wars.length ? `<div class="ir-body">${irBody(M, 'app')}</div>` : `<div class="empty">Loading their last ${wars || 10} ranked war reports… (${R.fromServer ? 'your server fetches them' : 'one request every couple of seconds'})</div>`}`;
}

// ---- My Faction tab: the same report for your own faction ----
let fcLastKey = '';
function ownContext() {
  const R = S.features.research;
  const t = R && R.tracked.find(x => x.own);
  const rec = t && R.factions[t.id];
  if (!rec) return null;
  const ffs = S.features.ffscouter || {};
  return { R, them: rec, us: null, ffs, stats: ffs.stats || {}, self: true };
}

function renderFaction() {
  const el = panel('faction');
  if (!el || !el.classList.contains('active')) return;
  const R = S.features.research;
  const c = ownContext();
  if (!c) {
    fcLastKey = '';
    el.innerHTML = `<div class="empty">${!S.api.hasKey && !(R && R.fromServer) ? 'Add your Torn API key in Settings (or connect a sync server) to see your faction.' : 'Loading your faction… Its members, last 10 ranked wars, chain reports and momentum snapshots fill in over the next few minutes.'}</div>`;
    return;
  }
  autoIntel(c.them, c.ffs);
  const own = S.features.war && S.features.war.own;
  const banner = (c.them.basic && c.them.basic.bannerImage) || (own && own.id === c.them.id ? own.bannerImage : '') || '';
  const key = `${reportKey(c.them, c.R, c.ffs, c, true)}|${banner}|${avatarsOn()}`;
  if (key === fcLastKey && el.querySelector('.ir-body')) return;
  fcLastKey = key;
  const M = reportModel(c);
  const wars = ((c.them.record || {}).wars || []).length;
  el.innerHTML = `${factionBanner(banner, 'fbanner-top')}<div class="toolbar"><span class="muted small">Your faction's war record, momentum, commitment and activity, analysed the same way as an opponent's.</span><span class="spacer"></span>
      <button class="primary" data-ir-export="self" title="Save the report as a PDF, plus an interactive .html (sortable, filterable tables) and a .csv">Export PDF + HTML…</button></div>
    ${reportStatus(c.them, c.R, c.ffs, M, true)}
    ${M.wars.length ? `<div class="ir-body">${irBody(M, 'app')}</div>` : `<div class="empty">Loading your last ${wars || 10} ranked war reports… (${c.R.fromServer ? 'your server fetches them' : 'one request every couple of seconds'})</div>`}`;
}

// Report clicks shared by Oppo Research and My Faction.
function reportClick(e) {
  const ix = e.target.closest('[data-ir-export]');
  if (ix) { exportIntelReport(ix, ix.dataset.irExport === 'self'); return true; }
  const ff = e.target.closest('[data-ir-ffs]');
  if (ff) {
    const R = S.features.research;
    const rec = R && R.factions[ff.dataset.irFfs];
    if (rec) { ff.disabled = true; cmd('ffscouter.intel', rec.id, Object.keys(rec.members).map(Number), true).catch(() => {}); }
    return true;
  }
  return false;
}

function initFaction() {
  const el = panel('faction');
  irEnhance(el);
  el.addEventListener('click', e => { reportClick(e); });
  el.addEventListener('change', e => {
    const src = e.target.closest('[data-ir-source]');
    if (src) { prefs.set('intel.source.self', src.value); fcLastKey = ''; renderFaction(); }
  });
}

async function exportIntelReport(btn, self = false) {
  const c = self ? ownContext() : currentResearch();
  if (!c) return;
  const M = reportModel(self ? c : { ...c, self: false });
  const old = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Exporting…';
  try {
    const r = await cmd('research.exportIntel', { name: M.name, pdf: irDocument(M, 'pdf'), html: irDocument(M, 'html'), csv: irCsv(M) });
    btn.textContent = r && r.cancelled ? old : 'Saved ✓';
  } catch (e) {
    btn.textContent = 'Failed';
  }
  setTimeout(() => { btn.disabled = false; btn.textContent = old; }, 2500);
}

// ---- Export: full report (.html), overview image (.png), dossiers (.csv) ----
function currentResearch() {
  const R = S.features.research;
  if (!R) return null;
  const targets = R.tracked.filter(t => !t.own);
  const ownT = R.tracked.find(t => t.own);
  const sel = targets.find(t => t.id === Number(prefs.get('research.sel', 0))) || targets[0];
  const them = sel && R.factions[sel.id];
  if (!them) return null;
  const us = ownT && R.factions[ownT.id];
  const ffs = S.features.ffscouter || {};
  const mine = (S.features.war && S.features.war.myStats && S.features.war.myStats.total) || 0;
  return { R, sel, them, us, ffs, stats: ffs.stats || {}, mine };
}

// The online chart as plain SVG (drawn off-screen at report width).
function chartSvg(v, width = 1100) {
  const host = document.createElement('div');
  host.style.cssText = `position:absolute;left:-20000px;top:0;width:${width}px`;
  document.body.appendChild(host);
  drawOnlineChart(host, v, width);
  const html = host.innerHTML;
  host.remove();
  return html;
}

const tctFull = ms => `${new Date(ms).toISOString().slice(0, 16).replace('T', ' ')} TCT`;

function warStartText() {
  const r = S.features.war && S.features.war.wars && S.features.war.wars.ranked;
  if (!r || !r.start) return '';
  const d = r.start - Date.now();
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][new Date(r.start).getUTCDay()];
  if (d > 0) return `Ranked war starts ${days} ${tctFull(r.start)} (in ${Math.floor(d / 86400e3)}d ${Math.floor((d % 86400e3) / 3600e3)}h)`;
  return r.end ? `Ranked war ended ${tctFull(r.end)}` : `Ranked war running since ${tctFull(r.start)}`;
}

// One-card summary for Discord: the most important facts at a glance.
function overviewCard(m) {
  const pair = (a, c, f = compact) => `<span class="ov-them">${a == null ? '–' : f(a)}</span><span class="ov-vs">vs</span><span class="ov-us">${c == null ? '–' : f(c)}</span>`;
  const tile = (k, v) => `<div class="ov-tile"><div class="ov-k">${k}</div><div class="ov-v">${v}</div></div>`;
  const hrs = (list, fmt) => (list.length ? list.slice(0, 3).map(fmt).join('<br>') : '<span class="muted">collecting…</span>');
  const b = m.bandsVsMe;
  return `<div class="ov">
    <div class="ov-head">
      <div><div class="ov-title">Oppo Research: ${esc(m.tName)}${m.tag ? ` [${esc(m.tag)}]` : ''}</div>
        <div class="ov-sub">${esc(warStartText() || m.why)} · vs ${esc(m.uName)}</div></div>
      <div class="ov-legend"><span class="ov-them">■ ${esc(m.tName)}</span><span class="ov-us">■ ${esc(m.uName)}</span></div>
    </div>
    <div class="ov-grid5">
      ${tile('Members', pair(m.members, m.usMembers, num))}
      ${tile('Est. stats total', m.hasStats ? pair(m.bsTotal[0], m.bsTotal[1]) : '–')}
      ${tile('Median member', m.hasStats ? pair(m.bsMedian[0], m.bsMedian[1]) : '–')}
      ${tile('Top 5 average', m.hasStats ? pair(m.bsTop5[0], m.bsTop5[1]) : '–')}
      ${tile('Respect', pair(m.respect[0], m.respect[1]))}
    </div>
    <div class="ov-grid5">
      ${tile(`Vs your ${m.mine ? compact(m.mine) : ''} stats`, b ? `<span class="est est-b2">${b.weaker} weaker</span> <span class="est est-b0">${b.even} even</span> <span class="est est-h2">${b.stronger} stronger</span>` : '–')}
      ${tile('Last 20 ranked wars', pair(m.wl[0], m.wl[1], x => x))}
      ${tile('Chains, last 30 days', pair(m.chains30[0], m.chains30[1], num))}
      ${tile('Longest chain, 30 days', pair(m.longest30[0], m.longest30[1], num))}
      ${tile('Median Xanax / Elo', `${pair(m.xanMedian[0], m.xanMedian[1])}<div class="ov-small">Elo ${m.eloMedian[0] == null ? '–' : num(Math.round(m.eloMedian[0]))} vs ${m.eloMedian[1] == null ? '–' : num(Math.round(m.eloMedian[1]))}</div>`)}
    </div>
    <div class="ov-grid3">
      ${tile('Their peak hours (avg online)', hrs(m.peak, x => `${hourLabel(x.i)} TCT · <b>${x.v.toFixed(1)}</b>`))}
      ${tile('Their quietest hours', hrs(m.quiet, x => `${hourLabel(x.i)} TCT · <b>${x.v.toFixed(1)}</b>`))}
      ${tile('Your best hours (you vs them)', hrs(m.edge, x => `${hourLabel(x.i)} TCT · <b class="pos">+${x.d.toFixed(1)}</b> <span class="muted">(${x.u.toFixed(1)} vs ${x.t.toFixed(1)})</span>`))}
    </div>
    <div class="ov-grid2">
      <div class="ov-tile"><div class="ov-k">Top threats (est. stats)</div>
        ${m.threats.length ? `<table class="ov-table">${m.threats.map(t => `<tr><td>${esc(t.name)}</td><td class="num">Lv ${t.level}</td><td class="num"><span class="est ${t.band ? t.band.cls : ''}">${compact(t.bs)}</span></td><td class="muted">${t.uh ? `${String(t.uh.from).padStart(2, '0')}–${String(t.uh.to).padStart(2, '0')} TCT` : ''}</td></tr>`).join('')}</table>` : '<span class="muted">needs FFScouter estimates</span>'}</div>
      <div class="ov-tile"><div class="ov-k">Also worth knowing</div><div class="ov-v ov-list">
        Revivers: <b>${m.revivers[0]}</b> vs ${m.revivers[1]}<br>
        Inactive 3+ days: <b>${m.inactive}</b> of ${m.members}<br>
        Median ranked war hits: <b>${m.rwMedian[0] == null ? '–' : compact(m.rwMedian[0])}</b> vs ${m.rwMedian[1] == null ? '–' : compact(m.rwMedian[1])}<br>
        Xanax per day (median): <b>${m.xanPace[0] == null ? '–' : m.xanPace[0].toFixed(1)}</b> vs ${m.xanPace[1] == null ? '–' : m.xanPace[1].toFixed(1)}<br>
        Online at last check: <b>${m.onlineNow == null ? '–' : m.onlineNow}</b></div></div>
    </div>
    <div class="ov-foot">Mentat · ${tctFull(Date.now())} · ${num(m.samples)} activity checks over ${m.hours >= 48 ? `${(m.hours / 24).toFixed(1)} days` : `${m.hours.toFixed(1)} h`} · official Torn API + FFScouter · full report attached</div>
  </div>`;
}

// Member dossiers as CSV (opens in Excel / Google Sheets).
function dossierCsv(c) {
  const head = ['faction', 'id', 'name', 'level', 'position', 'est_battle_stats', 'vs_your_stats', 'usual_hours_tct', 'online_share', 'last_action_utc',
    'xanax', 'xanax_per_day', 'energy_refills', 'stat_enhancers', 'energy_drinks', 'attacks_won', 'attacks_lost', 'defends_won', 'defends_lost', 'elo',
    'ranked_war_hits', 'respect', 'revive_skill', 'revives', 'time_played_hours', 'login_streak', 'networth'];
  const q = v => (v == null ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  const lines = [head.join(',')];
  for (const rec of [c.them, c.us].filter(Boolean)) {
    for (const m of Object.values(rec.members)) {
      const a = rec.activity[m.id];
      const p = personal(rec, m.id);
      const s = p ? p.s : {};
      const bs = (c.stats[m.id] && c.stats[m.id].bs) || null;
      const uh = usualHours(a);
      lines.push([rec.name, m.id, m.name, m.level, m.position, bs, bs && c.mine ? (bs / c.mine).toFixed(3) : '',
        uh ? `${uh.from}-${uh.to}` : '', a ? (sum(a.active) / Math.max(1, sum(a.samples))).toFixed(3) : '', m.lastAt ? new Date(m.lastAt).toISOString() : '',
        s.xanax, p && Number.isFinite(p.pace.xanax) ? p.pace.xanax.toFixed(2) : '', s.refills, s.ses, s.cans, s.attacksWon, s.attacksLost, s.defendsWon, s.defendsLost, s.elo,
        s.rwHits, s.respect, s.reviveSkill, s.revives, s.activity != null ? (s.activity / 3600).toFixed(1) : '', s.streak, s.networth].map(q).join(','));
    }
  }
  return lines.join('\r\n');
}

// mode 'all': choose where to save the report + overview image + CSV (image also copied);
// mode 'image': just copy the overview image to the clipboard.
async function exportResearch(mode, btn) {
  const c = currentResearch();
  if (!c) return;
  const v = researchView({ ...c, board: 'them', sortKey: 'stats', dir: -1, exportMode: true });
  const name = v.model.tName;
  const payload = {
    mode, name,
    overview: overviewCard(v.model),
    report: mode === 'all' ? `<header class="rp-head"><h1>Oppo Research: ${esc(name)}</h1><div class="muted">${esc(warStartText() || v.model.why)} · compared with ${esc(v.model.uName)} · exported ${tctFull(Date.now())} from Mentat</div></header>
      <section class="rp-overview">${overviewCard(v.model)}</section>
      ${v.html.replace('<div class="chart-title">Online now and over time</div><div id="rs-online"></div>', `<div class="chart-title">Online now and over time</div><div>${chartSvg(v)}</div>`)}` : '',
    csv: mode === 'all' ? dossierCsv(c) : '',
    data: mode === 'all' ? { exportedAt: Date.now(), them: c.them, us: c.us, estimates: Object.fromEntries([...Object.keys(c.them.members), ...(c.us ? Object.keys(c.us.members) : [])].map(id => [id, c.stats[id] || null])), yourStats: c.mine } : null,
  };
  const old = btn ? btn.textContent : '';
  if (btn) { btn.disabled = true; btn.textContent = mode === 'all' ? 'Exporting…' : 'Copying…'; }
  try {
    const r = await cmd('research.export', payload);
    if (btn) btn.textContent = r && r.cancelled ? old : mode === 'all' ? 'Saved ✓ (image copied)' : 'Copied ✓';
  } catch (e) {
    if (btn) btn.textContent = 'Failed';
  }
  if (btn) setTimeout(() => { btn.disabled = false; btn.textContent = old; }, 2500);
}

function initResearch() {
  const el = panel('research');
  irEnhance(el); // sortable / filterable report tables
  el.addEventListener('change', e => {
    const src = e.target.closest('[data-ir-source]');
    if (src) { prefs.set('intel.source', src.value); renderResearch(); return; }
    const sp = e.target.closest('[data-sc-spread]');
    if (sp) { cmd('settings.set', 'scout.spread', Number(sp.value)); return; }
    const rate = e.target.closest('[data-sc-rate]');
    if (rate) { const n = Math.max(2, Math.min(15, Math.round(Number(rate.value) || 6))); cmd('settings.set', 'scout.perMinute', n); }
  });
  el.addEventListener('click', e => {
    const v = e.target.closest('[data-rs-view]');
    if (v) { prefs.set('research.view', v.dataset.rsView); rsLastKey = ''; renderResearch(); return; }
    if (reportClick(e)) return;
    const ss = e.target.closest('[data-sc-sort]');
    if (ss) {
      const k = ss.dataset.scSort;
      const cur = prefs.get('scout.sort', 'position');
      prefs.set('scout.dir', cur === k ? -prefs.get('scout.dir', 1) : (k === 'name' || k === 'position' ? 1 : -1));
      prefs.set('scout.sort', k);
      rsLastKey = '';
      renderResearch();
      return;
    }
    const sr = e.target.closest('[data-sc-research]');
    if (sr) {
      const id = Number(sr.dataset.scResearch);
      cmd('research.watch', id);
      prefs.set('research.sel', id);
      rsLastKey = '';
      navOpen('research', 'report');
      return;
    }
    const en = e.target.closest('[data-sc-enable]');
    if (en) { cmd('settings.set', 'scout.enabled', en.dataset.scEnable === '1'); return; }
    const s = e.target.closest('[data-rs-sel]');
    if (s) { prefs.set('research.sel', Number(s.dataset.rsSel)); renderResearch(); return; }
    const b = e.target.closest('[data-rs-board]');
    if (b) { prefs.set('research.board', b.dataset.rsBoard); renderResearch(); return; }
    const w = e.target.closest('[data-rs-watch]');
    if (w) { cmd('research.watch', Number(w.dataset.rsWatch) || 0); return; }
    const x = e.target.closest('[data-rs-export]');
    if (x) { exportResearch(x.dataset.rsExport, x); return; }
    const th = e.target.closest('[data-rs-sort]');
    if (th) {
      const k = th.dataset.rsSort;
      const cur = prefs.get('research.sort', 'stats');
      prefs.set('research.dir', cur === k ? -prefs.get('research.dir', -1) : (k === 'name' || k === 'last' ? 1 : -1));
      prefs.set('research.sort', k);
      renderResearch();
    }
  });
  el.addEventListener('submit', e => {
    const f = e.target.closest('[data-rs-form]');
    if (!f) return;
    e.preventDefault();
    const id = Number(f.elements.fid.value) || 0;
    if (id > 0) cmd('research.watch', id);
  });
}
