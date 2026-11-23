// ==UserScript==
// @name         Mentat war board
// @namespace    mentat.example.com
// @version      1.0.18
// @description  The enemy faction with dibs, and a shared hit queue with the time each person hits the chain. For members of the faction's Mentat server. Works in Torn PDA and in browsers (Tampermonkey).
// @author       Mentat
// @match        https://www.torn.com/*
// @run-at       document-end
// @noframes
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_setClipboard
// @grant        GM.xmlHttpRequest
// @grant        GM.getValue
// @grant        GM.setValue
// @grant        GM.setClipboard
// @connect      mentat.example.com
// @connect      ffscouter.com
// @downloadURL  https://mentat.example.com/pda/mentat-war.user.js
// @updateURL    https://mentat.example.com/pda/mentat-war.meta.js
// ==/UserScript==

// What it does: a button over Torn pages opens the war board: the enemy faction's members with
// their status and dibs (claims), and the faction's hit queue with an estimated time for each
// hit. It only displays and links: it never reads, changes or clicks anything on Torn's pages.
// Data: everything comes from the Mentat server (it reads the chain, the enemy and who hit from
// Torn with its own key), so the board makes no Torn API calls with your key. To check you're a
// member, your key is sent once to the Mentat server, which asks Torn who you are and then
// forgets it; the session it gives back is kept in the script's own storage.

(async () => {
  'use strict';
  if (window.top !== window.self || window.__mentatWar) return;
  window.__mentatWar = true;

  const VERSION = '1.0.18';
  const SERVER = 'https://mentat.example.com';
  const GUIDE = `${SERVER}/pda/war.html`;
  const PDA_KEY = '###PDA-APIKEY###';
  const pdaKey = /^[A-Za-z0-9]{16}$/.test(PDA_KEY) ? PDA_KEY : '';
  const SEC = 1000;
  /* global PDA_storage, PDA_httpGet, PDA_httpPost, GM_xmlhttpRequest, GM_getValue, GM_setValue, GM_setClipboard, GM, GM_info */
  // Script managers: Torn PDA (PDA_*), Tampermonkey and others (GM_*), and ones with only the
  // newer GM.* functions, like Userscripts on iPad/iPhone Safari (the user's request, 2026-11-22).
  const GM4 = typeof GM !== 'undefined' && GM ? GM : null;
  const handler = (typeof GM_info !== 'undefined' && GM_info && GM_info.scriptHandler) || (GM4 && GM4.info && GM4.info.scriptHandler) || '';
  const isPda = typeof PDA_httpGet === 'function';

  // ---- Storage: Torn PDA's script store, Tampermonkey's, or localStorage ----
  const store = {
    async get(k, d) {
      try {
        if (typeof PDA_storage !== 'undefined') return (await PDA_storage.get(`war.${k}`, d)) ?? d;
        if (typeof GM_getValue === 'function') return GM_getValue(`war.${k}`, d) ?? d;
        if (GM4 && typeof GM4.getValue === 'function') return (await GM4.getValue(`war.${k}`, d)) ?? d;
        const v = localStorage.getItem(`mentat.war.${k}`);
        return v === null ? d : JSON.parse(v);
      } catch (e) { return d; }
    },
    async set(k, v) {
      try {
        if (typeof PDA_storage !== 'undefined') await PDA_storage.set(`war.${k}`, v);
        else if (typeof GM_setValue === 'function') GM_setValue(`war.${k}`, v);
        else if (GM4 && typeof GM4.setValue === 'function') await GM4.setValue(`war.${k}`, v);
        else localStorage.setItem(`mentat.war.${k}`, JSON.stringify(v));
      } catch (e) { /* keep going in memory */ }
    },
  };
  const cfg = Object.assign({ pos: null, tab: 'queue', filter: 'all', vibrate: true, open: false, live: 0, attackLight: true, lightSmall: false, sort: 'status', dir: 1, sort2: '', dir2: 1, filter: 'all', ofilter: 'all', osort: 'status', odir: 1, osort2: '', odir2: 1, online: true, idle: true, offline: true, oonline: true, oidle: true, ooffline: true, shareE: false, energyAsked: false, tf: { preset: '', minl: '', maxl: '', minff: 1.5, maxff: 2.5, inactive: true, fless: false } }, await store.get('cfg', {}));
  if (!['all', 'range', 'hittable', 'soon', 'hospital', 'travel', 'online', 'dibs'].includes(cfg.filter)) cfg.filter = 'all';
  if (!['all', 'online', 'okay', 'hospital', 'revivable', 'travel'].includes(cfg.ofilter)) cfg.ofilter = 'all';
  const saveCfg = () => store.set('cfg', cfg);

  // ---- HTTP to the Mentat server: Torn PDA's handler, Tampermonkey's, or fetch ----
  function gmRequest(method, url, headers, data) {
    return new Promise((resolve, reject) => GM_xmlhttpRequest({
      method, url, headers, data, timeout: 15000,
      onload: r => resolve({ status: r.status, text: r.responseText }),
      onerror: () => reject(new Error('network')), ontimeout: () => reject(new Error('timeout')),
    }));
  }
  async function xhr(method, url, headers, data) {
    let r;
    if (isPda) {
      const x = method === 'POST' ? await PDA_httpPost(url, headers, data) : await PDA_httpGet(url, headers);
      r = { status: Number(x.status), text: x.responseText };
    } else if (typeof GM_xmlhttpRequest === 'function') r = await gmRequest(method, url, headers, data);
    else if (GM4 && typeof GM4.xmlHttpRequest === 'function') {
      const x = await GM4.xmlHttpRequest({ method, url, headers, data, timeout: 15000 });
      r = { status: Number(x.status), text: x.responseText };
    } else { const x = await fetch(url, { method, headers, body: data }); r = { status: x.status, text: await x.text() }; }
    return r;
  }
  async function server(method, path, body, token) {
    const headers = { 'Content-Type': 'application/json', Accept: 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    const r = await xhr(method, `${SERVER}/api/v1/${path}`, headers, method === 'POST' ? JSON.stringify(body || {}) : undefined);
    let json = null;
    try { json = JSON.parse(r.text); } catch (e) { /* not JSON */ }
    return { status: r.status, json };
  }

  // ---- Sign-in: the server checks the key's faction, then forgets the key ----
  let session = await store.get('session', '');
  let me = await store.get('me', null);
  let signError = '';
  async function signIn(key) {
    signError = '';
    let r;
    try { r = await server('POST', 'login', { key, device: isPda ? 'Torn PDA war board' : 'War board (browser)' }); } catch (e) { signError = "Couldn't reach the Mentat server."; return false; }
    if (r.status === 200 && r.json && r.json.session) {
      session = r.json.session;
      me = { ...r.json.me, checkedAt: Date.now() };
      await store.set('session', session);
      await store.set('me', me);
      await store.set('refusedAt', 0);
      // Browsers: keep the key you signed in with on this device (the user's request, 2026-11-23),
      // so Live, energy sharing and your stats need no second key. Only ever sent to api.torn.com.
      if (!pdaKey) { liveKey = key; await store.set('liveKey', key); }
      return true;
    }
    if (r.status === 403) await store.set('refusedAt', Date.now());
    signError = (r.json && r.json.error) || "Couldn't sign in. Try again.";
    return false;
  }
  async function signOut() {
    if (session) server('POST', 'logout', {}, session).catch(() => {});
    session = '';
    me = null;
    board = null;
    await store.set('session', '');
    await store.set('me', null);
    if (!pdaKey) { liveKey = ''; await store.set('liveKey', ''); } // sign out also forgets the key
    render();
  }

  // ---- FFScouter (optional): fair fight and estimated battle stats ----
  // Uses YOUR FFScouter key (a Torn API key registered at ffscouter.com; in Torn PDA, the PDA key
  // if it's registered), because FFScouter's fair fight is worked out against the key owner's own
  // stats. Requests go straight to ffscouter.com, never to Torn or the Mentat server. Estimates
  // change slowly: each player is refreshed every 6 hours, up to 205 per request.
  const FFS = 'https://ffscouter.com/api/v1';
  const FFS_KEY_ERRORS = { 2: 'invalid key format', 6: 'key not registered at ffscouter.com', 4010: 'your account is banned from FFScouter', 4011: 'your faction is banned from FFScouter' };
  const ffs = Object.assign({ on: false, pda: false, premium: false, error: '' }, await store.get('ffs', {}));
  let ffsKey = ffs.on ? (ffs.pda ? pdaKey : await store.get('ffsKey', '')) : '';
  let ffsStats = await store.get('ffsStats', {}); // id -> { ff, bs, bsHuman, at }
  let ffsBusy = false;
  let ffsPausedUntil = 0;
  let ffsLast = 0;
  async function ffsCall(path, params) {
    const r = await xhr('GET', `${FFS}/${path}?${new URLSearchParams(params)}`, { Accept: 'application/json' });
    let d = null;
    try { d = JSON.parse(r.text); } catch (e) { /* not JSON */ }
    if (r.status !== 200 || (d && d.error)) throw Object.assign(new Error((d && d.error) || `FFScouter returned HTTP ${r.status}`), { code: d && d.code, retry: d && d.retry_after_seconds });
    return d;
  }
  async function ffsEnable(key, viaPda) {
    ffs.error = '';
    let info;
    try { info = await ffsCall('check-key', { key }); } catch (e) { ffs.error = `FFScouter: ${e.message}`; return false; }
    if (!info.is_registered) { ffs.error = "That key isn't registered with FFScouter yet. Sign up at ffscouter.com first."; return false; }
    Object.assign(ffs, { on: true, pda: !!viaPda, premium: !!info.is_premium, error: '', ackAt: Date.now() });
    ffsKey = key;
    await store.set('ffsKey', viaPda ? '' : key);
    await store.set('ffs', ffs);
    ffsLast = 0;
    return true;
  }
  async function ffsOff(reason = '') {
    Object.assign(ffs, { on: false, pda: false, error: reason });
    ffsKey = '';
    ffsStats = {};
    await store.set('ffsKey', '');
    await store.set('ffs', ffs);
    await store.set('ffsStats', {});
  }
  async function ffsTick() {
    const now = Date.now();
    if (!ffs.on || !ffsKey || ffsBusy || now < ffsPausedUntil || now - ffsLast < 20 * SEC || !board) return;
    const ids = new Set();
    if (board.enemy && board.enemy.members) for (const m of board.enemy.members) ids.add(m.id);
    if (board.me && board.me.id) ids.add(board.me.id); // FFScouter's estimate of you (for "Around your range")
    if (board.ours && board.ours.members) for (const m of board.ours.members) ids.add(m.id);
    for (const e of (board.queue && board.queue.entries) || []) if (e.target) ids.add(e.target);
    const need = [...ids].filter(id => !ffsStats[id] || now - ffsStats[id].at > 6 * 3600 * SEC);
    if (!need.length) return;
    ffsBusy = true;
    ffsLast = now;
    try {
      for (let i = 0; i < need.length; i += 205) {
        const chunk = need.slice(i, i + 205);
        const data = await ffsCall('get-stats', { key: ffsKey, targets: chunk.join(',') });
        for (const p of data || []) ffsStats[p.player_id] = { ff: p.fair_fight ?? null, bs: p.bs_estimate ?? null, bsHuman: p.bs_estimate_human || '', at: Date.now() };
        for (const id of chunk) if (!ffsStats[id]) ffsStats[id] = { ff: null, bs: null, at: Date.now() };
      }
      // Keep only players on the board now.
      for (const id of Object.keys(ffsStats)) if (!ids.has(Number(id))) delete ffsStats[id];
      await store.set('ffsStats', ffsStats);
      ffs.error = '';
    } catch (e) {
      if (e.code in FFS_KEY_ERRORS) await ffsOff(`FFScouter turned off: ${FFS_KEY_ERRORS[e.code]}.`);
      else { const wait = e.code === 21 ? Math.max(15, e.retry || 60) : 300; ffsPausedUntil = Date.now() + wait * SEC; ffs.error = `FFScouter: ${e.message}. Trying again in ${Math.ceil(wait / 60)} min.`; }
    } finally {
      ffsBusy = false;
      render();
    }
  }
  const ffOf = id => (ffs.on && ffsStats[id]) || null;

  // Target search (Targets tab): FFScouter's target finder with your key, like Mentat's Targets tab
  // (src/main/features/ffscouter.js findTargets): its "best respect" / "level hunting" lists, or
  // level, fair fight, inactive-only and no-faction filters; up to 50 players. Results are kept in
  // script storage, since the board reloads with every Torn page.
  const finder = Object.assign({ results: [], at: 0, error: '' }, await store.get('ffsFinder', {}));
  let finderBusy = false;
  async function ffsFind() {
    if (!ffs.on || !ffsKey || finderBusy) return;
    const p = cfg.tf;
    const params = { key: ffsKey, limit: 50 };
    const int = (v, lo, hi) => { const n = Math.round(Number(v)); return v !== '' && Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : null; };
    if (p.preset === 'respect' || p.preset === 'level') params.preset = p.preset;
    else {
      const minlevel = int(p.minl, 1, 100), maxlevel = int(p.maxl, 1, 100);
      if (minlevel) params.minlevel = minlevel;
      if (maxlevel) params.maxlevel = maxlevel;
      const minff = Number(p.minff), maxff = Number(p.maxff);
      if (minff >= 1) params.minff = minff;
      if (maxff >= 1) params.maxff = maxff;
      params.inactiveonly = p.inactive ? 1 : 0;
      params.factionless = p.fless ? 1 : 0;
    }
    finderBusy = true;
    finder.error = '';
    render(true);
    try {
      const data = await ffsCall('get-targets', params);
      finder.results = ((data && data.targets) || []).map(t => ({
        id: Number(t.player_id), name: t.name || '', level: t.level || 0, ff: t.fair_fight ?? null, bs: t.bs_estimate ?? null,
        bsHuman: t.bs_estimate_human || '', lastAction: (t.last_action || 0) * 1000,
      })).filter(r => r.id);
    } catch (e) {
      finder.results = [];
      finder.error = e.code === 17 ? 'No targets matched those filters.' : `FFScouter: ${e.message}`;
      if (e.code in FFS_KEY_ERRORS) await ffsOff(`FFScouter turned off: ${FFS_KEY_ERRORS[e.code]}.`);
    } finally {
      finderBusy = false;
      finder.at = Date.now();
      await store.set('ffsFinder', { results: finder.results, at: finder.at, error: finder.error });
      render(true);
    }
  }

  // Your own battle stats, for "Around your range": the real total from Torn when the board has
  // your key (Torn PDA; needs a Limited key), refreshed every 30 min; otherwise FFScouter's
  // estimate of you.
  let myStats = await store.get('myStats', null); // { total, at } or { denied, at }
  let myStatsBusy = false;
  async function myStatsTick() {
    const statsKey = pdaKey || liveKey;
    if (!statsKey || myStatsBusy || !ffs.on) return;
    const age = myStats ? Date.now() - myStats.at : Infinity;
    if (age < (myStats && myStats.denied ? 6 * 3600 * SEC : 30 * 60 * SEC)) return;
    myStatsBusy = true;
    try {
      const r = await fetch(`https://api.torn.com/v2/user/battlestats?key=${statsKey}&comment=Mentat`);
      const d = await r.json();
      if (d && d.error) myStats = { denied: [2, 16].includes(d.error.code), at: Date.now() }; // 16: Public key, 2: wrong key; else try again later
      else if (d && d.battlestats && d.battlestats.total) myStats = { total: Number(d.battlestats.total), at: Date.now() };
      await store.set('myStats', myStats);
      render();
    } catch (e) { /* try again next time */ } finally { myStatsBusy = false; }
  }
  function myTotal() {
    if (myStats && myStats.total) return { total: myStats.total, from: 'your stats from Torn' };
    const x = board && board.me && ffOf(board.me.id);
    if (x && x.bs) return { total: x.bs, from: "FFScouter's estimate of you" };
    return null;
  }
  // FF 3.00 or more, and estimated stats no more than 1.75x yours (the user's rule, 2026-11-22).
  const RANGE_FF = 3;
  const RANGE_MAX = 1.75;
  function inRange(id) {
    const x = ffOf(id);
    const mine = myTotal();
    if (!x || x.ff === null || !x.bs || !mine) return false;
    return Math.round(Number(x.ff) * 100) / 100 >= RANGE_FF && x.bs <= mine.total * RANGE_MAX;
  }
  const compact = n => (n >= 1e9 ? `${(n / 1e9).toFixed(2)}b` : n >= 1e6 ? `${(n / 1e6).toFixed(1)}m` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n));
  const ffText = id => ffHtml(ffOf(id));
  function ffHtml(x) {
    if (!x) return '';
    if (x.ff === null && x.bs === null) return ' · <span class="small">FF ?</span>';
    // Colours as in Mentat's Targets tab (src/ui/app.js): under 2 green, under 2.75 amber, else red.
    const ff = x.ff !== null ? Number(x.ff) : null;
    const cls = ff === null ? '' : ff < 2 ? 'ok' : ff < 2.75 ? 'warn' : 'bad';
    const tip = `Fair fight ${ff !== null ? ff.toFixed(2) : '?'} (FFScouter): higher = tougher fight, more respect.${x.bsHuman ? ` Estimated battle stats ${x.bsHuman}.` : ''}`;
    return ` <span class="ffs ${cls}" title="${esc(tip)}">FF ${ff !== null ? ff.toFixed(2) : '?'}${x.bsHuman ? ` · ${esc(x.bsHuman)}` : ''}</span>`;
  }

  // ---- Shadow root, styles ----
  const host = document.createElement('div');
  host.id = 'mentat-war';
  host.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483001;';
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `<style>
    :host { all: initial; }
    * { box-sizing: border-box; }
    .fab { position: fixed; width: 46px; height: 46px; border-radius: 50%; background: #1a1714; border: 2px solid #b07a22; pointer-events: auto;
      display: flex; align-items: center; justify-content: center; touch-action: none; user-select: none; -webkit-user-select: none; cursor: pointer;
      box-shadow: 0 3px 10px rgba(0,0,0,.55); -webkit-tap-highlight-color: transparent; font: 600 11px/1 -apple-system, "Segoe UI", Roboto, sans-serif; }
    .fab svg { width: 22px; height: 22px; fill: #e9cf9f; pointer-events: none; }
    .fab .t { position: absolute; top: 36px; left: 50%; transform: translateX(-50%); padding: 2px 6px; border-radius: 9px; white-space: nowrap;
      background: #2c2924; border: 1.5px solid #4a4339; color: #f6f1e9; font-size: 11px; line-height: 14px; font-variant-numeric: tabular-nums; }
    .fab .t:empty { display: none; }
    .fab.ok .t { border-color: #57a64a; color: #9fde8e; }
    .fab.warn .t { border-color: #e0912d; color: #ffcf8f; }
    .fab.bad { border-color: #e5534b; animation: p 1.2s ease-in-out infinite; }
    .fab.upd::after { content: ''; position: absolute; top: -2px; right: -2px; width: 12px; height: 12px; border-radius: 50%; background: #4ea1e8; border: 2px solid #1a1714; }
    .note.update { border-color: #4ea1e8; background: #16263a; }
    .note.update .join { margin-top: 6px; }
    .fab.bad .t { border-color: #e5534b; background: #e5534b; color: #fff; }
    @keyframes p { 50% { box-shadow: 0 3px 10px rgba(0,0,0,.55), 0 0 0 8px rgba(229,83,75,0); } 0%,100% { box-shadow: 0 3px 10px rgba(0,0,0,.55), 0 0 0 0 rgba(229,83,75,.55); } }
    @media (prefers-reduced-motion: reduce) { .fab.bad { animation: none; } }

    .panel { position: fixed; right: 12px; top: 56px; width: 430px; max-height: calc(100vh - 72px); display: flex; flex-direction: column; pointer-events: auto;
      background: #1e1c19; color: #f6f1e9; border: 1px solid #5a5145; border-radius: 12px; box-shadow: 0 12px 40px rgba(0,0,0,.6);
      font: 14px/1.4 -apple-system, "Segoe UI", Roboto, sans-serif; overflow: hidden; }
    @media (max-width: 640px) { .panel { left: 8px; right: 8px; top: auto; bottom: 8px; width: auto; max-height: 80vh; } }
    .panel[hidden] { display: none; }
    .head { padding: 10px 12px 8px; border-bottom: 1px solid #3a342c; background: #23201c; }
    .row1 { display: flex; align-items: center; gap: 8px; cursor: move; touch-action: none; user-select: none; -webkit-user-select: none; }
    .row1 .iconbtn { cursor: pointer; }
    .grip { color: #a99d8c; font-size: 16px; line-height: 1; flex: none; }
    .panel.dragging { opacity: .92; box-shadow: 0 16px 48px rgba(0,0,0,.7); }
    .title { font-weight: 700; color: #e9cf9f; font-size: 15px; flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .iconbtn { width: 34px; height: 34px; border-radius: 8px; border: 1px solid #6b6052; background: #2c2924; color: #f6f1e9; font: 600 16px/1 inherit; cursor: pointer; flex: none; }
    .chain { display: flex; align-items: baseline; gap: 10px; margin-top: 6px; font-variant-numeric: tabular-nums; flex-wrap: wrap; }
    .chain .big { font-size: 22px; font-weight: 700; }
    .chain .count { color: #c4b8a8; }
    .chain .score { margin-left: auto; font-size: 22px; font-weight: 700; white-space: nowrap; color: #f6f1e9; }
    .chain .score .lead { font-size: 15px; margin-left: 4px; }
    .warline { margin-top: 4px; color: #c4b8a8; font-size: 13px; font-variant-numeric: tabular-nums; }
    .ok { color: #9fde8e; } .warn { color: #ffcf8f; } .bad { color: #ff8a84; } .info { color: #9cc9f5; } .muted { color: #c4b8a8; }
    .tabs { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; margin-top: 8px; }
    .tabs button { flex: 1; padding: 8px; border-radius: 8px; border: 1px solid #6b6052; background: #2c2924; color: #f6f1e9; font: 600 14px inherit; font-family: inherit; cursor: pointer; }
    .tabs button[aria-selected="true"] { background: #9a6a1f; border-color: #c99a4a; color: #fff; }
    .body { overflow-y: auto; padding: 10px 12px 14px; -webkit-overflow-scrolling: touch; }
    .note { padding: 8px 10px; border-radius: 8px; background: #2c2924; border: 1px solid #5a5145; margin: 0 0 10px; }
    .note.turn { border-color: #e0912d; }
    .note.go { border-color: #e5534b; background: #4a1f1c; font-weight: 700; }
    .pace { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 4px; }
    select, input { padding: 7px 8px; border-radius: 8px; border: 1px solid #6b6052; background: #15130f; color: #f6f1e9; font: 14px inherit; font-family: inherit; }
    input { flex: 1; min-width: 0; }
    .small { font-size: 12.5px; color: #c4b8a8; }
    .btn { padding: 7px 10px; border-radius: 8px; border: 1px solid #6b6052; background: #2c2924; color: #f6f1e9; font: 600 13px inherit; font-family: inherit; cursor: pointer; text-decoration: none; display: inline-block; white-space: nowrap; }
    .btn.primary { background: #9a6a1f; border-color: #c99a4a; color: #fff; }
    .btn.on { background: #2f5a2a; border-color: #6fbf5f; color: #fff; }
    .btn.danger { border-color: #c4554e; }
    .btn:disabled { opacity: .5; cursor: default; }
    ol.q { list-style: none; margin: 8px 0; padding: 0; }
    .q li { display: grid; grid-template-columns: 26px 1fr auto; gap: 4px 8px; align-items: start; padding: 8px 0; border-bottom: 1px solid #2f2c27; }
    .q li.mine { background: rgba(201,154,74,.12); border-radius: 8px; padding: 8px 6px; }
    .pos { font-weight: 700; color: #e9cf9f; font-variant-numeric: tabular-nums; padding-top: 1px; }
    .who { min-width: 0; }
    .who b { font-weight: 600; }
    .who .tgt { font-size: 13px; color: #c4b8a8; overflow-wrap: anywhere; }
    .who .tgt a { color: #e9cf9f; }
    .eta { text-align: right; font-variant-numeric: tabular-nums; }
    .eta .in { font-weight: 700; font-size: 15px; }
    .eta .at, .eta .drift { font-size: 12px; color: #c4b8a8; }
    .acts { grid-column: 2 / 4; display: flex; gap: 6px; flex-wrap: wrap; }
    .join { display: flex; gap: 8px; margin-top: 6px; }
    h3 { font-size: 13px; color: #e9cf9f; margin: 14px 0 4px; font-weight: 700; text-transform: uppercase; letter-spacing: .04em; }
    ul.recent { list-style: none; margin: 0; padding: 0; font-size: 13px; }
    ul.recent li { padding: 3px 0; color: #ded4c6; }
    .filters { display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 8px; }
    .filters button { padding: 6px 10px; border-radius: 16px; border: 1px solid #6b6052; background: #2c2924; color: #f6f1e9; font: 13px inherit; font-family: inherit; cursor: pointer; }
    .filters button[aria-pressed="true"] { background: #e9cf9f; color: #1a1714; border-color: #e9cf9f; font-weight: 600; }
    .enemy { list-style: none; margin: 0; padding: 0; }
    .enemy li { display: grid; grid-template-columns: 1fr auto; gap: 4px 8px; padding: 8px 0; border-bottom: 1px solid #2f2c27; }
    .enemy li.claimed { border-left: 3px solid #c99a4a; padding-left: 8px; }
    .enemy .nm a { color: #f6f1e9; font-weight: 600; text-decoration: none; }
    .enemy .st { font-size: 13px; font-variant-numeric: tabular-nums; }
    .enemy .dibs { grid-column: 1 / 3; font-size: 12.5px; color: #ffcf8f; }
    .enemy .side { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; justify-content: flex-end; }
    .dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 5px; vertical-align: 1px; background: #8a8178; }
    .dot.Online { background: #6fdc5f; } .dot.Idle { background: #f0b44c; }
    .err { color: #ff8a84; margin: 6px 0; }
    .sign p { margin: 6px 0; }
    .sign .join input { font-family: ui-monospace, Consolas, monospace; }
    .toast { position: fixed; left: 50%; bottom: 90px; transform: translateX(-50%); max-width: calc(100vw - 32px); pointer-events: auto; padding: 10px 14px; border-radius: 10px;
      background: #2c2924; border: 1px solid #c99a4a; color: #f6f1e9; font: 13px/1.4 -apple-system, "Segoe UI", Roboto, sans-serif; box-shadow: 0 8px 24px rgba(0,0,0,.5); }
    .light { position: fixed; z-index: 3; left: 50%; top: 8px; transform: translateX(-50%); width: min(460px, calc(100vw - 16px)); pointer-events: auto; cursor: pointer;
      display: flex; align-items: center; gap: 12px; padding: 10px 14px; border-radius: 12px; border: 2px solid #e5534b; background: #3a1512; color: #fff;
      box-shadow: 0 8px 28px rgba(0,0,0,.6); font: 14px/1.35 -apple-system, "Segoe UI", Roboto, sans-serif; -webkit-tap-highlight-color: transparent; }
    .light[hidden] { display: none; }
    .light .lamp { flex: none; width: 26px; height: 26px; border-radius: 50%; background: #ff3b30; box-shadow: 0 0 14px 4px rgba(255,59,48,.75); animation: lamp 1s ease-in-out infinite; }
    .light b { display: block; font-size: 17px; letter-spacing: .01em; }
    .light .sub { color: #ffd9d6; font-size: 13px; font-variant-numeric: tabular-nums; }
    .light.wait { border-color: #e0912d; background: #3a2a10; }
    .light.wait .lamp { background: #ffb020; box-shadow: 0 0 14px 4px rgba(255,176,32,.6); }
    .light.wait .sub { color: #ffe3b5; }
    .light.go { border-color: #4fb543; background: #143316; }
    .light.go .lamp { background: #3ddc4a; box-shadow: 0 0 14px 4px rgba(61,220,74,.65); }
    .light.go .sub { color: #ccf3c6; }
    .light.small { width: auto; padding: 6px; border-radius: 50%; }
    .light.small .txt { display: none; }
    @keyframes lamp { 50% { opacity: .45; } }
    @media (prefers-reduced-motion: reduce) { .light .lamp { animation: none; } }
    .bonus { position: fixed; z-index: 3; left: 50%; top: 84px; transform: translateX(-50%); width: min(460px, calc(100vw - 16px)); pointer-events: none;
      padding: 12px 14px; border-radius: 12px; border: 3px solid #ffcc00; color: #fff; text-align: center; box-shadow: 0 8px 28px rgba(0,0,0,.6);
      background: repeating-linear-gradient(-45deg, #5a0d0a 0 14px, #3a0806 14px 28px); font: 800 20px/1.25 -apple-system, "Segoe UI", Roboto, sans-serif; letter-spacing: .02em; }
    .bonus[hidden] { display: none; }
    .bonus .sub { display: block; font-weight: 600; font-size: 13px; color: #ffe9a8; letter-spacing: 0; margin-top: 3px; }
    .light.small ~ .bonus { top: 54px; }
    .light[hidden] ~ .bonus { top: 8px; }
    .ffs { display: inline-block; padding: 1px 7px; border-radius: 9px; font-size: 11.5px; line-height: 16px; white-space: nowrap; font-variant-numeric: tabular-nums; background: #3a352e; color: #f6f1e9; }
    .ffs.ok { background: #233a1f; color: #a8e39a; }
    .ffs.warn { background: #3f2f14; color: #ffcf8f; }
    .ffs.bad { background: #45201d; color: #ff9d96; }
    .sortrow { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; margin-bottom: 8px; font-size: 13px; }
    .sortrow select { padding: 5px 6px; font-size: 13px; }
    .tf input[type="number"] { width: 64px; padding: 5px 6px; font-size: 13px; }
    .tf label { display: inline-flex; align-items: center; gap: 4px; }
    .actrow { display: flex; gap: 14px; align-items: center; flex-wrap: wrap; margin: -2px 0 8px; font-size: 13px; }
    .actrow label { display: inline-flex; align-items: center; gap: 6px; cursor: pointer; }
    .actrow input { width: 18px; height: 18px; accent-color: #b07a22; margin: 0; }
    .tgtform input { min-width: 0; flex: 1 1 160px; }
    .copybox { position: fixed; left: 50%; top: 50%; transform: translate(-50%, -50%); z-index: 4; width: min(520px, calc(100vw - 24px)); pointer-events: auto;
      background: #1e1c19; color: #f6f1e9; border: 1px solid #c99a4a; border-radius: 12px; padding: 12px 14px; box-shadow: 0 12px 40px rgba(0,0,0,.7); font: 14px/1.4 -apple-system, "Segoe UI", Roboto, sans-serif; }
    .eng { display: inline-block; padding: 1px 7px; border-radius: 9px; font-size: 11.5px; line-height: 16px; white-space: nowrap; background: #233a1f; color: #a8e39a; font-variant-numeric: tabular-nums; }
    .eng.old { background: #2c2924; color: #a99d8c; }
    .etotal { display: flex; gap: 14px; align-items: baseline; flex-wrap: wrap; margin: 0 0 8px; padding: 8px 10px; border-radius: 8px; background: #1d2a1b; border: 1px solid #4f8f45; }
    .etotal b { font-size: 20px; color: #a8e39a; font-variant-numeric: tabular-nums; }
    .tos { width: 100%; border-collapse: collapse; font-size: 12.5px; margin: 8px 0; }
    .tos th, .tos td { text-align: left; vertical-align: top; padding: 4px 6px; border-bottom: 1px solid #3a342c; }
    .tos th { color: #e9cf9f; width: 38%; font-weight: 600; }
    .modal { position: fixed; left: 50%; top: 50%; transform: translate(-50%, -50%); z-index: 5; width: min(460px, calc(100vw - 24px)); max-height: calc(100vh - 24px); overflow-y: auto; pointer-events: auto;
      background: #1e1c19; color: #f6f1e9; border: 1px solid #c99a4a; border-radius: 12px; padding: 14px 16px; box-shadow: 0 16px 48px rgba(0,0,0,.75); font: 14px/1.45 -apple-system, "Segoe UI", Roboto, sans-serif; }
    .enote { margin: 0 0 8px; color: #f6f1e9; }
    .modal h2 { margin: 0 0 6px; font-size: 17px; color: #e9cf9f; cursor: move; touch-action: none; user-select: none; -webkit-user-select: none; display: flex; align-items: center; gap: 8px; }
    .modal h2 .grip { color: #a99d8c; font-size: 16px; }
    .modal.dragging { opacity: .94; }
    .modal label.agree { display: flex; gap: 10px; align-items: flex-start; margin: 8px 0; }
    .modal label.agree input { width: 20px; height: 20px; flex: none; accent-color: #b07a22; margin: 1px 0 0; }
    .copybox textarea { width: 100%; min-height: 90px; margin: 8px 0; padding: 8px; border-radius: 8px; border: 1px solid #6b6052; background: #15130f; color: #f6f1e9; font: 13px/1.4 ui-monospace, Consolas, monospace; resize: vertical; }
    .tag { display: inline-block; padding: 1px 7px; border-radius: 9px; font-size: 11.5px; line-height: 16px; white-space: nowrap; }
    .tag.rev { background: #233a1f; color: #a8e39a; border: 1px solid #4f8f45; }
    .tag.pos { background: #2c2924; color: #ded4c6; }
    .bs { display: inline-block; padding: 1px 7px; border-radius: 9px; font-size: 11.5px; line-height: 16px; white-space: nowrap; background: #2b3440; color: #cfe2f7; font-variant-numeric: tabular-nums; }
    .bwarn { color: #ffcf8f; font-weight: 700; }
    .settings label { display: flex; align-items: center; gap: 10px; padding: 8px 0; border-bottom: 1px solid #2f2c27; }
    .settings input[type=checkbox] { flex: none; width: 20px; height: 20px; accent-color: #b07a22; }
    a { color: #e9cf9f; }
  </style>`;
  document.documentElement.appendChild(host);

  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  function toast(text, ms = 5000) {
    const n = document.createElement('div');
    n.className = 'toast';
    n.setAttribute('role', 'status');
    n.textContent = text;
    root.appendChild(n);
    setTimeout(() => n.remove(), ms);
  }

  // ---- Times ----
  const mmss = s => {
    s = Math.max(0, Math.round(s));
    if (s >= 3600) return `${Math.floor(s / 3600)}:${String(Math.floor(s % 3600 / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  };
  const tct = ms => new Date(ms).toISOString().slice(11, 19); // Torn City Time is UTC
  const ago = ms => { const s = Math.max(0, (Date.now() - ms) / SEC); return s < 60 ? 'just now' : s < 3600 ? `${Math.floor(s / 60)}m ago` : `${Math.floor(s / 3600)}h ago`; };
  const num = n => Number(n || 0).toLocaleString('en-US');

  // Same as server/hitqueue.js estimate(): when each place in the queue hits.
  function estimate(chain, hitAt, refill, count, now = Date.now()) {
    const step = Math.max(1, refill - hitAt);
    const left = chain && chain.current > 0 && chain.timeout > 0 && !(chain.cooldownUntil > now)
      ? chain.timeout - (now - chain.fetchedAt) / SEC : 0;
    const running = left > 0;
    const firstIn = running ? Math.max(0, left - hitAt) : 0;
    const times = [];
    const after = [];
    for (let i = 0; i < count; i++) { after.push(i * step); times.push(running ? now + (firstIn + i * step) * SEC : null); }
    return { running, left: Math.max(0, left), times, after, step, firstIn };
  }

  // ---- Board data ----
  let board = null; // last /war/board answer, server times turned into this device's clock
  let lastOk = 0;
  let netError = '';
  const drift = new Map(); // queue entry id -> its first estimated time (to show how far it moved)
  const buzzed = new Set();

  async function load() {
    if (!session) return;
    const open = !panel.hidden || onAttackPage(); // the bonus warning needs the enemy's members
    const have = board && board.enemy && board.enemy.members ? board.enemy.serverFetchedAt : 0;
    let r;
    const ours = !panel.hidden && cfg.tab === 'faction' ? `&ours=${board && board.ours && board.ours.members ? board.ours.serverFetchedAt : 0}` : '';
    try { r = await server('GET', `war/board?${open ? `members=${have}${ours}` : 'lite=1'}`, null, session); } catch (e) { netError = "Can't reach the Mentat server."; render(); return; }
    if (r.status === 401) { session = ''; await store.set('session', ''); netError = ''; if (pdaKey) await signIn(pdaKey); render(); return; }
    if (r.status !== 200 || !r.json) { netError = (r.json && r.json.error) || `Mentat server error ${r.status}`; render(); return; }
    take(r.json);
  }

  // Server timestamps to this device's clock, one part at a time.
  function localQueue(q, skew) {
    const L = t => (t ? t + skew : t);
    if (q.chain) { q.chain.fetchedAt = L(q.chain.fetchedAt); q.chain.cooldownUntil = L(q.chain.cooldownUntil); }
    for (const e of q.entries) if (e.targetInfo && e.targetInfo.until) e.targetInfo.until = L(e.targetInfo.until);
    for (const h of q.recent || []) h.at = L(h.at);
    return q;
  }
  function localClaims(c, skew) {
    for (const list of Object.values(c.claims || {})) for (const x of list) x.at += skew;
    return c;
  }

  function take(b) {
    const skew = Date.now() - b.now;
    b.skew = skew;
    const L = t => (t ? t + skew : t);
    if (b.queue) localQueue(b.queue, skew);
    if (b.enemy) {
      b.enemy.fetchedAt = L(b.enemy.fetchedAt);
      b.enemy.serverFetchedAt = b.enemy.fetchedAt - skew; // what to send back as ?members=
      if (b.enemy.members) {
        for (const m of b.enemy.members) {
          m.until = L(m.until);
          m.lastAt = L(m.lastAt);
          if (m.trip) { m.trip.landLo = L(m.trip.landLo); m.trip.landHi = L(m.trip.landHi); m.trip.expected = L(m.trip.expected); }
        }
        serverMembers.enemy = new Map(b.enemy.members.map(m => [m.id, m]));
      } else if (board && board.enemy && board.enemy.id === b.enemy.id && board.enemy.members) {
        b.enemy.members = board.enemy.members;
        if (board.enemy.live) { b.enemy.fetchedAt = board.enemy.fetchedAt; b.enemy.live = true; b.enemy.counts = board.enemy.counts; }
      }
    }
    if (b.ours) {
      b.ours.fetchedAt = L(b.ours.fetchedAt);
      b.ours.serverFetchedAt = b.ours.fetchedAt - skew;
      if (b.ours.members) {
        for (const m of b.ours.members) {
          m.until = L(m.until);
          m.lastAt = L(m.lastAt);
          if (m.trip) { m.trip.landLo = L(m.trip.landLo); m.trip.landHi = L(m.trip.landHi); m.trip.expected = L(m.trip.expected); }
        }
        serverMembers.ours = new Map(b.ours.members.map(m => [m.id, m]));
      } else if (board && board.ours && board.ours.members) {
        b.ours.members = board.ours.members;
        if (board.ours.live) { b.ours.fetchedAt = board.ours.fetchedAt; b.ours.live = true; b.ours.counts = board.ours.counts; }
      }
    } else if (board && board.ours) b.ours = board.ours; // not asked for this time: keep what we have
    if (b.energy && b.energy.members) for (const r of Object.values(b.energy.members)) r.at = L(r.at);
    else if (board && board.energy) b.energy = board.energy;
    if (b.claims) localClaims(b.claims, skew);
    else if (board && board.claims) b.claims = board.claims;
    if (b.war && b.war.ranked) { b.war.ranked.start = L(b.war.ranked.start); b.war.ranked.end = L(b.war.ranked.end); }
    board = b;
    applyLive('enemy');
    applyLive('ours');
    lastOk = Date.now();
    netError = '';
    render();
  }

  async function act(path, body) {
    let r;
    try { r = await server('POST', path, body, session); } catch (e) { toast("Can't reach the Mentat server."); return; }
    if (r.status !== 200) { toast((r.json && r.json.error) || `Failed (${r.status}).`); return; }
    // Show the answer straight away, then read the whole board again.
    if (board && r.json) {
      const skew = r.json.now ? Date.now() - r.json.now : board.skew;
      if (path === 'war/claims') board.claims = localClaims(r.json, skew);
      else if (r.json.queue) board.queue = localQueue(r.json.queue, skew);
      // The action is done: let go of the field it came from (phones keep focus in it after a
      // tap on a button), so the board redraws with the change instead of waiting for typing.
      const ae = root.activeElement;
      if (ae && panel.contains(ae) && typeof ae.blur === 'function') ae.blur();
      render(true);
    }
    load();
  }

  // ---- Live: the enemy from Torn with YOUR key (the user's rule, 2026-11-22) ----
  // With Live on and the Enemy tab open, this device reads the enemy's members from Torn every
  // 3/5/10 s with its own key (Torn PDA's key, or one entered for Live in a browser), so Live
  // never uses the server owner's key. The server's once-a-minute copy still supplies landing
  // estimates (it watches flights); the live read supplies everything else.
  let liveKey = pdaKey || await store.get('liveKey', '');
  const liveData = { enemy: null, ours: null }; // { factionId, at, members } per tab
  const serverMembers = { enemy: new Map(), ours: new Map() }; // the server's latest copies (for landing estimates)
  let liveBusy = false;
  let liveLast = 0;
  let livePausedUntil = 0;
  let liveError = '';
  // Which list Live is reading now: the Enemy tab's or the Faction tab's (or none).
  const liveKind = () => {
    if (panel.hidden || view !== 'main' || !(cfg.live > 0) || !board) return '';
    if (cfg.tab === 'enemy' && board.enemy && board.enemy.id) return 'enemy';
    if (cfg.tab === 'faction' && board.own && board.own.id) return 'ours';
    return '';
  };
  function liveMember(m) {
    const st = m.status || {};
    const la = m.last_action || {};
    return {
      id: m.id, name: m.name || `#${m.id}`, level: m.level || 0, position: m.position || '', state: st.state || '', description: st.description || '',
      until: (st.until || 0) * SEC, last: la.status || 'Offline', lastAt: (la.timestamp || 0) * SEC,
      revivable: !!m.is_revivable, reviveSetting: m.revive_setting && m.revive_setting !== 'Unknown' ? m.revive_setting : '', earlyDischarge: !!m.has_early_discharge,
      onWall: !!m.is_on_wall, trip: null, abroadSince: 0,
    };
  }
  function countsOf(list) {
    const c = { okay: 0, hospital: 0, jail: 0, travel: 0, abroad: 0, online: 0, idle: 0 };
    for (const m of list) {
      if (m.state === 'Okay') c.okay++;
      else if (m.state === 'Hospital') c.hospital++;
      else if (m.state === 'Jail') c.jail++;
      else if (m.state === 'Traveling') c.travel++;
      else if (m.state === 'Abroad') c.abroad++;
      if (m.last === 'Online') c.online++;
      else if (m.last === 'Idle') c.idle++;
    }
    return c;
  }
  // Put a live read over the server's copy when it's newer (keeping the server's flight info).
  function applyLive(kind) {
    const e = board && (kind === 'enemy' ? board.enemy : board.ours);
    const ld = liveData[kind];
    const fid = kind === 'enemy' ? e && e.id : board && board.own && board.own.id;
    if (!e || !ld || ld.factionId !== fid || ld.at <= (e.fetchedAt || 0) || Date.now() - ld.at > 60 * SEC) return;
    e.members = ld.members.map(m => {
      const s = serverMembers[kind].get(m.id);
      return s && s.state === m.state && s.description === m.description ? { ...m, trip: s.trip, abroadSince: s.abroadSince } : m;
    });
    e.fetchedAt = ld.at;
    e.counts = { ...(e.counts || {}), ...countsOf(e.members) };
    e.live = true;
  }
  async function liveTick() {
    const now = Date.now();
    const kind = liveKind();
    if (!kind || !liveKey || liveBusy || now < livePausedUntil || now - liveLast < cfg.live * SEC - 150) return;
    liveBusy = true;
    liveLast = now;
    const fid = kind === 'enemy' ? board.enemy.id : board.own.id;
    // Your own faction: /v2/faction/members (the key's faction); the enemy: /v2/faction/{id}/members.
    const path = kind === 'enemy' ? `/v2/faction/${fid}/members` : '/v2/faction/members';
    try {
      const r = await fetch(`https://api.torn.com${path}?striptags=true&timestamp=${Math.floor(now / 1000)}&key=${liveKey}&comment=Mentat`);
      const d = await r.json();
      if (d && d.error) {
        const code = d.error.code;
        liveError = `Torn says: ${d.error.error || 'error'}.`;
        if (code === 2 && !pdaKey) { liveKey = ''; await store.set('liveKey', ''); liveError = 'Torn rejected that key: enter it again to use Live.'; }
        livePausedUntil = Date.now() + (code === 5 ? 60 : 15) * SEC; // 5: too many requests
      } else {
        if (kind === 'ours' && !board.ours) board.ours = { fetchedAt: 0, counts: null };
        liveData[kind] = { factionId: fid, at: Date.now(), members: (d.members || []).map(liveMember) };
        liveError = '';
        applyLive(kind);
      }
    } catch (e) {
      liveError = "Can't reach Torn.";
      livePausedUntil = Date.now() + 10 * SEC;
    } finally {
      liveBusy = false;
      render();
    }
  }

  // ---- Energy sharing (the user's request, 2026-11-23) ----
  // Opt-in only: Torn's API rules keep a key's data confidential "unless permitted by the key
  // owner" and want the ToS table shown where the key is used. When on, this device reads your
  // energy bar and drug cooldown from Torn (/v2/user bars + cooldowns: a Minimal key or higher)
  // about once a minute while Torn is open and sends them to the Mentat server for the Faction
  // tab. Turning it off deletes them there.
  const HIT_E = 25; // energy per attack (Torn wiki, Attack: 25, or 15 under Love Juice at Valentine's)
  const E_FRESH = 15 * 60 * SEC; // readings older than this don't count towards the total
  const E_EVERY = 60 * SEC;
  const energyKey = () => pdaKey || liveKey;
  let eLast = 0;
  let eBusy = false;
  let ePausedUntil = 0;
  let eStatus = { at: 0, error: '' };
  const TOS_ROWS = [
    ['Data Storage', 'Temporary, less than a day (deleted at once if you turn sharing off)'],
    ['Data Sharing', 'Faction (members signed in to your faction\'s Mentat server)'],
    ['Purpose of Use', 'Public community tools: faction chain and war planning'],
    ['Key Storage & Sharing', 'Not stored or shared by the server. Torn PDA: PDA\'s key. Browser: the key you signed in with, kept only on this device and sent only to Torn.'],
    ['Key Access Level', 'Minimal (selections: bars, cooldowns)'],
  ];
  const tosHtml = () => `<table class="tos" aria-label="Torn API terms for energy sharing">${TOS_ROWS.map(([k, v]) => `<tr><th>${k}</th><td>${esc(v)}</td></tr>`).join('')}</table>`;
  async function energyTick(force = false) {
    const now = Date.now();
    if (!cfg.shareE || !session || eBusy || document.hidden || now < ePausedUntil) return;
    if (!force && now - eLast < E_EVERY) return;
    const key = energyKey();
    if (!key) { eStatus = { at: eStatus.at, error: 'Sharing needs your API key on this device (Settings).' }; return; }
    eBusy = true;
    eLast = now;
    try {
      const r = await fetch(`https://api.torn.com/v2/user?selections=bars,cooldowns&key=${key}&comment=Mentat`);
      const d = await r.json();
      if (d && d.error) {
        const code = d.error.code;
        eStatus = { at: eStatus.at, error: code === 16 ? "Your key is a Public key: sharing energy needs a Minimal key or higher." : code === 2 ? 'Torn rejected the key.' : `Torn says: ${d.error.error || 'error'}.` };
        ePausedUntil = Date.now() + ([2, 16].includes(code) ? 10 * 60 : 60) * SEC;
        return;
      }
      const res = await server('POST', 'war/energy', { energy: d.bars && d.bars.energy, drug: d.cooldowns && d.cooldowns.drug }, session);
      eStatus = res.status === 200 ? { at: Date.now(), error: '' } : { at: eStatus.at, error: (res.json && res.json.error) || `Mentat server error ${res.status}` };
    } catch (e) {
      eStatus = { at: eStatus.at, error: "Can't reach Torn or the Mentat server." };
      ePausedUntil = Date.now() + 60 * SEC;
    } finally {
      eBusy = false;
      render();
    }
  }
  async function setSharing(on) {
    cfg.shareE = on;
    cfg.energyAsked = true;
    saveCfg();
    if (on) { eLast = 0; ePausedUntil = 0; eStatus = { at: 0, error: '' }; await energyTick(true); }
    else {
      eStatus = { at: 0, error: '' };
      try { await server('POST', 'war/energy', { off: true }, session); } catch (e) { /* the server drops it within a day anyway */ }
    }
    render(true);
    load();
  }
  // A reading's energy now: Torn's bar regenerates `increment` every `interval` s (the first tick
  // `tick` s after the reading) up to the maximum; nothing regenerates above it.
  function energyNow(r, now = Date.now()) {
    const e = r.energy;
    let cur = e.current;
    if (cur < e.maximum && e.increment && e.interval) {
      const el = (now - r.at) / SEC;
      if (el >= e.tick) cur = Math.min(e.maximum, cur + e.increment * (1 + Math.floor((el - e.tick) / e.interval)));
    }
    return cur;
  }
  // The popup can be dragged by its title (the user's request, 2026-11-23), e.g. to see the page
  // while entering a key. Its place is kept as a share of the screen and it always stays on screen.
  function placeModal(m) {
    const p = cfg.modalPos;
    if (!p) { Object.assign(m.style, { left: '', top: '', transform: '' }); return; }
    const r = m.getBoundingClientRect();
    const left = Math.max(4, Math.min(window.innerWidth - r.width - 4, p.x * window.innerWidth));
    // Keep all of it on screen when it fits (e.g. the key box above a phone's keyboard).
    const top = Math.max(4, Math.min(window.innerHeight - Math.min(r.height, window.innerHeight - 8) - 4, p.y * window.innerHeight));
    Object.assign(m.style, { left: `${left}px`, top: `${top}px`, transform: 'none' });
  }
  function dragModal(m) {
    const handle = m.querySelector('h2');
    let start = null;
    handle.addEventListener('pointerdown', e => {
      if (e.button > 0) return;
      const r = m.getBoundingClientRect();
      start = { dx: e.clientX - r.left, dy: e.clientY - r.top, x: e.clientX, y: e.clientY, moved: false };
      handle.setPointerCapture(e.pointerId);
    });
    handle.addEventListener('pointermove', e => {
      if (!start) return;
      if (!start.moved && Math.abs(e.clientX - start.x) + Math.abs(e.clientY - start.y) < 5) return;
      start.moved = true;
      m.classList.add('dragging');
      cfg.modalPos = { x: (e.clientX - start.dx) / window.innerWidth, y: (e.clientY - start.dy) / window.innerHeight };
      placeModal(m);
    });
    const end = () => {
      if (!start) return;
      m.classList.remove('dragging');
      if (start.moved) {
        const r = m.getBoundingClientRect();
        cfg.modalPos = { x: r.left / window.innerWidth, y: r.top / window.innerHeight };
        saveCfg();
      }
      start = null;
    };
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
    window.addEventListener('resize', () => { if (m.isConnected) placeModal(m); });
  }
  // The faction's own note at the top of the energy opt-in (popup and Settings), at the owner's request.
  const ENERGY_NOTE = `<p class="enote"><b>While this is optional, if you don't do it Disco will trout you and Alma will run her fingers across chalk boards while you try to sleep forever and eternity &lt;3</b></p>`;
  // The first-time popup (also shown once after the update that added this).
  function energyPopup() {
    if (cfg.energyAsked || !session || !board || root.querySelector('.modal')) return;
    const m = document.createElement('div');
    m.className = 'modal';
    m.setAttribute('role', 'dialog');
    m.setAttribute('aria-label', 'Energy tracker');
    m.innerHTML = `<h2 title="Drag to move"><span class="grip" aria-hidden="true">⠿</span>New: energy tracker</h2>
      ${ENERGY_NOTE}
      <p style="margin:0 0 6px">Share your <b>energy</b> and <b>drug cooldown</b> with your faction, so the Faction tab can show how much energy (and how many hits) online members have ready. It's off unless you turn it on.</p>
      <p class="small" style="margin:0">While it's on, this device reads them from Torn with your own key about once a minute while you have Torn open, and sends them to your faction's Mentat server. Turn it off any time in Settings: your readings are deleted at once.</p>
      ${tosHtml()}
      ${me && me.keyLevel === 1 ? `<p class="err" style="margin:6px 0">Your API key is a <b>Public</b> key, which can't read energy. To share, sign out and sign in again with a Minimal or Limited key${pdaKey ? " (in Torn PDA: change the key in PDA's settings)" : ''}.</p>` : ''}
      ${energyKey() ? '' : `<div class="join"><input id="ekey" type="password" autocomplete="off" spellcheck="false" maxlength="40" placeholder="Your API key (Minimal or higher)" aria-label="Your API key for energy sharing"></div><p class="small" style="margin:4px 0 0">Kept only on this device, used only to read your energy and cooldowns from Torn.</p>`}
      <label class="agree"><input type="checkbox" id="eagree"> <span>I agree to share my energy and drug cooldown with my faction as described above.</span></label>
      <div class="join"><button class="btn primary" data-e="on">Share my energy</button><button class="btn" data-e="later">Not now</button></div>
      <p class="small err" id="emsg" style="margin:6px 0 0"></p>`;
    m.addEventListener('click', async e => {
      const b = e.target.closest('[data-e]');
      if (!b) return;
      if (b.dataset.e === 'later') { cfg.energyAsked = true; saveCfg(); m.remove(); toast('You can turn on energy sharing any time in Settings (⚙).'); return; }
      if (me && me.keyLevel === 1) { m.querySelector('#emsg').textContent = 'A Public key can\'t share energy: use a Minimal or Limited key.'; return; }
      if (!m.querySelector('#eagree').checked) { m.querySelector('#emsg').textContent = 'Tick the box to agree first.'; return; }
      const k = m.querySelector('#ekey');
      if (k) {
        const v = String(k.value || '').replace(/[^A-Za-z0-9]/g, '');
        if (!/^[A-Za-z0-9]{16}$/.test(v)) { m.querySelector('#emsg').textContent = 'A Torn API key is 16 letters and numbers.'; return; }
        liveKey = v;
        await store.set('liveKey', v);
      }
      m.remove();
      await setSharing(true);
      toast(eStatus.error ? `Energy sharing: ${eStatus.error}` : 'Thanks: your energy is now shared with the faction.', 6000);
    });
    root.appendChild(m);
    placeModal(m);
    dragModal(m);
  }
  function energySettingsHtml() {
    const st = cfg.shareE
      ? (eStatus.error ? `<span class="err">${esc(eStatus.error)}</span>` : eStatus.at ? `<span class="ok">Shared ${ago(eStatus.at)}.</span>` : 'Starting…')
      : 'Off.';
    return `<h3>Energy sharing</h3>
      ${ENERGY_NOTE}
      <label><input type="checkbox" data-share ${cfg.shareE ? 'checked' : ''}> Share my energy and drug cooldown with the faction</label>
      <p class="small" style="margin:4px 0">${st} ${cfg.shareE ? 'Turning it off deletes your readings from the server at once.' : 'Turning it on asks you to agree to the terms below first.'}</p>
      ${tosHtml()}`;
  }

  // ---- The button ----
  const MARK_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6.9 3 3 6.9l4.6 4.6-1.9 1.9 1.4 1.4 1.4-1.4 2.1 2.1-3.2 3.2a1.5 1.5 0 0 0 2.1 2.1l3.2-3.2 2.1 2.1-1.4 1.4 1.4 1.4 1.9-1.9 4.6 4.6L21 17.1 6.9 3zm10.2 0-5.3 5.3 3.9 3.9L21 6.9V3h-3.9z"/></svg>';
  const fab = document.createElement('div');
  fab.className = 'fab';
  fab.setAttribute('role', 'button');
  fab.setAttribute('aria-label', 'Mentat war board');
  fab.innerHTML = `${MARK_SVG}<span class="t"></span>`;
  root.appendChild(fab);
  const clampX = x => Math.max(4, Math.min(window.innerWidth - 50, x));
  const clampY = y => Math.max(4, Math.min(window.innerHeight - 66, y));
  function placeFab() {
    const p = cfg.pos;
    fab.style.left = `${clampX(p ? p.x * window.innerWidth : window.innerWidth - 54)}px`;
    fab.style.top = `${clampY(p ? p.y * window.innerHeight : (isPda ? 170 : 110))}px`;
  }
  placeFab();
  window.addEventListener('resize', placeFab);
  (function drag() {
    let start = null;
    fab.addEventListener('pointerdown', e => {
      fab.setPointerCapture(e.pointerId);
      const r = fab.getBoundingClientRect();
      start = { x: e.clientX, y: e.clientY, dx: e.clientX - r.left, dy: e.clientY - r.top, moved: false };
    });
    fab.addEventListener('pointermove', e => {
      if (!start) return;
      if (Math.abs(e.clientX - start.x) + Math.abs(e.clientY - start.y) > 8) start.moved = true;
      if (start.moved) { fab.style.left = `${clampX(e.clientX - start.dx)}px`; fab.style.top = `${clampY(e.clientY - start.dy)}px`; }
    });
    fab.addEventListener('pointerup', () => {
      if (!start) return;
      if (start.moved) { cfg.pos = { x: parseFloat(fab.style.left) / window.innerWidth, y: parseFloat(fab.style.top) / window.innerHeight }; saveCfg(); } else togglePanel();
      start = null;
    });
    fab.addEventListener('pointercancel', () => { start = null; });
    // On touch screens the browser follows a tap with a "click" where the finger was. The board
    // opens over the button on wider screens (iPad), so that click would land on a tab or button
    // in the board: cancel it.
    fab.addEventListener('touchend', e => { if (e.cancelable) e.preventDefault(); }, { passive: false });
    fab.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); togglePanel(); } });
    fab.tabIndex = 0;
  })();

  // ---- The light on attack pages (the user's request, 2026-11-22) ----
  // Red "Warning: Not your turn" while someone else is next in the hit queue, amber when you're
  // next but it's too early, green when it's your turn. Only the page address is looked at
  // (page.php?sid=attack); nothing on the page is read. Tap it to shrink it to the lamp.
  const light = document.createElement('div');
  light.className = 'light';
  light.hidden = true;
  light.setAttribute('role', 'status');
  light.innerHTML = '<span class="lamp" aria-hidden="true"></span><span class="txt"><b></b><span class="sub"></span></span>';
  root.appendChild(light);
  light.addEventListener('click', () => { cfg.lightSmall = !cfg.lightSmall; saveCfg(); renderLight(); });
  const onAttackPage = () => {
    const u = new URL(location.href);
    return u.searchParams.get('sid') === 'attack' && /^\/(page|loader)\.php$/.test(u.pathname);
  };
  // Chain bonus hits, from the Torn wiki (wiki.torn.com/wiki/Chain): 10, 25, 50, 100, 250, 500,
  // 1000, 2500, 5000, 10000, 25000, 50000 and 100000.
  const BONUS = new Set([10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 25000, 50000, 100000]);
  // During a war (ranked, raid or territory) only: the chain number that would be a bonus hit.
  function bonusAt(n) {
    if (!board || !board.live || !board.live.inWar) return 0;
    return BONUS.has(n) ? n : 0;
  }
  const enemyHas = id => !!(board && board.enemy && board.enemy.members && board.enemy.members.some(m => m.id === id));
  const enemyKnown = () => !!(board && board.enemy && board.enemy.members && board.enemy.members.length);
  const bonusBox = document.createElement('div');
  bonusBox.className = 'bonus';
  bonusBox.hidden = true;
  bonusBox.setAttribute('role', 'alert');
  root.appendChild(bonusBox);
  // "BONUS HIT: DO NOT HIT OUTSIDE" (the user's request, 2026-11-22): on an attack page during a
  // war, when the next hit is a bonus and the player in the address (user2ID) isn't in the faction
  // we're at war with. Only the address is read.
  function renderBonus() {
    const q = board && board.queue;
    const est = q && chainInfo();
    const target = onAttackPage() ? Number(new URL(location.href).searchParams.get('user2ID')) || 0 : 0;
    const n = est && est.running ? bonusAt(q.chain.current + 1) : 0;
    if (!cfg.attackLight || !session || !n || !target || !enemyKnown() || enemyHas(target)) { bonusBox.hidden = true; return; }
    bonusBox.hidden = false;
    const text = `BONUS HIT: DO NOT HIT OUTSIDE`;
    const sub = `The next hit is bonus #${num(n)}. This player isn't in ${board.enemy.name}: hit a war target.`;
    if (bonusBox.dataset.n !== String(n)) bonusBox.innerHTML = `${text}<span class="sub">${esc(sub)}</span>`;
    bonusBox.dataset.n = String(n);
  }

  function renderLight() {
    renderBonus();
    const show = (cls, title, sub) => {
      light.hidden = false;
      light.className = `light ${cls}${cfg.lightSmall ? ' small' : ''}`;
      light.querySelector('b').textContent = title;
      light.querySelector('.sub').textContent = sub;
      light.title = `${title}. ${sub}`;
      light.setAttribute('aria-label', light.title);
    };
    const q = board && board.queue;
    if (!cfg.attackLight || !session || !q || !q.entries.length || !onAttackPage()) { light.hidden = true; return; }
    const est = chainInfo();
    const now = Date.now();
    const myId = board.me.id;
    const i = q.entries.findIndex(e => e.by === myId);
    const head = q.entries[0];
    const timer = est.running ? ` · timer ${mmss(est.left)}` : '';
    if (i === 0) {
      if (!est.running) return show('go', 'Your turn', `You're first in the queue: your hit starts the timing.`);
      const s = (est.times[0] - now) / SEC;
      if (s <= 1) return show('go', 'Your turn: hit now', `Everyone hits at ${mmss(q.hitAt)}${timer}`);
      return show('wait', `Your turn in ${mmss(s)}`, `Wait until the timer shows ${mmss(q.hitAt)}${timer}`);
    }
    const next = est.running ? (est.times[0] - now) / SEC : null;
    const who = `${head.name} is next${next !== null ? (next <= 1 ? ' (now)' : ` (in ${mmss(next)})`) : ' (starts the chain)'}`;
    const mine = i > 0 ? ` · you're #${i + 1}${est.running ? ` in ${mmss((est.times[i] - now) / SEC)}` : ''}` : " · you're not in the queue";
    show('', 'Warning: Not your turn', `${who}${mine}${timer}`);
  }

  // ---- The panel ----
  const panel = document.createElement('div');
  panel.className = 'panel';
  panel.hidden = true;
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', 'War board');
  panel.innerHTML = `<div class="head">
      <div class="row1" title="Drag to move"><span class="grip" aria-hidden="true">⠿</span><div class="title">War board</div><button class="iconbtn" data-act="settings" aria-label="Settings" title="Settings">⚙</button><button class="iconbtn" data-act="close" aria-label="Close" title="Close">✕</button></div>
      <div class="chain" id="chain"></div><div class="warline" id="warline"></div>
      <div class="tabs" role="tablist"><button role="tab" data-tab="queue">Queue</button><button role="tab" data-tab="enemy">Enemy</button><button role="tab" data-tab="faction">Faction</button><button role="tab" data-tab="targets">FFScouter</button></div>
    </div><div class="body" id="body"></div>`;
  root.appendChild(panel);
  const $ = id => panel.querySelector(`#${id}`);
  let view = 'main'; // 'main' | 'settings'

  // Drag the title bar to move the board (the user's request, 2026-11-22). The place is kept as a
  // share of the screen (so it survives rotating and resizing) and always keeps the whole board
  // on screen; Settings → Reset places puts it back.
  function placePanel() {
    const p = cfg.panelPos;
    const st = panel.style;
    if (!p) { st.left = st.top = st.right = st.bottom = st.width = st.maxHeight = ''; return; }
    const w = Math.min(p.w || 430, window.innerWidth - 8);
    const left = Math.max(4, Math.min(window.innerWidth - w - 4, p.x * window.innerWidth));
    const top = Math.max(4, Math.min(window.innerHeight - 120, p.y * window.innerHeight));
    Object.assign(st, { left: `${left}px`, top: `${top}px`, right: 'auto', bottom: 'auto', width: `${w}px`, maxHeight: `${Math.max(160, window.innerHeight - top - 8)}px` });
  }
  window.addEventListener('resize', placePanel);
  (function dragPanel() {
    const handle = panel.querySelector('.row1');
    let start = null;
    handle.addEventListener('pointerdown', e => {
      if (e.target.closest('button') || e.button > 0) return;
      const r = panel.getBoundingClientRect();
      start = { dx: e.clientX - r.left, dy: e.clientY - r.top, w: r.width, x: e.clientX, y: e.clientY, moved: false };
      handle.setPointerCapture(e.pointerId);
    });
    handle.addEventListener('pointermove', e => {
      if (!start) return;
      if (!start.moved && Math.abs(e.clientX - start.x) + Math.abs(e.clientY - start.y) < 5) return;
      start.moved = true;
      panel.classList.add('dragging');
      cfg.panelPos = { x: (e.clientX - start.dx) / window.innerWidth, y: (e.clientY - start.dy) / window.innerHeight, w: Math.round(start.w) };
      placePanel();
    });
    const end = () => {
      if (!start) return;
      panel.classList.remove('dragging');
      if (start.moved) {
        // Save where it really ended up (after keeping it on screen).
        const r = panel.getBoundingClientRect();
        cfg.panelPos = { x: r.left / window.innerWidth, y: r.top / window.innerHeight, w: Math.round(r.width) };
        saveCfg();
      }
      start = null;
    };
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
  })();
  placePanel();

  function togglePanel(open = panel.hidden) {
    panel.hidden = !open;
    cfg.open = open;
    saveCfg();
    view = 'main';
    render(true);
    if (open) load();
  }

  // ---- Updates (the user's request, 2026-11-22) ----
  // Every board read from the server carries the newest script version. A userscript can't
  // replace itself: in Tampermonkey the Update button opens its update screen for the new
  // version; Torn PDA updates scripts itself, so there it says where to do it now.
  const newer = (a, b) => {
    const x = String(a || '').split('.').map(Number);
    const y = String(b || '').split('.').map(Number);
    for (let i = 0; i < Math.max(x.length, y.length); i++) { if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0); }
    return false;
  };
  const latestVersion = () => (board && board.script && board.script.version) || '';
  const updateReady = () => newer(latestVersion(), VERSION);
  const SCRIPT_URL = `${SERVER}/pda/mentat-war.user.js`;
  let updateHelp = false;
  function updateHtml() {
    if (!updateReady()) return '';
    const how = isPda
      ? "Torn PDA updates its scripts by itself. To update now: Settings → Advanced browser settings → Manage scripts, open <b>Mentat war board</b> and load it again from its address, then reload this page."
      : /userscripts/i.test(handler)
        ? "Userscripts (Safari): Update now opens the script's address. Open the Userscripts extension from Safari's address bar and install the update it offers, then reload Torn. Userscripts also checks for updates by itself."
        : "Tampermonkey opens its update screen: click <b>Update</b> there, then reload this page. If it only shows the script's text: Tampermonkey → Dashboard → Utilities → Install from URL, paste the address below.";
    return `<div class="note update"><b>Update available: ${esc(latestVersion())}</b> <span class="small">(you have ${VERSION})</span>
      <div class="join">${isPda ? '' : '<button class="btn primary" data-act="update">Update now</button>'}<button class="btn" data-act="updatehow">${updateHelp ? 'Hide how' : 'How'}</button></div>
      ${updateHelp || isPda ? `<p class="small" style="margin:6px 0 0">${how}</p><div class="join"><input readonly data-selectall value="${SCRIPT_URL}" aria-label="Script address"></div>` : ''}</div>`;
  }

  // ---- Drawing ----
  let lastBodyKey = '';
  function render(force = false) {
    renderFab();
    renderLight();
    if (panel.hidden) return;
    renderHead();
    const body = $('body');
    let html;
    if (!session) html = signInHtml();
    else if (view === 'settings') html = settingsHtml();
    else if (!board) html = `<p class="muted">${netError ? `<span class="err">${esc(netError)}</span>` : 'Loading…'}</p>`;
    else html = updateHtml() + (cfg.tab === 'enemy' ? enemyHtml() : cfg.tab === 'faction' ? factionHtml() : cfg.tab === 'targets' ? targetsHtml() : queueHtml());
    // Redraw only when something changed, so a tap isn't lost to a redraw (times tick in place).
    const key = html;
    if (!force && key === lastBodyKey) return tickTimes();
    const focus = root.activeElement && root.activeElement.id;
    const val = focus && root.activeElement.value;
    const scroll = body.scrollTop;
    if (focus && body.contains(root.activeElement) && !force) return tickTimes(); // don't redraw under someone typing
    body.innerHTML = html;
    body.scrollTop = scroll;
    if (focus) { const el = body.querySelector(`#${focus}`); if (el) { el.focus(); if (val !== undefined && el.value !== undefined) el.value = val; } }
    lastBodyKey = key;
    tickTimes();
  }

  function chainInfo() {
    const q = board && board.queue;
    if (!q) return null;
    return estimate(q.chain, q.hitAt, q.refill, q.entries.length);
  }
  const toneFor = s => (s < 60 ? 'bad' : s < 120 ? 'warn' : 'ok');

  function renderHead() {
    const tabs = panel.querySelectorAll('[data-tab]');
    tabs.forEach(t => t.setAttribute('aria-selected', String(t.dataset.tab === cfg.tab && view === 'main')));
    const q = board && board.queue;
    const own = board && board.own;
    $('chain').innerHTML = '';
    $('warline').textContent = '';
    if (!board) return;
    tabs[0].textContent = `Queue${q && q.entries.length ? ` (${q.entries.length})` : ''}`;
    const e = board.enemy;
    tabs[1].textContent = e && e.counts ? `Enemy (${e.counts.okay} okay)` : 'Enemy';
    const oc = board.ours && board.ours.members ? countsOf(board.ours.members) : null;
    tabs[2].textContent = oc ? `Faction (${oc.online} online)` : 'Faction';
    tabs[3].textContent = finder.results.length ? `FFScouter (${finder.results.length})` : 'FFScouter';
    panel.querySelector('.title').textContent = own ? `War board · ${own.name}` : 'War board';
    const c = q && q.chain;
    const est = chainInfo();
    if (q && q.noFaction) $('chain').innerHTML = '<span class="muted">The server\'s key can\'t see a faction chain.</span>';
    else if (est && est.running) $('chain').innerHTML = `<span class="big ${toneFor(est.left)}" data-chain>${mmss(est.left)}</span><span class="count">Chain ${num(c.current)}${c.max ? ` / ${num(c.max)}` : ''}</span>`;
    else if (c && c.cooldownUntil > Date.now()) $('chain').innerHTML = `<span class="muted">Chain cooldown</span> <span data-until="${c.cooldownUntil}"></span>`;
    else $('chain').innerHTML = `<span class="muted">${c ? 'No chain running' : 'Reading the chain…'}</span>`;
    if (netError) $('chain').insertAdjacentHTML('beforeend', `<span class="err">${esc(netError)}</span>`);
    const r = board.war && board.war.ranked;
    if (r && r.factions && r.factions.length === 2) {
      const us = r.factions.find(f => own && f.id === own.id) || r.factions[0];
      const them = r.factions.find(f => f !== us);
      if (r.start > Date.now()) $('warline').innerHTML = `Ranked war vs ${esc(them.name)} starts in <span data-until="${r.start}"></span>`;
      else if (!r.end || r.end > Date.now()) {
        // The score, large, at the right end of the chain line (the user's request, 2026-11-22).
        const lead = us.score - them.score;
        const tip = `${us.name} ${num(us.score)} – ${num(them.score)} ${them.name}`;
        $('chain').insertAdjacentHTML('beforeend', `<span class="score" title="${esc(tip)}">${num(us.score)} – ${num(them.score)}<span class="lead ${lead >= 0 ? 'ok' : 'bad'}">${lead >= 0 ? '+' : '−'}${num(Math.abs(lead))}</span></span>`);
        $('warline').innerHTML = `${esc(us.name)} vs ${esc(them.name)}${r.target ? ` · target ${num(r.target)}` : ''}`;
      }
    }
  }

  // Countdowns between redraws.
  function tickTimes() {
    if (panel.hidden) return;
    const now = Date.now();
    panel.querySelectorAll('[data-until]').forEach(el => { el.textContent = mmss((Number(el.dataset.until) - now) / SEC); });
    const est = chainInfo();
    const ch = panel.querySelector('[data-chain]');
    if (ch && est) { ch.textContent = mmss(est.left); ch.className = `big ${toneFor(est.left)}`; }
    if (!est || !board) return;
    const q = board.queue;
    panel.querySelectorAll('[data-eta]').forEach(el => {
      const i = Number(el.dataset.eta);
      const e = q.entries[i];
      if (!e) return;
      el.innerHTML = etaHtml(e, i, est, now);
    });
    const banner = panel.querySelector('[data-turn]');
    if (banner) { const t = turnHtml(est, now); banner.className = t.cls; banner.innerHTML = t.html; }
  }

  function etaHtml(e, i, est, now) {
    if (!est.running) return `<div class="in">${i === 0 ? 'first' : `+${mmss(est.after[i])}`}</div><div class="at">${i === 0 ? 'starts the timing' : 'after the first hit'}</div>`;
    const t = est.times[i];
    if (!drift.has(e.id)) drift.set(e.id, t);
    const d = Math.round((t - drift.get(e.id)) / SEC);
    const s = (t - now) / SEC;
    const inTxt = s <= 1 ? (i === 0 ? 'now' : 'next') : mmss(s);
    const cls = i === 0 && s <= 1 ? (est.left < 60 ? 'bad' : 'warn') : s < 60 ? 'warn' : '';
    return `<div class="in ${cls}">${inTxt}</div><div class="at">${tct(t)} TCT</div>${Math.abs(d) >= 5 ? `<div class="drift">${d > 0 ? `${mmss(d)} later` : `${mmss(-d)} sooner`}</div>` : ''}`;
  }

  // The note at the top of the queue when it's your turn, or nearly.
  function turnHtml(est, now) {
    const q = board.queue;
    const myId = board.me.id;
    const i = q.entries.findIndex(e => e.by === myId);
    if (i < 0) return { cls: 'note', html: `${q.entries.length ? `${q.entries.length} in the queue.` : 'Nobody is queued.'} Everyone hits at <b>${mmss(q.hitAt)}</b> left.` };
    if (!est.running) return { cls: 'note turn', html: i === 0 ? 'You\'re <b>first</b>: your hit starts the timing.' : `You're <b>#${i + 1}</b>: ${mmss(est.after[i])} after the first hit.` };
    const s = (est.times[i] - now) / SEC;
    if (i === 0 && s <= 1) {
      if (cfg.vibrate && !buzzed.has(q.entries[i].id) && navigator.vibrate) { buzzed.add(q.entries[i].id); try { navigator.vibrate([200, 100, 200]); } catch (e) { /* not allowed */ } }
      return { cls: 'note go', html: `Your turn: <b>hit now</b> (timer ${mmss(est.left)}).` };
    }
    return { cls: `note turn`, html: `You're <b>#${i + 1}</b>: hit in <b>${mmss(s)}</b>, at ${tct(est.times[i])} TCT.` };
  }

  function targetHtml(e, i) {
    const q = board.queue;
    const est = chainInfo();
    const n = est && est.running ? bonusAt(q.chain.current + 1 + i) : 0;
    const bonus = n ? ` <div class="bwarn">Bonus hit #${num(n)}${e.target && enemyKnown() && !enemyHas(e.target) ? `: this target isn't in ${esc(board.enemy.name)}, pick a war target` : ': hit a war target'}</div>` : '';
    if (!e.target) return bonus;
    const t = e.targetInfo;
    const name = t && t.name ? `${esc(t.name)} [${e.target}]` : `[${e.target}]`;
    let st = '';
    if (t && t.missing) st = ' · <span class="bad">no such player</span>';
    else if (t && t.state) {
      const left = t.until ? (t.until - Date.now()) / SEC : 0;
      const tone = t.state === 'Okay' ? 'ok' : t.state === 'Hospital' ? 'bad' : t.state === 'Traveling' || t.state === 'Abroad' ? 'info' : 'warn';
      st = ` · <span class="${tone}">${esc(t.state === 'Okay' ? 'Okay' : t.description || t.state)}${left > 0 ? ` <span data-until="${t.until}"></span>` : ''}</span>`;
    }
    return `<div class="tgt">→ <a href="https://www.torn.com/profiles.php?XID=${e.target}">${name}</a>${st}${ffText(e.target)} · <a href="https://www.torn.com/page.php?sid=attack&user2ID=${e.target}">Attack</a></div>${bonus}`;
  }

  let editingTarget = 0; // queue entry whose target is being edited

  // The queue as one line for Torn chat (the user's request, 2026-11-22): order, names, targets
  // and the estimated TCT time of each hit (or "+3:00" after the first hit when no chain runs).
  // Format from the user: "Current Queue: Name : Target > Name : Target > Name : Target >".
  function queueLine() {
    const parts = board.queue.entries.map(e => {
      const t = !e.target ? 'no target' : e.targetInfo && e.targetInfo.name ? e.targetInfo.name : String(e.target);
      return `${e.name} : ${t} >`;
    });
    return `Current Queue: ${parts.join(' ')}`;
  }
  async function copyText(text) {
    try { if (typeof GM_setClipboard === 'function') { GM_setClipboard(text, 'text'); return true; } } catch (e) { /* next way */ }
    try { if (GM4 && typeof GM4.setClipboard === 'function') { await GM4.setClipboard(text, 'text/plain'); return true; } } catch (e) { /* next way */ }
    try { if (navigator.clipboard && window.isSecureContext) { await navigator.clipboard.writeText(text); return true; } } catch (e) { /* next way */ }
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      if (ok) return true;
    } catch (e) { /* show it instead */ }
    return false;
  }
  // When copying isn't allowed (some phone browsers), show the line selected to copy by hand.
  function showCopyBox(text) {
    const old = root.querySelector('.copybox');
    if (old) old.remove();
    const box = document.createElement('div');
    box.className = 'copybox';
    box.setAttribute('role', 'dialog');
    box.innerHTML = '<b>Copy this into chat</b><textarea readonly></textarea><div class="join"><button class="btn primary">Done</button></div>';
    box.querySelector('textarea').value = text;
    box.querySelector('button').addEventListener('click', () => box.remove());
    root.appendChild(box);
    const ta = box.querySelector('textarea');
    ta.focus();
    ta.select();
  }

  // Chain leads can put faction members in the queue (the user's request, 2026-11-22).
  function addMemberHtml() {
    if (!board.me.lead) return '';
    const roster = (board.roster || []).filter(m => m.id !== board.me.id);
    if (!roster.length) return '<p class="small" style="margin-top:8px">Chain leads can add members here once the server has read the faction\'s member list (a minute or two).</p>';
    const dot = m => (m.last === 'Online' ? '● ' : m.last === 'Idle' ? '◐ ' : '');
    return `<h3>Add a member (chain leads)</h3>
      <div class="join"><select id="addwho" aria-label="Faction member"><option value="">Pick a member…</option>${roster.map(m => `<option value="${m.id}">${dot(m)}${esc(m.name)}${m.state && m.state !== 'Okay' ? ` (${esc(m.state)})` : ''}</option>`).join('')}</select></div>
      <div class="join"><input id="addtgt" inputmode="numeric" autocomplete="off" placeholder="Their target ID or profile link (optional)" aria-label="Their target (optional)"><button class="btn primary" data-act="addmember">Add to the queue</button></div>`;
  }

  function queueHtml() {
    const q = board.queue;
    const est = chainInfo();
    const now = Date.now();
    const myId = board.me.id;
    const options = [];
    for (let s = 30; s <= 270; s += 15) options.push(`<option value="${s}" ${s === q.hitAt ? 'selected' : ''}>${mmss(s)}</option>`);
    const rows = q.entries.map((e, i) => {
      const mine = e.by === myId;
      const acts = [];
      if (mine || board.me.lead) acts.push(`<button class="btn" data-act="tgtedit" data-entry="${e.id}">${e.target ? 'Change target' : 'Add target'}</button>`);
      if (mine) {
        acts.push(`<button class="btn" data-act="done" data-entry="${e.id}">I hit</button>`);
        if (i < q.entries.length - 1) acts.push(`<button class="btn" data-act="later" data-entry="${e.id}">Let next go first</button>`);
        acts.push(`<button class="btn danger" data-act="leave" data-entry="${e.id}">Leave</button>`);
      } else {
        if (i === 0 && est.running && est.left <= q.hitAt - 30) acts.push(`<button class="btn danger" data-act="skip" data-entry="${e.id}">Skip ${esc(e.name)}</button>`);
        if (board.me.lead) acts.push(`<button class="btn danger" data-act="remove" data-entry="${e.id}" data-name="${esc(e.name)}">Remove</button>`);
      }
      return `<li class="${mine ? 'mine' : ''}"><div class="pos">${i + 1}</div>
        <div class="who"><b>${esc(e.name)}</b>${mine ? ' <span class="small">(you)</span>' : ''}${e.note ? ` <span class="small">${esc(e.note)}</span>` : ''}${e.addedBy ? ` <span class="small">· added by ${esc(e.addedBy)}</span>` : ''}${targetHtml(e, i)}</div>
        <div class="eta" data-eta="${i}"></div>
        ${acts.length ? `<div class="acts">${acts.join('')}</div>` : ''}
        ${editingTarget === e.id ? `<div class="acts tgtform"><input id="tgtin" inputmode="numeric" autocomplete="off" placeholder="Target ID or profile link" aria-label="Target for ${esc(e.name)}" value="${e.target || ''}"><button class="btn primary" data-act="tgtsave" data-entry="${e.id}">Save</button>${e.target ? `<button class="btn" data-act="tgtclear" data-entry="${e.id}">No target</button>` : ''}<button class="btn" data-act="tgtcancel">Cancel</button></div>` : ''}</li>`;
    }).join('');
    const recent = (q.recent || []).slice(0, 6).map(h => `<li>${esc(h.name)} · ${esc(h.how)}${h.chain ? ` (#${num(h.chain)})` : ''}${h.timerAt ? ` at ${mmss(h.timerAt)}` : ''} · <span class="muted">${ago(h.at)}</span></li>`).join('');
    const watching = (q.watching || []).map(w => esc(w.name)).join(', ');
    return `<div class="note" data-turn></div>
      <div class="pace"><label for="hitat">Hit speed: everyone hits at</label>${board.me.lead ? `<select id="hitat" data-act="hitAt">${options.join('')}</select>` : `<b>${mmss(q.hitAt)}</b>`}<span class="small">left on the timer${board.me.lead ? '' : ' (set by chain leads and subleads)'}</span></div>
      <div class="small">The timer refills to ${mmss(q.refill)} ${q.refillSeen ? '(seen on this chain)' : '(assumed until a hit is seen)'}, so one hit every ${mmss(est.step)}.${q.pace !== null ? ` Hits have really landed at about <b>${mmss(q.pace)}</b> (last ${q.paceCount}).` : ''}${q.hitAtBy ? ` Set by ${esc(q.hitAtBy)}.` : ''}</div>
      ${rows ? `<div class="join" style="margin-top:8px"><button class="btn" data-act="copyq" title="Copies the queue, with targets and times, as one line for Torn chat">Copy queue for chat</button></div><ol class="q">${rows}</ol>` : '<p class="muted">The queue is empty.</p>'}
      <div class="join"><input id="jt" inputmode="numeric" autocomplete="off" placeholder="Target ID or profile link (optional)" aria-label="Target ID or profile link (optional)"><button class="btn primary" data-act="join">Join the queue</button></div>
      ${addMemberHtml()}
      <div class="small" style="margin-top:4px">Your hit comes off the queue by itself when the chain report shows it. Times move with the real timer, so a late or early hit shifts everyone after it.</div>
      ${recent ? `<h3>Recent hits</h3><ul class="recent">${recent}</ul>` : ''}
      ${watching ? `<p class="small" style="margin-top:10px">On the board now: ${watching}</p>` : ''}`;
  }

  // ---- Enemy ----
  function statusOf(m, now) {
    const left = m.until ? (m.until - now) / SEC : 0;
    if (m.state === 'Okay') return { tone: 'ok', html: 'Okay' };
    if (m.state === 'Hospital') return { tone: 'bad', html: `<span title="${esc(m.description)}">Hospital${left > 0 ? ` <span data-until="${m.until}"></span>` : ''}</span>` };
    if (m.state === 'Jail') return { tone: 'warn', html: `Jail${left > 0 ? ` <span data-until="${m.until}"></span>` : ''}` };
    if (m.state === 'Traveling') {
      const t = m.trip;
      const land = t && (t.expected || (t.landLo && t.landHi ? (t.landLo + t.landHi) / 2 : 0));
      return { tone: 'info', html: `${esc(m.description)}${land ? ` · lands ~${tct(land).slice(0, 5)} TCT` : ''}` };
    }
    return { tone: 'info', html: esc(m.description || m.state) };
  }
  // Filters and sorting as in Mentat's War tab (src/ui/war.js memberRows), plus Dibs.
  const FILTERS = [['all', 'All'], ['range', 'Around your range'], ['hittable', 'Hittable now'], ['soon', 'Out or landing within 15 min'], ['hospital', 'Hospital'], ['travel', 'Traveling / abroad'], ['online', 'Online / idle'], ['dibs', 'Dibs']];
  const SORTS = [['status', 'Status (hittable first)'], ['out', 'Out of hospital soonest'], ['level', 'Level'], ['stats', 'Est. stats'], ['active', 'Last active'], ['name', 'Name']];
  function sortMembers(rows, p = '') {
    const o = { sort: cfg[`${p}sort`], dir: cfg[`${p}dir`], sort2: cfg[`${p}sort2`], dir2: cfg[`${p}dir2`] };
    const rank = m => (m.state === 'Okay' ? 0 : m.state === 'Hospital' ? 1 : m.state === 'Jail' ? 2 : m.state === 'Traveling' ? 3 : m.state === 'Abroad' ? 4 : 5);
    const actRank = m => (m.last === 'Online' ? 0 : m.last === 'Idle' ? 1 : 2);
    const bs = m => (ffOf(m.id) && ffOf(m.id).bs) || 0;
    const nextAt = m => (m.state === 'Hospital' || m.state === 'Jail' ? m.until : m.trip ? (m.trip.expected || m.trip.landHi) : 0);
    const sec = o.sort2 && o.sort2 !== o.sort ? o.sort2 : '';
    const timed = m => m.state === 'Hospital' || m.state === 'Jail' || m.state === 'Traveling';
    const sorters = {
      // Hospital and jail always by earliest release, travellers by earliest landing, even with a
      // second sort; the second sort orders the rest.
      status: (a, b) => rank(a) - rank(b) || (timed(a) ? nextAt(a) - nextAt(b) : 0) || (sec ? 0 : nextAt(a) - nextAt(b) || actRank(a) - actRank(b) || b.level - a.level),
      out: (a, b) => (a.state === 'Hospital' ? a.until : Infinity) - (b.state === 'Hospital' ? b.until : Infinity) || rank(a) - rank(b),
      level: (a, b) => b.level - a.level,
      stats: (a, b) => bs(a) - bs(b),
      active: (a, b) => actRank(a) - actRank(b) || b.lastAt - a.lastAt,
      name: (a, b) => a.name.localeCompare(b.name),
    };
    const byKey = (key, d, a, b) => {
      if (key === 'stats' && (!bs(a) || !bs(b))) return (!bs(a)) - (!bs(b)); // no estimate: last
      return d * (sorters[key] || sorters.status)(a, b);
    };
    const dir = o.dir === -1 ? -1 : 1;
    const dir2 = o.dir2 === -1 ? -1 : 1;
    return rows.sort((a, b) => byKey(o.sort, dir, a, b) || (sec ? byKey(sec, dir2, a, b) : 0) || sorters.status(a, b) || a.name.localeCompare(b.name));
  }
  const LIVE = [[0, 'Off'], [3, '3 s'], [5, '5 s'], [10, '10 s']];
  // Online, Idle and Offline check boxes (the user's request, 2026-11-22): unticking one hides
  // those people, on top of the chosen filter. Each tab has its own.
  const activityOk = (m, p) => cfg[`${p}${m.last === 'Online' ? 'online' : m.last === 'Idle' ? 'idle' : 'offline'}`] !== false;
  const activityHtml = p => `<div class="actrow" role="group" aria-label="Show by activity"><span class="small">Show:</span>
      <label><input type="checkbox" data-activity="${p}online" ${cfg[`${p}online`] !== false ? 'checked' : ''}><span class="dot Online"></span>Online</label>
      <label><input type="checkbox" data-activity="${p}idle" ${cfg[`${p}idle`] !== false ? 'checked' : ''}><span class="dot Idle"></span>Idle</label>
      <label><input type="checkbox" data-activity="${p}offline" ${cfg[`${p}offline`] !== false ? 'checked' : ''}><span class="dot Offline"></span>Offline</label></div>`;
  function liveNote() {
    const calls = cfg.live ? Math.round(60 / cfg.live) : 0;
    if (!cfg.live) return cfg.tab === 'faction' ? 'Off: the list refreshes every couple of minutes from the server. Live refreshes it every 3, 5 or 10 s with your own API key while this tab is open.' : 'Off: the enemy refreshes every minute from the server. Live refreshes it every 3, 5 or 10 s with your own API key while this tab is open.';
    if (!liveKey) return `<span class="warn">Live uses your own API key</span> (Public is enough): about ${calls} calls a minute while this tab is open. It's kept in this script's storage on this device and only sent to api.torn.com.
      <span class="join"><input id="livekey" type="password" autocomplete="off" spellcheck="false" maxlength="40" placeholder="Your API key" aria-label="Your API key for Live"><button class="btn primary" data-act="livekey">Use for Live</button></span>`;
    const e = cfg.tab === 'faction' ? board.ours : board.enemy;
    const err = liveError ? ` <span class="err">${esc(liveError)}</span>` : '';
    if (e && e.live) return `<span class="ok">Live with your key: every ${cfg.live} s</span> (about ${calls} calls a minute of your 100).${err}`;
    return `Live with your key is starting…${err}`;
  }
  function rangeNote() {
    if (!ffs.on) return '<span class="warn">Around your range needs FFScouter: turn it on in Settings (⚙).</span>';
    const mine = myTotal();
    if (!mine) return 'Waiting for your own stats (from FFScouter)…';
    return `FF 3.00 or more and estimated stats up to 1.75× yours (${compact(mine.total)}, ${mine.from}): up to ${compact(mine.total * RANGE_MAX)}.`;
  }
  // ---- Targets (FFScouter target search) ----
  function readTargetForm() {
    const v = id => panel.querySelector(`#${id}`);
    const p = cfg.tf;
    if (v('tfpreset')) p.preset = v('tfpreset').value;
    if (v('tfminl')) p.minl = v('tfminl').value;
    if (v('tfmaxl')) p.maxl = v('tfmaxl').value;
    if (v('tfminff')) p.minff = v('tfminff').value;
    if (v('tfmaxff')) p.maxff = v('tfmaxff').value;
    if (v('tfinactive')) p.inactive = v('tfinactive').checked;
    if (v('tffless')) p.fless = v('tffless').checked;
    saveCfg();
  }
  function targetsHtml() {
    if (!ffs.on) {
      return `<p class="muted">Search FFScouter's target lists by level, fair fight and activity, then queue or attack from here. It needs your FFScouter key: turn FFScouter on in Settings (⚙).</p>
        <p class="small"><a href="${SERVER}/pda/war.html#ffscouter">How to add your FFScouter key</a></p>`;
    }
    const p = cfg.tf;
    const custom = !p.preset;
    const myId = board.me.id;
    const queued = new Set(board.queue.entries.filter(x => x.by === myId).map(x => x.target));
    const enemyIds = new Set(((board.enemy && board.enemy.members) || []).map(m => m.id));
    const rows = finder.results.map(r => `<li><div><div class="nm"><a href="https://www.torn.com/profiles.php?XID=${r.id}">${esc(r.name || `#${r.id}`)}</a> <span class="small">Lv ${r.level || '?'}</span>${ffHtml(r)}</div>
        <div class="st"><span class="small">${r.lastAction ? `Last action ${ago(r.lastAction)}` : 'Last action unknown'}</span>${enemyIds.has(r.id) ? ' · <span class="warn">in the enemy faction</span>' : ''}</div></div>
        <div class="side"><button class="btn" data-act="queueT" data-target="${r.id}" ${queued.has(r.id) ? 'disabled' : ''} title="Join the hit queue with this target">+ Queue</button>
          <a class="btn primary" href="https://www.torn.com/page.php?sid=attack&user2ID=${r.id}">Attack</a></div></li>`).join('');
    return `<div class="tf">
        <div class="sortrow"><label>List <select id="tfpreset"><option value="">Custom filters</option><option value="respect" ${p.preset === 'respect' ? 'selected' : ''}>Best respect</option><option value="level" ${p.preset === 'level' ? 'selected' : ''}>Level hunting</option></select></label></div>
        ${custom ? `<div class="sortrow"><label>Level <input id="tfminl" type="number" inputmode="numeric" min="1" max="100" placeholder="1" value="${esc(p.minl)}">–<input id="tfmaxl" type="number" inputmode="numeric" min="1" max="100" placeholder="100" value="${esc(p.maxl)}"></label>
          <label>Fair fight <input id="tfminff" type="number" inputmode="decimal" min="1" max="3" step="0.05" value="${esc(p.minff)}">–<input id="tfmaxff" type="number" inputmode="decimal" min="1" max="3" step="0.05" value="${esc(p.maxff)}"></label></div>
        <div class="sortrow"><label><input type="checkbox" id="tfinactive" ${p.inactive ? 'checked' : ''}> Inactive only</label><label><input type="checkbox" id="tffless" ${p.fless ? 'checked' : ''}> No faction</label></div>` : ''}
        <div class="join"><button class="btn primary" data-act="tfsearch" ${finderBusy ? 'disabled' : ''}>${finderBusy ? 'Searching…' : 'Search'}</button></div>
      </div>
      ${finder.error ? `<p class="err">${esc(finder.error)}</p>` : ''}
      ${rows ? `<p class="small" style="margin:8px 0 0">${finder.results.length} found ${ago(finder.at)}.</p><ul class="enemy">${rows}</ul>` : ''}
      <p class="small">Target lists from <a href="https://ffscouter.com">FFScouter</a> (${ffs.premium ? 'premium' : 'free'} account), with your FFScouter key. Searching doesn't use your Torn API limit. Fair fight: higher = tougher fight, more respect.</p>`;
  }

  function enemyHtml() {
    const e = board.enemy;
    if (!e) {
      const r = board.war && board.war.ranked;
      const own = board.own;
      const them = r && r.factions && r.factions.find(f => !own || f.id !== own.id);
      const ended = r && r.end && r.end <= Date.now() && them ? `The war with ${esc(them.name)} has ended. ` : '';
      return `<p class="muted">${ended}No enemy right now: the board shows your faction's ranked war, raid or territory war opponent while the war is on (or a faction set to watch in Mentat's War tab).</p>`;
    }
    if (!e.members) return '<p class="muted">Loading members…</p>';
    const now = Date.now();
    const claims = (board.claims && board.claims.claims) || {};
    const myId = board.me.id;
    const pick = m => {
      const f = cfg.filter;
      if (f === 'hittable') return m.state === 'Okay';
      // Everyone available within 15 min (the user's correction, 2026-11-22): hittable now, out of
      // hospital or jail within 15 min, or landing within 15 min (likeliest landing when we saw
      // them leave, else the latest it could be).
      if (f === 'soon') {
        const soon = 15 * 60 * SEC;
        if (m.state === 'Okay') return true;
        if ((m.state === 'Hospital' || m.state === 'Jail') && m.until - now <= soon) return true;
        if (m.state === 'Traveling' && m.trip) return (m.trip.expected || m.trip.landHi) - now <= soon;
        return false;
      }
      if (f === 'hospital') return m.state === 'Hospital';
      if (f === 'travel') return m.state === 'Traveling' || m.state === 'Abroad';
      if (f === 'online') return m.last === 'Online' || m.last === 'Idle';
      if (f === 'dibs') return !!claims[m.id];
      if (f === 'range') return inRange(m.id);
      return true;
    };
    const list = sortMembers(e.members.filter(m => pick(m) && activityOk(m, '')));
    const filters = `<select id="efilter" aria-label="Show">${FILTERS.map(([id, label]) => `<option value="${id}" ${cfg.filter === id ? 'selected' : ''}>${label}</option>`).join('')}</select>`;
    const sorts = `<label>Sort <select id="esort">${SORTS.map(([k, l]) => `<option value="${k}" ${cfg.sort === k ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
      <button class="btn" data-act="sortdir" title="Reverse" aria-label="Reverse the order">${cfg.dir === -1 ? '↑' : '↓'}</button>
      <label>then <select id="esort2"><option value="">—</option>${SORTS.filter(([k]) => k !== 'out').map(([k, l]) => `<option value="${k}" ${cfg.sort2 === k ? 'selected' : ''}>${l.replace(' (hittable first)', '')}</option>`).join('')}</select></label>`;
    const queued = new Set(board.queue.entries.filter(x => x.by === myId).map(x => x.target));
    const rows = list.map(m => {
      const cl = claims[m.id] || [];
      const mine = cl.some(c => c.by === myId);
      const st = statusOf(m, now);
      const dibs = cl.length ? `<div class="dibs">Dibs: ${cl.map((c, i) => `${i + 1}. ${c.by === myId ? 'you' : esc(c.name)}`).join(' · ')}</div>` : '';
      return `<li class="${cl.length ? 'claimed' : ''}"><div><div class="nm"><a href="https://www.torn.com/profiles.php?XID=${m.id}">${esc(m.name)}</a> <span class="small">Lv ${m.level}</span>${ffText(m.id)}</div>
        <div class="st"><span class="${st.tone}">${st.html}</span> · <span class="dot ${esc(m.last)}"></span><span class="small">${esc(m.last)}${m.last !== 'Online' && m.lastAt ? ` ${ago(m.lastAt)}` : ''}</span></div></div>
        <div class="side"><button class="btn ${mine ? 'on' : ''}" data-act="dibs" data-target="${m.id}" data-on="${mine ? 0 : 1}" aria-pressed="${mine}">${mine ? 'Dibs ✓' : 'Dibs'}</button>
          <button class="btn" data-act="queueT" data-target="${m.id}" ${queued.has(m.id) ? 'disabled' : ''} title="Join the hit queue with this target">+ Queue</button>
          <a class="btn primary" href="https://www.torn.com/page.php?sid=attack&user2ID=${m.id}">Attack</a></div>${dibs}</li>`;
    }).join('');
    const age = e.fetchedAt ? Math.round((now - e.fetchedAt) / SEC) : null;
    return `<div class="small" style="margin-bottom:6px">${esc(e.name)} · ${e.counts ? `${e.counts.okay} okay, ${e.counts.hospital} in hospital, ${e.counts.travel + e.counts.abroad} away` : ''}${age !== null && age > 20 ? ` · updated ${ago(e.fetchedAt)}` : ''}</div>
      <div class="filters" role="group" aria-label="Live refresh"><span class="small" style="align-self:center">Live:</span>${LIVE.map(([v, l]) => `<button data-live="${v}" aria-pressed="${cfg.live === v}">${l}</button>`).join('')}</div>
      <div class="small" style="margin:-2px 0 8px">${liveNote()}</div>
      <div class="sortrow">${filters}${sorts}</div>
      ${activityHtml('')}
      ${cfg.filter === 'range' ? `<p class="small" style="margin:-2px 0 8px">${rangeNote()}</p>` : ''}
      ${rows ? `<ul class="enemy">${rows}</ul>` : '<p class="muted">Nobody matches.</p>'}
      ${ffs.on ? `<p class="small">Fair fight and estimated stats from <a href="https://ffscouter.com">FFScouter</a>${ffs.error ? ` · <span class="err">${esc(ffs.error)}</span>` : ''}.</p>` : '<p class="small">Add FFScouter in Settings (⚙) for fair fight scores and estimated stats.</p>'}
      <p class="small">One dib at a time: dibbing someone else moves yours. ${board.claims && board.claims.clearOn === 'hospital' ? "A dib ends when the player lands in hospital (the server's key can't read the faction attack log, so it can't see who hit), when you drop it, or after 15 minutes." : 'A dib ends when you hit that player, when they land in hospital, when you drop it, or after 15 minutes.'} Dibs are shared with Mentat's War tab claims.</p>`;
  }

  // ---- Our faction (the user's request, 2026-11-22) ----
  // Members with status, online status, a Revivable tag (Torn's is_revivable), estimated stats
  // (FFScouter, no fair fight) and a bounty button. Sorting and filters like the Enemy tab.
  const OFILTERS = [['all', 'All'], ['online', 'Online / idle'], ['okay', 'Okay'], ['hospital', 'Hospital'], ['revivable', 'Revivable'], ['travel', 'Traveling / abroad']];
  // Torn's own add-bounty form for a player (address from the user, 2026-11-22).
  const bountyUrl = id => `https://www.torn.com/bounties.php?p=add&XID=${id}`;
  const statPill = id => {
    const x = ffOf(id);
    return x && x.bsHuman ? ` <span class="bs" title="Estimated battle stats (FFScouter)">${esc(x.bsHuman)}</span>` : '';
  };
  function factionHtml() {
    const o = board.ours;
    if (!o) return '<p class="muted">Loading your faction…</p>';
    if (o.denied && !o.members) return "<p class=\"muted\">The server's key can't read your faction's members.</p>";
    if (!o.members) return '<p class="muted">Loading members…</p>';
    const now = Date.now();
    const f = cfg.ofilter;
    const pick = m => {
      if (f === 'online') return m.last === 'Online' || m.last === 'Idle';
      if (f === 'okay') return m.state === 'Okay';
      if (f === 'hospital') return m.state === 'Hospital';
      if (f === 'revivable') return m.revivable;
      if (f === 'travel') return m.state === 'Traveling' || m.state === 'Abroad';
      return true;
    };
    const list = sortMembers(o.members.filter(m => pick(m) && activityOk(m, 'o')), 'o');
    const c = countsOf(o.members);
    const revivable = o.members.filter(m => m.revivable).length;
    const filters = `<select id="ofilter" aria-label="Show">${OFILTERS.map(([id, label]) => `<option value="${id}" ${f === id ? 'selected' : ''}>${label}</option>`).join('')}</select>`;
    const sorts = `<label>Sort <select id="osort">${SORTS.map(([k, l]) => `<option value="${k}" ${cfg.osort === k ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
      <button class="btn" data-act="osortdir" title="Reverse" aria-label="Reverse the order">${cfg.odir === -1 ? '↑' : '↓'}</button>
      <label>then <select id="osort2"><option value="">—</option>${SORTS.filter(([k]) => k !== 'out').map(([k, l]) => `<option value="${k}" ${cfg.osort2 === k ? 'selected' : ''}>${l.replace(' (hittable first)', '')}</option>`).join('')}</select></label>`;
    const shared = (board.energy && board.energy.members) || {};
    const eChip = m => {
      const r = shared[m.id];
      if (!r) return '';
      const e = energyNow(r, now);
      const old = now - r.at > E_FRESH;
      const drugUntil = r.drug ? r.at + r.drug * SEC : 0;
      return `<div class="st"><span class="eng${old ? ' old' : ''}" title="Energy shared ${ago(r.at)}${old ? ' (too old to count in the total)' : ''}">E ${e}/${r.energy.maximum} · ${Math.floor(e / HIT_E)} hits</span> <span class="small">${drugUntil > now ? `Drug <span data-until="${drugUntil}"></span>` : 'No drug cooldown'} · ${ago(r.at)}</span></div>`;
    };
    // The total: members sharing, online or idle now, with a reading from the last 15 minutes.
    let eTotal = 0;
    let hTotal = 0;
    let eCount = 0;
    for (const m of o.members) {
      const r = shared[m.id];
      if (!r || now - r.at > E_FRESH || (m.last !== 'Online' && m.last !== 'Idle')) continue;
      const e = energyNow(r, now);
      eTotal += e;
      hTotal += Math.floor(e / HIT_E);
      eCount++;
    }
    const sharing = o.members.filter(m => shared[m.id]).length;
    const totalHtml = `<div class="etotal" title="Members who share their energy, online or idle now, with a reading from the last 15 minutes. One attack costs ${HIT_E} energy."><span>~Online E available</span> <b>${num(eTotal)}</b> <span>~${num(hTotal)} hits</span> <span class="small">${eCount} of ${sharing} sharing members${cfg.shareE ? '' : ' · <a href="#" data-act="settings">share yours</a>'}</span></div>`;
    const rows = list.map(m => {
      const st = statusOf(m, now);
      const rev = m.revivable ? ` <span class="tag rev" title="${esc(m.reviveSetting ? `Revivable (revive setting: ${m.reviveSetting})` : 'Revivable')}">Revivable</span>` : '';
      const ed = m.earlyDischarge ? ' <span class="tag pos" title="Can take an early discharge from hospital">Early discharge</span>' : '';
      return `<li><div><div class="nm"><a href="https://www.torn.com/profiles.php?XID=${m.id}">${esc(m.name)}</a> <span class="small">Lv ${m.level}${m.position ? ` · ${esc(m.position)}` : ''}</span>${statPill(m.id)}${rev}${ed}</div>
        <div class="st"><span class="${st.tone}">${st.html}</span> · <span class="dot ${esc(m.last)}"></span><span class="small">${esc(m.last)}${m.last !== 'Online' && m.lastAt ? ` ${ago(m.lastAt)}` : ''}</span></div>${eChip(m)}</div>
        <div class="side"><a class="btn" href="${bountyUrl(m.id)}" title="Place a bounty on ${esc(m.name)}">Add bounty</a></div></li>`;
    }).join('');
    const age = o.fetchedAt ? Math.round((now - o.fetchedAt) / SEC) : null;
    return `${totalHtml}<div class="small" style="margin-bottom:6px">${esc((board.own && board.own.name) || 'Your faction')} · ${o.members.length} members · ${c.online} online, ${c.idle} idle · ${c.okay} okay, ${c.hospital} in hospital${revivable ? ` (${revivable} revivable)` : ''}, ${c.travel + c.abroad} away${age !== null && age > 20 ? ` · updated ${ago(o.fetchedAt)}` : ''}</div>
      <div class="filters" role="group" aria-label="Live refresh"><span class="small" style="align-self:center">Live:</span>${LIVE.map(([v, l]) => `<button data-live="${v}" aria-pressed="${cfg.live === v}">${l}</button>`).join('')}</div>
      <div class="small" style="margin:-2px 0 8px">${liveNote()}</div>
      <div class="sortrow">${filters}${sorts}</div>
      ${activityHtml('o')}
      ${rows ? `<ul class="enemy">${rows}</ul>` : '<p class="muted">Nobody matches.</p>'}
      ${ffs.on ? '<p class="small">Estimated stats from <a href="https://ffscouter.com">FFScouter</a>.</p>' : '<p class="small">Add FFScouter in Settings (⚙) for estimated stats.</p>'}`;
  }

  function signInHtml() {
    const refused = signError && /members of/i.test(signError);
    return `<div class="sign">
      <p><b>Sign in to your faction's Mentat server.</b></p>
      ${pdaKey ? '<p class="muted">Using the API key you gave Torn PDA.</p><div class="join"><button class="btn primary" data-act="signin">Sign in</button></div>'
        : `<p class="muted">Enter your Torn API key (Limited recommended; energy sharing needs at least Minimal). The Mentat server checks it once with Torn to see you're in the faction, then forgets it. This script keeps it on this device only, to read your own data from Torn (Live, energy sharing, your stats); it's never sent anywhere else. Signing out removes it.</p>
           <div class="join"><input id="key" type="password" autocomplete="off" spellcheck="false" maxlength="40" placeholder="API key" aria-label="Torn API key"><button class="btn primary" data-act="signin">Sign in</button></div>`}
      ${signError ? `<p class="err">${esc(signError)}</p>` : ''}
      ${refused ? '' : ''}<p class="small"><a href="${GUIDE}">How this works</a></p></div>`;
  }

  // Admin > Chain Lead > Chain Sublead. Admins tick the chain lead positions (Torn's API doesn't
  // give the order of positions); chain leads and admins add or remove chain subleads by name.
  function leadsHtml() {
    if (!board || !board.me) return '';
    const q = board.queue;
    const role = board.me.role || (board.me.lead ? 'lead' : '');
    const roleText = { admin: "You're an admin: you choose the chain lead positions and can do everything below.", lead: "You're a chain lead: you can set the hit speed, manage the queue, and add or remove chain subleads.", sublead: "You're a chain sublead: you can set the hit speed and manage the queue." }[role] || 'Chain leads and subleads set the hit speed and manage the queue.';
    let html = `<h3>Chain leads</h3><p class="small" style="margin:0 0 6px">${roleText}</p>`;
    if (board.me.admin) {
      const seen = [...new Set([...(board.positions || []), ...q.leadPositions])].sort((a, b) => a.localeCompare(b));
      html += seen.length
        ? `<p class="small" style="margin:0 0 4px"><b>Chain lead positions</b> (admins choose):</p>${seen.map(p => `<label><input type="checkbox" data-lead="${esc(p)}" ${q.leadPositions.some(x => x.toLowerCase() === p.toLowerCase()) ? 'checked' : ''}> ${esc(p)}</label>`).join('')}`
        : "<p class='small'>The faction's positions show here once the server has read your members (a minute or two).</p>";
    } else if (q.leadPositions.length) html += `<p class="small" style="margin:0 0 4px">Chain lead positions: ${q.leadPositions.map(esc).join(', ')}.</p>`;
    const manage = role === 'admin' || role === 'lead';
    const subs = q.subleads || [];
    html += `<p class="small" style="margin:10px 0 4px"><b>Chain subleads</b>${manage ? ' (added by chain leads):' : ':'}</p>`;
    html += subs.length
      ? `<ul class="recent">${subs.map(x => `<li>${esc(x.name)} <span class="muted">· added by ${esc(x.addedBy || '?')}</span>${manage ? ` <button class="btn danger" data-act="rmsub" data-player="${x.id}" data-name="${esc(x.name)}">Remove</button>` : ''}</li>`).join('')}</ul>`
      : '<p class="small" style="margin:0">None yet.</p>';
    if (manage) {
      const taken = new Set(subs.map(x => x.id));
      const roster = (board.roster || []).filter(m => !taken.has(m.id) && m.id !== board.me.id);
      html += roster.length
        ? `<div class="join"><select id="subwho" aria-label="Faction member to make a chain sublead"><option value="">Pick a member…</option>${roster.map(m => `<option value="${m.id}">${esc(m.name)}</option>`).join('')}</select><button class="btn primary" data-act="addsub">Make chain sublead</button></div>`
        : "<p class='small'>The faction's members show here once the server has read them (a minute or two).</p>";
    }
    return html;
  }

  function ffsHtml() {
    const intro = `<h3>FFScouter</h3><p class="small" style="margin:0 0 6px">Fair fight scores and estimated battle stats on the enemy list and queued targets, from <a href="https://ffscouter.com">FFScouter</a>. Uses your own FFScouter key (your Torn API key after signing up at ffscouter.com), since fair fight is worked out against your stats. Requests go only to ffscouter.com and don't use your Torn API limit.</p>`;
    if (ffs.on) return `${intro}<p>On (${ffs.premium ? 'premium' : 'free'} account${ffs.pda ? ", Torn PDA's key" : ''}). <button class="btn" data-act="ffsoff">Turn off</button></p>${ffs.error ? `<p class="err">${esc(ffs.error)}</p>` : ''}`;
    return `${intro}
      <div class="join"><input id="ffskey" type="password" autocomplete="off" spellcheck="false" maxlength="40" placeholder="${pdaKey ? "Leave empty to use Torn PDA's key" : 'FFScouter key'}" aria-label="FFScouter key"></div>
      <label><input type="checkbox" id="ffsack"> <span>I have read FFScouter's current <a href="https://ffscouter.com/privacy">data policy</a> and agree to it.</span></label>
      <div class="join"><button class="btn primary" data-act="ffson">Turn on FFScouter</button></div>
      <p class="small">${pdaKey ? "Torn PDA's key is used as it is and isn't saved by this script." : "The key is kept in this script's storage in this browser and only sent to ffscouter.com."} FFScouter is free; <a href="https://ffscouter.com/premium">premium</a> gives more accurate estimates.</p>
      ${ffs.error ? `<p class="err">${esc(ffs.error)}</p>` : ''}`;
  }

  function settingsHtml() {
    return `<div class="settings">
      <p class="muted" style="margin-top:0">${me && me.name ? `Signed in as ${esc(me.name)}` : ''}${me && me.faction && me.faction.name ? ` · ${esc(me.faction.name)}` : ''}</p>
      <label><input type="checkbox" data-set="vibrate" ${cfg.vibrate ? 'checked' : ''}> Vibrate when it's my turn (phones)</label>
      <label><input type="checkbox" data-set="attackLight" ${cfg.attackLight ? 'checked' : ''}> On attack pages, show a red light when it isn't my turn (green when it is)</label>
      ${energySettingsHtml()}
      ${!pdaKey && liveKey ? "<p class=\"small\">This device keeps the API key you signed in with, for Live, energy sharing and your stats. It's only sent to api.torn.com. Signing out removes it.</p>" : ''}
      ${leadsHtml()}
      ${ffsHtml()}
      <div class="join" style="margin-top:12px"><button class="btn" data-act="resetpos">Reset places</button><a class="btn" href="${GUIDE}">Guide</a><button class="btn danger" data-act="signout">Sign out</button></div>
      <div class="join"><button class="btn primary" data-act="back">Back to the board</button></div>
      <p class="small">Mentat war board ${VERSION}${latestVersion() ? (updateReady() ? ` · <b>${esc(latestVersion())} is available</b>` : ' · up to date') : ''}. <button class="btn" data-act="checkupdate">Check for updates</button> It only shows and links: it never reads or clicks anything on Torn's pages.</p></div>`;
  }

  // The button shows your next hit, else the chain timer.
  function renderFab() {
    const t = fab.querySelector('.t');
    if (!session) { t.textContent = ''; fab.className = 'fab'; fab.title = 'War board: sign in'; return; }
    const est = chainInfo();
    if (!board || !est) { t.textContent = ''; fab.className = 'fab'; return; }
    const q = board.queue;
    const i = q.entries.findIndex(e => e.by === board.me.id);
    if (i >= 0 && est.running) {
      const s = (est.times[i] - Date.now()) / SEC;
      t.textContent = s <= 1 && i === 0 ? 'HIT' : `#${i + 1} ${mmss(s)}`;
      fab.className = `fab ${i === 0 && s <= 1 ? 'bad' : s < 60 ? 'warn' : 'ok'}`;
      fab.title = i === 0 && s <= 1 ? 'Your turn: hit now' : `You're #${i + 1} in the queue, hitting in ${mmss(s)}`;
    } else if (i >= 0) {
      t.textContent = `#${i + 1}`;
      fab.className = 'fab ok';
      fab.title = `You're #${i + 1} in the hit queue`;
    } else if (est.running) {
      t.textContent = mmss(est.left);
      fab.className = `fab ${est.left < 60 ? 'bad' : est.left < 120 ? 'warn' : ''}`;
      fab.title = `Chain ${q.chain.current}: ${mmss(est.left)} left`;
    } else { t.textContent = ''; fab.className = 'fab'; fab.title = 'War board'; }
    if (updateReady()) { fab.classList.add('upd'); fab.title = `${fab.title || 'War board'} · update ${latestVersion()} available`; }
    fab.setAttribute('aria-label', fab.title || 'War board');
  }

  // ---- Taps ----
  const parseTarget = v => {
    const s = String(v || '').trim();
    if (!s) return 0;
    const m = /(?:XID=|user2ID=|ID=|\[)(\d+)/i.exec(s) || /^(\d+)$/.exec(s);
    return m ? Number(m[1]) : -1;
  };
  panel.addEventListener('click', async e => {
    if (e.target.closest('a[href="#"]')) e.preventDefault();
    if (e.target.matches && e.target.matches('[data-selectall]')) { e.target.select(); return; }
    const tab = e.target.closest('[data-tab]');
    if (tab) { cfg.tab = tab.dataset.tab; view = 'main'; saveCfg(); render(true); if (cfg.tab !== 'queue') load(); return; }
    const lv = e.target.closest('[data-live]');
    if (lv) { cfg.live = Number(lv.dataset.live); liveLast = 0; saveCfg(); render(true); liveTick(); return; }
    const a = e.target.closest('[data-act]');
    if (!a || a.tagName === 'SELECT') return;
    const what = a.dataset.act;
    if (what === 'close') return togglePanel(false);
    if (what === 'settings') { view = view === 'settings' ? 'main' : 'settings'; return render(true); }
    if (what === 'back') { view = 'main'; return render(true); }
    if (what === 'update') {
      a.disabled = false;
      // A new address each version, so no cached copy of the old script is shown (Userscripts
      // only offers to install when the address ends in .user.js, so not there).
      window.open(/userscripts/i.test(handler) ? SCRIPT_URL : `${SCRIPT_URL}?v=${encodeURIComponent(latestVersion())}`, '_blank');
      updateHelp = true;
      return render(true);
    }
    if (what === 'updatehow') { a.disabled = false; updateHelp = !updateHelp; return render(true); }
    if (what === 'checkupdate') {
      await load();
      toast(updateReady() ? `Update available: ${latestVersion()}.` : `You have the newest version (${VERSION}).`);
      view = 'main';
      return render(true);
    }
    if (what === 'livekey') {
      const k = String((panel.querySelector('#livekey') || {}).value || '').replace(/[^A-Za-z0-9]/g, '');
      if (!/^[A-Za-z0-9]{16}$/.test(k)) { toast('A Torn API key is 16 letters and numbers.'); a.disabled = false; return; }
      liveKey = k;
      await store.set('liveKey', k);
      liveError = '';
      liveLast = 0;
      render(true);
      liveTick();
      return;
    }
    if (what === 'forgetlive') { liveKey = ''; liveData.enemy = liveData.ours = null; await store.set('liveKey', ''); return render(true); }
    if (what === 'osortdir') { cfg.odir = cfg.odir === -1 ? 1 : -1; saveCfg(); return render(true); }
    if (what === 'sortdir') { cfg.dir = cfg.dir === -1 ? 1 : -1; saveCfg(); return render(true); }
    if (what === 'ffsoff') { await ffsOff(); return render(true); }
    if (what === 'tfsearch') { readTargetForm(); return ffsFind(); }
    if (what === 'ffson') {
      const typed = String((panel.querySelector('#ffskey') || {}).value || '').replace(/[^A-Za-z0-9]/g, '');
      if (!(panel.querySelector('#ffsack') || {}).checked) { ffs.error = "Please confirm you've read FFScouter's data policy."; return render(true); }
      const key = typed || pdaKey;
      if (!key) { ffs.error = 'Enter your FFScouter key.'; return render(true); }
      a.disabled = true;
      await ffsEnable(key, !typed && !!pdaKey);
      render(true);
      ffsTick();
      return;
    }
    if (what === 'resetpos') { cfg.pos = null; cfg.panelPos = null; saveCfg(); placeFab(); placePanel(); return; }
    if (what === 'signout') { view = 'main'; return signOut(); }
    if (what === 'signin') {
      const k = pdaKey || String((panel.querySelector('#key') || {}).value || '').replace(/[^A-Za-z0-9]/g, '');
      if (!k) { signError = 'Enter your API key.'; return render(true); }
      a.disabled = true;
      const ok = await signIn(k);
      render(true);
      if (ok) { start(); load(); }
      return;
    }
    a.disabled = true;
    setTimeout(() => { a.disabled = false; }, 1500);
    if (what === 'dibs') return act('war/claims', { target: Number(a.dataset.target), claim: a.dataset.on === '1' });
    if (what === 'queueT') return act('war/queue', { act: 'join', target: Number(a.dataset.target) });
    if (what === 'join') {
      const input = panel.querySelector('#jt');
      const t = parseTarget(input && input.value);
      if (t < 0) { toast('Use a player ID, or paste their profile link.'); a.disabled = false; return; }
      if (input) input.value = '';
      return act('war/queue', { act: 'join', target: t });
    }
    if (what === 'addmember') {
      const sel = panel.querySelector('#addwho');
      const who = Number(sel && sel.value);
      if (!who) { toast('Pick a member first.'); a.disabled = false; return; }
      const input = panel.querySelector('#addtgt');
      const t = parseTarget(input && input.value);
      if (t < 0) { toast('Use a player ID, or paste their profile link.'); a.disabled = false; return; }
      if (input) input.value = '';
      if (sel) sel.value = '';
      return act('war/queue', { act: 'join', for: who, target: t });
    }
    if (what === 'copyq') {
      a.disabled = false;
      const text = queueLine();
      if (await copyText(text)) toast(`Copied: ${text}`, 6000); else showCopyBox(text);
      return;
    }
    if (what === 'tgtedit') { a.disabled = false; editingTarget = Number(a.dataset.entry); render(true); const i = panel.querySelector('#tgtin'); if (i) { i.focus(); i.select(); } return; }
    if (what === 'tgtcancel') { a.disabled = false; editingTarget = 0; return render(true); }
    if (what === 'tgtsave' || what === 'tgtclear') {
      const t = what === 'tgtclear' ? 0 : parseTarget((panel.querySelector('#tgtin') || {}).value);
      if (t < 0) { toast('Use a player ID, or paste their profile link.'); a.disabled = false; return; }
      editingTarget = 0;
      return act('war/queue', { act: 'target', entry: Number(a.dataset.entry), target: t });
    }
    if (what === 'addsub') {
      const sel = panel.querySelector('#subwho');
      const who = Number(sel && sel.value);
      if (!who) { toast('Pick a member first.'); a.disabled = false; return; }
      return act('war/queue', { act: 'addSublead', player: who });
    }
    if (what === 'rmsub') {
      if (!window.confirm(`Remove ${a.dataset.name || 'them'} as a chain sublead?`)) { a.disabled = false; return; }
      return act('war/queue', { act: 'removeSublead', player: Number(a.dataset.player) });
    }
    if (what === 'remove') {
      if (!window.confirm(`Take ${a.dataset.name || 'them'} off the queue?`)) { a.disabled = false; return; }
      return act('war/queue', { act: 'leave', entry: Number(a.dataset.entry) });
    }
    if (['done', 'leave', 'skip', 'later'].includes(what)) {
      if (what === 'skip' && !window.confirm('Take them off the front of the queue so the next person goes?')) { a.disabled = false; return; }
      return act('war/queue', { act: what, entry: Number(a.dataset.entry) });
    }
  });
  panel.addEventListener('change', e => {
    if (e.target.id === 'hitat') act('war/queue', { act: 'hitAt', sec: Number(e.target.value) });
    if (e.target.id === 'efilter') { cfg.filter = e.target.value; saveCfg(); render(true); }
    if (e.target.closest('.tf')) { readTargetForm(); if (e.target.id === 'tfpreset') render(true); }
    if (e.target.id === 'ofilter') { cfg.ofilter = e.target.value; saveCfg(); render(true); }
    if (e.target.closest('[data-share]')) {
      if (e.target.checked) { e.target.checked = false; cfg.energyAsked = false; energyPopup(); }
      else setSharing(false);
    }
    const act2 = e.target.closest('[data-activity]');
    if (act2) { cfg[act2.dataset.activity] = act2.checked; saveCfg(); render(true); }
    if (e.target.id === 'osort') { cfg.osort = e.target.value; cfg.odir = 1; saveCfg(); render(true); }
    if (e.target.id === 'osort2') { cfg.osort2 = e.target.value; cfg.odir2 = 1; saveCfg(); render(true); }
    if (e.target.id === 'esort') { cfg.sort = e.target.value; cfg.dir = 1; saveCfg(); render(true); }
    if (e.target.id === 'esort2') { cfg.sort2 = e.target.value; cfg.dir2 = 1; saveCfg(); render(true); }
    const s = e.target.closest('[data-set]');
    if (s) { cfg[s.dataset.set] = s.checked; saveCfg(); renderLight(); }
    if (e.target.closest('[data-lead]')) {
      const picked = [...panel.querySelectorAll('[data-lead]')].filter(x => x.checked).map(x => x.dataset.lead);
      act('war/queue', { act: 'leads', positions: picked });
    }
  });
  panel.addEventListener('keydown', e => {
    if (e.key === 'Enter' && e.target.id === 'jt') panel.querySelector('[data-act="join"]').click();
    if (e.key === 'Enter' && /^tf/.test(e.target.id || '')) panel.querySelector('[data-act="tfsearch"]').click();
    if (e.key === 'Enter' && e.target.id === 'addtgt') panel.querySelector('[data-act="addmember"]').click();
    if (e.key === 'Enter' && e.target.id === 'tgtin') panel.querySelector('[data-act="tgtsave"]').click();
    if (e.key === 'Enter' && e.target.id === 'livekey') panel.querySelector('[data-act="livekey"]').click();
    if (e.key === 'Escape' && e.target.id === 'tgtin') { e.stopPropagation(); editingTarget = 0; render(true); return; }
    if (e.key === 'Enter' && e.target.id === 'key') panel.querySelector('[data-act="signin"]').click();
    if (e.key === 'Escape') togglePanel(false);
  });

  // ---- Start ----
  let timer = null;
  let ticker = null;
  let lastLoad = 0;
  function start() {
    if (timer) return;
    // Every 3 s with the board open, every 15 s closed (for the button), paused in the background.
    timer = setInterval(() => {
      if (document.hidden || !session) return;
      const every = panel.hidden && !(cfg.attackLight && onAttackPage()) ? 15 * SEC : 3 * SEC;
      if (Date.now() - lastLoad >= every - 200) { lastLoad = Date.now(); load(); }
      ffsTick();
      myStatsTick();
      liveTick();
      energyTick();
      energyPopup();
    }, 1000);
    ticker = setInterval(() => { renderFab(); renderLight(); tickTimes(); }, 1000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden && session) { lastLoad = Date.now(); load(); } });
  }

  // Someone the server turned away isn't asked again for 12 hours (the button stays hidden).
  if (!session && Date.now() - (await store.get('refusedAt', 0)) < 12 * 3600 * SEC) { host.remove(); return; }
  if (!session && pdaKey) await signIn(pdaKey);
  if (session) { start(); lastLoad = Date.now(); load(); }
  if (cfg.open) togglePanel(true); else render();
})();
