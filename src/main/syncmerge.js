'use strict';
// Shared by the app and the sync server (server/server.js): which settings sync between
// PCs, and how two copies of the collected data are combined.

// Settings that follow you between PCs. Each is synced as one value. Left out on purpose:
// keys (they're encrypted for one PC), window positions, the open tab and zoom, the sync
// settings themselves, and anything that's only a cache.
const SYNC_UNITS = [
  'ui.theme', 'ui.themeAuto', 'ui.themeDark', 'ui.themeLight', 'ui.accent', 'ui.clockZone', 'ui.clockThird', 'ui.clock24', 'ui.browserClocks',
  'ui.popupStyle', 'ui.popupSeconds', 'ui.popupCorner', 'ui.navLayout', 'ui.navCollapsed', 'ui.tabLayout', 'ui.nav', 'ui.condensed',
  'ui.setupDone', 'ui.buttons', 'ui.urgent', 'ui.urgentSound', 'ui.urgentRepeat',
  'user.interval', 'user.notify',
  'chain.enabled', 'chain.alerts', 'chain.desktop', 'chain.sound', 'chain.volume', 'chain.minChain',
  'chain.t150', 'chain.t90', 'chain.t60', 'chain.t30',
  'targets.list', 'targets.autoRefresh', 'targets.interval', 'targets.notify',
  'travel.yata', 'travel.method', 'travel.capacity', 'travel.sellMode', 'travel.feePct', 'travel.book',
  'travel.outbound', 'travel.restockInterval', 'travel.restockOffset',
  'travel.override', 'travel.learned',
  'market.watch', 'market.watchInterval', 'market.payoutPct', 'market.bazaar', 'market.priceSource',
  'alerts.rules', 'alerts.volume',
  'gamble.log', 'gamble.session',
  'planner.items', 'planner.days',
  'war.watchId', 'war.interval', 'war.live', 'war.pinned', 'research.watchId',
  'ffscouter.intervalHours', 'scout.spread',
  // FFScouter Premium's end (from any device's key check) and the end date already reminded about,
  // so the 24-hour reminder shows once across all your devices (core.js premiumReminder).
  'ffscouter.premiumUntil', 'ffscouter.premiumReminded',
  'chatwin.emojis', 'chatwin.onTop', 'chatwin.minimizeToBubble', 'chatwin.compact', 'chatwin.hideInBrowser',
];
const UNIT_SET = new Set(SYNC_UNITS);

// The synced unit a settings path belongs to ('user.notify.energy' -> 'user.notify').
function unitFor(p) {
  p = String(p || '');
  if (p === 'ui.tabLayoutReset') return 'ui.tabLayout';
  return SYNC_UNITS.find(u => p === u || p.startsWith(`${u}.`)) || null;
}

// Collected data that can be pulled from (and uploaded to) a sync server.
// 'scout' is pull-only: the server's scouting view (it never takes a PC's copy).
// mugger: Mugger's market database (features/muggerdb.js), collected by the server; apps only read it.
const DATASETS = ['research', 'war', 'travel', 'prices', 'bazaar', 'scout', 'mugger'];
const PULL_ONLY = new Set(['scout', 'mugger']);

const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);

// Two time series of [time, ...values]: every point from both, oldest first. On the same
// time, b's point wins. Keeps the newest `max` points.
function mergeSeries(a, b, max = 0) {
  if (!Array.isArray(a) || !a.length) return Array.isArray(b) ? b.slice(-max || undefined) : [];
  if (!Array.isArray(b) || !b.length) return a.slice(-max || undefined);
  const byT = new Map();
  for (const p of a) if (Array.isArray(p)) byT.set(p[0], p);
  for (const p of b) if (Array.isArray(p)) byT.set(p[0], p);
  const out = [...byT.values()].sort((x, y) => x[0] - y[0]);
  return max && out.length > max ? out.slice(out.length - max) : out;
}

// id -> series maps (price history).
function mergeSeriesMap(a, b, max) {
  const out = isObj(a) ? a : {};
  if (!isObj(b)) return out;
  for (const [id, s] of Object.entries(b)) out[id] = mergeSeries(out[id], s, max);
  return out;
}

// history.json: { mv, low }
function mergePrices(local, remote) {
  local = isObj(local) ? local : {};
  remote = isObj(remote) ? remote : {};
  local.mv = mergeSeriesMap(local.mv, remote.mv, 1000);
  local.low = mergeSeriesMap(local.low, remote.low, 3000);
  return local;
}

// bazaar-history.json: { baz }
function mergeBazaar(local, remote) {
  local = isObj(local) ? local : {};
  local.baz = mergeSeriesMap(local.baz, isObj(remote) ? remote.baz : null, 1500);
  return local;
}

// war.json: { history: { warId, points, avail }, trips, abroad }
function mergeWar(local, remote) {
  local = isObj(local) ? local : {};
  remote = isObj(remote) ? remote : {};
  const lh = local.history, rh = remote.history;
  if (rh && (!lh || rh.warId > lh.warId)) local.history = rh;
  else if (rh && lh && rh.warId === lh.warId) {
    lh.points = mergeSeries(lh.points, rh.points, 4000);
    lh.avail = mergeSeries(lh.avail, rh.avail, 4000);
  }
  // Travel: the other copy may have caught a departure this one missed.
  local.trips = isObj(local.trips) ? local.trips : {};
  for (const [id, t] of Object.entries(isObj(remote.trips) ? remote.trips : {})) {
    const mine = local.trips[id];
    if (!mine || (mine.desc === t.desc && !mine.departLo && t.departLo)) local.trips[id] = t;
  }
  local.abroad = isObj(local.abroad) ? local.abroad : {};
  for (const [id, a] of Object.entries(isObj(remote.abroad) ? remote.abroad : {})) if (!local.abroad[id]) local.abroad[id] = a;
  return local;
}

// research.json: { factions: { id: record } }. A faction collected in both places keeps
// the copy with more samples (the counts can't be added without counting hours twice).
function mergeResearch(local, remote) {
  local = isObj(local) ? local : {};
  local.factions = isObj(local.factions) ? local.factions : {};
  for (const [id, r] of Object.entries(isObj(remote) && isObj(remote.factions) ? remote.factions : {})) {
    const mine = local.factions[id];
    if (!mine || (r.samples || 0) > (mine.samples || 0) || ((r.samples || 0) === (mine.samples || 0) && (r.lastSample || 0) > (mine.lastSample || 0))) local.factions[id] = r;
  }
  return local;
}

// travel-history.json: { countries: { code: { update, since, latest, items } } }. Keeps
// whichever copy of each country has more readings, then the newest latest stock.
function mergeTravel(local, remote) {
  local = isObj(local) ? local : {};
  local.countries = isObj(local.countries) ? local.countries : {};
  const runs = c => Object.values((c && c.items) || {}).reduce((n, r) => n + (Array.isArray(r) ? r.length : 0), 0);
  for (const [code, c] of Object.entries(isObj(remote) && isObj(remote.countries) ? remote.countries : {})) {
    const mine = local.countries[code];
    if (!mine) { local.countries[code] = c; continue; }
    const keep = runs(c) > runs(mine) ? c : mine;
    const newer = (c.update || 0) > (mine.update || 0) ? c : mine;
    local.countries[code] = { ...keep, latest: newer.latest, update: Math.max(keep.update || 0, newer.update || 0) };
  }
  return local;
}

const MERGE = { research: mergeResearch, war: mergeWar, travel: mergeTravel, prices: mergePrices, bazaar: mergeBazaar };

// Settings collections that are combined (not replaced) the first time a PC joins a
// server, so nothing either side already had is lost.
// Two copies of the plan, merged item by item: the newer edit of each item wins. Removed items are
// kept as { id, deleted: true, at, updatedAt } (planner.js), so a removal on one device isn't
// undone by another device that still has the item.
function mergePlan(a, b) {
  const out = { ...(isObj(a) ? a : {}) };
  for (const [id, it] of Object.entries(isObj(b) ? b : {})) {
    if (!isObj(it)) continue;
    const mine = out[id];
    if (!isObj(mine) || (Number(it.updatedAt) || 0) >= (Number(mine.updatedAt) || 0)) out[id] = it;
  }
  return out;
}

// The plan without what every device drops anyway (planner.js): items a week past their time and
// removal markers a month after the removal. The server uses this too, so its copy doesn't grow.
function prunePlan(items, now = Date.now()) {
  const out = {};
  for (const [id, it] of Object.entries(isObj(items) ? items : {})) {
    if (!isObj(it) || now - (Number(it.at) || 0) >= 7 * 86400e3) continue;
    if (it.deleted && now - (Number(it.updatedAt) || 0) > 30 * 86400e3) continue;
    out[id] = it;
  }
  return out;
}

// Dates that only move forward: the later of the two copies wins.
const LATEST_UNITS = new Set(['ffscouter.premiumUntil', 'ffscouter.premiumReminded']);
const latest = (a, b) => Math.max(Number(a) || 0, Number(b) || 0);

function joinUnit(unit, local, remote) {
  if (LATEST_UNITS.has(unit)) return latest(local, remote);
  if (unit === 'planner.items') return mergePlan(local, remote);
  if (unit === 'targets.list' || unit === 'market.watch' || unit === 'travel.learned' || unit === 'travel.override' || unit === 'gamble.log') {
    return { ...(isObj(local) ? local : {}), ...(isObj(remote) ? remote : {}) };
  }
  if (unit === 'war.pinned') return [...new Set([...(Array.isArray(remote) ? remote : []), ...(Array.isArray(local) ? local : [])])].slice(-500);
  if (unit === 'alerts.rules') {
    const out = Array.isArray(remote) ? [...remote] : [];
    for (const r of Array.isArray(local) ? local : []) if (r && !out.some(x => x && x.id === r.id)) out.push(r);
    return out;
  }
  return remote;
}

// A setting another PC changed, applied here. Targets keep this PC's fresher status
// checks; watched items keep whether this PC already alerted.
function applyUnit(unit, local, remote) {
  if (LATEST_UNITS.has(unit)) return latest(local, remote);
  if (unit === 'targets.list' && isObj(remote)) {
    const out = {};
    for (const [id, t] of Object.entries(remote)) {
      const mine = isObj(local) ? local[id] : null;
      out[id] = mine && (mine.lastFetched || 0) >= ((t && t.lastFetched) || 0) ? mine : t;
    }
    return out;
  }
  if (unit === 'market.watch' && isObj(remote)) {
    const out = {};
    for (const [id, w] of Object.entries(remote)) {
      if (!isObj(w)) continue;
      const mine = isObj(local) ? local[id] : null;
      const { alerted, ...rest } = w;
      // Same alert price: keep this PC's "already alerted" note (a new price clears it).
      out[id] = mine && mine.alerted && mine.below === w.below ? { ...rest, alerted: mine.alerted } : rest;
    }
    return out;
  }
  return remote;
}

module.exports = { SYNC_UNITS, UNIT_SET, unitFor, DATASETS, PULL_ONLY, MERGE, mergeSeries, mergePlan, prunePlan, joinUnit, applyUnit };
