'use strict';
// Mentat's settings: defaults, what may be changed and how each value is checked, the tabs, the
// colour themes. Shared by the Windows app, the web app (core.js) and nothing else.

const DEFAULTS = {
  window: { bounds: null, maximized: false },
  browser: { bounds: null, maximized: false },
  chatwin: { bounds: null, bubble: null, onTop: true, minimizeToBubble: true, compact: true, hideInBrowser: true, zoom: 0, emojis: '😂 👍 ❤️ 😭 🙏 🔥 💀 👀 🎉 😅' },
  ui: { panel: 'overview', zoom: 0, openTornOnStart: false, closeToTray: true, trayHintShown: false, clockZone: 'America/New_York', clockThird: false, clock24: true, avatars: true, browserClocks: true, popupStyle: 'app', popupSeconds: 12, popupCorner: 'bottom-right', navLayout: 'top', navCollapsed: false, theme: 'mentat', accent: '' },
  session: { urls: [], active: 0 },
  api: { keyEnc: '', account: null, maxPerMinute: 40 },
  user: {
    interval: 60,
    notify: { energy: true, nerve: true, drug: true, booster: false, medical: false, travel: true, hospital: true, events: true, messages: true },
  },
  chain: { enabled: true, alerts: true, desktop: true, sound: 'soft', volume: 0.6, minChain: 10, t150: true, t90: true, t60: true, t30: true },
  targets: { list: {}, autoRefresh: true, interval: 120, notify: true },
  travel: {
    yata: true, method: 'auto', capacity: 0, sellMode: 'market', feePct: 0,
    book: false, outbound: true,
    restockInterval: 15, restockOffset: 0,
    override: {}, learned: {}, lastMethod: '', capacityApi: null,
  },
  market: { watch: {}, watchInterval: 300, payoutPct: 95, bazaar: true, priceSource: 'both' },
  ffscouter: { keyEnc: '', account: null, acknowledgedAt: 0, stats: {}, intervalHours: 6 },
  alerts: { rules: [], volume: 0.6 },
  war: { watchId: 0, interval: 30, pinned: [] },
  // Scouting (activity + war records of the factions around your rank). On this PC it's off
  // unless turned on; a sync server always scouts.
  scout: { enabled: false, perMinute: 6, spread: 1 },
  extensions: { torntools: false },
  // Pop-out tabs (popouts.js): open ones, window and bubble places, collapsed / on top.
  popouts: { open: [], bounds: {}, bubble: {}, collapsed: {}, onTop: {}, minimizeToBubble: true },
  // Data source: 'local' (this PC) or 'server' (a Mentat sync server). Secrets are DPAPI-encrypted.
  sync: { mode: 'local', url: '', tokenEnc: '', cfIdEnc: '', cfSecretEnc: '', serverId: '', joinedId: '', settingsRev: 0, dirty: [], deviceId: '' },
};

const TIME_ZONES = new Set(Intl.supportedValuesOf('timeZone'));
// Colour themes (ui/themes.css) and their window background, used before a page draws.
const THEME_BG = {
  mentat: '#17120d',
  dark: '#191919', midnight: '#0f1420', oled: '#000000', slate: '#1c2128', crimson: '#1a1515', amethyst: '#16131e', sepia: '#1d1915',
  light: '#eef0f3', sand: '#f3ece0', paper: '#f3f3f1', frost: '#e9f0f7', sage: '#ecf1ea', rose: '#f6edef', lavender: '#f0eef8', contrast: '#ffffff',
};
const LIGHT_THEMES = ['light', 'sand', 'paper', 'frost', 'sage', 'rose', 'lavender', 'contrast'];
const DARK_THEMES = Object.keys(THEME_BG).filter(k => !LIGHT_THEMES.includes(k));
// Default third clock: New York, or London for people whose local time already is New York.
DEFAULTS.ui.clockZone = Intl.DateTimeFormat().resolvedOptions().timeZone === 'America/New_York' ? 'Europe/London' : 'America/New_York';

// What the UI may change, and how each value is checked.
const bool = v => typeof v === 'boolean';
const num = (lo, hi) => v => typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;
const oneOf = (...xs) => v => xs.includes(v);
const SETTABLE = {
  // A main-bar entry: a tab, or one of its sub-tabs ('market:watch') lifted onto the main bar.
  'ui.panel': v => typeof v === 'string' && /^[a-z]+(:[a-z]+)?$/.test(v) && TABS.includes(v.split(':')[0]),
  // Tab layout (ui/nav.js keeps it tidy): order of main-bar entries, sub-tab order per tab, hidden ones.
  'ui.nav': v => {
    const ids = a => Array.isArray(a) && a.length <= 60 && a.every(x => typeof x === 'string' && /^[a-z]+(:[a-z]+)?$/.test(x));
    return !!v && typeof v === 'object' && !Array.isArray(v) && ids(v.order) && ids(v.hidden)
      && !!v.sub && typeof v.sub === 'object' && !Array.isArray(v.sub) && Object.keys(v.sub).length <= 20
      && Object.entries(v.sub).every(([k, a]) => TABS.includes(k) && ids(a));
  },
  'war.interval': num(15, 300),
  'ui.openTornOnStart': bool, 'ui.closeToTray': bool, 'ui.clock24': bool, 'ui.avatars': bool, 'ui.clockThird': bool, 'ui.browserClocks': bool,
  'ui.clockZone': v => typeof v === 'string' && TIME_ZONES.has(v),
  'ui.popupStyle': oneOf('windows', 'app'), 'ui.popupSeconds': num(0, 600),
  'ui.navLayout': oneOf('top', 'side'), 'ui.navCollapsed': bool,
  'ui.tabLayoutReset': bool,
  'ui.theme': oneOf(...Object.keys(THEME_BG)),
  // Match Windows light/dark mode: themeDark and themeLight are the two picks it switches between.
  'ui.themeAuto': bool, 'ui.themeDark': oneOf(...DARK_THEMES), 'ui.themeLight': oneOf(...LIGHT_THEMES),
  'ui.accent': v => v === '' || (typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v)),
  'ui.popupCorner': oneOf('bottom-right', 'top-right', 'bottom-left', 'top-left'),
  'api.maxPerMinute': num(10, 80),
  'user.interval': num(30, 600),
  'chain.enabled': bool, 'chain.alerts': bool, 'chain.desktop': bool,
  'chain.volume': num(0, 1), 'chain.minChain': num(0, 100000),
  'alerts.volume': num(0, 1), 'chain.sound': oneOf('soft', 'classic'),
  'chain.t150': bool, 'chain.t90': bool, 'chain.t60': bool, 'chain.t30': bool,
  'targets.autoRefresh': bool, 'targets.interval': num(30, 3600), 'targets.notify': bool,
  'travel.yata': bool, 'travel.method': oneOf('auto', 'Standard', 'Airstrip', 'Private', 'Business'),
  'travel.capacity': num(0, 500), 'travel.sellMode': oneOf('market', 'live'), 'travel.feePct': num(0, 50),
  'travel.restockInterval': num(5, 240), 'travel.restockOffset': num(0, 239),
  'travel.book': bool, 'travel.outbound': bool,
  'market.watchInterval': num(60, 3600), 'market.payoutPct': num(1, 150),
  'market.bazaar': bool, 'market.priceSource': oneOf('market', 'bazaar', 'both'),
  'ffscouter.intervalHours': num(1, 48),
  'scout.enabled': bool, 'scout.perMinute': num(2, 40), 'scout.spread': num(0, 4),
  'chatwin.emojis': v => typeof v === 'string' && v.length <= 300,
  'popouts.minimizeToBubble': bool,
  'ui.tourDone': bool,
  'updates.auto': bool,
  // Web and phone app: open Torn links in Torn PDA (auto = Android, where it falls back to the browser).
  'ui.pdaLinks': oneOf('auto', 'on', 'off'),
  'chatwin.onTop': bool, 'chatwin.minimizeToBubble': bool, 'chatwin.compact': bool, 'chatwin.hideInBrowser': bool,
};
// Per-tab layout: alignment and width of each tab's content (Settings → Appearance).
const TABS = ['overview', 'chain', 'research', 'faction', 'war', 'targets', 'travel', 'market', 'planner', 'casino', 'alerts', 'settings'];
const TAB_LABELS = {
  overview: 'Overview', chain: 'Chain', targets: 'Targets', faction: 'My Faction', war: 'War', research: 'Oppo Research',
  market: 'Market', travel: 'Travel', planner: 'Planner', casino: 'Casino', alerts: 'Alerts', settings: 'Settings',
  'targets:list': 'Targets', 'targets:abroad': 'Abroad',
  'research:overview': 'Research', 'research:report': 'War report', 'research:scout': 'Scouting',
  'travel:timed': 'Timed trips', 'travel:plan': 'Leave now', 'travel:items': 'Abroad items', 'travel:sell': 'Sell abroad', 'travel:flights': 'Flights & settings',
  'casino:blackjack': 'Blackjack', 'casino:poker': 'Poker', 'casino:highlow': 'High-Low', 'casino:games': 'Other games', 'casino:bookie': 'Bookie', 'casino:tracker': 'Tracker',
  'market:lookup': 'Item lookup', 'market:watch': 'Watchlist', 'market:deals': 'Deal finder', 'market:trade': 'Trade calculator',
};
const TAB_LAYOUT_DEFAULTS = {
  overview: { align: 'center', width: 'narrow' }, chain: { align: 'center', width: 'narrow' },
  research: { align: 'center', width: 'wide' }, faction: { align: 'center', width: 'wide' }, war: { align: 'center', width: 'medium' }, targets: { align: 'center', width: 'narrow' },
  travel: { align: 'center', width: 'full' }, market: { align: 'center', width: 'full' }, planner: { align: 'center', width: 'wide' }, casino: { align: 'center', width: 'wide' },
  alerts: { align: 'center', width: 'medium' }, settings: { align: 'center', width: 'narrow' },
};
DEFAULTS.ui.tabLayout = structuredClone(TAB_LAYOUT_DEFAULTS);
DEFAULTS.ui.themeAuto = false;
DEFAULTS.ui.pdaLinks = 'auto';
DEFAULTS.ui.tourDone = false; // the first-run tour was shown (or skipped)
// First-run setup (ui/setup.js): colours, tab bar, tabs, top bar buttons, starter alerts. Synced,
// so it shows once per person, not once per device.
DEFAULTS.ui.setupDone = false;
// Top bar buttons (and the clocks); false hides one. Ctrl+D and Ctrl+K work either way.
DEFAULTS.ui.buttons = { torn: true, pages: true, chat: true, clocks: true, account: true };
SETTABLE['ui.setupDone'] = bool;
// Condensed tabs: no profile pictures, faction tags or banners in these tabs (right-click a tab,
// or Settings → Customization). Synced, like the rest of the tab layout.
DEFAULTS.ui.condensed = [];
SETTABLE['ui.condensed'] = v => Array.isArray(v) && v.length <= TABS.length && new Set(v).size === v.length && v.every(x => TABS.includes(x));
for (const k of Object.keys(DEFAULTS.ui.buttons)) SETTABLE[`ui.buttons.${k}`] = bool;
DEFAULTS.updates = { auto: true }; // check the Mentat server for new versions (installed copies)
DEFAULTS.ui.themeDark = 'mentat';
DEFAULTS.ui.themeLight = 'sand';
// Tab order and visibility (ui/nav.js). Empty = the default layout.
DEFAULTS.ui.nav = { order: [], sub: {}, hidden: [] };
// Casino tab: your betting log and bankroll session (synced), and auto-tracking from your Torn log
// (its Full access key stays on this device; autoFrom = the newest log entry read, in seconds).
DEFAULTS.gamble = { log: {}, session: null };
DEFAULTS.casino = { logKeyEnc: '', auto: false, autoFrom: 0 };
SETTABLE['casino.auto'] = bool;
// Planner: plan items (synced, merged item by item), how many days the plan covers (synced), and
// which reminders already went off on this device (not synced).
DEFAULTS.planner = { items: {}, days: 3, fired: {} };
SETTABLE['planner.days'] = num(1, 60);
for (const t of TABS) {
  SETTABLE[`ui.tabLayout.${t}.align`] = oneOf('left', 'center', 'right');
  SETTABLE[`ui.tabLayout.${t}.width`] = oneOf('narrow', 'medium', 'wide', 'full');
}
// Flight time overrides: travel.override.<country code>|<method> = minutes (0 removes it).
const OVERRIDE_PATH = /^travel\.override\.(mex|cay|can|haw|uni|arg|swi|jap|chi|uae|sou)\|(Standard|Airstrip|Private|Business)$/;
for (const k of Object.keys(DEFAULTS.user.notify)) SETTABLE[`user.notify.${k}`] = bool;

// One-time changes to saved settings. Returns the synced settings it changed (to send to the server).
// 2026-11-18: the Mentat theme became the default; installs still on the old default (Torn Dark,
// the light pick still Daylight) move to it once. A theme someone picked themselves stays.
function migrateSettings(store) {
  const changed = [];
  if (!store.get('ui.themeMentat')) {
    if (store.get('ui.theme') === 'dark') { store.set('ui.theme', 'mentat'); changed.push('ui.theme'); }
    if (store.get('ui.themeDark') === 'dark') { store.set('ui.themeDark', 'mentat'); changed.push('ui.themeDark'); }
    if (store.get('ui.themeLight') === 'light') { store.set('ui.themeLight', 'sand'); changed.push('ui.themeLight'); }
    store.set('ui.themeMentat', true);
  }
  // 2026-11-18: the first-run setup arrived. Someone who already used Mentat here (the tour was
  // shown) has set it up, so it isn't offered to them.
  if (!store.get('ui.setupDone') && store.get('ui.tourDone')) { store.set('ui.setupDone', true); changed.push('ui.setupDone'); }
  return changed;
}

module.exports = {
  DEFAULTS, SETTABLE, TABS, TAB_LABELS, TAB_LAYOUT_DEFAULTS, THEME_BG, LIGHT_THEMES, DARK_THEMES, OVERRIDE_PATH, migrateSettings,
  bool, num, oneOf,
};
