'use strict';
// The Torn browser: a separate window with its own tab strip and address bar. Created on
// demand ("Open Torn" or any Torn link in the tool), closed independently of the tool, and
// it remembers its tabs and position.

const path = require('path');
const { EventEmitter } = require('events');
const { BaseWindow, WebContentsView, screen } = require('electron');
const { APP_ICON, brandWindow } = require('./brand');
const { Tabs, isTornUrl, isTabUrl, HOME } = require('./tabs');

const HEADER_H = 76;

function onScreen(b) {
  return !!b && screen.getAllDisplays().some(d => {
    const a = d.workArea;
    return b.x < a.x + a.width && b.x + b.width > a.x && b.y < a.y + a.height && b.y + b.height > a.y;
  });
}

class TornBrowser extends EventEmitter {
  constructor({ store, session, preload, onContextMenu, onShortcut, onPageReady = null }) {
    super();
    this.onPageReady = onPageReady;
    this.store = store;
    this.session = session;
    this.preload = preload;
    this.onContextMenu = onContextMenu;
    this.onShortcut = onShortcut;
    this.win = null;
    this.chrome = null;
    this.tabs = null;
    this.ready = null;
  }

  isOpen() {
    return !!this.win && !this.win.isDestroyed();
  }

  // Opens the window if needed. Restores the last session unless `firstUrl` is given.
  ensure(firstUrl = '') {
    if (this.isOpen()) return this.ready;
    const saved = this.store.get('browser.bounds');
    const win = new BaseWindow({
      width: 1300, height: 900, minWidth: 700, minHeight: 500,
      ...(onScreen(saved) ? saved : {}),
      title: 'Torn',
      icon: APP_ICON,
      backgroundColor: '#191919',
      show: false,
    });
    brandWindow(win);
    if (this.store.get('browser.maximized')) win.maximize();
    const chrome = new WebContentsView({
      webPreferences: { preload: this.preload, sandbox: true, contextIsolation: true, nodeIntegration: false },
    });
    chrome.setBackgroundColor('#111111');
    win.contentView.addChildView(chrome);
    chrome.webContents.loadFile(path.join(__dirname, '..', 'ui', 'browser.html'));
    chrome.webContents.on('will-navigate', e => e.preventDefault());
    chrome.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    chrome.webContents.on('before-input-event', (e, input) => this.onShortcut(e, input, this));

    const tabs = new Tabs({
      win,
      session: this.session,
      getZoom: () => this.store.get('ui.zoom') || 0,
      onInput: (e, input) => this.onShortcut(e, input, this),
      onContextMenu: (tab, params) => this.onContextMenu(tab, params, this),
      onPageReady: wc => this.onPageReady && this.onPageReady(wc),
    });
    tabs.on('changed', () => {
      this.send('tabs', tabs.list());
      const t = tabs.active;
      if (!win.isDestroyed()) win.setTitle(t ? `${t.title} - Torn` : 'Torn');
      this.emit('tabs');
    });

    this.win = win;
    this.chrome = chrome;
    this.tabs = tabs;

    const layout = () => {
      if (win.isDestroyed()) return;
      const [w, h] = win.getContentSize();
      chrome.setBounds({ x: 0, y: 0, width: w, height: h });
      tabs.setBounds({ x: 0, y: HEADER_H, width: w, height: Math.max(100, h - HEADER_H) });
    };
    win.on('resize', layout);
    win.on('focus', () => win.flashFrame(false));
    win.on('app-command', (_e, cmd) => {
      const wc = tabs.activeWebContents();
      if (!wc) return;
      if (cmd === 'browser-backward' && wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack();
      if (cmd === 'browser-forward' && wc.navigationHistory.canGoForward()) wc.navigationHistory.goForward();
    });
    win.on('close', () => this.saveState());
    win.on('closed', () => {
      // Closing the window doesn't stop the pages inside it; close every tab and the strip.
      for (const t of tabs.tabs) if (!t.view.webContents.isDestroyed()) t.view.webContents.close();
      if (!chrome.webContents.isDestroyed()) chrome.webContents.close();
      this.win = null;
      this.chrome = null;
      this.tabs = null;
      this.emit('closed');
    });

    this.ready = new Promise(resolve => {
      chrome.webContents.once('did-finish-load', () => {
        if (firstUrl && isTabUrl(firstUrl)) tabs.create(firstUrl);
        else {
          const { urls, active } = this.store.get('session') || {};
          const restore = (urls || []).filter(isTornUrl);
          if (!restore.length) restore.push(HOME);
          restore.forEach((u, i) => tabs.create(u, { activate: i === Math.min(active || 0, restore.length - 1) }));
        }
        layout();
        win.show();
        resolve();
      });
    });
    layout();
    return this.ready;
  }

  saveState() {
    if (!this.isOpen()) return;
    if (this.tabs) this.store.set('session', this.tabs.serialize());
    this.store.set('browser.maximized', this.win.isMaximized());
    if (!this.win.isMaximized() && !this.win.isMinimized() && !this.win.isFullScreen()) this.store.set('browser.bounds', this.win.getBounds());
  }

  // Opens a Torn URL in the browser window (a new tab by default) and brings it forward.
  async open(url, { newTab = true } = {}) {
    if (!this.isOpen()) {
      await this.ensure(url && isTabUrl(url) ? url : '');
      this.focus();
      if (!url || isTabUrl(url)) return;
    }
    if (url) this.tabs.open(url, { newTab });
    this.focus();
  }

  async show() {
    await this.ensure();
    this.focus();
  }

  focus() {
    if (!this.isOpen()) return;
    if (this.win.isMinimized()) this.win.restore();
    this.win.show();
    this.win.focus();
  }

  close() {
    if (this.isOpen()) this.win.close();
  }

  activeUrl() {
    return this.tabs && this.tabs.active ? this.tabs.active.url : '';
  }

  activeWebContents() {
    return this.tabs ? this.tabs.activeWebContents() : null;
  }

  send(channel, payload) {
    if (this.chrome && !this.chrome.webContents.isDestroyed()) this.chrome.webContents.send(channel, payload);
  }

  isChrome(wc) {
    return !!this.chrome && wc === this.chrome.webContents;
  }
}

module.exports = { TornBrowser, HOME };
