'use strict';
// Post-war report (the user's request, 2026-11-21): the facts of a finished ranked war plus fun
// accolades, as Discord-ready text (and an image, drawn by the War tab). Sources, all official:
//   /v2/faction/{warId}/rankedwarreport  result, score, hits, rank, rewards, every member (public key)
//   /v2/faction/chains + /v2/faction/{chainId}/chainreport  your chains during the war (public):
//        each attacker's respect (best single hit), mugs, hospitalisations, assists, retaliations,
//        overseas hits, draws, escapes, losses, chain bonus hits
//   /v2/faction/attacks?from&to  every attack in the war. Needs a key with faction API access;
//        without it those accolades are left out and the report says so.
//   Mentat's own score history for the war (lead changes, biggest lead, comebacks).
// Accolades only go to someone who did the thing (a count above zero). Built reports are kept
// (war-reports.json), so opening one again costs nothing.

const { EventEmitter } = require('events');
const { Store } = require('../store');

const PRIORITY = 7;
const MAX_ATTACK_PAGES = 80; // 8,000 attacks
const SUCCESS = new Set(['Attacked', 'Mugged', 'Hospitalized', 'Arrested', 'Looted', 'Special', 'Bounty']);
const DISCORD_LIMIT = 1900; // Discord's message limit is 2,000 characters; keep some room

const num = n => Math.round(Number(n) || 0).toLocaleString('en-US');
const pts = n => (Math.round((Number(n) || 0) * 100) / 100).toLocaleString('en-US', { maximumFractionDigits: 2 });
const s2ms = s => (s ? Number(s) * 1000 : 0);
function dur(ms) {
  const m = Math.round(ms / 60000);
  const d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60), mm = m % 60;
  return d ? `${d}d ${h}h ${mm}m` : h ? `${h}h ${mm}m` : `${mm}m`;
}
const tct = ms => new Date(ms).toISOString().slice(11, 16);

// ---- The report, from data already fetched ----
// report: the API's rankedwarreport. chains: chainreport objects (API shape) during the war.
// attacks: the war's attacks (API shape), or null when the key can't read them. history:
// Mentat's { warId, points: [[t, ours, theirs, target]] } for this war, if any.
function buildModel({ report, ownId, chains = [], attacks = null, history = null, builtAt = Date.now() }) {
  const r = report;
  const facs = r.factions || [];
  const usF = facs.find(f => f.id === ownId) || facs[0];
  const themF = facs.find(f => f !== usF) || {};
  const side = f => ({
    id: f.id, name: f.name || `Faction ${f.id}`, score: f.score || 0, attacks: f.attacks || 0,
    rankBefore: (f.rank && f.rank.before) || '', rankAfter: (f.rank && f.rank.after) || '',
    respect: (f.rewards && f.rewards.respect) || 0, points: (f.rewards && f.rewards.points) || 0,
    items: ((f.rewards && f.rewards.items) || []).map(i => ({ name: i.name, quantity: i.quantity || 1 })),
    members: (f.members || []).map(m => ({ id: m.id, name: m.name || `#${m.id}`, level: m.level || 0, attacks: m.attacks || 0, score: Number(m.score) || 0 })),
  });
  const us = side(usF), them = side(themF);
  const names = new Map([...us.members, ...them.members].map(m => [m.id, m.name]));
  const nameOf = id => names.get(id) || `#${id}`;
  const start = s2ms(r.start), end = s2ms(r.end);
  const accolades = [];
  // Winners of one accolade: everyone tied for the best value (at most 3).
  const award = (key, emoji, title, blurb, rows, value, text, { min = 0, low = false } = {}) => {
    const scored = rows.map(x => ({ x, v: value(x) })).filter(o => Number.isFinite(o.v) && (low ? true : o.v > min));
    if (!scored.length) return;
    const best = low ? Math.min(...scored.map(o => o.v)) : Math.max(...scored.map(o => o.v));
    const winners = scored.filter(o => o.v === best).slice(0, 3).map(o => ({ id: o.x.id, name: o.x.name || nameOf(o.x.id), value: o.v, text: text(o.x, o.v) }));
    accolades.push({ key, emoji, title, blurb, winners });
  };

  // From the war report (always there)
  const hitters = us.members.filter(m => m.attacks > 0);
  award('mvp', '🏆', 'MVP', 'most war score', us.members, m => m.score, (m, v) => `${pts(v)} pts`);
  award('workhorse', '🔨', 'Workhorse', 'most war hits', us.members, m => m.attacks, (m, v) => `${num(v)} hits`);
  award('sharpshooter', '🎯', 'Sharpshooter', 'best score per hit (5+ hits)', us.members.filter(m => m.attacks >= 5), m => Math.round(m.score / m.attacks * 100) / 100, (m, v) => `${pts(v)} pts a hit`);
  const levels = hitters.map(m => m.level).sort((a, b) => a - b);
  const medianLevel = levels.length ? levels[Math.floor(levels.length / 2)] : 0;
  award('mighty', '🐜', 'Small but Mighty', 'lowest level to put up a top-10 score',
    [...hitters].sort((a, b) => b.score - a.score).slice(0, 10).filter(m => m.level < medianLevel), m => m.level, (m, v) => `level ${v}, ${pts(m.score)} pts`, { low: true });

  // From your chains during the war
  const agg = new Map(); // id -> summed counts
  let longest = null, bonusList = [];
  for (const c of chains) {
    const d = c.details || {};
    if (!longest || (d.chain || 0) > longest.chain) longest = { id: c.id, chain: d.chain || 0, respect: d.respect || 0, start: s2ms(c.start), end: s2ms(c.end) };
    for (const b of c.bonuses || []) bonusList.push({ id: b.attacker_id, chain: b.chain, respect: b.respect });
    for (const a of c.attackers || []) {
      const t = a.attacks || {}, rs = a.respect || {};
      const o = agg.get(a.id) || { id: a.id, best: 0, mug: 0, hospitalize: 0, assists: 0, retaliations: 0, overseas: 0, draws: 0, escapes: 0, losses: 0, bonuses: 0, total: 0 };
      o.best = Math.max(o.best, rs.best || 0);
      for (const k of ['mug', 'hospitalize', 'assists', 'retaliations', 'overseas', 'draws', 'escapes', 'losses', 'bonuses', 'total']) o[k] += t[k] || 0;
      agg.set(a.id, o);
    }
  }
  const chainRows = [...agg.values()]; // names come from the war report (nameOf)
  award('heavy', '💥', 'Heavy Hitter', 'biggest single hit (respect)', chainRows, o => Math.round(o.best * 100) / 100, (o, v) => `${pts(v)} respect in one hit`);
  const bigBonus = bonusList.sort((a, b) => b.respect - a.respect)[0];
  award('bonus', '🎁', 'Bonus Hunter', 'most chain bonus hits', chainRows, o => o.bonuses, (o, v) => `${v} bonus hit${v === 1 ? '' : 's'}${bigBonus && bigBonus.id === o.id ? ` (incl. hit #${num(bigBonus.chain)} for ${num(bigBonus.respect)} respect)` : ''}`);
  award('pickpocket', '💰', 'Pickpocket', 'most mugs', chainRows, o => o.mug, (o, v) => `${v} mug${v === 1 ? '' : 's'}`);
  award('hospital', '🏥', 'Hospital Director', 'most hospitalisations', chainRows, o => o.hospitalize, (o, v) => `${v} sent to hospital`);
  award('assists', '🤝', 'Team Player', 'most assists', chainRows, o => o.assists, (o, v) => `${v} assist${v === 1 ? '' : 's'}`);
  award('payback', '😤', 'Payback', 'most retaliations', chainRows, o => o.retaliations, (o, v) => `${v} retal${v === 1 ? '' : 's'}`);
  award('globetrotter', '✈️', 'Globetrotter', 'most overseas hits', chainRows, o => o.overseas, (o, v) => `${v} hit${v === 1 ? '' : 's'} abroad`);
  award('peacemaker', '🕊️', 'Peacemaker', 'most draws', chainRows, o => o.draws, (o, v) => `${v} stalemate${v === 1 ? '' : 's'}`);
  award('character', '🩹', 'Character Building', 'most losses (it builds character)', chainRows, o => o.losses, (o, v) => `${v} L${v === 1 ? '' : 's'}`);

  // From the attack log (faction API access)
  let attackStats = null;
  if (Array.isArray(attacks)) {
    const fid = a => (a && a.faction && a.faction.id) || 0;
    const war = attacks.filter(a => a.is_ranked_war);
    const out = war.filter(a => fid(a.attacker) === us.id);
    const inc = war.filter(a => fid(a.defender) === us.id && fid(a.attacker) !== us.id);
    const won = out.filter(a => SUCCESS.has(a.result)).sort((a, b) => a.started - b.started);
    const byAttacker = new Map();
    for (const a of won) { const l = byAttacker.get(a.attacker.id) || []; l.push(a); byAttacker.set(a.attacker.id, l); }
    const people = [...byAttacker.entries()].map(([id, list]) => ({ id, name: list[0].attacker.name, list }));
    if (won.length) {
      const f = won[0], l = won[won.length - 1];
      accolades.push({ key: 'first', emoji: '🩸', title: 'First Blood', blurb: 'first war hit', winners: [{ id: f.attacker.id, name: f.attacker.name, value: f.started, text: `on ${f.defender.name} at ${tct(s2ms(f.started))} TCT` }] });
      accolades.push({ key: 'closer', emoji: '🔚', title: 'The Closer', blurb: 'last war hit', winners: [{ id: l.attacker.id, name: l.attacker.name, value: l.started, text: `on ${l.defender.name} at ${tct(s2ms(l.started))} TCT` }] });
    }
    award('owl', '🦉', 'Night Owl', 'most war hits 00:00–06:00 TCT', people, p => p.list.filter(a => new Date(s2ms(a.started)).getUTCHours() < 6).length, (p, v) => `${v} hits after midnight`);
    award('speed', '⚡', 'Speed Demon', 'most war hits in one hour', people, p => {
      let best = 0, i = 0;
      for (let j = 0; j < p.list.length; j++) { while (p.list[j].started - p.list[i].started > 3600) i++; best = Math.max(best, j - i + 1); }
      return best;
    }, (p, v) => `${v} hits in an hour`);
    award('slayer', '🗡️', 'Giant Slayer', 'beat the biggest level gap', people, p => Math.max(0, ...p.list.map(a => (a.defender.level || 0) - (a.attacker.level || 0))), (p, v) => {
      const a = p.list.reduce((x, y) => ((y.defender.level || 0) - (y.attacker.level || 0) > (x.defender.level || 0) - (x.attacker.level || 0) ? y : x));
      return `level ${a.attacker.level} beat level ${a.defender.level} ${a.defender.name}`;
    });
    award('ninja', '🥷', 'Ninja', 'most stealthed war hits', people, p => p.list.filter(a => a.is_stealthed).length, (p, v) => `${v} stealthed`);
    // Incoming: who held off the enemy, and who spent the war in hospital
    const defenders = new Map();
    for (const a of inc) {
      const o = defenders.get(a.defender.id) || { id: a.defender.id, name: a.defender.name, held: 0, hospital: 0 };
      if (SUCCESS.has(a.result)) o.hospital++;
      else if (a.result !== 'Assist' && a.result !== 'None') o.held++;
      defenders.set(a.defender.id, o);
    }
    award('wall', '🧱', 'Brick Wall', 'most enemy attacks held off', [...defenders.values()], o => o.held, (o, v) => `${v} attack${v === 1 ? '' : 's'} survived`);
    award('flyer', '🛌', 'Frequent Flyer', 'most trips to hospital (thanks for tanking)', [...defenders.values()], o => o.hospital, (o, v) => `${v} trip${v === 1 ? '' : 's'} to hospital`);
    // The enemy we hit the most
    const bags = new Map();
    for (const a of won) { const o = bags.get(a.defender.id) || { id: a.defender.id, name: a.defender.name, n: 0 }; o.n++; bags.set(a.defender.id, o); }
    const bag = [...bags.values()].sort((a, b) => b.n - a.n)[0];
    attackStats = { outgoing: out.length, won: won.length, incoming: inc.length, enemyHospitalised: won.filter(a => a.result === 'Hospitalized').length, punchingBag: bag ? { id: bag.id, name: bag.name, hits: bag.n } : null };
  }

  // Score history from Mentat (lead changes, biggest lead, comeback)
  let timeline = null;
  if (history && history.warId === r.id && Array.isArray(history.points) && history.points.length > 1) {
    let changes = 0, lastSign = 0, bestLead = 0, worst = 0, bestAt = 0, worstAt = 0;
    for (const [t, a, b] of history.points) {
      const d = a - b;
      const s = Math.sign(d);
      if (s && lastSign && s !== lastSign) changes++;
      if (s) lastSign = s;
      if (d > bestLead) { bestLead = d; bestAt = t; }
      if (d < worst) { worst = d; worstAt = t; }
    }
    timeline = { leadChanges: changes, biggestLead: bestLead, biggestLeadAt: bestAt, biggestDeficit: -worst, biggestDeficitAt: worstAt, samples: history.points.length };
  }

  const won = r.winner === us.id;
  return {
    builtAt,
    war: { id: r.id, start, end, duration: end - start, forfeit: !!r.forfeit, won, winner: r.winner, margin: us.score - them.score },
    us: { ...us, members: undefined }, them: { ...them, members: undefined },
    top: [...us.members].sort((a, b) => b.score - a.score || b.attacks - a.attacks),
    spectators: us.members.filter(m => m.attacks === 0).map(m => ({ id: m.id, name: m.name, level: m.level })),
    hitters: hitters.length, members: us.members.length,
    enemyTop: [...them.members].sort((a, b) => b.score - a.score).slice(0, 3),
    longestChain: longest, chainCount: chains.length,
    attackStats, timeline, accolades,
    sources: { chains: chains.length, attacks: Array.isArray(attacks) ? attacks.length : null, history: !!timeline },
  };
}

// ---- Discord text: parts of at most DISCORD_LIMIT characters, split between sections ----
function discordParts(m, { spectators = false, topN = 10 } = {}) {
  const res = m.war.forfeit ? (m.war.won ? 'Victory (they forfeited)' : 'Defeat (forfeit)') : m.war.won ? 'Victory!' : 'Defeat';
  const sections = [];
  const head = [`## ⚔️ ${m.us.name} vs ${m.them.name} — ${res}`,
    `**${num(m.us.score)} – ${num(m.them.score)}** · ${dur(m.war.duration)} · ranked war #${m.war.id}`,
    `Hits: ${num(m.us.attacks)} ours, ${num(m.them.attacks)} theirs · ${m.hitters}/${m.members} of us landed a hit`];
  if (m.us.rankBefore || m.us.rankAfter) head.push(`Rank: ${m.us.rankBefore || '?'} → ${m.us.rankAfter || '?'}`);
  const rewards = [m.us.respect ? `${num(m.us.respect)} respect` : '', m.us.points ? `${num(m.us.points)} points` : '', ...m.us.items.map(i => `${i.quantity > 1 ? `${i.quantity}× ` : ''}${i.name}`)].filter(Boolean);
  if (rewards.length) head.push(`Rewards: ${rewards.join(', ')}`);
  if (m.timeline) {
    const t = m.timeline;
    const bits = [`${t.leadChanges} lead change${t.leadChanges === 1 ? '' : 's'}`];
    if (t.biggestLead > 0) bits.push(`biggest lead ${num(t.biggestLead)}`);
    if (t.biggestDeficit > 0) bits.push(`${m.war.won ? 'came back from' : 'trailed by up to'} ${num(t.biggestDeficit)}`);
    head.push(`Swing: ${bits.join(' · ')}`);
  }
  if (m.longestChain && m.longestChain.chain) head.push(`Longest chain: ${num(m.longestChain.chain)} hits (${num(m.longestChain.respect)} respect)`);
  sections.push(head.join('\n'));

  const top = m.top.filter(x => x.attacks > 0).slice(0, topN);
  if (top.length) {
    const w = Math.min(18, Math.max(...top.map(x => x.name.length)));
    const rows = top.map((x, i) => `${String(i + 1).padStart(2)}. ${x.name.slice(0, w).padEnd(w)}  ${pts(x.score).padStart(8)} pts  ${String(x.attacks).padStart(4)} hits`);
    sections.push(`**Top scorers**\n\`\`\`\n${rows.join('\n')}\n\`\`\``);
  }
  if (m.accolades.length) {
    sections.push(`**🏅 Accolades**\n${m.accolades.map(a => `${a.emoji} **${a.title}** — ${a.winners.map(w => `${w.name} (${w.text})`).join(', ')}`).join('\n')}`);
  }
  const theirs = [];
  if (m.enemyTop[0]) theirs.push(`Their MVP: ${m.enemyTop[0].name} (${pts(m.enemyTop[0].score)} pts)`);
  if (m.attackStats && m.attackStats.punchingBag) theirs.push(`Punching bag: ${m.attackStats.punchingBag.name} (hit ${m.attackStats.punchingBag.hits}×)`);
  if (theirs.length) sections.push(`**😈 Their side** — ${theirs.join(' · ')}`);
  if (spectators && m.spectators.length) sections.push(`**🍿 Watched from the stands** — ${m.spectators.map(s => s.name).join(', ')}`);
  sections.push('-# Built with Mentat');

  // Pack sections into parts under the limit; a section that's too long on its own is cut by lines.
  const parts = [];
  let cur = '';
  const push = s => { if (cur && (cur + '\n\n' + s).length > DISCORD_LIMIT) { parts.push(cur); cur = s; } else cur = cur ? `${cur}\n\n${s}` : s; };
  for (const s of sections) {
    if (s.length <= DISCORD_LIMIT) { push(s); continue; }
    let chunk = '';
    for (const line of s.split('\n')) {
      if ((chunk + '\n' + line).length > DISCORD_LIMIT) { push(chunk); chunk = line; } else chunk = chunk ? `${chunk}\n${line}` : line;
    }
    if (chunk) push(chunk);
  }
  if (cur) parts.push(cur);
  return parts;
}

// ---- The feature: fetch, build, keep ----
class WarReportFeature extends EventEmitter {
  constructor({ api, war, dataDir }) {
    super();
    this.api = api;
    this.war = war;
    this.store = new Store(`${dataDir}/war-reports.json`, { reports: {} }, { debounceMs: 2000 });
    this.state = { building: 0, progress: '', error: '', wars: null };
  }

  snapshot() {
    return { ...this.state, built: Object.keys(this.store.get('reports') || {}).map(Number) };
  }

  tick() {}

  ownId() {
    return (this.war.state.own && this.war.state.own.id) || 0;
  }

  set(patch) {
    this.state = { ...this.state, ...patch };
    this.emit('state');
  }

  // Your faction's recent ranked wars, newest first.
  async listWars() {
    const d = await this.api.request('/v2/faction/rankedwars?limit=20&sort=DESC', { soft: [6, 7, 16], priority: 3 });
    const own = this.ownId();
    const wars = (d.rankedwars || []).map(w => {
      const fs = w.factions || [];
      const them = fs.find(f => f.id !== own) || {};
      const us = fs.find(f => f.id === own) || {};
      return { id: w.id, start: s2ms(w.start), end: s2ms(w.end), winner: w.winner || 0, us: us.score || 0, them: them.score || 0, opponent: them.name || '' };
    });
    this.set({ wars });
    return wars;
  }

  // The report for one war: kept, or built now. fresh = build again.
  async build(warId, { fresh = false } = {}) {
    const id = Number(warId);
    if (!Number.isInteger(id) || id <= 0) throw new Error('Which war?');
    const kept = (this.store.get('reports') || {})[id];
    if (kept && !fresh) return kept;
    const own = this.ownId();
    if (!own) throw new Error('Your faction is still loading; try again in a moment.');
    this.set({ building: id, progress: 'War report…', error: '' });
    try {
      const d = await this.api.request(`/v2/faction/${id}/rankedwarreport`, { soft: [6, 7], priority: PRIORITY });
      const report = d.rankedwarreport;
      if (!report || !report.end) throw new Error("That war hasn't finished (Torn makes its report when it ends).");
      if (!(report.factions || []).some(f => f.id === own)) throw new Error("Your faction wasn't in that war.");
      // Your chains during the war
      this.set({ progress: 'Chains…' });
      const c = await this.api.request(`/v2/faction/chains?from=${report.start - 86400}&to=${report.end + 3600}&limit=100`, { soft: [6, 7], priority: PRIORITY });
      const during = (c.chains || []).filter(x => x.end >= report.start && x.start <= report.end);
      const chains = [];
      for (const [i, ch] of during.entries()) {
        this.set({ progress: `Chain reports ${i + 1}/${during.length}…` });
        try { const cr = await this.api.request(`/v2/faction/${ch.id}/chainreport`, { soft: [6, 7], priority: PRIORITY }); if (cr.chainreport) chains.push(cr.chainreport); } catch (e) { /* skip one */ }
      }
      // Every attack in the war (faction API access only)
      let attacks = [];
      let from = report.start;
      const seen = new Set();
      for (let page = 0; page < MAX_ATTACK_PAGES; page++) {
        this.set({ progress: `Attacks ${attacks.length ? `(${num(attacks.length)})` : ''}…` });
        let a;
        try {
          a = await this.api.request(`/v2/faction/attacks?from=${from}&to=${report.end}&limit=100&sort=ASC`, { soft: [6, 7, 16], priority: PRIORITY });
        } catch (e) {
          if (e.kind === 'soft') { attacks = null; break; } // no faction API access
          throw e;
        }
        const list = (a.attacks || []).filter(x => !seen.has(x.id));
        for (const x of list) seen.add(x.id);
        attacks.push(...list);
        if ((a.attacks || []).length < 100 || !list.length) break;
        from = Math.max(from, ...list.map(x => x.started));
      }
      const history = this.war.history ? this.war.history() : null;
      const model = buildModel({ report, ownId: own, chains, attacks, history });
      const all = this.store.get('reports') || {};
      all[id] = model;
      // Keep the 20 newest
      const keep = Object.keys(all).map(Number).sort((a, b) => b - a).slice(0, 20);
      this.store.set('reports', Object.fromEntries(keep.map(k => [k, all[k]])));
      this.set({ building: 0, progress: '' });
      return model;
    } catch (e) {
      this.set({ building: 0, progress: '', error: e.message });
      throw e;
    }
  }

  flush() { this.store.flush(); }
}

module.exports = { WarReportFeature, buildModel, discordParts };
