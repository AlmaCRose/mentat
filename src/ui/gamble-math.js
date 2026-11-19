'use strict';
// The maths behind the Casino tab: pure functions, no page or API access (also loaded by tests in
// Node). Torn's rules as researched in Nov 2026 from the Torn wiki and forums; the ones marked
// ASSUMED couldn't be confirmed and are shown as such in the app.

const GM = (() => {
  // ---------------------------------------------------------------- Blackjack
  // Torn: 8 decks shuffled every game, dealer stands on soft 17, blackjack pays 3:2, double on any two
  // cards and after a split, one split (no re-split; split aces may draw), early surrender (half back),
  // no dealer peek (a dealer blackjack takes doubled and split stakes too), insurance pays 2:1,
  // Six Card Charlie (6 cards without busting wins, except against a dealer blackjack).
  // ASSUMED: a Charlie pays 1:1; a split hand of A+10 counts as 21, not blackjack.
  const BJ = { decks: 8, charlie: 6 };
  const RANKS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]; // 1 = ace, 10 = ten/J/Q/K

  function shoe(known) {
    const c = {};
    for (const r of RANKS) c[r] = r === 10 ? 16 * BJ.decks : 4 * BJ.decks;
    for (const k of known) if (c[k] > 0) c[k]--;
    const total = RANKS.reduce((s, r) => s + c[r], 0);
    const p = {};
    for (const r of RANKS) p[r] = c[r] / total;
    return p;
  }
  const add = (total, soft, r) => {
    let t = total + r;
    let s = soft;
    if (r === 1 && t + 10 <= 21) { t += 10; s = true; }
    if (t > 21 && s) { t -= 10; s = false; }
    return [t, s];
  };
  const handOf = cards => cards.reduce(([t, s], r) => add(t, s, r), [0, false]);

  // Dealer's final result for an upcard: { bj, bust, 17..21 } (the hole card comes from the shoe).
  function dealerDist(up, p) {
    const out = { bj: 0, bust: 0, 17: 0, 18: 0, 19: 0, 20: 0, 21: 0 };
    const memo = new Map();
    const play = (t, s) => {
      const k = `${t}|${s}`;
      if (memo.has(k)) return memo.get(k);
      const d = { bust: 0, 17: 0, 18: 0, 19: 0, 20: 0, 21: 0 };
      if (t > 21) d.bust = 1;
      else if (t >= 17) d[t] = 1; // stands on soft 17 too
      else for (const r of RANKS) { const [nt, ns] = add(t, s, r); const sub = play(nt, ns); for (const x in sub) d[x] += p[r] * sub[x]; }
      memo.set(k, d);
      return d;
    };
    const [t0, s0] = add(0, false, up);
    for (const r of RANKS) {
      const [t, s] = add(t0, s0, r);
      if (t === 21) { out.bj += p[r]; continue; } // natural (no peek: found out at the end)
      const sub = play(t, s);
      for (const x in sub) out[x] += p[r] * sub[x];
    }
    return out;
  }

  // Win/push/lose and EV for standing on a total (a bust hand loses).
  function standOdds(t, d) {
    if (t > 21) return { win: 0, push: 0, lose: 1, ev: -1 };
    let win = d.bust, push = 0, lose = d.bj;
    for (const v of [17, 18, 19, 20, 21]) { if (v < t) win += d[v]; else if (v === t) push += d[v]; else lose += d[v]; }
    if (t < 17) win += 0; // dealer always reaches 17+ or busts
    return { win, push, lose, ev: win - lose };
  }

  // Every action's expected value (per unit bet) for a hand against an upcard.
  function blackjack(cards, up) {
    const p = shoe([...cards, up]);
    const d = dealerDist(up, p);
    const charlieEV = 1 - 2 * d.bj;
    const memoHit = new Map();
    const standEV = t => standOdds(t, d).ev;
    const bestNoDouble = (t, s, n) => {
      if (t > 21) return -1;
      if (n >= BJ.charlie) return charlieEV;
      return Math.max(standEV(t), hitEV(t, s, n));
    };
    function hitEV(t, s, n) {
      const k = `${t}|${s}|${n}`;
      if (memoHit.has(k)) return memoHit.get(k);
      let ev = 0;
      for (const r of RANKS) { const [nt, ns] = add(t, s, r); ev += p[r] * bestNoDouble(nt, ns, n + 1); }
      memoHit.set(k, ev);
      return ev;
    }
    const doubleEV = (t, s) => {
      let ev = 0;
      for (const r of RANKS) { const [nt] = add(t, s, r); ev += p[r] * (nt > 21 ? -1 : standEV(nt)); }
      return 2 * ev;
    };
    const [t, s] = handOf(cards);
    const n = cards.length;
    const natural = n === 2 && t === 21;
    const res = { total: t, soft: s && t <= 21, dealer: d, natural };
    if (natural) {
      res.actions = { stand: 1.5 * (1 - d.bj) };
      res.best = 'stand';
      res.standOdds = { win: 1 - d.bj, push: d.bj, lose: 0 };
    } else {
      const a = { stand: t > 21 ? -1 : (n >= BJ.charlie ? charlieEV : standEV(t)) };
      if (t < 21 && n < BJ.charlie) a.hit = hitEV(t, s, n);
      if (n === 2 && t < 21) a.double = doubleEV(t, s);
      if (n === 2) a.surrender = -0.5;
      if (n === 2 && cards[0] === cards[1]) {
        // Each half: the pair card plus one more, then played with doubling allowed, no re-split.
        const c = cards[0];
        let ev = 0;
        for (const r of RANKS) {
          const [ht, hs] = add(...add(0, false, c), r);
          const play = Math.max(bestNoDouble(ht, hs, 2), ht < 21 ? doubleEV(ht, hs) : -Infinity);
          ev += p[r] * (ht === 21 ? standEV(21) : play);
        }
        a.split = 2 * ev;
      }
      res.actions = a;
      res.best = Object.entries(a).sort((x, y) => y[1] - x[1])[0][0];
      res.standOdds = standOdds(t, d);
    }
    // Insurance (dealer shows an ace): pays 2:1 if the hole card makes blackjack.
    if (up === 1) { const p10 = p[10]; res.insurance = { chance: p10, ev: 2 * p10 - (1 - p10) }; }
    res.dealerBust = d.bust;
    return res;
  }

  // ---------------------------------------------------------------- Poker (Texas Hold'em)
  // Cards are 0..51: rank = c % 13 (0 = 2 … 12 = ace), suit = (c / 13) | 0.
  const CATS = ['High card', 'Pair', 'Two pair', 'Three of a kind', 'Straight', 'Flush', 'Full house', 'Four of a kind', 'Straight flush'];
  const straightTop = mask => {
    for (let top = 12; top >= 3; top--) { const need = 0b11111 << (top - 4); if (top === 3) { if ((mask & 0b1111) === 0b1111 && (mask & (1 << 12))) return 3; } else if ((mask & need) === need) return top; }
    return -1;
  };
  // A comparable number for the best five of up to seven cards: category, then kickers.
  function evalHand(cards) {
    const counts = new Array(13).fill(0);
    const suitMask = [0, 0, 0, 0];
    const suitN = [0, 0, 0, 0];
    let mask = 0;
    for (const c of cards) { const r = c % 13, s = (c / 13) | 0; counts[r]++; suitMask[s] |= 1 << r; suitN[s]++; mask |= 1 << r; }
    const score = (cat, ...ks) => ks.slice(0, 5).reduce((v, k) => v * 13 + k, cat) * Math.pow(13, 5 - Math.min(5, ks.length));
    const fs = suitN.findIndex(n => n >= 5);
    if (fs >= 0) { const sf = straightTop(suitMask[fs]); if (sf >= 0) return score(8, sf); }
    const byCount = n => { const out = []; for (let r = 12; r >= 0; r--) if (counts[r] === n) out.push(r); return out; };
    const quads = byCount(4), trips = byCount(3), pairs = byCount(2), singles = byCount(1);
    const high = (ex, n) => { const out = []; for (let r = 12; r >= 0 && out.length < n; r--) if (counts[r] && !ex.includes(r)) out.push(r); return out; };
    if (quads.length) return score(7, quads[0], ...high([quads[0]], 1));
    if (trips.length && (trips.length > 1 || pairs.length)) return score(6, trips[0], trips.length > 1 ? trips[1] : pairs[0]);
    if (fs >= 0) { const out = []; for (let r = 12; r >= 0 && out.length < 5; r--) if (suitMask[fs] & (1 << r)) out.push(r); return score(5, ...out); }
    const st = straightTop(mask);
    if (st >= 0) return score(4, st);
    if (trips.length) return score(3, trips[0], ...high([trips[0]], 2));
    if (pairs.length >= 2) return score(2, pairs[0], pairs[1], ...high([pairs[0], pairs[1]], 1));
    if (pairs.length) return score(1, pairs[0], ...high([pairs[0]], 3));
    return score(0, ...singles.slice(0, 5));
  }
  const category = v => Math.min(8, Math.floor(v / Math.pow(13, 5)));

  // Chance to win / tie against `opponents` random hands, by simulation. `known` = cards seen
  // elsewhere (folded hands you saw, say). Runs `iterations` deals.
  function pokerEquity({ hole, board = [], opponents = 1, known = [], iterations = 20000, rng = Math.random }) {
    const used = new Set([...hole, ...board, ...known]);
    const deck = [];
    for (let c = 0; c < 52; c++) if (!used.has(c)) deck.push(c);
    let win = 0, tie = 0, shares = 0;
    const cats = new Array(9).fill(0);
    const need = 5 - board.length;
    for (let it = 0; it < iterations; it++) {
      // Partial shuffle: just the cards this deal needs.
      const take = need + opponents * 2;
      for (let i = 0; i < take; i++) { const j = i + Math.floor(rng() * (deck.length - i)); const tmp = deck[i]; deck[i] = deck[j]; deck[j] = tmp; }
      const full = board.concat(deck.slice(0, need));
      const mine = evalHand(hole.concat(full));
      cats[category(mine)]++;
      let best = true, tied = 0;
      for (let o = 0; o < opponents; o++) {
        const v = evalHand([deck[need + o * 2], deck[need + o * 2 + 1]].concat(full));
        if (v > mine) { best = false; break; }
        if (v === mine) tied++;
      }
      if (best) { if (tied) { tie++; shares += 1 / (tied + 1); } else win++; }
    }
    return { win: win / iterations, tie: tie / iterations, equity: (win + shares) / iterations, made: cats.map(n => n / iterations), iterations };
  }
  // Pot odds: the share of the final pot you pay to call.
  const potOdds = (pot, call) => (call > 0 ? call / (pot + call) : 0);

  // ---------------------------------------------------------------- High-Low
  // Ranks 2..14 (ace high). `seen` = ranks already dealt in this game; with no tracking, a full deck.
  // Ties replay the hand with the pot unchanged (forum), so they don't count either way.
  // The pot grows by the modifier shown on the game page (15%-35%) on each correct guess.
  function highLow(card, seen = [], modifier = 0.25, decks = 1) {
    const left = {};
    for (let r = 2; r <= 14; r++) left[r] = 4 * decks;
    for (const s of seen) if (left[s] > 0) left[s]--;
    const total = Object.values(left).reduce((a, b) => a + b, 0) || 1;
    let higher = 0, lower = 0, same = 0;
    for (let r = 2; r <= 14; r++) { if (r > card) higher += left[r]; else if (r < card) lower += left[r]; else same += left[r]; }
    higher /= total; lower /= total; same /= total;
    const pick = higher >= lower ? 'higher' : 'lower';
    const pWin = Math.max(higher, lower) / ((1 - same) || 1); // ties replayed
    // Guessing risks the whole pot for `modifier` more: worth it only above 1 / (1 + modifier).
    return { higher, lower, same, pick, pWin, needed: 1 / (1 + modifier), ev: pWin * (1 + modifier), keepGoing: pWin * (1 + modifier) > 1 };
  }

  // ---------------------------------------------------------------- Keno (80 numbers, 10 drawn)
  // Paytable from the Torn wiki (multiples of the bet). null = not confirmed.
  const KENO = {
    1: { 1: 8 }, 2: { 1: 2, 2: 38 }, 3: { 1: null, 2: null, 3: 80 },
    4: { 1: 2, 2: 3, 3: 10, 4: 300 }, 5: { 1: 1.5, 2: 3, 3: 5, 4: 50, 5: 2000 },
    6: { 1: 1.5, 2: 2, 3: 4, 4: 10, 5: 200, 6: 4000 }, 7: { 2: 3, 3: 10, 4: 25, 5: 150, 6: 1000, 7: 5000 },
    8: { 2: 2, 3: 7, 4: 20, 5: 200, 6: 500, 7: 1000, 8: 10000 }, 9: { 2: 2, 3: 5, 4: 10, 5: 70, 6: 200, 7: 1000, 8: 10000, 9: 50000 },
    10: { 2: 1.5, 3: 3, 4: 10, 5: 50, 6: 500, 7: 5000, 8: 10000, 9: 50000, 10: 100000 },
  };
  const choose = (n, k) => { if (k < 0 || k > n) return 0; let r = 1; for (let i = 1; i <= k; i++) r = r * (n - k + i) / i; return r; };
  function kenoOdds(picks) {
    const rows = [];
    let rtp = 0, unknown = false;
    for (let k = 0; k <= picks; k++) {
      const p = choose(picks, k) * choose(80 - picks, 10 - k) / choose(80, 10);
      const pay = KENO[picks][k];
      if (pay === null) unknown = true;
      if (pay) rtp += p * pay;
      rows.push({ matches: k, chance: p, pays: pay === undefined ? 0 : pay });
    }
    return { picks, rows, rtp, unknown };
  }

  // ---------------------------------------------------------------- Bookie
  const implied = o => (o > 1 ? 1 / o : 0);
  // Decimal odds for every outcome of one market -> the bookie's margin and the fair chances.
  function market(odds) {
    const imp = odds.map(implied);
    const sum = imp.reduce((a, b) => a + b, 0);
    return { margin: sum - 1, fair: imp.map(x => (sum ? x / sum : 0)), fairOdds: imp.map(x => (x ? sum / x : 0)) };
  }
  // Value of a price given your (or the market's) chance; Kelly share of bankroll (fraction 1 = full).
  function value(odds, chance) { return odds * chance - 1; }
  function kelly(odds, chance, fraction = 0.25) {
    const b = odds - 1;
    if (b <= 0) return 0;
    const f = (b * chance - (1 - chance)) / b;
    return Math.max(0, f * fraction);
  }

  // ---------------------------------------------------------------- Hedging
  // You hold `stake` at `odds` on one outcome; `others` = today's odds on every other outcome of the
  // match (1 for a 2-way market, 2 for a 3-way one). Profit for each result, given hedge stakes:
  // [if your pick wins, if other 1 wins, ...].
  function hedgeResults(stake, odds, others, stakes) {
    const out = stake + stakes.reduce((a, h) => a + h, 0);
    return [stake * odds - out, ...others.map((o, i) => stakes[i] * o - out)];
  }
  // Same profit whatever happens (it may be a loss, if the odds moved against you).
  function hedgeEqual(stake, odds, others) {
    const stakes = others.map(o => (o > 1 ? (stake * odds) / o : 0));
    return { stakes, results: hedgeResults(stake, odds, others, stakes) };
  }
  // Your money back if your pick loses, everything else riding on it. Impossible when the other
  // prices together carry no room (1/o summed >= 1).
  function hedgeCover(stake, odds, others) {
    const inv = others.reduce((a, o) => a + (o > 1 ? 1 / o : 1), 0);
    if (inv >= 1) return null;
    const total = stake / (1 - inv);
    const stakes = others.map(o => total / o);
    return { stakes, results: hedgeResults(stake, odds, others, stakes) };
  }

  // ---------------------------------------------------------------- reference
  const HOUSE = [
    { game: 'Blackjack', edge: 'about 0% with perfect play (players estimate −0.4% to +0.2%)', note: 'Use the Blackjack helper for every decision; never take insurance.' },
    { game: 'Roulette', edge: '2.70% on every bet', note: 'Single zero (European wheel, per players). No bet is better than another in the long run.' },
    { game: 'Slots', edge: 'about 4.4% (≈95.6% back, measured by a player over 212k spins, jackpot aside)', note: 'Pure chance; the jackpot odds may rise with the stake.' },
    { game: 'Keno', edge: 'depends on how many numbers you pick: see the table', note: 'The Keno table shows which number of picks pays back most.' },
    { game: 'Craps', edge: 'Pass 1.41%, Don\'t Pass 1.36%; other bets usually more', note: 'Stick to Pass/Don\'t Pass (plus odds if offered).' },
    { game: 'High-Low', edge: 'set by the live payout modifier', note: 'Use the High-Low helper: it says when to cash out.' },
    { game: 'Russian Roulette', edge: 'none: player against player, about 50/50', note: 'No house cut; a loss also means a short hospital stay.' },
    { game: 'Spin the Wheel', edge: "unknown: the prizes' chances aren't published", note: "Each spin costs something and the payout odds aren't known, so Mentat can't say whether it's worth it." },
    { game: 'Lottery', edge: 'your tickets ÷ all tickets for the pot', note: 'Worth it only when the pot is larger than everything paid in.' },
    { game: 'Poker', edge: 'no rake', note: 'Player against player: use the Poker helper for odds.' },
  ];

  // ---- Torn's Bookie as it shows on the page ----
  // A price as Torn shows it: fractional "41/50" (win 41 for every 50) or "x1.82" (the stake comes back
  // ×1.82), or plain decimal "1.82". Returns decimal odds (stake × odds back), or 0 when it isn't a price.
  function parseOdds(v) {
    const s = String(v === undefined || v === null ? '' : v).trim().toLowerCase().replace(/^x\s*/, '').replace(',', '.');
    if (!s) return 0;
    if (s === 'evens' || s === 'evs') return 2;
    const f = /^(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)$/.exec(s);
    if (f) return Number(f[2]) > 0 ? Math.round((1 + Number(f[1]) / Number(f[2])) * 10000) / 10000 : 0;
    const n = Number(s);
    return Number.isFinite(n) && n > 1 ? n : 0;
  }
  // Text copied from Torn's Bookie page: one or more matches, each like
  //   Orlando Magic v Philadelphia 76ers - NBA 2026/2027 (USA 1)
  //   2-Way Full event due to start at 00:00:00 - 19/11/2026 TCT
  //   41/50  x1.82  Orlando Magic   $ BET
  //   1/1    x2.00  Philadelphia 76ers
  // Cells can arrive on one line or one per line. Returns [{ home, away, league, market, start (ms), outcomes: [{ name, odds, frac }] }].
  function parseBookie(text) {
    const lines = String(text || '').replace(/\r/g, '').split(/[\n\t]+/).map(s => s.replace(/\s+/g, ' ').trim()).filter(Boolean);
    const events = [];
    let ev = null;
    const start = () => { ev = { home: '', away: '', league: '', market: '', start: 0, outcomes: [] }; events.push(ev); return ev; };
    const FRAC = /^(\d+(?:\.\d+)?\s*\/\s*\d+(?:\.\d+)?)$/;
    const X = /^x\s*(\d+(?:\.\d+)?)$/i;
    const clean = n => String(n || '').replace(/\s*\$.*$/, '').replace(/\s+BET$/i, '').replace(/^BET$/i, '').trim();
    const add = (frac, x, name) => {
      name = clean(name);
      const odds = frac ? parseOdds(frac) : parseOdds(x);
      if (!name || !(odds > 1)) return;
      (ev || start()).outcomes.push({ name, odds, frac: frac ? frac.replace(/\s+/g, '') : '' });
    };
    for (let i = 0; i < lines.length; i++) {
      const L = lines[i];
      let m;
      if ((m = /^(.+?) v (.+?) - (.+)$/.exec(L)) && !FRAC.test(L)) {
        const e = start();
        e.home = m[1].trim(); e.away = m[2].trim(); e.league = m[3].replace(/\s+\d+\s*[smhd]$/i, '').trim(); // drop the "3h" countdown
        continue;
      }
      if ((m = /^(.*?)\s*due to start at (\d{1,2}):(\d{2})(?::(\d{2}))?\s*-\s*(\d{1,2})\/(\d{1,2})\/(\d{4})/i.exec(L))) {
        const e = ev || start();
        e.market = m[1].trim();
        e.start = Date.UTC(Number(m[7]), Number(m[6]) - 1, Number(m[5]), Number(m[2]), Number(m[3]), Number(m[4] || 0));
        continue;
      }
      // One line: "41/50 x1.82 Orlando Magic" (the x part or the fraction may be missing).
      if ((m = /^(\d+(?:\.\d+)?\s*\/\s*\d+(?:\.\d+)?)\s+(?:x\s*(\d+(?:\.\d+)?)\s+)?(.+)$/i.exec(L))) { add(m[1], m[2], m[3]); continue; }
      if ((m = /^x\s*(\d+(?:\.\d+)?)\s+(.+)$/i.exec(L))) { add('', m[1], m[2]); continue; }
      // One cell per line: "41/50", "x1.82", "Orlando Magic".
      if (FRAC.test(L)) {
        const x = X.exec(lines[i + 1] || '');
        const name = lines[i + (x ? 2 : 1)];
        if (name && !FRAC.test(name) && !X.test(name)) { add(L, x ? x[1] : '', name); i += x ? 2 : 1; }
        continue;
      }
      if ((m = X.exec(L))) {
        const name = lines[i + 1];
        if (name && !FRAC.test(name) && !X.test(name)) { add('', m[1], name); i += 1; }
        continue;
      }
      // "Orlando Magic v Philadelphia 76ers" without the league: a new match unless it repeats the current one.
      if ((m = /^(.+?) v (.+)$/.exec(L))) {
        if (ev && ev.home === m[1].trim() && ev.away === m[2].trim()) continue;
        if (ev && !ev.home && !ev.outcomes.length) { ev.home = m[1].trim(); ev.away = m[2].trim(); continue; }
        const e = start();
        e.home = m[1].trim(); e.away = m[2].trim();
      }
    }
    return events.filter(e => e.outcomes.length);
  }

  return { BJ, shoe, handOf, dealerDist, blackjack, evalHand, category, CATS, pokerEquity, potOdds, highLow, KENO, kenoOdds, market, value, kelly, implied, hedgeResults, hedgeEqual, hedgeCover, HOUSE, parseOdds, parseBookie };
})();

if (typeof module !== 'undefined') module.exports = GM;
