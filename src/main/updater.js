'use strict';
// Updates for the installed app (electron-updater). The Mentat server hosts the newest installer
// and its latest.yml (package.json "build.publish"); the app checks 20 s after starting and then
// every 6 hours, downloads a newer version in the background, and installs it when you restart
// (or the next time you quit). Starting from source or the portable .exe: the portable copy can't
// replace itself, so it only says a new version is out and links to the download.

const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');
const { app } = require('electron');

let autoUpdater = null;
try { ({ autoUpdater } = require('electron-updater')); } catch (e) { /* not installed: running from source without it */ }

const FIRST_CHECK = 20e3;
const EVERY = 6 * 3600e3;
const RETRY = 30 * 60e3;

class Updater extends EventEmitter {
  constructor({ store, downloadPage }) {
    super();
    this.store = store;
    this.downloadPage = downloadPage; // for the portable copy
    this.portable = !!process.env.PORTABLE_EXECUTABLE_FILE;
    // Only an installed copy has resources/app-update.yml. app.isPackaged alone isn't enough: the
    // development copy runs as Mentat.exe (renamed Electron, scripts/brand-dev.js), which Electron
    // counts as packaged, and the check then fails looking for that file.
    let hasConfig = false;
    try { hasConfig = fs.existsSync(path.join(process.resourcesPath, 'app-update.yml')); } catch (e) { /* no */ }
    this.supported = app.isPackaged && hasConfig && !!autoUpdater;
    this.state = { status: this.supported ? 'idle' : 'source', version: app.getVersion(), latest: '', percent: 0, error: '', checkedAt: 0, notes: '' };
    this.nextCheck = Date.now() + FIRST_CHECK;
    if (!this.supported) return;
    autoUpdater.autoDownload = !this.portable;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.logger = null;
    autoUpdater.on('checking-for-update', () => this.set({ status: 'checking', error: '' }));
    autoUpdater.on('update-not-available', () => this.set({ status: 'current', checkedAt: Date.now() }));
    autoUpdater.on('update-available', info => this.set({ status: this.portable ? 'available' : 'downloading', latest: info.version, percent: 0, checkedAt: Date.now(), notes: notesOf(info) }));
    autoUpdater.on('download-progress', p => this.set({ status: 'downloading', percent: Math.round(p.percent || 0) }));
    autoUpdater.on('update-downloaded', info => this.set({ status: 'ready', latest: info.version, percent: 100, notes: notesOf(info) }));
    autoUpdater.on('error', e => {
      this.set({ status: 'error', error: friendly(e), checkedAt: Date.now() });
      this.nextCheck = Date.now() + RETRY;
    });
  }

  set(patch) {
    Object.assign(this.state, patch);
    this.emit('state');
  }

  // From the app's 1-second loop.
  tick(now) {
    if (!this.supported || now < this.nextCheck || ['checking', 'downloading', 'ready'].includes(this.state.status)) return;
    this.nextCheck = now + EVERY;
    if (this.store.get('updates.auto') === false) return;
    this.check();
  }

  check() {
    if (!this.supported) return this.snapshot();
    this.nextCheck = Date.now() + EVERY;
    autoUpdater.checkForUpdates().catch(e => this.set({ status: 'error', error: friendly(e) }));
    return this.snapshot();
  }

  // Restart into the new version now (it also installs by itself the next time you quit).
  install() {
    if (this.state.status !== 'ready') return;
    setImmediate(() => autoUpdater.quitAndInstall(false, true));
  }

  snapshot() {
    return { ...this.state, portable: this.portable, downloadPage: this.downloadPage, auto: this.store.get('updates.auto') !== false };
  }
}

const notesOf = info => String((info && typeof info.releaseNotes === 'string' && info.releaseNotes) || '').replace(/<[^>]+>/g, '').slice(0, 600);
function friendly(e) {
  const m = String((e && e.message) || e || '');
  if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|net::|getaddrinfo|socket/i.test(m)) return "Couldn't reach the update server.";
  if (/404|Cannot find .*latest\.yml/i.test(m)) return 'No update information on the server yet.';
  return m.split('\n')[0].slice(0, 200);
}

module.exports = { Updater };
