'use strict';
// The app's icon and Windows identity (Mentat; called Torn Desktop until 2026-11-18). The .ico
// holds 16–256 px sizes, so Windows picks a sharp one for the title bar, taskbar and tray.

const path = require('path');
const { app } = require('electron');

const APP_ID = 'com.mentat.app';
const APP_ICON = path.join(__dirname, '..', 'assets', 'mentat.ico');

// Tell the Windows taskbar which app a window belongs to, its icon, and how to start it again
// from a pinned button. Without this, starting from source (Start Mentat.cmd runs electron.exe)
// shows Electron's icon on the taskbar. Packaged, the icon is the one built into Mentat.exe
// (Windows can't read files inside app.asar).
function brandWindow(win) {
  if (process.platform !== 'win32' || !win || typeof win.setAppDetails !== 'function') return;
  try {
    win.setAppDetails({
      appId: APP_ID,
      appIconPath: app.isPackaged ? process.execPath : APP_ICON,
      appIconIndex: 0,
      relaunchCommand: app.isPackaged ? `"${process.execPath}"` : `"${process.execPath}" "${app.getAppPath()}"`,
      relaunchDisplayName: 'Mentat',
    });
  } catch (e) {
    console.error('Taskbar details not set', e.message);
  }
}

module.exports = { APP_ID, APP_ICON, brandWindow };
