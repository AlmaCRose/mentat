'use strict';
// Browser tabs. Each tab is a plain, sandboxed Chromium view of torn.com with no preload,
// no Node and nothing injected: Torn pages behave exactly as they would in Chrome.
// Links to other sites open in your default browser.

const { EventEmitter } = require('events');
const { WebContentsView, shell } = require('electron');

const HOME = 'https://www.torn.com/index.php';

function isTornUrl(u) {
  try {
    const x = new URL(u);
    return x.protocol === 'https:' && (x.hostname === 'torn.com' || x.hostname.endsWith('.torn.com'));
  } catch (e) {
    return false;
  }
}

// Other pages allowed in Torn browser tabs (TornTools' own pages when it's turned on).
const extraAllowed = [];
function allowInTabs(fn) {
  extraAllowed.push(fn);
}
const isTabUrl = u => isTornUrl(u) || extraAllowed.some(fn => fn(u));

function openExternal(u) {
  try {
    const x = new URL(u);
    if (x.protocol === 'https:' || x.protocol === 'http:') shell.openExternal(x.href);
  } catch (e) { /* ignore bad URLs */ }
}

// Turns what was typed in the address bar into a URL: full URLs, "torn.com/...", or a
// bare page like "gym.php" / "loader.php?sid=attack&user2ID=1".
function resolveTyped(text) {
  text = String(text || '').trim();
  if (!text) return '';
  if (/^https?:\/\//i.test(text) || /^chrome-extension:\/\//i.test(text)) return text;
  if (/^(www\.)?torn\.com/i.test(text)) return `https://${text.replace(/^www\./i, 'www.').replace(/^torn\.com/i, 'www.torn.com')}`;
  return `https://www.torn.com/${text.replace(/^\/+/, '')}`;
}

// Torn's Items page reads the #category part of the address once, when the page loads
// (otherwise it opens the last category you viewed), and ignores later changes to it. A
// full load of item.php#category works; but if the tab is already on the Items page, going
// to a new #category only scrolls, so reload the page to make Torn read it.
const LOAD_TIME_HASH = /^https:\/\/www\.torn\.com\/item\.php#./i;
function loadTornUrl(wc, url) {
  const cur = wc.getURL();
  if (LOAD_TIME_HASH.test(url) && cur && cur.split('#')[0] === url.split('#')[0]) {
    if (cur === url) return wc.reload();
    wc.once('did-navigate-in-page', () => { if (!wc.isDestroyed()) wc.reload(); });
  }
  return wc.loadURL(url);
}

class Tabs extends EventEmitter {
  constructor({ win, session, getZoom, onInput, onContextMenu }) {
    super();
    this.win = win;
    this.session = session;
    this.getZoom = getZoom;
    this.onInput = onInput;
    this.onContextMenu = onContextMenu;
    this.tabs = [];
    this.activeId = null;
    this.nextId = 1;
    this.bounds = { x: 0, y: 0, width: 800, height: 600 };
  }

  get active() {
    return this.tabs.find(t => t.id === this.activeId) || null;
  }

  create(url = HOME, { activate = true } = {}) {
    if (!isTabUrl(url)) url = HOME;
    const view = new WebContentsView({
      webPreferences: {
        session: this.session,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        spellcheck: true,
      },
    });
    view.setBackgroundColor('#191919');
    const tab = { id: this.nextId++, view, title: 'Torn', url, favicon: '', loading: true };
    this.tabs.push(tab);
    this.wire(tab);
    view.webContents.setZoomLevel(this.getZoom());
    loadTornUrl(view.webContents, url);
    if (activate || !this.activeId) this.activate(tab.id);
    else this.changed();
    return tab;
  }

  wire(tab) {
    const wc = tab.view.webContents;
    const update = () => {
      tab.url = wc.getURL() || tab.url;
      tab.title = wc.getTitle() || tab.title;
      this.changed();
    };
    wc.on('page-title-updated', update);
    wc.on('did-navigate', update);
    wc.on('did-navigate-in-page', update);
    wc.on('did-start-loading', () => { tab.loading = true; this.changed(); });
    wc.on('did-stop-loading', () => { tab.loading = false; update(); });
    wc.on('page-favicon-updated', (_e, favicons) => { tab.favicon = favicons[0] || ''; this.changed(); });

    // Keep tabs on Torn. Anything else goes to the default browser.
    const guard = (e, url) => {
      const target = (e && e.url) || url;
      if (target && !isTabUrl(target)) {
        e.preventDefault();
        openExternal(target);
      }
    };
    wc.on('will-navigate', guard);
    wc.on('will-redirect', guard);

    wc.setWindowOpenHandler(({ url, disposition }) => {
      if (isTabUrl(url)) this.create(url, { activate: disposition !== 'background-tab' });
      else openExternal(url);
      return { action: 'deny' };
    });

    wc.on('before-input-event', (e, input) => this.onInput(e, input));
    wc.on('context-menu', (_e, params) => this.onContextMenu(tab, params));
    wc.on('render-process-gone', () => { tab.title = 'Page crashed - press F5 to reload'; this.changed(); });
  }

  activate(id) {
    const next = this.tabs.find(t => t.id === id);
    if (!next) return;
    const prev = this.active;
    if (prev && prev !== next) this.win.contentView.removeChildView(prev.view);
    this.activeId = id;
    this.win.contentView.addChildView(next.view);
    next.view.setBounds(this.bounds);
    this.changed();
  }

  close(id) {
    const i = this.tabs.findIndex(t => t.id === id);
    if (i < 0) return;
    const [tab] = this.tabs.splice(i, 1);
    if (this.activeId === id) {
      this.win.contentView.removeChildView(tab.view);
      this.activeId = null;
      const next = this.tabs[Math.min(i, this.tabs.length - 1)];
      if (next) this.activate(next.id);
    }
    tab.view.webContents.close();
    if (!this.tabs.length) this.create(HOME);
    else this.changed();
  }

  cycle(step) {
    if (this.tabs.length < 2) return;
    const i = this.tabs.findIndex(t => t.id === this.activeId);
    this.activate(this.tabs[(i + step + this.tabs.length) % this.tabs.length].id);
  }

  activateIndex(i) {
    const tab = i === 'last' ? this.tabs[this.tabs.length - 1] : this.tabs[i];
    if (tab) this.activate(tab.id);
  }

  // Opens a URL typed or clicked in the app: Torn URLs load in the active tab (or a new
  // one), anything else opens in the default browser.
  open(url, { newTab = false } = {}) {
    url = resolveTyped(url);
    if (!url) return;
    if (!isTabUrl(url)) return openExternal(url);
    const tab = this.active;
    if (newTab || !tab) this.create(url);
    else loadTornUrl(tab.view.webContents, url);
  }

  setBounds(b) {
    this.bounds = b;
    const tab = this.active;
    if (tab) tab.view.setBounds(b);
  }

  setZoom(level) {
    for (const t of this.tabs) t.view.webContents.setZoomLevel(level);
  }

  activeWebContents() {
    const tab = this.active;
    return tab ? tab.view.webContents : null;
  }

  list() {
    return this.tabs.map(t => {
      const nav = t.view.webContents.navigationHistory;
      return {
        id: t.id,
        title: t.title,
        url: t.url,
        favicon: t.favicon,
        loading: t.loading,
        active: t.id === this.activeId,
        canGoBack: nav.canGoBack(),
        canGoForward: nav.canGoForward(),
      };
    });
  }

  serialize() {
    return {
      urls: this.tabs.map(t => t.url).filter(isTornUrl),
      active: Math.max(0, this.tabs.findIndex(t => t.id === this.activeId)),
    };
  }

  changed() {
    this.emit('changed');
  }
}

module.exports = { Tabs, isTornUrl, isTabUrl, allowInTabs, openExternal, loadTornUrl, HOME };
