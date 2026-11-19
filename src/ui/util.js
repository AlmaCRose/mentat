'use strict';
/* global app */
// Shared state and helpers for every UI script. Loaded first.

// ---- State ----
const S = { tabs: [], api: {}, settings: null, features: { user: null, chain: null, targets: null, market: null, travel: null, bazaar: null, ffscouter: null } };
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const panel = name => $(`#panels > section[data-panel="${name}"]`);

// ---- Formatting ----
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pad = n => String(n).padStart(2, '0');
function fmtDur(sec) {
  sec = Math.max(0, Math.floor(sec));
  const d = Math.floor(sec / 86400), h = Math.floor(sec % 86400 / 3600), m = Math.floor(sec % 3600 / 60), s = sec % 60;
  if (d) return `${d}d ${h}h ${pad(m)}m`;
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}
function fmtAgo(ms) {
  const s = Math.floor((Date.now() - ms) / 1000);
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
}
const num = n => Number(n || 0).toLocaleString('en-US', { maximumFractionDigits: 2 });
// A countdown that the 1s ticker keeps up to date. `done` is shown once it reaches zero.
const countdown = (until, done = 'ready') => `<span class="mono" data-until="${until}" data-done="${esc(done)}">${until > Date.now() ? fmtDur((until - Date.now()) / 1000) : esc(done)}</span>`;
const ago = ms => `<span data-ago="${ms}">${fmtAgo(ms)}</span>`;
const profileUrl = id => `https://www.torn.com/profiles.php?XID=${id}`;
const attackUrl = id => `https://www.torn.com/page.php?sid=attack&user2ID=${id}`;
const link = (url, text) => `<a data-open="${esc(url)}" title="Opens in a new Torn tab">${text}</a>`;

// ---- Pictures: players' profile pictures and factions' tag and banner ----
// Player pictures come from the avatars feature (a full address from Torn's profile data); a player
// whose picture isn't known yet gets an empty placeholder, which avatarsTick() asks about once it's on
// screen and fillAvatars() swaps for the picture when it arrives, without redrawing anything.
// Factions give file names: tags on factiontags.torn.com, banners on factionimages.torn.com.
const avatarsOn = () => !(S.settings && S.settings.ui && S.settings.ui.avatars === false);
function avatar(id, cls = '') {
  if (!id || !avatarsOn()) return '';
  const u = S.features.avatars && S.features.avatars.map ? S.features.avatars.map[id] : '';
  return u ? `<img class="av ${cls}" src="${esc(u)}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" data-av="${Number(id)}">`
    : `<span class="av av-none ${cls}" data-av="${Number(id)}" aria-hidden="true"></span>`;
}
const factionTag = (file, cls = '') => (file && avatarsOn() ? `<img class="ftag ${cls}" src="https://factiontags.torn.com/${encodeURIComponent(file)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : '');
const factionBanner = (file, cls = '') => (file && avatarsOn() ? `<img class="fbanner ${cls}" src="https://factionimages.torn.com/${encodeURIComponent(file)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : '');
function fillAvatars() {
  const map = (S.features.avatars && S.features.avatars.map) || {};
  for (const el of $$('.av-none[data-av]')) {
    const u = map[el.dataset.av];
    if (!u) continue;
    const img = document.createElement('img');
    img.className = el.className.replace(/\bav-none\b/, '').trim();
    Object.assign(img, { src: u, alt: '', loading: 'lazy', decoding: 'async', referrerPolicy: 'no-referrer' });
    img.dataset.av = el.dataset.av;
    el.replaceWith(img);
  }
}
const AV_ASKED = new Set();
let avAskedAt = Date.now();
function avatarsTick() {
  if (document.hidden || !avatarsOn() || typeof cmd !== 'function') return;
  if (Date.now() - avAskedAt > 10 * 60e3) { AV_ASKED.clear(); avAskedAt = Date.now(); }
  const ids = [];
  for (const el of $$('.av-none[data-av]')) {
    const id = el.dataset.av;
    if (AV_ASKED.has(id)) continue;
    const r = el.getBoundingClientRect();
    if (!r.width || r.bottom < -300 || r.top > innerHeight + 600) continue; // only what's on (or near) the screen
    AV_ASKED.add(id);
    ids.push(Number(id));
  }
  if (ids.length) cmd('avatars.want', ids).catch(() => {});
}
setInterval(avatarsTick, 1500);
// A picture that won't load (removed, blocked): drop it quietly.
document.addEventListener('error', e => {
  const t = e.target;
  if (t && t.tagName === 'IMG' && t.matches('img.av, img.ftag, img.fbanner')) {
    if (t.classList.contains('av')) { const s = document.createElement('span'); s.className = `${t.className} av-none av-broken`; t.replaceWith(s); } else t.remove();
  }
}, true);

function statusPill(st, until) {
  if (!st || !st.state) return '<span class="pill">Unknown</span>';
  const cls = { Okay: 'ok', Hospital: 'bad', Jail: 'bad', Federal: 'bad', Traveling: 'info', Abroad: 'info' }[st.state] || 'warn';
  const timed = (st.state === 'Hospital' || st.state === 'Jail') && until > Date.now();
  return `<span class="pill ${cls}" title="${esc(st.description)}">${esc(st.state)}${timed ? ' ' + countdown(until, 'out') : ''}</span>`;
}

// ---- Commands ----
const cmd = (name, ...args) => app.cmd(name, ...args).catch(e => { console.error(e); throw e; });

// ---- Money + numbers ----
function money(n, compact = false) {
  if (n === null || n === undefined || !Number.isFinite(Number(n))) return '–';
  n = Number(n);
  const sign = n < 0 ? '-' : '';
  const a = Math.abs(n);
  if (compact && a >= 1e9) return `${sign}$${(a / 1e9).toFixed(a >= 1e10 ? 1 : 2)}B`;
  if (compact && a >= 1e6) return `${sign}$${(a / 1e6).toFixed(a >= 1e7 ? 1 : 2)}M`;
  if (compact && a >= 1e4) return `${sign}$${(a / 1e3).toFixed(a >= 1e5 ? 0 : 1)}K`;
  return `${sign}$${Math.round(a).toLocaleString('en-US')}`;
}
const pct = (x, digits = 1) => (x === null || x === undefined || !Number.isFinite(x) ? '–' : `${x > 0 ? '+' : ''}${(x * 100).toFixed(digits)}%`);
const signClass = x => (x > 0 ? 'pos' : x < 0 ? 'neg' : '');
// Torn City Time is UTC.
const tct = ms => { const d = new Date(ms); return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`; };
const fmtMin = m => (m >= 60 ? `${Math.floor(m / 60)}h ${pad(Math.round(m % 60))}m` : `${Math.round(m)}m`);
const marketUrl = id => `https://www.torn.com/page.php?sid=ItemMarket#/market/view=search&itemID=${id}`;
// An item name that opens the item's market + bazaar prices in a pop-up.
const itemLink = (id, text) => `<a data-item="${Number(id)}" title="Item market and bazaar prices">${text}</a>`;

// Per-viewer UI preferences (sub-tab, filters). Never required for correctness.
const prefs = {
  get(k, d) { try { const v = localStorage.getItem('td.' + k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem('td.' + k, JSON.stringify(v)); } catch (e) { /* ignore */ } },
};

// Item catalog from the main process: id -> [name, type, marketValue, circulation, tradable, shops]
const CATALOG = { fetchedAt: 0, items: {}, byName: {} };
async function loadCatalog(force = false) {
  const at = S.features.market ? S.features.market.catalogAt : 0;
  if (!force && at && at === CATALOG.fetchedAt) return CATALOG;
  const c = await cmd('market.catalog');
  CATALOG.fetchedAt = c.fetchedAt;
  CATALOG.items = c.items || {};
  CATALOG.byName = {};
  for (const [id, it] of Object.entries(CATALOG.items)) CATALOG.byName[it[0].toLowerCase()] = Number(id);
  return CATALOG;
}
// Bazaar summary from Weav3r: id -> [cheapest bazaar price, bazaar average, bazaar count]
const BAZAAR = { fetchedAt: 0, items: {} };
async function loadBazaar(force = false) {
  const b = S.features.bazaar;
  if (!b || !b.summaryAt) return BAZAAR;
  if (!force && b.summaryAt === BAZAAR.fetchedAt) return BAZAAR;
  const s = await cmd('bazaar.summary');
  BAZAAR.fetchedAt = s.fetchedAt;
  BAZAAR.items = s.items || {};
  return BAZAAR;
}
const priceSource = () => (S.settings && S.settings.market && S.settings.market.priceSource) || 'both';
const SOURCE_LABEL = { market: 'Item market', bazaar: 'Bazaars', both: 'Market + bazaars' };
const bazaarUrl = playerId => `https://www.torn.com/bazaar.php?userId=${playerId}`;

// Item market lowest (live listings, when fetched) and bazaar lowest (per-item listings
// when fetched, else the all-items summary).
function marketLowest(id) {
  const l = S.features.market && S.features.market.live[id];
  return l && l.lowest ? { price: l.lowest, at: l.fetchedAt } : null;
}
function bazaarLowest(id) {
  const bl = S.features.bazaar && S.features.bazaar.listings[id];
  if (bl && bl.listings && bl.listings.length) return { price: bl.listings[0].price, at: bl.fetchedAt, player: bl.listings[0].player };
  const s = BAZAAR.items[id];
  return s && s[0] ? { price: s[0], at: BAZAAR.fetchedAt } : null;
}
// Cheapest price from the chosen source. where: 'market' | 'bazaar' | ''.
function cheapest(id, src = priceSource()) {
  const m = src !== 'bazaar' ? marketLowest(id) : null;
  const b = src !== 'market' ? bazaarLowest(id) : null;
  if (m && (!b || m.price <= b.price)) return { ...m, where: 'market' };
  if (b) return { ...b, where: 'bazaar' };
  return { price: 0, where: '', at: 0 };
}
const wherePill = w => (w ? `<span class="pill ${w === 'bazaar' ? 'warn' : 'info'}">${w === 'bazaar' ? 'bazaar' : 'market'}</span>` : '');

const itemName = id => (CATALOG.items[id] ? CATALOG.items[id][0] : `Item ${id}`);
const itemMV = id => (CATALOG.items[id] ? CATALOG.items[id][2] : 0);
const itemType = id => (CATALOG.items[id] ? CATALOG.items[id][1] : '');
