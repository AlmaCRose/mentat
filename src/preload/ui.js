'use strict';
// Bridge for the app's own UI only. Torn pages get no preload at all.
const { contextBridge, ipcRenderer } = require('electron');

const EVENTS = new Set(['tabs', 'feature', 'api', 'settings', 'beep', 'focus-address', 'browser', 'panel', 'panelSlot', 'popout', 'chatwin', 'popup', 'popup-snoozed', 'extensions', 'clocks']);

contextBridge.exposeInMainWorld('app', {
  cmd: (name, ...args) => ipcRenderer.invoke('cmd', name, ...args),
  on: (channel, fn) => {
    if (!EVENTS.has(channel)) throw new Error(`Unknown event ${channel}`);
    ipcRenderer.on(channel, (_e, payload) => fn(payload));
  },
});

// Colour theme (themes.css): set on <html> before the page draws, and live on changes.
const ACCENT = /^#[0-9a-f]{6}$/i;
function applyTheme(t) {
  const d = document.documentElement;
  if (!d || !t) return;
  if (t.name && t.name !== 'dark') d.dataset.theme = t.name;
  else delete d.dataset.theme;
  if (t.accent && ACCENT.test(t.accent)) {
    d.style.setProperty('--accent', t.accent);
    d.style.setProperty('--accent-2', `color-mix(in srgb, ${t.accent} 78%, black)`);
  } else {
    d.style.removeProperty('--accent');
    d.style.removeProperty('--accent-2');
  }
}
let theme = null;
try { theme = ipcRenderer.sendSync('theme-get'); } catch (e) { /* default theme */ }
applyTheme(theme);
if (!document.documentElement) document.addEventListener('DOMContentLoaded', () => applyTheme(theme));
ipcRenderer.on('theme', (_e, t) => { theme = t; applyTheme(t); });
