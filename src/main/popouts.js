'use strict';
// Pop-out tabs: any tab of the tools window (or a sub-tab on the main bar) in a small window
// of its own, optionally on top. Minimizing one collapses it to a draggable bubble, like the
// chat bubble, showing the tab's icon and a live badge (the chain timer, say). The windows run
// the same page as the tools window (index.html?pop=<tab>) and get the same updates.
// Remembered in settings: which are open (they come back on the next start), each window's
// place and size, each bubble's place, and whether it was collapsed or on top.

const path = require('path');
const { EventEmitter } = require('events');
const { BrowserWindow, screen } = require('electron');
const { APP_ICON, brandWindow } = require('./brand');

const BUBBLE_W = 80;
const BUBBLE_H = 84;
const TAB_ID = /^[a-z]+(:[a-z]+)?$/;

function onScreen(b) {
  return !!b && screen.getAllDisplays().some(d => {
    const a = d.workArea;
    return b.x < a.x + a.width && b.x + b.width > a.x && b.y < a.y + a.height && b.y + b.height > a.y;
  });
}

class Popouts extends EventEmitter {
  constructor({ store, preload, isTab, label, openUrl, onShortcut, onContextMenu }) {
    super();
    this.store = store;
    this.preload = preload;
    this.isTab = isTab; // id -> is it a real tab
    this.label = label; // id -> its name, for titles
    this.openUrl = openUrl;
    this.onShortcut = onShortcut;
    this.onContextMenu = onContextMenu;
    this.pops = new Map(); // id -> { win, bubble, collapsed, drag, badge }
  }

  get(key) { return this.store.get(`popouts.${key}`) || {}; }
  put(key, id, value) {
    const o = { ...this.get(key) };
    if (value === undefined || value === null) delete o[id]; else o[id] = value;
    this.store.set(`popouts.${key}`, o);
  }
  saveOpen() { this.store.set('popouts.open', [...this.pops.keys()]); }

  // Bring back the ones that were open last time.
  restore() {
    for (const id of this.store.get('popouts.open') || []) {
      if (TAB_ID.test(id) && this.isTab(id)) this.open(id, { collapsed: !!this.get('collapsed')[id] });
    }
  }

  isOpen(id) { const p = this.pops.get(id); return !!p && !p.win.isDestroyed(); }
  // Is a pop-out of this tab (or of one of its sub-tabs) open as a window, not a bubble?
  showing(tab) {
    for (const [id, p] of this.pops) {
      if (id.split(':')[0] === tab && !p.collapsed && !p.win.isDestroyed() && p.win.isVisible()) return true;
    }
    return false;
  }
  list() { return [...this.pops.keys()]; }

  // The pop-out (or its bubble) a page belongs to.
  idOf(wc) {
    for (const [id, p] of this.pops) if (!p.win.isDestroyed() && p.win.webContents === wc) return id;
    return null;
  }
  bubbleIdOf(wc) {
    for (const [id, p] of this.pops) if (p.bubble && !p.bubble.isDestroyed() && p.bubble.webContents === wc) return id;
    return null;
  }

  // Every pop-out page, for updates the tools window also gets.
  send(channel, payload) {
    for (const p of this.pops.values()) if (!p.win.isDestroyed()) p.win.webContents.send(channel, payload);
  }

  state(id) {
    const p = this.pops.get(id);
    return {
      id, label: this.label(id), open: this.isOpen(id), collapsed: !!(p && p.collapsed),
      onTop: this.get('onTop')[id] !== false, badge: (p && p.badge) || null,
    };
  }
  emitState(id) {
    const s = this.state(id);
    const p = this.pops.get(id);
    if (p && !p.win.isDestroyed()) p.win.webContents.send('popout', s);
    if (p && p.bubble && !p.bubble.isDestroyed()) p.bubble.webContents.send('popout', s);
    this.emit('state');
  }

  defaultBounds() {
    const a = screen.getPrimaryDisplay().workArea;
    const n = this.pops.size;
    const width = 560, height = 680;
    return { x: a.x + Math.max(0, a.width - width - 60 - n * 32), y: a.y + 60 + n * 32, width, height };
  }

  // Open (or bring up) a tab's pop-out.
  open(id, { collapsed = false } = {}) {
    if (!TAB_ID.test(id) || !this.isTab(id)) throw new Error('No such tab');
    if (this.isOpen(id)) { this.show(id); return; }
    const saved = this.get('bounds')[id];
    const onTop = this.get('onTop')[id] !== false;
    const win = new BrowserWindow({
      ...(onScreen(saved) ? saved : this.defaultBounds()),
      minWidth: 320, minHeight: 240,
      title: `${this.label(id)} · Mentat`,
      icon: APP_ICON,
      backgroundColor: '#191919',
      alwaysOnTop: onTop,
      show: false,
      webPreferences: {
        preload: this.preload, sandbox: true, contextIsolation: true, nodeIntegration: false,
        backgroundThrottling: false, // the bubble's badge keeps counting while collapsed
      },
    });
    brandWindow(win);
    win.loadFile(path.join(__dirname, '..', 'ui', 'index.html'), { query: { pop: id } });
    win.webContents.setWindowOpenHandler(({ url }) => { this.openUrl(url); return { action: 'deny' }; });
    win.webContents.on('will-navigate', e => e.preventDefault());
    win.webContents.on('page-title-updated', e => e.preventDefault());
    win.webContents.on('before-input-event', (e, input) => this.onShortcut(e, input, id));
    if (this.onContextMenu) win.webContents.on('context-menu', (_e, params) => this.onContextMenu(win, params));
    const p = { win, bubble: null, collapsed, drag: null, badge: null };
    this.pops.set(id, p);
    this.saveOpen();
    win.once('ready-to-show', () => {
      if (p.collapsed) this.showBubble(id);
      else { win.show(); this.showBubble(id); }
      this.emitState(id);
    });
    win.on('minimize', () => {
      if (this.store.get('popouts.minimizeToBubble') !== false) setImmediate(() => this.collapse(id));
    });
    win.on('close', () => this.saveBounds(id));
    win.on('closed', () => {
      this.stopDrag(p);
      if (p.bubble && !p.bubble.isDestroyed()) p.bubble.destroy();
      this.pops.delete(id);
      if (!this.quitting) { this.saveOpen(); this.put('collapsed', id, null); }
      this.emit('state');
    });
  }

  saveBounds(id) {
    const p = this.pops.get(id);
    if (!p || p.win.isDestroyed()) return;
    if (!p.win.isMaximized() && !p.win.isMinimized() && !p.win.isFullScreen() && p.win.isVisible()) this.put('bounds', id, p.win.getBounds());
  }

  show(id) {
    const p = this.pops.get(id);
    if (!p || p.win.isDestroyed()) return;
    p.collapsed = false;
    this.put('collapsed', id, null);
    if (p.win.isMinimized()) p.win.restore();
    p.win.show();
    p.win.focus();
    this.showBubble(id);
    this.emitState(id);
  }

  collapse(id) {
    const p = this.pops.get(id);
    if (!p || p.win.isDestroyed()) return;
    this.saveBounds(id);
    if (p.win.isMinimized()) p.win.restore();
    p.win.hide();
    p.collapsed = true;
    this.put('collapsed', id, true);
    this.showBubble(id);
    this.emitState(id);
  }

  toggle(id) {
    const p = this.pops.get(id);
    if (!this.isOpen(id)) this.open(id);
    else if (!p.collapsed && p.win.isVisible() && !p.win.isMinimized()) this.collapse(id);
    else this.show(id);
  }

  close(id) { const p = this.pops.get(id); if (p && !p.win.isDestroyed()) p.win.close(); }
  closeAll() { this.quitting = true; for (const id of this.list()) this.close(id); }

  setOnTop(id, on) {
    this.put('onTop', id, on ? null : false); // on top is the default
    const p = this.pops.get(id);
    if (p && !p.win.isDestroyed()) p.win.setAlwaysOnTop(!!on);
    this.emitState(id);
  }

  // The pop-out's page works out its badge (it has the data); the bubble shows it.
  setBadge(id, badge) {
    const p = this.pops.get(id);
    if (!p) return;
    const b = badge && typeof badge === 'object' ? {
      text: String(badge.text || '').slice(0, 12), tone: ['ok', 'warn', 'bad', 'info'].includes(badge.tone) ? badge.tone : '',
      title: String(badge.title || '').slice(0, 200),
    } : null;
    if (JSON.stringify(b) === JSON.stringify(p.badge)) return;
    p.badge = b;
    if (p.bubble && !p.bubble.isDestroyed()) p.bubble.webContents.send('popout', this.state(id));
  }

  // ---- Bubbles ----
  bubbleBounds(id) {
    const saved = this.get('bubble')[id];
    if (saved && onScreen({ ...saved, width: BUBBLE_W, height: BUBBLE_H })) return { x: saved.x, y: saved.y, width: BUBBLE_W, height: BUBBLE_H };
    // Stacked up the right edge, above where the chat bubble sits by default.
    const a = screen.getPrimaryDisplay().workArea;
    const i = this.list().indexOf(id);
    return { x: a.x + a.width - BUBBLE_W - 20, y: a.y + Math.max(0, Math.round(a.height * 0.6) - (i + 1) * (BUBBLE_H + 4)), width: BUBBLE_W, height: BUBBLE_H };
  }

  showBubble(id) {
    const p = this.pops.get(id);
    if (!p) return;
    if (p.bubble && !p.bubble.isDestroyed()) { p.bubble.showInactive(); return; }
    const b = new BrowserWindow({
      ...this.bubbleBounds(id),
      frame: false, transparent: true, resizable: false, maximizable: false, minimizable: false, fullscreenable: false,
      alwaysOnTop: true, skipTaskbar: true, hasShadow: false, show: false, focusable: true, title: this.label(id),
      webPreferences: { preload: this.preload, sandbox: true, contextIsolation: true, nodeIntegration: false },
    });
    b.setAlwaysOnTop(true, 'floating');
    b.loadFile(path.join(__dirname, '..', 'ui', 'popbubble.html'), { query: { id } });
    b.webContents.on('will-navigate', e => e.preventDefault());
    b.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    b.once('ready-to-show', () => { if (this.isOpen(id)) b.showInactive(); this.emitState(id); });
    b.on('closed', () => { if (p.bubble === b) p.bubble = null; });
    p.bubble = b;
  }

  resetBubble(id) {
    this.put('bubble', id, null);
    const p = this.pops.get(id);
    if (p && p.bubble && !p.bubble.isDestroyed()) p.bubble.setBounds(this.bubbleBounds(id));
  }

  // Dragging follows the pointer; a press that barely moves is a click and toggles the window.
  dragStart(id) {
    const p = this.pops.get(id);
    if (!p || !p.bubble || p.bubble.isDestroyed()) return;
    this.stopDrag(p);
    const c0 = screen.getCursorScreenPoint();
    const [x, y] = p.bubble.getPosition();
    const drag = { dx: c0.x - x, dy: c0.y - y, start: c0, moved: false };
    drag.timer = setInterval(() => {
      if (!p.bubble || p.bubble.isDestroyed()) { this.stopDrag(p); return; }
      const c = screen.getCursorScreenPoint();
      if (Math.abs(c.x - drag.start.x) + Math.abs(c.y - drag.start.y) > 6) drag.moved = true;
      if (drag.moved) p.bubble.setPosition(c.x - drag.dx, c.y - drag.dy);
    }, 16);
    drag.limit = setTimeout(() => this.dragEnd(id), 60000);
    p.drag = drag;
  }

  dragEnd(id) {
    const p = this.pops.get(id);
    if (!p) return;
    const drag = p.drag;
    this.stopDrag(p);
    if (!drag || !p.bubble || p.bubble.isDestroyed()) return;
    if (drag.moved) {
      const [x, y] = p.bubble.getPosition();
      this.put('bubble', id, { x, y });
    } else this.toggle(id);
  }

  stopDrag(p) {
    if (!p || !p.drag) return;
    clearInterval(p.drag.timer);
    clearTimeout(p.drag.limit);
    p.drag = null;
  }
}

module.exports = { Popouts };
