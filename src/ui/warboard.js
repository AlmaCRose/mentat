'use strict';
/* global S, cmd, showPanel, NAV_POP */
// War board tab (the user's request, 2026-11-26): the war board plugin (web/pda/mentat-war.user.js,
// the very file Torn PDA and Tampermonkey load) running inside Mentat, so the desktop app has the
// hit queue, dibs, the enemy and faction lists, energy sharing and the FFScouter search too. Like any
// tab it can be popped out into its own window and shrunk to a bubble, which shows your place in
// the queue (or the chain timer).
// The plugin gets window.__mentatWarEmbed (below) instead of a userscript manager: no button and no
// sign-in of its own; its Mentat server calls use this app's sign-in, its Torn reads go through the
// app's API queue with the saved key, FFScouter uses the key in Settings → Integrations (core.js
// 'warboard.*' commands). It keeps its own settings in this page's localStorage (mentat.war.*).
// It's loaded the first time the tab is shown, or at start in the tools window when energy sharing
// is on (sharing goes on while Mentat runs). Desktop only: the web app hides the tab (nav.js).

const WB_SRC = '../../web/pda/mentat-war.user.js';
let wbLoaded = false;
let wbBadge = null; // what the plugin's button would show: { text, tone, title }

const wbSection = () => document.querySelector('#panels > section[data-panel="warboard"]');
// On show here: its section is the active one and the window isn't hidden. A pop-out counts while
// it's shrunk to its bubble too, so the bubble's badge stays current.
function wbVisible() {
  const s = wbSection();
  return !!(s && s.classList.contains('active')) && (!document.hidden || !!NAV_POP);
}

function wbLoad() {
  if (wbLoaded || document.documentElement.classList.contains('web')) return;
  const s = wbSection();
  if (!s) return;
  wbLoaded = true;
  s.innerHTML = '<div class="wb-mount"></div>';
  window.__mentatWarEmbed = {
    mount: s.querySelector('.wb-mount'),
    visible: wbVisible,
    energyHere: () => !NAV_POP, // one window shares energy: the tools window
    me: () => {
      const m = S.features.sync && S.features.sync.me;
      return m ? { name: m.name || '', faction: m.faction || null } : null;
    },
    server: (method, path, body) => cmd('warboard.server', method, path, body),
    torn: path => cmd('warboard.torn', path),
    ffs: (path, params) => cmd('warboard.ffs', path, params),
    ffsState: () => {
      const f = S.features.ffscouter || {};
      return { on: !!f.hasKey, premium: !!(f.account && f.account.premium) };
    },
    open: url => cmd('torn.open', String(url), true),
    openSettings: () => {
      showPanel('settings');
      cmd('settings.set', 'ui.panel', 'settings');
      setTimeout(() => { const g = document.getElementById('set-integrations'); if (g) g.scrollIntoView({ block: 'start' }); }, 50);
    },
    badge: b => { wbBadge = b; },
  };
  const el = document.createElement('script');
  el.src = WB_SRC;
  el.onerror = () => { s.innerHTML = '<div class="empty">The war board could not be loaded.</div>'; };
  document.body.appendChild(el);
}

// Called by showPanel for every tab change (and on visibility changes): tell the board.
function renderWarboard() {
  const on = wbVisible();
  if (on) wbLoad();
  const c = window.__mentatWarEmbed && window.__mentatWarEmbed.control;
  if (!c) return;
  if (on) c.show(); else c.hide();
}
document.addEventListener('visibilitychange', () => { if (wbLoaded) renderWarboard(); });

// At start in the tools window: load it in the background when energy sharing is on.
(function wbAutoStart() {
  if (NAV_POP) return;
  let cfg = null;
  try { cfg = JSON.parse(localStorage.getItem('mentat.war.cfg') || 'null'); } catch (e) { cfg = null; }
  if (cfg && cfg.shareE) setTimeout(wbLoad, 3000);
})();

// The pop-out bubble's badge (app.js popBadge).
function warboardBadge() {
  return wbBadge;
}
