'use strict';
// Mentat's own popups: an alternative to Windows notifications (setting
// ui.popupStyle = 'app'). Small always-on-top cards in a screen corner that don't steal
// focus, stack when several arrive, and close after a set time (or stay until closed).
// "Open" goes to the alert's Torn page in the Torn browser; nothing is ever done in Torn.
//
// Urgent popups (showUrgent) are for things you mustn't miss, like a planned flight: a larger card
// in the middle of the screen you're using, on top of everything, that never closes by itself.
// Its sound repeats (ui.urgentRepeat, for up to 10 minutes) until you open, snooze or dismiss it.
// Like the corner cards it never takes the keyboard focus, so typing elsewhere isn't interrupted.

const path = require('path');
const { BrowserWindow, screen } = require('electron');

const W = 360;
const H = 104;
const GAP = 8;
const EDGE = 12;
const MAX = 5;
const UW = 480;
const UH = 200;
const U_MAX = 3;              // urgent cards at once (oldest goes)
const U_CASCADE = 34;         // each further urgent card sits a little lower and to the right
const U_SOUND_FOR = 10 * 60e3; // stop repeating the sound after this long (the card stays)

class Popups {
  constructor({ store, preload, openUrl, beep = () => {} }) {
    this.store = store;
    this.preload = preload;
    this.openUrl = openUrl;
    this.beep = beep;
    this.list = []; // { win, url, timer, until }
    this.urgent = []; // { win, url, sound, repeat, snoozeTimer, soundTimer, soundUntil }
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

  // The middle of the screen the mouse is on (where you're most likely looking).
  urgentBounds(i) {
    let a;
    try { a = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea; } catch (e) { a = screen.getPrimaryDisplay().workArea; }
    const off = U_CASCADE * i;
    return { x: Math.round(a.x + (a.width - UW) / 2 + off), y: Math.round(a.y + (a.height - UH) / 2 - UH * 0.15 + off), width: UW, height: UH };
  }

  showUrgent(title, body, url = '', opts = {}) {
    while (this.urgent.length >= U_MAX) this.close(this.urgent[0].win);
    const win = new BrowserWindow({
      ...this.urgentBounds(this.urgent.length),
      frame: false, transparent: true, resizable: false, movable: true, minimizable: false, maximizable: false,
      fullscreenable: false, skipTaskbar: true, alwaysOnTop: true, show: false, focusable: false, hasShadow: false,
      title: 'Mentat alert',
      webPreferences: { preload: this.preload, sandbox: true, contextIsolation: true, nodeIntegration: false },
    });
    win.setAlwaysOnTop(true, 'screen-saver');
    win.setVisibleOnAllWorkspaces(true);
    win.webContents.on('will-navigate', e => e.preventDefault());
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    const entry = { win, url, sound: opts.sound || null, repeat: Number(opts.repeat) || 0, snoozeTimer: null, soundTimer: null, soundUntil: 0, urgent: true };
    this.urgent.push(entry);
    win.loadFile(path.join(__dirname, '..', 'ui', 'popup.html'));
    win.webContents.once('did-finish-load', () => {
      if (win.isDestroyed()) return;
      win.webContents.send('popup', { title: String(title), body: String(body || ''), canOpen: !!url, seconds: 0, urgent: true, shownAt: Date.now() });
      this.ring(entry);
    });
    win.on('closed', () => {
      clearTimeout(entry.snoozeTimer);
      clearInterval(entry.soundTimer);
      this.urgent = this.urgent.filter(p => p !== entry);
    });
  }

  // Shows the card (again) and starts its sound, repeating it every `repeat` seconds for a while.
  ring(entry) {
    if (entry.win.isDestroyed()) return;
    entry.win.setBounds(this.urgentBounds(this.urgent.indexOf(entry)));
    entry.win.showInactive();
    entry.win.moveTop();
    clearInterval(entry.soundTimer);
    if (!entry.sound) return;
    this.beep(entry.sound);
    entry.soundUntil = Date.now() + U_SOUND_FOR;
    if (entry.repeat > 0) {
      entry.soundTimer = setInterval(() => {
        if (entry.win.isDestroyed() || Date.now() > entry.soundUntil) { clearInterval(entry.soundTimer); return; }
        this.beep(entry.sound);
      }, entry.repeat * 1000);
    }
  }

  snooze(entry, minutes) {
    clearInterval(entry.soundTimer);
    clearTimeout(entry.snoozeTimer);
    entry.win.hide();
    entry.snoozeTimer = setTimeout(() => {
      if (entry.win.isDestroyed()) return;
      entry.win.webContents.send('popup-snoozed', { minutes });
      this.ring(entry);
    }, minutes * 60e3);
  }

  startTimer(entry, secs) {
    clearTimeout(entry.timer);
    if (secs > 0) entry.timer = setTimeout(() => this.close(entry.win), secs * 1000);
  }

  entryFor(wc) {
    return [...this.list, ...this.urgent].find(p => !p.win.isDestroyed() && p.win.webContents === wc) || null;
  }

  isPopup(wc) {
    return !!this.entryFor(wc);
  }

  // From the popup: open its page, close it, or hold it open while the mouse is over it.
  action(wc, what) {
    const e = this.entryFor(wc);
    if (!e) return;
    if (e.urgent) {
      if (what === 'open') { if (e.url) this.openUrl(e.url); this.close(e.win); }
      else if (what === 'close') this.close(e.win);
      else if (what === 'quiet') clearInterval(e.soundTimer);
      else if (/^snooze\d+$/.test(what)) this.snooze(e, Math.max(1, Math.min(60, Number(what.slice(6)))));
      return;
    }
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
    for (const p of [...this.list, ...this.urgent]) this.close(p.win);
  }
}

module.exports = { Popups };
