'use strict';
// Mugger: who is worth mugging where you are abroad, and can you take them.
//
// The user's rules (2026-11-24): only players ABROAD matter (in Torn they can bank their money);
// players who buy costly items abroad carry cash; bazaar and item market sales made while they are
// abroad go to their cash on hand (wiki "Mug": "the money from the purchase is deposited into their
// wallet"). Restocks of thousands of items are several trips put in at once, not one.
//
// 1. Market database (muggerdb.js): bazaar sellers of abroad items and how their stock moves, 90
//    days, collected every 30 minutes by the Mentat server (or this device without one). No Torn API.
// 2. Your trip (Torn API with YOUR key on this device, never the server's — the user's rule,
//    2026-11-24 — and ONLY while you are flying out or abroad): the best `mugger.pool` traders for
//    that country from the database plus your Targets/Abroad lists, one /user/{id}?selections=profile
//    each; players in your country again every `mugger.here` minutes (1 by default, the user's
//    request 2026-11-24), those flying there every 3, the rest every 20. For each
//    player near you, once per trip: their job (/v2 job: a 7★ Clothing Store cuts mugs by 75%) and
//    travel record (/v2 personalstats cat=travel, plus items/trips a week ago); their trading stats
//    (/v2 personalstats cat=trading) every `mugger.market` minutes (5 by default) while they are in your country: item market
//    revenue since the first reading this trip = money into their wallet. Your battle stats once per
//    trip, your merits once a day. FFScouter: core.js adds the players near you to the FFScouter list,
//    which fetches each once and not again within 6 hours, so once per person per trip.
// 3. Bazaar sales near you: the items those players sell are re-read from Weav3r every 5 minutes.
// 4. Possible mug protection (the user's request 2026-11-25): anyone seen in hospital in your trip's
//    country is flagged for 12 hours from that sighting ("Mugged by" in the reason confirms it), and
//    the travel record adds their fights lost abroad since yesterday (defendslostabroad, by day, no country).
//
// Mug size (Torn wiki "Mug", pasted by the user 2026-11-24): 5% of cash on hand, rolled up to 10%
// (low values favoured), × (1 + Masterful Looting (5% a level, up to +50%) + Plunder (+20% to 49%),
// additive); a 7★ Clothing Store employee loses 75% less; after a mug the rest of their wallet is
// protected, the protection decaying to nothing over 12 hours.

const path = require('path');
const { EventEmitter } = require('events');
const { Store } = require('../store');
const { COUNTRIES } = require('./travel');
const { parseTrip, flightRange, COUNTRY_BY_NAME } = require('./war');
const { traderInfo, scores, rankTraders, TRADE_QTY } = require('./muggerdb');

const FLYING_EVERY = 3 * 60e3;
const FAR_EVERY = 20 * 60e3;
const RECORD_EVERY = 12 * 3600e3;
const MERITS_EVERY = 24 * 3600e3;
const TYPES_EVERY = 7 * 86400e3;
const RETRY = 2 * 60e3;
const WEEK = 7 * 86400e3;
const PLAYER_KEEP = 14 * 86400e3;
const COUNTRY_STATS = { mex: 'mexico', cay: 'cayman_islands', can: 'canada', haw: 'hawaii', uni: 'united_kingdom', arg: 'argentina', swi: 'switzerland', jap: 'japan', chi: 'china', uae: 'united_arab_emirates', sou: 'south_africa' };
const MUG = { base: [0.05, 0.10], lootingPerLevel: 0.05, clothing: 0.25 };

const PROTECT = 12 * 3600e3; // a mug protects what is left for 12 hours (Torn wiki "Mug")
const SAME_STAY = 25 * 60e3; // two hospital sightings this close together are one stay
// A hospital stay another player caused (only those can be a mug). Seen live 2026-11-25: "Mugged by X",
// "Hospitalized by X"; self-inflicted ones read like "Suffering from an acute hemolytic transfusion reaction",
// "Severe emesis following Ipecac Syrup ingestion", "Got a nasty surprise in the post."
const BY_PLAYER = /^(Mugged|Hospitali[sz]ed|Attacked) by /i;
const DAY = 86400e3;

const countryOf = name => COUNTRY_BY_NAME.get(String(name || '').trim().replace(/\.$/, '').toLowerCase()) || null;

// A hospital stay abroad reads like "In a Swiss hospital for 23 mins"; one in Torn "In hospital for ...".
// The abroad wording isn't confirmed against a live answer yet: without a match, the last country seen stands.
const HOSPITAL_ADJ = { mexican: 'Mexico', caymanian: 'Cayman Islands', canadian: 'Canada', hawaiian: 'Hawaii', british: 'United Kingdom', english: 'United Kingdom', argentinian: 'Argentina', argentine: 'Argentina', swiss: 'Switzerland', japanese: 'Japan', chinese: 'China', emirati: 'UAE', 'south african': 'South Africa' };
function hospitalCountry(desc) {
  const m = /^In an? (.+?) hospital\b/i.exec(String(desc || '').trim());
  if (!m) return '';
  const adj = HOSPITAL_ADJ[m[1].toLowerCase()];
  const c = countryOf(adj || m[1]);
  return c ? c.name : '';
}

// ---- A pasted list of the people in your country (the user's request 2026-11-25) ----
// You copy Torn's People list yourself (Mentat never reads Torn's pages) and paste it on the Mugger page.
// Copied with links, the page turns it into "Name [id]" lines; as plain text, names are matched against
// the market database, then looked up with Torn's player search (your key). Words that are clearly
// not names (the list's own labels, countries) are skipped.
const PASTE_MAX = 300;
const LOOKUP_MAX = 100;
const NOT_NAMES = new Set(('level lvl status okay hospital hospitalized traveling travelling abroad jail jailed attack attacks mug ' +
  'name names faction factions icons icon life online offline idle people page pages next prev previous last first show all sort ' +
  'by rank age days day hours hrs hour mins min minutes seconds secs ago user users profile list the and for from with you your ' +
  'mexico cayman islands canada hawaii united kingdom argentina switzerland japan china uae arab emirates south africa torn city ' +
  'returning flying landing landed bazaar shop market donator member members company none').split(' '));
function parsePeople(text) {
  const s = String(text || '');
  const ids = new Map(); // id -> name
  for (const m of s.matchAll(/([A-Za-z0-9_-]{1,20})\s*\[(\d{1,8})\]/g)) ids.set(Number(m[2]), m[1]);
  for (const m of s.matchAll(/(?:XID|user2ID)=(\d{1,8})/gi)) if (!ids.has(Number(m[1]))) ids.set(Number(m[1]), '');
  const rest = s.replace(/https?:\/\/\S+/gi, ' ').replace(/(?:XID|user2ID)=\d{1,8}/gi, ' ').replace(/[A-Za-z0-9_-]{1,20}\s*\[\d{1,8}\]/g, ' ');
  const nameLike = [...new Set((rest.match(/[A-Za-z0-9_-]+/g) || []).filter(w => /[A-Za-z]/.test(w) && w.length >= 3 && w.length <= 20 && !NOT_NAMES.has(w.toLowerCase())))];
  // Only a bare list of numbers is a list of IDs; numbers among words are levels, life and so on.
  if (!/[A-Za-z]/.test(rest)) for (const m of rest.matchAll(/\b\d{1,8}\b/g)) ids.set(Number(m[0]), '');
  const named = new Set([...ids.values()].filter(Boolean).map(n => n.toLowerCase()));
  return { ids: [...ids].filter(([id]) => id > 0).map(([id, name]) => ({ id, name })), names: nameLike.filter(n => !named.has(n.toLowerCase())) };
}

// Where a player is: place = country name or 'Torn'; kind = here | flying | hospital | jail | away.
function placeOf(st, lastIn) {
  st = st || {};
  const desc = String(st.description || '');
  if (st.state === 'Okay') return { place: 'Torn', kind: 'here' };
  if (st.state === 'Abroad') {
    const m = /^In (.+?)\.?$/i.exec(desc.trim());
    const c = m && countryOf(m[1]);
    return { place: c ? c.name : (m ? m[1] : ''), kind: 'here' };
  }
  if (st.state === 'Traveling') {
    const t = parseTrip(desc);
    if (!t || !t.country) return { place: '', kind: 'flying' };
    return t.back ? { place: 'Torn', kind: 'flying', from: t.country.name } : { place: t.country.name, kind: 'flying', from: 'Torn' };
  }
  if (st.state === 'Hospital') return { place: hospitalCountry(desc) || lastIn || 'Torn', kind: 'hospital' };
  if (st.state === 'Jail') return { place: 'Torn', kind: 'jail' };
  return { place: '', kind: 'away' };
}

// Your trip: flying out to a country, or there. null in Torn or on the way home.
function myTrip(u) {
  if (!u) return null;
  const st = u.status || {};
  const tr = u.travel;
  const dest = tr && tr.destination && tr.destination !== 'Torn' ? tr.destination : '';
  let country = '';
  if (st.state === 'Traveling') country = dest;
  else if (st.state === 'Abroad') country = dest || placeOf(st).place;
  else if (st.state === 'Hospital' && dest) country = dest;
  const c = countryOf(country);
  if (!c) return null;
  // The trip's identity: Torn's own departure time (whole seconds). Not departedAt, which is corrected
  // for clock skew on every status poll and so moved by milliseconds each time, making every poll a "new
  // trip" that threw away the checks so far (seen 2026-11-25 on a Hawaii trip: never got past ~19 of 150).
  const departed = tr && tr.departed ? Number(tr.departed) : 0;
  return { country: c.name, flying: st.state === 'Traveling', departed, key: `${c.name}|${departed || 'x'}` };
}

class MuggerFeature extends EventEmitter {
  constructor({ api, store, dataDir, db, user, viewing = () => false }) {
    super();
    this.api = api;
    this.store = store;
    this.mdb = db; // the market database (muggerdb.js)
    this.user = user;
    this.viewing = viewing;
    this.db = new Store(path.join(dataDir, 'mugger.json'), { trip: null, players: {}, me: null, merits: null, types: null }, { debounceMs: 20000 });
    this.extraIds = () => []; // your Targets and Abroad lists (core.js)
    this.inFlight = false;
    this.calls = [];
    this.pool = null;
    this.emitTimer = null;
    db.on('state', () => this.emitSoon());
    db.on('live', () => this.emitSoon());
    db.on('scanned', () => { this.pool = null; this.emitSoon(); });
  }

  // ---- Settings ----
  minCost() { return Math.max(10000, Number(this.store.get('mugger.minCost')) || 100000); }
  poolSize() { return Math.min(150, Math.max(10, Number(this.store.get('mugger.pool')) || 60)); }
  rate() { return Math.min(60, Math.max(5, Number(this.store.get('mugger.rate')) || 20)); }
  // Minutes between checks of players in your country (1-3).
  hereEvery() { return Math.min(3, Math.max(1, Number(this.store.get('mugger.here')) || 1)) * 60e3; }
  // Minutes between item market checks of players in your country (2-10).
  marketEvery() { return Math.min(10, Math.max(2, Number(this.store.get('mugger.market')) || 5)) * 60e3; }
  lootingAuto() { const v = this.store.get('mugger.looting'); return v === 'auto' || v === undefined || v === null; }
  // Masterful Looting level: from your merits (auto) or set by hand.
  looting() {
    if (this.lootingAuto()) { const m = this.db.data.merits; return m && Number.isFinite(m.looting) ? m.looting : 0; }
    return Math.min(10, Math.max(0, Number(this.store.get('mugger.looting')) || 0));
  }
  plunder() { return Math.min(49, Math.max(0, Number(this.store.get('mugger.plunder')) || 0)); }
  mult() { return 1 + this.looting() * MUG.lootingPerLevel + this.plunder() / 100; }

  // Your trip. If Torn's answer lacks the departure time (e.g. after landing), the trip to the same
  // country already under way carries on instead of starting over.
  trip() {
    const t = myTrip(this.user.state && this.user.state.data);
    const d = this.db.data.trip;
    if (t && !t.departed && d && d.country === t.country && d.departed && Date.now() - d.departed * 1000 < 12 * 3600e3) return { ...t, departed: d.departed, key: d.key };
    return t;
  }

  // The country on show: your choice, else your trip's, else the last one you went to.
  location() {
    const v = String(this.store.get('mugger.location') || 'auto');
    if (v !== 'auto' && countryOf(v)) return countryOf(v).name;
    const t = this.trip();
    if (t) return t.country;
    const last = this.db.data.trip;
    return last && last.country ? last.country : 'Mexico';
  }

  // Live (Torn API) only for the country of your trip.
  live() {
    const t = this.trip();
    return !!t && t.country === this.location();
  }

  // ---- What the market database says about a seller (no API; muggerdb.js traderInfo) ----
  sellerInfo(pid, items, country, now = Date.now()) {
    return traderInfo(this.mdb.seller(pid), items, country, this.minCost(), now);
  }

  // Bazaar sales since a time (at most 3× the abroad price each), database + watched readings.
  bazaarSold(info, since, items) {
    let value = 0, units = 0;
    for (const e of info.raw.ev) {
      if (e[0] < since || e[2] >= 0) continue;
      const m = items.get(e[1]);
      value += -e[2] * Math.min(e[3], m ? m.cost * 3 : e[3]);
      units += -e[2];
    }
    return { value, units };
  }

  // ---- Scores: for the country and overall, each 0-100 (muggerdb.js scores) ----
  score(info, rec, cash, country) {
    return scores(info, rec, cash, country);
  }

  // Items a trip: their last week's pace, else their average, else your capacity (the page says so).
  // Their carrying capacity, estimated (the user's rules, 2026-11-25): 15 always (5 base + 10 from a
  // Private Island airstrip, WLT stock or a Business Class Ticket); faction excursion upgrades +10 (only
  // your own faction's upgrades are in the API, so assumed maxed); a large suitcase +3 (the standard
  // 28-item setup); a Cruise Line job +2 from 3★, +5 at 10★ (from their job). No Smuggling For Beginners
  // book (unlikely); the 7★ Flower/Toy Shop bonus is for flowers and plushies only, so not counted.
  capacityOf(p) {
    const parts = [[15, 'base + airstrip/WLT/ticket'], [10, 'faction excursions (assumed maxed)'], [3, 'large suitcase (assumed)']];
    const j = p && p.job && !p.job.error ? p.job : null;
    const cruise = j && j.cruise ? (j.rating >= 10 ? 5 : j.rating >= 3 ? 2 : 0) : 0;
    if (cruise) parts.push([cruise, `${j.rating}★ Cruise Line`]);
    return { n: parts.reduce((a, x) => a + x[0], 0), text: parts.map(x => `${x[0]} ${x[1]}`).join(' + '), jobKnown: !!j };
  }

  // Items a trip: a trader flying out goes for a full load (the user's rule, 2026-11-25): their estimated
  // capacity, or their own average a trip if that's higher (a book, say).
  perTrip(rec, p = null) {
    let own = null;
    if (rec && rec.week && rec.week.trips > 0 && rec.week.items > 0) own = { n: rec.week.items / rec.week.trips, basis: 'their last week' };
    else if (rec && rec.now && rec.now.trips > 0 && rec.now.items > 0) own = { n: rec.now.items / rec.now.trips, basis: 'their average' };
    const cap = this.capacityOf(p);
    if (own && own.n > cap.n) return { n: own.n, basis: `a full load (${own.basis}: ${Math.round(own.n)} a trip, above the ${cap.n} estimated)`, cap };
    return { n: cap.n, basis: `a full load (${cap.n} = ${cap.text}${cap.jobKnown ? '' : '; job not checked yet'})`, cap };
  }

  // What they trade from a country: what they've listed (more than 5 at once) or restocked in the last
  // 90 days, and what Torn's bazaar directory says their bazaar specialises in. Most first.
  tradesFrom(info, country) {
    if (!info) return [];
    const out = new Map();
    for (const x of info.hist || []) if (x.countries.includes(country)) out.set(x.id, { ...x });
    for (const x of info.items) if (x.countries.includes(country) && !out.has(x.id)) out.set(x.id, { ...x });
    for (const x of info.spec || []) if (x.countries.includes(country) && !out.has(x.id)) out.set(x.id, { ...x, q: x.customers });
    return [...out.values()].sort((a, b) => b.q - a.q);
  }

  // Cash a trip takes: a full load × the abroad price of what they've traded most from this country.
  // No record of them trading anything from it: not known. No guessing (the user's rule, 2026-11-25).
  tripCash(info, rec, country, p = null) {
    const local = this.tradesFrom(info, country);
    if (!local.length) return null;
    const staple = local[0];
    const pt = this.perTrip(rec, p);
    return { amount: pt.n * staple.cost, items: pt.n, basis: pt.basis, name: staple.name, cost: staple.cost, local: true, why: 'what they have sold most from there' };
  }

  tripUnknown(info, country) {
    return info && !this.tradesFrom(info, country).length ? `No record in the market database of them selling anything from ${country}, so what they buy there (and the money it takes) isn't known.` : '';
  }

  // Cash on hand now, estimated (live only): the money for the trip while they're still flying out,
  // plus bazaar and item market sales since they left Torn.
  cashNow(p, info, rec, country, items) {
    if (!p || !p.place) return null;
    const out = { since: p.awaySince || 0, trip: 0, bazaar: 0, bazaarUnits: 0, market: 0, total: 0 };
    if (p.place.kind === 'flying' && p.place.place === country) {
      const tc = this.tripCash(info, rec, country, p);
      if (tc) out.trip = tc.amount;
      else out.tripUnknown = this.tripUnknown(info, country);
    }
    if (info && out.since) { const b = this.bazaarSold(info, out.since, items); out.bazaar = b.value; out.bazaarUnits = b.units; }
    const t0 = p.trade0, t1 = p.trade;
    if (t0 && t1 && !t1.error && !t0.error) out.market = Math.max(0, (t1.revenue - t0.revenue) - (t1.fees - t0.fees));
    out.total = out.trip + out.bazaar + out.market;
    return out;
  }

  // What a mug takes from that cash (wiki formula), with the 7★ Clothing Store cut.
  mugTake(cash, p) {
    if (!cash || !(cash.total > 0)) return null;
    const clothing = !!(p && p.job && p.job.clothing && p.job.rating >= 7);
    const k = this.mult() * (clothing ? MUG.clothing : 1);
    return { lo: cash.total * MUG.base[0] * k, hi: cash.total * MUG.base[1] * k, pctLo: MUG.base[0] * k, pctHi: MUG.base[1] * k, clothing };
  }

  // ---- The traders for a country: best from the database, plus your lists ----
  candidates(country) {
    const best = rankTraders(this.mdb, country, this.minCost(), this.poolSize(), pid => this.record(pid)).map(x => x.id);
    const extra = (this.extraIds() || []).map(Number).filter(Boolean);
    return [...new Set([...best, ...extra])];
  }

  record(pid) {
    const p = this.db.data.players[pid];
    return p && p.rec && !p.rec.error ? p.rec : null;
  }

  // Possible mug protection: seen in hospital in this country within the last 12 hours.
  protection(p, country, now = Date.now()) {
    const h = p && p.hosp;
    if (!h || h.place !== country || now - h.at >= PROTECT || !BY_PLAYER.test(h.text || '')) return null;
    return { at: h.at, seen: h.seen, ends: h.at + PROTECT, place: h.place, text: h.text, mugged: !!h.mugged, now: !!(p.place && p.place.kind === 'hospital') };
  }

  // Mugged in this country within 12 hours (the hospital reason said so): what they had left is
  // protected, so they come off the list into the Mug protected box and aren't checked again until the
  // protection ends (the user's request, 2026-11-25).
  muggedHere(p, country, now = Date.now()) {
    const pr = this.protection(p, country, now);
    return pr && pr.mugged ? pr : null;
  }

  near(p, country) {
    return !!(p && p.place && p.place.place === country && ['here', 'flying', 'hospital'].includes(p.place.kind));
  }

  // ---- The pasted People list: kept for this trip; once you've landed, only these are checked ----
  pasteFor(trip, create = false) {
    const p = this.db.data.paste;
    if (p && trip && p.trip === trip.key) return p;
    if (!create || !trip) return null;
    return (this.db.data.paste = { trip: trip.key, country: trip.country, at: Date.now(), ids: [], names: {}, left: [], lookups: [], notFound: [], lookupRetryAt: 0 });
  }

  pasteActive(trip) {
    const p = this.pasteFor(trip);
    return !!(p && !trip.flying && (p.ids.length || p.lookups.length));
  }

  pasteAdd(ps, id, name) {
    id = Number(id);
    if (!Number.isInteger(id) || id <= 0 || ps.ids.includes(id) || ps.ids.length >= PASTE_MAX) return false;
    ps.ids.push(id);
    if (name) ps.names[id] = String(name).slice(0, 30);
    ps.left = ps.left.filter(x => x.id !== id);
    return true;
  }

  paste(text) {
    const trip = this.trip();
    if (!trip) return { error: "Paste Torn's People list once you're abroad." };
    const { ids, names } = parsePeople(text);
    if (!ids.length && !names.length) return { error: 'No players found in that text.' };
    const ps = this.pasteFor(trip, true);
    ps.at = Date.now();
    const known = new Map(this.mdb.nameIndex());
    for (const [pid, p] of Object.entries(this.db.data.players)) if (p.name) known.set(String(p.name).toLowerCase(), Number(pid));
    let added = 0, byName = 0;
    for (const x of ids) if (this.pasteAdd(ps, x.id, x.name)) added++;
    for (const n of names) {
      const id = known.get(n.toLowerCase());
      if (id) { if (this.pasteAdd(ps, id, n)) { added++; byName++; } } else if (!ps.lookups.includes(n) && !ps.notFound.includes(n)) ps.lookups.push(n);
    }
    ps.lookups = ps.lookups.slice(0, LOOKUP_MAX);
    this.pool = null;
    this.db.save();
    this.emitSoon();
    return { added, byName, lookups: ps.lookups.length, total: ps.ids.length };
  }

  // Players from a list on a Torn page (right-click "Add all players in this list to Mugger", main.js, the
  // user's request 2026-11-25): onto the pasted list for this trip, exactly as a paste with links.
  addPlayers(players) {
    const trip = this.trip();
    if (!trip) return { error: 'Mugger adds players once you are flying out or abroad.' };
    const ps = this.pasteFor(trip, true);
    ps.at = Date.now();
    let added = 0;
    for (const x of players || []) if (this.pasteAdd(ps, x.id, x.name)) added++;
    this.pool = null;
    this.db.save();
    this.emitSoon();
    return { added, total: ps.ids.length, full: ps.ids.length >= PASTE_MAX, country: trip.country, landed: !trip.flying };
  }

  pasteClear() {
    this.db.data.paste = null;
    this.pool = null;
    this.db.save();
    this.emitSoon();
  }

  // A name from a plain-text paste: Torn's player search (your key), exact name only.
  async fetchLookup(name, trip) {
    const ps = this.pasteFor(trip);
    if (!ps) return;
    const drop = () => { ps.lookups = ps.lookups.filter(n => n !== name); };
    try {
      const d = await this.api.request(`/v2/user/search?name=${encodeURIComponent(name)}`, { soft: [6, 7, 16], priority: 8 });
      const hit = (d.search || []).find(u => u && String(u.name || '').toLowerCase() === name.toLowerCase());
      drop();
      if (hit && this.pasteAdd(ps, hit.id, hit.name)) this.pool = null;
      else if (!hit) ps.notFound = [...ps.notFound, name].slice(-60);
    } catch (e) {
      if (e.kind === 'soft') { drop(); ps.notFound = [...ps.notFound, name].slice(-60); } else ps.lookupRetryAt = Date.now() + RETRY;
    }
  }

  // ---- Torn API jobs during your trip ----
  nextJob(now, trip) {
    const d = this.db.data;
    if (!d.me || d.me.trip !== trip.key) return { kind: 'mystats' };
    if (this.lootingAuto() && (!d.merits || now - d.merits.at >= MERITS_EVERY) && !(d.merits && d.merits.retryAt > now)) return { kind: 'merits' };
    if ((!d.types || !d.types.cruise || now - d.types.at >= TYPES_EVERY) && !(d.types && d.types.retryAt > now)) return { kind: 'types' };
    const ps = this.pasteFor(trip);
    if (ps && ps.lookups.length && !(ps.lookupRetryAt > now)) return { kind: 'lookup', name: ps.lookups[0] };
    let best = null;
    const consider = (pri, job) => { if (!best || pri < best.pri) best = { ...job, pri }; };
    for (const id of this.pool || []) {
      const p = d.players[id];
      if (p && p.retryAt > now) continue;
      if (this.muggedHere(p, trip.country, now)) continue; // mug protected: not checked again for now
      if (p && p.invalid && now - p.at < 86400e3) continue;
      const checked = p && p.tripKey === trip.key ? p.at : 0;
      if (!checked) { consider(-3e12, { kind: 'profile', id }); continue; }
      const near = this.near(p, trip.country);
      if (near) {
        if (!p.job || p.job.trip !== trip.key) { consider(-2e12, { kind: 'job', id }); continue; }
        if (!p.rec || now - p.rec.at >= RECORD_EVERY) { consider(-2e12 + 1, { kind: 'record', id }); continue; }
        // Item market: as overdue as a location check would be (it used to wait for every location check,
        // so with many players near you it never came round).
        if (p.place.kind === 'here' && (!p.trade || now - p.trade.at >= this.marketEvery())) consider(p.trade ? -(now - p.trade.at - this.marketEvery()) : -1e12, { kind: 'trading', id });
      }
      const every = !near ? FAR_EVERY : p.place.kind === 'flying' ? FLYING_EVERY : this.hereEvery();
      const due = every - (now - checked);
      if (due <= 0) consider(due, { kind: 'profile', id });
    }
    return best;
  }

  async runJob(job, trip) {
    this.inFlight = true;
    this.calls.push(Date.now());
    try {
      const run = { mystats: () => this.fetchMyStats(trip), merits: () => this.fetchMerits(), types: () => this.fetchTypes(), profile: () => this.fetchProfile(job.id, trip), job: () => this.fetchJob(job.id, trip), record: () => this.fetchRecord(job.id, trip), trading: () => this.fetchTrading(job.id, trip), lookup: () => this.fetchLookup(job.name, trip) }[job.kind];
      await run();
    } finally {
      this.inFlight = false;
      this.db.save();
      if (job.kind === 'profile') this.updateWatch(trip);
      this.emitSoon();
    }
  }

  player(id) {
    const ps = this.db.data.players;
    return ps[id] || (ps[id] = { id });
  }

  async fetchMyStats(trip) {
    try {
      const d = await this.api.request('/v2/user/battlestats', { soft: [16], priority: 7 });
      const b = d.battlestats || {};
      const v = k => (b[k] && b[k].value) || 0;
      const total = (typeof b.total === 'number' ? b.total : 0) || v('strength') + v('defense') + v('speed') + v('dexterity');
      this.db.data.me = { trip: trip.key, total, strength: v('strength'), defense: v('defense'), speed: v('speed'), dexterity: v('dexterity'), at: Date.now() };
    } catch (e) {
      this.db.data.me = { trip: trip.key, denied: e.kind === 'soft', error: e.message, at: Date.now() };
    }
  }

  async fetchMerits() {
    try {
      const mine = await this.api.request('/v2/user/merits', { soft: [16], priority: 8 });
      const all = await this.api.request('/v2/torn/merits', { soft: [16], priority: 8 });
      const def = ((all && all.merits) || []).find(m => /masterful looting/i.test(m.name || ''));
      const up = def && ((mine && mine.merits && mine.merits.upgrades) || []).find(u => u.id === def.id);
      this.db.data.merits = { looting: def ? (up ? up.level : 0) : null, at: Date.now() };
    } catch (e) {
      this.db.data.merits = { ...(this.db.data.merits || { looting: null, at: 0 }), retryAt: Date.now() + (e.kind === 'soft' ? 86400e3 : RETRY) };
    }
  }

  // Company type ids named like "Clothing Store" (for the 75% cut).
  async fetchTypes() {
    try {
      const d = await this.api.request('/v2/torn/companies', { soft: [16], priority: 8 });
      const ids = [], cruise = [];
      const walk = (o, key) => {
        if (!o || typeof o !== 'object') return;
        if (Array.isArray(o)) { o.forEach(x => walk(x)); return; }
        if (typeof o.name === 'string' && /clothing/i.test(o.name)) { const id = Number(o.id ?? key); if (Number.isFinite(id)) ids.push(id); }
        if (typeof o.name === 'string' && /cruise/i.test(o.name)) { const id = Number(o.id ?? key); if (Number.isFinite(id)) cruise.push(id); }
        for (const [k, v] of Object.entries(o)) if (v && typeof v === 'object') walk(v, k);
      };
      walk(d);
      this.db.data.types = { clothing: [...new Set(ids)], cruise: [...new Set(cruise)], at: Date.now() };
    } catch (e) {
      this.db.data.types = { ...(this.db.data.types || { clothing: [], at: 0 }), retryAt: Date.now() + RETRY };
    }
  }

  async fetchProfile(id, trip) {
    const p = this.player(id);
    const now = Date.now();
    try {
      const d = await this.api.request(`/user/${id}?selections=profile`, { soft: [6, 7], priority: 8 });
      this.emit('profile', id, d);
      const st = d.status || {};
      const same = p.tripKey === trip.key;
      const prev = same ? p.place : null;
      const prevAt = same ? p.at : 0;
      const wasHosp = !!(p.place && p.place.kind === 'hospital');
      if (!same) Object.assign(p, { tripKey: trip.key, awaySince: 0, trade0: null, trade: null, flight: null });
      p.name = d.name || p.name || '';
      p.level = d.level || 0;
      p.age = d.age || 0;
      p.faction = d.faction && d.faction.faction_name ? { id: d.faction.faction_id, name: d.faction.faction_name } : null;
      p.status = { state: st.state || '', description: st.description || '', details: String(st.details || '').replace(/<[^>]*>/g, ''), until: (st.until || 0) * 1000, plane: st.plane_image_type || '' };
      p.life = d.life ? { current: d.life.current, maximum: d.life.maximum } : null;
      p.lastAction = d.last_action ? { status: d.last_action.status || '', at: (d.last_action.timestamp || 0) * 1000 } : null;
      p.invalid = false;
      p.retryAt = 0;
      const inCountry = st.state === 'Abroad' ? placeOf(st).place : '';
      if (inCountry) p.lastIn = inCountry;
      else if (st.state !== 'Hospital') p.lastIn = '';
      p.place = placeOf(st, p.lastIn);
      this.trackFlight(p, prev, prevAt, now);
      // Away from Torn since: the departure we saw, else the first time we saw them away this trip.
      const away = p.place.place && p.place.place !== 'Torn';
      if (away && !p.awaySince) p.awaySince = p.flight && p.flight.departLo ? Math.round((p.flight.departLo + p.flight.departHi) / 2) : now;
      if (!away) p.awaySince = 0;
      // In hospital abroad: maybe mugged, and then what they had left is protected for up to 12 hours.
      // Kept across trips from the first sighting of the stay; a "Mugged by" reason confirms it.
      if (p.place.kind === 'hospital' && p.place.place && p.place.place !== 'Torn' && BY_PLAYER.test(p.status.details)) {
        const h = p.hosp;
        const cont = wasHosp && h && h.place === p.place.place && now - h.seen < SAME_STAY;
        p.hosp = { at: cont ? h.at : now, seen: now, place: p.place.place, text: p.status.details, mugged: /mugg/i.test(p.status.details) || !!(cont && h.mugged) };
      }
      delete p.mugged;
      p.at = now;
      // On the pasted list but no longer in (or flying to) this country: off the list.
      const ps = this.pasteFor(trip);
      if (ps && ps.ids.includes(Number(id)) && !this.near(p, trip.country)) {
        ps.ids = ps.ids.filter(x => x !== Number(id));
        ps.left = [{ id: Number(id), name: p.name, at: now, to: p.place.kind === 'flying' ? p.place.place : (p.place.place || '') }, ...ps.left].slice(0, 30);
        this.pool = null;
      }
    } catch (e) {
      if (e.kind === 'soft') {
        p.invalid = true; p.at = now; p.error = e.message;
        const ps = this.pasteFor(trip);
        if (ps && ps.ids.includes(Number(id))) { ps.ids = ps.ids.filter(x => x !== Number(id)); ps.notFound = [...ps.notFound, `#${id}`].slice(-60); this.pool = null; }
      } else p.retryAt = now + RETRY;
    }
  }

  async fetchJob(id, trip) {
    const p = this.player(id);
    try {
      const d = await this.api.request(`/v2/user/${id}/job`, { soft: [6, 7, 16], priority: 8 });
      const j = d.job || null;
      const types = (this.db.data.types && this.db.data.types.clothing) || [];
      p.job = j && j.type === 'company'
        ? { trip: trip.key, company: j.name || '', typeId: j.type_id, rating: j.rating || 0, clothing: types.includes(Number(j.type_id)), cruise: ((this.db.data.types && this.db.data.types.cruise) || []).includes(Number(j.type_id)) }
        : { trip: trip.key, company: '', job: j ? String(j.name || '') : '', rating: 0, clothing: false };
    } catch (e) {
      if (e.kind === 'soft') p.job = { trip: trip.key, error: e.message }; else p.retryAt = Date.now() + RETRY;
    }
  }

  // Travel record: trips and items bought abroad (all time, per country) and a week ago.
  async fetchRecord(id, trip) {
    const p = this.player(id);
    try {
      const d = await this.api.request(`/v2/user/${id}/personalstats?cat=travel`, { soft: [6, 7, 16], priority: 8 });
      const t = (d.personalstats && d.personalstats.travel) || {};
      const per = {};
      for (const c of COUNTRIES) per[c.name] = Number(t[COUNTRY_STATS[c.code]]) || 0;
      const rec = { trip: trip.key, at: Date.now(), now: { trips: Number(t.total) || 0, items: Number(t.items_bought) || 0, defendsLost: Number(t.defends_lost) || 0, attacksWon: Number(t.attacks_won) || 0 }, per, favourite: '', week: null };
      let n = 0;
      for (const [name, v] of Object.entries(per)) if (v > n) { n = v; rec.favourite = name; }
      try {
        const ts = Math.floor((Date.now() - WEEK) / 1000);
        const w = await this.api.request(`/v2/user/${id}/personalstats?stat=itemsboughtabroad,traveltimes&timestamp=${ts}`, { soft: [6, 7, 16], priority: 9 });
        const then = {};
        for (const x of w.personalstats || []) if (x && x.name) then[x.name] = Number(x.value) || 0;
        if ('itemsboughtabroad' in then || 'traveltimes' in then) rec.week = { items: Math.max(0, rec.now.items - (then.itemsboughtabroad || 0)), trips: Math.max(0, rec.now.trips - (then.traveltimes || 0)) };
      } catch (e) { rec.weekError = e.message; }
      // Fights lost abroad since yesterday (Torn keeps this by day, without the country): a mug is one.
      try {
        const ts = Math.floor((Date.now() - DAY) / 1000);
        const y = await this.api.request(`/v2/user/${id}/personalstats?stat=defendslostabroad&timestamp=${ts}`, { soft: [6, 7, 16], priority: 9 });
        const x = (y.personalstats || []).find(s => s && s.name === 'defendslostabroad');
        if (x) rec.lostAbroad = { n: Math.max(0, rec.now.defendsLost - (Number(x.value) || 0)), since: ts * 1000 };
      } catch (e) { rec.lostError = e.message; }
      p.rec = rec;
    } catch (e) {
      if (e.kind === 'soft') p.rec = { trip: trip.key, at: Date.now(), error: e.message }; else p.retryAt = Date.now() + RETRY;
    }
  }

  // Trading stats. The first reading this trip is the baseline: item market revenue (less fees)
  // added since went into their wallet while they were away.
  async fetchTrading(id, trip) {
    const p = this.player(id);
    try {
      const d = await this.api.request(`/v2/user/${id}/personalstats?cat=trading`, { soft: [6, 7, 16], priority: 8 });
      const t = (d.personalstats && d.personalstats.trading) || {};
      const im = t.item_market || {}, bz = t.bazaar || {};
      const r = { at: Date.now(), revenue: Number(im.revenue) || 0, fees: Number(im.fees) || 0, imSales: Number(im.sales) || 0, bzSales: Number(bz.sales) || 0, bzCustomers: Number(bz.customers) || 0 };
      if (!p.trade0 || p.trade0.trip !== trip.key) p.trade0 = { ...r, trip: trip.key };
      p.trade = r;
    } catch (e) {
      if (e.kind === 'soft') p.trade = { at: Date.now(), error: e.message }; else p.retryAt = Date.now() + RETRY;
    }
  }

  // Landing window for someone flying (as on the War tab): the departure is caught when they switch
  // to Traveling between two checks; flight times from the travel table.
  trackFlight(p, prev, prevAt, now) {
    const st = p.status;
    if (st.state !== 'Traveling') { p.flight = null; return; }
    const t = parseTrip(st.description);
    if (!t || !t.country) { p.flight = null; return; }
    if (!p.flight || p.flight.desc !== st.description) {
      const seen = prev && prev.kind !== 'flying' && prevAt && now - prevAt < 25 * 60e3;
      p.flight = { desc: st.description, departLo: seen ? prevAt : 0, departHi: now };
    }
    const plane = ['private_jet', 'light_aircraft', 'airliner'].includes(st.plane) ? st.plane : '';
    const f = flightRange(t.country, plane, this.store.get('travel.learned') || {});
    p.flight.landLo = p.flight.departLo ? p.flight.departLo + f.lo * 0.75 * 0.97 : 0; // a travel book can cut 25%
    p.flight.landHi = p.flight.departHi + f.hi;
  }

  // ---- Ticks ----
  tick(now) {
    this.mdb.tick(now); // the market database collects whether or not you travel
    const trip = this.trip();
    const d = this.db.data;
    if (trip && (!d.trip || d.trip.key !== trip.key)) { d.trip = { ...trip, startedAt: now }; this.pool = null; this.db.save(); }
    if (!trip) {
      if (this.mdb.watchIds.size) this.mdb.watch([]);
      this.pool = null;
      return;
    }
    // Flying out: the best traders for the country. Landed with a pasted People list: only those people.
    const mode = this.pasteActive(trip) ? 'paste' : 'pool';
    if (!this.pool || this.poolMode !== mode || now - (this.poolAt || 0) > 5 * 60e3) {
      this.pool = mode === 'paste' ? [...this.pasteFor(trip).ids] : this.candidates(trip.country);
      this.poolMode = mode;
      this.poolAt = now;
      this.prune(now);
      this.updateWatch(trip);
    }
    if (!this.api.hasKey() || this.inFlight) return;
    this.calls = this.calls.filter(t => now - t < 60e3);
    if (this.calls.length >= this.rate()) return;
    const job = this.nextJob(now, trip);
    if (job) this.runJob(job, trip).catch(() => {});
  }

  // Re-read the bazaars of the players near you every 5 minutes (the items they hold most of).
  updateWatch(trip) {
    const items = this.mdb.items();
    const want = new Map();
    for (const id of this.pool || []) {
      const p = this.db.data.players[id];
      if (!p || p.tripKey !== trip.key || !this.near(p, trip.country)) continue;
      const info = this.sellerInfo(id, items, trip.country);
      for (const i of info ? info.items.slice(0, 2) : []) want.set(i.id, (want.get(i.id) || 0) + i.q * i.cost);
    }
    this.mdb.watch([...want.entries()].sort((a, b) => b[1] - a[1]).map(e => e[0]));
  }

  prune(now) {
    const keep = new Set((this.pool || []).map(String));
    for (const [id, p] of Object.entries(this.db.data.players)) if (!keep.has(id) && now - (p.at || 0) > PLAYER_KEEP) delete this.db.data.players[id];
  }

  // FFScouter: the players near you this trip (fetched once each; see the top).
  ffIds() {
    const trip = this.trip();
    if (!trip) return [];
    return (this.pool || []).filter(id => { const p = this.db.data.players[id]; return p && p.tripKey === trip.key && this.near(p, trip.country) && !this.muggedHere(p, trip.country); }).slice(0, 150);
  }

  // Check where they are again now (keeps what this trip has learned about them).
  recheck(id) {
    for (const [pid, p] of Object.entries(this.db.data.players)) {
      if (id && Number(pid) !== id) continue;
      if (p.at) p.at = 1;
      p.retryAt = 0;
    }
    this.poolAt = 0;
    this.db.save();
    this.emitSoon();
  }

  emitSoon() {
    if (this.emitTimer) return;
    this.emitTimer = setTimeout(() => { this.emitTimer = null; this.emit('state'); }, 400);
  }

  // ---- For the page ----
  snapshot() {
    const now = Date.now();
    const country = this.location();
    const trip = this.trip();
    const live = this.live();
    const items = this.mdb.items();
    const players = this.db.data.players;
    this.listed = new Set((this.extraIds() || []).map(Number));
    const rows = [];
    const mugged = [];
    const places = {};
    let checked = 0;
    if (live) {
      for (const id of this.pool || []) {
        const p = players[id];
        const pr = this.muggedHere(p, country, now);
        if (pr) { mugged.push({ id, name: p.name || '', level: p.level || 0, at: pr.at, ends: pr.ends, text: pr.text, inHospital: pr.now }); continue; }
        if (!p || p.tripKey !== trip.key || !p.at) continue;
        checked++;
        if (p.place && p.place.place && p.place.place !== 'Torn') {
          const k = `${p.place.place}${p.place.kind === 'flying' ? '|flying' : ''}`;
          places[k] = (places[k] || 0) + 1;
        }
        if (!this.near(p, country)) continue;
        const info = this.sellerInfo(id, items, country, now);
        const rec = p.rec && !p.rec.error ? p.rec : null;
        rows.push(this.row(id, p, info, rec, this.cashNow(p, info, rec, country, items), country, true));
      }
    } else {
      for (const id of this.candidates(country).slice(0, 40)) {
        const p = players[id] || null;
        rows.push(this.row(id, p, this.sellerInfo(id, items, country, now), this.record(id), null, country, false));
      }
    }
    rows.sort((a, b) => b.score.total - a.score.total);
    return {
      country, live, trip,
      choice: String(this.store.get('mugger.location') || 'auto'),
      db: { ...this.mdb.stats(), scan: this.mdb.scan, remote: this.mdb.remote(), watching: [...this.mdb.watchIds].map(i => (items.get(i) || {}).name || `#${i}`) },
      pool: (this.pool || []).length, checked, places, rows, mugged: mugged.sort((a, b) => b.at - a.at),
      poolMode: live ? this.poolMode || 'pool' : 'pool',
      paste: (() => {
        const ps = trip ? this.pasteFor(trip) : null;
        if (!ps) return null;
        return { count: ps.ids.length, active: this.pasteActive(trip), at: ps.at, lookups: ps.lookups.length, notFound: ps.notFound.slice(-8), notFoundCount: ps.notFound.length, left: ps.left.slice(0, 6), leftCount: ps.left.length, traders: ps.ids.filter(id => this.mdb.seller(id)).length };
      })(),
      me: this.db.data.me,
      mug: { looting: this.looting(), lootingAuto: this.lootingAuto(), merits: this.db.data.merits, plunder: this.plunder(), mult: this.mult() },
      settings: { minCost: this.minCost(), pool: this.poolSize(), rate: this.rate(), here: this.hereEvery() / 60e3, market: this.marketEvery() / 60e3, looting: this.lootingAuto() ? 'auto' : this.looting(), plunder: this.plunder() },
      countries: COUNTRIES.map(c => c.name),
    };
  }

  row(id, p, info, rec, cash, country, live) {
    const pt = this.perTrip(rec, p);
    const restock = info && info.ev.filter(e => e.dq > TRADE_QTY).slice(-1)[0];
    return {
      id, name: (p && p.name) || (info && info.name) || '', live,
      level: p ? p.level : 0, age: p ? p.age : 0, faction: p ? p.faction : null,
      status: live ? p.status : null, place: live ? p.place : null, flight: live ? p.flight : null,
      life: live ? p.life : null, lastAction: live ? p.lastAction : null, checkedAt: live ? p.at : 0,
      awaySince: live ? p.awaySince : 0, protect: live ? this.protection(p, country) : null, job: p ? p.job : null,
      listed: this.listed.has(id),
      market: info && {
        items: info.items.slice(0, 8), small: info.small.slice(0, 6), small30: info.small30, spec: info.spec.slice(0, 4), specCustomers: info.specCustomers, busiest: info.busiest, income: info.income, bulk: info.bulk, bazaar: info.bazaar, value: info.value, listed: info.listed, r30: info.r30, rc30: info.rc30, s30: info.s30, sv30: info.sv30,
        active: info.active, days: info.days, first: info.first, ev: info.ev, sellsHere: info.sellsHere, rc30Here: info.rc30Here, r30Here: info.r30Here,
        lastRestock: restock ? { ...restock, trips: pt && pt.n ? restock.dq / pt.n : null } : null,
      },
      rec, perTrip: pt, tripCash: this.tripCash(info, rec, country, p), tripUnknown: this.tripUnknown(info, country), cash, take: live ? this.mugTake(cash, p) : null,
      trade: live && p.trade && !p.trade.error ? { since: p.trade0 ? p.trade0.at : 0, at: p.trade.at } : null,
      ...(() => { const sc = this.score(info, rec, cash, country); return { score: sc.here, overall: sc.all }; })(),
    };
  }

  flush() { this.db.flush(); }
}

module.exports = { MuggerFeature, placeOf, myTrip, MUG, parsePeople };
