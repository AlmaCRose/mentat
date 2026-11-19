'use strict';
/* global S, $, panel, esc, num, cmd, money, pct, signClass, fmtAgo, ago, link, marketUrl, prefs,
   CATALOG, loadCatalog, itemName, itemMV, itemType, lineChart, CHART_COLORS, BAZAAR, priceSource, SOURCE_LABEL,
   bazaarUrl, marketLowest, bazaarLowest, cheapest, wherePill, syncSettingInputs, itemLink, renderSafe */
// Market & trading: item lookup with live listings and price history, a watchlist with
// price alerts, a category deal scanner, a trade calculator and the points market.

const histCache = new Map(); // id -> { at, data }
async function getHistory(id) {
  const c = histCache.get(id);
  if (c && Date.now() - c.at < 120000) return c.data;
  const data = await cmd('market.history', id);
  histCache.set(id, { at: Date.now(), data });
  return data;
}

function findItem(text) {
  text = String(text || '').trim().toLowerCase();
  if (!text) return 0;
  if (/^\d+$/.test(text) && CATALOG.items[text]) return Number(text);
  if (CATALOG.byName[text]) return CATALOG.byName[text];
  const hit = Object.entries(CATALOG.byName).find(([n]) => n.includes(text));
  return hit ? hit[1] : 0;
}

function itemDatalist() {
  if ($('#item-names')) return;
  const dl = document.createElement('datalist');
  dl.id = 'item-names';
  for (const it of Object.values(CATALOG.items)) if (it[4]) {
    const o = document.createElement('option');
    o.value = it[0];
    dl.appendChild(o);
  }
  document.body.appendChild(dl);
}

// Listing stats for one item: lowest, spread vs market value, depth near the lowest price.
function listingStats(id) {
  const l = (S.features.market && S.features.market.live[id]) || null;
  const mv = itemMV(id);
  if (!l || !l.listings) return { l, mv };
  const lowest = l.lowest || 0;
  const depth5 = l.listings.filter(x => x.price <= lowest * 1.05).reduce((s, x) => s + x.amount, 0);
  const underMv = l.listings.filter(x => mv && x.price < mv);
  return {
    l, mv, lowest, depth5,
    vsMv: mv && lowest ? lowest / mv - 1 : null,
    underQty: underMv.reduce((s, x) => s + x.amount, 0),
    underGain: underMv.reduce((s, x) => s + (mv - x.price) * x.amount, 0),
  };
}

function renderMarket() {
  const el = panel('market');
  if (!el.classList.contains('active')) return;
  const m = S.features.market;
  if (!S.api.hasKey) { el.innerHTML = '<div class="empty">Add an API key in Settings to load market data.</div>'; return; }
  if (!m || !m.catalogAt) { el.innerHTML = '<div class="empty">Loading the item list from Torn…</div>'; return; }
  loadCatalog().then(() => {
    itemDatalist();
    const sub = navView('market');
    const p = m.points;
    const bz = S.features.bazaar || {};
    el.innerHTML = `
      ${navSubnav('market', 'msub', '', { watch: `Watchlist (${m.watch.length})` })}
      <div class="toolbar">
        <label>Prices from <select data-set="market.priceSource"><option value="both">Market + bazaars</option><option value="market">Item market</option><option value="bazaar">Bazaars</option></select></label>
        <span class="muted small">${!bz.enabled ? 'Bazaar prices are off (Settings).' : bz.error ? `<span class="neg">${esc(bz.error)}</span>` : bz.summaryAt ? `Bazaar prices from Weav3r, ${ago(bz.summaryAt)}` : 'Loading bazaar prices…'}</span>
        ${bz.enabled ? '<a data-cmd="bazaar.refresh">refresh bazaars</a>' : ''}
      </div>
      <div class="grid3" style="margin-bottom:8px">
        <div class="stat"><div class="k">Points (lowest)</div><div class="v">${p && p.lowest ? money(p.lowest) : '…'}</div></div>
        <div class="stat"><div class="k">Cheapest 5 listings</div><div class="v small">${p && p.listings ? p.listings.map(x => `${money(x.cost)}×${num(x.quantity)}`).join(' · ') || '–' : '…'}</div></div>
        <div class="stat"><div class="k">Item list</div><div class="v small">${num(m.catalogCount)} items · ${ago(m.catalogAt)} <a data-cmd="market.points.refresh">refresh points</a></div></div>
      </div>
      <div id="market-body"></div>`;
    const body = $('#market-body');
    if (sub === 'lookup') renderLookup(body);
    else if (sub === 'watch') renderWatch(body);
    else if (sub === 'deals') renderDeals(body);
    else renderTrade(body);
    syncSettingInputs();
  });
}

// ---- Lookup ----
function renderLookup(body) {
  const id = prefs.get('market.item', 0);
  body.innerHTML = `
    <form class="keyrow" data-mform="lookup"><input list="item-names" name="q" placeholder="Item name or ID" value="${id ? esc(itemName(id)) : ''}" spellcheck="false"><button class="primary">Look up</button></form>
    <div id="lookup-out" style="margin-top:8px"></div>`;
  if (!id) { $('#lookup-out').innerHTML = '<div class="empty">Search any tradable item to see its live listings, price history and Torn shop prices.</div>'; return; }
  renderItemDetail($('#lookup-out'), id);
}

// One item's prices side by side: item market listings and bazaar listings (each bazaar
// links to that seller's bazaar), plus value, trends, Torn shops and price history. Used by
// Item lookup and by the item pop-up that opens when you click an item name anywhere.
function renderItemDetail(out, id) {
  const it = CATALOG.items[id];
  const st = listingStats(id);
  const src = priceSource();
  const m = S.features.market || {};
  const pending = (m.pending || []).includes(id);
  const bz = S.features.bazaar || {};
  const bl = bz.listings && bz.listings[id];
  const bPending = (bz.pending || []).includes(id);
  const bsum = BAZAAR.items[id];
  const best = cheapest(id);
  const shops = (it && it[5]) || [];
  const vs = p => (st.mv && p ? p / st.mv - 1 : null);
  const vsCell = p => `<td class="num ${signClass(-(vs(p) || 0))}">${pct(vs(p))}</td>`;
  const bazaarLow = bl && bl.listings.length ? bl.listings[0].price : bsum && bsum[0] ? bsum[0] : 0;
  out.innerHTML = `
    <div class="row between wrap"><div><b style="font-size:15px">${esc(it ? it[0] : `Item ${id}`)}</b> <span class="muted">${esc(it ? it[1] : '')} · ID ${id}</span></div>
      <span class="row"><button data-mrefresh="${id}" ${pending || bPending ? 'disabled' : ''}>${pending || bPending ? 'Checking…' : 'Refresh prices'}</button><button data-mwatch="${id}">Watch</button><button data-mtrade="${id}">Add to trade</button>${link(marketUrl(id), 'Open item market')}</span></div>
    <div class="grid4" style="margin:8px 0">
      <div class="stat"><div class="k">Market value</div><div class="v">${money(st.mv)}</div></div>
      <div class="stat"><div class="k">Cheapest (${esc(SOURCE_LABEL[src].toLowerCase())})</div><div class="v">${best.price ? money(best.price) : '…'}</div><div class="small">${wherePill(best.where)} <span class="${signClass(-(vs(best.price) || 0))}">${pct(vs(best.price))}</span></div></div>
      <div class="stat"><div class="k">Item market lowest</div><div class="v">${st.lowest ? money(st.lowest) : pending ? '…' : '–'}</div><div class="small muted">${st.l && st.l.average ? `avg sold ${money(st.l.average, true)}` : ''}</div></div>
      <div class="stat"><div class="k">Bazaar lowest</div><div class="v">${bz.enabled ? (bazaarLow ? money(bazaarLow) : bPending ? '…' : '–') : '<span class="muted small">off</span>'}</div><div class="small muted">${bz.enabled && bsum ? `${num(bsum[2])} bazaars · avg ${money(bsum[1], true)}` : ''}</div></div>
      <div class="stat"><div class="k">Market: within 5% of lowest</div><div class="v">${st.l ? num(st.depth5) : '–'}</div></div>
      <div class="stat"><div class="k">Market: listed under value</div><div class="v">${st.l ? num(st.underQty) : '–'}</div></div>
      <div class="stat"><div class="k">In circulation</div><div class="v">${it ? num(it[3]) : '–'}</div></div>
      <div class="stat"><div class="k">Value trend 1d / 7d</div><div class="v" data-trend>…</div></div>
    </div>
    <div class="cols2">
      <div><div class="chart-title">Item market listings</div>
        ${st.l && st.l.listings.length ? `<div class="list-scroll"><table class="data"><tr><th class="num">Price</th><th class="num">Qty</th><th class="num">vs value</th></tr>
          ${st.l.listings.map(x => `<tr><td class="num">${money(x.price)}</td><td class="num">${num(x.amount)}</td>${vsCell(x.price)}</tr>`).join('')}</table></div>
          <div class="note">Checked ${ago(st.l.fetchedAt)} (Torn caches listings for everyone). ${link(marketUrl(id), 'Buy on the item market')}</div>` : `<div class="muted small">${pending ? 'Loading…' : 'No item market listings.'}</div>`}</div>
      <div><div class="chart-title">Bazaar listings</div>
        ${!bz.enabled ? '<div class="muted small">Bazaar prices are off. Turn on "Bazaar prices from Weav3r" in Settings.</div>'
          : bl && bl.listings.length ? `<div class="list-scroll"><table class="data"><tr><th>Bazaar</th><th class="num">Price</th><th class="num">Qty</th><th class="num">vs value</th><th class="num">Seen</th></tr>
          ${bl.listings.map(x => `<tr><td>${link(bazaarUrl(x.player), esc(x.name || `#${x.player}`))}</td><td class="num">${money(x.price)}</td><td class="num">${num(x.quantity)}</td>${vsCell(x.price)}<td class="num muted small">${x.checked ? fmtAgo(x.checked) : '–'}</td></tr>`).join('')}</table></div>
          <div class="note">Cheapest ${bl.listings.length} of ${num(bl.total)} bazaars (Weav3r, ${ago(bl.fetchedAt)}). Click a name to open their bazaar in a new Torn tab; contents change fast.</div>`
          : `<div class="muted small">${bPending ? 'Loading…' : bl && bl.error ? esc(bl.error) : 'No bazaars are listing it.'}</div>`}</div>
    </div>
    ${shops.length ? `<div class="chart-title">Torn shops</div><table class="data"><tr><th>Where</th><th class="num">Buy</th><th class="num">Sell to shop</th></tr>
      ${shops.map(s => `<tr><td>${esc(s[1])}, ${esc(s[0])}</td><td class="num">${s[2] ? money(s[2]) : '–'}</td><td class="num">${s[3] ? money(s[3]) : '–'}</td></tr>`).join('')}</table>` : ''}
    <div class="chart-title">Price history</div><div data-chart></div>`;
  if (!st.l && !pending) cmd('market.live', [id]);
  if (bz.enabled && !bl && !bPending) cmd('bazaar.listings', [id]);
  getHistory(id).then(h => {
    const c = out.querySelector('[data-chart]');
    const series = [
      { name: 'Market value', points: h.mv },
      { name: 'Item market lowest', points: h.low, color: CHART_COLORS[1] },
    ];
    if (bz.enabled) series.push({ name: 'Bazaar lowest', points: h.baz || [], color: CHART_COLORS[2] });
    if (c) lineChart(c, { series, yFmt: v => money(v, true), tipFmt: v => money(v), empty: 'No history yet. The app records prices every time it fetches them.' });
  });
  cmd('market.trends', [id]).then(t => {
    const e = out.querySelector('[data-trend]');
    if (e) e.innerHTML = t[id] ? `<span class="${signClass(t[id].d1)}">${pct(t[id].d1)}</span> / <span class="${signClass(t[id].d7)}">${pct(t[id].d7)}</span>` : '<span class="muted small">building…</span>';
  });
}

// ---- Item pop-up ----
// Opens over whatever panel you are on, so you keep your place in the planner or deal list.
let modalItem = 0;
let modalSig = '';
function itemModalSig(id) {
  const l = S.features.market && S.features.market.live[id];
  const bz = S.features.bazaar || {};
  const b = bz.listings && bz.listings[id];
  return [l && l.fetchedAt, (S.features.market.pending || []).includes(id), b && b.fetchedAt, (bz.pending || []).includes(id), bz.enabled, priceSource()].join('|');
}
async function openItem(id) {
  id = Number(id);
  if (!id) return;
  await loadCatalog();
  modalItem = id;
  modalSig = '';
  $('#item-modal').hidden = false;
  renderItemModal(true);
  $('#item-modal .modal-card').scrollTop = 0;
}
function closeItem() {
  modalItem = 0;
  $('#item-modal').hidden = true;
  $('#item-modal-body').innerHTML = '';
}
// Redraws only when this item's prices changed, so the chart doesn't flicker on unrelated updates.
function renderItemModal(force = false) {
  if (!modalItem) return;
  const sig = itemModalSig(modalItem);
  if (!force && sig === modalSig) return;
  modalSig = sig;
  renderItemDetail($('#item-modal-body'), modalItem);
}

// Buttons inside an item view (Market tab or pop-up).
function itemButton(t) {
  const d = t.dataset;
  if (d.mrefresh) {
    const id = Number(d.mrefresh);
    const jobs = [cmd('market.live', [id])];
    if ((S.features.bazaar || {}).enabled) jobs.push(cmd('bazaar.listings', [id]));
    t.textContent = 'Checking…';
    t.disabled = true;
    // Prices checked in the last minute or two aren't fetched again (keeps request use low).
    Promise.all(jobs).then(rs => {
      if (rs.some(r => r && r.queued)) return;
      t.textContent = 'Up to date';
      setTimeout(() => { t.textContent = 'Refresh prices'; t.disabled = false; }, 1500);
    }).catch(() => { t.textContent = 'Refresh prices'; t.disabled = false; });
  } else if (d.mwatch) { cmd('market.watch.add', Number(d.mwatch), 0); t.textContent = 'Watching'; t.disabled = true; }
  else if (d.mtrade) { const rows = tradeRows(); const id = Number(d.mtrade); const ex = rows.find(r => r.id === id); if (ex) ex.qty++; else rows.push({ id, qty: 1 }); prefs.set('market.trade', rows); t.textContent = 'Added'; }
  else return false;
  return true;
}
function initItemModal() {
  const m = $('#item-modal');
  m.addEventListener('click', e => {
    if (e.target === m || e.target.closest('[data-item-close]')) return closeItem();
    const t = e.target.closest('[data-mrefresh],[data-mwatch],[data-mtrade]');
    if (t && itemButton(t) && t.dataset.mtrade) renderSafe('market', renderMarket);
  });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && modalItem) closeItem(); });
  document.addEventListener('click', e => {
    const a = e.target.closest('[data-item]');
    if (a) { e.preventDefault(); openItem(a.dataset.item); }
  });
}

// ---- Watchlist ----
function renderWatch(body) {
  const m = S.features.market;
  const src = priceSource();
  const rows = m.watch.map(w => ({ w, st: listingStats(w.id), best: cheapest(w.id), ml: marketLowest(w.id), bl: bazaarLowest(w.id) }));
  body.innerHTML = `
    <div class="toolbar"><label>Check item market every <select data-set="market.watchInterval" data-num>${[60, 120, 300, 600, 1800].map(v => `<option value="${v}">${v < 120 ? '1 min' : `${v / 60} min`}</option>`).join('')}</select></label>
      <span class="muted small">Alerts compare your target with the cheapest price from <b>${esc(SOURCE_LABEL[src].toLowerCase())}</b>. Item market checks use one Torn request per item; bazaar prices come from Weav3r every 10 min (no Torn requests).</span></div>
    ${rows.length ? `<div class="table-wrap"><table class="data">
      <tr><th>Item</th><th class="num">Cheapest</th><th class="num">Item market</th><th class="num">Bazaar</th><th class="num">Value</th><th class="num">vs value</th><th class="num">24h low / high</th><th class="num">Alert at or below</th><th></th></tr>
      ${rows.map(({ w, st, best, ml, bl }) => `<tr>
        <td>${itemLink(w.id, esc(itemName(w.id)))}</td>
        <td class="num ${w.below && best.price && best.price <= w.below ? 'pos' : ''}"><b>${best.price ? money(best.price) : '…'}</b> ${wherePill(best.where)}</td>
        <td class="num">${ml ? money(ml.price) : '–'}<div class="muted small">${ml ? fmtAgo(ml.at) : ''}</div></td>
        <td class="num">${bl ? money(bl.price) : '–'}<div class="muted small">${bl ? fmtAgo(bl.at) : ''}</div></td>
        <td class="num">${money(st.mv)}</td><td class="num ${signClass(-((best.price && st.mv ? best.price / st.mv - 1 : 0)))}">${best.price && st.mv ? pct(best.price / st.mv - 1) : '–'}</td>
        <td class="num" data-range="${w.id}">…</td>
        <td class="num"><input type="number" min="0" step="1" style="width:110px" value="${w.below || ''}" placeholder="no alert" data-mbelow="${w.id}"></td>
        <td><button class="danger" data-mremove="${w.id}" title="Stop watching">&times;</button></td></tr>`).join('')}
    </table></div>` : '<div class="empty">Nothing watched yet. Look up an item and press Watch.</div>'}`;
  for (const { w } of rows) {
    getHistory(w.id).then(h => {
      const e = $(`[data-range="${w.id}"]`);
      if (!e) return;
      const pts = [...(src !== 'bazaar' ? h.low : []), ...(src !== 'market' ? h.baz || [] : [])];
      const day = pts.filter(p => Date.now() - p[0] < 86400000).map(p => p[1]);
      e.textContent = day.length ? `${money(Math.min(...day), true)} / ${money(Math.max(...day), true)}` : '–';
    });
  }
}

// ---- Deal finder ----
function renderDeals(body) {
  const m = S.features.market;
  const types = {};
  for (const it of Object.values(CATALOG.items)) if (it[4] && it[2] > 0) types[it[1]] = (types[it[1]] || 0) + 1;
  const scan = m.scan;
  const minDisc = prefs.get('market.minDiscount', 5);
  const minValue = prefs.get('market.scanMin', 0);
  const sortBy = prefs.get('market.dealSort', 'disc');
  const sel = prefs.get('market.scanType', scan ? scan.type : '*');
  const typeLabel = t => (t === '*' ? 'All categories' : t);
  // Requests the scan can realistically use: most of the per-minute budget, not all of it.
  const perMin = Math.max(5, Math.round((S.api.maxPerMinute || 40) * 0.8));

  // How many items a scan would cover with the current choices (shown before starting).
  const count = Object.values(CATALOG.items).filter(it => it[4] && it[2] > 0 && it[2] >= minValue && (sel === '*' || it[1] === sel)).length;

  const src = priceSource();
  const bz = S.features.bazaar || {};
  const useMarket = src !== 'bazaar';
  const useBazaar = src !== 'market' && bz.enabled && !!BAZAAR.fetchedAt;
  const inScope = id => {
    const it = CATALOG.items[id];
    return it && it[4] && it[2] > 0 && it[2] >= minValue && (sel === '*' || it[1] === sel);
  };

  // Candidates: every in-scope item with a bazaar price (instant), plus scanned items.
  const ids = new Set();
  if (useBazaar) for (const id of Object.keys(BAZAAR.items)) if (inScope(id)) ids.add(Number(id));
  if (useMarket && scan) for (const id of scan.ids) ids.add(id);
  const rows = [];
  for (const id of ids) {
    const mv = itemMV(id);
    const ml = useMarket ? marketLowest(id) : null;
    const bl = useBazaar ? bazaarLowest(id) : null;
    const best = ml && (!bl || ml.price <= bl.price) ? { ...ml, where: 'market' } : bl ? { ...bl, where: 'bazaar' } : null;
    if (!best || !mv) continue;
    // Quantity and total gain are known from item market listings, or from bazaar listings
    // once they're loaded for that item; otherwise only the gain on one unit is known.
    let underQty = null, underGain = null;
    const st = listingStats(id);
    const bzl = bz.listings && bz.listings[id];
    if (best.where === 'market' && st.l) { underQty = st.underQty; underGain = st.underGain; }
    else if (best.where === 'bazaar' && bzl && bzl.listings.length) {
      const u = bzl.listings.filter(x => x.price < mv);
      underQty = u.reduce((s, x) => s + x.quantity, 0);
      underGain = u.reduce((s, x) => s + (mv - x.price) * x.quantity, 0);
    }
    rows.push({ id, mv, ml, bl, best, disc: 1 - best.price / mv, underQty, underGain, perUnit: mv - best.price, bazaars: BAZAAR.items[id] ? BAZAAR.items[id][2] : 0 });
  }
  const gainOf = r => (r.underGain !== null ? r.underGain : r.perUnit);
  rows.sort(sortBy === 'gain' ? (a, b) => gainOf(b) - gainOf(a) : (a, b) => b.disc - a.disc);
  const shown = rows.filter(r => r.disc * 100 >= minDisc);
  const all = sel === '*';
  const knownGain = shown.reduce((s, r) => s + (r.underGain || 0), 0);
  const byType = {};
  for (const r of shown) { const t = itemType(r.id); byType[t] = (byType[t] || 0) + 1; }
  const byWhere = { market: shown.filter(r => r.best.where === 'market').length, bazaar: shown.filter(r => r.best.where === 'bazaar').length };
  const done = scan ? scan.ids.length - scan.left : 0;
  const needDetail = shown.filter(r => r.best.where === 'bazaar' && r.underGain === null).slice(0, 6).map(r => r.id);

  body.innerHTML = `
    <div class="toolbar">
      <select data-mpref="scanType">
        <option value="*" ${sel === '*' ? 'selected' : ''}>All categories (${Object.values(types).reduce((a, b) => a + b, 0)})</option>
        ${Object.keys(types).sort().map(t => `<option value="${esc(t)}" ${t === sel ? 'selected' : ''}>${esc(t)} (${types[t]})</option>`).join('')}
      </select>
      <label title="Skip items worth less than this">Items worth at least $<input type="number" min="0" step="1000" style="width:100px" value="${minValue}" data-mpref="scanMin"></label>
      ${useMarket ? (scan && scan.left ? '<button data-mscan="stop">Stop item market scan</button>' : `<button class="primary" data-mscan="start">Scan item market (${count} items)</button><span class="muted small">≈ ${Math.max(1, Math.ceil(count / perMin))} min at ~${perMin} requests/min</span>`) : ''}
    </div>
    <div class="toolbar">
      <label>Show discounts of at least <input type="number" min="0" max="100" style="width:60px" value="${minDisc}" data-mpref="minDiscount">%</label>
      <label>Sort by <select data-mpref="dealSort"><option value="disc" ${sortBy === 'disc' ? 'selected' : ''}>Discount %</option><option value="gain" ${sortBy === 'gain' ? 'selected' : ''}>Gain $</option></select></label>
      ${needDetail.length ? `<button data-mbzload="${needDetail.join(',')}" title="Load bazaar listings for the top deals to get their quantity and total gain">Load bazaar details (${needDetail.length})</button>` : ''}
    </div>
    <div class="note" style="margin-top:0">${useBazaar ? `Bazaars: ${num(Object.keys(BAZAAR.items).length)} items priced instantly (Weav3r, ${fmtAgo(BAZAAR.fetchedAt)}).` : src !== 'market' ? 'Bazaar prices are loading or turned off.' : ''}
      ${useMarket ? (scan ? ` Item market: ${num(done)} / ${num(scan.ids.length)} ${esc(typeLabel(scan.type))} checked${scan.left ? `, ~${Math.ceil(scan.left / perMin)} min left` : ''}.` : ' Item market: not scanned yet (uses Torn requests).') : ''}</div>
    <div class="grid4" style="margin-bottom:8px">
      <div class="stat"><div class="k">Deals found</div><div class="v">${num(shown.length)}</div><div class="small muted">${src === 'both' ? `${byWhere.bazaar} bazaar · ${byWhere.market} market` : ''}</div></div>
      <div class="stat"><div class="k">Known total gain</div><div class="v pos">${money(knownGain, true)}</div><div class="small muted">where quantities are known</div></div>
      <div class="stat"><div class="k">Best discount</div><div class="v">${shown[0] ? `${(Math.max(...shown.map(r => r.disc)) * 100).toFixed(1)}% off` : '–'}</div></div>
      <div class="stat"><div class="k">Prices from</div><div class="v small">${esc(SOURCE_LABEL[src])}</div></div>
    </div>
    ${all && shown.length ? `<div class="note" style="margin-top:0">Deals by category: ${Object.entries(byType).sort((a, b) => b[1] - a[1]).slice(0, 14).map(([t, n]) => `${esc(t)} ${n}`).join(' · ')}</div>` : ''}
    ${ids.size ? `<div class="table-wrap"><table class="data">
      <tr><th>Item</th>${all ? '<th>Type</th>' : ''}<th class="num">Cheapest</th><th class="num">Value</th><th class="num">Discount</th>${src === 'both' ? '<th class="num">Item market</th><th class="num">Bazaar</th>' : ''}<th class="num">Qty under value</th><th class="num">Gain</th><th class="num">Checked</th><th></th></tr>
      ${shown.slice(0, 300).map(r => `<tr><td>${itemLink(r.id, esc(itemName(r.id)))}</td>${all ? `<td class="muted">${esc(itemType(r.id))}</td>` : ''}
        <td class="num"><b>${money(r.best.price)}</b> ${wherePill(r.best.where)}</td><td class="num">${money(r.mv)}</td>
        <td class="num pos"><b>${(r.disc * 100).toFixed(1)}% off</b></td>
        ${src === 'both' ? `<td class="num">${r.ml ? money(r.ml.price) : '–'}</td><td class="num">${r.bl ? money(r.bl.price) : '–'}${r.bazaars ? `<div class="muted small">${r.bazaars} bazaars</div>` : ''}</td>` : ''}
        <td class="num">${r.underQty !== null ? num(r.underQty) : '–'}</td>
        <td class="num">${r.underGain !== null ? money(r.underGain, true) : `${money(r.perUnit, true)}<div class="muted small">per unit</div>`}</td>
        <td class="num muted small">${fmtAgo(r.best.at)}</td>
        <td>${r.best.where === 'bazaar' && r.best.player ? link(bazaarUrl(r.best.player), 'Bazaar') : link(marketUrl(r.id), 'Market')}</td></tr>`).join('') || `<tr><td colspan="12" class="muted">No prices at ≥ ${minDisc}% under value${scan && scan.left ? ' yet' : ''}.</td></tr>`}
    </table></div>
    <div class="note">"Gain" = (market value − price) × quantity for every listing under value; "per unit" when only the cheapest price is known (load bazaar details for the full picture). Market value is Torn's estimate, so check recent sales before buying. Bazaar prices come from Weav3r and can be minutes old; a cheap bazaar may already be sold out or closed.</div>`
    : `<div class="empty">${src === 'market' ? 'Scan the item market to find listings priced under market value. Each item uses one Torn API request.' : 'Waiting for bazaar prices from Weav3r…'}</div>`}`;
}

// ---- Trade calculator ----
function tradeRows() {
  return prefs.get('market.trade', []);
}
function renderTrade(body) {
  const rows = tradeRows();
  const payout = (S.settings.market && S.settings.market.payoutPct) || 95;
  let mvTotal = 0, lowTotal = 0, lowKnown = true;
  const lines = rows.map(r => {
    const st = listingStats(r.id);
    const best = cheapest(r.id);
    const mvT = st.mv * r.qty;
    mvTotal += mvT;
    if (best.price) lowTotal += best.price * r.qty;
    else lowKnown = false;
    return { ...r, st, best, mvT };
  });
  const pay = mvTotal * payout / 100;
  body.innerHTML = `
    <form class="keyrow" data-mform="trade"><input list="item-names" name="q" placeholder="Item" spellcheck="false"><input name="qty" type="number" min="1" value="1" style="flex:0 0 70px" title="Quantity"><button class="primary">Add</button></form>
    <div class="toolbar"><label>Pay <input type="number" min="1" max="150" step="0.5" style="width:64px" data-set="market.payoutPct" data-num>% of value</label>
      <button data-mlive="${rows.map(r => r.id).join(',')}" ${rows.length ? '' : 'disabled'}>Check live prices</button>
      <button data-mtradecopy ${rows.length ? '' : 'disabled'}>Copy summary</button>
      <button class="danger" data-mtradeclear ${rows.length ? '' : 'disabled'}>Clear</button></div>
    ${rows.length ? `<div class="table-wrap"><table class="data">
      <tr><th>Item</th><th class="num">Qty</th><th class="num">Value each</th><th class="num">Value total</th><th class="num">Cheapest each</th><th class="num">At ${payout}%</th><th></th></tr>
      ${lines.map((l, i) => `<tr><td>${itemLink(l.id, esc(itemName(l.id)))}</td><td class="num"><input type="number" min="1" style="width:64px" value="${l.qty}" data-mtradeqty="${i}"></td>
        <td class="num">${money(l.st.mv)}</td><td class="num">${money(l.mvT)}</td><td class="num">${l.best.price ? `${money(l.best.price)} ${wherePill(l.best.where)}` : '–'}</td>
        <td class="num">${money(l.mvT * payout / 100)}</td><td><button class="danger" data-mtraderm="${i}">&times;</button></td></tr>`).join('')}
      <tr class="total"><td>Total</td><td class="num">${num(rows.reduce((s, r) => s + r.qty, 0))}</td><td></td><td class="num">${money(mvTotal)}</td><td class="num">${lowKnown ? money(lowTotal) : '–'}</td><td class="num"><b>${money(pay)}</b></td><td></td></tr>
    </table></div>
    <div class="grid3" style="margin-top:8px">
      <div class="stat"><div class="k">You pay (${payout}%)</div><div class="v">${money(pay)}</div></div>
      <div class="stat"><div class="k">Margin vs value</div><div class="v pos">${money(mvTotal - pay)}</div></div>
      <div class="stat"><div class="k">Margin vs cheapest listings</div><div class="v ${lowKnown ? signClass(lowTotal - pay) : 'muted'}">${lowKnown ? money(lowTotal - pay) : 'check prices'}</div></div>
    </div>` : '<div class="empty">Add the items in a trade to total their value and work out a payout.</div>'}`;
}

// ---- Events ----
function initMarket() {
  const el = panel('market');
  el.addEventListener('submit', e => {
    const f = e.target.closest('[data-mform]');
    if (!f) return;
    e.preventDefault();
    const id = findItem(f.q.value);
    if (!id) { f.q.setCustomValidity('No item with that name'); f.q.reportValidity(); setTimeout(() => f.q.setCustomValidity(''), 1500); return; }
    if (f.dataset.mform === 'lookup') { prefs.set('market.item', id); cmd('market.live', [id]); renderMarket(); }
    else {
      const rows = tradeRows();
      const qty = Math.max(1, Number(f.qty.value) || 1);
      const ex = rows.find(r => r.id === id);
      if (ex) ex.qty += qty; else rows.push({ id, qty });
      prefs.set('market.trade', rows);
      renderMarket();
    }
  });
  el.addEventListener('click', e => {
    const t = e.target.closest('[data-msub],[data-mlive],[data-mrefresh],[data-mbzload],[data-mwatch],[data-mtrade],[data-mremove],[data-mshow],[data-mscan],[data-mtraderm],[data-mtradeclear],[data-mtradecopy]');
    if (!t) return;
    const d = t.dataset;
    if (itemButton(t)) return;
    if (d.msub) { prefs.set('market.sub', d.msub); renderMarket(); }
    else if (d.mlive) {
      const ids = d.mlive.split(',').map(Number);
      if (priceSource() !== 'bazaar') cmd('market.live', ids);
      if (priceSource() !== 'market') cmd('bazaar.listings', ids);
      t.textContent = 'Checking…';
      t.disabled = true;
    }
    else if (d.mbzload) { cmd('bazaar.listings', d.mbzload.split(',').map(Number)); t.textContent = 'Loading…'; t.disabled = true; }
    else if (d.mremove) cmd('market.watch.remove', Number(d.mremove));
    else if (d.mshow) { prefs.set('market.item', Number(d.mshow)); navOpen('market', 'lookup'); }
    else if (d.mscan === 'start') cmd('market.scan.start', $('[data-mpref="scanType"]').value, prefs.get('market.scanMin', 0));
    else if (d.mscan === 'stop') cmd('market.scan.stop');
    else if (d.mtraderm) { const rows = tradeRows(); rows.splice(Number(d.mtraderm), 1); prefs.set('market.trade', rows); renderMarket(); }
    else if (d.mtradeclear !== undefined) { prefs.set('market.trade', []); renderMarket(); }
    else if (d.mtradecopy !== undefined) {
      const payout = (S.settings.market && S.settings.market.payoutPct) || 95;
      const rows = tradeRows();
      const total = rows.reduce((s, r) => s + itemMV(r.id) * r.qty, 0);
      const text = rows.map(r => `${r.qty}x ${itemName(r.id)} @ ${money(itemMV(r.id))}`).join('\n') + `\nTotal value: ${money(total)}\nPayout at ${payout}%: ${money(total * payout / 100)}`;
      navigator.clipboard.writeText(text).then(() => { t.textContent = 'Copied'; });
    }
  });
  el.addEventListener('change', e => {
    const t = e.target;
    if (t.dataset.mbelow) cmd('market.watch.below', Number(t.dataset.mbelow), Number(t.value) || 0);
    else if (t.dataset.mpref) { prefs.set(`market.${t.dataset.mpref}`, t.type === 'number' ? Number(t.value) : t.value); renderMarket(); }
    else if (t.dataset.mtradeqty) { const rows = tradeRows(); rows[Number(t.dataset.mtradeqty)].qty = Math.max(1, Number(t.value) || 1); prefs.set('market.trade', rows); renderMarket(); }
  });
}
