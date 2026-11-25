// ==UserScript==
// @name         Mentat Mugger
// @namespace    mentat.example.com
// @version      1.0.10
// @description  Mug targets where you are abroad: traders at or flying to your country, their estimated cash on hand, what a mug would take, and the fight. For members of the faction's Mentat server. Works in Torn PDA and in browsers (Tampermonkey, Greasemonkey, Userscripts on Safari).
// @author       Mentat
// @match        https://www.torn.com/*
// @run-at       document-end
// @noframes
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM.xmlHttpRequest
// @grant        GM.getValue
// @grant        GM.setValue
// @connect      mentat.example.com
// @connect      api.torn.com
// @connect      ffscouter.com
// @connect      weav3r.dev
// @downloadURL  https://mentat.example.com/pda/mentat-mugger.user.js
// @updateURL    https://mentat.example.com/pda/mentat-mugger.meta.js
// ==/UserScript==

// What it does: a button over Torn pages opens Mugger. While you're flying out or abroad it lists the
// players in (or flying to) that country who trade costly abroad items, with their estimated cash on
// hand, what a mug would take and the fight. It only displays and links: it never reads, changes or
// clicks anything on Torn's pages.
// Data:
// - Who trades: the Mentat server's market database (bazaar listings of abroad items, 90 days).
// - Where they are, their job, travel and trading stats, your battle stats and merits: Torn's API with
//   YOUR key (Torn PDA's, or the one you sign in with in a browser, kept only on this device), and only
//   while you're flying out or abroad (the user's rules, 2026-11-24). Nothing you look up is sent to
//   the Mentat server.
// - Bazaar sales near you: Weav3r (weav3r.dev, no key), the items those players sell, every 5 minutes.
// - Fair fight and estimated stats: FFScouter with your own FFScouter key (optional), once per player
//   per trip.
// Mug size (Torn wiki "Mug"): 5% of cash on hand, rolled up to 10% (low values favoured), × (1 +
// Masterful Looting (5% a level) + Plunder (+20% to 49%)); a 7★ Clothing Store employee loses 75% less;
// after a mug the rest of their wallet is protected, the protection decaying over 12 hours.
// Same rules as Mentat's Mugger tab (src/main/features/mugger.js, muggerdb.js).

(async () => {
  'use strict';
  if (window.top !== window.self || window.__mentatMugger) return;
  window.__mentatMugger = true;

  const VERSION = '1.0.10';
  const SERVER = 'https://mentat.example.com';
  const GUIDE = `${SERVER}/pda/mugger.html`;
  const SCRIPT_URL = `${SERVER}/pda/mentat-mugger.user.js`;
  const PDA_KEY = '###PDA-APIKEY###';
  const pdaKey = /^[A-Za-z0-9]{16}$/.test(PDA_KEY) ? PDA_KEY : '';
  const SEC = 1000, MIN = 60 * SEC;
  /* global PDA_storage, PDA_httpGet, PDA_httpPost, GM_xmlhttpRequest, GM_getValue, GM_setValue, GM, GM_info */
  const GM4 = typeof GM !== 'undefined' && GM ? GM : null;
  const handler = (typeof GM_info !== 'undefined' && GM_info && GM_info.scriptHandler) || (GM4 && GM4.info && GM4.info.scriptHandler) || '';
  const isPda = typeof PDA_httpGet === 'function';

  // ---- Storage: Torn PDA's script store, the script manager's, or localStorage ----
  const store = {
    async get(k, d) {
      try {
        if (typeof PDA_storage !== 'undefined') return (await PDA_storage.get(`mug.${k}`, d)) ?? d;
        if (typeof GM_getValue === 'function') return GM_getValue(`mug.${k}`, d) ?? d;
        if (GM4 && typeof GM4.getValue === 'function') return (await GM4.getValue(`mug.${k}`, d)) ?? d;
        const v = localStorage.getItem(`mentat.mug.${k}`);
        return v === null ? d : JSON.parse(v);
      } catch (e) { return d; }
    },
    async set(k, v) {
      try {
        if (typeof PDA_storage !== 'undefined') await PDA_storage.set(`mug.${k}`, v);
        else if (typeof GM_setValue === 'function') GM_setValue(`mug.${k}`, v);
        else if (GM4 && typeof GM4.setValue === 'function') await GM4.setValue(`mug.${k}`, v);
        else localStorage.setItem(`mentat.mug.${k}`, JSON.stringify(v));
      } catch (e) { /* keep going in memory */ }
    },
  };
  const COUNTRIES = ['Mexico', 'Cayman Islands', 'Canada', 'Hawaii', 'United Kingdom', 'Argentina', 'Switzerland', 'Japan', 'China', 'UAE', 'South Africa'];
  const cfg = Object.assign({ pos: null, panelPos: null, open: false, preview: 'Japan', flying: true, hosp: false, sort: 'score', looting: 'auto', plunder: 0, pool: 60, rate: 20, here: 1, market: 5, min: 100000 }, await store.get('cfg', {}));
  if (!COUNTRIES.includes(cfg.preview)) cfg.preview = 'Japan';
  const saveCfg = () => store.set('cfg', cfg);

  // ---- HTTP: Torn PDA's handler, the script manager's, or fetch ----
  function gmRequest(method, url, headers, data) {
    return new Promise((resolve, reject) => GM_xmlhttpRequest({
      method, url, headers, data, timeout: 20000,
      onload: r => resolve({ status: r.status, text: r.responseText }),
      onerror: () => reject(new Error('network')), ontimeout: () => reject(new Error('timeout')),
    }));
  }
  async function xhr(method, url, headers = {}, data) {
    if (isPda) {
      const x = method === 'POST' ? await PDA_httpPost(url, headers, data) : await PDA_httpGet(url, headers);
      return { status: Number(x.status), text: x.responseText };
    }
    if (typeof GM_xmlhttpRequest === 'function') return gmRequest(method, url, headers, data);
    if (GM4 && typeof GM4.xmlHttpRequest === 'function') {
      const x = await GM4.xmlHttpRequest({ method, url, headers, data, timeout: 20000 });
      return { status: Number(x.status), text: x.responseText };
    }
    const x = await fetch(url, { method, headers, body: data });
    return { status: x.status, text: await x.text() };
  }
  const parse = t => { try { return JSON.parse(t); } catch (e) { return null; } };
  async function server(method, path, body, token) {
    const headers = { 'Content-Type': 'application/json', Accept: 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    const r = await xhr(method, `${SERVER}/api/v1/${path}`, headers, method === 'POST' ? JSON.stringify(body || {}) : undefined);
    return { status: r.status, json: parse(r.text) };
  }

  // ---- Sign-in: the Mentat server checks you're in the faction, then forgets the key ----
  let session = await store.get('session', '');
  let me = await store.get('me', null);
  let liveKey = pdaKey ? '' : await store.get('liveKey', '');
  const myKey = () => pdaKey || liveKey;
  let signError = '';
  async function signIn(key) {
    signError = '';
    let r;
    try { r = await server('POST', 'login', { key, device: isPda ? 'Torn PDA Mugger' : 'Mugger (browser)' }); } catch (e) { signError = "Couldn't reach the Mentat server."; return false; }
    if (r.status === 200 && r.json && r.json.session) {
      session = r.json.session;
      me = { ...r.json.me, checkedAt: Date.now() };
      await store.set('session', session);
      await store.set('me', me);
      await store.set('refusedAt', 0);
      // Browsers keep the key on this device: Mugger looks players up with it (only ever sent to api.torn.com).
      if (!pdaKey) { liveKey = key; await store.set('liveKey', key); }
      return true;
    }
    if (r.status === 403) await store.set('refusedAt', Date.now());
    signError = (r.json && r.json.error) || "Couldn't sign in. Try again.";
    return false;
  }
  async function signOut() {
    if (session) server('POST', 'logout', {}, session).catch(() => {});
    session = ''; me = null; traders = null;
    await store.set('session', '');
    await store.set('me', null);
    if (!pdaKey) { liveKey = ''; await store.set('liveKey', ''); }
    render(true);
  }

  // ---- Torn API with your key: one call at a time, at most cfg.rate a minute (kept across page loads) ----
  let calls = (await store.get('calls', [])).filter(t => Date.now() - t < MIN);
  let tornPausedUntil = 0;
  let tornError = '';
  async function torn(path) {
    const key = myKey();
    if (!key) throw Object.assign(new Error('No API key'), { kind: 'nokey' });
    calls = calls.filter(t => Date.now() - t < MIN);
    calls.push(Date.now());
    store.set('calls', calls);
    const sep = path.includes('?') ? '&' : '?';
    const r = await fetch(`https://api.torn.com${path}${sep}key=${key}&comment=Mentat`);
    const d = await r.json();
    if (d && d.error) {
      const code = d.error.code;
      if (code === 2 && !pdaKey) { liveKey = ''; await store.set('liveKey', ''); tornError = 'Torn rejected your API key: sign out and in again.'; }
      if (code === 5) { tornPausedUntil = Date.now() + MIN; tornError = 'Torn says too many requests: pausing a minute.'; }
      if ([8, 9, 14].includes(code)) { tornPausedUntil = Date.now() + 5 * MIN; tornError = `Torn says: ${d.error.error}. Pausing 5 minutes.`; }
      throw Object.assign(new Error(d.error.error || 'Torn error'), { kind: [6, 7, 16].includes(code) ? 'soft' : 'torn', code });
    }
    tornError = '';
    return d;
  }
  const canCall = () => myKey() && Date.now() >= tornPausedUntil && calls.filter(t => Date.now() - t < MIN).length < cfg.rate;

  // Only one open Torn tab does the looking up (so two tabs don't use your API calls twice).
  const TAB = Math.random().toString(36).slice(2);
  async function leader() {
    const l = await store.get('lock', null);
    if (!l || l.tab === TAB || Date.now() - l.at > 15 * SEC) { await store.set('lock', { tab: TAB, at: Date.now() }); return true; }
    return false;
  }

  // ---- Your trip, from your own status (every minute) ----
  const COUNTRY_ALIAS = { 'united arab emirates': 'UAE', cayman: 'Cayman Islands' };
  const countryOf = name => {
    const n = String(name || '').trim().replace(/\.$/, '').toLowerCase();
    return COUNTRIES.find(c => c.toLowerCase() === n) || COUNTRY_ALIAS[n] || '';
  };
  // A hospital stay abroad reads like "In a Swiss hospital for 23 mins" (not yet confirmed live).
  const HOSPITAL_ADJ = { mexican: 'Mexico', caymanian: 'Cayman Islands', canadian: 'Canada', hawaiian: 'Hawaii', british: 'United Kingdom', english: 'United Kingdom', argentinian: 'Argentina', argentine: 'Argentina', swiss: 'Switzerland', japanese: 'Japan', chinese: 'China', emirati: 'UAE', 'south african': 'South Africa' };
  const hospitalCountry = desc => { const m = /^In an? (.+?) hospital\b/i.exec(String(desc || '').trim()); return m ? countryOf(HOSPITAL_ADJ[m[1].toLowerCase()] || m[1]) : ''; };
  const PROTECT = 12 * 60 * MIN, SAME_STAY = 25 * MIN, DAY = 24 * 60 * MIN;
  // Only a stay another player caused can be a mug ("Mugged by", "Hospitalized by"); not transfusions, Ipecac and the like.
  const BY_PLAYER = /^(Mugged|Hospitali[sz]ed|Attacked) by /i;
  // A pasted People list (the user's request 2026-11-25): you copy Torn's People list yourself (this
  // script never reads Torn's pages for it) and paste it in the panel. With links: "Name [id]" lines;
  // as plain text, names are matched against the market database, then Torn's player search.
  const PASTE_MAX = 300, LOOKUP_MAX = 100;
  const NOT_NAMES = new Set(('level lvl status okay hospital hospitalized traveling travelling abroad jail jailed attack attacks mug ' +
    'name names faction factions icons icon life online offline idle people page pages next prev previous last first show all sort ' +
    'by rank age days day hours hrs hour mins min minutes seconds secs ago user users profile list the and for from with you your ' +
    'mexico cayman islands canada hawaii united kingdom argentina switzerland japan china uae arab emirates south africa torn city ' +
    'returning flying landing landed bazaar shop market donator member members company none').split(' '));
  function parsePeople(text) {
    const s = String(text || '');
    const ids = new Map();
    for (const m of s.matchAll(/([A-Za-z0-9_-]{1,20})\s*\[(\d{1,8})\]/g)) ids.set(Number(m[2]), m[1]);
    for (const m of s.matchAll(/(?:XID|user2ID)=(\d{1,8})/gi)) if (!ids.has(Number(m[1]))) ids.set(Number(m[1]), '');
    const rest = s.replace(/https?:\/\/\S+/gi, ' ').replace(/(?:XID|user2ID)=\d{1,8}/gi, ' ').replace(/[A-Za-z0-9_-]{1,20}\s*\[\d{1,8}\]/g, ' ');
    const nameLike = [...new Set((rest.match(/[A-Za-z0-9_-]+/g) || []).filter(w => /[A-Za-z]/.test(w) && w.length >= 3 && w.length <= 20 && !NOT_NAMES.has(w.toLowerCase())))];
    if (!/[A-Za-z]/.test(rest)) for (const m of rest.matchAll(/\b\d{1,8}\b/g)) ids.set(Number(m[0]), '');
    const named = new Set([...ids.values()].filter(Boolean).map(n => n.toLowerCase()));
    return { ids: [...ids].filter(([id]) => id > 0).map(([id, name]) => ({ id, name })), names: nameLike.filter(n => !named.has(n.toLowerCase())) };
  }
  function peopleFromHtml(html) {
    try {
      const doc = new DOMParser().parseFromString(String(html || ''), 'text/html');
      const out = new Map();
      for (const a of doc.querySelectorAll('a[href]')) {
        const m = /[?&](?:XID|user2ID)=(\d+)/i.exec(a.getAttribute('href') || '');
        if (!m) continue;
        const name = (a.textContent || '').trim().replace(/\s+/g, '');
        if (!out.has(m[1]) || (!out.get(m[1]) && name)) out.set(m[1], /^[A-Za-z0-9_-]{1,20}$/.test(name) ? name : '');
      }
      return [...out].map(([id, name]) => (name ? name + ' [' + id + ']' : 'XID=' + id)).join('\n');
    } catch (e) { return ''; }
  }
  function parseTrip(desc) {
    const s = String(desc || '').trim();
    let m = /^Traveling from (.+?) to (.+?)\.?$/i.exec(s);
    if (m) { const back = m[2].toLowerCase() === 'torn'; return { country: countryOf(back ? m[1] : m[2]), back }; }
    m = /^Traveling to (.+?)\.?$/i.exec(s);
    if (m) return { country: countryOf(m[1]), back: false };
    m = /^Returning to Torn from (.+?)\.?$/i.exec(s);
    if (m) return { country: countryOf(m[1]), back: true };
    return null;
  }
  function placeOf(st, lastIn) {
    st = st || {};
    if (st.state === 'Okay') return { place: 'Torn', kind: 'here' };
    if (st.state === 'Abroad') { const m = /^In (.+?)\.?$/i.exec(String(st.description || '').trim()); return { place: m ? countryOf(m[1]) || m[1] : '', kind: 'here' }; }
    if (st.state === 'Traveling') { const t = parseTrip(st.description); return !t || !t.country ? { place: '', kind: 'flying' } : t.back ? { place: 'Torn', kind: 'flying' } : { place: t.country, kind: 'flying' }; }
    if (st.state === 'Hospital') return { place: hospitalCountry(st.description) || lastIn || 'Torn', kind: 'hospital' };
    if (st.state === 'Jail') return { place: 'Torn', kind: 'jail' };
    return { place: '', kind: 'away' };
  }
  let mine = await store.get('mine', null); // { status, travel, at }
  let mineBusy = false;
  async function mineTick() {
    if (mineBusy || !myKey() || Date.now() < tornPausedUntil || (mine && Date.now() - mine.at < MIN) || !(await leader())) return;
    mineBusy = true;
    try {
      let d;
      try { d = await torn('/user/?selections=basic,travel'); } catch (e) { if (e.code === 16) d = await torn('/user/?selections=basic'); else throw e; }
      const tr = d.travel && d.travel.destination ? { destination: d.travel.destination, departed: (d.travel.departed || 0) * 1000 } : null;
      mine = { status: { state: (d.status || {}).state || '', description: (d.status || {}).description || '' }, travel: tr, at: Date.now() };
      await store.set('mine', mine);
    } catch (e) { /* next minute */ } finally { mineBusy = false; render(); }
  }
  function myTrip() {
    if (!mine) return null;
    const st = mine.status, tr = mine.travel;
    const dest = tr && tr.destination && tr.destination !== 'Torn' ? tr.destination : '';
    let country = '';
    if (st.state === 'Traveling') { const t = parseTrip(st.description); country = dest || (t && !t.back ? t.country : ''); } else if (st.state === 'Abroad') country = dest || placeOf(st).place;
    country = countryOf(country);
    if (!country) return null;
    const departed = tr && tr.departed ? tr.departed : 0;
    return { country, flying: st.state === 'Traveling', key: `${country}|${departed || 'x'}` };
  }

  // ---- The traders for a country (Mentat server's market database) ----
  let traders = await store.get('traders', null); // { country, min, at, items, list, db, script }
  let tradersBusy = false;
  let netError = '';
  async function loadTraders(country, force = false, names = []) {
    if (!session || tradersBusy) return null;
    const t0 = myTrip();
    const ps = t0 && t0.country === country ? pasteFor(t0) : null;
    const ids = ps ? ps.ids.slice(0, PASTE_MAX) : [];
    const asked = new Set((traders && traders.asked) || []);
    if (!force && !names.length && traders && traders.country === country && traders.min === cfg.min && traders.n === cfg.pool && Date.now() - traders.at < 30 * MIN && ids.every(id => asked.has(id))) return null;
    tradersBusy = true;
    try {
      const r = await server('GET', `mugger/traders?country=${encodeURIComponent(country)}&min=${cfg.min}&n=${cfg.pool}${ids.length ? `&ids=${ids.join(',')}` : ''}${names.length ? `&names=${names.map(encodeURIComponent).join(',')}` : ''}`, null, session);
      if (r.status === 401) { await signOut(); return; }
      if (r.status !== 200 || !r.json) { netError = (r.json && r.json.error) || (r.status === 404 ? 'Your Mentat server needs an update for Mugger.' : `The Mentat server said ${r.status}.`); return; }
      traders = { country, min: cfg.min, n: cfg.pool, at: Date.now(), items: r.json.items || {}, list: r.json.traders || [], extra: r.json.extra || [], asked: ids, db: r.json.db || {}, script: r.json.script || {} };
      netError = '';
      await store.set('traders', traders);
      return r.json.named || {};
    } catch (e) { netError = "Couldn't reach the Mentat server."; return null; } finally { tradersBusy = false; render(); }
  }
  const traderById = id => (traders && traders.list.find(t => t.id === id)) || null;

  // ---- Players (kept per trip) ----
  // Players in your country: every cfg.here minutes (1 by default); flying in: 3; the rest of the pool: 20.
  const hereEvery = () => Math.min(3, Math.max(1, Number(cfg.here) || 1)) * MIN;
  // Item market sales of players in your country: every cfg.market minutes (5 by default).
  const marketEvery = () => Math.min(10, Math.max(2, Number(cfg.market) || 5)) * MIN;
  const FLYING_EVERY = 3 * MIN, FAR_EVERY = 20 * MIN, RECORD_EVERY = 12 * 60 * MIN, RETRY = 2 * MIN;
  let players = await store.get('players', {});
  let meta = Object.assign({ me: null, merits: null, types: null, trip: null }, await store.get('meta', {}));
  const savePlayers = () => store.set('players', players);
  const saveMeta = () => store.set('meta', meta);
  const near = (p, country) => !!(p && p.place && p.place.place === country && ['here', 'flying', 'hospital'].includes(p.place.kind));
  // Mugged in this country within 12 hours (the hospital reason said so): protected, so off the list and not checked again until it ends.
  const muggedHere = (p, country) => { const h = p && p.hosp; return !!(h && h.mugged && h.place === country && Date.now() - h.at < PROTECT); };
  // The pasted People list: its own storage key (any tab may paste; the tab doing the checks reads it
  // back before each check). Kept for this trip; once you've landed, only those people are checked.
  let pasteState = await store.get('paste', null);
  const savePaste = () => store.set('paste', pasteState);
  function pasteFor(trip, create = false) {
    if (pasteState && trip && pasteState.trip === trip.key) return pasteState;
    if (!create || !trip) return null;
    return (pasteState = { trip: trip.key, country: trip.country, at: Date.now(), ids: [], names: {}, left: [], lookups: [], notFound: [], lookupRetryAt: 0 });
  }
  const pasteActive = trip => { const p = trip ? pasteFor(trip) : null; return !!(p && !trip.flying && (p.ids.length || p.lookups.length)); };
  function pasteAdd(ps, id, name) {
    id = Number(id);
    if (!Number.isInteger(id) || id <= 0 || ps.ids.includes(id) || ps.ids.length >= PASTE_MAX) return false;
    ps.ids.push(id);
    if (name) ps.names[id] = String(name).slice(0, 30);
    ps.left = ps.left.filter(x => x.id !== id);
    return true;
  }
  const stubTrader = id => ({ id, name: (pasteState && pasteState.names[id]) || '', first: 0, items: [], r30: 0, rc30: 0, small30: 0, dir: { bazaar: '', spec: [], busiest: 0, income: 0, bulk: 0 }, s30: 0, sv30: 0, active: 0, rc30Here: 0, linked: false, ev: [], partsHere: {}, partsAll: {}, none: true });
  const traderAny = id => traderById(id) || (traders && (traders.extra || []).find(t => t.id === id)) || stubTrader(id);
  // Who is checked and listed: the best traders, or once you've landed, the pasted list.
  function source() {
    const trip = myTrip();
    if (!traders) return [];
    if (!trip || traders.country !== trip.country || !pasteActive(trip)) return traders.list;
    return pasteFor(trip).ids.map(traderAny);
  }
  const pool = () => (traders && myTrip() && traders.country === myTrip().country ? source().map(t => t.id) : []);

  function nextJob(now, trip) {
    if (!meta.me || meta.me.trip !== trip.key) return { kind: 'mystats' };
    if (cfg.looting === 'auto' && (!meta.merits || now - meta.merits.at >= 24 * 60 * MIN) && !(meta.merits && meta.merits.retryAt > now)) return { kind: 'merits' };
    if ((!meta.types || !meta.types.cruise || now - meta.types.at >= 7 * 24 * 60 * MIN) && !(meta.types && meta.types.retryAt > now)) return { kind: 'types' };
    const ps = pasteFor(trip);
    if (ps && ps.lookups.length && !(ps.lookupRetryAt > now)) return { kind: 'lookup', name: ps.lookups[0] };
    let best = null;
    const consider = (pri, job) => { if (!best || pri < best.pri) best = { ...job, pri }; };
    for (const id of pool()) {
      const p = players[id];
      if (p && p.retryAt > now) continue;
      if (muggedHere(p, trip.country)) continue; // mug protected: not checked again for now
      if (p && p.invalid && now - p.at < 24 * 60 * MIN) continue;
      const checked = p && p.tripKey === trip.key ? p.at : 0;
      if (!checked) { consider(-3e12, { kind: 'profile', id }); continue; }
      const isNear = near(p, trip.country);
      if (isNear) {
        if (!p.job || p.job.trip !== trip.key) { consider(-2e12, { kind: 'job', id }); continue; }
        if (!p.rec || now - p.rec.at >= RECORD_EVERY) { consider(-2e12 + 1, { kind: 'record', id }); continue; }
        if (p.place.kind === 'here' && (!p.trade || now - p.trade.at >= marketEvery())) consider(p.trade ? -(now - p.trade.at - marketEvery()) : -1e12, { kind: 'trading', id }); // as overdue as a location check
      }
      const every = !isNear ? FAR_EVERY : p.place.kind === 'flying' ? FLYING_EVERY : hereEvery();
      const due = every - (now - checked);
      if (due <= 0) consider(due, { kind: 'profile', id });
    }
    return best;
  }
  const player = id => players[id] || (players[id] = { id });
  const soft = (p, e) => { if (e.kind === 'soft') { p.invalid = true; p.at = Date.now(); } else p.retryAt = Date.now() + RETRY; };

  async function runJob(job, trip) {
    const now = Date.now();
    try {
      if (job.kind === 'mystats') {
        try {
          const d = await torn('/v2/user/battlestats');
          const b = d.battlestats || {};
          const v = k => (b[k] && b[k].value) || 0;
          meta.me = { trip: trip.key, total: Number(b.total) || v('strength') + v('defense') + v('speed') + v('dexterity'), at: now };
        } catch (e) { meta.me = { trip: trip.key, denied: e.code === 16, at: now }; }
      } else if (job.kind === 'merits') {
        try {
          const mineM = await torn('/v2/user/merits');
          const all = await torn('/v2/torn/merits');
          const def = ((all && all.merits) || []).find(m => /masterful looting/i.test(m.name || ''));
          const up = def && ((mineM.merits && mineM.merits.upgrades) || []).find(u => u.id === def.id);
          meta.merits = { looting: def ? (up ? up.level : 0) : null, at: now };
        } catch (e) { meta.merits = { ...(meta.merits || { looting: null, at: 0 }), retryAt: now + (e.kind === 'soft' ? 24 * 60 * MIN : RETRY) }; }
      } else if (job.kind === 'types') {
        try {
          const d = await torn('/v2/torn/companies');
          const ids = [], cruise = [];
          const walk = (o, key) => {
            if (!o || typeof o !== 'object') return;
            if (Array.isArray(o)) { o.forEach(x => walk(x)); return; }
            if (typeof o.name === 'string' && /clothing/i.test(o.name)) { const id = Number(o.id ?? key); if (Number.isFinite(id)) ids.push(id); }
            if (typeof o.name === 'string' && /cruise/i.test(o.name)) { const id = Number(o.id ?? key); if (Number.isFinite(id)) cruise.push(id); }
            for (const [k, v] of Object.entries(o)) if (v && typeof v === 'object') walk(v, k);
          };
          walk(d);
          meta.types = { clothing: [...new Set(ids)], cruise: [...new Set(cruise)], at: now };
        } catch (e) { meta.types = { ...(meta.types || { clothing: [], at: 0 }), retryAt: now + RETRY }; }
      } else if (job.kind === 'lookup') {
        const ps = pasteFor(trip);
        if (ps) {
          const drop = () => { ps.lookups = ps.lookups.filter(n => n !== job.name); };
          try {
            const d = await torn('/v2/user/search?name=' + encodeURIComponent(job.name));
            const hit = (d.search || []).find(u => u && String(u.name || '').toLowerCase() === job.name.toLowerCase());
            drop();
            if (hit) pasteAdd(ps, hit.id, hit.name); else ps.notFound = [...ps.notFound, job.name].slice(-60);
          } catch (e) { if (e.kind === 'soft') { drop(); ps.notFound = [...ps.notFound, job.name].slice(-60); } else ps.lookupRetryAt = now + RETRY; }
          await savePaste();
          if (ps.ids.length) loadTraders(trip.country);
        }
      } else if (job.kind === 'profile') {
        const p = player(job.id);
        try {
          const d = await torn(`/user/${job.id}?selections=profile`);
          const st = d.status || {};
          const same = p.tripKey === trip.key;
          const prev = same ? p.place : null, prevAt = same ? p.at : 0;
          const wasHosp = !!(p.place && p.place.kind === 'hospital');
          if (!same) Object.assign(p, { tripKey: trip.key, awaySince: 0, trade0: null, trade: null, flight: null });
          Object.assign(p, {
            name: d.name || p.name || '', level: d.level || 0, age: d.age || 0, invalid: false, retryAt: 0,
            faction: d.faction && d.faction.faction_name ? d.faction.faction_name : '',
            status: { state: st.state || '', description: st.description || '', details: String(st.details || '').replace(/<[^>]*>/g, ''), until: (st.until || 0) * 1000 },
            life: d.life ? [d.life.current, d.life.maximum] : null,
            last: d.last_action ? { status: d.last_action.status || '', at: (d.last_action.timestamp || 0) * 1000 } : null,
          });
          const inCountry = st.state === 'Abroad' ? placeOf(st).place : '';
          if (inCountry) p.lastIn = inCountry; else if (st.state !== 'Hospital') p.lastIn = '';
          p.place = placeOf(st, p.lastIn);
          // Flying: the departure is caught when they switch to Traveling between two checks.
          if (st.state === 'Traveling') {
            if (!p.flight || p.flight.desc !== st.description) {
              const seen = prev && prev.kind !== 'flying' && prevAt && now - prevAt < 25 * MIN;
              p.flight = { desc: st.description, departLo: seen ? prevAt : 0, departHi: now };
            }
          } else p.flight = null;
          const away = p.place.place && p.place.place !== 'Torn';
          if (away && !p.awaySince) p.awaySince = p.flight && p.flight.departLo ? Math.round((p.flight.departLo + p.flight.departHi) / 2) : now;
          if (!away) p.awaySince = 0;
          // In hospital abroad: maybe mugged, so flagged for 12 hours from the first sighting (kept across trips).
          if (p.place.kind === 'hospital' && p.place.place && p.place.place !== 'Torn' && BY_PLAYER.test(p.status.details)) {
            const h = p.hosp, cont = wasHosp && h && h.place === p.place.place && now - h.seen < SAME_STAY;
            p.hosp = { at: cont ? h.at : now, seen: now, place: p.place.place, text: p.status.details, mugged: /mugg/i.test(p.status.details) || !!(cont && h.mugged) };
          }
          delete p.mugged;
          p.at = now;
          // On the pasted list but no longer in (or flying to) this country: off the list.
          const ps = pasteFor(trip);
          if (ps && ps.ids.includes(Number(job.id)) && !near(p, trip.country)) {
            ps.ids = ps.ids.filter(x => x !== Number(job.id));
            ps.left = [{ id: Number(job.id), name: p.name, at: now, to: p.place.place || '' }, ...ps.left].slice(0, 30);
            await savePaste();
          }
        } catch (e) {
          soft(p, e);
          const ps = pasteFor(trip);
          if (e.kind === 'soft' && ps && ps.ids.includes(Number(job.id))) { ps.ids = ps.ids.filter(x => x !== Number(job.id)); ps.notFound = [...ps.notFound, '#' + job.id].slice(-60); await savePaste(); }
        }
      } else if (job.kind === 'job') {
        const p = player(job.id);
        try {
          const d = await torn(`/v2/user/${job.id}/job`);
          const j = d.job || null;
          const types = (meta.types && meta.types.clothing) || [];
          p.job = j && j.type === 'company' ? { trip: trip.key, company: j.name || '', rating: j.rating || 0, clothing: types.includes(Number(j.type_id)), cruise: ((meta.types && meta.types.cruise) || []).includes(Number(j.type_id)) } : { trip: trip.key, company: '', rating: 0, clothing: false };
        } catch (e) { if (e.kind === 'soft') p.job = { trip: trip.key, error: true }; else p.retryAt = now + RETRY; }
      } else if (job.kind === 'record') {
        const p = player(job.id);
        try {
          const d = await torn(`/v2/user/${job.id}/personalstats?cat=travel`);
          const t = (d.personalstats && d.personalstats.travel) || {};
          const per = { Mexico: t.mexico, 'Cayman Islands': t.cayman_islands, Canada: t.canada, Hawaii: t.hawaii, 'United Kingdom': t.united_kingdom, Argentina: t.argentina, Switzerland: t.switzerland, Japan: t.japan, China: t.china, UAE: t.united_arab_emirates, 'South Africa': t.south_africa };
          const rec = { at: now, trips: Number(t.total) || 0, items: Number(t.items_bought) || 0, lost: Number(t.defends_lost) || 0, favourite: '', week: null, per: {} };
          for (const [c, v] of Object.entries(per)) rec.per[c] = Number(v) || 0;
          let n = 0;
          for (const [c, v] of Object.entries(per)) if ((Number(v) || 0) > n) { n = Number(v); rec.favourite = c; }
          try {
            const w = await torn(`/v2/user/${job.id}/personalstats?stat=itemsboughtabroad,traveltimes&timestamp=${Math.floor((now - 7 * 24 * 60 * MIN) / SEC)}`);
            const then = {};
            for (const x of w.personalstats || []) if (x && x.name) then[x.name] = Number(x.value) || 0;
            if ('itemsboughtabroad' in then || 'traveltimes' in then) rec.week = { items: Math.max(0, rec.items - (then.itemsboughtabroad || 0)), trips: Math.max(0, rec.trips - (then.traveltimes || 0)) };
          } catch (e) { /* the pace stays unknown */ }
          // Fights lost abroad since yesterday (kept by day, without the country): a mug is one.
          try {
            const ts = Math.floor((now - DAY) / SEC);
            const y = await torn(`/v2/user/${job.id}/personalstats?stat=defendslostabroad&timestamp=${ts}`);
            const x = (y.personalstats || []).find(z => z && z.name === 'defendslostabroad');
            if (x) rec.lostAbroad = { n: Math.max(0, rec.lost - (Number(x.value) || 0)), since: ts * SEC };
          } catch (e) { /* unknown */ }
          p.rec = rec;
        } catch (e) { if (e.kind === 'soft') p.rec = { at: now, error: true }; else p.retryAt = now + RETRY; }
      } else if (job.kind === 'trading') {
        const p = player(job.id);
        try {
          const d = await torn(`/v2/user/${job.id}/personalstats?cat=trading`);
          const im = ((d.personalstats && d.personalstats.trading) || {}).item_market || {};
          const r = { at: now, revenue: Number(im.revenue) || 0, fees: Number(im.fees) || 0 };
          if (!p.trade0 || p.trade0.trip !== trip.key) p.trade0 = { ...r, trip: trip.key };
          p.trade = r;
        } catch (e) { if (e.kind === 'soft') p.trade = { at: now, error: true }; else p.retryAt = now + RETRY; }
      }
    } finally {
      await savePlayers();
      await saveMeta();
    }
  }

  let jobBusy = false;
  async function tripTick() {
    const trip = myTrip();
    if (!session) return;
    if (!trip) { await loadTraders(cfg.preview); return; }
    if (!meta.trip || meta.trip.key !== trip.key) { meta.trip = { ...trip, startedAt: Date.now() }; await saveMeta(); pruneOld(); }
    if (jobBusy || document.hidden || !canCall() || !(await leader())) { await loadTraders(trip.country); return; }
    pasteState = await store.get('paste', null);
    await loadTraders(trip.country);
    const job = nextJob(Date.now(), trip);
    if (!job) return;
    jobBusy = true;
    try { await runJob(job, trip); } finally { jobBusy = false; render(); }
  }
  function pruneOld() {
    const keep = new Set(pool().map(String));
    for (const [id, p] of Object.entries(players)) if (!keep.has(id) && Date.now() - (p.at || 0) > 14 * 24 * 60 * MIN) delete players[id];
    savePlayers();
  }

  // ---- Bazaar sales near you: Weav3r, every 5 minutes, the items those players sell ----
  let live = await store.get('live', {}); // pid -> { items: { id: [q, p, upd, seen] }, ev: [[t, id, dq, p, gone]] }
  const watchAt = {};
  let watchBusy = false;
  async function watchTick() {
    const trip = myTrip();
    if (!trip || watchBusy || document.hidden || !traders || traders.country !== trip.country || !(await leader())) return;
    const want = new Map();
    for (const t of source()) {
      if (!near(players[t.id], trip.country) || players[t.id].tripKey !== trip.key) continue;
      for (const [id, q] of t.items.slice(0, 2)) { const m = traders.items[id]; if (m && q > TRADE_QTY) want.set(id, (want.get(id) || 0) + q * m[1]); }
    }
    const ids = [...want.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(e => e[0]).filter(id => Date.now() - (watchAt[id] || 0) >= 5 * MIN);
    if (!ids.length) return;
    watchBusy = true;
    try {
      for (const id of ids) {
        watchAt[id] = Date.now();
        const seen = new Set();
        let complete = false;
        // One plain request: the cheapest 100 bazaars with sellers (Weav3r answers any ?page= query with an
        // anonymous top 10 since 2026-11-25); a longer list is partial and never marks anyone sold out.
        {
          const r = await xhr('GET', `https://weav3r.dev/api/marketplace/${id}`, { Accept: 'application/json' });
          const d = r.status === 200 ? parse(r.text) : null;
          const all = d && Array.isArray(d.listings) ? d.listings : [];
          for (const l of all) {
            const pid = Number(l.player_id);
            if (!pid) continue;
            seen.add(pid);
            const t = traderById(pid);
            const lv = live[pid] || (live[pid] = { items: {}, ev: [] });
            const base = t && t.items.find(x => x[0] === id);
            const prev = lv.items[id] || (base ? [base[1], base[2], base[3]] : null);
            const q = Number(l.quantity) || 0, pr = Number(l.price) || 0, upd = (Number(l.content_updated) || 0) * 1000;
            if (prev && prev[0] !== q) lv.ev.push([upd > (prev[2] || 0) ? upd : Date.now(), id, q - prev[0], pr || prev[1], 0]);
            lv.items[id] = [q, pr, upd, Date.now()];
          }
          complete = !!d && d.has_more === false && all.every(l => Number(l.player_id) > 0);
        }
        if (complete) {
          for (const t of source()) {
            const had = (live[t.id] && live[t.id].items[id]) || (() => { const b = t.items.find(x => x[0] === id); return b ? [b[1], b[2], b[3]] : null; })();
            if (!had || seen.has(t.id) || !(had[0] > 0)) continue;
            const lv = live[t.id] || (live[t.id] = { items: {}, ev: [] });
            if (lv.ev.some(e => e[1] === id && e[4])) continue;
            lv.ev.push([Date.now(), id, -had[0], had[1], 1]);
            delete lv.items[id];
          }
        }
        await new Promise(res => setTimeout(res, 3500));
      }
      for (const [pid, lv] of Object.entries(live)) { lv.ev = lv.ev.filter(e => Date.now() - e[0] < 3 * 24 * 60 * MIN); if (!lv.ev.length && !traderById(Number(pid))) delete live[pid]; }
      await store.set('live', live);
    } catch (e) { /* next time */ } finally { watchBusy = false; render(); }
  }

  // ---- FFScouter (optional), once per player per trip ----
  const FFS = 'https://ffscouter.com/api/v1';
  const FFS_KEY_ERRORS = { 2: 'invalid key format', 6: 'key not registered at ffscouter.com', 4010: 'your account is banned from FFScouter', 4011: 'your faction is banned from FFScouter' };
  const ffs = Object.assign({ on: false, pda: false, premium: false, error: '' }, await store.get('ffs', {}));
  let ffsKey = ffs.on ? (ffs.pda ? pdaKey : await store.get('ffsKey', '')) : '';
  let ffsStats = await store.get('ffsStats', {}); // id -> { ff, bs, bsHuman, at, trip }
  let ffsBusy = false, ffsPausedUntil = 0;
  async function ffsCall(path, params) {
    const r = await xhr('GET', `${FFS}/${path}?${new URLSearchParams(params)}`, { Accept: 'application/json' });
    const d = parse(r.text);
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
    return true;
  }
  async function ffsOff(reason = '') {
    Object.assign(ffs, { on: false, pda: false, error: reason });
    ffsKey = ''; ffsStats = {};
    await store.set('ffsKey', '');
    await store.set('ffs', ffs);
    await store.set('ffsStats', {});
  }
  async function ffsTick() {
    const trip = myTrip();
    if (!trip || !ffs.on || !ffsKey || ffsBusy || Date.now() < ffsPausedUntil || !(await leader())) return;
    const need = pool().filter(id => { const p = players[id]; const x = ffsStats[id]; return p && p.tripKey === trip.key && near(p, trip.country) && !muggedHere(p, trip.country) && !(x && (x.trip === trip.key || Date.now() - x.at < 6 * 60 * MIN)); });
    if (!need.length) return;
    ffsBusy = true;
    try {
      const data = await ffsCall('get-stats', { key: ffsKey, targets: need.slice(0, 205).join(',') });
      for (const p of data || []) ffsStats[p.player_id] = { ff: p.fair_fight ?? null, bs: p.bs_estimate ?? null, bsHuman: p.bs_estimate_human || '', at: Date.now(), trip: trip.key };
      for (const id of need.slice(0, 205)) if (!ffsStats[id]) ffsStats[id] = { ff: null, bs: null, at: Date.now(), trip: trip.key };
      for (const id of Object.keys(ffsStats)) if (Date.now() - ffsStats[id].at > 24 * 60 * MIN) delete ffsStats[id];
      await store.set('ffsStats', ffsStats);
      ffs.error = '';
    } catch (e) {
      if (e.code in FFS_KEY_ERRORS) await ffsOff(`FFScouter turned off: ${FFS_KEY_ERRORS[e.code]}.`);
      else { const wait = e.code === 21 ? Math.max(15, e.retry || 60) : 300; ffsPausedUntil = Date.now() + wait * SEC; ffs.error = `FFScouter: ${e.message}. Trying again in ${Math.ceil(wait / 60)} min.`; }
    } finally { ffsBusy = false; render(); }
  }

  // ---- Working it out (as Mentat's Mugger tab) ----
  const looting = () => (cfg.looting === 'auto' ? (meta.merits && Number.isFinite(meta.merits.looting) ? meta.merits.looting : 0) : Math.min(10, Math.max(0, Number(cfg.looting) || 0)));
  const mult = () => 1 + looting() * 0.05 + (Number(cfg.plunder) || 0) / 100;
  const clamp = x => Math.max(0, Math.min(1, Number.isFinite(x) ? x : 0));
  const log10 = x => (x > 0 ? Math.log10(x) : 0);
  function events(t) {
    const base = t.ev || [];
    const lv = live[t.id];
    const extra = lv ? lv.ev.filter(e => !base.some(b => b[1] === e[1] && b[2] === e[2] && Math.abs(b[0] - e[0]) < 30 * MIN)) : [];
    return [...base, ...extra].sort((a, b) => a[0] - b[0]);
  }
  // Only more than 5 of an item counts as trading (selling one is no sign of trips; the user's rule,
  // 2026-11-24). Smaller ones are still shown, marked as not counted. Sales of any size still count as
  // cash on hand.
  const TRADE_QTY = 5;
  // Their abroad items now: the market database's listings with this trip's Weav3r readings on top.
  function itemsOf(t) {
    const lv = live[t.id];
    const map = new Map(t.items.map(x => [x[0], [x[1], x[2], x[3]]]));
    if (lv) for (const [id, v] of Object.entries(lv.items)) map.set(Number(id), v);
    const out = [];
    for (const [id, v] of map) {
      const m = traders.items[id];
      if (!m || !(v[0] > 0) || m[1] < cfg.min) continue;
      out.push({ id, q: v[0], price: v[1], name: m[0], cost: m[1], countries: m[2] || [], small: v[0] <= TRADE_QTY });
    }
    return out.sort((a, b) => b.q * b.cost - a.q * a.cost);
  }
  // Their carrying capacity, estimated (the user's rules, 2026-11-25): 15 always (5 base + 10 airstrip,
  // WLT or Business Class Ticket), faction excursions +10 (other factions' upgrades aren't in the API:
  // assumed maxed), a large suitcase +3 (the standard 28), a Cruise Line job +2 from 3★ / +5 at 10★. No
  // Smuggling book (unlikely); Flower/Toy Shop bonuses are for flowers and plushies only.
  function capacityOf(p) {
    const parts = [[15, 'base + airstrip/WLT/ticket'], [10, 'faction excursions (assumed maxed)'], [3, 'large suitcase (assumed)']];
    const j = p && p.job && !p.job.error ? p.job : null;
    const cruise = j && j.cruise ? (j.rating >= 10 ? 5 : j.rating >= 3 ? 2 : 0) : 0;
    if (cruise) parts.push([cruise, j.rating + '★ Cruise Line']);
    return { n: parts.reduce((a, x) => a + x[0], 0), text: parts.map(x => x[0] + ' ' + x[1]).join(' + '), jobKnown: !!j };
  }
  // Items a trip: a full load (the user's rule): the estimate, or their own average a trip if higher.
  function perTrip(rec, p = null) {
    let own = null;
    if (rec && rec.week && rec.week.trips > 0 && rec.week.items > 0) own = { n: rec.week.items / rec.week.trips, basis: 'their last week' };
    else if (rec && rec.trips > 0 && rec.items > 0) own = { n: rec.items / rec.trips, basis: 'their average' };
    const cap = capacityOf(p);
    if (own && own.n > cap.n) return { n: own.n, basis: 'a full load (' + own.basis + ': ' + Math.round(own.n) + ' a trip, above the ' + cap.n + ' estimated)' };
    return { n: cap.n, basis: 'a full load (' + cap.n + ' = ' + cap.text + (cap.jobKnown ? '' : '; job not checked yet') + ')' };
  }
  // What they trade from a country: listed (more than 5 at once) or restocked in the last 90 days (the
  // server's t.hist), listed now, or their bazaar's speciality (Torn's directory). Most first.
  function tradesFrom(t, items, specItems, country) {
    const out = new Map();
    for (const [id, q] of t.hist || []) { const m = traders.items[id]; if (m && (m[2] || []).includes(country)) out.set(id, { id, q, name: m[0], cost: m[1], countries: m[2] || [] }); }
    for (const x of [...items, ...specItems]) if (x.countries.includes(country) && !out.has(x.id)) out.set(x.id, x);
    return [...out.values()].sort((a, b) => b.q - a.q);
  }
  // What a trip takes: a full load × what they've sold most from this country. No record of that: not known.
  function tripCash(local, rec, p) {
    if (!local.length) return null;
    const staple = local[0];
    const pt = perTrip(rec, p);
    return { amount: pt.n * staple.cost, items: pt.n, basis: pt.basis, name: staple.name, cost: staple.cost, why: 'what they have sold most from there' };
  }
  function row(t, country, isLive) {
    const p = players[t.id] || null;
    const rec = p && p.rec && !p.rec.error ? p.rec : null;
    const all = itemsOf(t);
    const items = all.filter(i => !i.small); // trading evidence: more than 5 of an item
    // No listings seen: the item their bazaar specialises in (Torn's bazaar directory) stands in.
    const specItems = ((t.dir && t.dir.spec) || []).map(([id, customers]) => { const m = traders.items[id]; return m ? { id, q: customers, name: m[0], cost: m[1], countries: m[2] || [] } : null; }).filter(Boolean);
    const local = t.none ? [] : tradesFrom(t, items, specItems, country);
    const tc = tripCash(local, rec, p); // not a trader: no trip money
    const unknown = !t.none && !local.length ? 'No record in the market database of them selling anything from ' + country + ", so what they buy there (and the money it takes) isn't known." : '';
    let cash = null, take = null;
    if (isLive && p && p.place) {
      cash = { trip: 0, bazaar: 0, market: 0, total: 0, since: p.awaySince || 0 };
      if (p.place.kind === 'flying' && tc) cash.trip = tc.amount;
      if (cash.since) for (const e of events(t)) { if (e[0] >= cash.since && e[2] < 0) { const m = traders.items[e[1]]; cash.bazaar += -e[2] * Math.min(e[3], m ? m[1] * 3 : e[3]); } }
      if (p.trade0 && p.trade && !p.trade.error) cash.market = Math.max(0, (p.trade.revenue - p.trade0.revenue) - (p.trade.fees - p.trade0.fees));
      cash.total = cash.trip + cash.bazaar + cash.market;
      const clothing = !!(p.job && p.job.clothing && p.job.rating >= 7);
      const k = mult() * (clothing ? 0.25 : 1);
      if (cash.total > 0) take = { lo: cash.total * 0.05 * k, hi: cash.total * 0.10 * k, pctLo: 0.05 * k, pctHi: 0.10 * k, clothing };
    }
    // Two scores (as the app's muggerdb.js scores): for this country (its items) and overall (every abroad item).
    const tripsHere = rec && rec.per ? rec.per[country] || 0 : 0;
    const share = rec && rec.trips > 0 ? tripsHere / rec.trips : 0;
    const cashPart = cash ? 20 * clamp((log10(cash.total) - 6) / 3) : 0;
    const parts = { ...(t.partsHere || t.parts || {}) };
    parts.fit = parts.fit || (rec && rec.favourite === country ? 10 : tripsHere > 0 ? 5 : 0);
    parts.travel = rec && rec.week ? 15 * clamp(log10(1 + rec.week.items * share) / log10(1501)) : 0;
    parts.cash = cashPart;
    const total = Math.round(Object.values(parts).reduce((a, x) => a + x, 0));
    const partsAll = { ...(t.partsAll || {}) };
    partsAll.travel = rec && rec.week ? 15 * clamp(log10(1 + rec.week.items) / log10(1501)) : 0;
    partsAll.cash = cashPart;
    const overall = Math.round(Object.values(partsAll).reduce((a, x) => a + x, 0) * 100 / 85);
    const restock = events(t).filter(e => e[2] > TRADE_QTY).slice(-1)[0];
    const pt = perTrip(rec, p);
    return { t, p, rec, items, all, tc, unknown, cash, take, total, overall, parts, partsAll, restock, restockTrips: restock && pt ? restock[2] / pt.n : null };
  }

  // ---- Shadow root, styles (as the war board's) ----
  const host = document.createElement('div');
  host.id = 'mentat-mugger';
  host.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483000;';
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `<style>
    :host { all: initial; }
    * { box-sizing: border-box; }
    .fab { position: fixed; width: 46px; height: 46px; border-radius: 50%; background: #1a1714; border: 2px solid #b07a22; pointer-events: auto;
      display: flex; align-items: center; justify-content: center; touch-action: none; user-select: none; -webkit-user-select: none; cursor: pointer;
      box-shadow: 0 3px 10px rgba(0,0,0,.55); -webkit-tap-highlight-color: transparent; font: 600 11px/1 -apple-system, "Segoe UI", Roboto, sans-serif; }
    .fab svg { width: 24px; height: 24px; fill: #e9cf9f; pointer-events: none; }
    .fab .t { position: absolute; top: 36px; left: 50%; transform: translateX(-50%); padding: 2px 6px; border-radius: 9px; white-space: nowrap;
      background: #2c2924; border: 1.5px solid #4a4339; color: #f6f1e9; font-size: 11px; line-height: 14px; font-variant-numeric: tabular-nums; }
    .fab .t:empty { display: none; }
    .fab.ok .t { border-color: #57a64a; color: #9fde8e; }
    .fab.upd::after { content: ''; position: absolute; top: -2px; right: -2px; width: 12px; height: 12px; border-radius: 50%; background: #4ea1e8; border: 2px solid #1a1714; }
    .panel { position: fixed; right: 12px; top: 56px; width: 460px; max-height: calc(100vh - 72px); display: flex; flex-direction: column; pointer-events: auto;
      background: #1e1c19; color: #f6f1e9; border: 1px solid #5a5145; border-radius: 12px; box-shadow: 0 12px 40px rgba(0,0,0,.6);
      font: 14px/1.4 -apple-system, "Segoe UI", Roboto, sans-serif; overflow: hidden; }
    @media (max-width: 640px) { .panel { left: 8px; right: 8px; top: auto; bottom: 8px; width: auto; max-height: 80vh; } }
    .panel[hidden] { display: none; }
    .head { padding: 10px 12px 8px; border-bottom: 1px solid #3a342c; background: #23201c; }
    .row1 { display: flex; align-items: center; gap: 8px; cursor: move; touch-action: none; user-select: none; -webkit-user-select: none; }
    .grip { color: #a99d8c; font-size: 16px; line-height: 1; flex: none; }
    .panel.dragging { opacity: .92; }
    .title { font-weight: 700; color: #e9cf9f; font-size: 15px; flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .iconbtn { width: 34px; height: 34px; border-radius: 8px; border: 1px solid #6b6052; background: #2c2924; color: #f6f1e9; font: 600 16px/1 inherit; cursor: pointer; flex: none; }
    .wip { margin-top: 6px; padding: 4px 8px; border: 1px dashed #e0912d; border-radius: 6px; background: #3a2a10; color: #ffcf8f; font-weight: 700; text-align: center; font-size: 12.5px; letter-spacing: .04em; }
    .trip { margin-top: 6px; font-size: 13px; color: #ded4c6; }
    .body { overflow-y: auto; padding: 10px 12px 14px; -webkit-overflow-scrolling: touch; }
    .note { padding: 8px 10px; border-radius: 8px; background: #2c2924; border: 1px solid #5a5145; margin: 0 0 10px; }
    .note.update { border-color: #4ea1e8; background: #16263a; }
    .ok { color: #9fde8e; } .warn { color: #ffcf8f; } .bad { color: #ff8a84; } .info { color: #9cc9f5; } .muted { color: #c4b8a8; }
    .small { font-size: 12.5px; color: #c4b8a8; }
    select, input { padding: 7px 8px; border-radius: 8px; border: 1px solid #6b6052; background: #15130f; color: #f6f1e9; font: 14px inherit; font-family: inherit; }
    input { flex: 1; min-width: 0; }
    .btn { padding: 7px 10px; border-radius: 8px; border: 1px solid #6b6052; background: #2c2924; color: #f6f1e9; font: 600 13px inherit; font-family: inherit; cursor: pointer; text-decoration: none; display: inline-block; white-space: nowrap; }
    .btn.primary { background: #9a6a1f; border-color: #c99a4a; color: #fff; }
    .btn.danger { border-color: #c4554e; }
    .join { display: flex; gap: 8px; margin-top: 6px; flex-wrap: wrap; }
    h3 { font-size: 13px; color: #e9cf9f; margin: 14px 0 4px; font-weight: 700; text-transform: uppercase; letter-spacing: .04em; }
    .paste { margin: 0 0 8px; }
    .paste textarea { width: 100%; box-sizing: border-box; min-height: 40px; resize: vertical; font: inherit; font-size: 12px; background: inherit; color: inherit; border: 1px solid #555; border-radius: 6px; padding: 4px 6px; }
    .opts { display: flex; gap: 6px 12px; flex-wrap: wrap; align-items: center; margin-bottom: 8px; font-size: 13px; }
    .opts label { display: inline-flex; align-items: center; gap: 6px; }
    .opts select { padding: 5px 6px; font-size: 13px; }
    .opts input[type=checkbox] { width: 18px; height: 18px; accent-color: #b07a22; flex: none; }
    ul.list { list-style: none; margin: 0; padding: 0; }
    .list li { padding: 9px 0; border-bottom: 1px solid #2f2c27; }
    .list .top { display: flex; gap: 8px; align-items: baseline; flex-wrap: wrap; }
    .list .nm { color: #f6f1e9; font-weight: 600; text-decoration: none; }
    .list .sc { margin-left: auto; }
    .list .line { margin-top: 3px; font-size: 13px; display: flex; gap: 6px 10px; flex-wrap: wrap; align-items: center; }
    .list .acts { margin-top: 6px; display: flex; gap: 6px; flex-wrap: wrap; }
    .pill { display: inline-block; padding: 1px 7px; border-radius: 9px; font-size: 11.5px; line-height: 16px; white-space: nowrap; background: #3a352e; color: #f6f1e9; font-variant-numeric: tabular-nums; }
    .pill.ok { background: #233a1f; color: #a8e39a; } .pill.warn { background: #3f2f14; color: #ffcf8f; } .pill.bad { background: #45201d; color: #ff9d96; } .pill.info { background: #1d2c3d; color: #9cc9f5; }
    .big { font-weight: 700; font-size: 15px; font-variant-numeric: tabular-nums; }
    .det { margin-top: 6px; padding: 8px; border-radius: 8px; background: #16140f; font-size: 12.5px; color: #ded4c6; }
    .det table { width: 100%; border-collapse: collapse; margin: 4px 0; }
    .det td, .det th { text-align: left; padding: 2px 4px; border-bottom: 1px solid #2f2c27; font-weight: 400; }
    .det th { color: #e9cf9f; }
    .tos { width: 100%; border-collapse: collapse; font-size: 12.5px; margin: 8px 0; }
    .tos th, .tos td { text-align: left; vertical-align: top; padding: 4px 6px; border-bottom: 1px solid #3a342c; }
    .tos th { color: #e9cf9f; width: 38%; font-weight: 600; }
    .err { color: #ff8a84; margin: 6px 0; }
    .settings label.chk { display: flex; align-items: center; gap: 10px; padding: 8px 0; border-bottom: 1px solid #2f2c27; }
    .dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 4px; vertical-align: 1px; background: #8a8178; }
    .dot.Online { background: #6fdc5f; } .dot.Idle { background: #f0b44c; }
    a { color: #e9cf9f; }
  </style>`;
  document.documentElement.appendChild(host);
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const money = n => { n = Number(n) || 0; const a = Math.abs(n); return a >= 1e9 ? `$${(a / 1e9).toFixed(a >= 1e10 ? 1 : 2)}B` : a >= 1e6 ? `$${(a / 1e6).toFixed(a >= 1e7 ? 1 : 2)}M` : a >= 1e4 ? `$${Math.round(a / 1e3)}K` : `$${Math.round(a).toLocaleString('en-US')}`; };
  const num = n => Number(n || 0).toLocaleString('en-US');
  const pad = n => String(n).padStart(2, '0');
  const tct = ms => { const d = new Date(ms); return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`; };
  const ago = ms => { const s = Math.max(0, Math.round((Date.now() - ms) / SEC)); return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.floor(s / 60)}m ago` : s < 86400 ? `${Math.floor(s / 3600)}h ago` : `${Math.floor(s / 86400)}d ago`; };
  const plural = (n, w) => `${num(n)} ${w}${Number(n) === 1 ? '' : 's'}`;
  const pct = x => `${(x * 100).toFixed(x < 0.1 ? 1 : 0)}%`;

  // ---- The button (drag to move; a tap opens the panel) ----
  const MARK_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill-rule="evenodd" d="M9 2h6l-1.6 3.2C17.4 6.6 20 10.6 20 15c0 4.4-3.6 7-8 7s-8-2.6-8-7c0-4.4 2.6-8.4 6.6-9.8zm2.2 8v1.1c-1.3.3-2.2 1.2-2.2 2.4 0 1.4 1.1 2 2.6 2.4 1 .3 1.3.5 1.3.9 0 .4-.4.7-1.1.7-.8 0-1.3-.3-1.5-.9l-1.6.5c.3 1 1.2 1.7 2.5 1.9V20h1.6v-1.1c1.4-.3 2.3-1.2 2.3-2.4 0-1.5-1.1-2.1-2.6-2.5-1-.3-1.3-.5-1.3-.8 0-.4.4-.6 1-.6.6 0 1.1.3 1.3.8l1.5-.6c-.3-.9-1.1-1.5-2.2-1.7V10z"/></svg>';
  const fab = document.createElement('div');
  fab.className = 'fab';
  fab.setAttribute('role', 'button');
  fab.setAttribute('aria-label', 'Mentat Mugger');
  fab.innerHTML = `${MARK_SVG}<span class="t"></span>`;
  root.appendChild(fab);
  const clampX = x => Math.max(4, Math.min(window.innerWidth - 50, x));
  const clampY = y => Math.max(4, Math.min(window.innerHeight - 66, y));
  function placeFab() {
    const p = cfg.pos;
    fab.style.left = `${clampX(p ? p.x * window.innerWidth : window.innerWidth - 54)}px`;
    fab.style.top = `${clampY(p ? p.y * window.innerHeight : (isPda ? 230 : 170))}px`; // below the war board's button
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
    // A tap's follow-up "click" would land in the panel when it opens over the button (iPad): cancel it.
    fab.addEventListener('touchend', e => { if (e.cancelable) e.preventDefault(); }, { passive: false });
    fab.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); togglePanel(); } });
    fab.tabIndex = 0;
  })();

  // ---- The panel (drag its title bar to move it) ----
  const panel = document.createElement('div');
  panel.className = 'panel';
  panel.hidden = true;
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', 'Mugger');
  panel.innerHTML = `<div class="head">
      <div class="row1" title="Drag to move"><span class="grip" aria-hidden="true">⠿</span><div class="title">Mugger</div><button class="iconbtn" data-act="settings" aria-label="Settings" title="Settings">⚙</button><button class="iconbtn" data-act="close" aria-label="Close" title="Close">✕</button></div>
      <div class="wip" role="note">Work In Progress</div>
      <div class="trip" id="trip"></div>
    </div><div class="body" id="body"></div>`;
  root.appendChild(panel);
  const $ = id => panel.querySelector(`#${id}`);
  let view = 'main';
  const open = new Set();
  function placePanel() {
    const p = cfg.panelPos;
    const st = panel.style;
    if (!p) { st.left = st.top = st.right = st.bottom = st.width = st.maxHeight = ''; return; }
    const w = Math.min(p.w || 460, window.innerWidth - 8);
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
      if (start.moved) { const r = panel.getBoundingClientRect(); cfg.panelPos = { x: r.left / window.innerWidth, y: r.top / window.innerHeight, w: Math.round(r.width) }; saveCfg(); }
      start = null;
    };
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
  })();
  placePanel();
  function togglePanel(show = panel.hidden) {
    panel.hidden = !show;
    cfg.open = show;
    saveCfg();
    view = 'main';
    render(true);
  }

  // ---- Updates ----
  const newer = (a, b) => {
    const x = String(a || '').split('.').map(Number), y = String(b || '').split('.').map(Number);
    for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
    return false;
  };
  const latest = () => (traders && traders.script && traders.script.version) || '';
  const updateReady = () => newer(latest(), VERSION);
  function updateHtml() {
    if (!updateReady()) return '';
    const how = isPda ? 'Torn PDA updates its scripts by itself. To update now: Settings → Advanced browser settings → Manage scripts, open <b>Mentat Mugger</b> and load it again from its address, then reload this page.'
      : /userscripts/i.test(handler) ? 'Userscripts (Safari): open the script address in Safari, then the Userscripts extension, and install the update.'
        : 'Your script manager opens its update screen: click <b>Update</b>, then reload this page. If it only shows the text: Dashboard → Utilities → Install from URL with the address below.';
    return `<div class="note update"><b>Update available: ${esc(latest())}</b> <span class="small">(you have ${VERSION})</span>
      ${isPda ? '' : '<div class="join"><button class="btn primary" data-act="update">Update now</button></div>'}
      <p class="small" style="margin:6px 0 0">${how}</p><div class="join"><input readonly value="${SCRIPT_URL}" aria-label="Script address"></div></div>`;
  }

  // ---- Drawing ----
  const TOS_ROWS = [
    ['Data Storage', 'Only on this device (the script\'s own storage); nothing you look up is sent to the Mentat server'],
    ['Data Sharing', 'None'],
    ['Purpose of Use', 'Public community tools: finding mug targets abroad'],
    ['Key Storage & Sharing', 'Not stored or shared by the server (it checks once that you\'re in the faction). Torn PDA: PDA\'s key. Browser: the key you sign in with, kept only on this device and sent only to Torn.'],
    ['Key Access Level', 'Limited recommended (your battle stats); Minimal for your status, travel and merits; other players\' profile, job and personal stats are public'],
  ];
  const tosHtml = () => `<table class="tos" aria-label="Torn API terms for Mugger">${TOS_ROWS.map(([k, v]) => `<tr><th>${k}</th><td>${esc(v)}</td></tr>`).join('')}</table>`;
  function signInHtml() {
    return `<p><b>Sign in to your faction's Mentat server.</b></p>
      ${pdaKey ? '<p class="muted">Using the API key you gave Torn PDA.</p><div class="join"><button class="btn primary" data-act="signin">Sign in</button></div>'
        : `<p class="muted">Enter your Torn API key (Limited recommended). The Mentat server checks it once with Torn to see you're in the faction, then forgets it. This script keeps it on this device only, to look players up on Torn while you're abroad; it's never sent anywhere else. Signing out removes it.</p>
           <div class="join"><input id="key" type="password" autocomplete="off" spellcheck="false" maxlength="40" placeholder="API key" aria-label="Torn API key"><button class="btn primary" data-act="signin">Sign in</button></div>`}
      ${signError ? `<p class="err">${esc(signError)}</p>` : ''}
      ${tosHtml()}<p class="small"><a href="${GUIDE}">How this works</a></p>`;
  }
  // Possible mug protection: in hospital in this country within 12 hours, or fights lost abroad since yesterday.
  function protectOf(p, country) {
    const out = { tags: [], line: '' };
    const h = p && p.hosp;
    if (h && h.place === country && Date.now() - h.at < PROTECT && BY_PLAYER.test(h.text || '')) {
      const inNow = p.place && p.place.kind === 'hospital';
      const when = `${inNow ? 'In hospital' : 'Was in hospital'} in ${h.place}, first seen ${ago(h.at)}`;
      const why = h.mugged
        ? `${h.text}. ${when}. What they had left is protected, less each hour, gone after 12 hours. Flag ends ${tct(h.at + PROTECT)} TCT.`
        : `${when}${h.text ? ` (${h.text})` : ''}. If they were mugged, what they had left is protected, less each hour, for 12 hours. Flag ends ${tct(h.at + PROTECT)} TCT.`;
      out.tags.push(`<span class="pill warn" title="${esc(why)}">${h.mugged ? `mugged ${ago(h.at)}` : 'may be mug-protected'}</span>`);
      out.line = esc(why);
    }
    const lost = p && p.rec && !p.rec.error && p.rec.lostAbroad;
    if (lost && lost.n > 0) {
      const why = `Lost ${lost.n} fight${lost.n === 1 ? '' : 's'} abroad since yesterday (Torn's daily count doesn't say where). A mug is a lost fight, so they may be protected.`;
      if (!out.tags.length) out.tags.push(`<span class="pill warn" title="${esc(why)}">lost ${lost.n} abroad</span>`);
      out.line = out.line ? `${out.line} ${esc(why)}` : esc(why);
    }
    return out;
  }
  function whereHtml(r) {
    const p = r.p, st = p.status || {};
    if (p.place.kind === 'flying') {
      const f = p.flight;
      return `<span class="pill info" title="${esc(st.description)}">Flying in</span>${f && f.departLo ? ` <span class="small">left ~${tct((f.departLo + f.departHi) / 2)} TCT</span>` : ''}`;
    }
    if (p.place.kind === 'hospital') return `<span class="pill bad" title="${esc(st.description)}">Hospital${st.until > Date.now() ? ` ${Math.ceil((st.until - Date.now()) / MIN)}m` : ''}</span>`;
    return `<span class="pill ok">In ${esc(p.place.place)}</span>${p.awaySince ? ` <span class="small">away since ${tct(p.awaySince)}</span>` : ''}`;
  }
  function fightHtml(r) {
    const x = ffs.on ? ffsStats[r.t.id] : null;
    const out = [];
    if (x && x.ff !== null && x.ff !== undefined) {
      const ff = Number(x.ff);
      out.push(`<span class="pill ${ff < 2 ? 'ok' : ff < 2.75 ? 'warn' : 'bad'}" title="Fair fight (FFScouter): higher = tougher">FF ${ff.toFixed(2)}${x.bsHuman ? ` · ${esc(x.bsHuman)}` : ''}</span>`);
    }
    if (x && x.bs && meta.me && meta.me.total) {
      const ratio = x.bs / meta.me.total;
      out.push(`<span class="pill ${ratio < 0.8 ? 'ok' : ratio < 1.25 ? 'warn' : 'bad'}" title="FFScouter's estimate of their battle stats ÷ yours">${ratio < 10 ? ratio.toFixed(2) : Math.round(ratio)}× you</span>`);
    }
    if (r.p && r.p.life) out.push(`<span class="small">Life ${num(r.p.life[0])}/${num(r.p.life[1])}</span>`);
    return out.join(' ') || `<span class="small">${ffs.on ? 'no estimate' : 'FFScouter off'}</span>`;
  }
  function detailHtml(r, country) {
    const c = r.cash, tc = r.tc, lines = [];
    if (c) {
      if (c.trip && tc) lines.push(`Trip money ${money(c.trip)}: still flying out. ${num(Math.round(tc.items))} items, ${esc(tc.basis)}, × ${money(tc.cost)} for ${esc(tc.name)} (${esc(tc.why || '')}).`);
      else if (r.unknown && r.p.place.kind === 'flying') lines.push(`Trip money: not known. ${esc(r.unknown)}`);
      else if (tc && r.p.place.kind !== 'flying') lines.push(`A trip here takes them about ${money(tc.amount)}; they've landed, so it's probably spent and isn't counted.`);
      if (c.since) lines.push(`Bazaar sales since ${tct(c.since)} TCT: ${money(c.bazaar)}.`);
      lines.push(r.p.trade0 ? `Item market revenue less fees since ${tct(r.p.trade0.at)} TCT: ${money(c.market)}.` : `Item market sales: checked every ${Math.round(marketEvery() / MIN)} minutes while they are in this country.`);
      if (r.take) lines.push(`Mug: ${pct(r.take.pctLo)}–${pct(r.take.pctHi)} of ${money(c.total)} = <b>${money(r.take.lo)}–${money(r.take.hi)}</b>${r.take.clothing ? ' (7★ Clothing Store: −75%)' : ''}. Low rolls are much likelier.`);
      const prot = protectOf(r.p, country);
      if (prot.line) lines.push(`<span class="bad">${prot.line}</span>`);
    } else if (tc) lines.push(`A trip to ${esc(country)} takes them about <b>${money(tc.amount)}</b> (${num(Math.round(tc.items))} × ${esc(tc.name)}, ${esc(tc.basis)}; ${esc(tc.why || '')}).`);
    else if (r.unknown) lines.push(`A trip to ${esc(country)}: not known. ${esc(r.unknown)}`);
    const job = r.p && r.p.job && !r.p.job.error ? (r.p.job.company ? `Works at ${esc(r.p.job.company)} (${r.p.job.rating}★${r.p.job.clothing ? ', Clothing Store' : ''}).` : 'No company.') : '';
    const items = r.all.length ? `<table><tr><th>In their bazaar</th><th>Qty</th><th>Abroad</th></tr>${r.all.slice(0, 8).map(i => `<tr><td>${esc(i.name)}${i.small ? ' <span class="small">(not counted)</span>' : ''}</td><td>${num(i.q)}</td><td>${money(i.cost)}</td></tr>`).join('')}</table>` : '';
    const ev = events(r.t).slice(-8).reverse().map(e => { const m = traders.items[e[1]]; return `${e[2] > 0 ? '+' : ''}${num(e[2])} ${esc(m ? m[0] : `#${e[1]}`)}${e[4] ? ' (sold out)' : ''}${e[2] > 0 && e[2] <= TRADE_QTY ? ' (small, not counted)' : ''} · ${ago(e[0])}`; }).join('; ');
    const t = r.t;
    const rec = r.rec ? `<p style="margin:4px 0">${num(r.rec.items)} items bought abroad in ${num(r.rec.trips)} trips${r.rec.week ? `; last 7 days ${num(r.rec.week.items)} in ${num(r.rec.week.trips)}` : ''}${r.rec.favourite ? `. Most trips: ${esc(r.rec.favourite)}` : ''}.</p>` : '';
    return `<div class="det">${lines.map(l => `<p style="margin:3px 0">${l}</p>`).join('')}${job ? `<p style="margin:3px 0">${job}</p>` : ''}${rec}
      ${t.dir && (t.dir.spec.length || t.dir.busiest || t.dir.income) ? `<p style="margin:4px 0">Torn's bazaar directory${t.dir.bazaar ? ` (${esc(t.dir.bazaar)})` : ''}: ${[...t.dir.spec.map(([id, c]) => `top ${esc((traders.items[id] || ['item'])[0])} bazaar, ${num(c)} customers this week`), t.dir.busiest ? `busiest list, ${num(t.dir.busiest)} customers` : '', t.dir.income ? `top grossing, ${money(t.dir.income)} this week` : ''].filter(Boolean).join('; ')}.</p>` : ''}
      <p style="margin:4px 0">Last 30 days: restocked ${num(t.r30)} items (${money(t.rc30)} at abroad prices${t.small30 ? `; plus ${num(t.small30)} in small restocks, not counted` : ''}), sold ${num(t.s30)}, active ${plural(t.active, 'day')}.</p>${items}${ev ? `<p style="margin:4px 0">Recent bazaar changes: ${ev}</p>` : ''}</div>`;
  }
  function listHtml() {
    const trip = myTrip();
    if (!traders) return `<p class="muted">${netError ? `<span class="err">${esc(netError)}</span>` : 'Loading the market database…'}</p>`;
    const country = trip ? trip.country : cfg.preview;
    const isLive = !!trip && traders.country === trip.country;
    let rows = (isLive ? source() : traders.list).map(t => row(t, country, isLive));
    const muggedList = isLive ? source().filter(t => muggedHere(players[t.id], country)).map(t => ({ t, p: players[t.id] })) : [];
    if (isLive) rows = rows.filter(r => !muggedHere(r.p, country)).filter(r => r.p && r.p.tripKey === trip.key && near(r.p, country) && (cfg.flying || r.p.place.kind !== 'flying') && (cfg.hosp || r.p.place.kind !== 'hospital'));
    const by = { score: (a, b) => b.total - a.total || b.overall - a.overall, overall: (a, b) => b.overall - a.overall || b.total - a.total, take: (a, b) => ((b.take && b.take.lo) || 0) - ((a.take && a.take.lo) || 0), ff: (a, b) => (((ffsStats[a.t.id] || {}).ff) || 99) - (((ffsStats[b.t.id] || {}).ff) || 99) };
    rows.sort(by[cfg.sort] || by.score);
    if (!isLive) rows = rows.slice(0, 25);
    const opt = (v, l, cur) => `<option value="${esc(v)}"${String(v) === String(cur) ? ' selected' : ''}>${esc(l)}</option>`;
    const opts = isLive
      ? `<div class="opts"><label><input type="checkbox" data-set="flying" ${cfg.flying ? 'checked' : ''}> Flying in</label><label><input type="checkbox" data-set="hosp" ${cfg.hosp ? 'checked' : ''}> Hospital</label><label>Sort <select data-cfg="sort">${opt('score', `Score for ${country}`, cfg.sort)}${opt('overall', 'Overall score', cfg.sort)}${opt('take', 'Mug take', cfg.sort)}${opt('ff', 'Easiest fight', cfg.sort)}</select></label></div>`
      : `<div class="opts"><label>Preview <select data-cfg="preview">${COUNTRIES.map(c => opt(c, c, cfg.preview)).join('')}</select></label><label>Sort <select data-cfg="sort">${opt('score', `Score for ${country}`, cfg.sort)}${opt('overall', 'Overall score', cfg.sort)}</select></label></div>`;
    const checked = pool().filter(id => players[id] && players[id].tripKey === (trip && trip.key) && players[id].at).length;
    const intro = isLive
      ? `<p class="small" style="margin:0 0 8px">${num(checked)}/${num(pool().length)} ${pasteActive(trip) ? 'pasted people' : 'traders'} located · your mug ${pct(0.05 * mult())}–${pct(0.10 * mult())} of cash on hand${tornError ? ` · <span class="err">${esc(tornError)}</span>` : ''}${!myKey() ? ' · <span class="err">No API key: sign out and in again.</span>' : ''}</p>`
      : '<p class="small" style="margin:0 0 8px">Mugger checks who is where once you fly abroad (it uses your API key only then). Meanwhile, the traders of a country from the market database:</p>';
    const li = rows.map(r => {
      const t = r.t, p = r.p, o = open.has(t.id);
      const name = (p && p.name) || t.name || `#${t.id}`;
      const top = t.items.slice(0, 2).map(([id, q]) => `${num(q)} ${esc((traders.items[id] || [`#${id}`])[0])}`).join(', ');
      const scoreCls = r.total >= 60 ? 'ok' : r.total >= 35 ? 'warn' : '';
      const tags = [];
      if (p && p.job && p.job.clothing && p.job.rating >= 7) tags.push('<span class="pill bad" title="Works at a 7★ Clothing Store: mugs take 75% less (Torn wiki)">7★ Clothing −75%</span>');
      if (isLive) tags.push(...protectOf(p, country).tags);
      return `<li>
        <div class="top"><a class="nm" href="https://www.torn.com/profiles.php?XID=${t.id}">${esc(name)}</a><span class="small">[${t.id}]${p && p.level ? ` · lvl ${p.level}` : ''}</span>${p && p.last ? `<span class="small"><span class="dot ${esc(p.last.status)}"></span>${esc(p.last.status)}</span>` : ''}<span class="sc pill ${scoreCls}" title="Score for ${esc(country)}: its items only (0–100)">here ${r.total}</span><span class="pill ${r.overall >= 60 ? 'ok' : r.overall >= 35 ? 'warn' : ''}" title="Overall score: every abroad item (0–100)">all ${r.overall}</span></div>
        ${isLive ? `<div class="line">${whereHtml(r)} ${tags.join(' ')}</div>
        <div class="line">${r.cash && r.cash.total ? `Cash ≈ <span class="big">${money(r.cash.total)}</span>${r.take ? ` → mug <span class="big ok">${money(r.take.lo)}–${money(r.take.hi)}</span>` : ''}` : '<span class="small">No cash seen since they left Torn</span>'}${r.unknown && p && p.place && p.place.kind === 'flying' ? ` <span class="small" title="${esc(r.unknown)}">· trip money not known</span>` : ''}</div>
        <div class="line">${fightHtml(r)}</div>` : `<div class="line">${r.tc ? `Trip ≈ <span class="big">${money(r.tc.amount)}</span>` : ''}</div>`}
        ${t.dir && t.dir.spec && t.dir.spec.length ? `<div class="line small">${num(t.dir.spec[0][1])} customers/week · top ${esc((traders.items[t.dir.spec[0][0]] || ['item'])[0])} bazaar</div>` : ''}
        <div class="line small">${top || 'nothing listed now'}${t.rc30 ? ` · ${money(t.rc30 / (30 / 7))}/week restocked` : ''}${r.restock ? ` · last restock +${num(r.restock[2])}${r.restockTrips > 1.5 ? ` ≈ ${Math.round(r.restockTrips)} trips` : ''} ${ago(r.restock[0])}` : ''}</div>
        <div class="acts">${isLive ? `<a class="btn primary" href="https://www.torn.com/page.php?sid=attack&user2ID=${t.id}">Attack</a>` : ''}<a class="btn" href="https://www.torn.com/bazaar.php?userId=${t.id}">Bazaar</a><button class="btn" data-act="details" data-id="${t.id}">${o ? 'Less' : 'Details'}</button></div>
        ${o ? detailHtml(r, country) : ''}</li>`;
    }).join('');
    const empty = isLive ? `<p class="muted">Nobody from the ${num(pool().length)} ${pasteActive(trip) ? 'people you pasted' : 'traders'} is ${cfg.flying ? 'in or flying to' : 'in'} ${esc(country)} yet${checked < pool().length ? ` (${num(checked)} checked so far)` : ''}.</p>` : `<p class="muted">No traders of ${esc(country)}'s items in the database yet.</p>`;
    const protectedBox = muggedList.length ? '<div class="paste"><p class="small" style="margin:8px 0 4px"><b>Mug protected</b> (' + num(muggedList.length) + '): mugged in ' + esc(country) + ', so off the list and not checked again until their protection ends, 12 hours from when they were first seen in hospital.</p>' + muggedList.map(({ t, p }) => '<p class="small" style="margin:2px 0"><a href="https://www.torn.com/profiles.php?XID=' + t.id + '">' + esc((p && p.name) || t.name || '#' + t.id) + '</a> [' + t.id + '] · ' + esc(p.hosp.text || 'Mugged') + ' · ' + ago(p.hosp.at) + ' · protected until ' + tct(p.hosp.at + PROTECT) + ' TCT</p>').join('') + '</div>' : '';
    return `${updateHtml()}${opts}${isLive ? pasteHtml(trip) : ''}${intro}${li ? `<ul class="list">${li}</ul>` : empty}${protectedBox}
      <p class="small">Market database: ${plural((traders.db || {}).sellers, 'trader')}, ${plural((traders.db || {}).days, 'day')} of history, from your Mentat server. Cash on hand counts trip money while they're still flying out, and bazaar and item market sales since they left Torn; what they had before isn't known.${ffs.on ? ' Estimates from <a href="https://ffscouter.com">FFScouter</a>.' : ''}</p>`;
  }
  let pasteMsg = '';
  function pasteHtml(trip) {
    const ps = pasteFor(trip), c = esc(trip.country);
    let state;
    if (!ps) state = "Copy Torn's People list for " + c + " and paste it here (a page at a time). Once you've landed, Mugger checks only those people, traders or not, and drops anyone who leaves.";
    else {
      const bits = [pasteActive(trip) ? 'Checking only the <b>' + num(ps.ids.length) + '</b> people you pasted' : '<b>' + num(ps.ids.length) + '</b> pasted; checked once you land'];
      if (ps.lookups.length) bits.push('looking up ' + plural(ps.lookups.length, 'name'));
      if (ps.left.length) bits.push('<span title="' + esc(ps.left.map(x => (x.name || '#' + x.id) + (x.to ? ' → ' + x.to : '') + ' (' + ago(x.at) + ')').join('\n')) + '">' + num(ps.left.length) + ' left: ' + esc(ps.left.slice(0, 3).map(x => x.name || '#' + x.id).join(', ')) + (ps.left.length > 3 ? '…' : '') + '</span>');
      if (ps.notFound.length) bits.push('<span title="' + esc(ps.notFound.join(', ')) + '">' + num(ps.notFound.length) + ' not found</span>');
      state = bits.join(' · ');
    }
    return '<div class="paste"><p class="small" style="margin:0 0 4px">' + state + '</p><textarea id="paste" rows="2" spellcheck="false" placeholder="Paste Torn\'s People list for ' + c + '"></textarea>'
      + '<div class="join"><button class="btn primary" data-pact="paste">Add to the list</button>' + (ps ? '<button class="btn" data-pact="pasteclear">Clear list</button>' : '') + (pasteMsg ? '<span class="small">' + esc(pasteMsg) + '</span>' : '') + '</div></div>';
  }
  async function pasteNow(text) {
    const trip = myTrip();
    if (!trip || !traders) { pasteMsg = "Paste Torn's People list once you're abroad."; return; }
    const { ids, names } = parsePeople(text);
    if (!ids.length && !names.length) { pasteMsg = 'No players found in that text.'; return; }
    pasteState = await store.get('paste', null);
    const ps = pasteFor(trip, true);
    ps.at = Date.now();
    let added = 0, byName = 0;
    for (const x of ids) if (pasteAdd(ps, x.id, x.name)) added++;
    if (names.length) {
      const known = new Map();
      for (const [pid, p] of Object.entries(players)) if (p && p.name) known.set(String(p.name).toLowerCase(), Number(pid));
      for (const t of [...traders.list, ...(traders.extra || [])]) if (t.name) known.set(String(t.name).toLowerCase(), t.id);
      const ask = names.filter(n => !known.has(n.toLowerCase())).slice(0, 200);
      if (ask.length) { const named = await loadTraders(trip.country, true, ask); for (const [n, id] of Object.entries(named || {})) known.set(n.toLowerCase(), Number(id)); }
      for (const n of names) {
        const id = known.get(n.toLowerCase());
        if (id) { if (pasteAdd(ps, id, n)) { added++; byName++; } } else if (!ps.lookups.includes(n) && !ps.notFound.includes(n)) ps.lookups.push(n);
      }
      ps.lookups = ps.lookups.slice(0, LOOKUP_MAX);
    }
    await savePaste();
    await loadTraders(trip.country, true);
    pasteMsg = 'Added ' + num(added) + (byName ? ' (' + num(byName) + ' by name)' : '') + (ps.lookups.length ? '; looking up ' + plural(ps.lookups.length, 'name') : '') + '. ' + num(ps.ids.length) + ' on the list.';
  }
  function settingsHtml() {
    const opt = (v, l, cur) => `<option value="${esc(v)}"${String(v) === String(cur) ? ' selected' : ''}>${esc(l)}</option>`;
    const merits = meta.merits && Number.isFinite(meta.merits.looting) ? `${meta.merits.looting}/10 from your merits` : 'read on your next trip';
    return `<div class="settings">
      <p class="muted" style="margin-top:0">${me && me.name ? `Signed in as ${esc(me.name)}` : ''}</p>
      <h3>Your mug</h3>
      <div class="opts"><label>Masterful Looting <select data-cfg="looting">${opt('auto', `from my merits (${merits})`, cfg.looting)}${Array.from({ length: 11 }, (_, i) => opt(i, `${i}/10`, cfg.looting)).join('')}</select></label>
      <label>Plunder <select data-cfg="plunder">${opt(0, 'none', cfg.plunder)}${Array.from({ length: 30 }, (_, i) => opt(20 + i, `${20 + i}%`, cfg.plunder)).join('')}</select></label></div>
      <p class="small" style="margin:0">5–10% × ${mult().toFixed(2)} = ${pct(0.05 * mult())}–${pct(0.10 * mult())} of cash on hand (Torn wiki). A 7★ Clothing Store cuts it by 75%.</p>
      <h3>Checking</h3>
      <div class="opts"><label>Items from <select data-cfg="min">${[50000, 100000, 250000, 500000, 1000000].map(v => opt(v, money(v), cfg.min)).join('')}</select></label>
      <label>Check <select data-cfg="pool">${[20, 40, 60, 100, 150].map(v => opt(v, `${v} traders`, cfg.pool)).join('')}</select></label>
      <label>In your country every <select data-cfg="here">${[1, 2, 3].map(v => opt(v, `${v} min`, cfg.here)).join('')}</select></label>
      <label>Item market every <select data-cfg="market">${[2, 5, 10].map(v => opt(v, `${v} min`, cfg.market)).join('')}</select></label>
      <label>Up to <select data-cfg="rate">${[10, 20, 30, 45].map(v => opt(v, `${v} calls/min`, cfg.rate)).join('')}</select></label></div>
      <p class="small" style="margin:0">Your Torn API key is used only while you're flying out or abroad, up to this many calls a minute (Torn allows 100 a minute across all your tools). Players in your country are checked again every 1–3 minutes (one call each), those flying in every 3, the rest every 20; their item market sales every 2–10 minutes (one call each).</p>
      <h3>FFScouter</h3>
      <p class="small" style="margin:0 0 6px">Fair fight and estimated battle stats from <a href="https://ffscouter.com">FFScouter</a>, once per player per trip, with your own FFScouter key. Requests go only to ffscouter.com.</p>
      ${ffs.on ? `<p>On (${ffs.premium ? 'premium' : 'free'}${ffs.pda ? ", Torn PDA's key" : ''}). <button class="btn" data-act="ffsoff">Turn off</button></p>`
        : `<div class="join"><input id="ffskey" type="password" autocomplete="off" spellcheck="false" maxlength="40" placeholder="${pdaKey ? "Leave empty to use Torn PDA's key" : 'FFScouter key'}" aria-label="FFScouter key"></div>
           <label class="chk"><input type="checkbox" id="ffsack"> <span>I have read FFScouter's current <a href="https://ffscouter.com/privacy">data policy</a> and agree to it.</span></label>
           <div class="join"><button class="btn primary" data-act="ffson">Turn on FFScouter</button></div>`}
      ${ffs.error ? `<p class="err">${esc(ffs.error)}</p>` : ''}
      <h3>Your key</h3>${tosHtml()}
      <div class="join" style="margin-top:12px"><button class="btn" data-act="resetpos">Reset places</button><a class="btn" href="${GUIDE}">Guide</a><button class="btn danger" data-act="signout">Sign out</button></div>
      <div class="join"><button class="btn primary" data-act="back">Back</button></div>
      <p class="small">Mentat Mugger ${VERSION}${latest() ? (updateReady() ? ` · <b>${esc(latest())} is available</b>` : ' · up to date') : ''}. It only shows and links: it never reads or clicks anything on Torn's pages.</p></div>`;
  }
  let lastHtml = '';
  function render(force = false) {
    renderFab();
    if (panel.hidden) return;
    const trip = myTrip();
    $('trip').innerHTML = !session ? '' : trip ? `${trip.flying ? 'Flying to' : 'In'} <b>${esc(trip.country)}</b>` : `In Torn${mine ? '' : ' (checking…)'}`;
    const html = !session ? signInHtml() : view === 'settings' ? settingsHtml() : listHtml();
    if (!force && html === lastHtml) return;
    const body = $('body');
    const a = root.activeElement;
    if (!force && a && body.contains(a) && /^(INPUT|SELECT|TEXTAREA)$/.test(a.tagName)) return; // don't redraw under someone typing
    const scroll = body.scrollTop;
    body.innerHTML = html;
    body.scrollTop = scroll;
    lastHtml = html;
  }
  function renderFab() {
    const t = fab.querySelector('.t');
    const trip = myTrip();
    let n = 0;
    if (session && trip && traders && traders.country === trip.country) n = source().filter(x => { const p = players[x.id]; return p && p.tripKey === trip.key && near(p, trip.country) && !muggedHere(p, trip.country); }).length;
    t.textContent = n ? String(n) : '';
    fab.className = `fab${n ? ' ok' : ''}${updateReady() ? ' upd' : ''}`;
    fab.title = !session ? 'Mugger: sign in' : trip ? `Mugger: ${n} trader${n === 1 ? '' : 's'} near you in ${trip.country}` : 'Mugger';
    fab.setAttribute('aria-label', fab.title);
  }

  // ---- Taps (no inline handlers: Torn's pages don't allow them) ----
  panel.addEventListener('click', async e => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const act = b.dataset.act;
    if (act === 'close') return togglePanel(false);
    if (act === 'settings') { view = view === 'settings' ? 'main' : 'settings'; return render(true); }
    if (act === 'back') { view = 'main'; return render(true); }
    if (act === 'signin') {
      const k = pdaKey || String(($('key') || {}).value || '').replace(/[^A-Za-z0-9]/g, '');
      if (!/^[A-Za-z0-9]{16}$/.test(k)) { signError = 'A Torn API key is 16 letters and numbers.'; return render(true); }
      b.disabled = true;
      if (await signIn(k)) { mine = null; await store.set('mine', null); mineTick(); tripTick(); }
      return render(true);
    }
    if (act === 'signout') return signOut();
    if (act === 'details') { const id = Number(b.dataset.id); if (open.has(id)) open.delete(id); else open.add(id); return render(true); }
    if (act === 'resetpos') { cfg.pos = null; cfg.panelPos = null; saveCfg(); placeFab(); placePanel(); return render(true); }
    if (act === 'update') { window.open(`${SCRIPT_URL}?v=${encodeURIComponent(latest())}`, '_blank'); return; }
    if (act === 'ffsoff') { await ffsOff(''); return render(true); }
    if (act === 'ffson') {
      if (!$('ffsack').checked) { ffs.error = "Tick the box to agree to FFScouter's data policy first."; return render(true); }
      const typed = String(($('ffskey') || {}).value || '').replace(/[^A-Za-z0-9]/g, '');
      const viaPda = !typed && !!pdaKey;
      const k = typed || pdaKey;
      if (!/^[A-Za-z0-9]{16}$/.test(k)) { ffs.error = 'An FFScouter key is your 16-character Torn API key registered at ffscouter.com.'; return render(true); }
      b.disabled = true;
      await ffsEnable(k, viaPda);
      return render(true);
    }
  });
  panel.addEventListener('change', e => {
    const c = e.target.closest('[data-set]');
    if (c) { cfg[c.dataset.set] = c.checked; saveCfg(); return render(true); }
    const s = e.target.closest('[data-cfg]');
    if (!s) return;
    const k = s.dataset.cfg;
    cfg[k] = ['plunder', 'pool', 'rate', 'min', 'here', 'market'].includes(k) ? Number(s.value) : k === 'looting' && s.value !== 'auto' ? Number(s.value) : s.value;
    saveCfg();
    if (['preview', 'min', 'pool'].includes(k)) { traders = null; tripTick(); }
    s.blur();
    render(true);
  });
  panel.addEventListener('paste', e => {
    if (!e.target || e.target.id !== 'paste') return;
    const html = e.clipboardData && e.clipboardData.getData('text/html');
    const lines = html ? peopleFromHtml(html) : '';
    if (!lines) return;
    e.preventDefault();
    e.target.value = (e.target.value ? e.target.value + '\n' : '') + lines;
  });
  panel.addEventListener('mousedown', async e => {
    const b = e.target.closest('[data-pact]');
    if (!b) return;
    e.preventDefault();
    const ta = panel.querySelector('#paste');
    if (b.dataset.pact === 'paste') {
      const text = ta ? ta.value : '';
      if (!text.trim()) pasteMsg = "Paste Torn's People list first.";
      else { await pasteNow(text); if (ta && !/^No players|^Paste/.test(pasteMsg)) ta.value = ''; }
    } else if (b.dataset.pact === 'pasteclear') {
      pasteState = null;
      await store.set('paste', null);
      pasteMsg = 'List cleared: back to the best traders.';
      if (ta) ta.value = '';
    }
    if (ta) ta.blur();
    render(true);
  });
  panel.addEventListener('keydown', e => {
    if (e.key === 'Enter' && e.target.id === 'key') panel.querySelector('[data-act="signin"]').click();
    if (e.key === 'Escape') togglePanel(false);
  });

  // ---- Start ----
  // Another open tab doing the looking up: show what it found (it's all in the shared script storage).
  let followAt = 0;
  async function follow() {
    if (Date.now() - followAt < 5 * SEC || (await leader())) return;
    followAt = Date.now();
    [mine, players, meta, live, traders, ffsStats, pasteState] = await Promise.all([store.get('mine', null), store.get('players', {}), store.get('meta', meta), store.get('live', {}), store.get('traders', null), store.get('ffsStats', {}), store.get('paste', null)]);
    render();
  }
  function start() {
    setInterval(() => {
      if (document.hidden || !session) return;
      follow();
      mineTick();
      tripTick();
      watchTick();
      ffsTick();
    }, 1500);
    setInterval(() => renderFab(), 5000);
  }
  // Someone the server turned away isn't asked again for 12 hours (the button stays hidden).
  if (!session && Date.now() - (await store.get('refusedAt', 0)) < 12 * 3600 * SEC) { host.remove(); return; }
  if (!session && pdaKey) await signIn(pdaKey);
  start();
  if (cfg.open) togglePanel(true); else render();
})();
