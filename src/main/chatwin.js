'use strict';
// Pop-out chat: a compact window showing Torn's own page (and so Torn's own chat) with your
// login, that can stay on top of other windows. With the compact view setting (default on)
// the page is trimmed to the chat with one open chat at a time (display only, chattrim.js).
// A small bar under it pins the window on top and types emojis into the chat box the same
// way the keyboard (or Windows' emoji panel) does.
// Links clicked in the page open in the Torn browser, so the chat window stays on chat.
// (A phone browser identity was tried for Torn's one-chat-at-a-time layout, but Cloudflare
// rightly flags a "phone" that otherwise looks like Windows; don't disguise the browser.)

const path = require('path');
const { EventEmitter } = require('events');
const { app, BaseWindow, BrowserWindow, WebContentsView, screen } = require('electron');
const { APP_ICON, brandWindow } = require('./brand');
const { isTornUrl, openExternal } = require('./tabs');
const { CHAT_TRIM_CSS, CHAT_TRIM_JS } = require('./chattrim');

const BAR_H = 40;
const BUBBLE_SIZE = 72;
const CHAT_HOME = 'https://www.torn.com/index.php';
// Logging in, two-step checks and Torn's bot check stay in the chat window.
const SIGN_IN = /\/(cdn-cgi\/|login|logout|authenticat|signin|sign-in|2fa|verify|captcha|register|recover|password)|[?&]sid=(login|logout|auth)/i;

function onScreen(b) {
  return !!b && screen.getAllDisplays().some(d => {
    const a = d.workArea;
    return b.x < a.x + a.width && b.x + b.width > a.x && b.y < a.y + a.height && b.y + b.height > a.y;
  });
}

const samePage = (a, b) => {
  try {
    const x = new URL(a), y = new URL(b);
    return x.origin === y.origin && x.pathname === y.pathname;
  } catch (e) {
    return false;
  }
};

// The chat window's own pages: Torn's home page (index.php, or the bare address it may show).
const isChatPage = u => {
  if (samePage(u, CHAT_HOME)) return true;
  try { return isTornUrl(u) && new URL(u).pathname === '/'; } catch (e) { return false; }
};
// A Torn page that belongs in the Torn browser rather than the chat window.
const awayFromChat = u => isTornUrl(u) && !isChatPage(u) && !SIGN_IN.test(u);

class ChatWindow extends EventEmitter {
  constructor({ store, session, preload, openUrl, onShortcut }) {
    super();
    this.store = store;
    this.session = session;
    this.preload = preload;
    this.openUrl = openUrl;
    this.onShortcut = onShortcut;
    this.win = null;
    this.bar = null;
    this.view = null;
    this.bubble = null;
    this.collapsed = false;
    this.unread = 0;
    this.drag = null;
  }

  isOpen() {
    return !!this.win && !this.win.isDestroyed();
  }


  state() {
    return {
      open: this.isOpen(), collapsed: this.collapsed, unread: this.unread,
      onTop: this.store.get('chatwin.onTop') !== false, emojis: this.store.get('chatwin.emojis'),
    };
  }

  show() {
    if (this.isOpen()) {
      const wasCollapsed = this.collapsed;
      this.collapsed = false;
      // The bubble stays while the chat is open: clicking it hides the chat again.
      this.showBubble();
      if (this.win.isMinimized()) this.win.restore();
      this.win.show();
      this.win.focus();
      this.clearUnread();
      if (wasCollapsed) this.emit('state');
      return;
    }
    const saved = this.store.get('chatwin.bounds');
    const win = new BaseWindow({
      width: 440, height: 760, minWidth: 320, minHeight: 360,
      ...(onScreen(saved) ? saved : {}),
      title: 'Torn Chat',
      icon: APP_ICON,
      backgroundColor: '#191919',
      alwaysOnTop: this.store.get('chatwin.onTop') !== false,
      show: false,
    });
    brandWindow(win);

    const bar = new WebContentsView({
      webPreferences: { preload: this.preload, sandbox: true, contextIsolation: true, nodeIntegration: false },
    });
    bar.setBackgroundColor('#111111');
    bar.webContents.loadFile(path.join(__dirname, '..', 'ui', 'chatwin.html'));
    bar.webContents.on('will-navigate', e => e.preventDefault());
    bar.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

    const view = new WebContentsView({
      // Not throttled while collapsed to the bubble, so the chat stays live in the background.
      webPreferences: {
        session: this.session,
        sandbox: true, contextIsolation: true, nodeIntegration: false, spellcheck: true, backgroundThrottling: false,
      },
    });
    view.setBackgroundColor('#191919');
    const wc = view.webContents;
    wc.setZoomLevel(this.store.get('chatwin.zoom') || 0);
    // Compact view (setting): chat only, one open chat at a time. See chattrim.js.
    wc.on('dom-ready', () => {
      if (this.store.get('chatwin.compact') === false) return;
      wc.insertCSS(CHAT_TRIM_CSS).catch(() => {});
      wc.executeJavaScript(CHAT_TRIM_JS).catch(() => {});
    });
    wc.loadURL(CHAT_HOME);

    // Keep the chat window on its page: other Torn pages (a profile from clicking a name in
    // chat, say) open in the Torn browser. Logging in and Torn's checks stay in this window.
    wc.on('will-navigate', e => {
      const target = e.url;
      if (!isTornUrl(target)) { e.preventDefault(); openExternal(target); return; }
      if (awayFromChat(target) && !SIGN_IN.test(wc.getURL())) {
        e.preventDefault();
        this.openUrl(target);
      }
    });
    // Safety nets for page changes that don't ask first: Torn's in-page routing (the address
    // changes by script) and redirects. That page opens in the Torn browser and the chat comes
    // back. At most once every 10 s, so a page that keeps redirecting can't open tab after tab.
    const bounce = (url, back) => {
      if (Date.now() - (this.bouncedAt || 0) < 10000) return;
      this.bouncedAt = Date.now();
      this.openUrl(url);
      back();
    };
    wc.on('did-navigate-in-page', (_e, url, isMainFrame) => {
      if (!isMainFrame || !awayFromChat(url)) return;
      bounce(url, () => {
        const h = wc.navigationHistory;
        if (h && h.canGoBack()) h.goBack();
        else wc.loadURL(CHAT_HOME);
      });
    });
    wc.on('did-navigate', (_e, url) => {
      if (awayFromChat(url)) bounce(url, () => wc.loadURL(CHAT_HOME));
    });
    wc.setWindowOpenHandler(({ url }) => { this.openUrl(url); return { action: 'deny' }; });
    wc.on('page-title-updated', () => { if (!win.isDestroyed()) win.setTitle('Torn Chat'); });
    wc.on('before-input-event', (e, input) => this.onShortcut(e, input, this));
    bar.webContents.on('before-input-event', (e, input) => this.onShortcut(e, input, this));

    win.contentView.addChildView(bar);
    win.contentView.addChildView(view);
    const layout = () => {
      if (win.isDestroyed()) return;
      const [w, h] = win.getContentSize();
      // Page on top, bar (emojis, pin, collapse) along the bottom next to Torn's chat box.
      const pageH = Math.max(100, h - BAR_H);
      view.setBounds({ x: 0, y: 0, width: w, height: pageH });
      bar.setBounds({ x: 0, y: pageH, width: w, height: BAR_H });
    };
    win.on('resize', layout);
    layout();
    win.on('close', () => this.saveState());
    win.on('focus', () => this.clearUnread());
    // Minimizing collapses to the bubble instead, so the chat keeps a visible sign.
    win.on('minimize', () => { if (this.store.get('chatwin.minimizeToBubble') !== false) setImmediate(() => this.collapse()); });
    win.on('closed', () => {
      // Closing a window doesn't stop the pages inside it; close them so Torn's chat really
      // disconnects (and can't touch the closed window).
      for (const v of [view, bar]) if (!v.webContents.isDestroyed()) v.webContents.close();
      this.win = null;
      this.bar = null;
      this.view = null;
      this.collapsed = false;
      this.unread = 0;
      this.destroyBubble();
      this.emit('state');
    });
    bar.webContents.once('did-finish-load', () => {
      if (win.isDestroyed()) return;
      win.show();
      this.showBubble();
      this.emit('state');
    });

    this.win = win;
    this.bar = bar;
    this.view = view;
  }

  saveState() {
    if (!this.isOpen()) return;
    if (!this.win.isMaximized() && !this.win.isMinimized() && !this.win.isFullScreen()) this.store.set('chatwin.bounds', this.win.getBounds());
  }

  close() {
    if (this.isOpen()) this.win.close();
  }

  // Chat button / Ctrl+K: open, collapse to the bubble, or expand from it.
  toggle() {
    if (this.isOpen() && this.win.isVisible() && !this.win.isMinimized()) this.collapse();
    else this.show();
  }

  // ---- Bubble: the chat window collapses into a small draggable circle that stays on top
  // and lights up when Torn's chat plays its new-message sound. ----
  collapse() {
    if (!this.isOpen()) return;
    this.saveState();
    if (this.win.isMinimized()) this.win.restore();
    this.win.hide();
    this.collapsed = true;
    this.showBubble();
    this.emit('state');
  }

  expand() {
    this.show();
  }

  bubbleBounds() {
    const size = BUBBLE_SIZE;
    const saved = this.store.get('chatwin.bubble');
    if (saved && onScreen({ ...saved, width: size, height: size })) return { x: saved.x, y: saved.y, width: size, height: size };
    const a = screen.getPrimaryDisplay().workArea;
    return { x: a.x + a.width - size - 24, y: a.y + Math.round(a.height * 0.6), width: size, height: size };
  }

  showBubble() {
    if (this.bubble && !this.bubble.isDestroyed()) {
      this.bubble.showInactive();
      return;
    }
    const b = new BrowserWindow({
      ...this.bubbleBounds(),
      frame: false, transparent: true, resizable: false, maximizable: false, minimizable: false, fullscreenable: false,
      alwaysOnTop: true, skipTaskbar: true, hasShadow: false, show: false, title: 'Torn Chat',
      webPreferences: { preload: this.preload, sandbox: true, contextIsolation: true, nodeIntegration: false },
    });
    b.setAlwaysOnTop(true, 'floating');
    b.loadFile(path.join(__dirname, '..', 'ui', 'bubble.html'));
    b.webContents.on('will-navigate', e => e.preventDefault());
    b.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    b.once('ready-to-show', () => { if (this.isOpen()) b.showInactive(); this.emit('state'); });
    b.on('closed', () => { this.bubble = null; });
    this.bubble = b;
  }

  hideBubble() {
    if (this.bubble && !this.bubble.isDestroyed()) this.bubble.hide();
  }

  destroyBubble() {
    this.stopDrag();
    if (this.bubble && !this.bubble.isDestroyed()) this.bubble.destroy();
    this.bubble = null;
  }

  isBubble(wc) {
    return !!this.bubble && !this.bubble.isDestroyed() && wc === this.bubble.webContents;
  }

  // Dragging: the bubble follows the mouse pointer from where it was grabbed. A press that
  // barely moves counts as a click and opens the chat.
  dragStart() {
    if (!this.bubble || this.bubble.isDestroyed()) return;
    this.stopDrag();
    const p = screen.getCursorScreenPoint();
    const [x, y] = this.bubble.getPosition();
    const drag = { dx: p.x - x, dy: p.y - y, start: p, moved: false };
    drag.timer = setInterval(() => {
      if (!this.bubble || this.bubble.isDestroyed()) return this.stopDrag();
      const c = screen.getCursorScreenPoint();
      if (Math.abs(c.x - drag.start.x) + Math.abs(c.y - drag.start.y) > 6) drag.moved = true;
      if (drag.moved) this.bubble.setPosition(c.x - drag.dx, c.y - drag.dy);
      return null;
    }, 16);
    // Safety net if the release is never reported.
    drag.limit = setTimeout(() => this.dragEnd(), 60000);
    this.drag = drag;
  }

  dragEnd() {
    const drag = this.drag;
    this.stopDrag();
    if (!drag || !this.bubble || this.bubble.isDestroyed()) return;
    if (drag.moved) {
      const [x, y] = this.bubble.getPosition();
      this.store.set('chatwin.bubble', { x, y });
    } else {
      // A click toggles: hide the chat if it's showing, bring it back if it's hidden.
      if (!this.collapsed && this.isOpen() && this.win.isVisible() && !this.win.isMinimized()) this.collapse();
      else this.expand();
    }
  }

  stopDrag() {
    if (!this.drag) return;
    clearInterval(this.drag.timer);
    clearTimeout(this.drag.limit);
    this.drag = null;
  }

  // Torn's chat played its new-message sound (in the chat window or any Torn tab).
  // Several sounds within a couple of seconds (one burst of messages) count once.
  ping() {
    if (!this.isOpen()) return;
    if (!this.collapsed && this.win.isFocused()) return;
    const now = Date.now();
    if (now - (this.lastPing || 0) < 2500) return;
    this.lastPing = now;
    this.unread = Math.min(this.unread + 1, 99);
    this.emit('state');
    if (this.collapsed && this.bubble && !this.bubble.isDestroyed()) this.bubble.showInactive();
  }

  clearUnread() {
    if (!this.unread) return;
    this.unread = 0;
    this.emit('state');
  }

  sendBubble(channel, payload) {
    if (this.bubble && !this.bubble.isDestroyed()) this.bubble.webContents.send(channel, payload);
  }

  setOnTop(on) {
    this.store.set('chatwin.onTop', !!on);
    if (this.isOpen()) this.win.setAlwaysOnTop(!!on);
    this.emit('state');
    this.emit('settings');
  }

  // Types text into whatever is focused in the page (the chat box you last clicked), like
  // the keyboard does. Torn's page isn't read or changed; you still press Enter to send.
  // Open a private chat with a player in Torn's own chat: the same "chat.openChannel" event
  // Torn's profile button sends (for "Start a chat" clicked in a Torn tab while chat is hidden
  // there; main.js). Opens or brings up the chat window and waits for Torn's chat to load first.
  async openChannel(userId, nickname) {
    this.show();
    const wc = this.view && this.view.webContents;
    if (!wc) return false;
    const detail = { userId: String(userId), nickname: String(nickname || ''), sourceElementId: null };
    for (let i = 0; i < 40; i++) {
      if (wc.isDestroyed()) return false;
      const ready = await wc.executeJavaScript("!!document.querySelector('#chatRoot')").catch(() => false);
      if (ready) {
        if (i) await new Promise(r => setTimeout(r, 600)); // it just loaded: let the chat start up
        await wc.executeJavaScript(`window.dispatchEvent(new CustomEvent('chat.openChannel', { detail: ${JSON.stringify(detail)} })); 1`).catch(() => {});
        return true;
      }
      await new Promise(r => setTimeout(r, 500));
    }
    return false;
  }

  insert(text) {
    if (!this.isOpen()) return;
    const wc = this.view.webContents;
    wc.focus();
    wc.insertText(String(text).slice(0, 32));
  }

  // Windows' own emoji picker (Win + .), typing into the chat box like the keyboard.
  emojiPanel() {
    if (!this.isOpen()) return;
    this.view.webContents.focus();
    app.showEmojiPanel();
  }

  reload() {
    if (this.isOpen()) this.view.webContents.loadURL(CHAT_HOME);
  }

  // A changed compact-view setting applies on reload.
  refreshView() {
    this.reload();
  }

  setZoom(level) {
    level = Math.max(-3, Math.min(3, level));
    this.store.set('chatwin.zoom', level);
    if (this.isOpen()) this.view.webContents.setZoomLevel(level);
  }

  // The chat window's Torn page (the one place Torn's chat still loads when it's hidden
  // from the Torn browser).
  isPageId(id) {
    return !!this.view && !this.view.webContents.isDestroyed() && this.view.webContents.id === id;
  }

  isBar(wc) {
    return !!this.bar && wc === this.bar.webContents;
  }

  send(channel, payload) {
    if (this.bar && !this.bar.webContents.isDestroyed()) this.bar.webContents.send(channel, payload);
  }
}

module.exports = { ChatWindow, CHAT_HOME };
