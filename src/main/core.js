'use strict';
// Mentat's core: settings, the features (your status, chain, targets, travel, market, war, oppo
// research, scouting, FFScouter, alerts) and the link to a Mentat server, plus the commands the
// tools page sends. Shared by the Windows app (main.js) and the web app (web/app/), so both
// behave the same; each "host" supplies what differs (windows, notifications, files, links).
//
// host: {
//   store                 settings Store
//   dataDir               folder for the data files
//   version, deviceName   for the server ("Mentat for Windows", "Mentat web")
//   send(channel, data)   updates for the tools page(s)
//   notify(title, body, url)
//   openUrl(url, newTab)  a Torn page or a link
//   activity, archive     long-term stores for oppo research (the web app passes empty stand-ins)
//   scoutLocal            this device may scout (Windows app: when turned on)
//   viewing(tab)          is that tab on show (war members and points refresh only then)
//   onSetting(p, value)   after a setting changes (themes, chat window, browser clocks…)
//   onSynced(changed, has) after settings arrive from another device
//   publicExtra()         more settings for the page
//   exportResearch(p), exportIntel(p)   save the oppo research exports
//   activeUrl()           the Torn page on show, for "add this player to targets"
//   extraFeatures         { name: feature } shown to the page like the others (e.g. updates)
//   defaultServer         the Mentat server this build signs in to
// }

const { TornApi } = require('./api');
const { Store } = require('./store');
const { PriceHistory } = require('./history');
const { SyncFeature } = require('./sync');
const { UserFeature } = require('./features/user');
const { ChainFeature } = require('./features/chain');
const { TargetsFeature, herePlace } = require('./features/targets');
const { MarketFeature } = require('./features/market');
const { TravelFeature } = require('./features/travel');
const { BazaarFeature } = require('./features/bazaar');
const { FFScouterFeature } = require('./features/ffscouter');
const { AlertsFeature } = require('./features/alerts');
const { WarFeature } = require('./features/war');
const { ResearchFeature } = require('./features/research');
const { ScoutFeature } = require('./features/scout');
const { CasinoFeature } = require('./features/casino');
const { PlannerFeature } = require('./features/planner');
const { AvatarsFeature } = require('./features/avatars');
const { SETTABLE, OVERRIDE_PATH, TAB_LAYOUT_DEFAULTS, LIGHT_THEMES, num } = require('./schema');

function createCore(host) {
  const { store, dataDir } = host;
  const send = (channel, data) => host.send(channel, data);
  const notify = (title, body, url) => host.notify(title, body, url);

  // ---- API + features ----
  const api = new TornApi(store);
  const user = new UserFeature({ api, store, notify });
  const chain = new ChainFeature({ api, store, notify, getMeId: () => user.meId() });
  // Your country (abroad or flying out) for the Abroad list, from your own status.
  const targets = new TargetsFeature({ api, store, notify, here: () => herePlace(user.state && user.state.data) });
  const cache = new Store(`${dataDir}/cache.json`, { items: null }, { debounceMs: 5000 });
  const history = new PriceHistory(dataDir);
  const market = new MarketFeature({ api, store, cache, notify, history });
  const travel = new TravelFeature({ api, store, dataDir });
  const bazaar = new BazaarFeature({ store, history });
  market.bazaar = bazaar;
  bazaar.on('summary', () => market.checkAllWatches());
  bazaar.on('listings', id => market.checkWatch(id));
  const war = new WarFeature({ api, store, dataDir });
  // War members and points refresh while their tab is on show (see host.viewing).
  const viewing = host.viewing || (tab => String(store.get('ui.panel') || '').split(':')[0] === tab);
  war.viewing = viewing;
  market.viewing = viewing;
  const { activity, archive } = host;
  const research = new ResearchFeature({ api, store, dataDir, war, activity, archive });
  const scout = new ScoutFeature({ api, store, dataDir, war, activity, archive, research, local: !!host.scoutLocal });
  war.statsWanted = () => research.tracked().length > 0;
  // FFScouter estimates for your targets and for the enemy faction on the War tab.
  const ffscouter = new FFScouterFeature({ store, dataDir, getTargetIds: () => [...new Set([...Object.keys(store.get('targets.list') || {}).map(Number), ...war.enemyIds(), ...research.memberIds()])] });
  let enemyKey = '';
  war.on('state', () => {
    const k = war.enemyIds().join(',');
    if (k && k !== enemyKey) ffscouter.refreshSoon();
    enemyKey = k;
  });
  let researchKey = '';
  research.on('state', () => {
    const k = research.memberIds().sort().join(',');
    if (k && k !== researchKey) ffscouter.refreshSoon();
    researchKey = k;
  });
  // Data source: this device, or a Mentat server that collects 24/7 (see sync.js and server/).
  const sync = new SyncFeature({ store, research, travel, war, history, scout, version: host.version, onSettings: applySynced, defaultServer: host.defaultServer || '', api });
  research.remote = () => sync.covering();
  // Abroad stock: this device stops polling YATA only once the server's copy has actually arrived,
  // so a device that can't get it (a failed download, say) still shows live stock.
  travel.remote = () => sync.covering() && sync.hasPulled('travel');
  scout.remote = () => sync.mode() === 'server' && sync.configured();
  user.on('flight', f => { travel.learnFlight(f); sync.markDirty(['travel.learned']); });
  if (host.migrated && host.migrated.length) sync.markDirty(host.migrated); // e.g. the new default theme, to your other devices
  const alerts = new AlertsFeature({ store, notify, user, chain, targets, war });
  // Casino tab: live odds come from the Mentat server (signed-in members).
  const casino = new CasinoFeature({ api, store, viewing, server: (method, p) => { if (!sync.configured()) throw new Error('Sign in to Mentat to load live odds.'); return sync.req(method, p); } });
  casino.on('imported', () => sync.markDirty(['gamble.log']));
  // Planner: your plan for the next few days (synced); reminders fire from here.
  const planner = new PlannerFeature({ store, notify });
  planner.on('pruned', () => sync.markDirty(['planner.items']));
  // Profile pictures: free from the profiles Targets fetches anyway, the rest a few a minute.
  const avatars = new AvatarsFeature({ api, store, dataDir });
  targets.on('profile', (id, d) => avatars.put(id, d && d.profile_image));
  const features = { user, chain, research, scout, war, targets, market, travel, bazaar, ffscouter, alerts, casino, planner, avatars, sync, ...(host.extraFeatures || {}) };

  // Settings changed on another device (from the Mentat server).
  function applySynced(changed) {
    for (const [u, v] of Object.entries(changed)) {
      if (u === 'war.watchId') { war.watch(v); continue; }
      store.set(u, v);
    }
    const has = pre => Object.keys(changed).some(u => u.startsWith(pre));
    if (has('targets.')) targets.emit('state');
    if (has('alerts.')) alerts.emit('state');
    if (has('market.')) { market.checkAllWatches(); market.emit('state'); }
    if (has('war.')) war.emit('state');
    if (has('research.')) research.emit('state');
    if (has('scout.')) scout.emit('state');
    if (has('travel.')) travel.emit('state');
    if (has('gamble.')) casino.emit('state');
    if (has('planner.')) planner.emit('state');
    if (host.onSynced) host.onSynced(changed, has);
    send('settings', publicSettings());
  }

  for (const [name, f] of Object.entries(features)) f.on('state', () => send('feature', { name, state: f.snapshot() }));
  chain.on('beep', alert => send('beep', alert));
  alerts.on('beep', alert => send('beep', alert));
  api.on('status', () => send('api', api.status()));
  api.on('key', () => send('api', api.status()));

  const ticker = setInterval(() => {
    const now = Date.now();
    for (const f of Object.values(features)) {
      try { f.tick(now); } catch (e) { console.error(e); }
    }
  }, 1000);

  // ---- Settings sent to the page (never a key) ----
  function publicSettings() {
    const { learned, capacityApi, lastMethod, ...travelSettings } = store.get('travel');
    const { watch, ...marketSettings } = store.get('market');
    return {
      ui: store.get('ui'), api: { maxPerMinute: store.get('api.maxPerMinute') }, user: store.get('user'), chain: store.get('chain'),
      targets: { autoRefresh: store.get('targets.autoRefresh'), interval: store.get('targets.interval'), notify: store.get('targets.notify') },
      travel: travelSettings, market: marketSettings,
      ffscouter: { intervalHours: store.get('ffscouter.intervalHours') },
      alerts: { volume: store.get('alerts.volume') },
      ...(host.publicExtra ? host.publicExtra() : {}),
    };
  }

  function setSetting(p, value) {
    if (OVERRIDE_PATH.test(p)) {
      if (!num(0, 600)(value)) throw new Error(`Invalid setting ${p}`);
      const key = p.slice('travel.override.'.length);
      const o = { ...store.get('travel.override') };
      if (value > 0) o[key] = value;
      else delete o[key];
      store.set('travel.override', o);
    } else if (p === 'ui.tabLayoutReset') {
      store.set('ui.tabLayout', structuredClone(TAB_LAYOUT_DEFAULTS));
    } else {
      const check = SETTABLE[p];
      if (!check || !check(value)) throw new Error(`Invalid setting ${p}`);
      store.set(p, value);
      if (p === 'market.priceSource') market.checkAllWatches();
      // Picking a theme also makes it the dark or light pick, so "match light/dark mode" has both ready.
      if (p === 'ui.theme') store.set(LIGHT_THEMES.includes(value) ? 'ui.themeLight' : 'ui.themeDark', value);
      if (p.startsWith('scout.')) scout.emit('state');
      if (p.startsWith('planner.')) planner.emit('state');
      if (p === 'ui.avatars') avatars.emit('state');
    }
    if (host.onSetting) host.onSetting(p, value);
    send('settings', publicSettings());
  }

  // ---- Commands from the tools page ----
  const commands = {
    'init': () => ({ api: api.status(), settings: publicSettings(), features: Object.fromEntries(Object.entries(features).map(([n, f]) => [n, f.snapshot()])) }),
    'torn.open': (url, newTab = true) => host.openUrl(String(url || ''), newTab !== false),
    'settings.set': (p, v) => setSetting(String(p), v),
    'key.save': async key => ({ account: await api.saveKey(key) }),
    'key.remove': () => api.clearKey(''),
    'user.refresh': () => user.refresh(),
    'chain.refresh': () => chain.refresh(),
    'targets.add': text => { ffscouter.refreshSoon(); return targets.add(String(text || '')); },
    'targets.addCurrent': () => { ffscouter.refreshSoon(); return targets.addFromUrl(host.activeUrl ? host.activeUrl() : ''); },
    'targets.removeFrom': from => targets.removeFrom(from === 'list' ? 'list' : ''),
    'targets.remove': (id, which) => targets.remove(Number(id), which === 'abroad' ? 'abroad' : 'home'),
    'targets.refresh': id => targets.refresh(Number(id)),
    'targets.refreshAll': () => targets.refreshAll(),
    'targets.clear': which => targets.clear(which === 'abroad' ? 'abroad' : 'home'),
    'ffscouter.saveKey': async (key, acknowledged) => ({ account: await ffscouter.saveKey(key, !!acknowledged) }),
    'ffscouter.removeKey': () => ffscouter.removeKey(''),
    'ffscouter.refresh': () => ffscouter.refreshSoon(true),
    'ffscouter.find': params => ffscouter.findTargets(params && typeof params === 'object' ? params : {}),
    'ffscouter.intel': (fid, ids, force) => ffscouter.loadIntel(Number(fid) || 0, Array.isArray(ids) ? ids.slice(0, 120) : [], !!force),
    'war.refresh': () => war.refresh(),
    'war.watch': id => war.watch(id),
    'war.pin': (id, on) => war.pin(id, !!on),
    'research.watch': id => research.research(id),
    'research.exportIntel': p => {
      if (!p || typeof p !== 'object' || typeof p.pdf !== 'string' || typeof p.html !== 'string') throw new Error('Nothing to export');
      return host.exportIntel({ name: String(p.name || ''), pdf: p.pdf, html: p.html, csv: String(p.csv || '') });
    },
    'research.export': p => {
      if (!p || typeof p !== 'object' || typeof p.overview !== 'string') throw new Error('Nothing to export');
      return host.exportResearch({ mode: p.mode === 'all' ? 'all' : 'image', name: String(p.name || ''), overview: p.overview, report: String(p.report || ''), csv: String(p.csv || ''), data: p.data || null });
    },
    'sync.configure': c => sync.configure(c && typeof c === 'object' ? c : {}),
    'sync.now': () => { sync.nextPoll = 0; return sync.poll(); },
    'sync.upload': () => sync.uploadAll(),
    'sync.forget': () => sync.forget(),
    // Sign in with your Torn key: the server checks you're in the faction (or allow-listed);
    // the key is then saved on this device for your own tools.
    'auth.health': url => sync.health(url ? String(url) : ''),
    'auth.login': async (key, url) => {
      const s = await sync.login({ url: url ? String(url) : '', key: String(key || ''), device: host.deviceName || 'Mentat' });
      let keyError = '';
      try { await api.saveKey(String(key || '').replace(/[^A-Za-z0-9]/g, '')); } catch (e) { keyError = e.message; }
      return { ...s, keyError };
    },
    'auth.logout': () => sync.logout(),
    // Admins: who uses Mentat on the server, the allow-list, signing someone out.
    'members.list': () => sync.req('GET', 'admin/members'),
    'members.allow': (id, note) => sync.req('POST', 'admin/allow', { body: { id: Number(id), note: String(note || '') } }),
    'members.disallow': id => sync.req('POST', 'admin/disallow', { body: { id: Number(id) } }),
    'members.signout': id => sync.req('POST', 'admin/signout', { body: { id: Number(id) } }),
    'alerts.add': rule => alerts.add(rule && typeof rule === 'object' ? rule : {}),
    'alerts.update': (id, patch) => alerts.update(String(id), patch && typeof patch === 'object' ? patch : {}),
    'alerts.remove': id => alerts.remove(String(id)),
    'alerts.test': id => alerts.test(String(id)),
    'alerts.preview': sound => alerts.preview(String(sound)),
    'popup.test': () => notify('Test alert', 'This is how your alerts will look.', 'https://www.torn.com/index.php'),
    'market.catalog': () => market.catalogCompact(),
    'market.live': ids => market.requestLive((Array.isArray(ids) ? ids : [ids]).map(Number).filter(Boolean).slice(0, 25), 5),
    'market.watch.add': (id, below) => market.addWatch(Number(id), Number(below) || 0),
    'market.watch.below': (id, below) => market.setBelow(Number(id), Number(below) || 0),
    'market.watch.remove': id => market.removeWatch(Number(id)),
    'market.points.refresh': () => market.refreshPoints(),
    'market.scan.start': (type, minValue) => market.startScan(String(type), Math.max(0, Number(minValue) || 0)),
    'market.scan.stop': () => market.stopScan(),
    'market.history': id => history.item(Number(id)),
    'market.trends': ids => history.trends((Array.isArray(ids) ? ids : []).map(Number).slice(0, 2000)),
    'bazaar.summary': () => bazaar.summary,
    'bazaar.listings': ids => bazaar.requestListings((Array.isArray(ids) ? ids : [ids]).map(Number).filter(Boolean).slice(0, 10)),
    'bazaar.refresh': () => bazaar.refresh(),
    'travel.refresh': () => travel.refresh(),
    'travel.capacity.refresh': () => travel.refreshCapacity(),
    'travel.stockHistory': (code, id) => travel.stockHistory(String(code), Number(id)),
    'travel.learned.clear': () => { store.set('travel.learned', {}); travel.emit('state'); },
    'casino.refresh': () => { casino.refreshCasino(); casino.refreshTables(); },
    'casino.odds.sports': () => casino.oddsSports(),
    'casino.odds.events': sport => casino.oddsEvents(String(sport || '')),
    'casino.odds.top': () => casino.oddsTop(),
    'avatars.want': ids => avatars.want(ids),
    'casino.log.add': e => casino.addLog(e),
    'casino.log.update': (id, patch) => casino.updateLog(String(id), patch && typeof patch === 'object' ? patch : {}),
    'casino.log.remove': id => casino.removeLog(String(id)),
    'casino.log.clear': which => casino.clearLog(which === 'auto' || which === 'manual' ? which : 'all'),
    'casino.session': s => casino.setSession(s && typeof s === 'object' ? s : null),
    'casino.logKey.save': key => casino.saveLogKey(key),
    'casino.logKey.remove': () => casino.removeLogKey(),
    'casino.log.import': () => casino.importLog(),
    'planner.add': it => planner.add(it),
    'planner.update': (id, patch) => planner.update(String(id), patch),
    'planner.remove': id => planner.remove(String(id)),
    'planner.copyDay': (from, to) => planner.copyDay(String(from), String(to)),
    'planner.clearDay': day => planner.clearDay(String(day)),
  };

  // Everything to disk (quitting, or the page going away).
  function flushAll() {
    for (const s of [store, cache, history, travel, war, research, scout]) { try { s.flush(); } catch (e) { console.error(e); } }
    try { if (activity) activity.flush(); if (archive) archive.flush(); } catch (e) { /* best effort */ }
    if (ffscouter.intelDb) ffscouter.intelDb.flush();
    sync.flush();
    store.flush();
  }
  function stop() { clearInterval(ticker); }

  return {
    api, features, commands, publicSettings, setSetting, applySynced, flushAll, stop,
    user, chain, targets, market, travel, bazaar, war, research, scout, ffscouter, alerts, casino, sync, history, cache,
  };
}

module.exports = { createCore };
