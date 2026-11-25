'use strict';
/* global restockAlerts, plBringSummary, S, $, $$, panel, esc, num, cmd, money, pct, signClass, tct, fmtMin, fmtAgo, ago, link, marketUrl, itemLink, prefs,
   CATALOG, loadCatalog, itemName, itemMV, itemType, lineChart, columnChart */
// Travel planner. Combines YATA abroad stock (with locally measured sell-out and restock
// patterns), Torn item prices (market value or live listings), your capacity, flight
// method and ticket costs into ranked round trips.

const SPECIAL_TYPES = new Set(['Flower', 'Plushie']);
const RISK = { ok: ['ok', 'In stock'], partial: ['warn', 'Partial'], empty: ['bad', 'Likely empty'], unknown: ['', 'Unknown'], restock: ['info', 'Restock due'] };
let trendCache = { at: 0, data: {} };

// ---- Model ----
function travelModel() {
  const T = S.features.travel;
  const ts = S.settings && S.settings.travel;
  if (!T || !ts) return null;
  const method = ts.method === 'auto' ? (T.lastMethod || 'Standard') : ts.method;
  const mi = Math.max(0, T.methods.indexOf(method));
  const capApi = T.capacityApi && !T.capacityApi.denied && T.capacityApi.base ? T.capacityApi : null;
  const general = ts.capacity > 0 ? ts.capacity : capApi ? capApi.base : method === 'Standard' ? 10 : 15;
  const special = capApi ? capApi.special || 0 : 0;
  const capSource = ts.capacity > 0 ? 'your setting' : capApi ? 'from your API key' : 'default for this method';
  const live = (S.features.market && S.features.market.live) || {};
  const bct = CATALOG.byName['business class ticket'];
  const fee = 1 - (ts.feePct || 0) / 100;

  const meta = Object.fromEntries(T.countriesMeta.map(c => [c.code, c]));
  const flight = c => {
    const key = `${c.code}|${method}`;
    if (ts.override && ts.override[key]) return { min: ts.override[key], source: 'your override' };
    if (T.learned && T.learned[key]) return { min: T.learned[key], source: 'measured' };
    return { min: meta[c.code].times[mi] * (ts.book ? 0.75 : 1), source: ts.book ? 'wiki −25% book' : 'wiki' };
  };
  const ticket = c => {
    const one = method === 'Standard' ? meta[c.code].ticket : method === 'Business' ? (bct ? itemMV(bct) : 0) : 0;
    return one;
  };
  // Selling at home: market value, or the cheapest current listing from the price source
  // (item market and/or bazaars) when "Sell at: Cheapest listing" is chosen.
  const sellHome = id => {
    if (ts.sellMode === 'live') {
      const c = cheapest(id);
      if (c.price) return { price: c.price * fee, source: c.where };
    }
    return { price: itemMV(id) * fee, source: 'mv' };
  };
  // Buying at home (for selling abroad): the cheapest listing you could actually buy.
  const buyHome = id => {
    const c = cheapest(id);
    if (c.price) return { price: c.price, source: c.where };
    return { price: itemMV(id), source: 'mv' };
  };
  return { T, ts, method, general, special, capSource, capApi, live, flight, ticket, sellHome, buyHome };
}

// An item's restock timer in words: "55m after selling out", "every 14m", "about every 2h 03m".
function cadText(cad) {
  if (!cad) return '';
  if (cad.kind === 'sellout') return `${fmtMin(cad.delay / 60000)} after selling out`;
  if (cad.kind === 'interval') return `about every ${fmtMin(cad.period / 60000)}`;
  return `every ${fmtMin(cad.period / 60000)}`;
}

// The predicted restock at or before t (null if none: a sell-out timer has nothing before its next
// restock), and the first one after t.
function cadPrev(cad, t) {
  if (!cad) return null;
  const k = Math.floor((t - cad.anchor) / cad.period);
  if (cad.kind === 'sellout' && k < 0) return null;
  return cad.anchor + k * cad.period;
}
function cadNext(cad, t) {
  const p = cadPrev(cad, t);
  return p === null ? cad.anchor : p + cad.period;
}

// Expected stock when you land.
// - If the learned rhythm says a restock happens between YATA's last reading and your
//   landing, start from the typical restock size and take off what usually sells between
//   the restock and your landing (from how long stock normally lasts).
// - Otherwise take the last reading and subtract the measured sell rate.
const MINUTE = 60000;
function predictStock(country, item, landAt) {
  const st = item.stats || {};
  const q = item.quantity;
  const cad = st.cadence;
  const lastReading = country.update;
  let restockAt = null;
  if (cad) {
    const r = cadPrev(cad, landAt);
    if (r !== null && r > lastReading && r <= landAt) restockAt = r;
  }
  // Units sold per minute right after a restock (stock lasts `stay` minutes on average).
  const drain = st.size && st.stay ? st.size / (st.stay / MINUTE) : st.rate;
  if (restockAt) {
    const conf = cad.confidence;
    if (!st.size) return { q: 0, how: `restock ~${tct(restockAt)}, size unknown`, restock: true, restockAt, conf };
    const since = (landAt - restockAt) / MINUTE;
    const left = Math.max(st.size, q) - (drain || 0) * since;
    return { q: Math.max(0, Math.floor(left)), how: `restocks ~${tct(restockAt)} (${conf})`, restock: true, restockAt, conf };
  }
  if (q > 0) {
    if (st.rate) {
      const left = q - st.rate * ((landAt - lastReading) / MINUTE);
      return { q: Math.max(0, Math.floor(left)), how: left > 0 ? 'sell rate measured' : 'sells out first', outAt: lastReading + (q / st.rate) * MINUTE };
    }
    return { q, how: 'no sell rate yet' };
  }
  const next = (st.next || []).find(t => t > landAt);
  return { q: 0, how: next ? `empty, restock ~${tct(next)}` : 'empty' };
}

// When to land after a predicted restock: once it has surely happened (its uncertainty
// plus a minute), but well before it usually sells out.
function landingDelay(st) {
  const cad = st.cadence;
  let d = (cad ? cad.uncertainty : 2 * MINUTE) + MINUTE;
  if (st.stay) d = Math.min(d, st.stay * 0.4);
  return Math.max(30000, d);
}

// Upcoming departures timed to land just after predicted restocks, for every destination,
// ranked by expected profit. Also includes "leave now" for each destination.
// opt.focus = an item you want: only countries selling it, departures timed to its
// restocks, and it goes in the plan first (even if it doesn't sell at a profit at home).
// opt.only = carry just that item (no filling spare slots with others).
function timedTrips(M, horizonMs = 6 * 3600 * 1000, opt = {}) {
  const now = Date.now();
  const trips = [];
  const focus = opt.focus || 0;
  for (const c of M.T.countries) {
    if (!c.items.length) continue;
    if (focus && !c.items.some(i => i.id === focus)) continue;
    const f = M.flight(c).min * MINUTE;
    const landings = [{ at: now + f, target: null }];
    for (const it of c.items) {
      const st = it.stats;
      if (!st || !st.cadence || !it.cost) continue;
      if (focus ? it.id !== focus : M.sellHome(it.id).price - it.cost <= 0) continue;
      for (const R of st.next || []) {
        const at = R + landingDelay(st);
        if (at - f < now || at - f > now + horizonMs) continue;
        landings.push({ at, target: it.id, restockAt: R });
      }
    }
    landings.sort((a, b) => a.at - b.at);
    const seen = [];
    for (const l of landings) {
      if (seen.some(s => Math.abs(s - l.at) < 2 * MINUTE)) continue;
      seen.push(l.at);
      const t = planTrip(M, c, l.at - f, opt);
      t.timed = !!l.target;
      t.target = l.target || 0;       // the item whose restock this trip is timed to
      t.restockAt = l.restockAt || 0;
      t.wait = l.at - f - now;
      trips.push(t);
    }
  }
  return trips;
}

// Greedy fill: special slots (flowers/plushies only) with the best of those first, then
// general slots with the best of everything left. Each candidate: { id, profit, avail }.
// A `focus` item (one you chose) goes first and is taken even without a profit.
function fill(cands, general, special, focus = 0) {
  const lines = new Map();
  const left = new Map(cands.map(c => [c.id, c.avail]));
  const sorted = cands.filter(c => c.avail > 0 && (c.profit > 0 || c.id === focus))
    .sort((a, b) => (b.id === focus) - (a.id === focus) || b.profit - a.profit);
  const take = (c, slots) => {
    const n = Math.min(slots, left.get(c.id));
    if (n <= 0) return 0;
    left.set(c.id, left.get(c.id) - n);
    const l = lines.get(c.id) || { ...c, qty: 0 };
    l.qty += n;
    lines.set(c.id, l);
    return n;
  };
  let sp = special, gen = general;
  for (const c of sorted) if (sp > 0 && SPECIAL_TYPES.has(itemType(c.id))) sp -= take(c, sp);
  for (const c of sorted) if (gen > 0) gen -= take(c, gen);
  const out = [...lines.values()].sort((a, b) => b.profit * b.qty - a.profit * a.qty);
  return { lines: out, total: out.reduce((s, l) => s + l.profit * l.qty, 0), cash: out.reduce((s, l) => s + l.cost * l.qty, 0), used: out.reduce((s, l) => s + l.qty, 0) };
}

function inboundCands(M, country, landAt) {
  return country.items.filter(i => i.cost > 0).map(i => {
    const sell = M.sellHome(i.id);
    const pred = predictStock(country, i, landAt);
    return { id: i.id, name: i.name, cost: i.cost, sell: sell.price, sellSource: sell.source, profit: sell.price - i.cost, avail: pred.q, pred, quantity: i.quantity, stats: i.stats };
  });
}

// Selling abroad: shops buy back what they sell. Black Market pays its current price,
// every other shop 75% of its price (Torn wiki, Travel).
// Suitcases can't be sold abroad (the user, 2026-11-25), so they never count as an outbound sale.
function cantSellAbroad(name) { return /suitcase/i.test(name || ''); }
function isBlackMarket(id, countryName) {
  const it = CATALOG.items[id];
  if (it && Array.isArray(it[5]) && it[5].some(s => s[0] === countryName && s[1] === 'Black Market')) return true;
  return itemType(id) === 'Drug';
}
function outboundCands(M, country) {
  return country.items.filter(i => i.cost > 0 && !cantSellAbroad(i.name || (CATALOG.items[i.id] || [])[0])).map(i => {
    const bm = isBlackMarket(i.id, country.name);
    const sellAbroad = bm ? i.cost : i.cost * 0.75;
    const buy = M.buyHome(i.id);
    return { id: i.id, name: i.name, cost: buy.price, buySource: buy.source, sellAbroad, shop: bm ? 'Black Market' : 'Shop (75%)', profit: buy.price > 0 ? sellAbroad - buy.price : 0, avail: Infinity };
  });
}

function planTrip(M, country, leaveAt, opt = {}) {
  const f = M.flight(country);
  const landAt = leaveAt + f.min * 60000;
  const focus = opt.focus || 0;
  let cands = inboundCands(M, country, landAt);
  const focusCand = focus ? cands.find(c => c.id === focus) || null : null;
  if (focus && opt.only) cands = cands.filter(c => c.id === focus);
  const inbound = fill(cands, M.general, M.special, focus);
  const outbound = M.ts.outbound ? fill(outboundCands(M, country), M.general, M.special) : { lines: [], total: 0, cash: 0, used: 0 };
  const ticket = M.ticket(country);
  const profit = inbound.total + outbound.total - ticket;
  const hours = (2 * f.min) / 60;
  const capacity = M.general + M.special;
  let risk = 'ok';
  if (!country.update) risk = 'unknown';
  else if (inbound.used === 0) risk = 'empty';
  else if (inbound.used < M.general) risk = inbound.lines.some(l => l.pred.restock) ? 'restock' : 'partial';
  const focusLine = focus ? inbound.lines.find(l => l.id === focus) || null : null;
  return { country, flight: f, leaveAt, landAt, inbound, outbound, ticket, profit, hours, perHour: hours ? profit / hours : 0, cash: inbound.cash + outbound.cash, risk, capacity, focus, focusCand, focusLine };
}

// Departures that land just after a restock: learned restock times when the app has them,
// otherwise the assumed schedule from Flights & settings (default every 15 minutes).
function restockDepartures(M, country, count = 4) {
  const learned = timedTrips(M).filter(t => t.country.code === country.code && t.timed).sort((a, b) => a.leaveAt - b.leaveAt);
  if (learned.length) return learned.slice(0, count);
  const I = Math.max(5, M.ts.restockInterval || 15) * 60000;
  const O = (M.ts.restockOffset || 0) * 60000;
  const f = M.flight(country).min * 60000;
  const earliest = Date.now() + f;
  let slot = Math.ceil((earliest - O) / I) * I + O;
  const out = [];
  for (let i = 0; i < count; i++, slot += I) {
    const land = slot + 60000; // land a minute after the restock
    out.push(planTrip(M, country, land - f));
  }
  return out;
}

// ---- Rendering ----
function renderTravel() {
  const el = panel('travel');
  if (!el.classList.contains('active')) return;
  const M = travelModel();
  if (!M) { el.innerHTML = '<div class="empty">Loading…</div>'; return; }
  const sub = navView('travel');
  const T = M.T;
  const anyStock = T.countries.some(c => c.items.length);
  const status = `${T.error ? `<span class="neg">${esc(T.error)}</span> · ` : ''}Stock from YATA${T.fromServer ? ' <span class="sync-badge" title="Polled by your sync server (Settings → Data source)">via your server</span>' : ''} ${T.fetchedAt ? ago(T.fetchedAt) : M.ts.yata ? 'loading…' : 'off'} · Sell prices: ${M.ts.sellMode === 'live' ? `cheapest listing (${SOURCE_LABEL[priceSource()].toLowerCase()}), else market value` : 'Torn market value'} · Buy prices at home: cheapest listing (${SOURCE_LABEL[priceSource()].toLowerCase()})${BAZAAR.fetchedAt ? `, bazaars ${fmtAgo(BAZAAR.fetchedAt)}` : ''}${CATALOG.fetchedAt ? '' : ' (loading item list…)'}`;

  el.innerHTML = `
    ${navSubnav('travel', 'tsub')}
    <div class="toolbar">
      <label>Method <select data-set="travel.method"><option value="auto">Auto (${esc(T.lastMethod || 'Standard')})</option>${T.methods.map(m => `<option value="${m}">${m === 'Private' ? 'WLT (Private)' : m}</option>`).join('')}</select></label>
      <label>Sell at <select data-set="travel.sellMode"><option value="market">Market value</option><option value="live">Cheapest listing</option></select></label>
      <label>Prices from <select data-set="market.priceSource"><option value="both">Market + bazaars</option><option value="market">Item market</option><option value="bazaar">Bazaars</option></select></label>
      <label class="row"><input type="checkbox" data-set="travel.outbound"> Sell abroad too</label>
      <span class="muted small">Carry ${M.general}${M.special ? ` + ${M.special} flowers/plushies` : ''} (${M.capSource})</span>
      <button data-cmd="travel.refresh" title="Fetch the latest abroad stock from YATA">Refresh stock</button>
    </div>
    <div class="note" style="margin-top:0">${status}</div>
    <div id="travel-body"></div>`;
  const body = $('#travel-body');
  if (!anyStock && sub !== 'flights') body.innerHTML = `<div class="empty">${M.ts.yata ? 'Waiting for abroad stock from YATA…' : 'YATA stock is turned off in Flights & settings.'}</div>`;
  else if (sub === 'timed') renderTimed(body, M);
  else if (sub === 'plan') renderPlan(body, M);
  else if (sub === 'items') renderItems(body, M);
  else if (sub === 'sell') renderSell(body, M);
  else renderFlights(body, M);
  syncSettingInputs();
}

const confPill = c => (c ? `<span class="pill ${c === 'high' ? 'ok' : c === 'medium' ? 'warn' : ''}" title="How sure the restock prediction is">${c}</span>` : '');

// Restock history for one item in a country (trip details): its stock over everything collected,
// when in the hour it restocks, and its latest restocks. One item at a time, because blending every
// item together flattens the picture (each item restocks at its own minutes).
function histItemFor(c, t) {
  const saved = Number(prefs.get(`travel.histItem.${c.code}`, 0));
  if (saved && c.items.some(i => i.id === saved)) return saved;
  const planned = t && t.inbound.lines[0];
  if (planned) return planned.id;
  const best = [...c.items].sort((a, b) => ((b.stats && b.stats.restockCount) || 0) - ((a.stats && a.stats.restockCount) || 0))[0];
  return best ? best.id : 0;
}
function restockHistoryShell(M, c, t) {
  const id = histItemFor(c, t);
  const T = M.T;
  const hours = c.since ? (Date.now() - c.since) / 3600e3 : 0;
  const items = [...c.items].sort((a, b) => ((b.stats && b.stats.restockCount) || 0) - ((a.stats && a.stats.restockCount) || 0) || a.name.localeCompare(b.name));
  return `<div class="row between wrap" style="margin-top:12px"><b>Restock history in ${esc(c.name)}</b>
      <label class="small row">Item <select data-thist="${c.code}">${items.map(i => `<option value="${i.id}" ${i.id === id ? 'selected' : ''}>${esc(i.name)} (${num((i.stats && i.stats.restockCount) || 0)} restocks)</option>`).join('')}</select></label></div>
    <div class="muted small">${hours >= 48 ? `${(hours / 24).toFixed(1)} days` : `${hours.toFixed(1)} h`} of YATA readings ${T.fromServer ? 'collected by your Mentat server' : 'collected by this app'} (kept for 4 days).</div>
    <div class="cols2 thist">
      <div><div class="chart-title">Stock over time</div><div id="thist-stock"></div></div>
      <div><div class="chart-title" id="restock-hist-title">When it restocks (minute of the hour, TCT)</div><div id="restock-hist"></div></div>
    </div>
    <div id="thist-ra"></div>
    <div id="thist-list"></div>`;
}
function drawRestockHist(M, code) {
  const hist = $('#restock-hist');
  const sel = $(`[data-thist="${code}"]`);
  const c = M.T.countries.find(x => x.code === code);
  if (!hist || !c || !sel) return;
  const id = Number(sel.value);
  const it = c.items.find(i => i.id === id);
  if (!it) return;
  const st = it.stats || {};
  const h = st.minuteHist || new Array(12).fill(0);
  const peak = Math.max(...h);
  columnChart(hist, {
    bars: h.map((v, k) => ({ label: `:${String(k * 5).padStart(2, '0')}`, value: v, tip: `${v} restock${v === 1 ? '' : 's'} at :${String(k * 5).padStart(2, '0')}–:${String(k * 5 + 4).padStart(2, '0')}` })),
    yFmt: v => String(Math.round(v)), empty: `No restocks of ${esc(it.name)} pinned down yet.`,
  });
  if (!peak) hist.innerHTML = `<div class="chart-empty">No restocks of ${esc(it.name)} pinned down yet.</div>`;
  const cad = st.cadence;
  const next = (st.next || []).filter(t => t > Date.now() - 60000).slice(0, 3);
  const recent = (st.restocks || []).slice(-8).reverse();
  // Sold out with no prediction: say how long, and whether that's late for this item.
  const outSince = !cad && st.zeroSince ? (st.lastPositive ? (st.lastPositive + st.zeroSince) / 2 : st.zeroSince) : 0;
  const late = outSince && st.selloutDelay ? `; it usually restocks ${fmtMin(st.selloutDelay.delay / 60000)} after selling out, so it's running late` : '';
  const ra = $('#thist-ra');
  if (ra) ra.innerHTML = restockAlerts(`${c.code}:${it.id}`, `${it.name} in ${c.name}`);
  const list = $('#thist-list');
  if (list) {
    list.innerHTML = `<div class="muted small" style="margin-top:4px">${cad ? `Restocks ${cadText(cad)}${cad.kind === 'sellout' && cad.soldOut ? ' (sold out now)' : ''}, ${cad.confidence} confidence${next.length ? ` · next ~${next.map(tct).join(', ')} ±${Math.ceil(cad.uncertainty / 60000)}m` : ''}` : outSince ? `Sold out since ${tct(outSince)} (${fmtMin((Date.now() - outSince) / 60000)} ago)${late}` : 'Not enough restocks of this item yet to time it'}${st.size ? ` · typical restock ${num(Math.round(st.size))}` : ''}${st.stay ? ` · lasts about ${fmtMin(st.stay / 60000)}` : ''} · ${num(st.restockCount || 0)} restocks seen</div>
      ${recent.length ? `<table class="data thist-recent"><tr><th>Latest restocks (TCT)</th><th class="num">Before</th><th class="num">After</th></tr>${recent.map(x => `<tr><td>${new Date(x.to).toUTCString().slice(5, 11)} ${tct(x.from)}${x.to - x.from > 60000 ? `–${tct(x.to)}` : ''}</td><td class="num">${num(x.before)}</td><td class="num">${num(x.after)}</td></tr>`).join('')}</table>` : ''}`;
  }
  // Stock over everything collected (from the readings this device holds: your server's when synced).
  cmd('travel.stockHistory', code, id).then(pts => {
    const s = $('#thist-stock');
    const now = $(`[data-thist="${code}"]`);
    if (!s || !now || Number(now.value) !== id) return; // another item was picked meanwhile
    lineChart(s, { series: [{ name: it.name, points: pts, step: true }], yZero: true, yFmt: v => num(Math.round(v)), empty: 'No stock readings recorded yet.' });
  }).catch(() => {});
}

// ---- Add a trip to the Planner ----
// A trip leaving within a minute counts as "now": it's planned for the next whole minute when you click.
const NEXT_MINUTE = () => Math.ceil((Date.now() + 1000) / MINUTE) * MINUTE;
// The same trip already in your plan: same country, leaving within 3 minutes of it.
function plannedTrip(code, leaveAt) {
  const P = S.features && S.features.planner;
  return Object.values((P && P.items) || {}).find(it => it && !it.deleted && it.type === 'trip' && it.country === code && Math.abs(it.at - leaveAt) < 3 * MINUTE) || null;
}
// "Add to planner" for one trip, or "In planner" (opens the Planner) once it's there.
// itemId: the item the trip is for (your chosen item, or the restock it's timed to); else the top of the load.
function planButton(t, itemId = 0, restockAt = 0) {
  const now = t.leaveAt - Date.now() < MINUTE;
  const at = now ? NEXT_MINUTE() : Math.round(t.leaveAt / MINUTE) * MINUTE;
  if (plannedTrip(t.country.code, at)) return '<button class="tplan added" data-tplanopen title="This trip is in your Planner. Click to open the Planner.">✓ In planner</button>';
  const id = itemId || (t.inbound.lines[0] ? t.inbound.lines[0].id : 0);
  return `<button class="tplan" data-tplan="${t.country.code}|${now ? 'now' : at}|${id}|${restockAt || 0}" title="Add this trip to your Planner: leave ${now ? 'now' : tct(at)} (TCT) for ${esc(t.country.name)}">Add to planner</button>`;
}
async function addTripToPlan(btn) {
  const [code, when, itemStr, restockStr] = btn.dataset.tplan.split('|');
  const M = travelModel();
  const at = when === 'now' ? NEXT_MINUTE() : Number(when);
  const itemId = Number(itemStr) || 0, restockAt = Number(restockStr) || 0;
  const country = M ? M.T.countries.find(c => c.code === code) : null;
  btn.disabled = true;
  try {
    const trip = { type: 'trip', at, country: code, method: M ? M.method : 'Standard', itemId };
    await cmd('planner.add', {
      ...trip, stay: 0, bring: plBringSummary(trip),
      // A 5-minute warning when there's time for one; none for a trip you're about to take.
      remind: at - Date.now() > 6 * MINUTE ? 5 : at - Date.now() > 2 * MINUTE ? 0 : -1,
      note: restockAt && itemId ? `Timed to land after the ${itemName(itemId)} restock (~${tct(restockAt)} TCT)` : '',
    });
    // Make sure the plan covers the day of the trip.
    const P = S.features.planner;
    const need = Math.floor((at - pmDayStart(Date.now())) / PM_DAY) + 1;
    if (P && need > (P.days || 3)) cmd('settings.set', 'planner.days', Math.min(60, need));
    btn.className = 'tplan added';
    btn.removeAttribute('data-tplan');
    btn.setAttribute('data-tplanopen', '');
    btn.textContent = '✓ In planner';
    btn.title = 'This trip is in your Planner. Click to open the Planner.';
    btn.disabled = false;
    toast(`Added to the Planner: trip to ${country ? country.name : code}, leave ${tct(at)} TCT.`, 4000);
  } catch (ex) { btn.disabled = false; toast(ex.message || String(ex)); }
}

// ---- Timed trips: leave so you land as stock restocks ----
function renderTimed(body, M) {
  const now = Date.now();
  const T = M.T;
  const withData = T.countries.filter(c => c.items.length);
  const since = Math.min(...withData.map(c => c.since || now));
  const hours = (now - since) / 3600e3;
  const itemsAll = withData.reduce((s, c) => s + c.items.length, 0);
  const restocksSeen = withData.reduce((s, c) => s + (c.restocksSeen || 0), 0);
  const itemsOwn = withData.reduce((s, c) => s + c.items.filter(i => i.stats && i.stats.cadence).length, 0);
  const itemsSellout = withData.reduce((s, c) => s + c.items.filter(i => i.stats && i.stats.cadence && i.stats.cadence.kind === 'sellout').length, 0);
  const sortBy = prefs.get('travel.timedSort', 'profit');
  const open = prefs.get('travel.timedOpen', '');

  // Item you want to buy (0 = best of everything). Every item sold abroad, by name.
  const abroad = new Map();
  for (const c of withData) for (const i of c.items) {
    const a = abroad.get(i.id) || { id: i.id, name: i.name, type: itemType(i.id), countries: [] };
    a.countries.push(c.name);
    abroad.set(i.id, a);
  }
  let focus = Number(prefs.get('travel.timedItem', 0)) || 0;
  if (focus && !abroad.has(focus)) focus = 0;
  const fillSpare = prefs.get('travel.timedFill', true) !== false;
  const byType = {};
  for (const a of [...abroad.values()].sort((x, y) => x.name.localeCompare(y.name))) (byType[a.type || 'Other'] ||= []).push(a);
  const itemSelect = `<select data-tpref="timedItem" title="Plan trips around one item you want to buy">
    <option value="0">Best of everything</option>
    ${Object.keys(byType).sort().map(t => `<optgroup label="${esc(t)}">${byType[t].map(a => `<option value="${a.id}" ${a.id === focus ? 'selected' : ''}>${esc(a.name)} (${esc(a.countries.join(', '))})</option>`).join('')}</optgroup>`).join('')}
  </select>`;

  const trips = timedTrips(M, undefined, focus ? { focus, only: !fillSpare } : {}).filter(t => focus || t.profit > 0);
  const gotOf = t => (t.focusLine ? t.focusLine.qty : 0);
  const sorters = {
    profit: (a, b) => b.profit - a.profit, perHour: (a, b) => b.perHour - a.perHour, leave: (a, b) => a.leaveAt - b.leaveAt,
    item: (a, b) => gotOf(b) - gotOf(a) || a.leaveAt - b.leaveAt,
  };
  // With an item chosen, the default is "most of that item" (then soonest).
  const sortKey = focus ? prefs.get('travel.timedSortFocus', 'item') : sortBy;
  trips.sort(sorters[sortKey] || sorters.profit);
  const bestTimed = trips.filter(t => t.timed).sort(sorters.profit)[0];
  const bestNow = trips.filter(t => !t.timed).sort(sorters.profit)[0];
  const tripKey = t => `${t.country.code}@${Math.round(t.leaveAt / 60000)}`;

  // Items worth timing: profitable, with a learned or borrowed rhythm.
  const rhythm = [];
  for (const c of withData) for (const i of c.items) {
    if (!i.cost) continue;
    if (focus && i.id !== focus) continue;
    const profit = M.sellHome(i.id).price - i.cost;
    if (profit <= 0 && !focus) continue;
    const st = i.stats || {};
    const perTrip = profit * Math.min(M.general + (SPECIAL_TYPES.has(itemType(i.id)) ? M.special : 0), st.size || i.quantity || 0);
    rhythm.push({ c, i, st, profit, perTrip });
  }
  rhythm.sort((a, b) => b.perTrip - a.perTrip);

  const tripRow = t => {
    const key = tripKey(t);
    let top = t.inbound.lines.slice(0, 2).map(l => `${esc(l.name)} ×${l.qty}`).join(', ') || '<span class="muted">nothing expected</span>';
    if (focus) {
      // Your item first: how many you'd get of how many expected at landing.
      const fc = t.focusCand;
      const got = t.focusLine ? t.focusLine.qty : 0;
      const others = t.inbound.lines.filter(l => l.id !== focus);
      top = `<b class="${got ? '' : 'neg'}">${esc(abroad.get(focus).name)} ×${got}</b>${fc ? ` <span class="muted small">of ~${num(fc.avail)} expected</span>` : ''}${others.length ? `<div class="muted small">+ ${others.slice(0, 2).map(l => `${esc(l.name)} ×${l.qty}`).join(', ')}${others.length > 2 ? '…' : ''}</div>` : ''}`;
    }
    const target = focus ? (t.focusCand && t.focusCand.pred.restock ? t.focusCand : null) : t.inbound.lines.find(l => l.pred.restock);
    return `<tr class="clickable ${open === key ? 'selected' : ''} ${focus && !gotOf(t) ? 'dim' : ''}" data-ttimed="${key}">
      <td><b>${tct(t.leaveAt)}</b><div class="muted small">${t.wait > 60000 ? `in ${fmtMin(t.wait / 60000)}` : 'now'}</div></td>
      <td>${esc(t.country.name)}<div class="muted small">${fmtMin(t.flight.min)} flight</div></td>
      <td>${tct(t.landAt)}</td>
      <td>${top}</td>
      <td class="num ${signClass(t.profit)}"><b>${money(t.profit, true)}</b></td>
      <td class="num">${money(t.perHour, true)}</td>
      <td>${t.timed && target ? `restock ${confPill(target.pred.conf)}` : '<span class="pill">current stock</span>'}</td>
      <td>${planButton(t, focus || t.target, t.timed ? t.restockAt : 0)}</td>
    </tr>
    ${open === key ? `<tr class="detail"><td colspan="8">${tripDetail(M, t)}</td></tr>` : ''}`;
  };

  body.innerHTML = `
    <div class="grid4" style="margin-bottom:8px">
      <div class="stat"><div class="k">Data collected</div><div class="v">${hours >= 48 ? `${(hours / 24).toFixed(1)} days` : `${hours.toFixed(1)} h`}</div></div>
      <div class="stat"><div class="k">Restocks observed</div><div class="v">${num(restocksSeen)}</div></div>
      <div class="stat"><div class="k">Items with a known timer</div><div class="v">${itemsOwn} / ${itemsAll}</div></div>
      <div class="stat"><div class="k">Timed from selling out</div><div class="v">${itemsSellout}</div><div class="small muted">restock a set time after selling out</div></div>
    </div>
    ${hours < 24 ? `<div class="note" style="margin-top:0">Still learning. Restock timing is measured from YATA readings every 2 minutes ${T.fromServer ? "by your sync server, around the clock" : "while this app runs (it keeps collecting in the system tray)"}. Predictions marked <i>low</i> are early guesses; after a day or two most items reach <i>medium</i> or <i>high</i>.</div>` : ''}
    <div class="grid3" style="margin:8px 0" ${focus ? 'hidden' : ''}>
      <div class="stat"><div class="k">Best timed trip (next 6h)</div><div class="v">${bestTimed ? `${esc(bestTimed.country.name)} · leave ${tct(bestTimed.leaveAt)}` : '–'}</div><div class="small ${bestTimed ? 'pos' : 'muted'}">${bestTimed ? `${money(bestTimed.profit, true)} expected` : 'waiting for restock data'}</div></div>
      <div class="stat"><div class="k">Best if you leave now</div><div class="v">${bestNow ? esc(bestNow.country.name) : '–'}</div><div class="small ${bestNow ? 'pos' : 'muted'}">${bestNow ? `${money(bestNow.profit, true)} expected` : ''}</div></div>
      <div class="stat"><div class="k">Times shown in</div><div class="v">TCT</div><div class="small muted">now ${tct(now)}</div></div>
    </div>
    <div class="toolbar">
      <label>Item ${itemSelect}</label>
      ${focus ? `<label class="row"><input type="checkbox" data-tpref="timedFill" ${fillSpare ? 'checked' : ''}> Fill spare slots with other items</label>` : ''}
    </div>
    ${focus ? focusSummary(M, focus, abroad.get(focus), trips) : ''}
    <div class="toolbar"><label>Sort by <select data-tpref="${focus ? 'timedSortFocus' : 'timedSort'}">
      ${focus ? `<option value="item" ${sortKey === 'item' ? 'selected' : ''}>Most ${esc(abroad.get(focus).name)}</option>` : ''}
      <option value="profit" ${sortKey === 'profit' ? 'selected' : ''}>Profit per trip</option>
      <option value="perHour" ${sortKey === 'perHour' ? 'selected' : ''}>Profit per flight hour</option>
      <option value="leave" ${sortKey === 'leave' ? 'selected' : ''}>Departure time</option></select></label>
      <span class="muted small">${trips.length} options in the next 6 hours${focus ? `, timed to ${esc(abroad.get(focus).name)} restocks` : ''}</span></div>
    <div class="table-wrap"><table class="data">
      <tr><th>Leave</th><th>Destination</th><th>Land</th><th>Bring home</th><th class="num">Profit</th><th class="num">Per hour</th><th>Based on</th><th><span class="sr-only">Planner</span></th></tr>
      ${trips.slice(0, 40).map(tripRow).join('') || '<tr><td colspan="8" class="muted">No profitable trips found yet.</td></tr>'}
    </table></div>
    <div class="note">Each timed trip lands a moment after a predicted restock (after its uncertainty has passed, but well before it usually sells out). Expected stock = typical restock size minus what usually sells before you land. Profit includes selling abroad when that's turned on, minus the ticket.</div>

    <h3>Restock rhythm ${focus ? `for ${esc(abroad.get(focus).name)}` : 'by item'}</h3>
    <div class="table-wrap"><table class="data">
      <tr><th>Item</th><th>Country</th><th class="num">Profit each</th><th class="num">Per full load</th><th>Restocks</th><th>Next (TCT)</th><th class="num">Lasts</th><th class="num">Typical size</th><th class="num">Seen</th><th>Confidence</th></tr>
      ${rhythm.slice(0, 60).map(r => {
        const cad = r.st.cadence;
        const next = (r.st.next || []).filter(t => t > now - 60000).slice(0, 2);
        return `<tr><td>${itemLink(r.i.id, esc(r.i.name))}</td><td>${esc(r.c.name)}</td>
          <td class="num ${signClass(r.profit)}">${money(r.profit)}</td><td class="num ${signClass(r.perTrip)}">${money(r.perTrip, true)}</td>
          <td>${cad ? `${cadText(cad)}${cad.kind === 'sellout' && cad.soldOut ? ' <span class="pill bad">sold out</span>' : ''}` : '<span class="muted">learning</span>'}</td>
          <td>${next.length ? next.map(t => `${tct(t)}${cad ? ` ±${Math.ceil(cad.uncertainty / 60000)}m` : ''}`).join(', ') : '–'}</td>
          <td class="num">${r.st.stay ? fmtMin(r.st.stay / 60000) : r.st.staysInStock ? 'until next' : '–'}</td>
          <td class="num">${r.st.size ? num(Math.round(r.st.size)) : '–'}</td>
          <td class="num">${num(r.st.restockCount || 0)}</td>
          <td>${cad ? confPill(cad.confidence) : ''}</td></tr>`;
      }).join('')}
    </table></div>
    <div class="note">Every item in every country has its own restock timer. For most, it starts when the item sells out: it restocks a set time later ("55m after selling out"), so a sold-out item's return can be timed to within a few minutes. Items that rarely sell out are timed from their usual gap between restocks. "Lasts" = how long stock usually stays after a restock before selling out: the window you need to land in.</div>`;
  if (open) drawRestockHist(M, open.split('@')[0]);
}

// Headline for a chosen item: the departure that gets you the most of it, the soonest one
// that gets you any, and what it costs where it's sold.
function focusSummary(M, id, info, trips) {
  const got = t => (t.focusLine ? t.focusLine.qty : 0);
  const withSome = trips.filter(t => got(t) > 0);
  const most = [...withSome].sort((a, b) => got(b) - got(a) || a.leaveAt - b.leaveAt)[0];
  const soonest = [...withSome].sort((a, b) => a.leaveAt - b.leaveAt)[0];
  const places = M.T.countries.map(c => ({ c, i: c.items.find(x => x.id === id) })).filter(p => p.i);
  const cheapestAbroad = places.filter(p => p.i.cost).sort((a, b) => a.i.cost - b.i.cost)[0];
  const sell = M.sellHome(id).price;
  const cap = M.general + (SPECIAL_TYPES.has(itemType(id)) ? M.special : 0);
  const when = t => `${esc(t.country.name)} · leave ${tct(t.leaveAt)}`;
  const sub = t => `${got(t)} of ${cap} slots · lands ${tct(t.landAt)}${t.wait > 60000 ? ` · in ${fmtMin(t.wait / 60000)}` : ' · now'}`;
  return `
    <div class="grid3" style="margin:8px 0">
      <div class="stat"><div class="k">Most ${esc(info.name)}</div><div class="v">${most ? when(most) : '–'}</div><div class="small ${most ? '' : 'muted'}">${most ? sub(most) : 'none expected in stock in the next 6 hours'}</div></div>
      <div class="stat"><div class="k">Soonest with stock</div><div class="v">${soonest ? when(soonest) : '–'}</div><div class="small muted">${soonest ? sub(soonest) : ''}</div></div>
      <div class="stat"><div class="k">Price</div><div class="v">${cheapestAbroad ? `${money(cheapestAbroad.i.cost)} in ${esc(cheapestAbroad.c.name)}` : '–'}</div>
        <div class="small">sells for ${money(sell)} at home · <span class="${signClass(cheapestAbroad ? sell - cheapestAbroad.i.cost : 0)}">${cheapestAbroad ? `${money(sell - cheapestAbroad.i.cost)} each` : ''}</span></div></div>
    </div>
    <div class="note" style="margin-top:0">Sold in ${places.map(p => `${esc(p.c.name)} (${num(p.i.quantity)} in stock now)`).join(', ')}. Trips below are timed to land just after its restocks${places.length > 1 ? ' in each country' : ''}; it goes in the plan first, even if it doesn't sell at a profit at home.</div>`;
}

function riskPill(r) {
  const [cls, label] = RISK[r] || RISK.unknown;
  return `<span class="pill ${cls}">${label}</span>`;
}

// ---- Sortable tables: Leave now, Abroad items, Sell abroad ----
// Click a column heading (again to reverse) or use "Sort by". Each table remembers its own order.
// Columns: [key, label, right-aligned, value (default row[key]), first direction (default: text
// A→Z, numbers high→low)]. Rows without a value always go last.
const RISK_ORDER = { ok: 0, restock: 1, partial: 2, unknown: 3, empty: 4 };
const PLAN_COLS = [
  ['country', 'Destination', 0, t => t.country.name], ['flight', 'Flight', 1, t => t.flight.min, 1],
  ['inbound', 'Bring home', 1, t => t.inbound.total], ['outbound', 'Sell abroad', 1, t => t.outbound.total || null],
  ['ticket', 'Ticket', 1, t => t.ticket, 1], ['profit', 'Trip profit', 1], ['perHour', 'Per hour', 1],
  ['cash', 'Cash needed', 1, t => t.cash, 1], ['risk', 'Stock', 0, t => RISK_ORDER[t.risk] ?? 3, 1],
];
const SELL_COLS = [
  ['name', 'Item', 0], ['country', 'Country', 0], ['shop', 'Shop', 0], ['cost', 'Buy at home', 1, null, 1],
  ['sellAbroad', 'Sells abroad', 1], ['profit', 'Profit each', 1], ['roi', 'ROI', 1], ['load', 'Full load', 1],
];
const TV_DEFAULT = { plan: { k: 'perHour', dir: -1 }, items: { k: 'profit', dir: -1 }, sell: { k: 'profit', dir: -1 } };
const tvCols = (view, M) => (view === 'plan' ? PLAN_COLS.filter(c => c[0] !== 'outbound' || M.ts.outbound) : view === 'items' ? ITEM_COLS : SELL_COLS);
function tvSortState(view, cols) {
  const s = prefs.get(`travel.sort.${view}`, null);
  if (s && cols.some(c => c[0] === s.k) && (s.dir === 1 || s.dir === -1)) return s;
  if (view === 'items') { // the old Abroad items sort
    const f = prefs.get('travel.itemFilter', {});
    if (f.sort && cols.some(c => c[0] === f.sort)) return { k: f.sort, dir: f.dir === 1 ? 1 : -1 };
  }
  return TV_DEFAULT[view];
}
function tvSortRows(rows, cols, s) {
  const col = cols.find(c => c[0] === s.k) || cols[0];
  const get = col[3] || (r => r[col[0]]);
  const blank = v => v === null || v === undefined || (typeof v === 'number' && !Number.isFinite(v));
  return rows.sort((a, b) => {
    const x = get(a), y = get(b);
    if (blank(x) || blank(y)) return blank(x) - blank(y);
    if (typeof x === 'string') return s.dir * x.localeCompare(y);
    return s.dir * (x - y);
  });
}
function tvHeads(view, cols, s) {
  return cols.map(([k, l, n]) => `<th class="${n ? 'num' : ''} ${s.k === k ? 'sorted' : ''}" data-tvsort="${view}:${k}" aria-sort="${s.k === k ? (s.dir > 0 ? 'ascending' : 'descending') : 'none'}" title="Sort by ${esc(l)}">${esc(l)}${s.k === k ? (s.dir > 0 ? ' ▲' : ' ▼') : ''}</th>`).join('');
}
function tvSortBar(view, cols, s) {
  const text = !(cols.find(c => c[0] === s.k) || [])[2] && s.k !== 'risk';
  return `<label>Sort by <select data-tvsortsel="${view}">${cols.map(([k, l]) => `<option value="${k}" ${s.k === k ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></label>
    <button data-tvdir="${view}" title="Reverse the order">${s.dir > 0 ? (text ? '▲ A → Z' : '▲ Lowest first') : (text ? '▼ Z → A' : '▼ Highest first')}</button>`;
}
// From a heading: the same column again reverses it. From the menu: that column's usual direction.
function tvPick(view, k, fromHeading) {
  const cols = tvCols(view, travelModel());
  const col = cols.find(c => c[0] === k);
  if (!col) return;
  const cur = tvSortState(view, cols);
  const dir = fromHeading && cur.k === k ? -cur.dir : (col[4] ?? (col[2] ? -1 : 1));
  prefs.set(`travel.sort.${view}`, { k, dir });
  renderTravel();
}

function renderPlan(body, M) {
  const now = Date.now();
  const trips = M.T.countries.filter(c => c.items.length).map(c => planTrip(M, c, now)).sort((a, b) => b.perHour - a.perHour);
  const open = prefs.get('travel.open', '');
  const best = trips[0]; // by profit per hour, whatever order the table is in
  const cols = tvCols('plan', M);
  const ss = tvSortState('plan', cols);
  tvSortRows(trips, cols, ss);
  body.innerHTML = `
    ${best ? `<div class="grid3" style="margin-bottom:8px">
      <div class="stat"><div class="k">Best trip right now</div><div class="v">${esc(best.country.name)}</div></div>
      <div class="stat"><div class="k">Expected profit</div><div class="v ${signClass(best.profit)}">${money(best.profit, true)}</div></div>
      <div class="stat"><div class="k">Per hour (round trip)</div><div class="v">${money(best.perHour, true)}</div></div>
    </div>` : ''}
    <div class="toolbar">${tvSortBar('plan', cols, ss)}</div>
    <div class="table-wrap"><table class="data">
      <tr>${tvHeads('plan', cols, ss)}<th><span class="sr-only">Planner</span></th></tr>
      ${trips.map(t => `
        <tr class="clickable ${open === t.country.code ? 'selected' : ''}" data-topen="${t.country.code}">
          <td><b>${esc(t.country.name)}</b><div class="muted small">YATA ${t.country.update ? fmtAgo(t.country.update) : 'n/a'}</div></td>
          <td class="num">${fmtMin(t.flight.min)}<div class="muted small">${esc(t.flight.source)}</div></td>
          <td class="num">${money(t.inbound.total, true)}<div class="muted small">${t.inbound.used}/${t.capacity} slots</div></td>
          ${M.ts.outbound ? `<td class="num">${t.outbound.total ? money(t.outbound.total, true) : '–'}</td>` : ''}
          <td class="num">${t.ticket ? money(t.ticket, true) : 'free'}</td>
          <td class="num ${signClass(t.profit)}"><b>${money(t.profit, true)}</b></td>
          <td class="num"><b>${money(t.perHour, true)}</b></td>
          <td class="num">${money(t.cash, true)}</td>
          <td>${riskPill(t.risk)}</td>
          <td>${planButton(t)}</td>
        </tr>
        ${open === t.country.code ? `<tr class="detail"><td colspan="${M.ts.outbound ? 10 : 9}">${tripDetail(M, t)}</td></tr>` : ''}`).join('')}
    </table></div>
    <div class="note">Trip profit = items you bring home (sold at ${M.ts.sellMode === 'live' ? 'the cheapest current listing' : 'market value'}) ${M.ts.outbound ? '+ items you sell abroad ' : ''}− ticket. Per hour uses the round trip (2 × flight). Stock at landing uses YATA's last reading minus the sell rate measured on this PC; it gets more accurate the longer the app runs.</div>`;
  if (open) drawRestockHist(M, open);
}

function tripDetail(M, t) {
  const c = t.country;
  const inLines = t.inbound.lines.map(l => `<tr>
      <td>${itemLink(l.id, esc(l.name))}</td><td class="num">${l.qty}</td><td class="num">${money(l.cost)}</td>
      <td class="num">${money(l.sell)}${l.sellSource !== 'mv' ? ' ' + wherePill(l.sellSource) : ''}</td>
      <td class="num ${signClass(l.profit)}">${money(l.profit)}</td><td class="num">${money(l.profit * l.qty, true)}</td>
      <td class="num">${num(l.quantity)} → ${num(l.pred.q)}<div class="muted small">${esc(l.pred.how)}</div></td></tr>`).join('');
  const outLines = t.outbound.lines.map(l => `<tr>
      <td>${itemLink(l.id, esc(l.name))}</td><td class="num">${l.qty}</td><td class="num">${money(l.cost)}${l.buySource !== 'mv' ? ' ' + wherePill(l.buySource) : ''}</td>
      <td class="num">${money(l.sellAbroad)}<div class="muted small">${esc(l.shop)}</div></td><td class="num ${signClass(l.profit)}">${money(l.profit)}</td><td class="num">${money(l.profit * l.qty, true)}</td></tr>`).join('');
  const deps = restockDepartures(M, c);
  const ids = [...new Set([...c.items.map(i => i.id)])];

  // Every option at this destination, ranked, so you can see why the plan picked what it did.
  const inPlan = new Map(t.inbound.lines.map(l => [l.id, l.qty]));
  const outPlan = new Map(t.outbound.lines.map(l => [l.id, l.qty]));
  const why = (planned, profit, avail) => (planned ? `<b>${planned} in plan</b>` : profit <= 0 ? 'loses money' : avail <= 0 ? 'sold out at landing' : 'slots already filled by better items');
  const allIn = inboundCands(M, c, t.landAt).sort((a, b) => b.profit - a.profit);
  const allOut = outboundCands(M, c).filter(o => o.cost > 0).sort((a, b) => b.profit - a.profit);
  const optionsIn = allIn.map(o => `<tr class="${inPlan.has(o.id) ? 'selected' : o.profit <= 0 || o.avail <= 0 ? 'dim' : ''}">
      <td>${itemLink(o.id, esc(o.name))}<div class="muted small">${esc(itemType(o.id))}</div></td><td class="num">${money(o.cost)}</td><td class="num">${money(o.sell)}</td>
      <td class="num ${signClass(o.profit)}">${money(o.profit)}</td><td class="num ${signClass(o.profit)}">${pct(o.cost ? o.profit / o.cost : null, 0)}</td>
      <td class="num">${num(o.quantity)} → ${num(o.avail)}</td><td>${why(inPlan.get(o.id), o.profit, o.avail)}</td></tr>`).join('');
  const optionsOut = allOut.map(o => `<tr class="${outPlan.has(o.id) ? 'selected' : o.profit <= 0 ? 'dim' : ''}">
      <td>${itemLink(o.id, esc(o.name))}</td><td>${esc(o.shop)}</td><td class="num">${money(o.cost)}${o.buySource !== 'mv' ? ' ' + wherePill(o.buySource) : ''}</td>
      <td class="num">${money(o.sellAbroad)}</td><td class="num ${signClass(o.profit)}">${money(o.profit)}</td><td>${why(outPlan.get(o.id), o.profit, 1)}</td></tr>`).join('');
  const optionsOpen = prefs.get('travel.options', false);
  return `
    <div class="detail-box">
      <div class="row between"><b>Bring home from ${esc(c.name)}</b>
        <span class="row"><button data-tlive="${ids.join(',')}" title="Fetch live item market listings for every item sold here (${ids.length} requests)">Check live prices</button>
        ${link('https://www.torn.com/travelagency.php', 'Travel agency')}</span></div>
      ${inLines ? `<table class="data"><tr><th>Item</th><th class="num">Qty</th><th class="num">Buy</th><th class="num">Sell home</th><th class="num">Each</th><th class="num">Total</th><th class="num">Stock now → landing</th></tr>${inLines}
        <tr class="total"><td>Total</td><td class="num">${t.inbound.used}</td><td class="num">${money(t.inbound.cash, true)}</td><td></td><td></td><td class="num">${money(t.inbound.total, true)}</td><td></td></tr></table>`
        : '<div class="muted">Nothing profitable expected in stock when you land.</div>'}
      ${M.ts.outbound ? `<div style="margin-top:10px"><b>Take out and sell abroad</b></div>
        ${outLines ? `<table class="data"><tr><th>Item</th><th class="num">Qty</th><th class="num">Buy at home</th><th class="num">Sells abroad</th><th class="num">Each</th><th class="num">Total</th></tr>${outLines}</table>
        <div class="note">Home prices marked live are real listings; others use market value, so check live prices before buying.</div>` : '<div class="muted small">No item here sells abroad for more than it costs at home.</div>'}` : ''}
      <div class="note">The plan fills your slots with the most profitable item first, then the next, as far as stock allows. One item filling every slot just means it beats everything else here.</div>
      <div style="margin-top:10px"><a data-toptions>${optionsOpen ? '▾' : '▸'} All ${allIn.length} items in ${esc(c.name)}, ranked</a></div>
      ${optionsOpen ? `
        <div class="chart-title">Bring home (sorted by profit each)</div>
        <table class="data"><tr><th>Item</th><th class="num">Buy</th><th class="num">Sell home</th><th class="num">Each</th><th class="num">ROI</th><th class="num">Stock now → landing</th><th>Plan</th></tr>${optionsIn}</table>
        ${M.ts.outbound ? `<div class="chart-title">Sell abroad (sorted by profit each)</div>
        <table class="data"><tr><th>Item</th><th>Shop</th><th class="num">Buy at home</th><th class="num">Sells abroad</th><th class="num">Each</th><th>Plan</th></tr>${optionsOut}</table>` : ''}` : ''}
      <div style="margin-top:10px"><b>When to leave</b> <span class="muted small">(${M.method}, ${fmtMin(t.flight.min)} each way; ${deps.some(d => d.timed) ? 'timed to restocks learned from YATA' : `no restocks learned yet, so assuming every ${M.ts.restockInterval} min${M.ts.restockOffset ? ` +${M.ts.restockOffset}` : ''}`}; all times TCT)</span></div>
      <table class="data"><tr><th>Leave</th><th>Land</th><th class="num">Bring home</th><th class="num">Trip profit</th><th>Stock</th><th><span class="sr-only">Planner</span></th></tr>
        <tr><td>Now (${tct(t.leaveAt)})</td><td>${tct(t.landAt)}</td><td class="num">${money(t.inbound.total, true)}</td><td class="num ${signClass(t.profit)}">${money(t.profit, true)}</td><td>${riskPill(t.risk)}</td><td>${planButton(t, t.focus || t.target, t.timed ? t.restockAt : 0)}</td></tr>
        ${deps.map(d => `<tr><td>${tct(d.leaveAt)} <span class="muted small">in ${fmtMin((d.leaveAt - Date.now()) / 60000)}</span></td><td>${tct(d.landAt)}</td><td class="num">${money(d.inbound.total, true)}</td><td class="num ${signClass(d.profit)}">${money(d.profit, true)}</td><td>${riskPill(d.risk)}</td><td>${planButton(d, d.target, d.timed ? d.restockAt : 0)}</td></tr>`).join('')}
      </table>
      ${restockHistoryShell(M, c, t)}
    </div>`;
}

// ---- Abroad items table ----
const ITEM_COLS = [
  ['country', 'Country'], ['name', 'Item'], ['cost', 'Cost', 1, null, 1], ['sell', 'Sells home', 1], ['profit', 'Profit', 1], ['roi', 'ROI', 1],
  ['quantity', 'Stock', 1], ['rate', 'Sold/hr', 1], ['outIn', 'Sells out in', 1, null, 1], ['landing', 'At landing', 1], ['d7', 'MV 7d', 1],
];

function renderItems(body, M) {
  const now = Date.now();
  const f = prefs.get('travel.itemFilter', { country: '', type: '', q: '', instock: false, sort: 'profit', dir: -1 });
  const rows = [];
  for (const c of M.T.countries) {
    const fl = M.flight(c);
    for (const i of c.items) {
      if (!i.cost) continue;
      const sell = M.sellHome(i.id);
      const pred = predictStock(c, i, now + fl.min * 60000);
      const rate = i.stats && i.stats.rate ? i.stats.rate * 60 : null;
      rows.push({
        c, i, country: c.name, name: i.name, type: itemType(i.id), cost: i.cost, sell: sell.price, sellSource: sell.source,
        profit: sell.price - i.cost, roi: i.cost ? (sell.price - i.cost) / i.cost : null, quantity: i.quantity, rate,
        outIn: i.quantity > 0 && rate ? (i.quantity / rate) * 60 - (now - c.update) / 60000 : null,
        landing: pred.q, pred, d7: trendCache.data[i.id] ? trendCache.data[i.id].d7 : null,
      });
    }
  }
  const types = [...new Set(rows.map(r => r.type).filter(Boolean))].sort();
  let shown = rows.filter(r => (!f.country || r.c.code === f.country) && (!f.type || r.type === f.type) && (!f.q || r.name.toLowerCase().includes(f.q.toLowerCase())) && (!f.instock || r.quantity > 0));
  const ss = tvSortState('items', ITEM_COLS);
  tvSortRows(shown, ITEM_COLS, ss);
  const open = prefs.get('travel.itemOpen', '');

  body.innerHTML = `
    <div class="toolbar">
      <select data-tfilter="country"><option value="">All countries</option>${M.T.countriesMeta.map(c => `<option value="${c.code}" ${f.country === c.code ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select>
      <select data-tfilter="type"><option value="">All types</option>${types.map(t => `<option ${f.type === t ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select>
      <input data-tfilter="q" placeholder="Search items" value="${esc(f.q)}" style="width:130px">
      <label class="row"><input type="checkbox" data-tfilter="instock" ${f.instock ? 'checked' : ''}> In stock</label>
      <span class="muted small">${shown.length} items</span>
      <span class="spacer"></span>
      ${tvSortBar('items', ITEM_COLS, ss)}
    </div>
    <div class="table-wrap"><table class="data sortable">
      <tr>${tvHeads('items', ITEM_COLS, ss)}</tr>
      ${shown.map(r => {
        const key = `${r.c.code}:${r.i.id}`;
        return `<tr class="clickable ${r.quantity ? '' : 'dim'} ${open === key ? 'selected' : ''}" data-titem="${key}">
          <td>${esc(r.country)}</td><td>${itemLink(r.i.id, esc(r.name))}<div class="muted small">${esc(r.type)}</div></td>
          <td class="num">${money(r.cost)}</td><td class="num">${money(r.sell)}${r.sellSource !== 'mv' ? '<div>' + wherePill(r.sellSource) + '</div>' : ''}</td>
          <td class="num ${signClass(r.profit)}">${money(r.profit)}</td><td class="num ${signClass(r.roi)}">${pct(r.roi, 0)}</td>
          <td class="num">${num(r.quantity)}</td><td class="num">${r.rate === null ? '–' : num(Math.round(r.rate))}</td>
          <td class="num">${r.outIn === null ? '–' : r.outIn <= 0 ? 'now' : fmtMin(r.outIn)}</td>
          <td class="num">${num(r.landing)}<div class="muted small">${esc(r.pred.how)}</div></td>
          <td class="num ${signClass(r.d7)}">${pct(r.d7)}</td></tr>
          ${open === key ? `<tr class="detail"><td colspan="${ITEM_COLS.length}">${itemDetailShell(r)}</td></tr>` : ''}`;
      }).join('')}
    </table></div>
    <div class="note">Sold/hr and restock data are measured on this PC from YATA readings (last 48h). "MV 7d" is the change in Torn's market value over 7 days, recorded by this app.</div>`;
  if (open) fillItemDetail(M, open);
  refreshTrends(rows.map(r => r.i.id));
}

function itemDetailShell(r) {
  const st = r.i.stats || {};
  const restocks = (st.restocks || []).slice(-6).reverse();
  return `<div class="detail-box">
    <div class="row between"><b>${esc(r.name)} in ${esc(r.country)}</b>
      <span class="row"><button data-tlive="${r.i.id}">Check live price</button><button data-twatch="${r.i.id}">Watch price</button>${link(marketUrl(r.i.id), 'Item market')}</span></div>
    ${restockAlerts(`${r.c.code}:${r.i.id}`, `${r.name} in ${r.country}`)}
    <div class="grid4" style="margin:8px 0">
      <div class="stat"><div class="k">Restocks</div><div class="v">${st.cadence ? cadText(st.cadence) : st.zeroSince ? 'sold out' : '–'}</div><div class="small muted">${st.cadence ? st.cadence.confidence : st.zeroSince ? `since ${tct(st.lastPositive ? (st.lastPositive + st.zeroSince) / 2 : st.zeroSince)}${st.selloutDelay ? `, usually back ${fmtMin(st.selloutDelay.delay / 60000)} after selling out` : ''}` : 'learning'}</div></div>
      <div class="stat"><div class="k">Next restock (TCT)</div><div class="v">${(st.next || []).find(t => t > Date.now() - 60000) ? tct(st.next.find(t => t > Date.now() - 60000)) : '–'}</div><div class="small muted">${st.cadence ? `±${Math.ceil(st.cadence.uncertainty / 60000)} min` : ''}</div></div>
      <div class="stat"><div class="k">Typical restock</div><div class="v">${st.size ? num(Math.round(st.size)) : '–'}</div></div>
      <div class="stat"><div class="k">Lasts after restock</div><div class="v">${st.stay ? fmtMin(st.stay / 60000) : st.staysInStock ? 'until next' : '–'}</div></div>
      <div class="stat"><div class="k">Then empty for</div><div class="v">${st.emptyFor ? fmtMin(st.emptyFor / 60000) : '–'}</div></div>
      <div class="stat"><div class="k">Restocks seen</div><div class="v">${num(st.restockCount || 0)}</div></div>
    </div>
    <div class="chart-title">${esc(r.name)} stock in ${esc(r.country)} <span class="muted small">(${(() => { const h = r.c.since ? (Date.now() - r.c.since) / 3600e3 : 0; return h >= 48 ? `${(h / 24).toFixed(1)} days` : `${h.toFixed(1)} h`; })()} of readings; up to 4 days are kept)</span></div><div id="titem-stock" data-for="${r.c.code}:${r.i.id}"></div>
    <div class="chart-title">Price at home</div><div id="titem-price"></div>
    ${restocks.length ? `<div class="chart-title">Recent restocks (TCT)</div><table class="data"><tr><th>Between</th><th class="num">Before</th><th class="num">After</th></tr>
      ${restocks.map(x => `<tr><td>${tct(x.from)}–${tct(x.to)}</td><td class="num">${num(x.before)}</td><td class="num">${num(x.after)}</td></tr>`).join('')}</table>` : ''}
  </div>`;
}

async function fillItemDetail(M, key) {
  const [code, idStr] = key.split(':');
  const id = Number(idStr);
  const [stock, hist] = await Promise.all([cmd('travel.stockHistory', code, id), cmd('market.history', id)]);
  // The tab may have been redrawn for another item while this loaded: only draw into this item's box.
  const s = $('#titem-stock');
  if (!s || s.dataset.for !== key) return;
  lineChart(s, { series: [{ name: itemName(id).startsWith('Item ') ? 'Stock' : itemName(id), points: stock, step: true }], yZero: true, yFmt: v => num(Math.round(v)), empty: 'No stock readings recorded yet.' });
  const p = $('#titem-price');
  if (p) lineChart(p, { series: [{ name: 'Market value', points: hist.mv }, { name: 'Lowest listing', points: hist.low }], yFmt: v => money(v, true), tipFmt: v => money(v), empty: 'No price history yet. It builds up as the app runs.' });
}

async function refreshTrends(ids) {
  if (Date.now() - trendCache.at < 10 * 60 * 1000) return;
  trendCache.at = Date.now();
  trendCache.data = await cmd('market.trends', [...new Set(ids)]);
  if (navView('travel') === 'items') renderTravel();
}

// ---- Sell abroad ----
function renderSell(body, M) {
  const rows = [];
  for (const c of M.T.countries) {
    for (const r of outboundCands(M, c)) {
      if (r.cost > 0) rows.push({ ...r, country: c.name, roi: r.profit / r.cost, load: Math.max(0, r.profit) * M.general });
    }
  }
  rows.sort((a, b) => b.profit - a.profit);
  const top = rows.slice(0, 60);
  const ss = tvSortState('sell', SELL_COLS);
  tvSortRows(top, SELL_COLS, ss);
  const unchecked = rows.filter(r => r.buySource !== 'market').slice(0, 25).map(r => r.id);
  body.innerHTML = `
    <div class="note" style="margin-top:0">Foreign shops buy back what they sell: the Black Market pays its current price, other shops pay 75% of theirs. These are the items that sell abroad for more than they cost at home. Suitcases are left out: they can't be sold abroad.</div>
    <div class="toolbar"><button data-tlive="${unchecked.join(',')}" ${unchecked.length ? '' : 'disabled'}>Check live home prices (${unchecked.length})</button>
      <span class="muted small">${rows.length > top.length ? `the ${top.length} most profitable of ${rows.length}` : `${rows.length} items`}</span>
      <span class="spacer"></span>${tvSortBar('sell', SELL_COLS, ss)}</div>
    <div class="table-wrap"><table class="data sortable">
      <tr>${tvHeads('sell', SELL_COLS, ss)}</tr>
      ${top.map(r => `<tr class="${r.profit > 0 ? '' : 'dim'}"><td>${itemLink(r.id, esc(r.name))}</td><td>${esc(r.country)}</td><td>${esc(r.shop)}</td>
        <td class="num">${money(r.cost)}${r.buySource !== 'mv' ? ' ' + wherePill(r.buySource) : '<div class="muted small">market value</div>'}</td>
        <td class="num">${money(r.sellAbroad)}</td><td class="num ${signClass(r.profit)}">${money(r.profit)}</td>
        <td class="num ${signClass(r.profit)}">${pct(r.roi, 0)}</td><td class="num">${money(r.load, true)}</td></tr>`).join('')}
    </table></div>`;
}

// ---- Flights & settings ----
function renderFlights(body, M) {
  const T = M.T;
  const cap = T.capacityApi;
  body.innerHTML = `
    <h3>Flight times (minutes, one way)</h3>
    <div class="table-wrap"><table class="data">
      <tr><th>Destination</th>${T.methods.map(m => `<th class="num ${m === M.method ? 'sorted' : ''}">${m === 'Private' ? 'WLT' : m}</th>`).join('')}<th class="num">Your ${M.method === 'Private' ? 'WLT' : M.method} override</th><th class="num">Ticket</th></tr>
      ${T.countriesMeta.map(c => `<tr><td>${esc(c.name)}</td>
        ${T.methods.map((m, i) => {
          const learned = T.learned[`${c.code}|${m}`];
          return `<td class="num">${learned ? `<b title="Measured from your flights">${learned}</b>` : c.times[i]}</td>`;
        }).join('')}
        <td class="num"><input type="number" min="0" max="600" step="0.1" style="width:64px" data-set="travel.override.${c.code}|${M.method}" data-num placeholder="${M.flight(c).min.toFixed(0)}"></td>
        <td class="num">${M.ticket(c) ? money(M.ticket(c)) : 'free'}</td></tr>`).join('')}
    </table></div>
    <div class="note">Defaults from the Torn wiki; flights vary by up to 3%. <b>Bold</b> = measured from your own flights (used automatically). An override beats both; set 0 to clear.
      <a data-cmd="travel.learned.clear">Forget measured times</a></div>

    <h3>Trip costs and options</h3>
    <div class="setting"><label>Read "Mailing Yourself Abroad" (−25% flight time, applied to wiki times)</label><input type="checkbox" data-set="travel.book"></div>
    <div class="setting"><label>Include selling items abroad in trip profit</label><input type="checkbox" data-set="travel.outbound"></div>
    <div class="setting"><label>Selling fee / trader discount at home (%)</label><input type="number" min="0" max="50" step="0.5" style="width:70px" data-set="travel.feePct" data-num></div>
    <div class="note">Airstrip and WLT flights are free. Standard uses the wiki ticket price. Business Class uses one Business Class Ticket at its market value.</div>

    <h3>Carry capacity</h3>
    <div class="setting"><label>Items you can carry (0 = automatic)</label><input type="number" min="0" max="500" style="width:70px" data-set="travel.capacity" data-num></div>
    <div class="note">${cap && cap.denied ? 'Your key can\'t read travel capacity (needs a Limited key), so the default for your method is used.' : cap && cap.base ? `From your API key: ${cap.base} items + ${cap.special} special (treated as flower/plushie slots). <a data-cmd="travel.capacity.refresh">Re-check</a>` : 'Checking your capacity…'}
      Using ${M.general}${M.special ? ` + ${M.special}` : ''} (${M.capSource}).</div>

    <h3>Restocks</h3>
    <div class="setting"><label>Assume restocks every (minutes)</label><input type="number" min="5" max="240" style="width:70px" data-set="travel.restockInterval" data-num></div>
    <div class="setting"><label>Restock offset (minutes past the slot)</label><input type="number" min="0" max="239" style="width:70px" data-set="travel.restockOffset" data-num></div>
    <div class="note">Used for "When to leave". Check the restock chart in the Trip planner (it shows when restocks were actually seen) and adjust these to match.</div>

    <h3>Data source</h3>
    <div class="setting"><label>Get abroad stock from YATA (every 5 min, no key sent)</label><input type="checkbox" data-set="travel.yata"></div>`;
}

// ---- Events ----
function initTravel() {
  const el = panel('travel');
  el.addEventListener('click', e => {
    // Item names and Torn links inside a clickable row shouldn't also open/close the row.
    if (e.target.closest('[data-item],[data-open]')) return;
    const s = e.target.closest('[data-tsub]');
    if (s) { prefs.set('travel.sub', s.dataset.tsub); renderTravel(); return; }
    const pa = e.target.closest('[data-tplan]');
    if (pa) { e.stopPropagation(); if (!pa.disabled) addTripToPlan(pa); return; }
    if (e.target.closest('[data-tplanopen]')) { e.stopPropagation(); showPanel('planner'); return; }
    const live = e.target.closest('[data-tlive]');
    if (live) { e.stopPropagation(); cmd('market.live', live.dataset.tlive.split(',').map(Number)); live.disabled = true; live.textContent = 'Checking…'; return; }
    const w = e.target.closest('[data-twatch]');
    if (w) { e.stopPropagation(); cmd('market.watch.add', Number(w.dataset.twatch), 0); w.disabled = true; w.textContent = 'Watching'; return; }
    if (e.target.closest('[data-toptions]')) { prefs.set('travel.options', !prefs.get('travel.options', false)); renderTravel(); return; }
    const hs = e.target.closest('[data-tvsort]');
    if (hs) { const [v, k] = hs.dataset.tvsort.split(':'); tvPick(v, k, true); return; }
    const rv = e.target.closest('[data-tvdir]');
    if (rv) {
      const v = rv.dataset.tvdir;
      const s = tvSortState(v, tvCols(v, travelModel()));
      prefs.set(`travel.sort.${v}`, { k: s.k, dir: -s.dir });
      renderTravel();
      return;
    }
    if (e.target.closest('a, button, input, select')) return;
    const tt = e.target.closest('[data-ttimed]');
    if (tt) { prefs.set('travel.timedOpen', prefs.get('travel.timedOpen', '') === tt.dataset.ttimed ? '' : tt.dataset.ttimed); renderTravel(); return; }
    const o = e.target.closest('[data-topen]');
    if (o) { prefs.set('travel.open', prefs.get('travel.open', '') === o.dataset.topen ? '' : o.dataset.topen); renderTravel(); return; }
    const it = e.target.closest('[data-titem]');
    if (it) { prefs.set('travel.itemOpen', prefs.get('travel.itemOpen', '') === it.dataset.titem ? '' : it.dataset.titem); renderTravel(); }
  });
  const onFilter = e => {
    const t = e.target.closest('[data-tfilter]');
    if (!t) return;
    const f = prefs.get('travel.itemFilter', { country: '', type: '', q: '', instock: false, sort: 'profit', dir: -1 });
    f[t.dataset.tfilter] = t.type === 'checkbox' ? t.checked : t.value;
    prefs.set('travel.itemFilter', f);
    if (e.type === 'change' || t.type !== 'text') renderTravel();
  };
  el.addEventListener('change', onFilter); // text inputs fire change on Enter or blur
  el.addEventListener('change', e => {
    const t = e.target.closest('[data-tvsortsel]');
    if (t) tvPick(t.dataset.tvsortsel, t.value, false);
  });
  el.addEventListener('change', e => {
    const h = e.target.closest('[data-thist]');
    if (h) { prefs.set(`travel.histItem.${h.dataset.thist}`, Number(h.value)); drawRestockHist(travelModel(), h.dataset.thist); }
  });
  el.addEventListener('change', e => {
    const t = e.target.closest('[data-tpref]');
    if (t) { prefs.set(`travel.${t.dataset.tpref}`, t.type === 'checkbox' ? t.checked : t.value); renderTravel(); }
  });
}
