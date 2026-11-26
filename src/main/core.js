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
//   notify(title, body, url, opts)   opts.urgent: middle-of-the-screen popup ({ sound, repeat })
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
const { ClaimsFeature } = require('./features/claims');
const { WarReportFeature, discordParts } = require('./features/warreport');
const { UserFeature } = require('./features/user');
const { ChainFeature } = require('./features/chain');
const { TargetsFeature, herePlace } = require('./features/targets');
const { MarketFeature } = require('./features/market');
const { TravelFeature } = require('./features/travel');
const { BazaarFeature } = require('./features/bazaar');
const { FFScouterFeature } = require('./features/ffscouter');
const { AlertsFeature, SOUNDS } = require('./features/alerts');
const { WarFeature } = require('./features/war');
const { ResearchFeature } = require('./features/research');
const { ScoutFeature } = require('./features/scout');
const { CasinoFeature } = require('./features/casino');
const { PlannerFeature } = require('./features/planner');
const { AvatarsFeature } = require('./features/avatars');
const { MuggerFeature } = require('./features/mugger');
const { MuggerDb } = require('./features/muggerdb');
const { SETTABLE, OVERRIDE_PATH, TAB_LAYOUT_DEFAULTS, LIGHT_THEMES, num } = require('./schema');

function createCore(host) {
  const { store, dataDir } = host;
  const send = (channel, data) => host.send(channel, data);
  // kind: which notification this is ('trip', 'energy', 'chain', …; see ui.urgent in schema.js), or
  // true / false when the caller decided itself (a planned item or custom alert with its own choice).
  // Urgent ones go to the middle of the screen and stay until dismissed (popups.js / web host).
  const urgentOpts = () => {
    const s = SOUNDS[store.get('ui.urgentSound')] || SOUNDS.doorbell;
    const vol = store.get('alerts.volume');
    return { urgent: true, sound: s.count ? { ...s, volume: vol === undefined ? 0.6 : vol } : null, repeat: Number(store.get('ui.urgentRepeat')) || 0 };
  };
  const notify = (title, body, url, kind) => {
    const urgent = kind === true || (typeof kind === 'string' && !!(store.get('ui.urgent') || {})[kind]);
    return host.notify(title, body, url, urgent ? urgentOpts() : {});
  };

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
  const ffscouter = new FFScouterFeature({ store, dataDir, getTargetIds: () => [...new Set([...Object.keys(store.get('targets.list') || {}).map(Number), ...war.enemyIds(), ...research.memberIds(), ...mugger.ffIds()])] });
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
  research.ownerPicks = () => sync.ownerResearchPicks();
  // Abroad stock: this device stops polling YATA only once the server's copy has actually arrived,
  // so a device that can't get it (a failed download, say) still shows live stock.
  travel.remote = () => sync.covering() && sync.hasPulled('travel');
  scout.remote = () => sync.mode() === 'server' && sync.configured();
  user.on('flight', f => { travel.learnFlight(f); sync.markDirty(['travel.learned']); });
  if (host.migrated && host.migrated.length) sync.markDirty(host.migrated); // e.g. the new default theme, to your other devices
  const alerts = new AlertsFeature({ store, notify, user, chain, targets, war, travel });
  travel.watchKeys = () => alerts.restockKeys(); // restock alerts: read YATA every 10 s
  // Casino tab: live odds come from the Mentat server (signed-in members).
  // War claims, shared through the Mentat server (War tab → Claim).
  const claims = new ClaimsFeature({ sync, war, viewing });
  // Post-war report: facts + accolades for Discord (War tab → War report)
  const warreport = new WarReportFeature({ api, war, dataDir });
  const casino = new CasinoFeature({ api, store, viewing, server: (method, p) => { if (!sync.configured()) throw new Error('Sign in to Mentat to load live odds.'); return sync.req(method, p); } });
  casino.on('imported', () => sync.markDirty(['gamble.log']));
  // Planner: your plan for the next few days (synced); reminders fire from here.
  const planner = new PlannerFeature({ store, notify });
  planner.on('pruned', () => sync.markDirty(['planner.items']));
  // Profile pictures: free from the profiles Targets fetches anyway, the rest a few a minute.
  const avatars = new AvatarsFeature({ api, store, dataDir });
  targets.on('profile', (id, d) => avatars.put(id, d && d.profile_image));
  // Mugger: a 90-day market database of bazaar sellers of abroad items (Weav3r; collected by the Mentat
  // server, or here without one), and while you're abroad, where they are, their cash and the fight.
  const muggerDb = new MuggerDb({ dataDir, travel, api }); // bazaar directories with your key when there's no server
  const mugger = new MuggerFeature({ api, store, dataDir, db: muggerDb, user, viewing });
  muggerDb.remote = () => sync.covering() && sync.hasPulled('mugger'); // the server's copy has arrived
  muggerDb.useServer = () => sync.mode() === 'server' && sync.configured();
  sync.muggerDb = muggerDb;
  mugger.extraIds = () => Object.keys(store.get('targets.list') || {}).map(Number);
  mugger.on('profile', (id, d) => avatars.put(id, d && d.profile_image));
  let muggerFfKey = '';
  mugger.on('state', () => {
    const k = mugger.ffIds().join(',');
    if (k && k !== muggerFfKey) ffscouter.refreshSoon();
    muggerFfKey = k;
  });
  user.on('state', () => mugger.emitSoon()); // your trip
  // FFScouter summaries for the team's war report link (its Comparison tab; the user's request,
  // 2026-11-24). The server has no FFScouter key, so the owner's or an admin's device shares what it
  // loaded for the researched factions: activity by hour of the week, estimated battle stats and
  // each member's usual hours. Checked once a minute, sent only when something changed.
  const ffsShare = {
    sent: '', at: 0, pauseUntil: 0, busy: false,
    usual(m) { // busiest 3 hours (TCT) from FFScouter's 96 quarter-hour activity counts
      if (!m || !Array.isArray(m.act)) return null;
      const by = Array.from({ length: 24 }, (_, h) => m.act.slice(h * 4, h * 4 + 4).reduce((a, b) => a + (b || 0), 0));
      const total = by.reduce((a, b) => a + b, 0);
      if (total < 3) return null;
      let best = 0, at = 0;
      for (let h = 0; h < 24; h++) { const v = by[h] + by[(h + 1) % 24] + by[(h + 2) % 24]; if (v > best) { best = v; at = h; } }
      return [at, (at + 3) % 24, Math.round((best / total) * 100) / 100];
    },
    intelTried: new Map(), // faction id -> last background load attempt
    // FFScouter Premium: load the activity history of each researched faction (theirs and ours) in
    // the background, so it's there without opening the Research tab (the user's report,
    // 2026-11-24: the shared report had no FFScouter activity for a new opponent). One faction at a
    // time, refreshed daily; a failed one waits an hour.
    loadIntel(now) {
      const acct = store.get('ffscouter.account') || {};
      const job = ffscouter.intelJob;
      if (!acct.premium || (job && job.running)) return;
      for (const t of research.tracked()) {
        const rec = research.rec(t.id);
        if (!rec || !Object.keys(rec.members || {}).length) continue;
        const have = ffscouter.intel(t.id);
        if (have && now - have.at < 24 * 3600e3) continue;
        if (now - (this.intelTried.get(t.id) || 0) < 3600e3) continue;
        this.intelTried.set(t.id, now);
        ffscouter.loadIntel(t.id, Object.keys(rec.members).map(Number), !!have).catch(() => {});
        return;
      }
    },
    tick(now) {
      if (this.busy || now - this.at < 60e3 || now < this.pauseUntil) return;
      if (ffscouter.hasKey()) { try { this.loadIntel(now); } catch (e) { console.error(e); } }
      if (!sync.signedIn() || sync.mode() !== 'server' || !ffscouter.hasKey()) return;
      this.at = now;
      const stats = ffscouter.stats();
      const factions = research.tracked().map(t => research.rec(t.id)).filter(Boolean).map(rec => {
        const i = ffscouter.intel(rec.id);
        const ids = Object.keys(rec.members || {});
        const st = {}, uh = {};
        for (const id of ids) {
          // The current estimate, else the latest one in FFScouter's stat history
          const g = i && i.growth && i.growth[id];
          if (stats[id] && stats[id].bs) st[id] = stats[id].bs;
          else if (g && g.last && g.last.bs) st[id] = g.last.bs;
          const u = i && i.members ? this.usual(i.members[id]) : null;
          if (u) uh[id] = u;
        }
        // intel: the whole FFScouter intel, so the server's intelligence report and member dossiers
        // match the app's (per-member activity by 15 minutes, estimated-stat growth).
        return { id: rec.id, days: i ? i.days : 0, at: i ? i.at : 0, week: i && i.faction ? i.faction.week : null, stats: st, uh, intel: i || null };
      }).filter(f => f.week || Object.keys(f.stats).length);
      if (!factions.length) return;
      const sig = JSON.stringify(factions);
      if (sig === this.sent) return;
      this.busy = true;
      sync.req('POST', 'research/ffscouter', { body: { factions } })
        .then(() => { this.sent = sig; })
        .catch(e => { this.pauseUntil = Date.now() + (/403|owner and admins|404|not found/i.test(e.message) ? 6 * 3600e3 : 10 * 60e3); })
        .finally(() => { this.busy = false; });
    },
  };
  // FFScouter Premium reminder (the user's request, 2026-11-24): 24 hours before Premium runs out,
  // once across all of the person's devices. The end date comes from any device's key check and is
  // synced (ffscouter.premiumUntil), as is the end date already reminded about
  // (ffscouter.premiumReminded). Whichever device is running when the time comes shows it; if none
  // is, the next one to start does. A device waits until it has the server's synced settings (or
  // 10 minutes, if it can't reach the server), so it doesn't repeat what another device showed.
  const premiumReminder = {
    at: 0, startedAt: Date.now(),
    tick(now) {
      if (now - this.at < 60e3) return;
      this.at = now;
      const acct = store.get('ffscouter.account') || {};
      const synced = Number(store.get('ffscouter.premiumUntil')) || 0;
      const until = Math.max(synced, Number(acct.premiumUntil) || 0);
      if (until !== synced) { store.set('ffscouter.premiumUntil', until); sync.markDirty(['ffscouter.premiumUntil']); }
      if (!until || now < until - 24 * 3600e3) return;
      if ((Number(store.get('ffscouter.premiumReminded')) || 0) >= until) return;
      if (sync.configured() && !sync.settingsFresh() && now - this.startedAt < 10 * 60e3) return;
      store.set('ffscouter.premiumReminded', until);
      sync.markDirty(['ffscouter.premiumReminded']);
      const left = until - now;
      const when = `${new Date(until).toISOString().slice(0, 16).replace('T', ' ')} TCT`;
      const inTime = left >= 3600e3 ? `${Math.round(left / 3600e3)} hours` : `${Math.max(1, Math.round(left / 60e3))} minutes`;
      const title = left > 0 ? `FFScouter Premium ends in ${inTime}` : 'FFScouter Premium has ended';
      const body = `${left > 0 ? 'It runs out' : 'It ran out'} ${when}. Renew at ffscouter.com to keep FFScouter activity history and stat growth in Oppo Research and the team war pages.`;
      // Stays on screen until dismissed (urgent popup), one sound, no repeats.
      host.notify(title, body, 'https://ffscouter.com/premium', { ...urgentOpts(), repeat: 0 });
    },
  };
  const features = { user, chain, research, scout, war, claims, warreport, targets, market, travel, bazaar, ffscouter, alerts, casino, planner, avatars, mugger, sync, ...(host.extraFeatures || {}) };

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
    try { ffsShare.tick(now); } catch (e) { console.error(e); }
    try { premiumReminder.tick(now); } catch (e) { console.error(e); }
  }, 1000);

  // ---- Settings sent to the page (never a key) ----
  function publicSettings() {
    const { learned, capacityApi, lastMethod, ...travelSettings } = store.get('travel');
    const { watch, ...marketSettings } = store.get('market');
    return {
      ui: store.get('ui'), api: { maxPerMinute: store.get('api.maxPerMinute') }, user: store.get('user'), chain: store.get('chain'),
      targets: { autoRefresh: store.get('targets.autoRefresh'), interval: store.get('targets.interval'), notify: store.get('targets.notify') },
      // The War tab's dropdowns (without these they showed their first option after every redraw)
      war: { interval: store.get('war.interval'), live: store.get('war.live') },
      travel: travelSettings, market: marketSettings,
      ffscouter: { intervalHours: store.get('ffscouter.intervalHours') },
      mugger: store.get('mugger'),
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
      if (p.startsWith('mugger.')) { mugger.pool = null; mugger.emitSoon(); }
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
    // War board tab (the war board plugin running inside Mentat, the user's request 2026-11-26):
    // its Mentat server calls with this app's sign-in, its Torn reads through the API queue with the
    // saved key (counted like everything else), its FFScouter reads with the saved FFScouter key.
    // Each limited to what the board uses.
    'warboard.server': (method, p, body) => {
      method = method === 'POST' ? 'POST' : 'GET';
      p = String(p || '');
      if (!/^war\/(board|queue|claims|energy)(\?[A-Za-z0-9_=&.-]*)?$/.test(p)) return { status: 400, json: { error: 'Not allowed' } };
      return sync.call(method, p, method === 'POST' ? (body && typeof body === 'object' ? body : {}) : null);
    },
    'warboard.torn': async p => {
      p = String(p || '');
      const ok = /^\/v2\/(faction\/(\d+\/)?members|user\/battlestats|user\/\d+\/basic)(\?[A-Za-z0-9_=&]*)?$/.test(p) || p === '/v2/user?selections=bars,cooldowns';
      if (!ok) return { error: { code: 0, error: 'Not allowed' } };
      try {
        // Priority 7: after the app's own features (chain, your status, war), so the board's Live
        // can't crowd them out when the key is near its limit.
        return await api.request(p, { soft: [6, 7, 16], priority: 7 });
      } catch (e) {
        return { error: { code: e.code || 0, error: e.message } };
      }
    },
    'warboard.ffs': (p, params) => ffscouter.boardCall(String(p || ''), params),
    'ffscouter.intel': (fid, ids, force) => ffscouter.loadIntel(Number(fid) || 0, Array.isArray(ids) ? ids.slice(0, 120) : [], !!force),
    'war.refresh': () => war.refresh(),
    'war.watch': id => war.watch(id),
    'war.pin': (id, on) => war.pin(id, !!on),
    'war.reportWars': () => warreport.listWars(),
    'war.report': async (id, opts = {}) => {
      const model = await warreport.build(id, { fresh: !!(opts && opts.fresh) });
      return { model, parts: discordParts(model, { spectators: !!(opts && opts.spectators) }) };
    },
    // The report card as an image on the clipboard (desktop: export.js; the web app has none)
    'war.reportImage': html => (host.copyImage ? host.copyImage(String(html || '')) : { unsupported: true }),
    // A link to the report as a page on the Mentat server, for sharing with the team: it opens at
    // once with no sign-in or API calls (server/warpage.js). The server builds it with its own key.
    'war.reportLink': async id => {
      if (!sync.signedIn()) throw new Error('Team links need the Mentat server: sign in to it first.');
      try {
        return await sync.req('GET', `war/report-link?war=${Number(id) || 0}`);
      } catch (e) {
        if (/404|not found/i.test(e.message)) throw new Error('Your Mentat server needs an update for team links.');
        throw e;
      }
    },
    'war.claim': (id, on) => claims.set(Number(id), !!on),
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
    'popup.testUrgent': () => notify('Plan: Trip to Japan', 'Test of an urgent popup: in 5 min (14:05 TCT). Snooze or dismiss it.', 'https://www.torn.com/page.php?sid=travel', true),
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
    'mugger.scan': () => mugger.scanNow(),
    'mugger.recheck': id => mugger.recheck(Number(id) || 0),
    'mugger.paste': text => mugger.paste(String(text || '').slice(0, 200000)),
    'mugger.pasteClear': () => mugger.pasteClear(),
    'planner.add': it => planner.add(it),
    'planner.update': (id, patch) => planner.update(String(id), patch),
    'planner.remove': id => planner.remove(String(id)),
    'planner.copyDay': (from, to) => planner.copyDay(String(from), String(to)),
    'planner.clearDay': day => planner.clearDay(String(day)),
  };

  // Everything to disk (quitting, or the page going away).
  function flushAll() {
    for (const s of [store, cache, history, travel, war, research, scout, warreport, mugger, muggerDb]) { try { s.flush(); } catch (e) { console.error(e); } }
    try { if (activity) activity.flush(); if (archive) archive.flush(); } catch (e) { /* best effort */ }
    if (ffscouter.intelDb) ffscouter.intelDb.flush();
    sync.flush();
    store.flush();
  }
  function stop() { clearInterval(ticker); }

  return {
    api, features, commands, publicSettings, setSetting, applySynced, flushAll, stop,
    user, chain, targets, market, travel, bazaar, war, research, scout, ffscouter, alerts, casino, mugger, sync, history, cache, premiumReminder,
  };
}

module.exports = { createCore };
