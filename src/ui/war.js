'use strict';
/* global S, $, panel, esc, num, cmd, money, signClass, tct, fmtDur, fmtMin, ago, countdown, link, statusPill,
   profileUrl, attackUrl, prefs, lineChart, CHART_COLORS, syncSettingInputs, renderSafe, chainClass */
// War tools: ranked war overview with live scores and a score chart, raids/territory wars,
// and a status board for the enemy faction (or any faction you watch) and your own.

const HOUR = 3600e3;

// Lead change per hour over the last `windowMs` of the score history.
function leadRate(points, windowMs = HOUR) {
  if (!points || points.length < 2) return null;
  const last = points[points.length - 1];
  const from = points.find(p => p[0] >= last[0] - windowMs) || points[0];
  const dt = (last[0] - from[0]) / HOUR;
  if (dt < 0.05) return null;
  return {
    lead: ((last[1] - last[2]) - (from[1] - from[2])) / dt,
    us: (last[1] - from[1]) / dt,
    them: (last[2] - from[2]) / dt,
  };
}

// ---- Chains: yours and theirs, side by side ----
const CHAIN_BONUSES = [10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 25000, 50000, 100000];
function chainBox(label, c, note) {
  const now = Date.now();
  if (!c) return `<div class="war-chain"><div class="muted small">${label}</div><div class="time mono muted">–</div><div class="small muted">${note || 'Loading…'}</div></div>`;
  const active = c.current > 0 && !c.cooldown && c.expiresAt > now;
  const next = CHAIN_BONUSES.find(b => b > c.current);
  if (active) {
    return `<div class="war-chain"><div class="muted small">${label}</div>
      <div class="time mono ${chainClass((c.expiresAt - now) / 1000)}" data-chain-until="${c.expiresAt}">${fmtDur((c.expiresAt - now) / 1000)}</div>
      <div class="small"><b>${num(c.current)}</b> hits${c.modifier && c.modifier !== 1 ? ` · ×${c.modifier}` : ''}${next ? ` · next bonus ${num(next)} <span class="muted">(${num(next - c.current)} to go)</span>` : ''}</div></div>`;
  }
  if (c.cooldown && c.cooldownUntil > now) {
    return `<div class="war-chain"><div class="muted small">${label}</div><div class="time mono muted">${countdown(c.cooldownUntil, '0:00')}</div><div class="small muted">cooldown after a ${num(c.current)} chain</div></div>`;
  }
  return `<div class="war-chain"><div class="muted small">${label}</div><div class="time mono muted">0:00</div><div class="small muted">no chain running</div></div>`;
}
function chainsCard(w) {
  const ours = S.features.chain && S.features.chain.chain;
  const enemyName = (w.enemy && w.enemy.name) || (w.target && w.target.name) || 'Enemy';
  const ourNote = !(S.settings && S.settings.chain && S.settings.chain.enabled) ? 'Chain timer is off (Chain tab)' : ours && ours.noFaction ? 'No faction' : '';
  return `<div class="war-card war-chains">
    ${chainBox(`Your chain${w.own ? ` · ${esc(w.own.name)}` : ''}`, ours && !ours.noFaction ? ours : null, ourNote)}
    ${chainBox(`Their chain · ${esc(enemyName)}`, w.enemyChain && !w.enemyChain.none ? w.enemyChain : null, w.target ? '' : 'No opponent')}
  </div>`;
}

// ---- Estimated stats vs yours: blue within 10%, softer blues weaker, hotter colours stronger ----
const EST_BANDS = [
  [3, 'h4', 'over 3× yours'], [1.75, 'h3', '1.75–3× yours'], [1.25, 'h2', '125–175% of yours'], [1.1, 'h1', '110–125% of yours'],
  [0.9, 'b0', 'within 10% of yours'], [0.7, 'b1', '70–90% of yours'], [0.45, 'b2', '45–70% of yours'], [0.25, 'b3', '25–45% of yours'], [0, 'g', 'under 25% of yours'],
];
function estBand(bs, mine) {
  if (!bs || !mine) return null;
  const ratio = bs / mine;
  const band = EST_BANDS.find(([min]) => ratio >= min) || EST_BANDS[EST_BANDS.length - 1];
  return { ratio, cls: `est-${band[1]}`, label: band[2] };
}
function estLegend(mine) {
  return `<div class="est-legend"><span class="muted small">Est. stats vs yours (${compactStat(mine)}):</span>${EST_BANDS.slice().reverse().map(([, cls, label]) => `<span class="est est-${cls}">${label.replace(' of yours', '').replace(' yours', '')}</span>`).join('')}</div>`;
}
// Share of your stats: a percentage, or a multiple once it's 10× or more.
const ratioText = r => (r >= 10 ? `${r >= 100 ? Math.round(r) : r.toFixed(1)}×` : `${Math.round(r * 100)}%`);
const compactStat = n => (n >= 1e9 ? `${(n / 1e9).toFixed(2)}b` : n >= 1e6 ? `${(n / 1e6).toFixed(2)}m` : n >= 1e3 ? `${(n / 1e3).toFixed(0)}k` : String(n));

function lastActionDot(m) {
  const cls = m.last === 'Online' ? 'on' : m.last === 'Idle' ? 'idle' : 'off';
  return `<span class="la-dot ${cls}"></span>${esc(m.last)}<div class="muted small">${esc(m.lastRel)}</div>`;
}

// Second line of the Status cell. Travellers get a landing estimate:
//   seen leaving  → "lands ~12:43 TCT · in 14m" (window 12:38–12:47)
//   already flying when first seen → "lands by 13:10 TCT"
function statusDetail(m) {
  const t = m.trip;
  if (m.state === 'Traveling' && t) {
    const how = t.methods.length > 1 ? `${t.methods.join(' or ')}` : t.methods[0];
    if (t.seen) {
      const tip = `Seen leaving between checks. ${how} flight to ${t.back ? 'Torn' : t.country}. Window ${tct(t.landLo)}–${tct(t.landHi)} TCT allows for flight variation and a travel book (−25%).`;
      const opts = t.options || [];
      // Airliner: Business or Standard, two distinct likely times rather than an average.
      const head = opts.length > 1
        ? opts.map(o => `~${tct(o.at)} <span class="muted">(${esc(o.method)})</span>`).join(' or ')
        : `~${tct(t.expected)} TCT`;
      const next = opts.map(o => o.at).filter(a => a > Date.now()).sort((a, b) => a - b)[0] || t.landHi;
      return `<div class="small"><span class="land-est" title="${esc(tip)}">✈ lands ${head} · ${countdown(next, 'landing')}</span></div>
        <div class="muted small">${esc(m.description)} · ${esc(how)}</div>`;
    }
    return `<div class="small"><span class="land-est unsure" title="They were already flying when the app first saw them, so only the latest landing time is known.">✈ lands by ${tct(t.landHi)} TCT · ≤ ${countdown(t.landHi, 'any moment')}</span></div>
      <div class="muted small">${esc(m.description)} · ${esc(how)} · left before we were watching</div>`;
  }
  if (m.state === 'Abroad' && m.abroadSince) return `<div class="muted small">${esc(m.description)} · since ${tct(m.abroadSince)} TCT</div>`;
  if (m.state === 'Hospital') return `<div class="muted small">${esc(m.details || m.description)}</div>`;
  if (m.state !== 'Okay' && m.state !== 'Jail') return `<div class="muted small">${esc(m.description)}</div>`;
  return '';
}

const WAR_FILTERS = [['all', 'All'], ['hittable', 'Hittable now'], ['soon', 'Out or landing within 15 min'], ['hospital', 'Hospital'], ['travel', 'Traveling / abroad'], ['online', 'Online / idle']];
const WAR_SORTS = [['status', 'Status (hittable first)'], ['out', 'Out of hospital soonest'], ['level', 'Level'], ['stats', 'Est. stats'], ['active', 'Last active'], ['name', 'Name']];

// War claims (shared through the Mentat server): who's going for this enemy, in claim order.
const claimsFor = id => { const c = S.features.claims; return (c && c.available && c.claims && c.claims[id]) || []; };
function claimCell(m) {
  const c = S.features.claims;
  if (!c || !c.available) return '';
  const list = claimsFor(m.id);
  const mine = list.some(x => x.by === c.me);
  const who = list.map((x, i) => `${i + 1}. ${x.by === c.me ? '<b>you</b>' : esc(x.name)} <span class="muted">${fmtAgo(x.at)}</span>`).join('<br>');
  return ` <button class="${mine ? 'claimed' : ''}" data-war-claim="${m.id}" data-on="${mine ? 0 : 1}" title="${mine ? 'Drop your claim' : 'Claim: everyone using Mentat sees you are going for them. It clears when they land in hospital, or after 15 minutes.'}">${mine ? 'Unclaim' : 'Claim'}</button>${list.length ? `<div class="small claim-list" title="Claimed, in order">${who}</div>` : ''}`;
}

function memberRows(list, opts) {
  const now = Date.now();
  const ffs = S.features.ffscouter || {};
  const stats = ffs.stats || {};
  const f = opts.filter;
  const q = (opts.q || '').trim().toLowerCase();
  const hittable = m => m.state === 'Okay';
  const pinned = new Set(opts.pinned || []);
  const mine = opts.mine || 0;
  let rows = opts.noFilter ? [...list] : list.filter(m => {
    if (q && !m.name.toLowerCase().includes(q) && String(m.id) !== q) return false;
    if (f === 'hittable') return hittable(m);
    if (f === 'soon') return (m.state === 'Hospital' && m.until - now <= 15 * 60e3) || (m.trip && m.trip.seen && m.trip.landHi - now <= 15 * 60e3);
    if (f === 'hospital') return m.state === 'Hospital';
    if (f === 'travel') return m.state === 'Traveling' || m.state === 'Abroad';
    if (f === 'online') return m.last === 'Online' || m.last === 'Idle';
    return true;
  });
  const rank = m => (m.state === 'Okay' ? 0 : m.state === 'Hospital' ? 1 : m.state === 'Jail' ? 2 : m.state === 'Traveling' ? 3 : m.state === 'Abroad' ? 4 : 5);
  const actRank = m => (m.last === 'Online' ? 0 : m.last === 'Idle' ? 1 : 2);
  const bs = m => (stats[m.id] && stats[m.id].bs) || 0;
  // When someone is next available: hospital/jail release, or estimated landing.
  const nextAt = m => (m.state === 'Hospital' || m.state === 'Jail' ? m.until : m.trip ? (m.trip.expected || m.trip.landHi) : 0);
  // Each column's natural order. With a second sort column, Status only groups (hittable,
  // hospital, jail, traveling, abroad) and the second column orders within each group.
  const sec = opts.sort2 && opts.sort2 !== opts.sort ? opts.sort2 : '';
  const sorters = {
    status: (a, b) => rank(a) - rank(b) || (sec ? 0 : nextAt(a) - nextAt(b) || actRank(a) - actRank(b) || b.level - a.level),
    out: (a, b) => (a.state === 'Hospital' ? a.until : Infinity) - (b.state === 'Hospital' ? b.until : Infinity) || rank(a) - rank(b),
    level: (a, b) => b.level - a.level,
    stats: (a, b) => bs(a) - bs(b),
    active: (a, b) => actRank(a) - actRank(b) || b.lastAt - a.lastAt,
    name: (a, b) => a.name.localeCompare(b.name),
  };
  const byKey = (key, d, a, b) => {
    // No estimate yet: always last, whichever way the stats column is sorted.
    if (key === 'stats' && (!bs(a) || !bs(b))) return (!bs(a)) - (!bs(b));
    return d * (sorters[key] || sorters.status)(a, b);
  };
  const dir = opts.dir === -1 ? -1 : 1;
  const dir2 = opts.dir2 === -1 ? -1 : 1;
  rows.sort((a, b) => byKey(opts.sort, dir, a, b) || (sec ? byKey(sec, dir2, a, b) : 0) || sorters.status(a, b) || a.name.localeCompare(b.name));
  const showStats = !!ffs.hasKey;
  // Clickable headers: click to sort by a column (again to reverse); Shift+click to sort
  // by it second, within the first. The arrow shows the real order: ▲ low → high (A → Z),
  // ▼ high → low. The first click gives each column its most useful order (highest level,
  // weakest stats, most active…).
  const NATURAL_UP = { name: true, level: false, status: true, out: true, active: false, stats: true };
  const arrow = (key, d) => ((NATURAL_UP[key] !== false) === (d === 1) ? ' ▲' : ' ▼');
  const th = (key, label, cls = '') => {
    const on = opts.sort === key || (key === 'status' && opts.sort === 'out');
    const second = !on && sec === key;
    return `<th class="${cls} war-sort ${on ? 'sorted' : second ? 'sorted2' : ''}" data-war-sort="${key}" title="Click: sort by ${label.toLowerCase()} (again to reverse). Shift+click: sort by it second.">${label}${on ? arrow(opts.sort, dir) : second ? `<sup>2</sup>${arrow(key, dir2)}` : ''}</th>`;
  };
  return `<div class="table-wrap"><table class="data war-table">
    <tr>${th('name', 'Member')}${th('level', 'Lvl', 'num')}${th('status', 'Status')}${th('active', 'Last action')}${showStats ? th('stats', 'Est. stats', 'num') : ''}<th></th></tr>
    ${rows.map(m => {
      const s = stats[m.id];
      const away = m.state === 'Traveling' || m.state === 'Abroad';
      const isPinned = pinned.has(m.id);
      const band = s && s.bs ? estBand(s.bs, mine) : null;
      return `<tr class="${hittable(m) && opts.enemy ? 'war-hit' : ''} ${away ? 'dim' : ''} ${opts.enemy && claimsFor(m.id).length ? 'claimed-row' : ''}">
        <td><button class="pin-btn ${isPinned ? 'on' : ''}" data-war-pin="${m.id}" data-on="${isPinned ? 0 : 1}" title="${isPinned ? 'Unpin' : 'Pin to the list at the top'}">${isPinned ? '&#9733;' : '&#9734;'}</button>${avatar(m.id)}${link(profileUrl(m.id), esc(m.name))} <span class="muted small">[${m.id}]</span><div class="muted small pin-indent">${esc(m.position)}${m.revivable ? ' · revivable' : ''}</div></td>
        <td class="num">${m.level}</td>
        <td>${statusPill({ state: m.state, description: m.description }, m.until)}${statusDetail(m)}</td>
        <td>${lastActionDot(m)}</td>
        ${showStats ? `<td class="num">${s && s.bsHuman ? `<span class="est ${band ? band.cls : ''}" title="${band ? `${ratioText(band.ratio)} of your ${compactStat(mine)} (${band.label})` : 'Estimated total battle stats (FFScouter)'}">${esc(s.bsHuman)}</span><div class="muted small">${band ? `${ratioText(band.ratio)} · ` : ''}FF ${s.ff != null ? Number(s.ff).toFixed(2) : '–'}</div>` : '<span class="muted small">–</span>'}</td>` : ''}
        <td class="nowrap">${opts.enemy ? `<button class="primary" data-open="${attackUrl(m.id)}" title="Open the attack page in a Torn tab">Attack</button> <button data-war-target="${m.id}" title="Add to your Targets list">+ Target</button>${claimCell(m)}` : ''}</td>
      </tr>`;
    }).join('') || `<tr><td colspan="6" class="muted">No members match.</td></tr>`}
  </table></div>
  ${opts.noFilter ? '' : `<div class="note">${rows.length} of ${list.length} shown.${!showStats && opts.enemy ? ' Add your FFScouter key in Settings to see estimated battle stats here.' : ''}</div>`}`;
}

function rankedCard(w, r) {
  const now = Date.now();
  const own = w.own ? w.own.id : 0;
  const us = r.factions.find(f => f.id === own) || r.factions[0];
  const them = r.factions.find(f => f !== us) || r.factions[1] || { name: '?', score: 0, chain: 0 };
  const lead = us.score - them.score;
  const h = w.history;
  const rate = h ? leadRate(h.points) : null;
  const factionLink = f => link(`https://www.torn.com/factions.php?step=profile&ID=${f.id}`, esc(f.name));
  if (w.phase === 'upcoming') {
    return `<div class="war-card">
      <div class="war-title">Ranked war vs ${factionLink(them)}</div>
      <div class="war-big">Starts in ${countdown(r.start, 'now')}</div>
      <div class="muted">${tct(r.start)} TCT · target lead ${num(r.target)}</div></div>`;
  }
  const ended = w.phase === 'ended';
  const won = ended && r.winner === us.id;
  const pctToTarget = r.target ? Math.max(0, Math.min(1, lead / r.target)) : 0;
  const eta = !ended && rate && rate.lead > 0 && lead < r.target ? (r.target - lead) / rate.lead : null;
  return `<div class="war-card">
    <div class="row between wrap"><div class="war-title">Ranked war${ended ? ` · ended ${ago(r.end)}` : ''}</div>
      <span class="muted small">${ended ? `${tct(r.start)} → ${tct(r.end)} TCT` : `running ${fmtDur((now - r.start) / 1000)} · since ${tct(r.start)} TCT`}</span></div>
    <div class="war-sides">
      <div class="war-side us"><div class="muted small">${esc(us.name)} (you)</div><div class="war-score">${num(us.score)}</div><div class="small">chain ${num(us.chain)}${rate ? ` · +${num(Math.round(rate.us))}/h` : ''}</div></div>
      <div class="war-mid"><div class="war-lead ${signClass(lead)}">${lead > 0 ? '+' : ''}${num(lead)}</div><div class="muted small">lead · target ${num(r.target)}</div></div>
      <div class="war-side them"><div class="muted small">${factionLink(them)}</div><div class="war-score">${num(them.score)}</div><div class="small">chain ${num(them.chain)}${rate ? ` · +${num(Math.round(rate.them))}/h` : ''}</div></div>
    </div>
    <div class="war-progress" title="Lead towards the target"><span style="width:${(pctToTarget * 100).toFixed(1)}%"></span></div>
    <div class="small muted" style="margin-top:4px">${ended ? (r.winner ? (won ? '<span class="pos">You won.</span>' : '<span class="neg">You lost.</span>') : 'Ended.') : `${lead >= 0 ? `${(pctToTarget * 100).toFixed(1)}% of the target lead` : `${num(-lead)} behind`}${rate ? ` · lead ${rate.lead >= 0 ? 'growing' : 'shrinking'} ${num(Math.abs(Math.round(rate.lead)))}/h (last hour)` : ''}${eta ? ` · at this pace the target is reached in ~${fmtMin(eta * 60)} (the target also drops over time)` : ''}`}</div>
    <div class="chart-title" style="margin-top:10px">Score</div><div id="war-score-chart"></div>
  </div>`;
}

function otherWars(w) {
  if (!w.wars) return '';
  const own = w.own ? w.own.id : 0;
  const rows = [
    ...w.wars.raids.map(x => ({ kind: 'Raid', ...x })),
    ...w.wars.territory.map(x => ({ kind: `Territory ${x.territory}`, ...x })),
  ];
  if (!rows.length) return '';
  return `<h3>Raids &amp; territory wars</h3><table class="data">
    <tr><th>War</th><th>Opponent</th><th class="num">Score</th><th class="num">Chain</th><th>Status</th><th></th></tr>
    ${rows.map(x => {
      const us = x.factions.find(f => f.id === own) || {};
      const them = x.factions.find(f => f.id !== own) || {};
      return `<tr><td>${esc(x.kind)}</td><td>${esc(them.name || '?')}</td><td class="num">${num(us.score || 0)} – ${num(them.score || 0)}</td><td class="num">${num(us.chain || 0)} – ${num(them.chain || 0)}</td>
        <td>${x.end ? `ended ${ago(x.end)}` : `since ${tct(x.start)} TCT`}</td><td><button data-war-watch="${them.id}">Watch</button></td></tr>`;
    }).join('')}</table>`;
}

function renderWar() {
  const el = panel('war');
  if (!el || !el.classList.contains('active')) return;
  if (!S.api.hasKey) { el.innerHTML = '<div class="empty">Add your Torn API key in Settings to use war tools.</div>'; return; }
  const w = S.features.war;
  if (!w) { el.innerHTML = '<div class="empty">Loading…</div>'; return; }
  const board = prefs.get('war.board', 'enemy');
  const opts = {
    filter: prefs.get('war.filter', 'all'), sort: prefs.get('war.sort', 'status'), dir: prefs.get('war.dir', 1),
    sort2: prefs.get('war.sort2', ''), dir2: prefs.get('war.dir2', 1), q: prefs.get('war.q', ''),
  };
  const r = w.wars && w.wars.ranked;
  const e = w.enemy;
  const c = e && e.counts;
  const now = Date.now();
  // Next people back: hospital releases and (seen) landings, soonest first.
  const outSoon = e ? e.members
    .map(m => (m.state === 'Hospital' && m.until > now ? { m, at: m.until, plane: false } : m.trip && m.trip.seen && m.trip.landHi > now ? { m, at: m.trip.expected, plane: true } : null))
    .filter(Boolean).sort((a, b) => a.at - b.at).slice(0, 8) : [];
  const source = { ranked: 'your ranked war', raid: 'your raid', territory: 'your territory war', watch: 'watched by you' };
  const list = board === 'ours' ? (w.ours ? w.ours.members : []) : e ? e.members : [];

  el.innerHTML = `
    <div class="toolbar">
      <span class="muted small">${w.own ? `${esc(w.own.name)}${w.own.tag ? ` [${esc(w.own.tag)}]` : ''}${w.own.rank ? ` · ${esc(w.own.rank)}` : ''}` : w.noFaction ? 'You are not in a faction.' : 'Loading your faction…'}</span>
      <span class="spacer"></span>
      <label>Refresh every <select data-set="war.interval" data-num><option value="15">15 s</option><option value="30">30 s</option><option value="60">1 min</option><option value="120">2 min</option></select></label>
      <label title="During a war, while this tab is on screen, the enemy's statuses refresh this often (one request each time: 20 a minute at 3 s, 12 at 5 s). Your other Mentat calls make room for it.">Live while watching <select data-set="war.live" data-num><option value="0">Off</option><option value="3">3 s</option><option value="5">5 s</option><option value="10">10 s</option></select></label>
      ${w.live ? `<span class="pill ok" title="Enemy statuses refresh every ${w.live} s while this tab is on screen during the war.">Live · ${w.live} s</span>` : ''}
      <button data-cmd="war.refresh">Refresh now</button>
    </div>
    ${w.error ? `<div class="note neg">${esc(w.error)}</div>` : ''}
    ${S.features.claims && S.features.claims.error ? `<div class="note neg">Claims: ${esc(S.features.claims.error)}</div>` : ''}
    ${r ? rankedCard(w, r) : `<div class="war-card"><div class="war-title">No ranked war right now</div><div class="muted small">${w.wars ? `Checked ${ago(w.wars.fetchedAt)}.` : 'Checking…'} When your faction is matched, the countdown and live scores show here.</div></div>`}
    ${w.own || w.target ? chainsCard(w) : ''}
    ${otherWars(w)}

    <h3>${board === 'ours' ? 'Your faction' : 'Enemy board'}</h3>
    <div class="toolbar">
      <div class="subnav" style="margin:0"><button data-war-board="enemy" class="${board === 'enemy' ? 'active' : ''}">Enemy</button><button data-war-board="ours" class="${board === 'ours' ? 'active' : ''}">Your faction</button></div>
      ${board === 'enemy' ? `<span class="small">${e ? `<b>${factionTag(e.info && e.info.tagImage)}${link(`https://www.torn.com/factions.php?step=profile&ID=${e.id}`, esc(e.name))}</b> <span class="muted">· ${esc(source[e.source] || '')} · updated ${ago(e.fetchedAt)}</span>` : `<span class="muted">${w.target ? 'Loading members…' : 'No war opponent.'}</span>`}</span>
      <form class="row" data-war-watchform><input name="fid" type="number" min="1" placeholder="Faction ID" style="width:110px" value="${w.watchId || ''}"><button>Watch faction</button>${w.watchId ? '<button type="button" data-war-watch="0">Follow my war</button>' : ''}</form>` : `<span class="muted small">${w.ours ? `updated ${ago(w.ours.fetchedAt)}` : 'Loading…'}</span>`}
    </div>
    ${board === 'enemy' && c ? `<div class="grid4" style="margin:6px 0">
      <div class="stat"><div class="k">Hittable now</div><div class="v pos">${c.okay}</div><div class="small muted">of ${c.total} members</div></div>
      <div class="stat"><div class="k">In hospital</div><div class="v">${c.hospital}</div><div class="small muted">${c.out5} out within 5 min · ${c.out15} within 15</div></div>
      <div class="stat"><div class="k">Traveling / abroad</div><div class="v">${c.travel + c.abroad}</div><div class="small muted">${c.travel} flying${c.land15 ? ` · ${c.land15} landing within 15 min` : ''}${c.jail ? ` · ${c.jail} in jail` : ''}</div></div>
      <div class="stat"><div class="k">Online / idle</div><div class="v">${c.online} <span class="muted small">/ ${c.idle}</span></div><div class="small muted">active in the last few minutes</div></div>
    </div>
    ${outSoon.length ? `<div class="chips"><span class="muted small">Back next:</span>${outSoon.map(o => `<span class="chip-item" title="${o.plane ? 'Estimated landing' : 'Out of hospital'}">${o.plane ? '✈ ' : ''}${esc(o.m.name)} ${o.plane ? '~' : ''}${countdown(o.at, o.plane ? 'landing' : 'out')}</span>`).join('')}</div>` : ''}` : ''}
    ${board === 'ours' && w.ours && w.ours.denied ? '<div class="note">Your key can\'t see your faction\'s member list.</div>' : ''}
    <div class="toolbar" style="margin-top:8px">
      <select data-war-pref="filter">${WAR_FILTERS.map(([k, l]) => `<option value="${k}" ${opts.filter === k ? 'selected' : ''}>${l}</option>`).join('')}</select>
      <label>Sort <select data-war-pref="sort">${WAR_SORTS.map(([k, l]) => `<option value="${k}" ${opts.sort === k ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
      <label>then <select data-war-pref="sort2"><option value="">—</option>${WAR_SORTS.filter(([k]) => k !== 'out').map(([k, l]) => `<option value="${k}" ${opts.sort2 === k ? 'selected' : ''}>${l.replace(' (hittable first)', '')}</option>`).join('')}</select></label>
      <input data-war-pref="q" placeholder="Search name or ID" value="${esc(opts.q)}" style="width:160px">
    </div>
    ${(() => {
      if (!list.length) return `<div class="empty">${board === 'enemy' ? (w.target ? 'Loading members…' : 'No opponent right now. Enter a faction ID above to watch any faction.') : 'Loading…'}</div>`;
      const pinSet = new Set(w.pinned || []);
      const pinnedList = list.filter(m => pinSet.has(m.id));
      const rest = list.filter(m => !pinSet.has(m.id));
      const mine = (w.myStats && w.myStats.total) || 0;
      const common = { ...opts, enemy: board === 'enemy', pinned: w.pinned, mine };
      const ffsOn = S.features.ffscouter && S.features.ffscouter.hasKey;
      return `${pinnedList.length ? `<div class="pinned-head">&#9733; Pinned (${pinnedList.length})</div>${memberRows(pinnedList, { ...common, noFilter: true })}<div class="pinned-head rest">Everyone else</div>` : ''}
        ${memberRows(rest, common)}
        ${ffsOn && board === 'enemy' ? (mine ? estLegend(mine) : `<div class="note">${w.myStats && w.myStats.denied ? 'Colour-coding needs your battle stats, which needs a Limited (or Full) API key.' : 'Loading your battle stats for colour-coding…'}</div>`) : ''}`;
    })()}
    ${board === 'enemy' && w.history && w.history.avail.length > 1 ? '<div class="chart-title" style="margin-top:10px">Enemy availability during the war</div><div id="war-avail-chart"></div>' : ''}
    <div class="note">Statuses refresh every ${w.interval} s during a war (only while this tab is open otherwise). Attack opens the attack page in the Torn browser; nothing is done for you. Alerts → "War enemy out of hospital" can warn you before someone comes out.</div>`;
  syncSettingInputs();

  const h = w.history;
  const sc = $('#war-score-chart');
  if (sc && h) {
    lineChart(sc, {
      series: [
        { name: 'You', points: h.points.map(p => [p[0], p[1]]), color: CHART_COLORS[0] },
        { name: r ? ((r.factions.find(f => !w.own || f.id !== w.own.id) || {}).name || 'Enemy') : 'Enemy', points: h.points.map(p => [p[0], p[2]]), color: CHART_COLORS[1] },
      ],
      yFmt: v => num(Math.round(v)), empty: 'The score chart builds up while the app runs during the war.',
    });
  } else if (sc) sc.innerHTML = '<div class="muted small">The score chart builds up while the app runs during the war.</div>';
  const ac = $('#war-avail-chart');
  if (ac && h) {
    lineChart(ac, {
      series: [
        { name: 'Hittable', points: h.avail.map(p => [p[0], p[1]]), color: CHART_COLORS[2] },
        { name: 'In hospital', points: h.avail.map(p => [p[0], p[2]]), color: CHART_COLORS[1] },
        { name: 'Online / idle', points: h.avail.map(p => [p[0], p[3]]), color: CHART_COLORS[0] },
      ],
      yFmt: v => String(Math.round(v)), yZero: true,
    });
  }
}

function initWar() {
  const el = panel('war');
  el.addEventListener('click', e => {
    const b = e.target.closest('[data-war-board]');
    if (b) { prefs.set('war.board', b.dataset.warBoard); renderWar(); return; }
    const sortTh = e.target.closest('[data-war-sort]');
    if (sortTh) {
      const key = sortTh.dataset.warSort;
      const cur = prefs.get('war.sort', 'status');
      const same = cur === key || (key === 'status' && cur === 'out');
      if (e.shiftKey && !same) {
        // Shift+click: second sort column (again to reverse it).
        const cur2 = prefs.get('war.sort2', '');
        prefs.set('war.dir2', cur2 === key ? -prefs.get('war.dir2', 1) : 1);
        prefs.set('war.sort2', key);
      } else {
        prefs.set('war.dir', same ? -prefs.get('war.dir', 1) : 1);
        // Promoting the second column to first: keep the old first as the second.
        if (!same && prefs.get('war.sort2', '') === key) { prefs.set('war.sort2', cur === 'out' ? 'status' : cur); prefs.set('war.dir2', prefs.get('war.dir', 1)); }
        prefs.set('war.sort', key);
      }
      renderWar();
      return;
    }
    const pin = e.target.closest('[data-war-pin]');
    if (pin) { cmd('war.pin', Number(pin.dataset.warPin), pin.dataset.on === '1'); return; }
    const cl = e.target.closest('[data-war-claim]');
    if (cl) {
      cl.disabled = true;
      cmd('war.claim', Number(cl.dataset.warClaim), cl.dataset.on === '1').catch(() => { cl.disabled = false; });
      return;
    }
    const t = e.target.closest('[data-war-target]');
    if (t) { cmd('targets.add', t.dataset.warTarget).then(() => { t.textContent = 'Added'; t.disabled = true; }); return; }
    const wch = e.target.closest('[data-war-watch]');
    if (wch) cmd('war.watch', Number(wch.dataset.warWatch) || 0);
  });
  el.addEventListener('submit', e => {
    const f = e.target.closest('[data-war-watchform]');
    if (!f) return;
    e.preventDefault();
    const id = Number(f.elements.fid.value) || 0;
    if (id > 0) cmd('war.watch', id);
  });
  el.addEventListener('change', e => {
    const p = e.target.closest('[data-war-pref]');
    if (p) {
      prefs.set(`war.${p.dataset.warPref}`, p.value);
      if (p.dataset.warPref === 'sort') prefs.set('war.dir', 1); // the dropdowns pick the natural order
      if (p.dataset.warPref === 'sort2') prefs.set('war.dir2', 1);
      renderWar();
    }
  });
  el.addEventListener('input', e => {
    const p = e.target.closest('[data-war-pref="q"]');
    if (!p) return;
    prefs.set('war.q', p.value);
    clearTimeout(initWar.t);
    initWar.t = setTimeout(() => {
      renderWar();
      const i = $('[data-war-pref="q"]');
      if (i) { i.focus(); i.setSelectionRange(i.value.length, i.value.length); }
    }, 250);
  });
}
