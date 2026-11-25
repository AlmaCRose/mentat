'use strict';
/* global S, $, esc, cmd, prefs, panel, money, num, ago, fmtAgo, tct, avatar, link, profileUrl, attackUrl, bazaarUrl, itemLink, statusPill, ffPill */
// Mugger tab (features/mugger.js + muggerdb.js do the collecting).
// In Torn: a preview from the market database (who trades a country's items), no API calls.
// Flying out or abroad: the players at or flying to your country, with their estimated cash on hand
// (trip money while still flying out, bazaar and item market sales since they left Torn), what a mug
// would take (Torn wiki formula), and the fight (your stats vs FFScouter's estimate).

const MUG_OPEN = new Set();
let MUG_PASTE_MSG = '';

// Copied from Torn's People list with its links: turn the links into "Name [id]" lines, so every
// player's ID comes along (plain text only has the names).
function mugPeopleFromHtml(html) {
  try {
    const doc = new DOMParser().parseFromString(String(html || ''), 'text/html');
    const out = new Map();
    for (const a of doc.querySelectorAll('a[href]')) {
      const m = /[?&](?:XID|user2ID)=(\d+)/i.exec(a.getAttribute('href') || '');
      if (!m) continue;
      const name = (a.textContent || '').trim().replace(/\s+/g, '');
      if (!out.has(m[1]) || (!out.get(m[1]) && name)) out.set(m[1], /^[A-Za-z0-9_-]{1,20}$/.test(name) ? name : '');
    }
    return [...out].map(([id, name]) => (name ? `${name} [${id}]` : `XID=${id}`)).join('\n');
  } catch (e) { return ''; }
}

// Mugged here within 12 hours: off the list, not checked again until their protection ends.
function mugProtectedBox(f) {
  const list = f.mugged || [];
  if (!list.length) return '';
  const li = list.map(m => `<li>${link(profileUrl(m.id), esc(m.name || `#${m.id}`))} <span class="muted small">[${m.id}]${m.level ? ` · lvl ${m.level}` : ''}</span> · ${esc(m.text || 'Mugged')}${m.inHospital ? ' (in hospital)' : ''} · first seen ${fmtAgo(m.at)} · <b>protected until ${tct(m.ends)} TCT</b></li>`).join('');
  return `<div class="card mug-protected"><div><b>Mug protected</b> <span class="muted small">${num(list.length)} mugged in ${esc(f.country)}: what they had left is protected, so they're off the list and not checked again until it ends (12 hours from when Mentat first saw them in hospital).</span></div><ul>${li}</ul></div>`;
}

// The People list box: paste, the list's state, who left.
function mugPasteCard(f) {
  const ps = f.paste;
  const c = esc(f.trip.country);
  let state;
  if (!ps) state = `Copy Torn's People list for ${c} (select the list on the page and copy it) and paste it here, a page at a time if it has several, or in a Mentat Torn tab right-click a name in the list → <b>Add all players in this list to Mugger</b>. Once you've landed, Mugger checks only those people, traders or not, and drops anyone who leaves ${c}.`;
  else {
    const bits = [];
    if (ps.active) bits.push(`Checking only the <b>${num(ps.count)}</b> people you pasted (${num(ps.traders)} in the market database)`);
    else bits.push(`<b>${num(ps.count)}</b> pasted; Mugger switches to them when you land`);
    if (ps.lookups) bits.push(`looking up ${num(ps.lookups)} name${ps.lookups === 1 ? '' : 's'}`);
    if (ps.leftCount) bits.push(`<span title="${esc(ps.left.map(x => `${x.name || `#${x.id}`}${x.to ? ` → ${x.to}` : ''} (${fmtAgo(x.at)})`).join('\n'))}">${num(ps.leftCount)} left: ${esc(ps.left.slice(0, 3).map(x => x.name || `#${x.id}`).join(', '))}${ps.leftCount > 3 ? '…' : ''}</span>`);
    if (ps.notFoundCount) bits.push(`<span class="muted" title="${esc(ps.notFound.join(', '))}">${num(ps.notFoundCount)} not found</span>`);
    state = bits.join(' · ');
  }
  return `<div class="card mug-paste">
    <div class="small" style="margin-bottom:6px">${state}</div>
    <textarea id="mug-paste" rows="2" spellcheck="false" placeholder="Paste Torn's People list for ${c}"></textarea>
    <div class="row" style="gap:6px;margin-top:6px"><button class="primary" id="mug-paste-add">Add to the list</button>${ps ? '<button id="mug-paste-clear" title="Forget the pasted list: back to the best traders">Clear list</button>' : ''}<span class="small muted">${esc(MUG_PASTE_MSG)}</span></div>
  </div>`;
}
// The country score's parts; the overall score has the same without fit, over every abroad item, scaled to 100.
const MUG_PARTS = { trading: ['Trading (30 days)', 30], stock: ['Stock now', 10], activity: ['Bazaar activity (Torn)', 10], fit: ['Fits this country', 15], travel: ['Items bought abroad (week)', 15], cash: ['Cash on hand (est.)', 20] };
const pctTxt = x => `${(x * 100).toFixed(x < 0.1 ? 1 : 0)}%`;

function mugWhere(r) {
  const pl = r.place || {};
  const st = r.status || {};
  if (pl.kind === 'flying') {
    const f = r.flight;
    let when = '';
    if (f && f.landHi) {
      const now = Date.now();
      if (f.landHi < now) when = 'should have landed';
      else if (f.landLo) when = `lands ${tct(Math.max(now, f.landLo))}–${tct(f.landHi)} TCT`;
      else when = `lands by ${tct(f.landHi)} TCT`;
    }
    const tip = `${st.description}. ${f && f.landLo ? 'Landing window from when Mentat saw them leave and the flight times (a travel book can make it shorter).' : "Mentat didn't see them leave, so only the latest landing is known."}`;
    return `<span class="pill info" title="${esc(tip)}">Flying in</span><div class="muted small">${esc(when)}</div>`;
  }
  if (pl.kind === 'hospital') return `${statusPill(st, st.until)}<div class="muted small">in ${esc(pl.place)}</div>`;
  return `<span class="pill ok" title="${esc(st.description || '')}">In ${esc(pl.place)}</span>${r.awaySince ? `<div class="muted small">away since ${tct(r.awaySince)} TCT</div>` : ''}`;
}

function mugLast(r) {
  const la = r.lastAction;
  if (!la) return '';
  const cls = la.status === 'Online' ? 'on' : la.status === 'Idle' ? 'idle' : '';
  return `<div class="small"><span class="la-dot ${cls}"></span>${esc(la.status)}${la.at ? ` · ${ago(la.at)}` : ''}</div>`;
}

function mugScore(r, country) {
  const pill = (s, label, tip) => `<span class="pill ${s.total >= 60 ? 'ok' : s.total >= 35 ? 'warn' : ''} mono" title="${esc(tip)}">${label} ${s.total}</span>`;
  const hereTip = `For ${country}: items sold there only.\n` + Object.entries(MUG_PARTS).map(([k, [l, max]]) => `${l}: ${Math.round(r.score.parts[k])}/${max}`).join('\n');
  const o = r.overall;
  const allTip = 'Overall: every abroad item (no fit), scaled to 100.\n' + Object.entries(MUG_PARTS).filter(([k]) => k !== 'fit').map(([k, [l, max]]) => `${l}: ${Math.round(o.parts[k])}/${max}`).join('\n');
  return `<div class="mug-scores">${pill(r.score, 'here', hereTip)}${pill(o, 'all', allTip)}</div>`;
}

function mugCash(r) {
  const c = r.cash;
  const unk = c && c.tripUnknown ? `<div class="muted small" title="${esc(c.tripUnknown)}">trip money not known</div>` : '';
  if (!c || !c.total) return `<span class="muted small" title="No sales seen since they left Torn${r.place && r.place.kind === 'here' ? ', and they have probably spent their trip money' : ''}">none seen</span>${unk}`;
  const parts = [];
  const tc = r.tripCash;
  if (c.trip) parts.push(tc ? `<span title="${esc(`${num(Math.round(tc.items))} × ${tc.name} at ${money(tc.cost, true)}: ${tc.basis}; ${tc.why || ''}.`)}">trip money ${money(c.trip, true)} (${num(Math.round(tc.items))} × ${esc(tc.name)})</span>` : `trip money ${money(c.trip, true)}`);
  if (c.bazaar) parts.push(`bazaar ${money(c.bazaar, true)}`);
  if (c.market) parts.push(`market ${money(c.market, true)}`);
  return `<b>${money(c.total, true)}</b><div class="muted small">${parts.join(' + ')}</div>${unk}`;
}

// Possible mug protection: in hospital in this country within 12 hours (confirmed if the reason
// says "Mugged by"), or fights lost abroad since yesterday (country unknown).
function mugProtect(r) {
  const pr = r.protect;
  const out = { pills: [], line: '' };
  if (pr) {
    const when = `${pr.now ? 'In hospital' : 'Was in hospital'} in ${pr.place}, first seen ${fmtAgo(pr.at)}`;
    const tail = `What they had left is protected, less each hour, gone after 12 hours (Torn wiki). Flag ends ${tct(pr.ends)} TCT.`;
    if (pr.mugged) {
      out.pills.push(`<span class="pill warn" title="${esc(`${pr.text}. ${when}. ${tail}`)}">mugged ${fmtAgo(pr.at)}</span>`);
      out.line = `${esc(pr.text)} (${esc(when)}): ${esc(tail)}`;
    } else {
      const why = `${when}${pr.text ? ` (${pr.text})` : ''}. If they were mugged, what they had left is protected, less each hour, for 12 hours (Torn wiki). Flag ends ${tct(pr.ends)} TCT.`;
      out.pills.push(`<span class="pill warn" title="${esc(why)}">may be mug-protected</span>`);
      out.line = esc(why);
    }
  }
  const lost = r.rec && r.rec.lostAbroad;
  if (lost && lost.n > 0) {
    const why = `Lost ${lost.n} fight${lost.n === 1 ? '' : 's'} abroad since yesterday (Torn's daily "defends lost abroad" count, which doesn't say where). A mug is a lost fight, so they may be protected.`;
    if (!pr) out.pills.push(`<span class="pill warn" title="${esc(why)}">lost ${lost.n} abroad</span>`);
    out.line = out.line ? `${out.line} ${esc(why)}` : esc(why);
  }
  return out;
}

function mugTake(r) {
  const t = r.take;
  const warn = [];
  if (r.job && r.job.clothing && r.job.rating >= 7) warn.push('<span class="pill bad" title="Works at a 7★ Clothing Store: mugs take 75% less (Torn wiki)">7★ Clothing −75%</span>');
  else if (r.job && r.job.clothing) warn.push(`<span class="pill warn" title="Works at a ${r.job.rating}★ Clothing Store. The wiki gives the 75% cut for 7★ stores.">${r.job.rating}★ Clothing</span>`);
  if (r.live) warn.push(...mugProtect(r).pills);
  if (!t) return warn.join(' ') || '<span class="muted small">–</span>';
  return `<b title="${esc(`${pctTxt(t.pctLo)}–${pctTxt(t.pctHi)} of the estimated cash on hand. Low rolls are much likelier than high ones (Torn wiki).`)}">${money(t.lo, true)}–${money(t.hi, true)}</b>${warn.length ? `<div>${warn.join(' ')}</div>` : ''}`;
}

function mugMarket(m, r) {
  if (!m) return '<span class="muted small">not in the market database</span>';
  const top = m.items.slice(0, 2).map(i => `${num(i.q)} ${esc(i.name)}`).join(', ');
  const more = m.items.length > 2 ? ` +${m.items.length - 2}` : '';
  const lines = [`<div title="${esc(`Abroad items in their bazaar, valued at the abroad shop price (listed for ${money(m.listed, true)})`)}"><b>${money(m.value, true)}</b> <span class="muted small">${top || 'nothing listed now'}${more}</span></div>`];
  if (m.rc30) lines.push(`<div class="small" title="Restocks in the last 30 days at abroad prices, ${num(m.active)} active days">${money(m.rc30 / (30 / 7), true)}/week restocked</div>`);
  if (m.spec && m.spec.length) lines.push(`<div class="small" title="Torn's bazaar directory: one of the top 10 bazaars for ${esc(m.spec[0].name)}">${num(m.spec[0].customers)} customers/week · top ${esc(m.spec[0].name)} bazaar</div>`);
  else if (m.busiest) lines.push(`<div class="small" title="Torn's weekly list of the busiest bazaars">${num(m.busiest)} customers/week (busiest bazaars)</div>`);
  const lr = m.lastRestock;
  if (lr) lines.push(`<div class="muted small" title="${esc(`Players put several trips' worth in at once.${r.perTrip ? ` At ${num(Math.round(r.perTrip.n))} items a trip (${r.perTrip.basis}).` : ''}`)}">last restock +${num(lr.dq)} ${esc(lr.name)}${lr.trips && lr.trips > 1.5 ? ` ≈ ${Math.round(lr.trips)} trips` : ''} · ${fmtAgo(lr.at)}</div>`);
  return lines.join('');
}

function mugTravel(r) {
  const rec = r.rec;
  if (!rec) return `<span class="muted small">${r.live ? 'loading…' : 'loads during a trip'}</span>`;
  const fav = rec.favourite ? `<div class="muted small">Most trips: ${esc(rec.favourite)}</div>` : '';
  if (rec.week) return `<div><b>${num(rec.week.items)}</b> items · ${num(rec.week.trips)} trips <span class="muted small">last 7 days</span></div>${fav}`;
  return `<div>${num(rec.now.items)} items · ${num(rec.now.trips)} trips <span class="muted small">all time</span></div>${fav}`;
}

function mugFight(r, est, me) {
  const e = est[r.id];
  const parts = [];
  if (e && e.ff !== null && e.ff !== undefined) parts.push(ffPill(e));
  if (e && e.bs && me && me.total) {
    const ratio = e.bs / me.total;
    const cls = ratio < 0.8 ? 'ok' : ratio < 1.25 ? 'warn' : 'bad';
    parts.push(`<span class="pill ${cls}" title="${esc(`FFScouter's estimate of their battle stats (${e.bsHuman || num(e.bs)}) ÷ yours (${num(me.total)}). Below 1 = weaker than you on paper.`)}">${ratio < 10 ? ratio.toFixed(2) : Math.round(ratio)}× you</span>`);
  }
  if (!parts.length) parts.push('<span class="muted small">no estimate</span>');
  const life = r.life && r.life.maximum ? `Life ${num(r.life.current)}/${num(r.life.maximum)} · ` : '';
  return `<div class="row" style="flex-wrap:wrap;gap:4px">${parts.join('')}</div><div class="muted small">${life}level ${r.level || '?'}</div>`;
}

function mugDetail(r, me, est, f) {
  const s = r.score;
  const o = r.overall;
  const bars = Object.entries(MUG_PARTS).map(([k, [l, max]]) => `<div class="mug-part"><span>${esc(l)}</span><span class="mug-track"><span style="width:${Math.round(100 * s.parts[k] / max)}%"></span></span><span class="mono">${Math.round(s.parts[k])}/${max}</span></div>`).join('');
  const c = r.cash, tc = r.tripCash;
  const lines = [];
  if (r.live) {
    if (c && c.trip && tc) lines.push(`Trip money ${money(c.trip, true)}: still flying out, so not spent yet. ${num(Math.round(tc.items))} items, ${esc(tc.basis)}, × ${money(tc.cost, true)} for ${esc(tc.name)} (${esc(tc.why || '')}).`);
    else if (c && c.tripUnknown) lines.push(`Trip money: not known. ${esc(c.tripUnknown)}`);
    else if (tc && r.place && r.place.kind !== 'flying') lines.push(`A trip here takes them about ${money(tc.amount, true)} (${num(Math.round(tc.items))} × ${esc(tc.name)}); they've landed, so it's probably spent and isn't counted.`);
    if (c && c.since) lines.push(`Bazaar sales since ${tct(c.since)} TCT: ${money(c.bazaar, true)}${c.bazaarUnits ? ` (${num(c.bazaarUnits)} items)` : ''}.`);
    if (r.trade) lines.push(`Item market revenue less fees since ${tct(r.trade.since)} TCT: ${money(c ? c.market : 0, true)} (checked ${fmtAgo(r.trade.at)}).`);
    else lines.push(`Item market sales: checked every ${f.settings.market} minutes while they are in this country.`);
    if (r.take) lines.push(`Mug: ${pctTxt(r.take.pctLo)}–${pctTxt(r.take.pctHi)} of ${money(c.total, true)} = <b>${money(r.take.lo, true)}–${money(r.take.hi, true)}</b>${r.take.clothing ? ' (7★ Clothing Store: −75%)' : ''}. Low rolls are much likelier.`);
    const prot = mugProtect(r);
    if (prot.line) lines.push(`<span class="neg">${prot.line}</span>`);
  } else if (tc) lines.push(`A trip to ${esc(f.country)} takes them about <b>${money(tc.amount, true)}</b>: ${num(Math.round(tc.items))} items, ${esc(tc.basis)}, × ${money(tc.cost, true)} for ${esc(tc.name)} (${esc(tc.why || '')}).`);
  else if (r.tripUnknown) lines.push(`A trip to ${esc(f.country)}: not known. ${esc(r.tripUnknown)}`);
  const job = r.job && !r.job.error ? (r.job.company ? `<div class="small">Works at ${esc(r.job.company)} (${num(r.job.rating)}★${r.job.clothing ? ', Clothing Store' : ''}${r.job.cruise ? ', Cruise Line' : ''}).</div>` : `<div class="small">${r.job.job ? `Job: ${esc(r.job.job)}` : 'No company.'}</div>`) : '';
  const e = est[r.id];
  const fight = `<div class="small" style="margin-top:6px"><b>Fight.</b> ${e && e.bsHuman ? `Their estimated battle stats ${esc(e.bsHuman)} (FFScouter${e.updated ? `, ${new Date(e.updated).toLocaleDateString()}` : ''})` : 'No FFScouter estimate'}${me && me.total ? ` · yours ${num(me.total)}` : ''}${e && e.ff ? ` · fair fight ${e.ff.toFixed(2)}` : ''}.</div>`;

  const m = r.market;
  const all = m ? [...m.items, ...(m.small || [])] : [];
  const items = all.length ? `<table class="data"><tr><th>In their bazaar</th><th class="num">Qty</th><th class="num">Their price</th><th class="num">Abroad</th><th>Sold in</th></tr>${all.map(i => `<tr${i.small ? ' class="dim" title="5 or fewer: not counted as trading"' : ''}><td>${itemLink(i.id, esc(i.name))}${i.small ? ' <span class="small">(not counted)</span>' : ''}</td><td class="num">${num(i.q)}</td><td class="num">${money(i.price)}</td><td class="num">${money(i.cost)}</td><td>${esc(i.countries.join(', '))}</td></tr>`).join('')}</table>` : '<div class="muted small">No abroad items in their bazaar now.</div>';
  const dirBits = m ? [
    ...(m.spec || []).map(x => `top ${esc(x.name)} bazaar, ${num(x.customers)} customers this week`),
    m.busiest ? `busiest bazaars list, ${num(m.busiest)} customers this week` : '',
    m.income ? `top grossing list, ${money(m.income, true)} this week` : '',
    m.bulk ? `bulk sales list, ${num(m.bulk)} this week` : '',
  ].filter(Boolean) : [];
  const dirLine = dirBits.length ? `<div class="small" style="margin-top:6px"><b>Torn's bazaar directory${m.bazaar ? ` (${esc(m.bazaar)})` : ''}:</b> ${dirBits.join('; ')}.</div>` : '';
  const act = m ? `${dirLine}<div class="small" style="margin-top:6px">Last 30 days: restocked ${num(m.r30)} items (${money(m.rc30, true)} at abroad prices${m.small30 ? `; plus ${num(m.small30)} in small restocks of 5 or fewer, not counted` : ''}), sold ${num(m.s30)} (${money(m.sv30, true)}), active on ${num(m.active)} days. In the database since ${new Date(m.first).toLocaleDateString()}.</div>` : '';
  const ev = m && m.ev.length ? `<div class="small" style="margin-top:6px"><b>Recent bazaar changes:</b> ${m.ev.slice().reverse().slice(0, 10).map(x => `<span class="${x.dq > 0 ? 'pos' : ''}">${x.dq > 0 ? '+' : ''}${num(x.dq)} ${esc(x.name)}${x.gone ? ' (sold out / removed)' : ''}${x.small ? ' (small, not counted)' : ''} · ${fmtAgo(x.at)}</span>`).join('; ')}</div>` : '';

  const rec = r.rec;
  let recHtml = `<div class="muted small">${r.live ? 'Their travel record loads once per trip.' : 'Their travel record loads when they are near you on a trip.'}</div>`;
  if (rec) {
    const per = Object.entries(rec.per || {}).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
    const max = per.length ? per[0][1] : 1;
    recHtml = `<div class="small"><b>${num(rec.now.items)}</b> items bought abroad in <b>${num(rec.now.trips)}</b> trips${rec.week ? `; last 7 days ${num(rec.week.items)} in ${num(rec.week.trips)}` : ''}. Defends lost abroad ${num(rec.now.defendsLost)}.</div>
      ${per.map(([n, v]) => `<div class="mug-part"><span>${esc(n)}</span><span class="mug-track"><span style="width:${Math.round(100 * v / max)}%"></span></span><span class="mono">${num(v)}</span></div>`).join('')}
      <div class="note">Loaded ${ago(rec.at)}.</div>`;
  }
  return `<div class="mug-detail">
    <div class="mug-dcol"><b class="small">For ${esc(f.country)}: ${s.total}/100</b> <span class="muted small">(items sold there)</span>${bars}<div class="small" style="margin-top:4px"><b>Overall: ${o.total}/100</b> <span class="muted">(every abroad item: trading ${Math.round(o.parts.trading)}, stock ${Math.round(o.parts.stock)}, activity ${Math.round(o.parts.activity)}, travel ${Math.round(o.parts.travel)}, cash ${Math.round(o.parts.cash)}, of 85, scaled)</span></div><div class="small" style="margin-top:8px">${lines.join('<br>')}</div>${job}${fight}</div>
    <div class="mug-dcol">${items}${act}${ev}</div>
    <div class="mug-dcol">${recHtml}</div>
  </div>`;
}

function renderMugger() {
  const el = panel('mugger');
  const f = S.features.mugger;
  if (!el) return;
  if (!f) { el.innerHTML = '<div class="mug-wip" role="note">Work In Progress</div><div class="card">Starting…</div>'; return; }
  const est = (S.features.ffscouter || {}).stats || {};
  const ffsKey = (S.features.ffscouter || {}).hasKey;
  const me = f.me && !f.me.denied && f.me.total ? f.me : null;
  const db = f.db || {};
  const sc = db.scan || {};
  const live = f.live;
  const flying = prefs.get('mugger.flying', true);
  const hosp = prefs.get('mugger.hosp', false);
  const sort = prefs.get('mugger.sort', 'score');
  let rows = f.rows.filter(r => !live || ((flying || r.place.kind !== 'flying') && (hosp || r.place.kind !== 'hospital')));
  const by = {
    score: (a, b) => b.score.total - a.score.total || b.overall.total - a.overall.total,
    overall: (a, b) => b.overall.total - a.overall.total || b.score.total - a.score.total,
    take: (a, b) => ((b.take && b.take.lo) || 0) - ((a.take && a.take.lo) || 0),
    trip: (a, b) => ((b.tripCash && b.tripCash.amount) || 0) - ((a.tripCash && a.tripCash.amount) || 0),
    ff: (a, b) => ((est[a.id] && est[a.id].ff) || 99) - ((est[b.id] && est[b.id].ff) || 99),
    bs: (a, b) => ((est[a.id] && est[a.id].bs) || 1e15) - ((est[b.id] && est[b.id].bs) || 1e15),
    landing: (a, b) => ((a.flight && a.flight.landHi) || 0) - ((b.flight && b.flight.landHi) || 0),
  };
  rows = rows.slice().sort(by[sort] || by.score);

  const opt = (v, l, cur) => `<option value="${esc(v)}"${String(v) === String(cur) ? ' selected' : ''}>${esc(l)}</option>`;
  const trip = f.trip;
  const tripLine = trip
    ? `${trip.flying ? `Flying to <b>${esc(trip.country)}</b>` : `In <b>${esc(trip.country)}</b>`}${live ? ` · ${num(f.checked)}/${num(f.pool)} ${f.poolMode === 'paste' ? 'pasted people' : 'traders'} located` : ` · showing ${esc(f.country)} from the database only (live checks are for ${esc(trip.country)})`}`
    : `In Torn: Mugger checks who is where once you fly abroad. Showing the market database for <b>${esc(f.country)}</b> (no API calls).`;
  const dbLine = sc.running
    ? `Reading bazaars ${num(sc.done)}/${num(sc.total)} items…`
    : `${num(db.sellers || 0)} traders · ${num(db.days || 0)} day${db.days === 1 ? "" : "s"} of history${db.oldest ? ` since ${esc(db.oldest)}` : ''} · ${db.lastScan ? `read ${ago(db.lastScan)}` : 'first read starts when abroad stock has loaded'} · ${db.remote ? 'from the Mentat server' : 'collected on this device'}`;
  const watching = live && db.watching && db.watching.length ? ` · re-reading ${esc(db.watching.slice(0, 4).join(', '))}${db.watching.length > 4 ? ` +${db.watching.length - 4}` : ''} every 5 min` : '';
  const mug = f.mug || { mult: 1, looting: 0 };
  const mugLine = `Your mug: 5–10% × ${mug.mult.toFixed(2)} = <b>${pctTxt(0.05 * mug.mult)}–${pctTxt(0.10 * mug.mult)}</b> of cash on hand (Masterful Looting ${num(mug.looting)}/10${mug.lootingAuto ? (mug.merits && Number.isFinite(mug.merits.looting) ? ', from your merits' : ', merits read on your next trip') : ''}${mug.plunder ? `, Plunder ${mug.plunder}%` : ''})`;
  const meLine = f.me && f.me.denied ? '<span class="neg">Your battle stats need a Limited key.</span>'
    : me ? `Your battle stats <b>${num(me.total)}</b>` : (live ? '<span class="muted">Loading your battle stats…</span>' : '');
  const chips = live ? Object.entries(f.places || {}).sort((a, b) => b[1] - a[1]).map(([k, n]) => {
    const [p, fly] = k.split('|');
    return `<span class="chip-item" title="Checked traders ${fly ? 'flying to' : 'in'} ${esc(p)}">${fly ? '→ ' : ''}${esc(p)} <b>${n}</b></span>`;
  }).join('') : '';

  const head = live
    ? '<tr><th class="num">#</th><th>Player</th><th>Where</th><th class="num" title="Score for this country (its items only) and overall (every abroad item), each 0–100">Score</th><th class="num" title="Estimated: trip money while still flying out, plus bazaar and item market sales since they left Torn">Cash on hand</th><th class="num" title="What a mug would take from that, with your merits and Plunder (Torn wiki formula)">Mug take</th><th title="From the market database">Trading</th><th>Travel</th><th>Fight</th><th></th></tr>'
    : '<tr><th class="num">#</th><th>Player</th><th class="num" title="Score for this country (its items only) and overall (every abroad item), each 0–100">Score</th><th class="num" title="Items a trip × the abroad price of what they stock most from this country">Cash a trip</th><th title="From the market database">Trading</th><th>Travel</th><th></th></tr>';
  const cols = live ? 10 : 7;
  const body = rows.length ? rows.map((r, i) => {
    const open = MUG_OPEN.has(r.id);
    const sub = [r.faction ? esc(r.faction.name) : (r.live ? 'No faction' : ''), r.age ? `${num(r.age)} days old` : ''].filter(Boolean).join(' · ');
    const who = `<td><div class="row" style="gap:6px">${avatar(r.id)}<div>${link(profileUrl(r.id), esc(r.name || `#${r.id}`))} <span class="muted small">[${r.id}]</span>${r.listed ? ' <span class="pill" title="On your Targets or Abroad list">listed</span>' : ''}${sub ? `<div class="muted small">${sub}</div>` : ''}${mugLast(r)}</div></div></td>`;
    const acts = `<td class="mug-act">${live ? `<button class="primary" data-open="${esc(attackUrl(r.id))}" title="Opens the attack page in a Torn tab">Attack</button>` : ''}<button data-open="${esc(bazaarUrl(r.id))}" title="Their bazaar">Bazaar</button>${live && !r.listed ? `<button data-cmd="targets.add" data-arg="${r.id}" title="Add to your Abroad list">+ List</button>` : ''}${live ? `<button data-cmd="mugger.recheck" data-arg="${r.id}" title="Check where they are now">&#8635;</button>` : ''}</td>`;
    const tc = r.tripCash ? `<b>${money(r.tripCash.amount, true)}</b><div class="muted small">${num(Math.round(r.tripCash.items))} × ${esc(r.tripCash.name)}</div>` : r.tripUnknown ? `<span class="muted small" title="${esc(r.tripUnknown)}">not known</span>` : '<span class="muted small">–</span>';
    const cells = live
      ? `<td>${mugWhere(r)}</td><td class="num">${mugScore(r, f.country)}</td><td class="num">${mugCash(r)}</td><td class="num">${mugTake(r)}</td><td>${mugMarket(r.market, r)}</td><td>${mugTravel(r)}</td><td>${mugFight(r, est, me)}</td>`
      : `<td class="num">${mugScore(r, f.country)}</td><td class="num">${tc}</td><td>${mugMarket(r.market, r)}</td><td>${mugTravel(r)}</td>`;
    return `<tr class="clickable${open ? ' selected' : ''}" data-mug-row="${r.id}"><td class="num muted">${i + 1}</td>${who}${cells}${acts}</tr>${open ? `<tr class="detail"><td colspan="${cols}">${mugDetail(r, me, est, f)}</td></tr>` : ''}`;
  }).join('') : `<tr><td colspan="${cols}" class="muted" style="padding:14px">${live
    ? `Nobody from the ${num(f.pool)} ${f.poolMode === 'paste' ? 'people you pasted' : 'traders being checked'} is ${flying ? 'in or flying to' : 'in'} ${esc(f.country)} yet${f.checked < f.pool ? ` (${num(f.checked)}/${num(f.pool)} checked so far)` : ''}.`
    : db.sellers ? `No traders of ${esc(f.country)}'s items in the database yet.` : 'The market database is empty: the first read of the bazaars takes about 8 minutes.'}</td></tr>`;

  el.innerHTML = `
    <div class="mug-wip" role="note">Work In Progress</div>
    <h3>Mugger <span class="muted small" style="text-transform:none;letter-spacing:0">${dbLine}${watching}</span></h3>
    <div class="card row between" style="flex-wrap:wrap">
      <span>${tripLine}${sc.error ? ` · <span class="neg">${esc(sc.error)}</span>` : ''}</span>
      <span>${meLine}${live && !ffsKey ? ' · <span class="muted">Add an FFScouter key in Settings for fight estimates</span>' : ''}</span>
    </div>
    <div class="toolbar">
      <label>Country <select id="mug-loc">${opt('auto', `Auto: your trip${trip ? ` (${trip.country})` : ''}`, f.choice)}${f.countries.map(c => opt(c, c, f.choice)).join('')}</select></label>
      <label title="Abroad items that cost at least this much in the abroad shops count">Items from <select id="mug-min">${[50000, 100000, 250000, 500000, 1000000].map(v => opt(v, money(v, true), f.settings.minCost)).join('')}</select></label>
      <label title="How many of the best traders Mentat checks with your API key during a trip">Check <select id="mug-pool">${[20, 40, 60, 100, 150].map(v => opt(v, `${v} traders`, f.settings.pool)).join('')}</select></label>
      <label title="How often players in your country are checked again (each check is one API call per player)">In your country every <select id="mug-here">${[1, 2, 3].map(v => opt(v, `${v} min`, f.settings.here)).join('')}</select></label>
      <label title="How often the item market sales of players in your country are checked (one API call per player)">Item market every <select id="mug-market">${[2, 5, 10].map(v => opt(v, `${v} min`, f.settings.market)).join('')}</select></label>
      <label title="Mugger's share of your Torn API calls per minute during a trip">Up to <select id="mug-rate">${[10, 20, 30, 45].map(v => opt(v, `${v} calls/min`, f.settings.rate)).join('')}</select></label>
      <label title="Masterful Looting merit: +5% a level to what you mug (Torn wiki)">Looting <select id="mug-loot">${opt('auto', 'from my merits', f.settings.looting)}${Array.from({ length: 11 }, (_, i) => opt(i, `${i}/10`, f.settings.looting)).join('')}</select></label>
      <label title="Your weapon's Plunder bonus: +20% to 49% to what you mug (Torn wiki)">Plunder <select id="mug-plunder">${opt(0, 'none', f.settings.plunder)}${Array.from({ length: 30 }, (_, i) => opt(20 + i, `${20 + i}%`, f.settings.plunder)).join('')}</select></label>
    </div>
    <div class="note" style="margin-top:0">${mugLine}. A 7★ Clothing Store cuts it by 75%; after a mug the rest of their wallet is protected, decaying over 12 hours (Torn wiki).</div>
    ${live ? mugPasteCard(f) : ''}
    ${chips ? `<div class="chips" title="Where the checked traders are (→ = flying there)">${chips}</div>` : ''}
    ${live ? `<div class="toolbar">
      <label><input type="checkbox" id="mug-flying"${flying ? ' checked' : ''}> Include players flying in</label>
      <label><input type="checkbox" id="mug-hosp"${hosp ? ' checked' : ''}> Include hospital</label>
      <label>Sort <select id="mug-sort">${opt('score', `Score for ${f.country}`, sort)}${opt('overall', 'Overall score', sort)}${opt('take', 'Mug take', sort)}${opt('ff', 'Fair fight, easiest first', sort)}${opt('bs', 'Estimated stats, lowest first', sort)}${opt('landing', 'Landing soonest', sort)}</select></label>
      <span class="spacer"></span><button data-cmd="mugger.recheck" data-arg="0" title="Check where everyone is again">Re-check all</button>
    </div>` : `<div class="toolbar"><label>Sort <select id="mug-sort">${opt('score', `Score for ${f.country}`, sort)}${opt('overall', 'Overall score', sort)}${opt('trip', 'Cash a trip', sort)}</select></label></div>`}
    <table class="data mug-table">${head}${body}</table>
    ${live ? mugProtectedBox(f) : ''}
    <div class="note">How it works: a market database of bazaar listings of abroad items (Weav3r, every 30 minutes, 90 days), with Torn's bazaar directories (the busiest bazaars for each item, every 12 hours), shows who trades abroad and how much. Only while you're flying out or abroad does Mugger use your API key: where the best ${num(f.settings.pool)} traders for your country are (those in your country checked again every ${num(f.settings.here)} min, those flying in every 3, the rest every 20); for those near you, once per trip, their job, travel record and FFScouter estimate; every ${num(f.settings.market)} minutes, their item market revenue. Their bazaars are re-read every 5 minutes. Once you've landed, paste Torn's People list in the box above and Mugger checks only those people (traders or not), dropping anyone who flies out. Cash on hand counts trip money while they're still flying out, and sales since they left Torn; what they had before isn't known. Click a row for the details.</div>`;

  const set = (id, key, conv) => { const s = $(id, el); if (s) s.addEventListener('change', e => cmd('settings.set', key, conv(e.target.value)).catch(() => {})); };
  set('#mug-loc', 'mugger.location', v => v);
  set('#mug-min', 'mugger.minCost', Number);
  set('#mug-pool', 'mugger.pool', Number);
  set('#mug-rate', 'mugger.rate', Number);
  set('#mug-here', 'mugger.here', Number);
  set('#mug-market', 'mugger.market', Number);
  set('#mug-loot', 'mugger.looting', v => (v === 'auto' ? 'auto' : Number(v)));
  set('#mug-plunder', 'mugger.plunder', Number);
  const pref = (id, key) => { const c = $(id, el); if (c) c.addEventListener('change', e => { prefs.set(key, c.type === 'checkbox' ? e.target.checked : e.target.value); renderMugger(); }); };
  pref('#mug-flying', 'mugger.flying');
  pref('#mug-hosp', 'mugger.hosp');
  pref('#mug-sort', 'mugger.sort');

  // The People list box. Buttons act on mousedown (keeping the box focused), so the page can't redraw
  // between pressing and releasing and swallow the click.
  const ta = $('#mug-paste', el);
  if (ta) {
    ta.addEventListener('paste', e => {
      const html = e.clipboardData && e.clipboardData.getData('text/html');
      const lines = html ? mugPeopleFromHtml(html) : '';
      if (!lines) return; // plain text: pasted as it is
      e.preventDefault();
      ta.value = (ta.value ? `${ta.value}\n` : '') + lines;
    });
    const btn = (id, fn) => { const b = $(id, el); if (b) b.addEventListener('mousedown', e => { e.preventDefault(); fn(); }); };
    btn('#mug-paste-add', async () => {
      const text = ta.value;
      if (!text.trim()) { MUG_PASTE_MSG = "Paste Torn's People list first."; ta.blur(); renderMugger(); return; }
      try {
        const r = await cmd('mugger.paste', text);
        MUG_PASTE_MSG = r && r.error ? r.error : `Added ${num(r.added)}${r.byName ? ` (${num(r.byName)} by name from the market database)` : ''}${r.lookups ? `; looking up ${num(r.lookups)} name${r.lookups === 1 ? '' : 's'} on Torn` : ''}. ${num(r.total)} on the list.`;
        if (r && !r.error) ta.value = '';
      } catch (e) { MUG_PASTE_MSG = "Couldn't add them."; }
      ta.blur();
      renderMugger();
    });
    btn('#mug-paste-clear', async () => {
      await cmd('mugger.pasteClear').catch(() => {});
      MUG_PASTE_MSG = 'List cleared: back to the best traders.';
      ta.value = '';
      ta.blur();
      renderMugger();
    });
  }
}

document.addEventListener('click', e => {
  const tr = e.target.closest('tr[data-mug-row]');
  if (!tr || e.target.closest('a, button, input, select')) return;
  const id = Number(tr.dataset.mugRow);
  if (MUG_OPEN.has(id)) MUG_OPEN.delete(id); else MUG_OPEN.add(id);
  renderMugger();
});
