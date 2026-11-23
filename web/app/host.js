'use strict';
/* global Mentat */
// Mentat in a web browser (and installed as a phone app): starts the same core as the Windows app
// (mentat-core.js) in this page and gives the tools page what the Windows app's preload gives it:
// app.cmd() and app.on(). Personal tools use your key from this device; shared data (oppo research,
// war records, scouting, abroad stock, price history) comes from this Mentat server.
// What only the Windows app can do (its own Torn browser, the chat window, pop-out windows and
// bubbles, TornTools) is left out here; Torn links open in a new tab, or in Torn PDA on a phone.

(function () {
  const DATA = '/mentat';
  const subs = new Map();
  const emit = (ch, data) => { for (const f of subs.get(ch) || []) { try { f(data); } catch (e) { console.error(e); } } };
  const ua = navigator.userAgent;
  const isAndroid = /Android/i.test(ua);
  const isIOS = /iPhone|iPad|iPod/i.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const isPhone = isAndroid || isIOS || matchMedia('(max-width: 700px)').matches;
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  document.documentElement.classList.add('web');
  if (isPhone) document.documentElement.classList.add('phone');
  if (standalone) document.documentElement.classList.add('standalone');
  // A Windows computer (not a phone or tablet): offered the Windows app.
  if (/Windows NT/i.test(ua) && !isPhone) document.documentElement.classList.add('windows');

  // ---- Colour theme, before the page draws (the last one is remembered on this device) ----
  const ACCENT = /^#[0-9a-f]{6}$/i;
  function paintTheme(t) {
    const d = document.documentElement;
    if (t.name && t.name !== 'dark') d.dataset.theme = t.name; else delete d.dataset.theme;
    if (t.accent && ACCENT.test(t.accent)) {
      d.style.setProperty('--accent', t.accent);
      d.style.setProperty('--accent-2', `color-mix(in srgb, ${t.accent} 78%, black)`);
    } else { d.style.removeProperty('--accent'); d.style.removeProperty('--accent-2'); }
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = getComputedStyle(d).getPropertyValue('--chrome').trim() || '#121212';
  }
  try { paintTheme(JSON.parse(localStorage.getItem('mentat.theme') || '{"name":"mentat"}')); } catch (e) { paintTheme({ name: 'mentat' }); }
  const darkMedia = matchMedia('(prefers-color-scheme: dark)');

  // ---- Links: Torn pages in a new tab, or in Torn PDA (phones) ----
  // Torn PDA opens tornpda://www.torn.com/... links. On Android an intent link opens PDA when it's
  // installed and falls back to the normal page when it isn't; iPhones have no fallback, so there
  // it's a setting (Settings → App: "Open Torn links in Torn PDA").
  function tornLink(url) {
    let u;
    try { u = new URL(url); } catch (e) { return null; }
    if (!/(^|\.)torn\.com$/.test(u.hostname)) return { href: u.href, external: true };
    const mode = core ? core.store.get('ui.pdaLinks') : 'auto';
    const rest = `${u.host}${u.pathname}${u.search}${u.hash}`;
    if (mode === 'on') return { href: `tornpda://${rest}`, app: true, web: u.href };
    if (mode !== 'off' && isAndroid) return { href: `intent://${rest}#Intent;scheme=tornpda;package=com.manuito.tornpda;S.browser_fallback_url=${encodeURIComponent(u.href)};end`, app: true, web: u.href };
    return { href: u.href };
  }
  function openUrl(url) {
    const l = tornLink(String(url || ''));
    if (!l || !/^(https?|tornpda|intent):/.test(l.href)) return;
    if (l.app) {
      // Android: start PDA from a fresh window. Chrome closes a window whose only job was opening
      // another app, so you come back to Mentat as you left it. Sending this window there instead
      // left a blank "redirect" window behind in the installed web app (user report, 2026-11-18).
      if (isAndroid) {
        const w = window.open(l.href, '_blank');
        if (w) { try { w.opener = null; } catch (e) { /* already handed over */ } return; }
      }
      // iPhone, installed app: iOS opens the link in its in-app browser sheet, which stayed blank after
      // handing over to PDA. Our own page fills that sheet: it opens PDA, then tries to close itself
      // or says how to get back (pda.html; user report with a screenshot, 2026-11-18).
      if (isIOS && standalone) {
        const page = new URL(`pda.html#to=${encodeURIComponent(l.href)}&web=${encodeURIComponent(l.web || '')}`, location.href).href;
        const w = window.open(page, '_blank');
        if (w) return;
      }
      location.href = l.href;
      return;
    }
    // Not window.open(..., 'noopener'): that always returns null, even when the tab opened, which
    // looked like a blocked pop-up and sent this tab to the link too. Cut the opener by hand instead.
    const w = window.open(l.href, '_blank');
    if (w) { try { w.opener = null; } catch (e) { /* already cross-origin */ } }
    else location.href = l.href; // pop-ups really blocked (an installed app on some phones)
  }
  // Links in the page (data-open) go through the same rules.
  document.addEventListener('click', e => {
    const a = e.target.closest && e.target.closest('a[href^="https://www.torn.com"], a[href^="https://torn.com"]');
    if (a && !a.hasAttribute('data-open')) { e.preventDefault(); openUrl(a.href); }
  }, true);

  // ---- Alerts: a system notification when allowed and the page isn't on screen, else in the page ----
  function notify(title, body, url, opts = {}) {
    if (opts.urgent) return urgentCard(title, body, url, opts);
    const style = core ? core.store.get('ui.popupStyle') : 'app';
    if ('Notification' in window && Notification.permission === 'granted' && (document.hidden || style === 'windows')) {
      try {
        const n = new Notification(title, { body, icon: '/assets/mentat-mark.png', tag: `mentat-${title}` });
        n.onclick = () => { window.focus(); if (url) openUrl(url); n.close(); };
        return;
      } catch (e) { /* phones only notify from the service worker: fall through */ }
    }
    if (typeof window.toast === 'function') window.toast(`${title}: ${body}`, 9000);
  }

  // Urgent alerts: a card in the middle of the page that stays until dismissed or snoozed, its sound
  // repeating (for up to 10 minutes), plus a system notification that stays put when the page is hidden.
  const urgentCards = [];
  function urgentCard(title, body, url, opts) {
    while (urgentCards.length >= 3) urgentCards[0].close();
    const el = document.createElement('div');
    el.className = 'urgent-card';
    el.setAttribute('role', 'alertdialog');
    el.setAttribute('aria-label', title);
    el.innerHTML = '<div class="u-app">Mentat · urgent</div><div class="u-title"></div><div class="u-body"></div>'
      + '<div class="u-row"><button class="primary" data-u="open">Open in Torn</button><button data-u="2">Snooze 2 min</button><button data-u="5">Snooze 5 min</button><button data-u="close" class="u-dismiss">Dismiss</button></div>';
    el.querySelector('.u-title').textContent = title;
    el.querySelector('.u-body').textContent = body || '';
    if (!url) el.querySelector('[data-u="open"]').hidden = true;
    let soundTimer = 0, snoozeTimer = 0, sysNote = null;
    const stopSound = () => clearInterval(soundTimer);
    const ring = () => {
      el.hidden = false;
      stopSound();
      if (opts.sound && typeof window.beep === 'function') {
        window.beep(opts.sound);
        const until = Date.now() + 10 * 60e3;
        if (opts.repeat > 0) soundTimer = setInterval(() => { if (Date.now() > until) stopSound(); else window.beep(opts.sound); }, opts.repeat * 1000);
      }
      if (document.hidden && 'Notification' in window && Notification.permission === 'granted') {
        try { sysNote = new Notification(title, { body, icon: '/assets/mentat-mark.png', tag: `mentat-urgent-${title}`, requireInteraction: true }); sysNote.onclick = () => { window.focus(); sysNote.close(); }; } catch (e) { /* phones: service worker only */ }
      }
    };
    const entry = {
      close() { stopSound(); clearTimeout(snoozeTimer); if (sysNote) sysNote.close(); el.remove(); urgentCards.splice(urgentCards.indexOf(entry), 1); },
    };
    el.addEventListener('click', e => {
      const b = e.target.closest('[data-u]');
      if (!b) return;
      const a = b.dataset.u;
      if (a === 'open') { if (url) openUrl(url); entry.close(); }
      else if (a === 'close') entry.close();
      else { stopSound(); if (sysNote) sysNote.close(); el.hidden = true; snoozeTimer = setTimeout(ring, Number(a) * 60e3); }
    });
    urgentCards.push(entry);
    document.body.appendChild(el);
    el.style.setProperty('--u-off', `${(urgentCards.length - 1) * 28}px`);
    ring();
  }

  // ---- Files: exports download (the PDF goes through the print dialog: "Save as PDF") ----
  const safeName = s => String(s || 'Mentat').replace(/[^\w .-]+/g, '').trim().slice(0, 80) || 'Mentat';
  function download(name, text, type) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type }));
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
  }
  function printHtml(html) {
    const f = document.createElement('iframe');
    f.style.cssText = 'position:fixed;width:0;height:0;border:0;';
    f.srcdoc = html;
    f.onload = () => { try { f.contentWindow.print(); } catch (e) { /* closed */ } setTimeout(() => f.remove(), 60000); };
    document.body.appendChild(f);
  }
  const exporters = {
    exportIntel: p => {
      const base = `${safeName(p.name)} - Mentat intel`;
      download(`${base}.html`, p.html, 'text/html');
      if (p.csv) download(`${base}.csv`, `﻿${p.csv}`, 'text/csv');
      printHtml(p.pdf);
      return { html: `${base}.html`, csv: p.csv ? `${base}.csv` : '', pdf: 'print dialog' };
    },
    exportResearch: p => {
      if (p.mode !== 'all') {
        if (typeof window.toast === 'function') window.toast('Copying the summary image is in the Windows app. Use "Export full report" here.', 7000);
        return { cancelled: true };
      }
      const base = `${safeName(p.name)} - Mentat research`;
      download(`${base}.html`, p.report || p.overview, 'text/html');
      if (p.csv) download(`${base}.csv`, `﻿${p.csv}`, 'text/csv');
      if (p.data) download(`${base}.json`, JSON.stringify(p.data), 'application/json');
      return { copied: false, html: `${base}.html` };
    },
  };

  // ---- The Pages menu (a list of Torn pages), shown under its button ----
  function pagesMenu(x, y) {
    const old = document.getElementById('pages-menu');
    if (old) { old.remove(); return; }
    const { PAGES } = Mentat.require('pages.js');
    const m = document.createElement('div');
    m.id = 'pages-menu';
    m.setAttribute('role', 'menu');
    m.innerHTML = PAGES.map(([g, pages]) => `<div class="pm-group">${g}</div>${pages.map(([l, u]) => `<button role="menuitem" data-pm="${u}">${l}</button>`).join('')}`).join('');
    document.body.appendChild(m);
    const r = m.getBoundingClientRect();
    m.style.left = `${Math.max(8, Math.min(x, innerWidth - r.width - 8))}px`;
    m.style.top = `${Math.max(8, Math.min(y, innerHeight - r.height - 8))}px`;
    const close = ev => { if (!m.contains(ev.target)) { m.remove(); document.removeEventListener('pointerdown', close, true); } };
    setTimeout(() => document.addEventListener('pointerdown', close, true));
    m.addEventListener('click', ev => { const b = ev.target.closest('[data-pm]'); if (b) { m.remove(); openUrl(b.dataset.pm); } });
  }

  // ---- What only the Windows app does: harmless answers here ----
  const WEB_COMMANDS = {
    'torn.show': () => openUrl('https://www.torn.com/index.php'),
    'tool.focus': () => {},
    'pages.menu': (x, y) => pagesMenu(x, y),
    'chatwin.toggle': () => openUrl('https://www.torn.com/index.php'),
    'chatwin.open': () => openUrl('https://www.torn.com/index.php'),
    'ext.status': () => ({ available: false, installed: false, enabled: false, loaded: false, web: true }),
    'updates.check': () => null,
    'updates.install': () => null,
    'popup.action': () => null,
    'web.notifyPermission': async () => ('Notification' in window ? Notification.requestPermission() : 'unsupported'),
    'web.info': () => ({ isAndroid, isIOS, isPhone, standalone, notify: 'Notification' in window ? Notification.permission : 'unsupported' }),
  };

  // ---- Start the core ----
  let core = null;
  const ACTIVITY = {
    observe() {}, flush() {},
    profile(ids) {
      const members = {};
      for (const id of ids) members[id] = { act: new Array(96).fill(0), obs: new Array(96).fill(0), days: 0 };
      return { from: '', to: '', days: 0, members, week: { act: new Array(168).fill(0), obs: new Array(168).fill(0) } };
    },
    stats: () => ({ days: 0, first: '', players: 0 }),
  };
  const ARCHIVE = {
    has: () => false, get: () => null, put: (_k, _i, o) => o, playerWars: () => [], flush() {},
    fetchRanked: async () => null, fetchChain: async () => null, stats: () => ({ rankedWars: 0, chains: 0, players: 0 }),
  };
  const ready = (async () => {
    await Mentat.load();
    const { Store } = Mentat.require('store.js');
    const { DEFAULTS, THEME_BG, migrateSettings } = Mentat.require('schema.js');
    const { createCore } = Mentat.require('core.js');
    const defaults = structuredClone(DEFAULTS);
    defaults.sync.mode = 'server';
    const store = new Store(`${DATA}/settings.json`, defaults, { debounceMs: 1500 });
    const migrated = migrateSettings(store);
    function currentTheme() {
      const pick = store.get('ui.themeAuto') ? (darkMedia.matches ? store.get('ui.themeDark') : store.get('ui.themeLight')) : store.get('ui.theme');
      return { name: THEME_BG[pick] ? pick : 'mentat', accent: store.get('ui.accent') || '' };
    }
    const applyTheme = () => {
      const t = currentTheme();
      paintTheme(t);
      try { localStorage.setItem('mentat.theme', JSON.stringify(t)); } catch (e) { /* private mode */ }
    };
    darkMedia.addEventListener('change', () => { if (store.get('ui.themeAuto')) applyTheme(); });
    core = createCore({
      store, dataDir: DATA, version: Mentat.version, deviceName: isPhone ? (standalone ? 'Mentat phone app' : 'Mentat on a phone browser') : 'Mentat in a browser',
      defaultServer: location.origin, send: emit, notify, openUrl: url => openUrl(url), migrated,
      activity: ACTIVITY, archive: ARCHIVE, scoutLocal: false,
      // A tab is on show only while the page is visible (War's live mode stops in the background).
      viewing: tab => !document.hidden && String(store.get('ui.panel') || '').split(':')[0] === tab,
      exportResearch: exporters.exportResearch, exportIntel: exporters.exportIntel,
      publicExtra: () => ({
        popouts: { minimizeToBubble: false }, updates: { auto: false },
        chatwin: { emojis: '', onTop: false, minimizeToBubble: false, compact: true, hideInBrowser: false },
        web: { isAndroid, isIOS, isPhone, standalone, pdaLinks: store.get('ui.pdaLinks') || 'auto' },
      }),
      onSetting: p => { if (p.startsWith('ui.theme') || p === 'ui.accent') applyTheme(); },
      onSynced: (_c, has) => { if (has('ui.theme') || has('ui.accent')) applyTheme(); },
    });
    core.store = store;
    applyTheme();
    // Keep what's collected: save when the page is hidden or closed.
    const save = () => { try { core.flushAll(); } catch (e) { /* best effort */ } Mentat.persistNow(); };
    document.addEventListener('visibilitychange', () => { if (document.hidden) save(); });
    window.addEventListener('pagehide', save);
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
    return core;
  })();
  ready.catch(e => {
    console.error(e);
    document.body.innerHTML = `<div style="padding:24px;font:15px sans-serif">Mentat couldn't start in this browser: ${String(e.message || e).replace(/</g, '&lt;')}. Try an up-to-date Chrome, Edge, Firefox or Safari.</div>`;
  });

  // ---- Installing as an app, notifications, the service worker ----
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => navigator.serviceWorker.register('/app/sw.js', { scope: '/app/' }).catch(e => console.warn('Mentat: service worker', e)));
  }
  let installPrompt = null; // Android / desktop Chrome and Edge offer this; iPhones don't
  window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); installPrompt = e; });
  window.addEventListener('appinstalled', () => { installPrompt = null; if (typeof window.toast === 'function') window.toast('Mentat is installed. Open it from your home screen.', 7000); });
  const say = (text, ms = 9000) => { if (typeof window.toast === 'function') window.toast(text, ms); };
  function installHelp() {
    if (standalone) return 'Mentat is already running as an installed app.';
    if (isIOS) return 'On iPhone and iPad: open Mentat in Safari, tap the Share button, then "Add to Home Screen".';
    if (isAndroid) return 'In Chrome: tap the ⋮ menu, then "Add to Home screen" or "Install app".';
    return 'In Chrome or Edge: use the install icon at the right of the address bar, or the browser menu → "Install Mentat".';
  }
  document.addEventListener('click', async e => {
    const b = e.target.closest && e.target.closest('[data-web]');
    if (!b) return;
    if (b.dataset.web === 'install') {
      if (installPrompt) { installPrompt.prompt(); installPrompt = null; } else say(installHelp(), 12000);
    } else if (b.dataset.web === 'notify') {
      if (!('Notification' in window)) { say(isIOS && !standalone ? 'On iPhone, notifications work once Mentat is added to your home screen (Share → Add to Home Screen).' : "This browser can't show notifications."); return; }
      const r = await Notification.requestPermission();
      say(r === 'granted' ? 'Notifications are on.' : 'Notifications are blocked. You can allow them in the browser\'s site settings.');
      b.textContent = r === 'granted' ? 'Allowed' : 'Allow notifications';
    }
  });
  // ---- On a phone, offer to install (a browser only opens its install dialog from a tap) ----
  const SHARE_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true" class="ins-share"><path d="M12 3l-4 4h3v8h2V7h3l-4-4zM6 10v10h12V10h-2v8H8v-8H6z"/></svg>';
  function installSheet() {
    if (!isPhone || standalone || document.getElementById('install-sheet')) return;
    let ask = {};
    try { ask = JSON.parse(localStorage.getItem('mentat.installAsk') || '{}'); } catch (e) { /* none */ }
    if (ask.never || (ask.later && Date.now() - ask.later < 7 * 86400e3)) return;
    const iosOtherBrowser = isIOS && /CriOS|FxiOS|EdgiOS/.test(ua);
    const steps = isIOS
      ? `<ol class="ins-steps"><li>Tap ${SHARE_ICON} <b>Share</b> ${iosOtherBrowser ? 'in the browser\'s menu' : 'at the bottom of Safari'}.</li><li>Choose <b>Add to Home Screen</b>, then <b>Add</b>.</li><li>Open <b>Mentat</b> from your home screen and sign in there.</li></ol>`
      : `<ol class="ins-steps"><li>Tap the <b>⋮</b> menu at the top right of Chrome.</li><li>Choose <b>Install app</b> (or <b>Add to Home screen</b>).</li></ol>`;
    const el = document.createElement('div');
    el.id = 'install-sheet';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-labelledby', 'ins-title');
    el.innerHTML = `<div class="ins-card">
      <div class="ins-head"><img src="/assets/mentat-icon-192.png" alt=""><div><b id="ins-title">Install Mentat on your phone</b><div class="ins-sub">Free, takes a few seconds, no app store.</div></div></div>
      <ul class="ins-why">
        <li><b>Opens like an app:</b> full screen, from your home screen.</li>
        <li><b>Alerts while it's closed:</b> landing, the chain timer, full bars and cooldowns${isIOS ? ' (on iPhone these only work in the installed app)' : ''}.</li>
        <li><b>Starts faster</b> and opens even on a weak connection.</li>
      </ul>
      ${isIOS ? '<p class="ins-note">Install it first, then sign in inside the app: iPhones keep the installed app\'s sign-in separate from the browser\'s.</p>' : ''}
      <div class="ins-how"${!isIOS && installPrompt ? ' hidden' : ''}>${steps}</div>
      <div class="ins-actions">
        ${!isIOS ? `<button class="primary" data-ins="install"${installPrompt ? '' : ' hidden'}>Install Mentat</button>` : ''}
        <button data-ins="later">${isIOS ? 'Got it' : 'Not now'}</button>
        <button class="ins-never" data-ins="never">Don't ask again</button>
      </div></div>`;
    document.body.appendChild(el);
    el.addEventListener('click', async e => {
      const b = e.target.closest('[data-ins]');
      if (!b) return;
      const a = b.dataset.ins;
      if (a === 'install') {
        if (!installPrompt) return;
        installPrompt.prompt();
        const r = await installPrompt.userChoice.catch(() => ({}));
        installPrompt = null;
        if (r && r.outcome === 'accepted') { el.remove(); return; }
        b.hidden = true;
        el.querySelector('.ins-how').hidden = false;
        return;
      }
      try { localStorage.setItem('mentat.installAsk', JSON.stringify(a === 'never' ? { never: true } : { later: Date.now() })); } catch (err) { /* private mode */ }
      el.remove();
      if (a === 'never') say('You can install Mentat any time from Settings → This device.', 6000);
    });
  }
  // Chrome may offer its install dialog a moment after the page opens: switch the sheet over.
  window.addEventListener('beforeinstallprompt', () => {
    const el = document.getElementById('install-sheet');
    if (!el) return;
    const b = el.querySelector('[data-ins="install"]');
    if (b) b.hidden = false;
    const how = el.querySelector('.ins-how');
    if (how) how.hidden = true;
  });
  window.addEventListener('appinstalled', () => { const el = document.getElementById('install-sheet'); if (el) el.remove(); });
  window.addEventListener('load', () => setTimeout(installSheet, 1200));

  // The install note and button say what fits this device. Only writes when something differs:
  // a write is itself a change the observer sees, so writing every time would never stop.
  document.addEventListener('DOMContentLoaded', () => {
    const fill = () => {
      const n = document.getElementById('web-install-note');
      if (n && !n.dataset.filled) { n.dataset.filled = '1'; n.textContent = `${n.textContent} ${installHelp()}`; }
      const btn = document.querySelector('[data-web="notify"]');
      const want = 'Notification' in window && Notification.permission === 'granted' ? 'Allowed' : 'Allow notifications';
      if (btn && btn.textContent !== want) btn.textContent = want;
    };
    new MutationObserver(fill).observe(document.body, { childList: true, subtree: true });
  });

  // ---- Alerts while Mentat is closed (opt-in): a push subscription plus your key on the server ----
  const pushSupported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  const b64ToBytes = s => { const b = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)); return Uint8Array.from(b, c => c.charCodeAt(0)); };
  let pushCfg = null;
  async function pushRefresh() {
    const btn = document.querySelector('[data-web="push"]');
    if (!btn || !core || !core.sync.signedIn()) return;
    try { pushCfg = await core.sync.req('GET', 'push/config'); } catch (e) { pushCfg = null; }
    const on = !!(pushCfg && pushCfg.on);
    btn.textContent = on ? 'Turn off' : 'Turn on';
    btn.disabled = !pushCfg || !pushCfg.available;
    const prefs = document.getElementById('push-prefs');
    const actions = document.getElementById('push-actions');
    if (prefs) prefs.hidden = !on;
    if (actions) actions.hidden = !on;
    for (const c of document.querySelectorAll('[data-push-pref]')) c.checked = !!(pushCfg && pushCfg.prefs[c.dataset.pushPref]);
    const st = document.getElementById('push-status');
    if (st) st.textContent = on ? `On for ${pushCfg.devices} device${pushCfg.devices === 1 ? '' : 's'}.` : '';
    if (pushCfg && !pushCfg.available) document.getElementById('push-note').textContent = 'Not available on this Mentat server yet.';
  }
  async function pushOn() {
    if (isIOS && !standalone) return say('On iPhone and iPad, alerts work from the installed app: open Mentat in Safari, tap Share, then "Add to Home Screen", and turn this on from there.', 14000);
    if (!pushSupported) return say("This browser can't receive alerts while Mentat is closed.");
    if ((await Notification.requestPermission()) !== 'granted') return say("Notifications are blocked for Mentat. Allow them in the browser's site settings, then try again.");
    const key = core.api.getKey();
    if (!key) return say('Add your Torn API key first (Settings → Account).');
    const cfg = pushCfg || await core.sync.req('GET', 'push/config');
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(cfg.publicKey) });
    const device = isPhone ? (isIOS ? 'iPhone / iPad' : 'Android phone') : 'Computer browser';
    pushCfg = await core.sync.req('POST', 'push/subscribe', { body: { subscription: sub.toJSON(), key, device } });
    say('Alerts are on. You\'ll get them here even when Mentat is closed.');
  }
  async function pushOff() {
    const reg = await navigator.serviceWorker.getRegistration('/app/');
    const sub = reg && await reg.pushManager.getSubscription();
    // Turning it off on one device leaves your other devices as they are.
    pushCfg = await core.sync.req('POST', 'push/unsubscribe', { body: { endpoint: sub ? sub.endpoint : null } });
    if (sub) await sub.unsubscribe().catch(() => {});
    say(pushCfg.on ? 'Alerts are off on this device.' : 'Alerts are off, and your key has been deleted from the server.');
  }
  document.addEventListener('click', async e => {
    const b = e.target.closest && e.target.closest('[data-web="push"], [data-web="push-test"]');
    if (!b || !core) return;
    b.disabled = true;
    try {
      if (b.dataset.web === 'push-test') { const r = await core.sync.req('POST', 'push/test', { body: {} }); say(r.sent ? 'Test alert sent.' : 'No device got it: turn alerts off and on again here.'); }
      else if (pushCfg && pushCfg.on) await pushOff();
      else await pushOn();
    } catch (err) { say(String(err.message || err)); }
    b.disabled = false;
    pushRefresh();
  });
  document.addEventListener('change', async e => {
    const c = e.target.closest && e.target.closest('[data-push-pref]');
    if (!c || !core) return;
    const prefs = {};
    for (const x of document.querySelectorAll('[data-push-pref]')) prefs[x.dataset.pushPref] = x.checked;
    try { pushCfg = await core.sync.req('POST', 'push/prefs', { body: { prefs } }); } catch (err) { say(String(err.message || err)); }
  });
  // Once signed in and the settings are on the page.
  ready.then(c => {
    let tries = 0;
    const wait = setInterval(() => {
      if (document.querySelector('[data-web="push"]') && c.sync.signedIn()) { clearInterval(wait); pushRefresh(); }
      if (++tries > 120) clearInterval(wait);
    }, 1000);
    let lastTry = 0;
    c.sync.on('state', () => {
      if (!c.sync.signedIn() || pushCfg || Date.now() - lastTry < 30e3) return;
      lastTry = Date.now();
      pushRefresh();
    });
  }).catch(() => {});

  window.app = {
    cmd: async (name, ...args) => {
      const c = await ready;
      const fn = c.commands[name] || WEB_COMMANDS[name];
      if (!fn) return null; // Windows-only (pop-outs, the Torn browser's tabs…)
      const r = await fn(...args);
      c.sync.afterCommand(name, args);
      return r === undefined ? null : r;
    },
    on: (channel, fn) => {
      if (!subs.has(channel)) subs.set(channel, []);
      subs.get(channel).push(fn);
    },
  };
})();
