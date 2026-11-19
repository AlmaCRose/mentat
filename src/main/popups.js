'use strict';
// Mentat's own popups: an alternative to Windows notifications (setting
// ui.popupStyle = 'app'). Small always-on-top cards in a screen corner that don't steal
// focus, stack when several arrive, and close after a set time (or stay until closed).
// "Open" goes to the alert's Torn page in the Torn browser; nothing is ever done in Torn.

const path = require('path');
const { BrowserWindow, screen } = require('electron');

const W = 360;
const H = 104;
const GAP = 8;
const EDGE = 12;
const MAX = 5;

class Popups {
  constructor({ store, preload, openUrl }) {
    this.store = store;
    this.preload = preload;
    this.openUrl = openUrl;
    this.list = []; // { win, url, timer, until }
  }

  corner() {
    const c = this.store.get('ui.popupCorner');
    return ['bottom-right', 'top-right', 'bottom-left', 'top-left'].includes(c) ? c : 'bottom-right';
  }

  // Seconds a popup stays up; 0 = until closed.
  duration() {
    const d = Number(this.store.get('ui.popupSeconds'));
    return Number.isFinite(d) && d >= 0 ? d : 12;
  }

  position(i) {
    const a = screen.getPrimaryDisplay().workArea;
    const c = this.corner();
    const x = c.endsWith('right') ? a.x + a.width - W - EDGE : a.x + EDGE;
    const step = (H + GAP) * i;
    const y = c.startsWith('bottom') ? a.y + a.height - H - EDGE - step : a.y + EDGE + step;
    return { x, y, width: W, height: H };
  }

  layout() {
    this.list.forEach((p, i) => { if (!p.win.isDestroyed()) p.win.setBounds(this.position(i)); });
  }

  show(title, body, url = '') {
    while (this.list.length >= MAX) this.close(this.list[0].win);
    const win = new BrowserWindow({
      ...this.position(this.list.length),
      frame: false, transparent: true, resizable: false, movable: false, minimizable: false, maximizable: false,
      fullscreenable: false, skipTaskbar: true, alwaysOnTop: true, show: false, focusable: false, hasShadow: false,
      title: 'Mentat alert',
      webPreferences: { preload: this.preload, sandbox: true, contextIsolation: true, nodeIntegration: false },
    });
    win.setAlwaysOnTop(true, 'screen-saver');
    win.webContents.on('will-navigate', e => e.preventDefault());
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    const entry = { win, url, timer: null };
    this.list.push(entry);
    const secs = this.duration();
    win.loadFile(path.join(__dirname, '..', 'ui', 'popup.html'));
    win.webContents.once('did-finish-load', () => {
      if (win.isDestroyed()) return;
      win.webContents.send('popup', { title: String(title), body: String(body || ''), canOpen: !!url, seconds: secs });
      win.showInactive();
      this.startTimer(entry, secs);
    });
    win.on('closed', () => {
      clearTimeout(entry.timer);
      this.list = this.list.filter(p => p !== entry);
      this.layout();
    });
  }

  startTimer(entry, secs) {
    clearTimeout(entry.timer);
    if (secs > 0) entry.timer = setTimeout(() => this.close(entry.win), secs * 1000);
  }

  entryFor(wc) {
    return this.list.find(p => !p.win.isDestroyed() && p.win.webContents === wc) || null;
  }

  isPopup(wc) {
    return !!this.entryFor(wc);
  }

  // From the popup: open its page, close it, or hold it open while the mouse is over it.
  action(wc, what) {
    const e = this.entryFor(wc);
    if (!e) return;
    if (what === 'open') {
      if (e.url) this.openUrl(e.url);
      this.close(e.win);
    } else if (what === 'close') {
      this.close(e.win);
    } else if (what === 'hold') {
      clearTimeout(e.timer);
    } else if (what === 'release') {
      this.startTimer(e, Math.min(this.duration(), 5) || 0);
    }
  }

  close(win) {
    if (win && !win.isDestroyed()) win.destroy();
  }

  closeAll() {
    for (const p of [...this.list]) this.close(p.win);
  }
}

module.exports = { Popups };
