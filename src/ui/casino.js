'use strict';
/* global S, $, $, esc, cmd, prefs, panel, money, num, pct, ago, link, signClass, navView, navSubnav, navOpen, NAV_POP, navActive, GM, lineChart, CHART_COLORS, toast */
// Casino tab: helpers for Torn's casino games and the bookie. Advice only: you play every hand
// yourself in Torn; nothing here clicks, bets or reads Torn's pages.
//   Blackjack  the exact value of every move for your hand (Torn's rules)
//   Poker      your chance to win from your cards and the board, and pot odds
//   High-Low   higher or lower, and when to cash out
//   Other      house edges, keno, roulette, lottery, your tokens, a bankroll session
//   Bookie     margins, value and stake sizes; live bookmaker odds from the Mentat server
//   Tracker    your bets and sessions: profit, ROI, by game, over time

const CZ = {
  bj: prefs.get('casino.bj', { hand: [], up: 0, next: 'auto', bet: 0 }),
  pk: prefs.get('casino.pk', { hole: [], board: [], opp: 1, pot: 0, call: 0 }),
  hl: prefs.get('casino.hl', { card: 0, mod: 25, count: false, seen: [] }),
  keno: prefs.get('casino.keno', 6),
  odds: { sports: null, sport: prefs.get('casino.sport', ''), events: null, loading: '', error: '', torn: {} },
  pkCache: new Map(),
  pkBusy: '',
  chart: null,
  editing: '', // a tracker entry whose result is being typed in
  betting: '', // a live-odds outcome being logged
};
const saveBJ = () => prefs.set('casino.bj', CZ.bj);
const savePK = () => prefs.set('casino.pk', CZ.pk);
const saveHL = () => prefs.set('casino.hl', CZ.hl);
const czIn = ms => { const m = Math.max(0, Math.round(ms / 60000)); return m >= 60 ? `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m` : `${m}m`; };
const czPct = (x, d = 1) => (x === null || x === undefined || !Number.isFinite(x) ? '–' : `${(x * 100).toFixed(d)}%`);
const czEV = x => `${x > 0 ? '+' : ''}${(x * 100).toFixed(1)}%`;
const GAME_LABEL = { blackjack: 'Blackjack', poker: 'Poker', highlow: 'High-Low', roulette: 'Roulette', slots: 'Slots', keno: 'Keno', craps: 'Craps', wheel: 'Spin the Wheel', lottery: 'Lottery', russian: 'Russian Roulette', bookie: 'Bookie', other: 'Other' };
const CASINO_URL = 'https://www.torn.com/casino.php';
const GAME_URL = {
  blackjack: 'https://www.torn.com/page.php?sid=blackjack', poker: 'https://www.torn.com/page.php?sid=holdem', highlow: 'https://www.torn.com/page.php?sid=highlow',
  bookie: 'https://www.torn.com/page.php?sid=bookie', keno: 'https://www.torn.com/page.php?sid=keno', roulette: 'https://www.torn.com/page.php?sid=roulette',
};

function renderCasino() {
  const el = panel('casino');
  if (!el || !el.classList.contains('active')) return;
  const sub = navView('casino');
  const c = S.features.casino || {};
  el.innerHTML = `
    ${navSubnav('casino', 'czsub')}
    <div class="note small cz-note">Advice only: you play every hand yourself in Torn. Gamble with money you can afford to lose; over time the house wins every game except Poker and Russian Roulette.</div>
    <div id="cz-body"></div>`;
  const body = $('#cz-body');
  body.dataset.view = sub;
  if (sub === 'blackjack') renderBJ(body);
  else if (sub === 'poker') renderPoker(body, c);
  else if (sub === 'highlow') renderHL(body);
  else if (sub === 'games') renderGames(body, c);
  else if (sub === 'bookie') renderBookie(body, c);
  else renderTracker(body, c);
  const inline = $('.cz-inline input', body);
  if (inline) inline.focus();
}

// ================================================================ Blackjack
const BJ_LABEL = r => (r === 1 ? 'A' : r === 10 ? '10' : String(r));
const BJ_ACTION = { stand: 'Stand', hit: 'Hit', double: 'Double', split: 'Split', surrender: 'Surrender' };

function bjKeypad() {
  return `<div class="cz-keypad">${[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(r => `<button data-bjcard="${r}" title="${r === 10 ? '10, J, Q or K (keys 0, T, J, Q, K)' : r === 1 ? 'Ace (key A or 1)' : `Key ${r}`}">${r === 10 ? '10<small>JQK</small>' : BJ_LABEL(r)}</button>`).join('')}</div>`;
}
const bjCards = (cards, empty) => (cards.length ? cards.map(r => `<span class="cz-card">${BJ_LABEL(r)}</span>`).join('') : `<span class="muted small">${empty}</span>`);

function renderBJ(body) {
  const b = CZ.bj;
  const target = b.next === 'dealer' || (b.next === 'auto' && b.hand.length >= 2 && !b.up) ? 'dealer' : 'hand';
  let out = '';
  if (b.hand.length >= 2 && b.up) {
    const r = GM.blackjack(b.hand, b.up);
    const acts = Object.entries(r.actions).sort((x, y) => y[1] - x[1]);
    const max = Math.max(...acts.map(a => Math.abs(a[1])), 0.01);
    const bet = Number(b.bet) || 0;
    const charlieLeft = 6 - b.hand.length;
    const verdict = r.total > 21 ? 'Bust' : r.natural ? 'Blackjack!' : BJ_ACTION[r.best];
    out = `
      <div class="cz-verdict ${r.total > 21 ? 'bad' : ''}"><span class="k">${r.total > 21 ? 'Your hand' : r.natural ? 'You have' : 'Best move'}</span><span class="v">${verdict}</span>
        <span class="small muted">${r.total > 21 ? 'Over 21: this hand is lost.' : r.natural ? `Pays 3:2 unless the dealer also has blackjack (${czPct(r.dealer.bj)}).` : `${r.soft ? 'Soft' : 'Hard'} ${r.total} against a dealer ${BJ_LABEL(b.up)}`}</span></div>
      ${r.total <= 21 ? `<table class="data cz-acts"><tr><th>Move</th><th class="num">Average result</th>${bet ? '<th class="num">On your bet</th>' : ''}<th></th></tr>
        ${acts.map(([k, v]) => `<tr class="${k === r.best ? 'cz-best' : ''}"><td>${BJ_ACTION[k]}${k === 'double' ? ' <span class="muted small">(bet ×2)</span>' : ''}${k === 'split' ? ' <span class="muted small">(two hands)</span>' : ''}</td>
          <td class="num ${signClass(v)}">${czEV(v)}</td>${bet ? `<td class="num ${signClass(v)}">${money(v * bet)}</td>` : ''}
          <td class="cz-barcell"><span class="cz-bar ${v < 0 ? 'neg' : 'pos'}" style="width:${Math.round(Math.abs(v) / max * 100)}%"></span></td></tr>`).join('')}
      </table>` : ''}
      <div class="grid3 cz-stats">
        <div class="stat"><div class="k">Dealer busts</div><div class="v">${czPct(r.dealerBust)}</div></div>
        <div class="stat"><div class="k">If you stand: win / push / lose</div><div class="v small">${r.standOdds ? `${czPct(r.standOdds.win, 0)} / ${czPct(r.standOdds.push, 0)} / ${czPct(r.standOdds.lose, 0)}` : '–'}</div></div>
        <div class="stat"><div class="k">${r.insurance ? 'Insurance' : 'Six Card Charlie'}</div><div class="v small">${r.insurance ? `<span class="neg">Don't take it</span> (${czEV(r.insurance.ev)}; dealer blackjack ${czPct(r.insurance.chance, 0)})` : charlieLeft > 0 && r.total < 21 ? `${charlieLeft} more card${charlieLeft === 1 ? '' : 's'} without busting wins` : r.total <= 21 && b.hand.length >= 6 ? '<span class="pos">Charlie: you win</span>' : '–'}</div></div>
      </div>`;
  } else {
    out = `<div class="empty">${b.hand.length < 2 ? 'Tap your two cards, then the dealer\'s face-up card.' : 'Now tap the dealer\'s face-up card.'}<br><span class="small muted">Or type them: A, 2-9, 0 or T/J/Q/K for ten. Backspace undoes, N starts a new hand.</span></div>`;
  }
  body.innerHTML = `
    <div class="cz-cols">
      <div class="cz-left">
        <div class="cz-hands">
          <div class="cz-hand ${target === 'hand' ? 'on' : ''}" data-bjtarget="hand"><div class="k">Your hand ${b.hand.length >= 2 ? `<b>${(() => { const [t, s] = GM.handOf(b.hand); return `${s && t <= 21 ? 'soft ' : ''}${t}`; })()}</b>` : ''}</div><div class="cards">${bjCards(b.hand, 'tap two cards')}</div></div>
          <div class="cz-hand ${target === 'dealer' ? 'on' : ''}" data-bjtarget="dealer"><div class="k">Dealer shows</div><div class="cards">${b.up ? `<span class="cz-card">${BJ_LABEL(b.up)}</span>` : '<span class="muted small">one card</span>'}</div></div>
        </div>
        ${bjKeypad()}
        <div class="toolbar cz-tools">
          <button data-bjundo title="Backspace">Undo</button><button data-bjnew class="primary" title="N">New hand</button>
          <label class="small">Bet <input type="number" min="0" step="1000" data-bjbet value="${b.bet || ''}" placeholder="optional" style="width:110px"></label>
          ${link(GAME_URL.blackjack, 'Open Blackjack')}
        </div>
        ${out}
      </div>
      <div class="cz-right">
        <div class="chart-title">Strategy chart <span class="muted small">(best move for any two cards)</span></div>
        <div id="cz-chart">${CZ.chart ? bjChartHtml() : '<button data-bjchart>Show the chart</button>'}</div>
        <div class="note small">Torn's rules, as used here: 8 decks shuffled every game · dealer stands on soft 17 · blackjack pays 3:2 · double on any two cards, also after a split · one split (aces may draw) · early surrender (half back) · the dealer doesn't check for blackjack, so a dealer blackjack also takes doubled and split bets · Six Card Charlie. <b>Not confirmed:</b> what a Charlie pays (1:1 assumed). Results are averages over many hands: a single hand still goes either way.</div>
      </div>
    </div>`;
}

// Best move for every starting hand (computed once, ~0.5 s).
function bjChartData() {
  const ups = [2, 3, 4, 5, 6, 7, 8, 9, 10, 1];
  const code = (r, noSplit) => {
    const a = { ...r.actions };
    if (noSplit) delete a.split;
    const best = Object.entries(a).sort((x, y) => y[1] - x[1])[0][0];
    return { stand: 'S', hit: 'H', double: 'D', split: 'P', surrender: 'R' }[best];
  };
  const rows = [];
  for (let t = 5; t <= 20; t++) {
    const cards = t <= 11 ? [t === 5 ? 3 : 2, t === 5 ? 2 : t - 2] : [10, t - 10];
    rows.push({ group: 'Hard', label: String(t), cells: ups.map(u => code(GM.blackjack(cards, u), true)) });
  }
  for (let x = 2; x <= 9; x++) rows.push({ group: 'Soft', label: `A,${x}`, cells: ups.map(u => code(GM.blackjack([1, x], u))) });
  for (const x of [1, 10, 9, 8, 7, 6, 5, 4, 3, 2]) rows.push({ group: 'Pairs', label: `${BJ_LABEL(x)},${BJ_LABEL(x)}`, cells: ups.map(u => code(GM.blackjack([x, x], u))) });
  return { ups, rows };
}
function bjChartHtml() {
  const d = CZ.chart;
  let html = `<table class="cz-strat"><tr><th></th>${d.ups.map(u => `<th>${BJ_LABEL(u)}</th>`).join('')}</tr>`;
  let group = '';
  for (const r of d.rows) {
    if (r.group !== group) { group = r.group; html += `<tr class="cz-sg"><td colspan="11">${group}${group === 'Hard' ? ' totals' : group === 'Soft' ? ' hands (with an ace)' : ''}</td></tr>`; }
    html += `<tr><th>${r.label}</th>${r.cells.map(c => `<td class="cz-${c}">${c}</td>`).join('')}</tr>`;
  }
  return `${html}</table><div class="cz-legend small"><span class="cz-H">H</span> hit <span class="cz-S">S</span> stand <span class="cz-D">D</span> double <span class="cz-P">P</span> split <span class="cz-R">R</span> surrender <span class="muted">· columns: dealer's card</span></div>`;
}

function bjTap(r) {
  const b = CZ.bj;
  const toDealer = b.next === 'dealer' || (b.next === 'auto' && b.hand.length >= 2 && !b.up);
  if (toDealer) { b.up = r; b.next = 'auto'; } else if (b.hand.length < 12) b.hand.push(r);
  saveBJ();
  renderCasino();
}
function bjUndo() {
  const b = CZ.bj;
  if (b.up && (b.hand.length <= 2 || b.next === 'dealer')) b.up = 0;
  else if (b.hand.length) b.hand.pop();
  saveBJ();
  renderCasino();
}
function bjNew() { CZ.bj.hand = []; CZ.bj.up = 0; CZ.bj.next = 'auto'; saveBJ(); renderCasino(); }

// ================================================================ Poker
const PK_R = '23456789TJQKA';
const PK_S = ['♣', '♦', '♥', '♠'];
const pkCard = (c, attrs = '') => `<span class="cz-card ${(c / 13 | 0) === 1 || (c / 13 | 0) === 2 ? 'red' : ''}" ${attrs}>${PK_R[c % 13] === 'T' ? '10' : PK_R[c % 13]}${PK_S[c / 13 | 0]}</span>`;

function renderPoker(body, c) {
  const p = CZ.pk;
  const used = new Set([...p.hole, ...p.board]);
  const slots = (arr, n, kind) => Array.from({ length: n }, (_, i) => (arr[i] !== undefined ? pkCard(arr[i], `data-pkdel="${kind}:${i}" title="Remove"`) : `<span class="cz-card empty" data-pkslot="${kind}">?</span>`)).join('');
  const key = `${p.hole.join(',')}|${p.board.join(',')}|${p.opp}`;
  const res = CZ.pkCache.get(key);
  const pot = Number(p.pot) || 0, call = Number(p.call) || 0;
  const need = GM.potOdds(pot, call);
  let out = '';
  if (p.hole.length === 2 && [0, 3, 4, 5].includes(p.board.length)) {
    if (!res) {
      out = '<div class="empty"><span class="spinner"></span> Working out your odds…</div>';
      if (CZ.pkBusy !== key) {
        CZ.pkBusy = key;
        setTimeout(() => {
          const r = GM.pokerEquity({ hole: p.hole, board: p.board, opponents: p.opp, iterations: p.opp <= 2 ? 30000 : 15000 });
          CZ.pkCache.set(key, r);
          if (CZ.pkCache.size > 60) CZ.pkCache.delete(CZ.pkCache.keys().next().value);
          CZ.pkBusy = '';
          renderCasino();
        }, 30);
      }
    } else {
      const now = p.board.length >= 3 ? GM.CATS[GM.category(GM.evalHand([...p.hole, ...p.board]))] : '';
      const fair = 1 / (p.opp + 1);
      out = `
        <div class="grid3 cz-stats">
          <div class="stat"><div class="k">Your share of the pot (equity)</div><div class="v cz-big">${czPct(res.equity)}</div><div class="small muted">an average hand here gets ${czPct(fair, 0)}</div></div>
          <div class="stat"><div class="k">Win / split</div><div class="v">${czPct(res.win)} / ${czPct(res.tie)}</div><div class="small muted">against ${p.opp} random hand${p.opp === 1 ? '' : 's'}</div></div>
          <div class="stat"><div class="k">${now ? 'You have' : 'Stage'}</div><div class="v">${now || 'Before the flop'}</div><div class="small muted">${['', '', '', 'on the flop', 'on the turn', 'on the river'][p.board.length]}</div></div>
        </div>
        ${call > 0 ? `<div class="cz-verdict ${res.equity >= need ? 'good' : 'bad'}"><span class="k">Calling ${money(call)} into ${money(pot)}</span><span class="v">${res.equity >= need ? 'Call' : 'Fold'}</span>
          <span class="small muted">You need ${czPct(need)} of the pot to break even; you have about ${czPct(res.equity)}. ${p.board.length < 5 ? 'More bets may follow, so treat close calls as folds.' : ''}</span></div>` : ''}
        ${p.board.length < 5 ? `<div class="chart-title">How your hand ends up (by the river)</div>
        <table class="data cz-made">${res.made.map((x, i) => (x > 0.0005 ? `<tr><td>${GM.CATS[i]}</td><td class="num">${czPct(x)}</td><td class="cz-barcell"><span class="cz-bar pos" style="width:${Math.round(x * 100)}%"></span></td></tr>` : '')).reverse().join('')}</table>` : ''}
        <div class="small muted">Simulated over ${num(res.iterations)} deals against random hands. Real opponents fold weak hands, so a strong bet from them means they're likely stronger than random.</div>`;
    }
  } else {
    out = `<div class="empty">${p.hole.length < 2 ? 'Pick your two cards from the deck below.' : 'Add the flop (3 cards), turn and river as they come, or leave the board empty for pre-flop odds.'}</div>`;
  }
  const t = c.tables;
  body.innerHTML = `
    <div class="cz-cols">
      <div class="cz-left">
        <div class="cz-hands">
          <div class="cz-hand ${p.hole.length < 2 ? 'on' : ''}"><div class="k">Your cards</div><div class="cards">${slots(p.hole, 2, 'hole')}</div></div>
          <div class="cz-hand ${p.hole.length === 2 ? 'on' : ''}"><div class="k">Board</div><div class="cards">${slots(p.board, 5, 'board')}</div></div>
        </div>
        <div class="cz-deck">${[3, 2, 1, 0].map(s => `<div>${[12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1, 0].map(r => { const card = s * 13 + r; return used.has(card) ? '<span class="cz-card gone"></span>' : pkCard(card, `data-pkcard="${card}" role="button" tabindex="0"`); }).join('')}</div>`).join('')}</div>
        <div class="toolbar cz-tools">
          <label class="small">Opponents <span class="seg">${[1, 2, 3, 4, 5, 6, 7, 8].map(n => `<button data-pkopp="${n}" class="${p.opp === n ? 'on' : ''}">${n}</button>`).join('')}</span></label>
          <button data-pknew class="primary">New hand</button>
        </div>
        <div class="toolbar cz-tools">
          <label class="small">Pot <input type="number" min="0" data-pkpot value="${p.pot || ''}" placeholder="0" style="width:110px"></label>
          <label class="small">To call <input type="number" min="0" data-pkcall value="${p.call || ''}" placeholder="0" style="width:110px"></label>
        </div>
        ${out}
      </div>
      <div class="cz-right">
        <div class="chart-title">Torn poker tables ${c.tablesAt ? `<span class="muted small">${ago(c.tablesAt)}</span>` : ''} ${link(GAME_URL.poker, 'Open Poker')}</div>
        ${c.tablesError ? `<div class="error small">${esc(c.tablesError)}</div>` : ''}
        ${t && t.length ? `<table class="data"><tr><th>Table</th><th class="num">Blinds</th><th class="num">Players</th><th class="num">Speed</th></tr>
          ${t.slice().sort((a, b2) => a.big - b2.big).map(x => `<tr><td>${esc(x.name)}</td><td class="num">${money(x.small, true)} / ${money(x.big, true)}</td><td class="num">${x.players}/${x.max}</td><td class="num">${x.speed}</td></tr>`).join('')}</table>`
          : `<div class="muted small">${S.api.hasKey ? 'Loading tables…' : 'Add your API key to see the tables.'}</div>`}
        <div class="note small">No-limit Texas Hold'em, player against player with no rake, so good play wins money over time. Tip: on a table, your starting money is your risk: pick blinds you can afford to lose 50 big blinds of.</div>
      </div>
    </div>`;
}

function pkTap(card) {
  const p = CZ.pk;
  if (p.hole.includes(card) || p.board.includes(card)) return;
  if (p.hole.length < 2) p.hole.push(card);
  else if (p.board.length < 5) p.board.push(card);
  savePK();
  renderCasino();
}

// ================================================================ High-Low
const HL_LABEL = r => ({ 11: 'J', 12: 'Q', 13: 'K', 14: 'A' }[r] || String(r));
function renderHL(body) {
  const h = CZ.hl;
  const mod = Math.max(0, Number(h.mod) || 0) / 100;
  let out = '';
  if (h.card) {
    const r = GM.highLow(h.card, h.count ? h.seen : [], mod);
    out = `
      <div class="cz-verdict ${r.keepGoing ? 'good' : 'bad'}"><span class="k">Dealer shows ${HL_LABEL(h.card)}</span><span class="v">${r.keepGoing ? `Guess ${r.pick}` : 'Cash out'}</span>
        <span class="small muted">${r.keepGoing ? `${czPct(r.pWin)} chance to be right; guessing is worth it above ${czPct(r.needed)}.` : `Only ${czPct(r.pWin)} chance (${r.pick}); with a ${h.mod}% gain you'd need ${czPct(r.needed)}. Take the money if the game lets you.`}</span></div>
      <div class="grid3 cz-stats">
        <div class="stat"><div class="k">Higher</div><div class="v">${czPct(r.higher)}</div></div>
        <div class="stat"><div class="k">Lower</div><div class="v">${czPct(r.lower)}</div></div>
        <div class="stat"><div class="k">Same (replayed)</div><div class="v">${czPct(r.same)}</div></div>
      </div>`;
  } else out = '<div class="empty">Tap the card the dealer is showing.</div>';
  const table = [];
  for (let c = 2; c <= 14; c++) { const r = GM.highLow(c, [], mod); table.push(`<tr class="${c === h.card ? 'cz-best' : ''}"><td>${HL_LABEL(c)}</td><td>${r.pick}</td><td class="num">${czPct(r.pWin)}</td><td>${r.keepGoing ? '<span class="pos">guess</span>' : '<span class="neg">cash out</span>'}</td></tr>`); }
  body.innerHTML = `
    <div class="cz-cols">
      <div class="cz-left">
        <div class="cz-keypad hl">${[2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14].map(c => `<button data-hlcard="${c}" class="${c === h.card ? 'on' : ''}">${HL_LABEL(c)}</button>`).join('')}</div>
        <div class="toolbar cz-tools">
          <label class="small" title="The pot's gain for a right guess, shown on the High-Low page">Gain per right guess <input type="number" min="1" max="100" data-hlmod value="${h.mod}" style="width:64px">%</label>
          <label class="small"><input type="checkbox" data-hlcount ${h.count ? 'checked' : ''}> Count cards seen this game</label>
          ${h.count ? `<span class="small muted">${h.seen.length} seen</span><button data-hlreset>New game</button>` : ''}
          ${link(GAME_URL.highlow, 'Open High-Low')}
        </div>
        ${out}
        ${h.count && h.seen.length ? `<div class="small muted">Seen: ${h.seen.map(HL_LABEL).join(' ')}</div>` : ''}
      </div>
      <div class="cz-right">
        <div class="chart-title">Every card at a ${h.mod}% gain <span class="muted small">(full deck)</span></div>
        <table class="data"><tr><th>Card</th><th>Pick</th><th class="num">Chance</th><th></th></tr>${table.join('')}</table>
        <div class="note small">A right guess grows the pot by the gain shown on the page (15–35%); a wrong one loses it all, so a guess pays only when you're more likely right than 1 ÷ (1 + gain). Aces are high and a tie replays the card. <b>Not confirmed:</b> whether Torn deals from one deck per game; if it reshuffles every card, leave counting off.</div>
      </div>
    </div>`;
}

// ================================================================ Other games
const ROULETTE = [['Single number', 35, 1], ['Split (2 numbers)', 17, 2], ['Street (3)', 11, 3], ['Corner (4)', 8, 4], ['Six line (6)', 5, 6], ['Dozen or column (12)', 2, 12], ['Red/black, odd/even, high/low (18)', 1, 18]];
function renderGames(body, c) {
  const s = c.session;
  const k = GM.kenoOdds(CZ.keno);
  const kenoAll = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(n => GM.kenoOdds(n));
  const bestKeno = kenoAll.filter(x => !x.unknown).sort((a, b2) => b2.rtp - a.rtp)[0];
  const lot = prefs.get('casino.lottery', { mine: 1, total: 0, pot: 0, price: 0 });
  const lotChance = lot.total > 0 ? Math.min(1, lot.mine / lot.total) : 0;
  let sess = '';
  if (s) {
    const diff = s.now - s.start;
    const hitStop = s.stopLoss > 0 && -diff >= s.stopLoss;
    const hitTarget = s.target > 0 && diff >= s.target;
    sess = `
      <div class="cz-verdict ${hitStop ? 'bad' : hitTarget ? 'good' : ''}"><span class="k">Session (${esc(GAME_LABEL[s.game])}), started ${ago(s.startedAt)}</span>
        <span class="v ${signClass(diff)}">${diff >= 0 ? '+' : ''}${money(diff)}</span>
        <span class="small">${hitStop ? '<b>Stop-loss reached: stop playing now.</b>' : hitTarget ? '<b>Target reached: a good time to stop.</b>' : `${s.stopLoss ? `${money(s.stopLoss + diff)} left before your stop-loss` : 'No stop-loss set'}${s.target ? ` · ${money(s.target - diff)} to your target` : ''}`}</span></div>
      <form class="toolbar cz-tools" data-czform="sessnow"><label class="small">Money now <input type="number" min="0" name="now" value="${s.now}" style="width:130px"></label><button>Update</button>
        <button type="button" data-czsessend="log" class="primary">End and log it</button><button type="button" data-czsessend="drop">End</button></form>`;
  } else {
    sess = `<form class="toolbar cz-tools" data-czform="sessstart">
      <label class="small">Game <select name="game">${Object.entries(GAME_LABEL).filter(([g]) => g !== 'bookie').map(([g, l]) => `<option value="${g}">${l}</option>`).join('')}</select></label>
      <label class="small">Bankroll <input type="number" min="1" name="start" required style="width:120px"></label>
      <label class="small">Stop-loss <input type="number" min="0" name="stopLoss" placeholder="lose at most" style="width:110px"></label>
      <label class="small">Target <input type="number" min="0" name="target" placeholder="win" style="width:100px"></label>
      <button class="primary">Start session</button></form>
      <div class="small muted">Decide before you play how much you'll lose at most, and stop there. Chasing losses is how bankrolls disappear.</div>`;
  }
  body.innerHTML = `
    <div class="cz-cols">
      <div class="cz-left">
        <div class="grid3 cz-stats">
          <div class="stat"><div class="k">Casino tokens</div><div class="v">${c.casino ? num(c.casino.tokens) : '–'}</div><div class="small muted">75 more each day</div></div>
          <div class="stat"><div class="k">Casino streak (Torn)</div><div class="v ${c.casino ? signClass(c.casino.streak) : ''}">${c.casino ? num(c.casino.streak) : '–'}</div><div class="small muted">${c.casinoAt ? ago(c.casinoAt) : ''} <a data-cmd="casino.refresh">refresh</a></div></div>
          <div class="stat"><div class="k">Casino</div><div class="v small">${link(CASINO_URL, 'Open the casino')}</div></div>
        </div>
        ${c.casinoError ? `<div class="error small">${esc(c.casinoError)}</div>` : ''}
        <div class="chart-title">Bankroll session</div>
        ${sess}
        <div class="chart-title">Every game's edge</div>
        <table class="data cz-house"><tr><th>Game</th><th>House edge</th><th>Advice</th></tr>${GM.HOUSE.map(h => `<tr><td>${esc(h.game)}</td><td>${esc(h.edge)}</td><td class="small">${esc(h.note)}</td></tr>`).join('')}</table>
      </div>
      <div class="cz-right">
        <div class="chart-title">Keno</div>
        <div class="toolbar"><span class="small">Numbers picked</span> <span class="seg">${[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(n => `<button data-kenopick="${n}" class="${CZ.keno === n ? 'on' : ''}">${n}</button>`).join('')}</span></div>
        <table class="data"><tr><th>Matches</th><th class="num">Chance</th><th class="num">Pays</th></tr>
          ${k.rows.filter(r => r.pays !== 0 || r.matches === 0).map(r => `<tr><td>${r.matches}</td><td class="num">${r.chance < 0.0001 ? `1 in ${num(Math.round(1 / r.chance))}` : czPct(r.chance, 2)}</td><td class="num">${r.pays === null ? '?' : r.pays ? `×${r.pays}` : '–'}</td></tr>`).join('')}</table>
        <div class="small">Pays back ${k.unknown ? 'at least ' : ''}<b>${czPct(k.rtp)}</b> of what you bet${k.unknown ? ' (some payouts unknown)' : ''}. Best: <b>${bestKeno.picks} number${bestKeno.picks === 1 ? '' : 's'} (${czPct(bestKeno.rtp)})</b>. 10 of 80 numbers are drawn; payouts as listed on the Torn wiki.</div>
        <div class="chart-title">Roulette <span class="muted small">(single zero)</span></div>
        <table class="data"><tr><th>Bet</th><th class="num">Pays</th><th class="num">Chance</th></tr>${ROULETTE.map(([n, p, w]) => `<tr><td>${n}</td><td class="num">${p}:1</td><td class="num">${czPct(w / 37)}</td></tr>`).join('')}</table>
        <div class="small muted">Every bet loses 2.7% on average: no system changes that.</div>
        <div class="chart-title">Lottery</div>
        <form class="toolbar cz-tools" data-czform="lottery">
          <label class="small">Your tickets <input type="number" min="0" name="mine" value="${lot.mine || ''}" style="width:80px"></label>
          <label class="small">All tickets <input type="number" min="0" name="total" value="${lot.total || ''}" style="width:90px"></label>
          <label class="small">Pot <input type="number" min="0" name="pot" value="${lot.pot || ''}" style="width:120px"></label>
          <label class="small">Ticket price <input type="number" min="0" name="price" value="${lot.price || ''}" style="width:90px"></label>
          <button>Work out</button></form>
        ${lot.total ? `<div class="small">Chance to win: <b>${lotChance < 0.0001 ? `1 in ${num(Math.round(1 / lotChance))}` : czPct(lotChance, 3)}</b>${lot.pot && lot.price ? ` · each ticket is worth about <b>${money(lot.pot / lot.total)}</b> against its ${money(lot.price)} price: ${lot.pot / lot.total > lot.price ? '<span class="pos">worth buying</span>' : '<span class="neg">not worth it</span>'}` : ''}</div>` : '<div class="small muted">Daily Dime $100 · Lucky Shot $10,000 · Holy Grail $1,000,000 a ticket.</div>'}
      </div>
    </div>`;
}

// ================================================================ Bookie
// A price for an input box: decimal, as Torn's "x" price.
const czOddsVal = o => (Number(o) > 1 ? String(Math.round(Number(o) * 10000) / 10000) : '');
// The calculator, saved: odds (up to 3 outcomes), their names and which one is your pick when the
// odds came from a paste of Torn's Bookie page, plus that match.
function czCalc() {
  const c = { odds: [2, 0, 0], names: ['', '', ''], pick: 0, event: null, stake: 0, chance: 0, bank: 0, frac: 0.25, ...prefs.get('casino.bookcalc', {}) };
  c.names = [0, 1, 2].map(i => (c.names && c.names[i]) || '');
  c.pick = c.names.some(Boolean) ? Math.max(0, Math.min(2, Number(c.pick) || 0)) : 0;
  return c;
}
// Same match in the live odds? Team names compared loosely ("76ers" in "Philadelphia 76ers").
const czNorm = x => String(x || '').toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]/g, '');
const czSame = (a, b) => { a = czNorm(a); b = czNorm(b); return !!(a && b && (a === b || (Math.min(a.length, b.length) >= 4 && (a.includes(b) || b.includes(a))))); };
function czMatch(pe, events) {
  if (!pe || !pe.home || !events) return null;
  const ev = events.find(e => (czSame(e.home, pe.home) && czSame(e.away, pe.away)) || (czSame(e.home, pe.away) && czSame(e.away, pe.home)));
  if (!ev) return null;
  const isDraw = n => /^(draw|tie|x)$/i.test(String(n).trim());
  const map = pe.outcomes.map(o => ev.outcomes.findIndex(lo => (isDraw(o.name) && isDraw(lo.name)) || czSame(lo.name, o.name)));
  return { ev, map };
}
// Matches pasted from Torn: their prices go into the live-odds table (now, or once that sport's odds load).
function czApplyPasted() {
  const od = CZ.odds;
  const events = [...((od.events && od.events.events) || []), ...((od.top && od.top.events) || [])];
  if (!events.length) return 0;
  let n = 0;
  for (const pe of CZ.pasted || []) {
    const m = czMatch(pe, events);
    if (!m) continue;
    m.map.forEach((k, i) => { if (k >= 0) { od.torn[`${m.ev.id}|${k}`] = pe.outcomes[i].odds; n++; } });
  }
  return n;
}
// The live-odds sport for a Torn league ("NBA 2026/2027 (USA 1)" → NBA), if there is an obvious one.
function czSportFor(league) {
  const sports = CZ.odds.sports || [];
  const L = ` ${String(league || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ')} `;
  if (!L.trim()) return '';
  const hit = sports.find(sp => { const t = String(sp.title || '').split(' - ')[0].toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(); return t && L.includes(` ${t} `); });
  return hit ? hit.key : '';
}
function czTake(text) {
  const found = GM.parseBookie(text);
  if (!found.length) { toast("Couldn't find any prices in that. On Torn's Bookie page, select a match from its name down to its last price, copy, and paste."); return false; }
  const pe = found[0];
  const calc = czCalc();
  const outs = pe.outcomes.slice(0, 3);
  prefs.set('casino.bookcalc', { ...calc, odds: [0, 1, 2].map(i => (outs[i] ? outs[i].odds : 0)), names: [0, 1, 2].map(i => (outs[i] ? outs[i].name : '')), pick: 0, chance: 0,
    event: { home: pe.home, away: pe.away, league: pe.league, market: pe.market, start: pe.start, more: Math.max(0, pe.outcomes.length - 3) } });
  CZ.pasted = [...found, ...(CZ.pasted || []).filter(x => !found.some(f => f.home === x.home && f.away === x.away))].slice(0, 30);
  const n = czApplyPasted();
  const sport = !n && CZ.odds.sports && !(CZ.odds.top && CZ.odds.top.sports.some(x => x.key === czSportFor(pe.league) && x.at)) ? czSportFor(pe.league) : '';
  if (found.length > 1) toast(`Read ${found.length} matches (${found.reduce((a, x) => a + x.outcomes.length, 0)} prices): they're in Likeliest winners; the first is in the calculator.`, 6000);
  else toast(`Read ${found.length === 1 ? `${pe.home ? `${pe.home} v ${pe.away}` : 'the match'}` : `${found.length} matches`}: ${pe.outcomes.map(o => `${o.name} ${o.frac || `x${o.odds}`}`).join(', ')}.`, 5000);
  if (sport && sport !== CZ.odds.sport) loadOddsEvents(sport);
  else renderCasino();
  return true;
}

function renderBookie(body, c) {
  const calc = czCalc();
  const named = calc.names.some(Boolean);
  const DEF = ['Your pick', 'Other', 'Draw/third'];
  const label = i => calc.names[i] || DEF[i];
  const outs = [0, 1, 2].map(i => ({ i, odds: Number(calc.odds[i]) || 0 })).filter(o => o.odds > 1);
  const mk = outs.length >= 2 ? GM.market(outs.map(o => o.odds)) : null;
  const pick = calc.pick;
  const pickAt = outs.findIndex(o => o.i === pick);
  const o1 = Number(calc.odds[pick]) || 0;
  const od = CZ.odds;
  const signedIn = S.features.sync && S.features.sync.signedIn;
  if (signedIn && !od.sports && !od.loading && !od.error) loadOddsSports();
  const events = od.events && od.events.events ? od.events.events : [];
  if (signedIn && od.sports && !od.top && !od.topError && od.loading !== 'top' && !CZ.topAsked) { CZ.topAsked = true; loadOddsTop(); }
  if (CZ.pasted && CZ.pasted.length && (od.events || od.top) && CZ.pastedFor !== (od.events || od.top)) { CZ.pastedFor = od.events || od.top; czApplyPasted(); }
  // The pasted match in the live odds: its fair chance is a far better guess than Torn's own prices.
  const live = calc.event && named ? czMatch({ ...calc.event, outcomes: [0, 1, 2].filter(i => calc.names[i]).map(i => ({ name: calc.names[i] })) }, [...events, ...((od.top && od.top.events) || [])]) : null;
  const liveFair = live && live.map[pick] >= 0 ? live.ev.outcomes[live.map[pick]].fair : 0;
  const chance = Number(calc.chance) > 0 ? Number(calc.chance) / 100 : liveFair || (mk && pickAt >= 0 ? mk.fair[pickAt] : 0);
  const chanceFrom = Number(calc.chance) > 0 ? 'yours' : liveFair ? 'live' : 'torn';
  const stake = Number(calc.stake) || 0;
  const val = o1 > 1 && chance ? GM.value(o1, chance) : null;
  const kel = o1 > 1 && chance ? GM.kelly(o1, chance, calc.frac) : 0;
  const ev0 = calc.event;
  const tctHM = t => new Date(t).toISOString().slice(11, 16);
  const eventLine = ev0 ? `<div class="cz-match small"><b>${esc(ev0.home ? `${ev0.home} v ${ev0.away}` : 'Pasted match')}</b>${ev0.league ? ` <span class="muted">${esc(ev0.league)}</span>` : ''}${ev0.market ? ` · ${esc(ev0.market)}` : ''}${ev0.start ? ` · starts ${tctHM(ev0.start)} TCT${ev0.start > Date.now() ? ` (in ${czIn(ev0.start - Date.now())})` : ' <span class="pill bad">started</span>'}` : ''}${mk ? ` · Torn's margin ${czPct(mk.margin)}` : ''}${live ? ` · <span class="pill ok" title="${esc(live.ev.outcomes[0] ? `Fair chance from ${(od.events && od.events.events[0] && od.events.events[0].source) || 'bookmakers'}` : '')}">in the live odds</span>` : ''}${ev0.more ? ` · <span class="muted">${ev0.more} more outcome${ev0.more === 1 ? '' : 's'} not shown</span>` : ''} <a data-czpasteclear>clear</a></div>` : '';
  body.innerHTML = `
    <div class="cz-cols">
      <div class="cz-left">
        <div class="chart-title">Bet calculator</div>
        <details class="cz-paste" ${ev0 ? '' : 'open'}><summary class="small">Paste a match from Torn's Bookie</summary>
          <textarea data-czpaste rows="3" placeholder="On Torn's Bookie page, select a match from its name down to its last price (like '41/50  x1.82  Orlando Magic'), copy, and paste it here."></textarea>
          <div class="small muted">Mentat reads the match, its start time and every price, fills the calculator, and finds the match in the live odds when that sport is there.</div></details>
        ${eventLine}
        <form class="cz-calc" data-czform="bookcalc">
          <div class="toolbar cz-tools"><span class="small">Torn's odds:</span>
            ${[0, 1, 2].map(i => `<label class="small">${esc(label(i))}${named && i === pick ? ' <span class="pill ok">your pick</span>' : ''} <input type="text" inputmode="decimal" autocomplete="off" name="o${i}" value="${czOddsVal(calc.odds[i])}" placeholder="${i === 2 ? '–' : 'x1.82 or 41/50'}" style="width:${i === 2 ? 80 : 100}px"></label>`).join('')}</div>
          <div class="toolbar cz-tools">
            ${named ? `<label class="small">Your pick <select name="pick">${[0, 1, 2].filter(i => calc.names[i]).map(i => `<option value="${i}" ${i === pick ? 'selected' : ''}>${esc(calc.names[i])}</option>`).join('')}</select></label>` : ''}
            <label class="small">Stake <input type="number" min="0" name="stake" value="${calc.stake || ''}" style="width:120px"></label>
            <label class="small" title="Leave empty to use ${liveFair ? 'the fair chance from the live bookmaker odds' : "the fair chance from Torn's own odds"}">Your chance <input type="number" min="0" max="100" step="0.1" name="chance" value="${calc.chance || ''}" placeholder="${chance && chanceFrom !== 'yours' ? (chance * 100).toFixed(1) : ''}" style="width:70px">%</label>
            <label class="small">Bankroll <input type="number" min="0" name="bank" value="${calc.bank || ''}" style="width:120px"></label>
            <label class="small">Kelly <select name="frac">${[[0.25, '¼ (safer)'], [0.5, '½'], [1, 'full']].map(([v, l]) => `<option value="${v}" ${calc.frac === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
            <button>Work out</button>${o1 > 1 && stake ? ' <button type="button" data-czcalclog title="Add this bet to the tracker as pending">Log bet</button>' : ''}</div>
        </form>
        <div class="grid3 cz-stats">
          <div class="stat"><div class="k">Pays if it wins</div><div class="v">${o1 > 1 && stake ? money(stake * o1) : '–'}</div><div class="small muted">${o1 > 1 && stake ? `profit ${money(stake * (o1 - 1))}` : 'stake × odds'}</div></div>
          <div class="stat"><div class="k">Odds say</div><div class="v">${o1 > 1 ? czPct(1 / o1) : '–'}</div><div class="small muted">${mk && pickAt >= 0 ? `fair ${czPct(mk.fair[pickAt])} after Torn's ${czPct(mk.margin)} margin` : 'enter every outcome\'s odds for the margin'}${liveFair ? `<br>live bookmakers: <b>${czPct(liveFair)}</b>` : ''}</div></div>
          <div class="stat"><div class="k">Value</div><div class="v ${val === null ? '' : signClass(val)}">${val === null ? '–' : czEV(val)}</div><div class="small muted">${val === null ? '' : `${chanceFrom === 'live' ? 'against the live odds · ' : chanceFrom === 'torn' ? "against Torn's own odds · " : ''}${val > 0 ? `bet up to ${czPct(kel)} of your bankroll${calc.bank ? ` (${money(kel * calc.bank)})` : ''}` : 'no bet: the price is too short'}`}</div></div>
        </div>
        <div class="note small">Torn shows each price two ways: <b>41/50</b> (win $41 for every $50) and <b>x1.82</b> (a $1,000 bet returns $1,820). Type either, or plain 1.82. A bet has <b>value</b> when your chance of winning is higher than the odds say. With no chance of your own, the fair chance from Torn's odds always shows a loss (the margin): use the live odds to find prices Torn has set too long. Kelly is a stake size for value bets; a quarter of it is much less bumpy.</div>
        ${hedgeHtml(c)}
      </div>
      <div class="cz-right">
        ${czWinnersHtml(signedIn)}
        <div class="chart-title">Live bookmaker odds ${od.events && od.events.fetchedAt ? `<span class="muted small">${ago(od.events.fetchedAt)}${od.events.stale ? ' (old)' : ''}</span>` : ''} ${link(GAME_URL.bookie, 'Open Bookie')}</div>
        ${!signedIn ? '<div class="muted small">Sign in to the Mentat server to see live odds.</div>'
          : od.error ? `<div class="error small">${esc(od.error)}</div>`
          : !od.sports ? '<div class="muted small"><span class="spinner"></span> Loading sports…</div>'
          : `<div class="toolbar"><select data-czsport><option value="">Pick a sport…</option>${groupSports(od.sports)}</select>${od.loading ? ' <span class="spinner"></span>' : ''}</div>`}
        ${od.events && od.events.note ? `<div class="small muted">${esc(od.events.note)}</div>` : ''}
        ${events.length ? `<div class="small muted">Fair chance: ${esc(events[0].source)}. Type Torn's odds for an outcome (x1.82 or 41/50), or paste matches from Torn's Bookie in the calculator, to check their value.</div>
          <div class="cz-events">${events.slice(0, 40).map(ev => `
            <div class="card cz-event"><div class="small"><b>${esc(ev.home)}</b> v <b>${esc(ev.away)}</b> <span class="muted">${new Date(ev.start).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })}</span></div>
              <table class="data"><tr><th>Outcome</th><th class="num">Fair</th><th class="num">Fair odds</th><th class="num">Best price</th><th class="num">Torn's odds</th><th class="num">Value</th></tr>
              ${ev.outcomes.map((o, i) => { const k = `${ev.id}|${i}`; const t = Number(od.torn[k]) || 0; const v = t > 1 ? GM.value(t, o.fair) : null; return `<tr><td>${esc(o.name)}</td><td class="num">${czPct(o.fair)}</td><td class="num">${o.fairOdds.toFixed(2)}</td><td class="num" title="${esc(o.bestBook)}">${o.best ? o.best.toFixed(2) : '–'}</td>
                <td class="num"><input type="text" inputmode="decimal" autocomplete="off" data-czodds="${esc(k)}" value="${czOddsVal(t)}" placeholder="x1.82" style="width:70px"></td>
                <td class="num ${v === null ? '' : signClass(v)}">${v === null ? '' : `${czEV(v)}${v > 0 ? (CZ.betting === k ? ` <form class="cz-inline" data-czform="logbet" data-key="${esc(k)}"><input type="number" min="1" name="stake" placeholder="stake" style="width:90px" autofocus><button>Log</button></form>` : ` <a data-czlogbet="${esc(k)}" title="Add to the tracker as a pending bet">log</a>`) : ''}`}</td></tr>`; }).join('')}</table></div>`).join('')}</div>`
          : od.events ? '<div class="muted small">No upcoming matches with odds.</div>' : ''}
        <div class="note small">Torn's bookie also has over/under, handicap and odd/even bets; live odds here cover match results. For the others, put Torn's prices for each side in the calculator.</div>
      </div>
    </div>`;
  if (od.sport) { const sel = $('[data-czsport]', body); if (sel) sel.value = od.sport; }
}
// ---- Hedging a bet you already have ----
const HEDGE_DEFAULT = { stake: 0, odds: 0, o1: 0, o2: 0, h1: 0, h2: 0, from: '', label: '' };
// The plans for the saved hedge form: [{ key, name, stakes (whole $), results }].
function hedgePlans(h) {
  const others = [h.o1, h.o2].map(Number).filter(o => o > 1);
  if (!(h.stake > 0 && h.odds > 1 && others.length)) return null;
  const plan = (key, name, stakes) => { stakes = stakes.map(x => Math.max(0, Math.round(x))); return { key, name, stakes, results: GM.hedgeResults(h.stake, h.odds, others, stakes) }; };
  const plans = [plan('none', 'No hedge', others.map(() => 0)), plan('lock', 'Same result whatever happens', GM.hedgeEqual(h.stake, h.odds, others).stakes)];
  const cover = GM.hedgeCover(h.stake, h.odds, others);
  const cv = cover && plan('cover', 'Stake back if your pick loses', cover.stakes);
  if (cv && cv.results[0] >= 0) plans.push(cv); // otherwise it loses money when your pick wins
  const mine = [h.h1, h.h2].slice(0, others.length).map(x => Number(x) || 0);
  if (mine.some(x => x > 0)) plans.push(plan('mine', 'Your hedge', mine));
  return { others, plans };
}
function hedgeHtml(c) {
  const h = { ...HEDGE_DEFAULT, ...prefs.get('casino.hedge', {}) };
  const pending = Object.values(c.log || {}).filter(e => e.open && e.game === 'bookie' && e.stake > 0 && e.odds > 1).sort((a, b) => b.at - a.at);
  const p = hedgePlans(h);
  const names = ['Other side', 'Third (draw)'];
  let out = '<div class="small muted">Enter your bet and today\'s odds on the other side (and the draw, for a 3-way match).</div>';
  if (p) {
    const lock = p.plans.find(x => x.key === 'lock');
    const locked = lock.results[0];
    const fmt = v => { const r = Math.round(v); return `<span class="${signClass(r)}">${r > 0 ? '+' : ''}${money(r)}</span>`; };
    out = `
      <div class="cz-verdict ${locked >= 0 ? 'good' : 'bad'}"><span class="k">Hedging now</span>
        <span class="v">${locked >= 0 ? `Locks in ${money(locked)}` : `Locks a ${money(-locked)} loss`}</span>
        <span class="small muted">${locked >= 0 ? `Bet ${lock.stakes.map((s, i) => `${money(s)} on ${names[i].toLowerCase()}`).join(' and ')} and you win ${money(locked)} whatever the result.` : `The odds have moved against your pick. Hedging caps the loss at ${money(-locked)}; not hedging risks your whole ${money(h.stake)} for a chance at ${money(h.stake * (h.odds - 1))}.`}</span></div>
      <table class="data cz-hedge"><tr><th>Plan</th><th class="num">Bet${p.others.length > 1 ? 's' : ''} to add</th><th class="num">Your pick wins</th>${p.others.map((_, i) => `<th class="num">${names[i]} wins</th>`).join('')}<th></th></tr>
        ${p.plans.map(x => `<tr class="${x.key === 'lock' ? 'cz-best' : ''}"><td>${x.name}</td><td class="num">${x.stakes.some(s => s) ? x.stakes.map(s => money(s, true)).join(' + ') : '–'}</td>
          ${x.results.map(fmt).map(v => `<td class="num">${v}</td>`).join('')}
          <td>${x.key !== 'none' ? `<a data-czhedgelog="${x.key}" title="Add these bets to the tracker as pending">log</a>` : ''}</td></tr>`).join('')}
      </table>`;
  }
  return `
    <div class="chart-title">Hedge a bet you've placed</div>
    <form class="cz-calc" data-czform="hedge">
      ${pending.length ? `<div class="toolbar cz-tools"><label class="small">From the tracker <select data-czhedgefrom><option value="">Pending bets…</option>${pending.map(e => `<option value="${esc(e.id)}" ${h.from === e.id ? 'selected' : ''}>${esc(e.note || 'Bookie bet')}: ${money(e.stake, true)} @ ${e.odds}</option>`).join('')}</select></label></div>` : ''}
      <div class="toolbar cz-tools">
        <label class="small">Your stake <input type="number" min="0" name="stake" value="${h.stake || ''}" style="width:110px"></label>
        <label class="small">at odds <input type="text" inputmode="decimal" autocomplete="off" name="odds" value="${czOddsVal(h.odds)}" placeholder="x1.82" style="width:70px"></label>
        <label class="small">Other side now <input type="text" inputmode="decimal" autocomplete="off" name="o1" value="${czOddsVal(h.o1)}" placeholder="x2.00" style="width:70px"></label>
        <label class="small">Draw now <input type="text" inputmode="decimal" autocomplete="off" name="o2" value="${czOddsVal(h.o2)}" placeholder="–" style="width:70px"></label>
      </div>
      ${czCalc().names.some(Boolean) ? `<div class="toolbar cz-tools"><a class="small" data-czhedgepaste title="Your pick's price stays as you bet it; the other sides take the pasted prices">Use today's prices from the pasted match</a></div>` : ''}
      <div class="toolbar cz-tools">
        <label class="small" title="Try your own hedge stakes">Your hedge: other <input type="number" min="0" name="h1" value="${h.h1 || ''}" placeholder="optional" style="width:100px"></label>
        <label class="small">draw <input type="number" min="0" name="h2" value="${h.h2 || ''}" placeholder="–" style="width:100px"></label>
        <button>Work out</button>${h.stake || h.odds ? ' <button type="button" data-czhedgeclear>Clear</button>' : ''}
      </div>
    </form>
    ${out}
    <div class="note small">Hedging trades a chance at the full win for a sure result. It works when the price on the other side has lengthened since you bet (your pick looks likelier), so both sides together pay more than you put in. Every hedge pays Torn's margin again, so it lowers your average result: use it to protect a big bet, not as a habit. You can only hedge while Torn still takes bets on that match.</div>`;
}

function groupSports(list) {
  const groups = {};
  for (const s of list) (groups[s.group] = groups[s.group] || []).push(s);
  return Object.entries(groups).sort((a, b) => a[0].localeCompare(b[0])).map(([g, xs]) => `<optgroup label="${esc(g)}">${xs.map(s => `<option value="${esc(s.key)}">${esc(s.title)}</option>`).join('')}</optgroup>`).join('');
}
async function loadOddsSports() {
  const od = CZ.odds;
  od.loading = 'sports';
  try {
    const r = await cmd('casino.odds.sports');
    od.sports = r.sports || [];
    od.error = '';
  } catch (e) { od.error = e.message; od.sports = null; }
  od.loading = '';
  if (od.sport && od.sports && od.sports.some(s => s.key === od.sport) && !od.events) loadOddsEvents(od.sport);
  else renderCasino();
}
async function loadOddsEvents(sport) {
  const od = CZ.odds;
  od.sport = sport;
  prefs.set('casino.sport', sport);
  if (!sport) { od.events = null; renderCasino(); return; }
  od.loading = 'events';
  renderCasino();
  try { od.events = await cmd('casino.odds.events', sport); od.error = ''; } catch (e) { od.events = null; toast(e.message); }
  od.loading = '';
  renderCasino();
}

// ---- Likeliest winners: every upcoming match Mentat knows, ranked ----
// Live bookmaker odds from the server's scan of the big leagues (and any sport you opened), plus matches
// you pasted from Torn's Bookie. Torn's API has no Bookie data, so Torn's own prices come from pastes
// (or typing them in); a match only in a paste gets its chance from Torn's prices, margin removed.
const CZW_SPAN = { '1d': ['24 hours', 86400e3], '3d': ['3 days', 3 * 86400e3], '7d': ['7 days', 7 * 86400e3] };
function czWinnerRows() {
  const od = CZ.odds;
  const f = { win: '3d', min: 60, sort: 'chance', ...prefs.get('casino.winners', {}) };
  const now = Date.now();
  const span = (CZW_SPAN[f.win] || CZW_SPAN['3d'])[1];
  const titleOf = k => ((od.sports || []).find(x => x.key === k) || {}).title || '';
  const seen = new Set();
  const live = [];
  for (const ev of [...((od.top && od.top.events) || []), ...((od.events && od.events.events) || []).map(e => ({ ...e, sportTitle: titleOf(od.sport) }))]) {
    if (seen.has(ev.id)) continue;
    seen.add(ev.id);
    live.push(ev);
  }
  const rows = [];
  const pastedLive = new Set();
  for (const ev of live) {
    for (const pe of CZ.pasted || []) if (czMatch(pe, [ev])) pastedLive.add(pe);
    if (ev.start <= now || ev.start > now + span) continue;
    ev.outcomes.forEach((o, k) => {
      const key = `${ev.id}|${k}`;
      const torn = Number(od.torn[key]) || 0;
      rows.push({ key, match: `${ev.home} v ${ev.away}`, league: ev.sportTitle || '', start: ev.start, name: o.name, chance: o.fair, fairOdds: o.fairOdds, torn, value: torn > 1 ? GM.value(torn, o.fair) : null, src: 'live', ev, k });
    });
  }
  for (const pe of CZ.pasted || []) {
    if (pastedLive.has(pe) || (pe.start && (pe.start <= now || pe.start > now + span))) continue;
    const mk = GM.market(pe.outcomes.map(o => o.odds));
    pe.outcomes.forEach((o, i) => rows.push({ key: `p|${pe.home}|${pe.away}|${i}`, match: pe.home ? `${pe.home} v ${pe.away}` : 'Pasted match', league: String(pe.league || '').replace(/\s*\d{4}\/\d{4}.*$/, ''), start: pe.start, name: o.name, chance: mk.fair[i], fairOdds: mk.fair[i] ? 1 / mk.fair[i] : 0, torn: o.odds, value: null, src: 'torn', pe, i }));
  }
  const shown = rows.filter(r => r.chance >= (Number(f.min) || 0) / 100);
  const pay = r => r.torn || r.fairOdds || 0;
  shown.sort(f.sort === 'payout' ? (a, b) => pay(b) - pay(a) : f.sort === 'value' ? (a, b) => (b.value === null ? -9 : b.value) - (a.value === null ? -9 : a.value) || b.chance - a.chance : (a, b) => b.chance - a.chance);
  return { rows: shown.slice(0, 30), total: shown.length, all: rows.length, f };
}
function czWinnersHtml(signedIn) {
  const od = CZ.odds;
  const { rows, total, all, f } = czWinnerRows();
  const day = t => new Date(t).toUTCString().slice(0, 3);
  const when = t => (t ? `${pmDay(t)} ${new Date(t).toISOString().slice(11, 16)}` : '–');
  function pmDay(t) { return new Date(t).toISOString().slice(0, 10) === new Date().toISOString().slice(0, 10) ? 'Today' : day(t); }
  const top = od.top;
  const status = !signedIn ? 'Sign in to the Mentat server for live odds; until then the list has only matches you paste from Torn\'s Bookie.'
    : od.topError ? `${esc(od.topError)} The list has only matches you paste from Torn's Bookie.`
      : top ? `${top.events.length} upcoming matches from ${top.sports.filter(x => x.at).length} of ${top.sports.length} big leagues${top.scanning || top.pending ? ', fetching more in the background…' : ''}${CZ.pasted && CZ.pasted.length ? `, plus ${CZ.pasted.length} pasted` : ''}.`
        : od.loading === 'top' ? '<span class="spinner"></span> Loading…' : '';
  const sel = (name, opts, v) => `<select data-czw="${name}">${opts.map(([k, l]) => `<option value="${k}" ${String(k) === String(v) ? 'selected' : ''}>${l}</option>`).join('')}</select>`;
  return `
    <div class="chart-title">Likeliest winners</div>
    <div class="toolbar cz-tools small">
      <label>Starting within ${sel('win', Object.entries(CZW_SPAN).map(([k, [l]]) => [k, l]), f.win)}</label>
      <label>Win chance ${sel('min', [[0, 'any'], [50, '50%+'], [60, '60%+'], [70, '70%+'], [80, '80%+'], [90, '90%+']], f.min)}</label>
      <label>Sort ${sel('sort', [['chance', 'likeliest first'], ['payout', 'biggest payout'], ['value', 'best value']], f.sort)}</label>
    </div>
    <div class="small muted">${status}</div>
    ${rows.length ? `<table class="data cz-winners"><tr><th>Starts (TCT)</th><th>Match</th><th>To win</th><th class="num">Chance</th><th class="num">Torn's price</th><th class="num">Value</th><th></th></tr>
      ${rows.map(r => `<tr>
        <td class="nowrap">${when(r.start)}</td>
        <td><span class="small">${esc(r.match)}</span>${r.league ? `<div class="small muted">${esc(r.league)}</div>` : ''}</td>
        <td><b>${esc(r.name)}</b></td>
        <td class="num" title="${r.src === 'live' ? 'From real bookmakers, margin removed' : "From Torn's own prices, margin removed (no live odds for this match)"}">${czPct(r.chance)}${r.src === 'torn' ? ' <span class="muted small">Torn</span>' : ''}</td>
        <td class="num">${r.src === 'live' ? `<input type="text" inputmode="decimal" autocomplete="off" data-czodds="${esc(r.key)}" value="${czOddsVal(r.torn)}" placeholder="fair x${r.fairOdds ? r.fairOdds.toFixed(2) : '–'}" title="Type Torn's price (x1.82 or 41/50), or paste the match from Torn's Bookie. It's value when Torn pays more than the fair price." style="width:78px">` : `x${r.torn.toFixed(2)}`}</td>
        <td class="num ${r.value === null ? '' : signClass(r.value)}">${r.value === null ? '' : czEV(r.value)}</td>
        <td><a data-czwuse="${esc(r.key)}" title="Open in the bet calculator">use</a></td></tr>`).join('')}</table>
      ${total > rows.length ? `<div class="small muted">Showing the first ${rows.length} of ${total}.</div>` : ''}`
    : `<div class="muted small">${all ? 'Nothing matches those filters.' : 'No matches yet. Paste matches from Torn\'s Bookie into the calculator (several at once is fine), or sign in for live odds.'}</div>`}
    <div class="note small">Chance = how often that side should win, from real bookmakers' prices with their margin taken out. A likely winner pays little: it's only worth backing when Torn's price is above the fair price (Value above 0). Torn's API has no Bookie data, so Torn's prices come from what you paste or type.</div>`;
}
async function loadOddsTop(again = 0) {
  const od = CZ.odds;
  od.loading = od.loading || 'top';
  try { od.top = await cmd('casino.odds.top'); od.topError = ''; } catch (e) { od.topError = e.message; }
  if (od.loading === 'top') od.loading = '';
  CZ.pastedFor = null; // match pastes against the new list too
  renderCasino();
  // The server fetches leagues it hasn't seen today in the background: look again shortly.
  clearTimeout(CZ.topT);
  if (od.top && (od.top.scanning || od.top.pending) && again < 12) CZ.topT = setTimeout(() => { if (panel('casino') && panel('casino').classList.contains('active')) loadOddsTop(again + 1); }, 25000);
}

// ================================================================ Tracker
const PERIODS = { day: ['Today', 86400e3], week: ['7 days', 7 * 86400e3], month: ['30 days', 30 * 86400e3], all: ['All', Infinity] };
function trackerStats(list) {
  const settled = list.filter(e => !e.open && e.net !== null && e.net !== undefined);
  const net = settled.reduce((a, e) => a + e.net, 0);
  // Return on stakes: only entries with a stake (a bankroll session has none).
  const withStake = settled.filter(e => e.stake > 0);
  const staked = withStake.reduce((a, e) => a + e.stake, 0);
  const stakedNet = withStake.reduce((a, e) => a + e.net, 0);
  const wins = settled.filter(e => e.net > 0).length;
  return { n: settled.length, net, staked, roi: staked ? stakedNet / staked : null, winRate: settled.length ? wins / settled.length : null, open: list.filter(e => e.open).length, unknown: list.filter(e => !e.open && (e.net === null || e.net === undefined)).length };
}
function renderTracker(body, c) {
  const period = prefs.get('casino.period', 'month');
  const gameF = prefs.get('casino.gameFilter', '');
  const since = Date.now() - PERIODS[period][1];
  const all = Object.values(c.log || {}).sort((a, b) => b.at - a.at);
  const list = all.filter(e => e.at >= since && (!gameF || e.game === gameF));
  const st = trackerStats(list);
  const byGame = {};
  for (const e of list) (byGame[e.game] = byGame[e.game] || []).push(e);
  const games = Object.entries(byGame).map(([g, xs]) => [g, trackerStats(xs)]).sort((a, b) => b[1].net - a[1].net);
  const settled = list.filter(e => !e.open && Number.isFinite(e.net)).sort((a, b) => a.at - b.at);
  let run = 0;
  const points = settled.map(e => [e.at, (run += e.net)]);
  if (points.length) points.unshift([settled[0].at - 60e3, 0]); // the running total starts at nothing
  const big = settled.length ? [settled.reduce((a, e) => (e.net > a.net ? e : a)), settled.reduce((a, e) => (e.net < a.net ? e : a))] : null;
  const form = prefs.get('casino.addform', { game: 'blackjack', outcome: 'won' });
  body.innerHTML = `
    <div class="toolbar">
      <span class="seg">${Object.entries(PERIODS).map(([k, [l]]) => `<button data-czperiod="${k}" class="${period === k ? 'on' : ''}">${l}</button>`).join('')}</span>
      <select data-czgame><option value="">All games</option>${Object.entries(GAME_LABEL).map(([g, l]) => `<option value="${g}" ${gameF === g ? 'selected' : ''}>${l}</option>`).join('')}</select>
    </div>
    <div class="grid4 cz-stats">
      <div class="stat"><div class="k">Profit / loss</div><div class="v cz-big ${signClass(st.net)}">${st.net >= 0 ? '+' : ''}${money(st.net)}</div></div>
      <div class="stat"><div class="k">Return on stakes</div><div class="v ${signClass(st.roi)}">${st.roi === null ? '–' : pct(st.roi)}</div><div class="small muted">${money(st.staked, true)} staked</div></div>
      <div class="stat"><div class="k">Bets won</div><div class="v">${st.winRate === null ? '–' : czPct(st.winRate, 0)}</div><div class="small muted">${num(st.n)} settled${st.open ? ` · ${st.open} pending` : ''}</div></div>
      <div class="stat"><div class="k">Biggest win / loss</div><div class="v small">${big ? `<span class="pos">${money(big[0].net, true)}</span> / <span class="neg">${money(big[1].net, true)}</span>` : '–'}</div></div>
    </div>
    <div class="cz-cols">
      <div class="cz-left">
        <div class="chart-title">Profit over time</div><div id="cz-plchart"></div>
        <div class="chart-title">Add a bet or session</div>
        <form class="cz-add" data-czform="add">
          <div class="toolbar cz-tools">
            <select name="game">${Object.entries(GAME_LABEL).map(([g, l]) => `<option value="${g}" ${form.game === g ? 'selected' : ''}>${l}</option>`).join('')}</select>
            <label class="small">Stake <input type="number" min="0" name="stake" style="width:110px"></label>
            <label class="small" title="Bookie bets: Torn's price, x1.82 or 41/50">Odds <input type="text" inputmode="decimal" autocomplete="off" name="odds" style="width:70px" placeholder="x1.82"></label>
          </div>
          <div class="toolbar cz-tools">
            <span class="seg">${[['won', 'Won'], ['lost', 'Lost'], ['push', 'Push'], ['open', 'Pending']].map(([v, l]) => `<button type="button" data-czoutcome="${v}" class="${form.outcome === v ? 'on' : ''}">${l}</button>`).join('')}</span>
            <label class="small" title="Profit, not counting your stake back. Leave empty to work it out from the odds.">Profit <input type="number" name="net" style="width:110px" placeholder="${form.outcome === 'won' ? 'from odds' : ''}"></label>
            <input name="note" placeholder="Note (optional)" maxlength="200" style="flex:1;min-width:120px">
            <button class="primary">Add</button>
          </div>
        </form>
        <div class="chart-title">Entries <span class="muted small">${list.length} shown</span></div>
        ${list.length ? `<div class="list-scroll"><table class="data cz-log"><tr><th>When</th><th>Game</th><th class="num">Stake</th><th class="num">Result</th><th>Note</th><th></th></tr>
          ${list.slice(0, 300).map(e => `<tr><td class="nowrap small">${new Date(e.at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</td>
            <td>${esc(GAME_LABEL[e.game] || e.game)}${e.src === 'auto' ? ' <span class="pill info" title="From your Torn log">auto</span>' : ''}</td>
            <td class="num">${e.stake === null || e.stake === undefined ? '–' : money(e.stake, true)}${e.odds ? ` <span class="muted small">@${e.odds}</span>` : ''}</td>
            <td class="num">${CZ.editing === e.id ? `<form class="cz-inline" data-czform="net" data-id="${esc(e.id)}"><input type="number" name="net" placeholder="profit, − for loss" style="width:120px" autofocus><button>OK</button></form>` : e.open ? `<span class="pill warn">pending</span> <a data-czsettle="${esc(e.id)}:won">won</a> · <a data-czsettle="${esc(e.id)}:lost">lost</a>${e.game === 'bookie' && e.stake > 0 && e.odds > 1 ? ` · <a data-czhedge="${esc(e.id)}" title="Work out a hedge for this bet">hedge</a>` : ''}` : Number.isFinite(e.net) ? `<span class="${signClass(e.net)}">${e.net >= 0 ? '+' : ''}${money(e.net, true)}</span>` : `<a data-czsetnet="${esc(e.id)}" title="Torn's log didn't say: enter it">set</a>`}</td>
            <td class="small">${esc(e.note || e.title || '')}</td>
            <td><button class="icon-btn" data-czdel="${esc(e.id)}" title="Delete">×</button></td></tr>`).join('')}</table></div>` : '<div class="empty">Nothing logged in this period yet.</div>'}
      </div>
      <div class="cz-right">
        <div class="chart-title">By game</div>
        ${games.length ? `<table class="data"><tr><th>Game</th><th class="num">Bets</th><th class="num">Profit</th><th class="num">Return</th></tr>${games.map(([g, s]) => `<tr><td>${esc(GAME_LABEL[g] || g)}</td><td class="num">${s.n}</td><td class="num ${signClass(s.net)}">${money(s.net, true)}</td><td class="num">${s.roi === null ? '–' : pct(s.roi)}</td></tr>`).join('')}</table>` : '<div class="muted small">–</div>'}
        <div class="chart-title">Auto-tracking from your Torn log <span class="pill warn">beta</span></div>
        ${trackerAutoHtml(c)}
      </div>
    </div>`;
  lineChart($('#cz-plchart'), { series: [{ name: 'Profit', points, color: CHART_COLORS[0], step: true }], yFmt: v => money(v, true), tipFmt: v => money(v), empty: 'Add a few results to see your running profit.' });
}
function trackerAutoHtml(c) {
  const a = c.auto || {};
  if (!c.hasLogKey) {
    return `<div class="small">Torn only shares your casino and bookie history with a <b>Full access</b> key. Make one just for this (Torn → Settings → API keys → Full access), and Mentat copies new results into the tracker every 15 minutes.</div>
      <form class="keyrow" data-czform="logkey"><input type="password" name="key" placeholder="Full access key" autocomplete="off" spellcheck="false"><button class="primary">Save</button></form>
      <div class="note small">The key is kept encrypted on this device only: it isn't sent to the Mentat server or your other devices, and it's used for nothing but reading your log. Results it imports do sync. Torn's log doesn't always say how much you won, so check the entries marked <b>set</b>.</div>`;
  }
  return `<div class="small">${c.autoOn ? '<span class="pill ok">on</span>' : '<span class="pill">paused</span>'} ${a.lastAt ? `checked ${ago(a.lastAt)}` : 'checking soon'} · ${num(a.imported || 0)} imported this run
      ${a.cats && a.cats.length ? `<div class="muted">Reading: ${a.cats.map(x => esc(x.title)).join(', ')}</div>` : ''}</div>
    ${a.error ? `<div class="error small">${esc(a.error)}</div>` : ''}
    <div class="toolbar cz-tools"><button data-czauto="check">Check now</button><button data-czauto="${c.autoOn ? 'pause' : 'resume'}">${c.autoOn ? 'Pause' : 'Resume'}</button><button data-czauto="forget">Remove the key</button><button data-czauto="clear">Delete imported entries</button></div>`;
}

// ================================================================ events
function initCasino() {
  const el = panel('casino');
  if (!el) return;
  el.addEventListener('click', async e => {
    const t = e.target.closest('[data-czsub],[data-bjcard],[data-bjtarget],[data-bjundo],[data-bjnew],[data-bjchart],[data-pkcard],[data-pkdel],[data-pkopp],[data-pknew],[data-hlcard],[data-hlreset],[data-kenopick],[data-czsessend],[data-czperiod],[data-czoutcome],[data-czdel],[data-czsettle],[data-czsetnet],[data-czauto],[data-czlogbet],[data-czhedge],[data-czhedgelog],[data-czhedgeclear],[data-czpasteclear],[data-czcalclog],[data-czhedgepaste],[data-czwuse]');
    if (!t) return;
    const d = t.dataset;
    if (d.czsub) { prefs.set('casino.sub', d.czsub); renderCasino(); return; }
    if (d.bjcard) return bjTap(Number(d.bjcard));
    if (d.bjtarget) { CZ.bj.next = d.bjtarget === 'dealer' ? 'dealer' : (CZ.bj.hand.length >= 2 && !CZ.bj.up ? 'hand' : 'auto'); saveBJ(); renderCasino(); return; }
    if (d.bjundo !== undefined) return bjUndo();
    if (d.bjnew !== undefined) return bjNew();
    if (d.bjchart !== undefined) {
      $('#cz-chart').innerHTML = '<span class="spinner"></span> Working it out…';
      setTimeout(() => { CZ.chart = bjChartData(); renderCasino(); }, 30);
      return;
    }
    if (d.pkcard) return pkTap(Number(d.pkcard));
    if (d.pkdel) { const [k, i] = d.pkdel.split(':'); CZ.pk[k].splice(Number(i), 1); savePK(); renderCasino(); return; }
    if (d.pkopp) { CZ.pk.opp = Number(d.pkopp); savePK(); renderCasino(); return; }
    if (d.pknew !== undefined) { CZ.pk.hole = []; CZ.pk.board = []; CZ.pk.pot = 0; CZ.pk.call = 0; savePK(); renderCasino(); return; }
    if (d.hlcard) {
      const card = Number(d.hlcard);
      CZ.hl.card = card;
      if (CZ.hl.count) CZ.hl.seen.push(card);
      saveHL(); renderCasino(); return;
    }
    if (d.hlreset !== undefined) { CZ.hl.seen = []; CZ.hl.card = 0; saveHL(); renderCasino(); return; }
    if (d.kenopick) { CZ.keno = Number(d.kenopick); prefs.set('casino.keno', CZ.keno); renderCasino(); return; }
    if (d.czperiod) { prefs.set('casino.period', d.czperiod); renderCasino(); return; }
    if (d.czhedge) {
      const e2 = S.features.casino.log[d.czhedge];
      if (e2) prefs.set('casino.hedge', { ...HEDGE_DEFAULT, stake: e2.stake, odds: e2.odds, from: e2.id, label: e2.note || '' });
      navOpen('casino', 'bookie');
      setTimeout(() => { const x = $('[data-czform=hedge] [name=o1]'); if (x) { x.scrollIntoView({ block: 'center' }); x.focus(); } }, 50);
      return;
    }
    if (d.czhedgeclear !== undefined) { prefs.set('casino.hedge', HEDGE_DEFAULT); renderCasino(); return; }
    if (d.czwuse) {
      const r = czWinnerRows().rows.find(x => x.key === d.czwuse) || null;
      if (!r) return;
      const calc = czCalc();
      if (r.src === 'live') {
        const outs = r.ev.outcomes.slice(0, 3);
        prefs.set('casino.bookcalc', { ...calc, names: [0, 1, 2].map(i => (outs[i] ? outs[i].name : '')), odds: [0, 1, 2].map(i => Number(CZ.odds.torn[`${r.ev.id}|${i}`]) || 0), pick: Math.min(r.k, 2), chance: 0,
          event: { home: r.ev.home, away: r.ev.away, league: r.league, market: '', start: r.ev.start, more: Math.max(0, r.ev.outcomes.length - 3) } });
      } else {
        const outs = r.pe.outcomes.slice(0, 3);
        prefs.set('casino.bookcalc', { ...calc, names: [0, 1, 2].map(i => (outs[i] ? outs[i].name : '')), odds: [0, 1, 2].map(i => (outs[i] ? outs[i].odds : 0)), pick: Math.min(r.i, 2), chance: 0,
          event: { home: r.pe.home, away: r.pe.away, league: r.pe.league, market: r.pe.market, start: r.pe.start, more: Math.max(0, r.pe.outcomes.length - 3) } });
      }
      renderCasino();
      const f = $('[data-czform="bookcalc"]');
      if (f) { f.scrollIntoView({ block: 'center' }); const o = f.elements[`o${calc.pick}`]; if (o && !o.value) o.focus(); }
      return;
    }
    if (d.czpasteclear !== undefined) { prefs.set('casino.bookcalc', { ...czCalc(), names: ['', '', ''], pick: 0, event: null }); renderCasino(); return; }
    if (d.czcalclog !== undefined) {
      const calc = czCalc();
      const o = Number(calc.odds[calc.pick]) || 0;
      if (!(o > 1 && calc.stake > 0)) return;
      const ev = calc.event;
      const what = calc.names[calc.pick] || 'Bookie bet';
      await cmd('casino.log.add', { game: 'bookie', stake: calc.stake, odds: o, open: true, note: `${ev && ev.home ? `${ev.home} v ${ev.away}: ` : ''}${what}`.slice(0, 200), at: Date.now() });
      toast('Logged as a pending bet in the Tracker.');
      return;
    }
    if (d.czhedgepaste !== undefined) {
      const calc = czCalc();
      const h = { ...HEDGE_DEFAULT, ...prefs.get('casino.hedge', {}) };
      const others = [0, 1, 2].filter(i => i !== calc.pick && Number(calc.odds[i]) > 1).map(i => Number(calc.odds[i]));
      prefs.set('casino.hedge', { ...h, odds: h.odds > 1 ? h.odds : Number(calc.odds[calc.pick]) || 0, o1: others[0] || 0, o2: others[1] || 0, label: h.label || `${calc.event && calc.event.home ? `${calc.event.home} v ${calc.event.away}: ` : ''}${calc.names[calc.pick]}` });
      renderCasino();
      return;
    }
    if (d.czoutcome) { prefs.set('casino.addform', { ...prefs.get('casino.addform', {}), outcome: d.czoutcome }); renderCasino(); return; }
    try {
      if (d.czsessend) {
        const s = S.features.casino.session;
        if (d.czsessend === 'log' && s) await cmd('casino.log.add', { game: s.game, stake: null, net: s.now - s.start, note: `Session: ${money(s.start, true)} bankroll`, at: Date.now() });
        await cmd('casino.session', null);
      } else if (d.czdel) {
        await cmd('casino.log.remove', d.czdel);
      } else if (d.czsettle) {
        const [id, how] = d.czsettle.split(':');
        const e2 = S.features.casino.log[id];
        if (!e2) return;
        let net = how === 'lost' ? -(e2.stake || 0) : e2.odds && e2.stake ? Math.round(e2.stake * (e2.odds - 1)) : null;
        if (how === 'won' && net === null) { CZ.editing = id; renderCasino(); return; } // no odds: type the profit
        await cmd('casino.log.update', id, { net, open: false });
      } else if (d.czsetnet) {
        CZ.editing = d.czsetnet;
        renderCasino();
      } else if (d.czauto) {
        if (d.czauto === 'check') await cmd('casino.log.import');
        else if (d.czauto === 'pause' || d.czauto === 'resume') await cmd('settings.set', 'casino.auto', d.czauto === 'resume');
        else if (d.czauto === 'forget') { if (confirm('Remove the Full access key from this device? Imported entries stay.')) await cmd('casino.logKey.remove'); }
        else if (d.czauto === 'clear') { if (confirm('Delete every entry imported from your Torn log (on all your devices)?')) await cmd('casino.log.clear', 'auto'); }
      } else if (d.czhedgelog) {
        const h = { ...HEDGE_DEFAULT, ...prefs.get('casino.hedge', {}) };
        const p = hedgePlans(h);
        const plan = p && p.plans.find(x => x.key === d.czhedgelog);
        if (!plan) return;
        const names = ['other side', 'draw'];
        let n = 0;
        for (let i = 0; i < plan.stakes.length; i++) {
          if (!plan.stakes[i]) continue;
          await cmd('casino.log.add', { game: 'bookie', stake: plan.stakes[i], odds: p.others[i], open: true, note: `Hedge (${names[i]})${h.label ? ` for ${h.label}` : ''}`.slice(0, 200), at: Date.now() });
          n++;
        }
        toast(`Logged ${n} hedge bet${n === 1 ? '' : 's'} as pending in the Tracker.`);
      } else if (d.czlogbet) {
        CZ.betting = d.czlogbet;
        renderCasino();
      }
    } catch (err) { toast(err.message); }
  });
  el.addEventListener('submit', async e => {
    const f = e.target.closest('[data-czform]');
    if (!f) return;
    e.preventDefault();
    const v = Object.fromEntries(new FormData(f).entries());
    const n = x => (x === undefined || x === '' ? 0 : Number(x) || 0);
    try {
      if (f.dataset.czform === 'sessstart') await cmd('casino.session', { game: v.game, start: n(v.start), now: n(v.start), stopLoss: n(v.stopLoss), target: n(v.target), startedAt: Date.now() });
      else if (f.dataset.czform === 'sessnow') await cmd('casino.session', { ...S.features.casino.session, now: n(v.now) });
      else if (f.dataset.czform === 'lottery') { prefs.set('casino.lottery', { mine: n(v.mine), total: n(v.total), pot: n(v.pot), price: n(v.price) }); renderCasino(); }
      else if (f.dataset.czform === 'bookcalc') {
        const old = czCalc();
        prefs.set('casino.bookcalc', { ...old, odds: [GM.parseOdds(v.o0), GM.parseOdds(v.o1), GM.parseOdds(v.o2)], pick: v.pick !== undefined ? Number(v.pick) || 0 : old.pick, stake: n(v.stake), chance: n(v.chance), bank: n(v.bank), frac: Number(v.frac) || 0.25 });
        renderCasino();
      } else if (f.dataset.czform === 'add') {
        const outcome = prefs.get('casino.addform', {}).outcome || 'won';
        const stake = n(v.stake), odds = GM.parseOdds(v.odds);
        let net = v.net === '' ? null : Number(v.net);
        if (outcome === 'lost') net = net === null ? -stake : -Math.abs(net);
        else if (outcome === 'push') net = 0;
        else if (outcome === 'won' && net === null) {
          if (odds > 1 && stake) net = Math.round(stake * (odds - 1));
          else { toast('Enter the profit, or the stake and odds.'); return; }
        }
        await cmd('casino.log.add', { game: v.game, stake, odds: odds || null, net: outcome === 'open' ? null : net, open: outcome === 'open', note: v.note, at: Date.now() });
        prefs.set('casino.addform', { game: v.game, outcome });
      } else if (f.dataset.czform === 'hedge') {
        const old = { ...HEDGE_DEFAULT, ...prefs.get('casino.hedge', {}) };
        const same = n(v.stake) === old.stake && GM.parseOdds(v.odds) === old.odds;
        prefs.set('casino.hedge', { stake: n(v.stake), odds: GM.parseOdds(v.odds), o1: GM.parseOdds(v.o1), o2: GM.parseOdds(v.o2), h1: n(v.h1), h2: n(v.h2), from: same ? old.from : '', label: same ? old.label : '' });
        renderCasino();
      } else if (f.dataset.czform === 'net') {
        if (v.net === '') return;
        CZ.editing = '';
        await cmd('casino.log.update', f.dataset.id, { net: Number(v.net) || 0, open: false });
      } else if (f.dataset.czform === 'logbet') {
        const [evId, i] = f.dataset.key.split('|');
        const ev = CZ.odds.events && CZ.odds.events.events.find(x => x.id === evId);
        if (!ev || !n(v.stake)) return;
        CZ.betting = '';
        await cmd('casino.log.add', { game: 'bookie', stake: n(v.stake), odds: Number(CZ.odds.torn[f.dataset.key]) || 0, open: true, note: `${ev.home} v ${ev.away}: ${ev.outcomes[i].name}`, at: Date.now() });
        toast('Logged as a pending bet in the Tracker.');
        renderCasino();
      } else if (f.dataset.czform === 'logkey') {
        await cmd('casino.logKey.save', String(v.key || ''));
        toast('Saved: checking your log now.');
      }
    } catch (err) { toast(err.message); }
  });
  el.addEventListener('paste', e => {
    const t = e.target;
    if (!t.matches || !t.matches('[data-czpaste]')) return;
    const text = (e.clipboardData || window.clipboardData).getData('text');
    if (!text) return;
    e.preventDefault();
    czTake(text);
  });
  el.addEventListener('input', e => {
    const t = e.target;
    // Typed or dropped in rather than pasted: read it once it has prices in it.
    if (t.matches && t.matches('[data-czpaste]') && /\d\s*\/\s*\d|x\d/i.test(t.value) && GM.parseBookie(t.value).length) {
      clearTimeout(CZ.pasteT);
      CZ.pasteT = setTimeout(() => czTake(t.value), 600);
    }
  });
  el.addEventListener('change', e => {
    const t = e.target;
    if (t.matches('[data-bjbet]')) { CZ.bj.bet = Math.max(0, Number(t.value) || 0); saveBJ(); renderCasino(); }
    else if (t.matches('[data-pkpot]')) { CZ.pk.pot = Math.max(0, Number(t.value) || 0); savePK(); renderCasino(); }
    else if (t.matches('[data-pkcall]')) { CZ.pk.call = Math.max(0, Number(t.value) || 0); savePK(); renderCasino(); }
    else if (t.matches('[data-hlmod]')) { CZ.hl.mod = Math.min(100, Math.max(1, Number(t.value) || 25)); saveHL(); renderCasino(); }
    else if (t.matches('[data-hlcount]')) { CZ.hl.count = t.checked; CZ.hl.seen = CZ.hl.card && t.checked ? [CZ.hl.card] : []; saveHL(); renderCasino(); }
    else if (t.matches('[data-czsport]')) loadOddsEvents(t.value);
    else if (t.matches('[data-czw]')) { prefs.set('casino.winners', { ...prefs.get('casino.winners', {}), [t.dataset.czw]: t.dataset.czw === 'min' ? Number(t.value) : t.value }); renderCasino(); }
    else if (t.matches('[data-czodds]')) { CZ.odds.torn[t.dataset.czodds] = GM.parseOdds(t.value); renderCasino(); }
    else if (t.matches('.cz-calc[data-czform="bookcalc"] select[name="pick"]')) { prefs.set('casino.bookcalc', { ...czCalc(), pick: Number(t.value) || 0, chance: 0 }); renderCasino(); }
    else if (t.matches('[data-czhedgefrom]')) {
      const e2 = S.features.casino.log[t.value];
      const old = { ...HEDGE_DEFAULT, ...prefs.get('casino.hedge', {}) };
      prefs.set('casino.hedge', e2 ? { ...old, stake: e2.stake, odds: e2.odds, from: e2.id, label: e2.note || '', h1: 0, h2: 0 } : { ...old, from: '' });
      renderCasino();
    } else if (t.matches('[data-czgame]')) { prefs.set('casino.gameFilter', t.value); renderCasino(); }
    else if (t.matches('.cz-add select[name="game"]')) prefs.set('casino.addform', { ...prefs.get('casino.addform', {}), game: t.value });
  });
  el.addEventListener('keydown', e => {
    if (e.key === 'Escape' && e.target.closest('.cz-inline')) { CZ.editing = ''; CZ.betting = ''; renderCasino(); return; }
    const t = e.target.closest('[data-pkcard]');
    if (t && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); pkTap(Number(t.dataset.pkcard)); }
  });
  // Blackjack from the keyboard: A/1, 2-9, 0/T/J/Q/K, Backspace, N.
  document.addEventListener('keydown', e => {
    if (!el.classList.contains('active') || navView('casino') !== 'blackjack' || e.ctrlKey || e.metaKey || e.altKey) return;
    if (/^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement && document.activeElement.tagName)) return;
    if (document.body.classList.contains('gated')) return;
    const k = e.key.toLowerCase();
    const r = k === 'a' || k === '1' ? 1 : /^[2-9]$/.test(k) ? Number(k) : ['0', 't', 'j', 'q', 'k'].includes(k) ? 10 : 0;
    if (r) { e.preventDefault(); bjTap(r); } else if (k === 'backspace') { e.preventDefault(); bjUndo(); } else if (k === 'n' || k === 'escape') { e.preventDefault(); bjNew(); }
  });
}
