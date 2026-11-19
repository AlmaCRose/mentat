// ==UserScript==
// @name         Mentat bubbles
// @namespace    mentat.example.com
// @version      1.1.0
// @description  Mentat's floating bubbles in Torn PDA: landing time, chain timer, energy and nerve, cooldowns and the ranked war lead. For members of the faction's Mentat server.
// @author       Mentat
// @match        https://www.torn.com/*
// @run-at       document-end
// @downloadURL  https://mentat.example.com/pda/mentat-bubbles.user.js
// @updateURL    https://mentat.example.com/pda/mentat-bubbles.user.js
// ==/UserScript==

// What it does: shows small draggable bubbles over Torn pages with live countdowns. It only
// displays: it never reads, changes or clicks anything on Torn's pages, and tapping a bubble just
// opens the matching Torn page.
// Data: your bars, cooldowns, travel and chain from Torn's API with your Torn PDA key (one request
// a minute), and your faction's ranked war every 5 minutes. To check you're a member, the key is
// sent once to the Mentat server, which asks Torn who you are and then forgets the key; the session
// it gives back is kept in Torn PDA's own script storage.

(async () => {
  'use strict';
  if (window.top !== window.self || window.__mentatBubbles) return;
  window.__mentatBubbles = true;

  const SERVER = 'https://mentat.example.com';
  const GUIDE = `${SERVER}/pda/`;
  const KEY = '###PDA-APIKEY###';
  const hasKey = /^[A-Za-z0-9]{16}$/.test(KEY);
  const SEC = 1000;

  // ---- Storage: Torn PDA's per-script store, or the page's localStorage outside PDA ----
  const pdaStore = typeof PDA_storage !== 'undefined' ? PDA_storage : null; // eslint-disable-line no-undef
  const store = {
    async get(k, d) {
      try { if (pdaStore) return (await pdaStore.get(k, d)) ?? d; const v = localStorage.getItem(`mentat.${k}`); return v === null ? d : JSON.parse(v); } catch (e) { return d; }
    },
    async set(k, v) {
      try { if (pdaStore) await pdaStore.set(k, v); else localStorage.setItem(`mentat.${k}`, JSON.stringify(v)); } catch (e) { /* full: keep going in memory */ }
    },
  };
  const DEFAULT_ON = { travel: true, chain: true, energy: true, nerve: true, life: false, cooldowns: true, war: true };
  const cfg = await store.get('cfg', {});
  cfg.on = { ...DEFAULT_ON, ...(cfg.on || {}) };
  cfg.pos = cfg.pos || {};
  cfg.group = cfg.group !== false; // the Mentat button that hides or shows them all
  cfg.collapsed = !!cfg.collapsed;
  const saveCfg = () => store.set('cfg', cfg);

  // ---- HTTP: Torn PDA's handlers reach the Mentat server; Torn's API allows the page itself ----
  async function server(method, path, body, token) {
    const headers = { 'Content-Type': 'application/json', Accept: 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    const url = `${SERVER}/api/v1/${path}`;
    let status, text;
    if (typeof PDA_httpGet === 'function') { // eslint-disable-line no-undef
      const r = method === 'POST' ? await PDA_httpPost(url, headers, JSON.stringify(body || {})) : await PDA_httpGet(url, headers); // eslint-disable-line no-undef
      status = Number(r.status);
      text = r.responseText;
    } else {
      const r = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
      status = r.status;
      text = await r.text();
    }
    let json = null;
    try { json = JSON.parse(text); } catch (e) { /* not JSON */ }
    return { status, json };
  }
  async function torn(path) {
    const sep = path.includes('?') ? '&' : '?';
    const r = await fetch(`https://api.torn.com${path}${sep}key=${KEY}&comment=Mentat`);
    const d = await r.json();
    if (d && d.error) throw Object.assign(new Error(d.error.error || 'Torn API error'), { code: d.error.code });
    return d;
  }

  // ---- Membership: the Mentat server checks the key's faction, then forgets the key ----
  let me = await store.get('me', null);
  async function signIn() {
    const r = await server('POST', 'login', { key: KEY, device: 'Torn PDA bubbles' });
    if (r.status === 200 && r.json && r.json.session) {
      me = { ...r.json.me, checkedAt: Date.now() };
      await store.set('session', r.json.session);
      await store.set('me', me);
      return true;
    }
    if (r.status === 403) { await store.set('refusedAt', Date.now()); notice((r.json && r.json.error) || 'Mentat is for members of the faction.'); }
    else notice((r.json && r.json.error) || "Couldn't reach the Mentat server.");
    return false;
  }
  async function checkMember() {
    if (Date.now() - (await store.get('refusedAt', 0)) < 12 * 3600 * SEC) return false; // asked recently: not a member
    const session = await store.get('session', '');
    if (session && me && Date.now() - (me.checkedAt || 0) < 6 * 3600 * SEC) return true;
    if (session) {
      const r = await server('GET', 'me', null, session).catch(() => null);
      if (r && r.status === 200) { me = { ...r.json, checkedAt: Date.now() }; await store.set('me', me); return true; }
      if (r && r.status !== 401) return !!me; // server unreachable: keep going with the last answer
    }
    return signIn();
  }

  // ---- The bubbles ----
  const BUBBLES = [
    ['travel', 'Landing', 'https://www.torn.com/index.php', '<path d="M21 16v-2l-8-5V3.5a1.5 1.5 0 0 0-3 0V9l-8 5v2l8-2.5V19l-2 1.5V22l3.5-1 3.5 1v-1.5L13 19v-5.5z"/>'],
    ['chain', 'Chain', 'https://www.torn.com/factions.php?step=your#/war/chain', '<path d="M10.6 13.4a1 1 0 0 1 0-1.4l3-3a1 1 0 1 1 1.4 1.4l-3 3a1 1 0 0 1-1.4 0zM8 18.5a3.5 3.5 0 0 1-2.5-6l2.3-2.3 1.4 1.4-2.3 2.3a1.5 1.5 0 0 0 2.1 2.1l2.3-2.3 1.4 1.4-2.3 2.3a3.5 3.5 0 0 1-2.4 1.1zm8.3-4.7-1.4-1.4 2.3-2.3a1.5 1.5 0 0 0-2.1-2.1l-2.3 2.3-1.4-1.4 2.3-2.3a3.5 3.5 0 0 1 5 5z"/>'],
    ['energy', 'Energy', 'https://www.torn.com/gym.php', '<path d="M13 2 4 14h6l-1 8 9-12h-6z"/>'],
    ['nerve', 'Nerve', 'https://www.torn.com/page.php?sid=crimes', '<path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm-1 5h2v6h-2zm0 8h2v2h-2z"/>'],
    ['life', 'Life', 'https://www.torn.com/item.php#medical-items', '<path d="M12 21s-7-4.4-9.3-9A5.3 5.3 0 0 1 12 6a5.3 5.3 0 0 1 9.3 6c-2.3 4.6-9.3 9-9.3 9z"/>'],
    ['cooldowns', 'Cooldowns', 'https://www.torn.com/item.php', '<path fill-rule="evenodd" d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm0 2a8 8 0 1 1 0 16 8 8 0 0 1 0-16zm-1 3h2v5.2l3.6 2.1-1 1.7L11 13.4z"/>'],
    ['war', 'Ranked war', 'https://www.torn.com/factions.php?step=your#/war/rank', '<path d="M6.9 3 3 6.9l4.6 4.6-1.9 1.9 1.4 1.4 1.4-1.4 2.1 2.1-3.2 3.2a1.5 1.5 0 0 0 2.1 2.1l3.2-3.2 2.1 2.1-1.4 1.4 1.4 1.4 1.9-1.9 4.6 4.6L21 17.1 6.9 3zm10.2 0-5.3 5.3 3.9 3.9L21 6.9V3h-3.9z"/>'],
  ];

  const host = document.createElement('div');
  host.id = 'mentat-bubbles';
  host.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483000;';
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `<style>
    :host { all: initial; }
    .b { position: fixed; width: 48px; height: 48px; border-radius: 50%; background: #23201c; border: 2px solid #9a6a1f;
      display: flex; align-items: center; justify-content: center; pointer-events: auto; touch-action: none; user-select: none; -webkit-user-select: none;
      box-shadow: 0 3px 10px rgba(0,0,0,.55); font: 600 11px/1 -apple-system, "Segoe UI", Roboto, sans-serif; color: #f1e6d3; -webkit-tap-highlight-color: transparent; }
    .b svg { width: 22px; height: 22px; fill: #e9d3ae; pointer-events: none; }
    .b .t { position: absolute; top: 38px; left: 50%; transform: translateX(-50%); min-width: 30px; max-width: 76px; padding: 2px 6px; box-sizing: border-box; border-radius: 9px;
      background: #2c2924; border: 1.5px solid #4a4339; color: #f1e6d3; font-size: 11px; line-height: 14px; text-align: center; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-variant-numeric: tabular-nums; }
    .b.ok .t { border-color: #57a64a; color: #9fde8e; }
    .b.warn .t { border-color: #e0912d; color: #ffcf8f; }
    .b.bad { border-color: #e5534b; animation: p 1.4s ease-in-out infinite; }
    .b.bad .t { border-color: #e5534b; background: #e5534b; color: #fff; }
    .b.info .t { border-color: #4ea1e8; }
    .b[hidden] { display: none; }
    .m { width: 40px; height: 40px; background: #1a1714; border-color: #b07a22; }
    .m img, .m svg { width: 15px; height: 27px; pointer-events: none; }
    .m.open { opacity: .85; }
    .m .t { top: 31px; }
    @keyframes p { 50% { box-shadow: 0 3px 10px rgba(0,0,0,.55), 0 0 0 7px rgba(229,83,75,0); } 0%,100% { box-shadow: 0 3px 10px rgba(0,0,0,.55), 0 0 0 0 rgba(229,83,75,.5); } }
    @media (prefers-reduced-motion: reduce) { .b.bad { animation: none; } }
    .panel { position: fixed; left: 50%; top: 50%; transform: translate(-50%, -50%); width: min(320px, calc(100vw - 32px)); pointer-events: auto;
      background: #1e1c19; color: #eee; border: 1px solid #4a4339; border-radius: 12px; padding: 14px 16px; box-shadow: 0 12px 40px rgba(0,0,0,.6);
      font: 14px/1.4 -apple-system, "Segoe UI", Roboto, sans-serif; }
    .panel h2 { margin: 0 0 2px; font-size: 16px; color: #e9d3ae; }
    .panel .muted { color: #a59a8a; font-size: 12px; }
    .panel label { display: flex; align-items: center; gap: 10px; padding: 7px 0; border-bottom: 1px solid #2f2c27; }
    .panel input { width: 20px; height: 20px; accent-color: #b07a22; }
    .panel .row { display: flex; gap: 8px; margin-top: 12px; flex-wrap: wrap; }
    .panel button, .panel a { flex: 1; padding: 9px 10px; border-radius: 8px; border: 1px solid #4a4339; background: #2c2924; color: #eee; font: inherit; text-align: center; text-decoration: none; }
    .panel button.primary { background: #9a6a1f; border-color: #b07a22; color: #fff; }
    .note { position: fixed; left: 50%; bottom: 80px; transform: translateX(-50%); max-width: calc(100vw - 32px); pointer-events: auto; padding: 10px 14px; border-radius: 10px;
      background: #2c2924; border: 1px solid #9a6a1f; color: #f1e6d3; font: 13px/1.4 -apple-system, "Segoe UI", Roboto, sans-serif; box-shadow: 0 8px 24px rgba(0,0,0,.5); }
  </style>`;
  document.documentElement.appendChild(host);

  function notice(text, ms = 8000) {
    const n = document.createElement('div');
    n.className = 'note';
    n.textContent = `Mentat: ${text}`;
    root.appendChild(n);
    setTimeout(() => n.remove(), ms);
  }

  const els = {};
  BUBBLES.forEach(([id, label, , icon], i) => {
    const b = document.createElement('div');
    b.className = 'b';
    b.hidden = true;
    b.setAttribute('role', 'button');
    b.setAttribute('aria-label', label);
    b.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${icon}</svg><span class="t"></span>`;
    root.appendChild(b);
    els[id] = b;
    drag(b, id, () => {
      const url = BUBBLES.find(x => x[0] === id)[2];
      if (location.href !== url) location.href = url;
    });
  });

  // The Mentat button: tap to hide or show every bubble; while they're hidden it shows the most
  // urgent one's countdown (the chain, else the landing time).
  const MARK = 'data:image/png;base64,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';
  const MARK_SVG = '<svg viewBox="0 0 15 27" aria-hidden="true" fill="none" stroke="#e9cf9f" stroke-width="2.6" stroke-linejoin="round"><path d="M7.5 9.2 12.6 14.3 7.5 19.4 2.4 14.3Z"/><path d="M7.5 9.2 12.9 3.8M7.5 19.4 2.1 24.8"/></svg>';
  const main = document.createElement('div');
  main.className = 'b m';
  main.hidden = true;
  main.setAttribute('role', 'button');
  main.innerHTML = `<img alt=""><span class="t"></span>`;
  const markImg = main.querySelector('img');
  markImg.addEventListener('error', () => { markImg.outerHTML = MARK_SVG; }, { once: true }); // a page that blocks data: images
  markImg.src = MARK;
  root.appendChild(main);
  drag(main, 'main', () => { cfg.collapsed = !cfg.collapsed; saveCfg(); render(); });

  // Saved place (as a share of the screen, so it survives rotating). Bubbles that haven't been
  // moved stack under the Mentat button (or down the right edge without it), with no gaps for
  // hidden ones.
  const clampX = (x, w = 52) => Math.max(4, Math.min(window.innerWidth - w, x));
  const clampY = (y, h = 70) => Math.max(4, Math.min(window.innerHeight - h, y));
  function placeMain() {
    const p = cfg.pos.main;
    main.style.left = `${clampX(p ? p.x * window.innerWidth : window.innerWidth - 54, 44)}px`;
    main.style.top = `${clampY(p ? p.y * window.innerHeight : 96, 60)}px`;
  }
  function place(id, i) {
    const b = els[id];
    const p = cfg.pos[id];
    let x, y;
    if (p) { x = p.x * window.innerWidth; y = p.y * window.innerHeight; }
    else if (cfg.group) { x = parseFloat(main.style.left) - 4; y = parseFloat(main.style.top) + 58 + i * 66; }
    else { x = window.innerWidth - 60; y = 120 + i * 66; }
    b.style.left = `${clampX(x)}px`;
    b.style.top = `${clampY(y)}px`;
  }
  function stack() {
    placeMain();
    let i = 0;
    for (const [id] of BUBBLES) {
      if (els[id].hidden) continue;
      place(id, cfg.pos[id] ? 0 : i++);
    }
  }
  window.addEventListener('resize', stack);

  // Drag to move; a tap does the bubble's job; holding for half a second opens the settings.
  function drag(b, id, onTap) {
    let start = null;
    let hold = null;
    b.addEventListener('pointerdown', e => {
      b.setPointerCapture(e.pointerId);
      const r = b.getBoundingClientRect();
      start = { x: e.clientX, y: e.clientY, dx: e.clientX - r.left, dy: e.clientY - r.top, moved: false, held: false };
      hold = setTimeout(() => { if (start && !start.moved) { start.held = true; openPanel(); } }, 550);
    });
    b.addEventListener('pointermove', e => {
      if (!start) return;
      if (Math.abs(e.clientX - start.x) + Math.abs(e.clientY - start.y) > 8) { start.moved = true; clearTimeout(hold); }
      if (start.moved) {
        const isMain = id === 'main';
        b.style.left = `${clampX(e.clientX - start.dx, isMain ? 44 : 52)}px`;
        b.style.top = `${clampY(e.clientY - start.dy, isMain ? 60 : 70)}px`;
        if (isMain) { cfg.pos.main = { x: parseFloat(b.style.left) / window.innerWidth, y: parseFloat(b.style.top) / window.innerHeight }; stack(); } // the stack follows
      }
    });
    const end = () => {
      clearTimeout(hold);
      if (!start) return;
      if (start.moved) {
        cfg.pos[id] = { x: parseFloat(b.style.left) / window.innerWidth, y: parseFloat(b.style.top) / window.innerHeight };
        saveCfg();
      } else if (!start.held) onTap();
      start = null;
    };
    b.addEventListener('pointerup', end);
    b.addEventListener('pointercancel', () => { clearTimeout(hold); start = null; });
    b.addEventListener('contextmenu', e => e.preventDefault());
  }

  function openPanel() {
    if (root.querySelector('.panel')) return;
    const p = document.createElement('div');
    p.className = 'panel';
    p.setAttribute('role', 'dialog');
    p.innerHTML = `<h2>Mentat bubbles</h2>
      <div class="muted">${me && me.name ? `Signed in as ${esc(me.name)}${me.faction && me.faction.name ? ` · ${esc(me.faction.name)}` : ''}` : 'Not signed in'}</div>
      <label><input type="checkbox" data-group ${cfg.group ? 'checked' : ''}> Mentat button: tap it to hide or show all bubbles</label>
      ${BUBBLES.map(([id, label]) => `<label><input type="checkbox" data-on="${id}" ${cfg.on[id] ? 'checked' : ''}> ${label}</label>`).join('')}
      <div class="muted" style="margin-top:6px">Bubbles show only when there's something to show (landing time while flying, the chain while it runs). Drag to move, tap to open the page, hold any bubble or the Mentat button for this menu.</div>
      <div class="row"><button data-act="reset">Reset places</button><a href="${GUIDE}" data-act="guide">Guide</a></div>
      <div class="row"><button data-act="signout">Sign out</button><button class="primary" data-act="close">Done</button></div>`;
    root.appendChild(p);
    p.addEventListener('change', e => {
      const c = e.target.closest('[data-on]');
      if (c) { cfg.on[c.dataset.on] = c.checked; saveCfg(); render(); }
      if (e.target.closest('[data-group]')) {
        cfg.group = e.target.checked;
        if (!cfg.group) cfg.collapsed = false; // without the button they can't be hidden
        saveCfg();
        render();
      }
    });
    p.addEventListener('click', async e => {
      const a = e.target.closest('[data-act]');
      if (!a) return;
      if (a.dataset.act === 'reset') { cfg.pos = {}; saveCfg(); stack(); }
      else if (a.dataset.act === 'signout') {
        const s = await store.get('session', '');
        if (s) server('POST', 'logout', {}, s).catch(() => {});
        await store.set('session', '');
        await store.set('me', null);
        me = null;
        stop();
        p.remove();
        notice('Signed out. Reload a page to sign in again.');
      } else if (a.dataset.act === 'close') p.remove();
    });
  }
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // ---- Data ----
  let data = { at: 0, bars: null, cooldowns: null, travel: null, war: null, warAt: 0, error: '' };
  const cached = await store.get('data', null); // last known values, so bubbles show at once on a new page
  if (cached && Date.now() - cached.at < 5 * 60 * SEC) data = { ...data, ...cached };

  async function refresh() {
    try {
      const u = await torn('/v2/user?selections=bars,cooldowns,travel');
      data.bars = u.bars || null;
      data.cooldowns = u.cooldowns || null;
      data.travel = u.travel || null;
      data.at = Date.now();
      data.error = '';
    } catch (e) {
      data.error = e.message;
      if ([2, 10, 13, 18].includes(e.code)) { notice(`Torn says: ${e.message}. Check the API key in Torn PDA.`); stop(); }
    }
    if (cfg.on.war && Date.now() - data.warAt > 5 * 60 * SEC) {
      try { const w = await torn('/v2/faction/wars'); data.war = (w.wars && w.wars.ranked) || null; data.warAt = Date.now(); } catch (e) { data.warAt = Date.now(); }
    }
    store.set('data', data);
    render();
  }

  // ---- Showing it ----
  const short = s => {
    s = Math.max(0, Math.floor(s));
    if (s < 3600) return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
    if (s < 86400) return `${Math.floor(s / 3600)}h${String(Math.floor(s % 3600 / 60)).padStart(2, '0')}`;
    return `${Math.floor(s / 86400)}d${Math.floor(s % 86400 / 3600)}h`;
  };
  const num = n => (Math.abs(n) >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : Math.abs(n) >= 1e4 ? `${Math.round(n / 1e3)}k` : Math.abs(n) >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n));
  // Seconds left now, counting down from the last reading.
  const left = s => Math.max(0, (Number(s) || 0) - (Date.now() - data.at) / SEC);

  const latest = {}; // what each bubble would show, for the Mentat button while they're hidden
  function show(id, text, tone, title) {
    const b = els[id];
    latest[id] = text === null ? null : { text, tone, title };
    const on = !!cfg.on[id] && text !== null && running && !(cfg.group && cfg.collapsed);
    b.hidden = !on;
    if (!on) return;
    b.className = `b ${tone || ''}`;
    b.querySelector('.t').textContent = text;
    b.title = title || '';
    b.setAttribute('aria-label', title || text);
  }

  function render() {
    const now = Date.now() / SEC;
    const bars = data.bars || {};
    // Travel: flying, then abroad.
    const tr = data.travel;
    if (tr && tr.time_left > 0) show('travel', short(left(tr.time_left)), 'info', `Landing in ${tr.destination} in ${short(left(tr.time_left))}`);
    else if (tr && tr.destination && tr.destination !== 'Torn') show('travel', 'abroad', '', `In ${tr.destination}`);
    else show('travel', null);
    // Chain: running, then cooldown.
    const c = bars.chain;
    if (c && c.current > 0 && c.timeout > 0) {
      const s = left(c.timeout);
      show('chain', short(s), s < 60 ? 'bad' : s < 120 ? 'warn' : 'ok', `Chain ${c.current}, ${short(s)} left`);
    } else if (c && c.cooldown > 0) show('chain', short(left(c.cooldown)), 'info', `Chain cooldown, ${short(left(c.cooldown))}`);
    else show('chain', null);
    // Bars: the value, green when full.
    for (const [id, letter] of [['energy', 'E'], ['nerve', 'N'], ['life', '♥']]) {
      const b = bars[id];
      if (!b) { show(id, null); continue; }
      const full = b.current >= b.maximum || left(b.full_time) <= 0;
      show(id, `${letter} ${num(b.current)}`, full ? 'ok' : '', `${id[0].toUpperCase()}${id.slice(1)} ${b.current}/${b.maximum}${full ? ', full' : `, full in ${short(left(b.full_time))}`}`);
    }
    // Cooldowns: the drug cooldown first, then booster, then medical.
    const cd = data.cooldowns || {};
    const which = [['drug', 'D'], ['booster', 'B'], ['medical', 'M']].find(([k]) => left(cd[k]) > 0);
    show('cooldowns', which ? `${which[1]} ${short(left(cd[which[0]]))}` : null, '', [['drug', 'Drug'], ['booster', 'Booster'], ['medical', 'Medical']].map(([k, l]) => `${l}: ${left(cd[k]) > 0 ? short(left(cd[k])) : 'ready'}`).join(' · '));
    // Ranked war: countdown to the start, then the lead.
    const w = data.war;
    if (w && w.factions && (!w.end || w.end > now)) {
      if (w.start > now) show('war', short(w.start - now), 'info', 'Ranked war starts in');
      else {
        const us = w.factions.find(f => me && f.id === me.factionId) || w.factions[0];
        const them = w.factions.find(f => f !== us) || w.factions[1];
        const lead = (us && them) ? us.score - them.score : 0;
        show('war', `${lead >= 0 ? '+' : '−'}${num(Math.abs(lead))}`, lead >= 0 ? 'ok' : 'bad', us && them ? `${us.score} to ${them.score} vs ${them.name}` : 'Ranked war');
      }
    } else show('war', null);
    renderMain();
    stack();
  }

  function renderMain() {
    main.hidden = !running || !cfg.group;
    if (main.hidden) return;
    const col = cfg.collapsed;
    const urgent = col ? ['chain', 'travel'].map(id => cfg.on[id] && latest[id]).find(Boolean) : null;
    main.className = `b m ${col ? (urgent && urgent.tone) || '' : 'open'}`;
    const t = main.querySelector('.t');
    t.hidden = !urgent;
    t.textContent = urgent ? urgent.text : '';
    const what = col ? `Mentat: ${urgent ? `${urgent.title}. ` : ''}tap to show the bubbles` : 'Mentat: tap to hide the bubbles';
    main.title = what;
    main.setAttribute('aria-label', what);
    main.setAttribute('aria-expanded', String(!col));
  }

  // ---- Start ----
  let running = false;
  let timers = [];
  function stop() { running = false; timers.forEach(clearInterval); timers = []; render(); }
  if (!hasKey) { notice('add your API key in Torn PDA (Settings) to use the bubbles.'); return; }
  if (!(await checkMember())) return;
  running = true;
  render();
  if (Date.now() - data.at > 55 * SEC) refresh();
  timers.push(setInterval(render, SEC));
  timers.push(setInterval(() => { if (!document.hidden) refresh(); }, 60 * SEC));
  document.addEventListener('visibilitychange', () => { if (!document.hidden && running && Date.now() - data.at > 30 * SEC) refresh(); });
})();
