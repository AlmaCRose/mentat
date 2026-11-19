'use strict';
// Bookmaker odds for the Casino tab's Bookie helper, from The Odds API (the-odds-api.com, free plan:
// 500 credits a month, 1 credit per sport fetched). Members type in Torn's price for a match; the app
// compares it with the market's fair chance, worked out here from real bookmakers' prices.
//
// Credits are rationed: each sport's odds are kept for 3 hours (and on disk, so a restart doesn't
// spend more), and each day may only use its share of what's left this month. When the share is
// used up, the last odds fetched are served, marked as old. The key is a root-only credential
// (sudo torn-desktop-set-odds); without it these endpoints say the service isn't set up.

const fs = require('fs');
const path = require('path');

const BASE = 'https://api.the-odds-api.com/v4';
const SPORTS_TTL = 12 * 3600e3;
const ODDS_TTL = 3 * 3600e3;
const MIN_GAP = 20e3; // between paid requests
const REGION = 'eu'; // includes Pinnacle, the sharpest book (its prices make the best "fair" line)
// The scan for likely winners: the big leagues Torn's Bookie carries, each refreshed at most once a
// day (about 10 credits a day, leaving the rest of the day's share for sports people open by hand).
// Leagues Torn's Bookie carries. Per the user (2026-11-18): NCAAF yes; NCAAB only some games (still being checked),
// so it stays in: a game Torn doesn't list is easy to skip, a missing one can't be found.
const TOP_SPORTS = [
  'basketball_nba', 'americanfootball_nfl', 'icehockey_nhl', 'baseball_mlb', 'soccer_epl', 'soccer_spain_la_liga',
  'soccer_germany_bundesliga', 'soccer_italy_serie_a', 'soccer_france_ligue_one', 'soccer_uefa_champs_league',
  'americanfootball_ncaaf', 'basketball_ncaab', 'soccer_usa_mls', 'mma_mixed_martial_arts',
];
const TOP_TTL = 24 * 3600e3;
const TOP_SHOW = 7 * 86400e3; // matches starting within a week

const daysLeftInMonth = (now = new Date()) => {
  const last = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).getUTCDate();
  return last - now.getUTCDate() + 1;
};
const dayOf = t => new Date(t).toISOString().slice(0, 10);

// One event's odds -> the fair chance of each outcome (no bookmaker margin) and the best price.
function summarize(ev) {
  const books = [];
  for (const b of ev.bookmakers || []) {
    const m = (b.markets || []).find(x => x.key === 'h2h');
    if (!m || !Array.isArray(m.outcomes) || m.outcomes.length < 2) continue;
    books.push({ key: b.key, title: b.title, prices: Object.fromEntries(m.outcomes.filter(o => o.price > 1).map(o => [o.name, Number(o.price)])) });
  }
  const names = [];
  for (const n of [ev.home_team, ev.away_team, 'Draw']) if (n && books.some(b => b.prices[n])) names.push(n);
  for (const b of books) for (const n of Object.keys(b.prices)) if (!names.includes(n)) names.push(n);
  const fairOf = b => {
    if (!names.every(n => b.prices[n])) return null;
    const imp = names.map(n => 1 / b.prices[n]);
    const sum = imp.reduce((a, x) => a + x, 0);
    return { fair: imp.map(x => x / sum), margin: sum - 1 };
  };
  const sharp = books.find(b => b.key === 'pinnacle');
  let fair = sharp && fairOf(sharp) ? fairOf(sharp).fair : null;
  let source = fair ? 'Pinnacle, margin removed' : '';
  if (!fair) {
    const all = books.map(fairOf).filter(Boolean);
    if (!all.length) return null;
    fair = names.map((_, i) => all.reduce((a, f) => a + f.fair[i], 0) / all.length);
    const s = fair.reduce((a, x) => a + x, 0);
    fair = fair.map(x => x / s);
    source = `average of ${all.length} bookmaker${all.length === 1 ? '' : 's'}, margin removed`;
  }
  const margins = books.map(fairOf).filter(Boolean).map(f => f.margin);
  return {
    id: String(ev.id), start: Date.parse(ev.commence_time) || 0, home: ev.home_team || '', away: ev.away_team || '',
    source, books: books.length, typicalMargin: margins.length ? margins.sort((a, b) => a - b)[Math.floor(margins.length / 2)] : null,
    outcomes: names.map((name, i) => {
      let best = 0, bestBook = '';
      for (const b of books) if ((b.prices[name] || 0) > best) { best = b.prices[name]; bestBook = b.title; }
      return { name, fair: fair[i], fairOdds: fair[i] ? 1 / fair[i] : 0, best, bestBook };
    }),
  };
}

class Odds {
  constructor({ key, dataDir, log = () => {}, fetchFn = fetch }) {
    this.key = String(key || '').trim();
    this.file = path.join(dataDir, 'odds-cache.json');
    this.log = log;
    this.fetch = fetchFn;
    this.lastPaid = 0;
    this.inFlight = new Map();
    this.c = { sports: null, sportsAt: 0, odds: {}, remaining: null, used: null, day: '', usedToday: 0, allowToday: null, error: '' };
    try { Object.assign(this.c, JSON.parse(fs.readFileSync(this.file, 'utf8'))); } catch (e) { /* first run */ }
  }

  configured() { return !!this.key; }

  save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(`${this.file}.tmp`, JSON.stringify(this.c));
      fs.renameSync(`${this.file}.tmp`, this.file);
    } catch (e) { this.log('Odds cache not saved:', e.message); }
  }

  budget(now = Date.now()) {
    const today = dayOf(now);
    if (this.c.day !== today) {
      this.c.day = today;
      this.c.usedToday = 0;
      // Today's share of what's left this month (unknown before the first request: allow a few).
      this.c.allowToday = this.c.remaining == null ? 5 : Math.max(0, Math.floor(this.c.remaining / daysLeftInMonth(new Date(now))));
    }
    return { remaining: this.c.remaining, usedToday: this.c.usedToday, allowToday: this.c.allowToday };
  }

  async call(p, paid) {
    const url = `${BASE}${p}${p.includes('?') ? '&' : '?'}apiKey=${encodeURIComponent(this.key)}`;
    const res = await this.fetch(url, { headers: { Accept: 'application/json', 'User-Agent': 'Mentat' }, signal: AbortSignal.timeout(15000) });
    const rem = res.headers.get('x-requests-remaining');
    const used = res.headers.get('x-requests-used');
    if (rem != null && rem !== '') this.c.remaining = Number(rem);
    if (used != null && used !== '') this.c.used = Number(used);
    if (paid) { this.c.usedToday++; this.lastPaid = Date.now(); }
    if (res.status === 401) throw Object.assign(new Error('The odds service key was refused. The server admin can set a new one.'), { status: 503 });
    if (res.status === 429) throw Object.assign(new Error('The odds service is out of credits for now; showing the last odds fetched.'), { status: 503 });
    if (!res.ok) throw Object.assign(new Error(`The odds service answered ${res.status}.`), { status: 502 });
    return res.json();
  }

  status() {
    const b = this.budget();
    return { configured: this.configured(), remaining: b.remaining, usedToday: b.usedToday, allowToday: b.allowToday };
  }

  // Sports in season (the list is free).
  async sports() {
    if (!this.configured()) throw Object.assign(new Error('Live odds aren\'t set up on this server yet.'), { status: 503, code: 'odds_off' });
    const now = Date.now();
    if (!this.c.sports || now - this.c.sportsAt > SPORTS_TTL) {
      try {
        const list = await this.call('/sports', false);
        this.c.sports = (Array.isArray(list) ? list : []).filter(s => s.active && !s.has_outrights).map(s => ({ key: s.key, group: s.group, title: s.title }));
        this.c.sportsAt = now;
        this.save();
      } catch (e) { if (!this.c.sports) throw e; }
    }
    return { sports: this.c.sports, budget: this.status() };
  }

  // Likely winners across the big leagues: every cached match (refreshed at most daily), and a quiet
  // background fetch of leagues not seen today, one at a time, within the day's share of credits.
  async top() {
    if (!this.configured()) throw Object.assign(new Error('Live odds aren\'t set up on this server yet.'), { status: 503, code: 'odds_off' });
    await this.sports();
    const now = Date.now();
    const titles = Object.fromEntries((this.c.sports || []).map(x => [x.key, x.title]));
    const keys = TOP_SPORTS.filter(k => titles[k]);
    const due = keys.filter(k => !this.c.odds[k] || now - this.c.odds[k].at > TOP_TTL);
    if (due.length && !this.scanning) this.scanDue([...due]);
    const events = [];
    for (const k of keys) {
      const have = this.c.odds[k];
      if (!have) continue;
      for (const ev of have.events) if (ev.start > now && ev.start < now + TOP_SHOW) events.push({ ...ev, sport: k, sportTitle: titles[k] });
    }
    events.sort((a, b) => a.start - b.start);
    return { sports: keys.map(k => ({ key: k, title: titles[k], at: (this.c.odds[k] || {}).at || 0 })), events, scanning: !!this.scanning, pending: due.length, budget: this.status() };
  }

  scanDue(due) {
    this.scanning = true;
    const next = async () => {
      const k = due.shift();
      const b = this.budget();
      if (!k || !((b.remaining == null || b.remaining > 0) && b.usedToday < b.allowToday)) { this.scanning = false; return; }
      const wait = Math.max(0, this.lastPaid + MIN_GAP + 500 - Date.now());
      setTimeout(async () => {
        try { if (!this.c.odds[k] || Date.now() - this.c.odds[k].at > TOP_TTL) await this.events(k); } catch (e) { /* that league stays out for now */ }
        next();
      }, wait).unref?.();
    };
    next();
  }

  // One sport's upcoming matches with fair chances. Cached for 3 hours; rationed per day.
  async events(sport) {
    if (!this.configured()) throw Object.assign(new Error('Live odds aren\'t set up on this server yet.'), { status: 503, code: 'odds_off' });
    sport = String(sport || '');
    if (!/^[a-z0-9_]{2,60}$/.test(sport)) throw Object.assign(new Error('Unknown sport.'), { status: 400 });
    if (this.c.sports && !this.c.sports.some(s => s.key === sport)) throw Object.assign(new Error('That sport isn\'t in season.'), { status: 400 });
    const now = Date.now();
    const have = this.c.odds[sport];
    if (have && now - have.at < ODDS_TTL) return { sport, fetchedAt: have.at, events: have.events, stale: false, budget: this.status() };
    const b = this.budget(now);
    const canSpend = (b.remaining == null || b.remaining > 0) && b.usedToday < b.allowToday && now - this.lastPaid > MIN_GAP;
    if (!canSpend) {
      if (have) return { sport, fetchedAt: have.at, events: have.events, stale: true, note: 'Today\'s share of odds requests is used up, so these are the last odds fetched.', budget: this.status() };
      throw Object.assign(new Error('Today\'s share of odds requests is used up. Try again tomorrow, or pick a sport someone has already loaded today.'), { status: 503 });
    }
    if (this.inFlight.has(sport)) return this.inFlight.get(sport);
    const job = (async () => {
      try {
        const list = await this.call(`/sports/${sport}/odds?regions=${REGION}&markets=h2h&oddsFormat=decimal&dateFormat=iso`, true);
        const events = (Array.isArray(list) ? list : []).map(summarize).filter(Boolean).sort((a, b2) => a.start - b2.start).slice(0, 80);
        this.c.odds[sport] = { at: Date.now(), events };
        // Keep the cache small: drop sports not asked for in 3 days.
        for (const [k, v] of Object.entries(this.c.odds)) if (Date.now() - v.at > 3 * 86400e3) delete this.c.odds[k];
        this.save();
        this.log(`Odds: fetched ${sport} (${events.length} matches, ${this.c.remaining ?? '?'} credits left this month).`);
        return { sport, fetchedAt: this.c.odds[sport].at, events, stale: false, budget: this.status() };
      } catch (e) {
        this.save();
        if (have) return { sport, fetchedAt: have.at, events: have.events, stale: true, note: e.message, budget: this.status() };
        throw e;
      } finally { this.inFlight.delete(sport); }
    })();
    this.inFlight.set(sport, job);
    return job;
  }
}

module.exports = { Odds, summarize, daysLeftInMonth, TOP_SPORTS };
