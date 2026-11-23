'use strict';
// Two windows:
// - The tool window (always open): the app's own tabs (Overview, Chain, Targets, Travel,
//   Market, Settings). Closing it quits the app.
// - The Torn browser (browser.js): a separate window with Torn tabs, opened on demand.
//   Every Torn link in the tool opens there as a new tab.

const path = require('path');
const fs = require('fs');
const { app, BrowserWindow, session, ipcMain, Menu, Tray, clipboard, shell, screen, webContents, nativeTheme } = require('electron');
const { Store } = require('./store');
const { isTornUrl, allowInTabs, openExternal, HOME } = require('./tabs');
const { Extensions, BRIDGE: EXT_BRIDGE } = require('./extensions');
const { TornBrowser } = require('./browser');
const { ChatWindow } = require('./chatwin');
const { Popouts } = require('./popouts');
const { Updater } = require('./updater');
const { CHAT_BUNDLE } = require('./chattrim');
const { PAGES } = require('./pages');
const { createNotifier } = require('./notify');
const { Popups } = require('./popups');
const { idFromUrl } = require('./features/targets');
const { createCore } = require('./core');
const { ActivityStore } = require('./activity');
const { WarArchive } = require('./warchive');
const { exportResearch, exportIntel, copyCardImage } = require('./export');
const { readPlayerList } = require('./playerlist');

const PRELOAD = path.join(__dirname, '..', 'preload', 'ui.js');
const { APP_ICON, brandWindow } = require('./brand');

const { DEFAULTS, TAB_LABELS, THEME_BG, migrateSettings } = require('./schema');

// The app was called "Torn Desktop" until 2026-11-18. Its data folder (%APPDATA%\Torn Desktop: settings,
// encrypted keys, the Torn login, collected data) moves to %APPDATA%\Mentat once. If the move can't happen yet
// (the old version is still running), keep using the old folder; nothing is copied or deleted.
(function moveOldDataFolder() {
  const now = app.getPath('userData');
  const old = path.join(app.getPath('appData'), 'Torn Desktop');
  // Only for the normal folder (not one picked with --user-data-dir, e.g. a test copy).
  if (now !== path.join(app.getPath('appData'), 'Mentat') || !fs.existsSync(path.join(old, 'settings.json')) || fs.existsSync(path.join(now, 'settings.json'))) return;
  try {
    if (fs.existsSync(now)) fs.rmdirSync(now); // only succeeds while it's empty
    fs.renameSync(old, now);
    console.log(`Moved the data folder from ${old} to ${now}`);
  } catch (e) {
    app.setPath('userData', old);
    console.log(`Using the old data folder ${old} for now (${e.code || e.message})`);
  }
})();

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.whenReady().then(start);
}

function onScreen(b) {
  return !!b && screen.getAllDisplays().some(d => {
    const a = d.workArea;
    return b.x < a.x + a.width && b.x + b.width > a.x && b.y < a.y + a.height && b.y + b.height > a.y;
  });
}

function start() {
  app.setAppUserModelId(app.isPackaged ? 'com.mentat.app' : process.execPath);
  Menu.setApplicationMenu(null);

  const store = new Store(path.join(app.getPath('userData'), 'settings.json'), DEFAULTS);
  const migrated = migrateSettings(store);
  const tornSession = session.fromPartition('persist:torn');
  // Torn pages don't need camera, location, etc. Allow only harmless permissions.
  const ALLOWED = new Set(['clipboard-sanitized-write', 'fullscreen']);
  tornSession.setPermissionRequestHandler((_wc, perm, cb) => cb(ALLOWED.has(perm)));
  tornSession.setPermissionCheckHandler((_wc, perm) => ALLOWED.has(perm));
  // Leftover login data from the retired phone-style chat window (its own session).
  fs.rm(path.join(app.getPath('userData'), 'Partitions', 'torn-chat'), { recursive: true, force: true }, () => {});

  // ---- Colour theme: every app window asks for it while loading and hears changes. ----
  // The theme in use: the picked one, or with "match Windows" on, the dark or light pick for Windows' mode.
  function currentTheme() {
    const pick = store.get('ui.themeAuto')
      ? (nativeTheme.shouldUseDarkColors ? store.get('ui.themeDark') : store.get('ui.themeLight'))
      : store.get('ui.theme');
    return THEME_BG[pick] ? pick : 'mentat';
  }
  const themePayload = () => ({ name: currentTheme(), accent: store.get('ui.accent') || '' });
  nativeTheme.on('updated', () => { if (store.get('ui.themeAuto')) broadcastTheme(); });
  ipcMain.on('theme-get', e => { e.returnValue = themePayload(); });
  function broadcastTheme() {
    const t = themePayload();
    for (const wc of webContents.getAllWebContents()) {
      if (!wc.isDestroyed() && wc.getURL().startsWith('file:')) wc.send('theme', t);
    }
    if (!win.isDestroyed()) win.setBackgroundColor(THEME_BG[t.name]);
  }

  // ---- Tool window ----
  const saved = store.get('window.bounds');
  const win = new BrowserWindow({
    width: 1280, height: 900, minWidth: 720, minHeight: 500,
    ...(onScreen(saved) ? saved : {}),
    title: 'Mentat',
    icon: APP_ICON,
    backgroundColor: THEME_BG[currentTheme()],
    show: false,
    webPreferences: {
      preload: PRELOAD,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false, // keep countdowns and chain beeps on time when minimized
    },
  });
  brandWindow(win);
  if (store.get('window.maximized')) win.maximize();
  win.loadFile(path.join(__dirname, '..', 'ui', 'index.html'));
  win.webContents.setWindowOpenHandler(({ url }) => { openAnywhere(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', e => e.preventDefault());
  win.once('ready-to-show', () => win.show());
  win.on('focus', () => win.flashFrame(false));

  let popouts = null; // pop-out tabs, set up below
  const TOOL_ONLY = new Set(['beep', 'panel', 'panelSlot']);
  const sendTool = (channel, payload) => {
    if (!win.isDestroyed()) win.webContents.send(channel, payload);
    if (!TOOL_ONLY.has(channel) && popouts) popouts.send(channel, payload);
  };
  const focusTool = () => {
    if (win.isDestroyed()) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  };

  // ---- Torn browser window ----
  const browser = new TornBrowser({
    store,
    session: tornSession,
    preload: PRELOAD,
    onContextMenu: showContextMenu,
    onShortcut: browserShortcut,
    onPageReady: wc => linkProfileChat(wc),
  });
  // "Start a chat" on a player's profile while chat is hidden in Torn tabs (the user's request,
  // 2026-11-21). Torn's profile button only sends a "chat.openChannel" event to the page's chat,
  // which isn't loaded in tabs then. A listener in an isolated world (Torn's scripts can't see
  // it) catches that one event, and the chat window gets the same event, so Torn's own chat
  // opens the conversation there. Nothing else on the page is read.
  const CHAT_WORLD = 1002;
  const CHAT_TAG = '__mentat_chat__';
  const CHAT_LISTENER = `window.addEventListener('chat.openChannel', e => { const d = e.detail || {}; console.debug(${JSON.stringify(CHAT_TAG)} + JSON.stringify({ userId: String(d.userId || ''), nickname: String(d.nickname || '') })); }); 1`;
  const chatLinked = new WeakSet();
  function linkProfileChat(wc) {
    if (store.get('chatwin.hideInBrowser') === false) return; // chat runs in the tab itself then
    wc.executeJavaScriptInIsolatedWorld(CHAT_WORLD, [{ code: CHAT_LISTENER }]).catch(() => {});
    if (chatLinked.has(wc)) return;
    chatLinked.add(wc);
    wc.on('console-message', e => {
      const m = String((e && e.message) || '');
      if (!m.startsWith(CHAT_TAG)) return;
      let d;
      try { d = JSON.parse(m.slice(CHAT_TAG.length)); } catch (err) { return; }
      const id = Number(d.userId);
      if (!Number.isInteger(id) || id <= 0) return;
      chatwin.openChannel(id, String(d.nickname || '').slice(0, 40)).catch(err => console.error('Open chat:', err.message));
    });
  }
  browser.on('tabs', () => sendTool('browser', browserState()));
  browser.on('closed', () => sendTool('browser', browserState()));
  const browserState = () => ({ open: browser.isOpen(), tabs: browser.tabs ? browser.tabs.tabs.length : 0, url: browser.activeUrl() });

  // ---- Pop-out chat window (Torn's own page and chat, optionally on top) ----
  const chatwin = new ChatWindow({
    store,
    session: tornSession,
    preload: PRELOAD,
    openUrl: url => openAnywhere(url, true),
    onShortcut: chatShortcut,
  });
  const chatState = () => chatwin.state();

  // ---- Pop-out tabs: a tab in its own window, collapsing to a bubble ----
  popouts = new Popouts({
    store,
    preload: PRELOAD,
    isTab: id => Object.prototype.hasOwnProperty.call(TAB_LABELS, id),
    label: id => TAB_LABELS[id] || id,
    openUrl: url => openAnywhere(url, true),
    onShortcut: popShortcut,
  });
  app.on('before-quit', () => { popouts.quitting = true; }); // they reopen next time
  // Torn's chat stays out of the Torn browser's pages (setting, default on): its script
  // bundle isn't loaded there, only in the chat window. Same idea as Torn PDA's
  // "hide chat" option; the rest of the page is untouched.
  // (One handler per session, so it also serves the TornTools bridge: see extensions.js.)
  tornSession.webRequest.onBeforeRequest({ urls: [CHAT_BUNDLE, EXT_BRIDGE] }, (d, cb) => {
    if (d.url.startsWith('https://torndesktop.invalid/')) {
      handleExtBridge(d.url);
      cb({ cancel: true });
      return;
    }
    const block = store.get('chatwin.hideInBrowser') !== false && typeof d.webContentsId === 'number' && !chatwin.isPageId(d.webContentsId);
    cb({ cancel: block });
  });
  // TornTools notifications become Mentat alerts; its "open tab" requests open in
  // the Torn browser (Torn pages and TornTools' own pages only; anything else in your
  // default browser).
  function handleExtBridge(raw) {
    try {
      const u = new URL(raw);
      const q = u.searchParams;
      if (u.pathname === '/notify') notify(String(q.get('title') || 'TornTools').slice(0, 120), String(q.get('body') || '').slice(0, 300), '');
      else if (u.pathname === '/open') {
        const target = String(q.get('url') || '');
        if (isTornUrl(target) || extensions.isExtensionUrl(target)) browser.open(target, { newTab: true });
        else openExternal(target);
      }
    } catch (e) { /* ignore malformed */ }
  }

  // ---- TornTools (optional, your own copy from Chrome) ----
  const extensions = new Extensions({ store, session: tornSession, dataDir: app.getPath('userData') });
  allowInTabs(u => extensions.isExtensionUrl(u));
  extensions.on('state', () => { const st = extensions.status(); sendTool('extensions', st); browser.send('extensions', st); });
  // Load before Torn pages open so its content scripts run on them; reload any that beat it.
  extensions.load().then(ext => { if (ext && browser.tabs) for (const t of browser.tabs.tabs) t.view.webContents.reload(); });
  let ttPopup = null;
  function openTornToolsPopup() {
    if (!extensions.loaded) return;
    if (ttPopup && !ttPopup.isDestroyed()) { ttPopup.focus(); return; }
    const near = browser.isOpen() ? browser.win.getBounds() : win.getBounds();
    ttPopup = new BrowserWindow({
      width: 430, height: 640, x: near.x + near.width - 450, y: near.y + 80, title: 'TornTools', backgroundColor: '#191919',
      webPreferences: { session: tornSession, sandbox: true, contextIsolation: true },
    });
    ttPopup.removeMenu();
    ttPopup.webContents.setWindowOpenHandler(({ url }) => { if (isTornUrl(url) || extensions.isExtensionUrl(url)) browser.open(url, { newTab: true }); else openExternal(url); return { action: 'deny' }; });
    ttPopup.loadURL(extensions.pageUrl('popup.html'));
    ttPopup.on('closed', () => { ttPopup = null; });
  }
  chatwin.on('state', () => { const s = chatState(); chatwin.send('chatwin', s); chatwin.sendBubble('chatwin', s); sendTool('chatwin', s); });
  // New-message sign: Torn's chat plays a sound for new messages, in whichever Torn tab or
  // window currently plays chat sounds. The app only sees that a Torn page is making sound
  // (like a browser tab's speaker icon); it never reads the chat.
  app.on('web-contents-created', (_e, wc) => {
    wc.once('did-start-loading', () => {
      if (wc.session !== tornSession) return;
      wc.on('audio-state-changed', ev => { if (ev.audible) chatwin.ping(); });
    });
  });
  // Pinning from the chat window's bar updates the checkbox in Settings too.
  chatwin.on('settings', () => sendTool('settings', publicSettings()));

  // Torn URLs open in the Torn browser (new tab), anything else in the default browser.
  function openAnywhere(url, newTab = true) {
    if (isTornUrl(url)) browser.open(url, { newTab });
    else openExternal(url);
  }

  // ---- API, features and the link to the Mentat server: core.js (shared with the web app) ----
  const popups = new Popups({ store, preload: PRELOAD, openUrl: url => openAnywhere(url, true), beep: sound => sendTool('beep', sound) });
  const notify = createNotifier({ getWindow: () => win, openUrl: url => openAnywhere(url, true), popups, getStyle: () => store.get('ui.popupStyle') });
  const dataDir = app.getPath('userData');
  const activity = new ActivityStore(dataDir);
  const archive = new WarArchive(dataDir);
  // The Mentat server this build signs in to (another can be entered): package.json "mentat.server",
  // which scripts/dist.js fills in from mentat.local.json; when run from source, mentat.local.json.
  let defaultServer = '';
  try { defaultServer = require(path.join(__dirname, '..', '..', 'package.json')).mentat.server || ''; } catch (e) { /* none */ }
  if (!defaultServer) try { defaultServer = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'mentat.local.json'), 'utf8')).server || ''; } catch (e) { /* none */ }
  defaultServer = String(defaultServer).trim().replace(/\/+$/, '');
  // New versions from the Mentat server (installed copies; see updater.js).
  const updater = new Updater({ store, downloadPage: defaultServer ? `${defaultServer}/download` : '' });
  const core = createCore({
    store, dataDir, version: app.getVersion(), deviceName: 'Mentat for Windows', defaultServer, migrated,
    send: sendTool, notify, openUrl: (url, newTab) => openAnywhere(url, newTab),
    activity, archive, scoutLocal: true,
    // A tab is on show when the tools window is on it (or one of its sub-tabs) or a pop-out of it
    // is open as a window. Bubbles only need what their badge shows, which keeps updating anyway.
    // (Minimised or in the tray doesn't count: War's live mode and Market's refresh stop then.)
    viewing: tab => (String(store.get('ui.panel') || '').split(':')[0] === tab && !win.isDestroyed() && win.isVisible() && !win.isMinimized()) || popouts.showing(tab),
    extraFeatures: { updates: updater },
    activeUrl: () => browser.activeUrl(),
    exportResearch: p => exportResearch(p, win),
    copyImage: html => copyCardImage(html),
    exportIntel: p => exportIntel(p, win),
    publicExtra: () => ({
      popouts: { minimizeToBubble: store.get('popouts.minimizeToBubble') !== false },
      updates: { auto: store.get('updates.auto') !== false },
      chatwin: { emojis: store.get('chatwin.emojis'), onTop: store.get('chatwin.onTop'), minimizeToBubble: store.get('chatwin.minimizeToBubble'), compact: store.get('chatwin.compact'), hideInBrowser: store.get('chatwin.hideInBrowser') },
    }),
    onSetting: (p, value) => {
      if (p === 'ui.theme' || p === 'ui.accent' || p.startsWith('ui.themeAuto') || p === 'ui.themeDark' || p === 'ui.themeLight') broadcastTheme();
      if (p === 'chatwin.onTop') chatwin.setOnTop(value);
      else if (p === 'chatwin.compact') chatwin.refreshView();
      else if (p === 'chatwin.hideInBrowser' && browser.tabs) for (const t of browser.tabs.tabs) t.view.webContents.reload();
      else if (p.startsWith('chatwin.')) chatwin.emit('state');
      if (p.startsWith('ui.clock') || p === 'ui.browserClocks') browser.send('clocks', clockSettings());
    },
    onSynced: (changed, has) => {
      if (has('ui.theme') || has('ui.accent')) broadcastTheme(); // ui.themeAuto/Dark/Light too
      if ('chatwin.onTop' in changed) chatwin.setOnTop(!!changed['chatwin.onTop']);
      if (has('chatwin.')) chatwin.emit('state');
      if (has('ui.clock') || has('ui.browserClocks')) browser.send('clocks', clockSettings());
    },
  });
  const { sync, targets } = core;
  const publicSettings = () => core.publicSettings();
  // Signed out (left the faction, an admin, or the user): pop-outs close with the rest of the tools.
  sync.on('state', () => { if (!sync.signedIn() && sync.kind() === 'session') for (const id of popouts.list()) popouts.close(id); });
  // Long-term stores: save every 10 minutes (and on quit).
  setInterval(() => { try { activity.flush(); archive.flush(); } catch (e) { console.error(e); } }, 10 * 60e3).unref();

  // The browser window's toolbar shows the same clocks as the tools window.
  function clockSettings() {
    return { show: store.get('ui.browserClocks') !== false, third: store.get('ui.clockThird') !== false, zone: store.get('ui.clockZone'), h24: store.get('ui.clock24') !== false };
  }

  function setZoom(level) {
    level = Math.max(-3, Math.min(3, level));
    store.set('ui.zoom', level);
    if (browser.tabs) browser.tabs.setZoom(level);
  }

  // Native drop-down of Torn pages, shown under the button that asked for it.
  function showPagesMenu(sender, x, y) {
    const owner = BrowserWindow.fromWebContents(sender) || (browser.isChrome(sender) ? browser.win : win);
    const template = PAGES.map(([group, pages]) => ({
      label: group,
      submenu: pages.map(([label, url]) => ({ label, click: () => openAnywhere(url, true) })),
    }));
    Menu.buildFromTemplate(template).popup({ window: owner, x: Math.round(x), y: Math.round(y) });
  }

  // ---- Commands from the tool UI and the browser's tab strip ----
  const wcActive = () => browser.activeWebContents();
  const tabsDo = fn => (...args) => (browser.tabs ? fn(browser.tabs, ...args) : null);
  const COMMANDS = {
    ...core.commands,
    'init': () => ({ ...core.commands.init(), browser: browserState() }),
    'browser.init': () => ({ tabs: browser.tabs ? browser.tabs.list() : [], clocks: clockSettings() }),
    'torn.show': () => browser.show(),
    'tool.focus': () => focusTool(),
    'pages.menu': (x, y, e) => showPagesMenu(e.sender, x, y),
    'tabs.new': tabsDo(t => { t.create(HOME); }),
    'tabs.close': tabsDo((t, id) => t.close(id)),
    'tabs.activate': tabsDo((t, id) => t.activate(id)),
    'tabs.open': tabsDo((t, url, newTab) => t.open(String(url || ''), { newTab: !!newTab })),
    'tabs.back': () => { const wc = wcActive(); if (wc && wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack(); },
    'tabs.forward': () => { const wc = wcActive(); if (wc && wc.navigationHistory.canGoForward()) wc.navigationHistory.goForward(); },
    'tabs.reload': () => { const wc = wcActive(); if (wc) wc.reload(); },
    'tabs.stop': () => { const wc = wcActive(); if (wc) wc.stop(); },
    'tabs.home': tabsDo(t => t.open(HOME)),
    'tabs.focus': () => { const wc = wcActive(); if (wc) wc.focus(); },
    'updates.check': () => updater.check(),
    'updates.install': () => updater.install(),
    'ext.status': () => extensions.status(),
    // Turn TornTools on: copy it from Chrome the first time, then load it.
    'ext.enable': async on => {
      if (on) {
        if (!extensions.installed()) extensions.install();
        store.set('extensions.torntools', true);
        const ext = await extensions.load();
        if (ext && browser.tabs) for (const t of browser.tabs.tabs) t.view.webContents.reload();
      } else {
        store.set('extensions.torntools', false);
        extensions.unload();
        if (browser.tabs) for (const t of browser.tabs.tabs) t.view.webContents.reload();
      }
      return extensions.status();
    },
    'ext.update': async () => {
      extensions.unload();
      extensions.install();
      const ext = await extensions.load();
      if (ext && browser.tabs) for (const t of browser.tabs.tabs) t.view.webContents.reload();
      return extensions.status();
    },
    'ext.remove': () => { extensions.remove(); return extensions.status(); },
    'ext.options': () => { if (extensions.loaded) browser.open(extensions.pageUrl('options.html'), { newTab: true }); },
    'ext.popup': () => openTornToolsPopup(),
    'popup.action': (what, e) => popups.action(e.sender, String(what)),
    'pop.open': id => popouts.open(String(id)),
    'pop.state': ctx => popouts.state(ctx.popId || ctx.bubbleId),
    'pop.badge': (ctx, b) => { if (ctx.popId) popouts.setBadge(ctx.popId, b); },
    'pop.collapse': ctx => { if (ctx.popId) popouts.collapse(ctx.popId); },
    'pop.onTop': (ctx, on) => { if (ctx.popId) popouts.setOnTop(ctx.popId, !!on); },
    'pop.close': ctx => { if (ctx.popId) popouts.close(ctx.popId); },
    // From a pop-out: show a tab in the tools window instead (a link to another tab, say).
    'pop.toMain': (ctx, id) => { focusTool(); sendTool('panel', String(id || ctx.popId || 'overview')); },
    'pop.bubbleDrag': (ctx, phase) => { if (ctx.bubbleId) (phase === 'start' ? popouts.dragStart(ctx.bubbleId) : popouts.dragEnd(ctx.bubbleId)); },
    'pop.bubbleMenu': ctx => {
      const id = ctx.bubbleId;
      const p = id && popouts.pops.get(id);
      if (!p || !p.bubble) return;
      const showing = !p.collapsed && p.win.isVisible();
      Menu.buildFromTemplate([
        showing ? { label: `Hide ${TAB_LABELS[id]}`, click: () => popouts.collapse(id) } : { label: `Open ${TAB_LABELS[id]}`, click: () => popouts.show(id) },
        { label: 'Keep the window on top', type: 'checkbox', checked: popouts.state(id).onTop, click: m => popouts.setOnTop(id, m.checked) },
        { label: 'Show in the tools window', click: () => { focusTool(); sendTool('panel', id); } },
        { type: 'separator' },
        { label: 'Move bubble back to the side', click: () => popouts.resetBubble(id) },
        { label: 'Close pop-out', click: () => popouts.close(id) },
      ]).popup({ window: p.bubble });
    },
    'chatwin.open': () => chatwin.show(),
    'chatwin.toggle': () => chatwin.toggle(),
    'chatwin.init': () => chatState(),
    'chatwin.onTop': on => chatwin.setOnTop(!!on),
    'chatwin.insert': text => chatwin.insert(String(text || '')),
    'chatwin.emojiPanel': () => chatwin.emojiPanel(),
    'chatwin.reload': () => chatwin.reload(),
    'chatwin.collapse': () => chatwin.collapse(),
    'chatwin.bubbleDrag': phase => (phase === 'start' ? chatwin.dragStart() : chatwin.dragEnd()),
    'chatwin.bubbleMenu': () => {
      if (!chatwin.bubble) return;
      Menu.buildFromTemplate([
        chatwin.collapsed ? { label: 'Open chat', click: () => chatwin.expand() } : { label: 'Hide chat', click: () => chatwin.collapse() },
        { label: 'Mark as read', enabled: chatwin.unread > 0, click: () => chatwin.clearUnread() },
        { label: 'Show Mentat tools', click: focusTool },
        { type: 'separator' },
        { label: 'Move bubble back to the corner', click: () => { store.set('chatwin.bubble', null); chatwin.bubble.setBounds(chatwin.bubbleBounds()); } },
        { label: 'Close chat', click: () => chatwin.close() },
      ]).popup({ window: chatwin.bubble });
    },
  };
  // The browser's tab strip may only drive tabs and navigation.
  const CHROME_ALLOWED = new Set(['browser.init', 'tool.focus', 'pages.menu', 'tabs.new', 'tabs.close', 'tabs.activate', 'tabs.open', 'tabs.back', 'tabs.forward', 'tabs.reload', 'tabs.stop', 'tabs.home', 'tabs.focus', 'chatwin.open', 'ext.status', 'ext.popup', 'ext.options']);
  // The chat window's bar may only drive the chat window.
  const CHAT_ALLOWED = new Set(['tool.focus', 'chatwin.init', 'chatwin.onTop', 'chatwin.insert', 'chatwin.emojiPanel', 'chatwin.reload', 'chatwin.collapse']);
  // The bubble may only be dragged, opened and show its menu.
  const BUBBLE_ALLOWED = new Set(['chatwin.init', 'chatwin.bubbleDrag', 'chatwin.bubbleMenu']);
  // A pop-out's bubble likewise (its own pop-out only).
  const POP_BUBBLE_ALLOWED = new Set(['pop.state', 'pop.bubbleDrag', 'pop.bubbleMenu']);

  ipcMain.handle('cmd', async (e, name, ...args) => {
    // Pop-out tabs are the tools window's own page, so they may do what it does.
    const popId = popouts.idOf(e.sender);
    const bubbleId = popouts.bubbleIdOf(e.sender);
    const fromTool = (!win.isDestroyed() && e.sender === win.webContents) || !!popId;
    const fromChrome = browser.isChrome(e.sender);
    const fromChat = chatwin.isBar(e.sender);
    const fromBubble = chatwin.isBubble(e.sender);
    // A popup may only act on itself (open its page, close, hold open).
    const fromPopup = popups.isPopup(e.sender) && name === 'popup.action';
    if (!fromTool && !(fromChrome && CHROME_ALLOWED.has(name)) && !(fromChat && CHAT_ALLOWED.has(name)) && !(fromBubble && BUBBLE_ALLOWED.has(name)) && !(bubbleId && POP_BUBBLE_ALLOWED.has(name)) && !fromPopup) throw new Error('Not allowed');
    const fn = COMMANDS[name];
    if (!fn) throw new Error(`Unknown command ${name}`);
    const ctx = { popId, bubbleId };
    const result = await (name === 'pages.menu' ? fn(args[0], args[1], e) : name === 'popup.action' ? fn(args[0], e)
      : name.startsWith('pop.') && name !== 'pop.open' ? fn(ctx, ...args) : fn(...args));
    if (fromTool) sync.afterCommand(name, args); // synced settings go to the sync server
    return result === undefined ? null : result;
  });

  // ---- Keyboard shortcuts ----
  // In the Torn browser (pages and tab strip).
  function browserShortcut(e, input, b) {
    if (input.type !== 'keyDown') return;
    const key = input.key.toLowerCase();
    const ctrl = input.control || input.meta;
    const t = b.tabs;
    const wc = b.activeWebContents();
    let handled = true;
    if (!t) handled = false;
    else if (ctrl && key === 't') t.create(HOME);
    else if (ctrl && key === 'w') { if (t.active) t.close(t.active.id); }
    else if (ctrl && key === 'tab') t.cycle(input.shift ? -1 : 1);
    else if (ctrl && /^[1-8]$/.test(key)) t.activateIndex(Number(key) - 1);
    else if (ctrl && key === '9') t.activateIndex('last');
    else if ((ctrl && key === 'r') || key === 'f5') { if (wc) (input.shift ? wc.reloadIgnoringCache() : wc.reload()); }
    else if (input.alt && key === 'arrowleft') COMMANDS['tabs.back']();
    else if (input.alt && key === 'arrowright') COMMANDS['tabs.forward']();
    else if (ctrl && key === 'l') { b.chrome.webContents.focus(); b.send('focus-address'); }
    else if (ctrl && (key === '=' || key === '+')) setZoom((store.get('ui.zoom') || 0) + 0.5);
    else if (ctrl && key === '-') setZoom((store.get('ui.zoom') || 0) - 0.5);
    else if (ctrl && key === '0') setZoom(0);
    else if (key === 'f11') b.win.setFullScreen(!b.win.isFullScreen());
    else if (key === 'f12') { if (wc) wc.toggleDevTools(); }
    else if (ctrl && input.shift && key === 'i') b.chrome.webContents.toggleDevTools();
    else if (ctrl && key === 'd') focusTool();
    else if (ctrl && key === 'k') chatwin.toggle();
    else handled = false;
    if (handled) e.preventDefault();
  }
  // In the chat window (page and bar).
  function chatShortcut(e, input, c) {
    if (input.type !== 'keyDown') return;
    const key = input.key.toLowerCase();
    const ctrl = input.control || input.meta;
    const wc = c.view ? c.view.webContents : null;
    let handled = true;
    if ((ctrl && key === 'r') || key === 'f5') c.reload();
    else if (ctrl && (key === '=' || key === '+')) c.setZoom((store.get('chatwin.zoom') || 0) + 0.5);
    else if (ctrl && key === '-') c.setZoom((store.get('chatwin.zoom') || 0) - 0.5);
    else if (ctrl && key === '0') c.setZoom(0);
    else if (ctrl && key === 'd') focusTool();
    else if (ctrl && key === 'k') c.collapse();
    else if (key === 'f12') { if (wc) wc.toggleDevTools(); }
    else handled = false;
    if (handled) e.preventDefault();
  }
  // In a pop-out tab's window.
  function popShortcut(e, input, id) {
    if (input.type !== 'keyDown') return;
    const key = input.key.toLowerCase();
    const ctrl = input.control || input.meta;
    let handled = true;
    if (ctrl && key === 'w') popouts.close(id);
    else if (ctrl && key === 'd') browser.show();
    else if (ctrl && key === 'k') chatwin.toggle();
    else if (ctrl && input.shift && key === 'i') { const p = popouts.pops.get(id); if (p) p.win.webContents.toggleDevTools(); }
    else handled = false;
    if (handled) e.preventDefault();
  }
  // In the tool window.
  win.webContents.on('before-input-event', (e, input) => {
    if (input.type !== 'keyDown') return;
    const key = input.key.toLowerCase();
    const ctrl = input.control || input.meta;
    let handled = true;
    if (ctrl && key === 't') browser.open(HOME, { newTab: true });
    else if (ctrl && key === 'd') browser.show();
    else if (ctrl && key === 'k') chatwin.toggle();
    else if (ctrl && input.shift && key === 'i') win.webContents.toggleDevTools();
    else if (ctrl && /^[0-9]$/.test(key)) sendTool('panelSlot', (Number(key) + 9) % 10); // in the user's tab order
    else handled = false;
    if (handled) e.preventDefault();
  });

  // ---- Right-click menu in Torn pages ----
  // "Add all players in this list to targets" (the user's request, 2026-11-21): the one place
  // besides the chat trimming where Mentat reads a Torn page, and only when you pick it. It runs
  // once in an isolated world (Torn's scripts can't see or change it), reads the player links of
  // the list around the link you right-clicked, and changes nothing on the page.
  const LIST_WORLD = 1001;
  // While you're abroad (or flying out) these go to the Abroad list, else to Targets.
  async function addListPlayers(wc, p, which) {
    const z = wc.getZoomFactor() || 1;
    let r = null;
    try {
      r = await wc.executeJavaScriptInIsolatedWorld(LIST_WORLD, [{ code: `(${readPlayerList.toString()})(${Math.round(p.x / z)}, ${Math.round(p.y / z)}, ${JSON.stringify(p.linkURL)})` }]);
    } catch (e) { console.error('Read player list:', e.message); }
    const players = r && Array.isArray(r.players) ? r.players : [];
    const meId = ((core.api.status().account) || {}).id || 0;
    const own = core.war.state.own ? core.war.state.own.id : 0;
    const keep = players.filter(x => x.id !== meId && !(own && x.factionId === own));
    if (!keep.length) {
      notify('Targets', players.length ? 'Nobody to add: everyone in that list is you or in your faction.' : "Couldn't find a list of players around that link.", '');
      return;
    }
    core.ffscouter.refreshSoon();
    const res = targets.addPlayers(keep, 'list', which);
    const already = keep.length - res.added;
    const skipped = players.length - keep.length;
    const notes = [];
    if (already) notes.push(res.full ? `${already} not added: already listed or the list is full at 250` : `${already} already listed`);
    if (skipped) notes.push(`${skipped} skipped (you or your faction)`);
    notify('Targets', `Added ${res.added} player${res.added === 1 ? '' : 's'} to ${which === 'abroad' ? 'the Abroad list' : 'Targets'}${notes.length ? `; ${notes.join(', ')}` : ''}.`, '');
  }
  // One player from a right-click: says so when they're already listed (nobody is listed twice).
  function addOnePlayer(id, which) {
    const label = which === 'abroad' ? 'the Abroad list' : 'Targets';
    const res = which === 'abroad' ? targets.addPlayers([{ id }], '', 'abroad') : targets.add(String(id));
    notify('Targets', res.added ? `Added player ${id} to ${label}.` : `Player ${id} is already on ${label}.`, '');
  }

  function showContextMenu(tab, p, b) {
    const wc = tab.view.webContents;
    const items = [];
    if (p.linkURL) {
      const id = idFromUrl(p.linkURL);
      items.push(
        { label: 'Open link in new tab', click: () => openAnywhere(p.linkURL, true) },
        { label: 'Copy link address', click: () => clipboard.writeText(p.linkURL) },
      );
      if (id && /profiles\.php|user2ID=/i.test(p.linkURL)) {
        const which = targets.here() ? 'abroad' : 'home';
        const to = which === 'abroad' ? 'Abroad targets' : 'targets';
        items.push(
          { label: `Add player ${id} to ${to}`, click: () => addOnePlayer(id, which) },
          { label: `Add all players in this list to ${to}`, click: () => addListPlayers(wc, p, which).catch(e => console.error('Add list players:', e)) },
        );
      }
      items.push({ type: 'separator' });
    }
    if (p.isEditable) {
      items.push({ role: 'cut', enabled: p.editFlags.canCut }, { role: 'copy', enabled: p.editFlags.canCopy }, { role: 'paste', enabled: p.editFlags.canPaste }, { role: 'selectAll' }, { type: 'separator' });
    } else if (p.selectionText) {
      items.push({ role: 'copy' }, { type: 'separator' });
    }
    const pageId = idFromUrl(tab.url);
    if (pageId && !p.linkURL) { const which = targets.here() ? 'abroad' : 'home'; items.push({ label: `Add player ${pageId} to ${which === 'abroad' ? 'Abroad targets' : 'targets'}`, click: () => addOnePlayer(pageId, which) }, { type: 'separator' }); }
    items.push(
      { label: 'Back', enabled: wc.navigationHistory.canGoBack(), click: () => wc.navigationHistory.goBack() },
      { label: 'Forward', enabled: wc.navigationHistory.canGoForward(), click: () => wc.navigationHistory.goForward() },
      { label: 'Reload', click: () => wc.reload() },
      { type: 'separator' },
      { label: 'Copy page address', click: () => clipboard.writeText(tab.url) },
      { label: 'Show Mentat tools', click: focusTool },
      { label: 'Inspect', click: () => wc.inspectElement(p.x, p.y) },
    );
    Menu.buildFromTemplate(items).popup({ window: b.win });
  }

  // ---- System tray: closing the tools window keeps the app running (and collecting
  // travel data) unless "Keep running in the tray" is turned off. ----
  let quitting = false;
  app.on('before-quit', () => { quitting = true; });
  let tray = null;
  Promise.resolve(APP_ICON).then(icon => {
    tray = new Tray(icon);
    tray.setToolTip('Mentat');
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'Show Mentat', click: focusTool },
      { label: 'Open Torn', click: () => browser.show() },
      { label: 'Open chat', click: () => chatwin.show() },
      { type: 'separator' },
      { label: 'Quit', click: () => { quitting = true; app.quit(); } },
    ]));
    tray.on('click', focusTool);
  }).catch(e => console.error('Tray icon unavailable', e));

  // ---- Start up / shut down ----
  if (store.get('ui.openTornOnStart')) browser.ensure();
  win.webContents.once('did-finish-load', () => popouts.restore());

  app.on('second-instance', focusTool);

  win.on('close', e => {
    if (!quitting && tray && store.get('ui.closeToTray')) {
      e.preventDefault();
      win.hide();
      if (!store.get('ui.trayHintShown')) {
        store.set('ui.trayHintShown', true);
        notify('Mentat is still running', 'It keeps collecting travel data and alerts in the system tray. Right-click the tray icon to quit.');
      }
      return;
    }
    browser.saveState();
    chatwin.saveState();
    store.set('window.maximized', win.isMaximized());
    if (!win.isMaximized() && !win.isMinimized() && !win.isFullScreen()) store.set('window.bounds', win.getBounds());
    core.stop();
    core.flushAll();
  });
  // Really closing the tool (quit, or tray turned off) closes everything.
  win.on('closed', () => {
    browser.close();
    chatwin.close();
    popups.closeAll();
    if (tray) tray.destroy();
    app.quit();
  });
}

app.on('window-all-closed', () => app.quit());
