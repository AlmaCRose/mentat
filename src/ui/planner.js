'use strict';
/* global S, $, $$, panel, esc, cmd, money, tct, fmtMin, prefs, itemName, travelModel, predictStock, landingDelay, planTrip, cadPrev, cadNext,
   PM_MIN, PM_HOUR, PM_DAY, ENERGY_KINDS, NERVE_KINDS, BLOOD_LIFE, pmDayStart, pmDayKey, pmHM, simulate, dayPoints, valueAt, toast, renderSafe,
   svgEl, makeTooltip, inboundCands, fill, itemType, SPECIAL_TYPES */
/* exported renderPlanner, initPlanner */
// Planner tab: a plan for the next N days (synced between devices). Trips are checked against
// the restock rhythm the Travel tab has learned (will your item be in stock when you land, or
// should you leave a little earlier or later?); energy, nerve and life are projected through the
// plan from your live bars (planner-math.js), with boosts, cooldowns and blood bag fills.
// All times are Torn City Time (TCT, UTC), like the game.

const PL_TYPES = {
  trip: { label: 'Trip', icon: '<path d="M21 15.5v-2l-8-5V3.5a1.5 1.5 0 0 0-3 0V8.5l-8 5v2l8-2.5v5.5l-2 1.5V21l3.5-1 3.5 1v-1.5l-2-1.5V13z"/>' },
  gym: { label: 'Gym (spend energy)', icon: '<path d="M2 10h2V8h2v8H4v-2H2zm4-3h3v10H6zm9 0h3v10h-3zM9 11h6v2H9zm9-3h2v2h2v4h-2v2h-2z"/>' },
  crimes: { label: 'Crimes (spend nerve)', icon: '<path d="M12 2 4 5v6c0 5 3.4 9.7 8 11 4.6-1.3 8-6 8-11V5zm-1 13-3.5-3.5 1.4-1.4L11 12.2l4.6-4.6L17 9z"/>' },
  energy: { label: 'Energy boost', icon: '<path d="M13 2 4 14h7l-1 8 9-12h-7z"/>' },
  nerve: { label: 'Nerve refill', icon: '<path d="M12 2a7 7 0 0 0-4 12.7V18h8v-3.3A7 7 0 0 0 12 2zM9 20h6v2H9z"/>' },
  blood: { label: 'Fill blood bags', icon: '<path d="M12 2s-6 7-6 12a6 6 0 0 0 12 0c0-5-6-12-6-12zm-2 12h4v2h-4z"/>' },
  life: { label: 'Life change (medical item)', icon: '<path d="M10 3h4v7h7v4h-7v7h-4v-7H3v-4h7z"/>' },
  note: { label: 'Note', icon: '<path d="M5 3h10l4 4v14H5zm9 1v4h4M8 12h8v2H8zm0 4h6v2H8z"/>' },
};
const PL_REMIND = [[-1, 'No reminder'], [0, 'Remind me at the time'], [5, '5 min before'], [10, '10 min before'], [15, '15 min before'], [30, '30 min before'], [60, '1 hour before']];
// Torn's own bar colours (the theme's --energy green, --nerve red, --life blue); nerve is also dashed, so it
// stays apart from energy for red-green colour blindness.
const PL_SERIES = [['energy', 'Energy'], ['nerve', 'Nerve'], ['life', 'Life']];
const plColor = k => getComputedStyle(document.documentElement).getPropertyValue(`--${k}`).trim() || { energy: '#6cb33e', nerve: '#d4483a', life: '#4c8fd4' }[k];
let PLS = { form: null, err: '' }; // form: { day, id (editing) or null, draft }

const plCountries = () => ((S.features.travel && S.features.travel.countriesMeta) || []);
const plCountryName = code => (plCountries().find(c => c.code === code) || { name: code }).name;
const plWhen = t => `${pmHM(t)}${pmDayKey(t) !== pmDayKey(Date.now()) ? ` <span class="muted small">${esc(new Date(t).toUTCString().slice(0, 3))} ${new Date(t).getUTCDate()}</span>` : ''}`;
// Item names from the catalogue, or from the abroad stock list when the catalogue isn't loaded.
function plItemName(id) {
  const n = itemName(id);
  if (!/^Item \d+$/.test(n)) return n;
  for (const c of (S.features.travel && S.features.travel.countries) || []) { const i = c.items.find(x => x.id === id); if (i) return i.name; }
  return n;
}
const plSigned = ms => `${ms >= 0 ? '+' : '−'}${fmtMin(Math.abs(ms) / PM_MIN)}`;

function plTitle(it) {
  if (it.type === 'trip') return `Trip to ${plCountryName(it.country)}${it.itemId ? ` for ${plItemName(it.itemId)}` : ''}`;
  if (it.type === 'gym') return it.amount ? `Gym: ${it.amount} energy` : 'Gym: spend all your energy';
  if (it.type === 'crimes') return it.amount ? `Crimes: ${it.amount} nerve` : 'Crimes: spend all your nerve';
  if (it.type === 'energy') { const k = ENERGY_KINDS[it.kind] || ENERGY_KINDS.custom; return k.fill ? k.label : `${k.label} (+${it.amount || k.amount} energy)`; }
  if (it.type === 'nerve') { const k = NERVE_KINDS[it.kind] || NERVE_KINDS.custom; return k.fill ? k.label : `${k.label} (+${it.amount || k.amount} nerve)`; }
  if (it.type === 'blood') return `Fill ${it.count} blood bag${it.count === 1 ? '' : 's'}`;
  if (it.type === 'life') return `${it.amount >= 0 ? '+' : ''}${it.amount} life${it.note ? '' : ' (medical item)'}`;
  return it.note || 'Note';
}

// ---- Trips: flight times and restock timing (shares the Travel tab's model) ----
function plFlightMin(code, method) {
  const T = S.features.travel, ts = S.settings && S.settings.travel;
  if (!T || !ts) return 0;
  const c = T.countriesMeta.find(x => x.code === code);
  if (!c) return 0;
  const key = `${code}|${method}`;
  if (ts.override && ts.override[key]) return ts.override[key];
  if (T.learned && T.learned[key]) return T.learned[key];
  const mi = Math.max(0, T.methods.indexOf(method));
  return c.times[mi] * (ts.book ? 0.75 : 1);
}

// Everything about one trip: when you land and get back, and whether the item you want will be
// there when you land (with times to leave instead when it won't).
function plTrip(it, M, now) {
  const T = S.features.travel, ts = (S.settings && S.settings.travel) || {};
  const method = it.method || (M ? M.method : 'Standard');
  const fMin = plFlightMin(it.country, method);
  const f = fMin * PM_MIN;
  const out = { method, fMin, landAt: it.at + f, backAt: it.at + 2 * f + (it.stay || 0) * PM_MIN, lines: [], moves: [], level: 'ok' };
  const add = (level, text) => { out.lines.push({ level, text }); if (level === 'bad' || (level === 'warn' && out.level !== 'bad')) out.level = level; };
  out.bring = plBring(it, M, method, out.landAt);
  if (out.bring) out.lines.push({ level: 'money', text: plBringText(out.bring, it) });
  const u = S.features.user && S.features.user.data;
  if (u && u.travel && it.at < u.travel.arriveAt) add('warn', `You're flying to ${esc(u.travel.destination)} now and land at ${pmHM(u.travel.arriveAt)}.`);
  else if (u && u.status && u.status.state === 'Abroad' && it.at < now + f) add('warn', `You're abroad now: fly back to Torn first (${fmtMin(fMin)} with ${esc(method)}).`);
  const c = T && T.countries.find(x => x.code === it.country);
  if (!it.itemId) return out;
  const item = c && c.items.find(i => i.id === it.itemId);
  const name = esc(plItemName(it.itemId));
  if (!c || !c.update) { add('info', 'No abroad stock data yet (Travel tab, YATA).'); return out; }
  if (!item) { add('bad', `${name} isn't sold in ${esc(c.name)} (by the last stock reading).`); return out; }
  const st = item.stats || {};
  const cad = st.cadence;
  const move = (leave, label) => { if (leave > now + 30000 && Math.abs(leave - it.at) >= 30000) out.moves.push({ at: leave, label }); };
  if (cad) {
    const P = cad.period;
    const prev = cadPrev(cad, out.landAt);
    const next = cadNext(cad, out.landAt);
    if (prev === null) {
      // A sell-out timer: the next restock is after you land.
      const delay = landingDelay(st);
      add(item.quantity > 0 ? 'ok' : 'bad', item.quantity > 0
        ? `${name} is in stock now (${item.quantity}); it should still be there unless it sells out first.`
        : `${name} is sold out and should restock ~${pmHM(next)} (±${Math.round(cad.uncertainty / PM_MIN)} min): you'd land before that.`);
      if (item.quantity <= 0) move(next + delay - f, `Leave ${pmHM(next + delay - f)} (${plSigned(next + delay - f - it.at)}) to land just after the ~${pmHM(next)} restock`);
      out.restock = { prev: null, next, conf: cad.confidence, period: P };
      if (out.landAt - now > 24 * PM_HOUR) add('info', 'More than a day ahead: restock times this far out are rough. Check again on the day.');
      return out;
    }
    const delay = landingDelay(st);
    const pred = predictStock(c, item, out.landAt);
    const lasts = st.stay || 0; // how long stock usually lasts after a restock (ms)
    const since = out.landAt - prev;
    const conf = `${cad.confidence} confidence`;
    const tooEarly = since < cad.uncertainty + 30000;
    const lateRisk = lasts && since > lasts * 0.7;
    if (pred.q > 0 && !lateRisk && !tooEarly) {
      add('ok', `About ${pred.q} ${name} when you land at ${pmHM(out.landAt)}: restock ~${pmHM(prev)} (${conf}).`);
    } else if (tooEarly) {
      add('warn', `You land right at the ~${pmHM(prev)} restock, give or take ${Math.round(cad.uncertainty / PM_MIN)} min: it may not have happened yet.`);
      move(prev + delay - f, `Leave ${pmHM(prev + delay - f)} (${plSigned(prev + delay - f - it.at)})`);
    } else {
      add(pred.q > 0 ? 'warn' : 'bad', pred.q > 0
        ? `${name} may run low: you land ${fmtMin(since / PM_MIN)} after the ~${pmHM(prev)} restock and it usually lasts about ${fmtMin(lasts / PM_MIN)}.`
        : `${name} is likely sold out when you land at ${pmHM(out.landAt)}${lasts ? ` (it usually lasts about ${fmtMin(lasts / PM_MIN)} after a restock)` : ''}.`);
      const later = next + delay - f, earlier = prev + delay - f;
      const opts = [[later, `Leave ${pmHM(later)} (${plSigned(later - it.at)}) to land just after the ~${pmHM(next)} restock`], [earlier, `Leave ${pmHM(earlier)} (${plSigned(earlier - it.at)}) to land just after the ~${pmHM(prev)} restock`]];
      opts.sort((a, b) => Math.abs(a[0] - it.at) - Math.abs(b[0] - it.at)).forEach(([t, l]) => move(t, l));
    }
    out.restock = { prev, next, conf: cad.confidence, period: P };
  } else {
    const I = Math.max(5, ts.restockInterval || 15) * PM_MIN, O = (ts.restockOffset || 0) * PM_MIN;
    const nextR = Math.ceil((out.landAt - O) / I) * I + O, prevR = nextR - I;
    add('info', `${name}'s restock rhythm isn't learned yet: assuming a restock every ${I / PM_MIN} min (Travel → Flights & settings). Now ${item.quantity} in stock.`);
    move(prevR + PM_MIN - f, `Leave ${pmHM(prevR + PM_MIN - f)} (${plSigned(prevR + PM_MIN - f - it.at)}) to land a minute after ~${pmHM(prevR)}`);
    move(nextR + PM_MIN - f, `Leave ${pmHM(nextR + PM_MIN - f)} (${plSigned(nextR + PM_MIN - f - it.at)}) to land a minute after ~${pmHM(nextR)}`);
  }
  if (out.landAt - now > 24 * PM_HOUR) add('info', 'More than a day ahead: restock times are projected from the learned rhythm and can drift. Check again on the day.');
  // Expected profit with your Travel settings (only for the flight method Travel uses).
  if (M && method === M.method) {
    try {
      const t = planTrip(M, c, it.at, { focus: it.itemId });
      if (t && t.focusLine) out.profit = { qty: t.focusLine.qty, total: t.profit };
    } catch (e) { /* the catalogue isn't loaded yet */ }
  }
  return out;
}

// ---- How much money to bring on a trip ----
// A full load of the item you picked at the shop price abroad (YATA's readings), with your
// flower/plushie slots filled with the best of those likely in stock when you land; with no item
// picked, the best load by the stock forecast. Plus the Standard ticket, which is paid in cash when
// you fly (Airstrip and WLT cost no cash, Business uses a Business Class Ticket item).
function plBring(it, M, method, landAt) {
  const T = S.features.travel;
  const c = T && T.countries.find(x => x.code === it.country);
  if (!M || !c || !c.items.length) return null;
  const meta = (T.countriesMeta || []).find(x => x.code === it.country);
  const ticket = method === 'Standard' && meta ? meta.ticket || 0 : 0;
  // Capacity from your API key or your setting; the per-method default otherwise.
  const general = M.capSource === 'default for this method' ? (method === 'Standard' ? 10 : 15) : M.general;
  const cands = inboundCands(M, c, landAt);
  let lines = [];
  let basis = 'forecast';
  if (it.itemId) {
    const f = cands.find(x => x.id === it.itemId);
    if (!f) return { cash: 0, ticket, total: ticket, lines: [], basis: 'missing' };
    const special = SPECIAL_TYPES.has(itemType(it.itemId));
    lines.push({ id: f.id, name: f.name, qty: general + (special ? M.special : 0), cost: f.cost });
    if (!special && M.special) {
      const sp = fill(cands.filter(x => x.id !== it.itemId && SPECIAL_TYPES.has(itemType(x.id))), 0, M.special);
      lines.push(...sp.lines.map(l => ({ id: l.id, name: l.name, qty: l.qty, cost: l.cost, extra: true })));
    }
    basis = 'item';
  } else {
    lines = fill(cands, general, M.special).lines.map(l => ({ id: l.id, name: l.name, qty: l.qty, cost: l.cost }));
  }
  const cash = lines.reduce((s, l) => s + l.qty * l.cost, 0);
  return { cash, ticket, total: cash + ticket, lines, basis, capacity: general + M.special };
}
function plBringText(b, it) {
  const parts = b.lines.map(l => `${l.qty} ${esc(l.name)} at ${money(l.cost)} (${money(l.qty * l.cost)})${l.extra ? ' for your flower/plushie slots' : ''}`);
  if (b.ticket) parts.push(`${money(b.ticket)} Standard ticket`);
  // (An item missing from the stock reading has its own warning below; only the ticket counts here.)
  const why = b.basis === 'forecast' && !b.lines.length ? ' (nothing worth buying is forecast in stock)' : '';
  return `Bring <b>${money(b.total)}</b>${parts.length ? `: ${parts.join(' + ')}` : ''}${why}.${b.basis === 'forecast' && b.lines.length ? ' <span class="muted">No item picked: the best load by the stock forecast.</span>' : ''}`;
}
// The short form kept with the plan item for its reminder (worked out here, sent with the item).
function plBringSummary(d) {
  const M = S.features.travel && S.settings ? travelModel() : null;
  if (!M || d.type !== 'trip') return undefined;
  const method = d.method || M.method;
  const b = plBring(d, M, method, d.at + plFlightMin(d.country, method) * PM_MIN);
  if (!b || !b.total) return undefined;
  const text = [...b.lines.map(l => `${l.qty} ${l.name}`), ...(b.ticket ? ['ticket'] : [])].join(' + ');
  return { total: Math.round(b.total), text: text.slice(0, 120) };
}

// ---- The whole plan, projected ----
function plModel() {
  const P = S.features.planner;
  if (!P) return null;
  const now = Date.now();
  const start = pmDayStart(now);
  const days = Math.max(1, P.days || 3);
  const end = start + days * PM_DAY;
  const M = S.features.travel && S.settings ? travelModel() : null;
  const items = Object.values(P.items || {}).sort((a, b) => a.at - b.at);
  const trips = {};
  const busy = [];
  const u = S.features.user && S.features.user.data;
  if (u && u.travel && u.travel.arriveAt > now) {
    const dest = u.travel.destination;
    const country = plCountries().find(c => c.name === dest);
    const back = country ? plFlightMin(country.code, u.travel.method || (M ? M.method : 'Standard')) * PM_MIN : 0;
    busy.push({ id: 'now', from: now, to: u.travel.arriveAt, kind: 'flying', name: dest === 'Torn' ? 'flying home' : `flying to ${dest}`, trip: 'your current trip', where: dest });
    if (dest !== 'Torn') busy.push({ id: 'now', from: u.travel.arriveAt, to: u.travel.arriveAt + back, kind: 'away', name: `in ${dest} or flying home`, trip: 'your current trip', where: dest });
  }
  for (const it of items) {
    if (it.type !== 'trip') continue;
    trips[it.id] = plTrip(it, M, now);
    const tr = trips[it.id], where = plCountryName(it.country), trip = `the trip to ${where}`;
    const leaveAbroad = tr.landAt + (it.stay || 0) * PM_MIN;
    busy.push({ id: it.id, from: it.at, to: tr.landAt, kind: 'flying', name: `flying to ${where}`, trip, where });
    if (it.stay) busy.push({ id: it.id, from: tr.landAt, to: leaveAbroad, kind: 'abroad', name: `in ${where}`, trip, where });
    busy.push({ id: it.id, from: leaveAbroad, to: tr.backAt, kind: 'flying', name: `flying home from ${where}`, trip, where });
  }
  const sim = simulate({
    now, until: end, busy,
    bars: u && u.bars, cooldowns: u && u.cooldowns, refillsUsedToday: u && u.refills,
    items: items.map(it => (it.type === 'trip' ? { ...it, backAt: trips[it.id].backAt } : it)),
  });
  return { P, now, start, days, end, items, trips, sim, M, u, busy };
}

function plProjection(it, r) { return plProjectionBits(it, r).map(esc).join(' · '); }
function plProjectionBits(it, r) {
  if (!r) return [];
  const bits = [];
  const bar = (k, word) => { const b = r.before[k], a = r.after[k]; return b && a && b.cur !== a.cur ? `${word} ${b.cur} → ${a.cur}` : b ? `${word} ${b.cur}/${b.max}` : ''; };
  if (it.type === 'gym' || it.type === 'energy') bits.push(bar('energy', 'Energy'));
  if (it.type === 'crimes' || it.type === 'nerve') bits.push(bar('nerve', 'Nerve'));
  if (it.type === 'blood' || it.type === 'life') bits.push(bar('life', 'Life'));
  if (it.type === 'blood' && r.fills && r.fills.length) bits.push(`fills at ${r.fills.map(pmHM).join(', ')}`);
  bits.push(...r.info.filter(x => !/^\+\d+ (energy|nerve)$/.test(x) && !/fill/.test(x)));
  return bits.filter(Boolean);
}

function plItemRow(it, mdl) {
  const r = mdl.sim.results[it.id];
  const trip = mdl.trips[it.id];
  const past = it.at < mdl.now;
  const warn = [...(r ? r.warn : [])].map(w => ({ level: 'warn', text: esc(w) }));
  const lines = trip ? trip.lines : [];
  const t = PL_TYPES[it.type] || PL_TYPES.note;
  const tripLine = trip ? `<div class="pl-meta">${esc(trip.method === 'Private' ? 'WLT' : trip.method)} · ${fmtMin(trip.fMin)} each way · lands ${plWhen(trip.landAt)} · back in Torn ${plWhen(trip.backAt)}${it.stay ? ` (${fmtMin(it.stay)} abroad)` : ''}${trip.profit ? ` · ≈ ${money(trip.profit.total)} profit with ${trip.profit.qty} ${esc(plItemName(it.itemId))}` : ''}</div>` : '';
  const proj = plProjection(it, r);
  const msg = l => `<div class="pl-msg ${l.level}"><span class="pl-msg-ic" aria-hidden="true">${l.level === 'ok' ? '✓' : l.level === 'info' ? 'i' : l.level === 'money' ? '$' : '!'}</span><span>${l.text}</span></div>`;
  const moves = trip && trip.moves.length && !past ? `<div class="pl-moves">${trip.moves.map(m => `<button data-plmove="${it.id}" data-at="${m.at}">${esc(m.label)}</button>`).join('')}</div>` : '';
  return `<li class="pl-item ${past ? 'past' : ''} ${it.done ? 'done' : ''}" data-plitem="${it.id}">
    <span class="pl-time" title="${esc(new Date(it.at).toLocaleString())} your time">${pmHM(it.at)}</span>
    <svg class="pl-icon" viewBox="0 0 24 24" aria-hidden="true">${t.icon}</svg>
    <div class="pl-main">
      <div class="pl-title">${esc(plTitle(it))}${past ? ' <span class="pill">past</span>' : ''}${it.remind >= 0 ? ` <span class="muted small" title="Reminder">⏰ ${it.remind ? `${it.remind} min before` : 'at the time'}${plUrgent(it) ? ' · <b class="pl-urgent" title="Urgent popup in the middle of the screen">urgent</b>' : ''}</span>` : ''}</div>
      ${tripLine}
      ${proj && !past ? `<div class="pl-meta">${proj}</div>` : ''}
      ${it.note && it.type !== 'note' ? `<div class="pl-meta pl-note">${esc(it.note)}</div>` : ''}
      ${past ? '' : [...lines, ...warn].map(msg).join('')}
      ${moves}
    </div>
    <span class="pl-acts">
      <label class="pl-done" title="Done"><input type="checkbox" data-pldone="${it.id}" ${it.done ? 'checked' : ''}><span class="sr-only">Done</span></label>
      <button data-pledit="${it.id}" title="Change">Edit</button>
      <button class="danger" data-plrm="${it.id}" title="Remove" aria-label="Remove">&times;</button>
    </span>
  </li>`;
}

// ---- One day as a 24-hour timeline ----
// Left to right, 00:00 to 24:00 TCT: trips as blocks (flying hatched, time abroad solid), plan items as
// markers, cooldowns as thin bars, and energy, nerve and life (as % of max) underneath. Time away from
// Torn is shaded through every row, so it lines up with the bars. Hover for details; click a block to
// change it, or an empty spot (mouse) to add something at that time.
const PL_TYPE_COLOR = { trip: 'muted', gym: 'energy', energy: 'energy', crimes: 'nerve', nerve: 'nerve', blood: 'life', life: 'life', note: 'muted' };
const PL_CDS = [['drug', 'Drug'], ['booster', 'Booster'], ['medical', 'Medical']];
const plPlain = html => new DOMParser().parseFromString(String(html), 'text/html').body.textContent || '';
const plCut = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const plCap = s => s.charAt(0).toUpperCase() + s.slice(1);
// A time on your own clock, in your 12/24-hour choice; withDay adds the weekday when it's another day there.
function plLocal(t, withDay = false) {
  const h24 = !(S.settings && S.settings.ui && S.settings.ui.clock24 === false);
  const d = new Date(t);
  const s = d.toLocaleTimeString([], { hour: h24 ? '2-digit' : 'numeric', minute: '2-digit', hour12: !h24 });
  const other = d.getDate() !== d.getUTCDate();
  return withDay && other ? `${d.toLocaleDateString([], { weekday: 'short' })} ${s}` : s;
}
function plShort(it) {
  if (it.type === 'gym') return it.amount ? `Gym ${it.amount}e` : 'Gym (all)';
  if (it.type === 'crimes') return it.amount ? `Crimes ${it.amount}n` : 'Crimes (all)';
  if (it.type === 'energy') return (ENERGY_KINDS[it.kind] || ENERGY_KINDS.custom).label;
  if (it.type === 'nerve') return (NERVE_KINDS[it.kind] || NERVE_KINDS.custom).label;
  if (it.type === 'blood') return `${it.count} blood bag${it.count === 1 ? '' : 's'}`;
  if (it.type === 'life') return `${it.amount >= 0 ? '+' : ''}${it.amount} life`;
  return it.note || 'Note';
}

function plTimeline(host, mdl, d0) {
  const { now, sim } = mdl;
  const d1 = d0 + PM_DAY;
  const day = pmDayKey(d0);
  host.textContent = '';
  const W = Math.max(260, host.clientWidth || 320);
  const narrow = W < 560;
  const M = { l: 54, r: 8 };
  const PW = W - M.l - M.r;
  const X = t => M.l + ((Math.min(Math.max(t, d0), d1) - d0) / PM_DAY) * PW;
  const T = x => d0 + ((x - M.l) / PW) * PM_DAY;
  const busy = mdl.busy.filter(b => b.to > d0 && b.from < d1);
  const items = mdl.items.filter(it => it.type !== 'trip' && it.at >= d0 && it.at < d1);
  const nTrips = mdl.items.filter(it => it.type === 'trip' && it.at >= d0 && it.at < d1).length;
  const cds = PL_CDS.map(([k, w]) => ({ k, w, spans: ((sim.cdSpans || {})[k] || []).filter(([a, b]) => b > d0 && a < d1) })).filter(c => c.spans.length);
  const bars = PL_SERIES.filter(([k]) => sim.bars[k] && sim.bars[k].max);
  const from = Math.max(d0, now);

  // Plan items into rows, so markers and their labels don't overlap (at most 3 rows).
  const lanes = [], placed = [];
  const fits = ext => lanes.findIndex(l => l.every(([a, b]) => ext[1] + 3 < a || ext[0] - 3 > b));
  for (const it of items) {
    const x = X(it.at);
    const label = plCut(plShort(it), 20);
    const lw = narrow ? 0 : label.length * 6.2 + 6;
    const full = [x - 11, x + 11 + lw], bare = [x - 11, x + 11];
    let lane = lw ? fits(full) : -1, lab = lane >= 0;
    if (lane < 0 && lw && lanes.length < 3) { lanes.push([]); lane = lanes.length - 1; lab = true; }
    if (lane < 0) { lane = fits(bare); lab = false; }
    if (lane < 0 && lanes.length < 3) { lanes.push([]); lane = lanes.length - 1; }
    if (lane < 0) lane = lanes.length - 1; // very crowded: markers overlap; the list below has them all
    lanes[lane].push(lab ? full : bare);
    placed.push({ it, x, lane, label: lab ? label : '' });
  }

  // Rows, top to bottom.
  const LH = 26;
  const nLanes = Math.max(1, lanes.length);
  let y = 4;
  const tripY = y; y += LH + 4;
  const laneY = y; y += nLanes * LH + 2;
  const cdY = y; y += cds.length ? cds.length * 12 + 8 : 0;
  // 0–100% keeps the same height every day; a bar pushed over its maximum (Xanax, cans) adds room above.
  let top = 100;
  if (from < d1) for (const [k] of bars) for (const [, v] of dayPoints(sim.bars[k], from, d1)) top = Math.max(top, v);
  top = Math.ceil(top / 50) * 50;
  const P100 = narrow ? 64 : 76;
  const CH = bars.length ? Math.round(Math.min(P100 * (top / 100), P100 * 2.2)) + 10 : 0;
  const chartY = y; y += CH;
  const axisY = y;
  // Your own time as a second row under the TCT hours (not when your clock is on TCT already).
  const showLocal = new Date(d0).getTimezoneOffset() !== 0 || new Date(d1).getTimezoneOffset() !== 0;
  const H = axisY + (showLocal ? 32 : 18);
  const Y = v => chartY + 5 + (1 - v / top) * (CH - 10);

  // Legend (HTML), only for what this day shows.
  const legend = document.createElement('div');
  legend.className = 'chart-legend pl-tl-legend';
  const key = (cls, style, text) => `<span><span class="chart-key ${cls}" ${style ? `style="${style}"` : ''}></span>${text}</span>`;
  legend.innerHTML = [
    ...bars.map(([k, w]) => key('', `background:${k === 'nerve' ? `repeating-linear-gradient(90deg, ${plColor(k)} 0 4px, transparent 4px 7px)` : plColor(k)}`, w)),
    busy.some(b => b.kind === 'flying') ? key('pl-sw pl-sw-fly', '', 'Flying') : '',
    busy.some(b => b.kind !== 'flying') ? key('pl-sw pl-sw-away', '', 'Abroad') : '',
    cds.length ? key('pl-sw pl-sw-cd', '', 'Cooldown') : '',
  ].filter(Boolean).join('');
  if (legend.innerHTML) host.appendChild(legend);

  const svg = svgEl('svg', {
    width: W, height: H, viewBox: `0 0 ${W} ${H}`, class: 'chart-svg pl-tl-svg', role: 'img',
    'aria-label': `${day}: ${items.length + nTrips} planned, as a 24-hour timeline. The list below has the same plan.`,
  });
  const hatchId = `plhatch-${day}`;
  const defs = svgEl('defs');
  const pat = svgEl('pattern', { id: hatchId, width: 6, height: 6, patternUnits: 'userSpaceOnUse', patternTransform: 'rotate(45)' });
  pat.appendChild(svgEl('line', { x1: 0, y1: 0, x2: 0, y2: 6, class: 'pl-tl-hatch' }));
  defs.appendChild(pat);
  svg.appendChild(defs);
  const add = (tag, attrs, text) => { const e = svgEl(tag, attrs); if (text !== undefined) e.textContent = text; svg.appendChild(e); return e; };

  // Row names in the margin.
  add('text', { x: M.l - 6, y: tripY + LH / 2 + 4, class: 'pl-tl-name', 'text-anchor': 'end' }, 'Trips');
  add('text', { x: M.l - 6, y: laneY + LH / 2 + 4, class: 'pl-tl-name', 'text-anchor': 'end' }, 'Plan');
  cds.forEach((c, i) => add('text', { x: M.l - 6, y: cdY + i * 12 + 9, class: 'pl-tl-name', 'text-anchor': 'end' }, c.w));

  // Hours: a line each hour, labelled every 3 h (6 h when narrow).
  const every = narrow ? 6 : 3;
  for (let h = 0; h <= 24; h++) {
    const x = M.l + (h / 24) * PW;
    add('line', { x1: x, x2: x, y1: tripY, y2: axisY, class: h % every ? 'pl-tl-hour' : 'chart-grid' });
    if (h % every) continue;
    const anchor = h === 0 ? 'start' : h === 24 ? 'end' : 'middle';
    add('text', { x, y: axisY + 13, class: 'chart-axis', 'text-anchor': anchor }, `${String(h).padStart(2, '0')}:00`);
    if (showLocal) add('text', { x, y: axisY + 27, class: 'chart-axis pl-tl-local', 'text-anchor': anchor }, plLocal(d0 + h * PM_HOUR));
  }
  add('text', { x: M.l - 6, y: axisY + 13, class: 'pl-tl-name', 'text-anchor': 'end' }, 'TCT');
  if (showLocal) add('text', { x: M.l - 6, y: axisY + 27, class: 'pl-tl-name', 'text-anchor': 'end' }, 'Your time');
  // The part of today that's already gone.
  if (now > d0) add('rect', { x: M.l, y: tripY, width: X(now) - M.l, height: axisY - tripY, class: 'pl-tl-past' });
  // Time away from Torn, through every row.
  for (const b of busy) {
    const x0 = X(b.from), x1 = X(b.to);
    if (x1 - x0 < 0.5) continue;
    add('rect', { x: x0, y: tripY, width: x1 - x0, height: axisY - tripY, class: `pl-tl-band ${b.kind === 'flying' ? 'fly' : 'away'}`, ...(b.kind === 'flying' ? { fill: `url(#${hatchId})` } : {}) });
  }

  // Energy, nerve and life, as % of each maximum.
  if (CH) {
    for (const v of [0, 50, 100, ...(top > 100 ? [top] : [])]) {
      add('line', { x1: M.l, x2: W - M.r, y1: Y(v), y2: Y(v), class: v === 100 ? 'pl-tl-max' : 'chart-grid' });
      add('text', { x: M.l - 6, y: Y(v) + 4, class: 'chart-axis', 'text-anchor': 'end' }, `${v}%`);
    }
    if (from < d1) {
      // Life first and dashed nerve last, so a full nerve still shows where it sits on a full life line.
      for (const k of ['life', 'energy', 'nerve'].filter(x => bars.some(([b]) => b === x))) {
        const pts = dayPoints(sim.bars[k], from, d1);
        let d = '';
        pts.forEach(([t, v], i) => { d += i ? `H${X(t)}V${Y(v)}` : `M${X(t)},${Y(v)}`; });
        add('path', { d, fill: 'none', stroke: plColor(k), 'stroke-width': 2, 'stroke-linejoin': 'round', ...(k === 'nerve' ? { 'stroke-dasharray': '6 4' } : {}) });
      }
    }
  }

  // Cooldowns.
  cds.forEach((c, i) => {
    for (const [a, b] of c.spans) {
      const x0 = X(a), x1 = X(b);
      if (x1 - x0 >= 1) add('rect', { x: x0, y: cdY + i * 12 + 3, width: x1 - x0, height: 6, rx: 3, class: `pl-tl-cd cd-${c.k}` });
    }
  });

  // Trips: one block per trip, flying hatched and time abroad solid.
  const tripBoxes = [];
  const byTrip = {};
  for (const b of busy) (byTrip[b.id] = byTrip[b.id] || []).push(b);
  for (const [id, segs] of Object.entries(byTrip)) {
    const a = Math.min(...segs.map(s => s.from)), z = Math.max(...segs.map(s => s.to));
    const x0 = X(a), x1 = X(z);
    if (x1 - x0 < 1) continue;
    for (const s of segs) {
      const s0 = X(s.from), s1 = X(s.to);
      if (s1 - s0 < 0.5) continue;
      add('rect', { x: s0, y: tripY + 2, width: s1 - s0, height: LH - 4, class: `pl-tl-seg ${s.kind === 'flying' ? 'fly' : 'away'}` });
      if (s.kind === 'flying') add('rect', { x: s0, y: tripY + 2, width: s1 - s0, height: LH - 4, fill: `url(#${hatchId})`, class: 'pl-tl-seghatch' });
    }
    add('rect', { x: x0, y: tripY + 2, width: x1 - x0, height: LH - 4, rx: 5, class: `pl-tl-trip${z < now ? ' past' : ''}` });
    const it = mdl.P.items[id] || null;
    const where = segs[0].where || '';
    const text = x1 - x0 > where.length * 6.6 + 30 ? `✈ ${where}` : x1 - x0 > 22 ? '✈' : '';
    if (text) add('text', { x: (x0 + x1) / 2, y: tripY + LH / 2 + 4, class: 'pl-tl-triplabel', 'text-anchor': 'middle' }, text);
    tripBoxes.push({ id, it, a, z, x0, x1, segs });
  }

  // Plan items: a marker (icon) at its time, a guide line down through the bars, and a short label.
  for (const p of placed) {
    const { it, x, lane } = p;
    const t = PL_TYPES[it.type] || PL_TYPES.note;
    const c = PL_TYPE_COLOR[it.type] || 'muted';
    const my = laneY + lane * LH + 2;
    const g = add('g', { class: `pl-tl-item${it.at < now ? ' past' : ''}${it.done ? ' done' : ''}` });
    g.appendChild(svgEl('line', { x1: x, x2: x, y1: my + LH - 4, y2: axisY, class: `pl-tl-guide c-${c}` }));
    g.appendChild(svgEl('rect', { x: x - 11, y: my, width: 22, height: LH - 4, rx: 5, class: `pl-tl-mk c-${c}` }));
    const ic = svgEl('g', { transform: `translate(${x - 7},${my + 4}) scale(${14 / 24})`, class: 'pl-tl-ic' });
    ic.innerHTML = t.icon;
    g.appendChild(ic);
    if (p.label) { const tx = svgEl('text', { x: x + 15, y: my + LH / 2 + 2, class: 'pl-tl-label' }); tx.textContent = p.label; g.appendChild(tx); }
    // Blood bag fills: a dot on the life line at each fill.
    const r = sim.results[it.id];
    if (it.type === 'blood' && r && r.fills && CH && sim.bars.life && sim.bars.life.max) {
      for (const f of r.fills) {
        if (f < d0 || f >= d1) continue;
        g.appendChild(svgEl('circle', { cx: X(f), cy: Y((valueAt(sim.bars.life, f) / sim.bars.life.max) * 100), r: 3.5, class: 'pl-tl-fill' }));
      }
    }
  }

  // Now.
  if (now >= d0 && now < d1) add('line', { x1: X(now), x2: X(now), y1: tripY, y2: axisY, class: 'pl-tl-now' });

  const cross = add('line', { y1: tripY, y2: axisY, class: 'chart-cross', visibility: 'hidden' });
  const hit = add('rect', { x: M.l, y: 0, width: PW, height: axisY, fill: 'transparent', class: 'pl-tl-hit' });
  host.appendChild(svg);
  const tip = makeTooltip(host);

  let ptr = 'mouse';
  const find = (px, py) => {
    if (py >= laneY && py < laneY + nLanes * LH) {
      const lane = Math.floor((py - laneY) / LH);
      const p = placed.filter(q => q.lane === lane && Math.abs(q.x - px) <= 12).sort((a, b) => Math.abs(a.x - px) - Math.abs(b.x - px))[0];
      if (p) return { item: p.it };
    }
    if (py >= tripY && py < tripY + LH) {
      const tb = tripBoxes.find(b => px >= b.x0 - 2 && px <= b.x1 + 2);
      if (tb) return { trip: tb };
    }
    return null;
  };
  const statusRows = t => {
    if (t < now) return [{ value: 'Already past' }];
    const rows = [];
    for (const [k, w] of bars) { const s = sim.bars[k]; rows.push({ color: plColor(k), value: `${Math.round(valueAt(s, t))}/${s.max}`, label: w }); }
    const b = mdl.busy.find(x => t >= x.from && t < x.to);
    if (b) rows.push({ value: plCap(b.name), label: `until ${pmHM(b.to)}` });
    for (const [k, w] of PL_CDS) {
      const sp = ((sim.cdSpans || {})[k] || []).find(([a, z]) => t >= a && t < z);
      if (sp) rows.push({ value: `${w} cooldown`, label: `until ${pmHM(sp[1])}${pmDayKey(sp[1]) !== day ? ` (${pmDayKey(sp[1]).slice(5)})` : ''}` });
    }
    return rows;
  };
  const show = e => {
    const r = svg.getBoundingClientRect();
    const px = e.clientX - r.left, py = e.clientY - r.top;
    const f = find(px, py);
    let t = T(px), title, rows;
    if (f && f.item) {
      const it = f.item, res = sim.results[it.id];
      t = it.at;
      title = `${pmHM(it.at)} · ${plTitle(it)}`;
      rows = plProjectionBits(it, res).map(v => ({ value: plCut(v, 80) }));
      if (res && res.warn.length) rows.push({ value: `! ${plCut(res.warn[0], 90)}`, label: res.warn.length > 1 ? `(+${res.warn.length - 1} more below)` : '' });
      if (it.note && it.type !== 'note') rows.push({ value: plCut(it.note, 80) });
      rows.push({ value: 'Click to change' });
    } else if (f && f.trip) {
      const tb = f.trip, tr = mdl.trips[tb.id];
      if (tr && tb.it) {
        t = Math.max(d0, tb.it.at);
        title = plTitle(tb.it);
        rows = [{ value: `Leave ${pmHM(tb.it.at)}`, label: `· lands ${pmHM(tr.landAt)} · back in Torn ${pmHM(tr.backAt)}` }, ...tr.lines.slice(0, 2).map(l => ({ value: plCut(plPlain(l.text), 100) })), { value: 'Click to change' }];
      } else {
        title = plCap(tb.segs[0].trip || 'trip');
        rows = tb.segs.map(s => ({ value: plCap(s.name), label: `${pmHM(s.from)}–${pmHM(s.to)}` }));
      }
    } else {
      t = Math.round(t / (5 * PM_MIN)) * 5 * PM_MIN;
      title = `${pmHM(t)} TCT · ${plLocal(t, true)} your time`;
      rows = statusRows(t);
      if (ptr !== 'touch' && t > now) rows.push({ value: 'Click to plan something here' });
    }
    hit.style.cursor = f && !(f.trip && !f.trip.it) ? 'pointer' : t > now && ptr !== 'touch' ? 'cell' : 'default';
    cross.setAttribute('x1', X(t));
    cross.setAttribute('x2', X(t));
    cross.setAttribute('visibility', 'visible');
    tip.show(X(t), py, rows, title);
  };
  hit.addEventListener('pointerdown', e => { ptr = e.pointerType || 'mouse'; show(e); });
  hit.addEventListener('pointermove', e => { ptr = e.pointerType || ptr; show(e); });
  hit.addEventListener('pointerleave', () => { cross.setAttribute('visibility', 'hidden'); tip.hide(); });
  hit.addEventListener('click', e => {
    const r = svg.getBoundingClientRect();
    const f = find(e.clientX - r.left, e.clientY - r.top);
    if (f && f.item) { tip.hide(); plOpenForm(null, f.item.id); return; }
    if (f && f.trip && f.trip.it) { tip.hide(); plOpenForm(null, f.trip.id); return; }
    if (f || ptr === 'touch') return;
    const t = Math.round(T(e.clientX - r.left) / (5 * PM_MIN)) * 5 * PM_MIN;
    if (t > now + PM_MIN) { tip.hide(); plOpenForm(day, null, t); }
  });
}

// Urgent reminders (a large popup in the middle of the screen): the item's own choice, else
// Settings → Notifications → Urgent popups (planned trips / other planned items).
function plUrgentDefault(type) {
  const u = (S.settings && S.settings.ui && S.settings.ui.urgent) || {};
  return !!(type === 'trip' ? u.trip : u.plan);
}
function plUrgent(it) {
  return it.urgent === 'on' || (it.urgent !== 'off' && plUrgentDefault(it.type));
}

// ---- Add / edit form ----
function plDefaultTime(day) {
  const now = Date.now();
  const d0 = Date.parse(`${day}T00:00:00Z`);
  if (pmDayKey(now) === day) return Math.ceil((now + 5 * PM_MIN) / (15 * PM_MIN)) * 15 * PM_MIN;
  return d0 + 12 * PM_HOUR;
}

function plDraftDefaults(type, prev = {}) {
  const ts = (S.settings && S.settings.travel) || {};
  const M = S.features.travel && S.settings ? travelModel() : null;
  const base = { type, at: prev.at, note: prev.note || '', remind: prev.remind !== undefined ? prev.remind : type === 'trip' ? 5 : -1, urgent: prev.urgent || '' };
  if (type === 'trip') return { ...base, country: prev.country || 'mex', method: prev.method || (M ? M.method : ts.method === 'auto' ? 'Standard' : ts.method) || 'Standard', itemId: prev.itemId || 0, stay: prev.stay || 0 };
  if (type === 'gym' || type === 'crimes') return { ...base, amount: prev.amount || 0 };
  if (type === 'energy') return { ...base, kind: prev.kind || 'xanax', amount: prev.amount || 0 };
  if (type === 'nerve') return { ...base, kind: prev.kind || 'refill', amount: prev.amount || 0 };
  if (type === 'blood') return { ...base, count: prev.count || 3 };
  if (type === 'life') return { ...base, amount: prev.amount || 0, cdHours: prev.cdHours || 0 };
  return base;
}

function plForm(mdl) {
  const F = PLS.form;
  const d = F.draft;
  const T = S.features.travel;
  const dayOpts = Array.from({ length: mdl.days }, (_, i) => pmDayKey(mdl.start + i * PM_DAY));
  if (!dayOpts.includes(F.day)) dayOpts.push(F.day);
  const sel = (name, opts, v) => `<select name="${name}">${opts.map(([k, l]) => `<option value="${esc(k)}" ${String(k) === String(v) ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>`;
  const field = (label, html, wide = false) => `<label class="pl-field${wide ? ' wide' : ''}"><span>${label}</span>${html}</label>`;
  let fields = '';
  if (d.type === 'trip') {
    const c = T && T.countries.find(x => x.code === d.country);
    const items = c ? [...c.items].sort((a, b) => a.name.localeCompare(b.name)) : [];
    fields += field('Country', sel('country', plCountries().map(x => [x.code, x.name]), d.country));
    fields += field('Flight', sel('method', ((T && T.methods) || ['Standard', 'Airstrip', 'Private', 'Business']).map(m => [m, m === 'Private' ? 'WLT (private)' : m]), d.method));
    fields += field('Item you want (optional)', sel('itemId', [[0, 'Nothing in particular'], ...items.map(i => [i.id, `${i.name} (${i.quantity} in stock now)`])], d.itemId), true);
    fields += field('Time abroad (min)', `<input name="stay" type="number" min="0" max="1440" value="${esc(d.stay || 0)}" style="width:80px">`);
  } else if (d.type === 'gym' || d.type === 'crimes') {
    fields += field(`${d.type === 'gym' ? 'Energy' : 'Nerve'} to spend (0 = all you have)`, `<input name="amount" type="number" min="0" max="100000" value="${esc(d.amount || 0)}" style="width:100px">`);
  } else if (d.type === 'energy' || d.type === 'nerve') {
    const kinds = d.type === 'energy' ? ENERGY_KINDS : NERVE_KINDS;
    const k = kinds[d.kind] || kinds.custom;
    fields += field('What', sel('kind', Object.entries(kinds).map(([key, x]) => [key, x.label]), d.kind));
    if (!k.fill) fields += field(`+ ${d.type}`, `<input name="amount" type="number" min="1" max="100000" value="${esc(d.amount || k.amount)}" style="width:90px">`);
    if (d.type === 'energy' && (d.kind === 'can' || d.kind === 'custom' || d.kind === 'xanax')) {
      fields += field('Cooldown', sel('cd', [['', 'None'], ['drug', 'Drug'], ['booster', 'Booster']], d.cd !== undefined ? d.cd : k.cd || ''));
      fields += field('Hours', `<input name="cdHours" type="number" min="0" max="48" step="0.25" value="${esc(d.cdHours !== undefined ? d.cdHours : k.cdHours || 0)}" style="width:70px">`);
    }
  } else if (d.type === 'blood') {
    fields += field('Blood bags to fill', `<input name="count" type="number" min="1" max="50" value="${esc(d.count || 1)}" style="width:70px">`);
  } else if (d.type === 'life') {
    fields += field('Life (+ heals, − costs)', `<input name="amount" type="number" min="-100000" max="100000" value="${esc(d.amount || 0)}" style="width:100px">`);
    fields += field('Medical cooldown (h)', `<input name="cdHours" type="number" min="0" max="24" step="0.25" value="${esc(d.cdHours || 0)}" style="width:70px">`);
  }
  const hint = {
    energy: 'Xanax: +250 energy and about 6–8 h of drug cooldown. Refills fill the bar once per TCT day. FHC fills it and adds 6 h of booster cooldown. Energy drinks: set the can\'s energy and cooldown.',
    blood: 'Each fill costs 30% of your max life and adds 1 h of medical cooldown (Torn wiki). Mentat times each fill for when your life is full again, so no regen is lost.',
    gym: 'Mentat projects your energy to this time (regen, earlier boosts and sessions) and warns when you\'d be short.',
    crimes: 'Mentat projects your nerve to this time and warns when you\'d be short.',
  }[d.type];
  return `<form class="pl-form" data-plform autocomplete="off">
    <div class="pl-fields">
      ${field('Type', sel('type', Object.entries(PL_TYPES).map(([k, x]) => [k, x.label]), d.type))}
      ${field('Day', sel('day', dayOpts.map(k => [k, k === pmDayKey(mdl.now) ? `Today (${k.slice(5)})` : `${new Date(`${k}T00:00:00Z`).toUTCString().slice(0, 3)} ${k.slice(5)}`]), F.day))}
      ${field('Time (TCT)', `<input name="time" type="time" value="${pmHM(d.at)}" required>`)}
      ${fields}
      ${field(d.type === 'note' ? 'Note' : 'Note (optional)', `<input name="note" type="text" maxlength="300" value="${esc(d.note || '')}" ${d.type === 'note' ? 'required' : ''}>`, true)}
      ${field('Reminder', sel('remind', PL_REMIND, d.remind))}
      ${d.remind >= 0 ? field('Reminder style', sel('urgent', [['', `As in Settings (${plUrgentDefault(d.type) ? 'urgent' : 'normal popup'})`], ['on', 'Urgent: middle of the screen'], ['off', 'Normal popup']], d.urgent || '')) : ''}
    </div>
    ${hint ? `<div class="note">${esc(hint)}</div>` : ''}
    <div class="pl-preview-slot">${plPreview(mdl, d)}</div>
    ${PLS.err ? `<div class="error">${esc(PLS.err)}</div>` : ''}
    <div class="row"><button class="primary">${F.id ? 'Save' : 'Add to plan'}</button><button type="button" data-plcancel>Cancel</button></div>
  </form>`;
}

// A trip's timing, checked while you fill the form in.
function plPreview(mdl, d) {
  let preview = '';
  if (d.type === 'trip' && d.at) {
    const tr = plTrip({ ...d, id: 'draft' }, mdl.M, mdl.now);
    preview = `<div class="pl-preview"><div class="pl-meta">Lands ${plWhen(tr.landAt)} · back in Torn ${plWhen(tr.backAt)} (${fmtMin(tr.fMin)} each way)${tr.profit ? ` · ≈ ${money(tr.profit.total)} profit` : ''}</div>
      ${tr.lines.map(l => `<div class="pl-msg ${l.level}"><span class="pl-msg-ic" aria-hidden="true">${l.level === 'ok' ? '✓' : l.level === 'info' ? 'i' : l.level === 'money' ? '$' : '!'}</span><span>${l.text}</span></div>`).join('')}
      ${tr.moves.length ? `<div class="pl-moves">${tr.moves.map(m => `<button type="button" data-pldraftmove="${m.at}">${esc(m.label)}</button>`).join('')}</div>` : ''}</div>`;
  }
  return preview;
}

// Reads the form into the draft (so a re-draw keeps what was typed).
function plReadForm(f) {
  const F = PLS.form;
  if (!F || !f) return;
  const d = F.draft;
  const v = n => (f.elements[n] ? f.elements[n].value : undefined);
  F.day = v('day') || F.day;
  const hm = (v('time') || pmHM(d.at)).split(':').map(Number);
  d.at = Date.parse(`${F.day}T00:00:00Z`) + ((hm[0] || 0) * 60 + (hm[1] || 0)) * PM_MIN;
  for (const n of ['country', 'method', 'kind', 'cd', 'note', 'urgent']) if (v(n) !== undefined) d[n] = v(n);
  for (const n of ['itemId', 'stay', 'amount', 'count', 'cdHours', 'remind']) if (v(n) !== undefined) d[n] = Number(v(n));
  if (v('type') && v('type') !== d.type) {
    const keep = F.remindSet ? { remind: d.remind } : {};
    const next = plDraftDefaults(v('type'), { ...d, remind: undefined });
    F.draft = { ...next, ...keep, at: d.at };
  }
}

// ---- Render ----
// force: a redraw you asked for (a click, a choice in the form). Without it (live data arriving, the
// minute timer) the tab waits while you're typing in the form, so a half-typed time isn't reset.
function renderPlanner(force) {
  const el = panel('planner');
  if (!el || !el.classList.contains('active')) return;
  const a = document.activeElement;
  if (force !== true && a && el.contains(a) && a.closest('[data-plform]')) { PLS.pending = true; return; }
  PLS.pending = false;
  const mdl = plModel();
  if (!mdl) { el.innerHTML = '<div class="empty">Loading…</div>'; return; }
  const { now, sim, u } = mdl;
  const bars = sim.bars;
  const barCard = (k, word) => {
    const s = bars[k];
    if (!s) return `<div class="stat"><div class="k">${word}</div><div class="v muted">–</div></div>`;
    const b = u.bars[k];
    const full = b.current >= b.maximum ? 'full now' : s.fullAt.length ? `full ${plWhen(s.fullAt[0])}` : '';
    const lost = k === 'life' ? 0 : Math.round(s.wasted); // sitting at full life is normal, not a loss
    return `<div class="stat pl-bar-${k}"><div class="k">${word}</div><div class="v">${b.current}/${b.maximum}</div><div class="muted small">${full}${lost ? ` · <span class="neg">${lost} regen lost while full</span>` : ''}</div></div>`;
  };
  const cds = u && u.cooldowns ? ['drug', 'booster', 'medical'].map(k => {
    const end = sim.cooldowns[k];
    return `${k} ${end > now + 30000 ? `until ${plWhen(end)}` : 'free'}`;
  }).join(' · ') : '';
  const next = mdl.items.filter(i => i.at >= now && !i.done).slice(0, 3);
  const dayHtml = [];
  for (let i = 0; i < mdl.days; i++) {
    const d0 = mdl.start + i * PM_DAY;
    const key = pmDayKey(d0);
    const its = mdl.items.filter(it => it.at >= d0 && it.at < d0 + PM_DAY);
    const label = i === 0 ? 'Today' : i === 1 ? 'Tomorrow' : new Date(d0).toUTCString().slice(0, 3);
    const lost = PL_SERIES.map(([k, w]) => (bars[k] && bars[k].wastedByDay[key] && k !== 'life' ? `${w.toLowerCase()} ${bars[k].wastedByDay[key]}` : '')).filter(Boolean);
    const formHere = PLS.form && PLS.form.day === key;
    dayHtml.push(`<section class="pl-day" data-plday="${key}" aria-label="${esc(label)}">
      <div class="pl-dayhead"><h3>${label} <span class="muted small">${new Date(d0).toUTCString().slice(5, 11)} · TCT</span></h3>
        <span class="row wrap">${its.length ? `<button data-plcopy="${key}" title="Copy this day's plan to the next day">Copy to next day</button><button data-plclear="${key}" class="danger">Clear</button>` : ''}<button class="primary" data-pladd="${key}">+ Add</button></span></div>
      <div class="chart pl-tl" data-pltl="${key}"></div>
      ${lost.length ? `<div class="pl-msg warn"><span class="pl-msg-ic" aria-hidden="true">!</span><span>Regen lost while full this day: ${esc(lost.join(', '))}. Spend or plan a session before the bar fills.</span></div>` : ''}
      ${formHere && !PLS.form.id ? plForm(mdl) : ''}
      ${its.length ? `<ul class="pl-list">${its.map(it => (PLS.form && PLS.form.id === it.id ? `<li class="pl-item editing">${plForm(mdl)}</li>` : plItemRow(it, mdl))).join('')}</ul>` : formHere ? '' : '<div class="muted small pl-empty">Nothing planned.</div>'}
    </section>`);
  }
  const later = mdl.items.filter(it => it.at >= mdl.end).length;
  el.innerHTML = `
    <div class="pl-head">
      <div>
        <h2 class="pl-h">Planner</h2>
        <div class="note" style="margin:0">Plan the next few days: trips (timed to restocks), gym and crimes, boosts, blood bags and notes. Each day is a 24-hour timeline: your plan on top, your energy, nerve and life projected underneath from your live data, and time away from Torn shaded through both. Hover for details, click a block to change it, or click an empty spot to plan something at that time. Times are Torn City Time; the plan syncs to your other devices.</div>
      </div>
      <div class="pl-days row"><span class="muted small">Plan covers</span><button data-pldays="-1" ${mdl.days <= 1 ? 'disabled' : ''} aria-label="One day fewer">−</button><b>${mdl.days} day${mdl.days === 1 ? '' : 's'}</b><button data-pldays="1" ${mdl.days >= 60 ? 'disabled' : ''}>+ Add a day</button></div>
    </div>
    <div class="cz-stats pl-stats">
      ${barCard('energy', 'Energy')}${barCard('nerve', 'Nerve')}${barCard('life', 'Life')}
      <div class="stat"><div class="k">Next up</div><div class="v small">${next.length ? next.map(it => `${pmHM(it.at)} ${esc(plTitle(it))}`).join('<br>') : '<span class="muted">Nothing planned</span>'}</div></div>
    </div>
    ${!u || !u.bars ? '<div class="note">Add your Torn API key (Settings → Account) to project your energy, nerve and life through the plan.</div>' : `<div class="muted small" style="margin:-4px 0 8px">Cooldowns at the end of the plan: ${cds}. Regen counted from your API data (${bars.energy ? `energy +${bars.energy.inc} every ${bars.energy.interval / PM_MIN} min` : ''}${bars.nerve ? `, nerve +${bars.nerve.inc} every ${bars.nerve.interval / PM_MIN} min` : ''}${bars.life ? `, life +${bars.life.inc} every ${bars.life.interval / PM_MIN} min` : ''}).</div>`}
    ${dayHtml.join('')}
    ${later ? `<div class="note">${later} item${later === 1 ? '' : 's'} after the last day: add days to see ${later === 1 ? 'it' : 'them'}.</div>` : ''}`;
  // Each day's 24-hour timeline, drawn to the panel's width.
  for (const host of el.querySelectorAll('[data-pltl]')) plTimeline(host, mdl, Date.parse(`${host.dataset.pltl}T00:00:00Z`));
  const f = el.querySelector('[data-plform]');
  if (f && PLS.focus) { const x = f.elements[PLS.focus]; if (x) x.focus(); PLS.focus = ''; }
}

// ---- Events ----
function plOpenForm(day, id, at) {
  const P = S.features.planner;
  const it = id && P && P.items[id];
  PLS.err = '';
  PLS.form = it ? { day: pmDayKey(it.at), id, draft: { ...it } } : { day, id: null, draft: { ...plDraftDefaults(prefs.get('planner.lastType', 'trip')), at: at || plDefaultTime(day) } };
  PLS.focus = it ? 'time' : 'type';
  renderPlanner(true);
  const f = $('#panels [data-plform]');
  if (f) f.scrollIntoView({ block: 'nearest' });
}

function initPlanner() {
  const el = panel('planner');
  el.addEventListener('click', async e => {
    const t = e.target;
    const days = t.closest('[data-pldays]');
    if (days) { const n = (S.features.planner.days || 3) + Number(days.dataset.pldays); cmd('settings.set', 'planner.days', Math.max(1, Math.min(60, n))); return; }
    const add = t.closest('[data-pladd]');
    if (add) { plOpenForm(add.dataset.pladd); return; }
    const ed = t.closest('[data-pledit]');
    if (ed) { plOpenForm(null, ed.dataset.pledit); return; }
    if (t.closest('[data-plcancel]')) { PLS.form = null; renderPlanner(true); return; }
    const rm = t.closest('[data-plrm]');
    if (rm) { const it = S.features.planner.items[rm.dataset.plrm]; if (it && confirm(`Remove "${plTitle(it)}" at ${pmHM(it.at)}?`)) cmd('planner.remove', rm.dataset.plrm); return; }
    const mv = t.closest('[data-plmove]');
    if (mv) { mv.disabled = true; cmd('planner.update', mv.dataset.plmove, { at: Number(mv.dataset.at) }).catch(ex => toast(ex.message)); return; }
    const dm = t.closest('[data-pldraftmove]');
    if (dm && PLS.form) {
      plReadForm(dm.closest('form'));
      PLS.form.draft.at = Number(dm.dataset.pldraftmove);
      PLS.form.day = pmDayKey(PLS.form.draft.at);
      renderPlanner(true);
      return;
    }
    const cp = t.closest('[data-plcopy]');
    if (cp) {
      const to = pmDayKey(Date.parse(`${cp.dataset.plcopy}T00:00:00Z`) + PM_DAY);
      try {
        const n = await cmd('planner.copyDay', cp.dataset.plcopy, to);
        const need = Math.round((Date.parse(`${to}T00:00:00Z`) - pmDayStart(Date.now())) / PM_DAY) + 1;
        if (need > S.features.planner.days) cmd('settings.set', 'planner.days', Math.min(60, need));
        toast(`Copied ${n} item${n === 1 ? '' : 's'} to ${to.slice(5)}.`, 4000);
      } catch (ex) { toast(ex.message); }
      return;
    }
    const cl = t.closest('[data-plclear]');
    if (cl && confirm(`Remove everything planned on ${cl.dataset.plclear.slice(5)}?`)) cmd('planner.clearDay', cl.dataset.plclear);
  });
  el.addEventListener('change', e => {
    const t = e.target;
    if (t.matches('[data-pldone]')) { cmd('planner.update', t.dataset.pldone, { done: t.checked }); return; }
    const f = t.closest('[data-plform]');
    if (!f) return;
    if (t.name === 'remind' && PLS.form) PLS.form.remindSet = true;
    plReadForm(f); // keep what was typed, in case the tab is redrawn
    if (t.name === 'time' || t.name === 'stay') {
      const slot = f.querySelector('.pl-preview-slot');
      const mdl = slot && plModel();
      if (mdl) slot.innerHTML = plPreview(mdl, PLS.form.draft);
      return;
    }
    // Fields that change what the form shows: draw it again.
    if (['type', 'country', 'kind', 'method', 'itemId', 'day', 'remind'].includes(t.name)) {
      PLS.focus = t.name;
      renderPlanner(true);
    }
  });
  el.addEventListener('submit', async e => {
    const f = e.target.closest('[data-plform]');
    if (!f) return;
    e.preventDefault();
    plReadForm(f);
    const F = PLS.form;
    const d = { ...F.draft };
    if (d.type === 'trip' && !d.itemId) d.itemId = 0;
    d.bring = d.type === 'trip' ? plBringSummary(d) || null : null; // null clears an old one
    if ((d.type === 'energy' || d.type === 'nerve') && !d.amount) delete d.amount;
    delete d.id; delete d.updatedAt;
    try {
      if (F.id) await cmd('planner.update', F.id, d);
      else { await cmd('planner.add', d); prefs.set('planner.lastType', d.type); }
      PLS.form = null;
      PLS.err = '';
    } catch (ex) { PLS.err = ex.message || String(ex); }
    renderPlanner(true);
  });
  // Charts are drawn to the panel's width: draw again when it changes.
  let plW = 0, plT = 0;
  window.addEventListener('resize', () => {
    clearTimeout(plT);
    plT = setTimeout(() => { if (el.classList.contains('active') && el.clientWidth !== plW) { plW = el.clientWidth; renderSafe('planner', renderPlanner); } }, 200);
  });
  // A redraw that waited for you to finish typing: once you leave the form.
  el.addEventListener('focusout', e => {
    const f = e.target.closest && e.target.closest('[data-plform]');
    if (!PLS.pending || !f || (e.relatedTarget && f.contains(e.relatedTarget))) return;
    setTimeout(() => { if (PLS.pending) renderSafe('planner', () => renderPlanner(true)); }, 0);
  });
  // Keep "past" markers and projections current while the tab is open.
  setInterval(() => { if (el.classList.contains('active')) renderSafe('planner', renderPlanner); }, 60000);
}
