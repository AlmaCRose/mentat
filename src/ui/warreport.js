'use strict';
/* global S, $, esc, cmd */
// Post-war report (War tab → War report): pick a finished ranked war, build its report
// (features/warreport.js) and copy it for Discord as text (in parts under Discord's limit) and,
// in the Windows app, as an image. Building fetches the war's report, your chains during it and,
// with faction API access, every attack in it; built reports are kept.

let wrState = { open: false, wars: null, warId: 0, result: null, error: '', spectators: false };

function wrModal() {
  let m = $('#wr-modal');
  if (m) return m;
  m = document.createElement('div');
  m.id = 'wr-modal';
  m.hidden = true;
  m.innerHTML = '<div class="modal-card" role="dialog" aria-label="War report"><button class="modal-close" data-wr-close title="Close (Esc)">&times;</button><div id="wr-body"></div></div>';
  document.body.appendChild(m);
  m.addEventListener('click', wrClick);
  m.addEventListener('change', e => {
    if (e.target.id === 'wr-spect') { wrState.spectators = e.target.checked; if (wrState.warId) wrOpenWar(wrState.warId, false); }
  });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && wrState.open) wrClose(); });
  return m;
}

async function openWarReport() {
  wrState = { ...wrState, open: true, error: '', result: null, warId: 0 };
  wrModal().hidden = false;
  renderWarReport();
  try {
    wrState.wars = await cmd('war.reportWars');
  } catch (e) {
    wrState.error = `Couldn't load your faction's wars: ${e.message || e}`;
  }
  renderWarReport();
}

function wrClose() {
  wrState.open = false;
  const m = $('#wr-modal');
  if (m) m.hidden = true;
}

async function wrOpenWar(id, fresh) {
  wrState.warId = id;
  wrState.error = '';
  if (fresh || !wrState.result || wrState.result.model.war.id !== id) wrState.result = null;
  renderWarReport();
  try {
    wrState.result = await cmd('war.report', id, { fresh: !!fresh, spectators: wrState.spectators });
  } catch (e) {
    wrState.error = e.message || String(e);
  }
  renderWarReport();
}

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch (e) { /* fall back */ }
  const t = document.createElement('textarea');
  t.value = text;
  t.style.position = 'fixed'; t.style.opacity = '0';
  document.body.appendChild(t);
  t.select();
  const ok = document.execCommand('copy');
  t.remove();
  return ok;
}

async function wrClick(e) {
  const m = $('#wr-modal');
  if (e.target === m || e.target.closest('[data-wr-close]')) { wrClose(); return; }
  const w = e.target.closest('[data-wr-war]');
  if (w) { wrOpenWar(Number(w.dataset.wrWar), false); return; }
  if (e.target.closest('[data-wr-back]')) { wrState.warId = 0; wrState.result = null; wrState.error = ''; renderWarReport(); return; }
  if (e.target.closest('[data-wr-rebuild]')) { wrOpenWar(wrState.warId, true); return; }
  const p = e.target.closest('[data-wr-copy]');
  if (p && wrState.result) {
    const ok = await copyText(wrState.result.parts[Number(p.dataset.wrCopy)]);
    p.textContent = ok ? 'Copied ✓' : 'Copy failed';
    setTimeout(() => { if (p.isConnected) p.textContent = p.dataset.label; }, 2000);
    return;
  }
  const img = e.target.closest('[data-wr-image]');
  if (img && wrState.result) {
    img.disabled = true;
    img.textContent = 'Drawing…';
    try {
      const r = await cmd('war.reportImage', wrCardHtml(wrState.result.model, true));
      img.textContent = r && r.copied ? 'Image copied ✓' : 'Not available here';
    } catch (err) {
      img.textContent = 'Image failed';
    }
    setTimeout(() => { if (img.isConnected) { img.textContent = 'Copy image'; img.disabled = false; } }, 2500);
  }
}

const wrNum = n => Math.round(Number(n) || 0).toLocaleString('en-US');
const wrPts = n => (Math.round((Number(n) || 0) * 100) / 100).toLocaleString('en-US', { maximumFractionDigits: 2 });
const wrDate = ms => new Date(ms).toISOString().slice(0, 10);
const wrDur = ms => { const t = Math.round(ms / 60000), d = Math.floor(t / 1440), h = Math.floor((t % 1440) / 60), mm = t % 60; return d ? `${d}d ${h}h ${mm}m` : h ? `${h}h ${mm}m` : `${mm}m`; };

// The report card: shown in the window, and drawn as the image (forImage: no buttons, wider).
function wrCardHtml(m, forImage = false) {
  const res = m.war.forfeit ? (m.war.won ? 'Victory · forfeit' : 'Defeat · forfeit') : m.war.won ? 'Victory' : 'Defeat';
  const facts = [
    `${wrDur(m.war.duration)} long`,
    `${wrNum(m.us.attacks)} hits ours · ${wrNum(m.them.attacks)} theirs`,
    `${m.hitters}/${m.members} of us hit`,
    m.us.rankBefore || m.us.rankAfter ? `Rank ${esc(m.us.rankBefore || '?')} → ${esc(m.us.rankAfter || '?')}` : '',
    m.us.respect ? `${wrNum(m.us.respect)} respect earned` : '',
    m.longestChain && m.longestChain.chain ? `Longest chain ${wrNum(m.longestChain.chain)}` : '',
    m.timeline ? `${m.timeline.leadChanges} lead change${m.timeline.leadChanges === 1 ? '' : 's'}` : '',
    m.timeline && m.timeline.biggestDeficit > 0 ? `${m.war.won ? 'came back from' : 'trailed by up to'} ${wrNum(m.timeline.biggestDeficit)}` : '',
  ].filter(Boolean);
  const top = m.top.filter(x => x.attacks > 0).slice(0, 10);
  const enemy = [m.enemyTop[0] ? `Their MVP: <b>${esc(m.enemyTop[0].name)}</b> (${wrPts(m.enemyTop[0].score)} pts)` : '',
    m.attackStats && m.attackStats.punchingBag ? `Punching bag: <b>${esc(m.attackStats.punchingBag.name)}</b> (hit ${m.attackStats.punchingBag.hits}×)` : ''].filter(Boolean);
  return `<div class="wr-card${forImage ? ' wr-image' : ''}">
    <div class="wr-head">
      <div><div class="wr-title">⚔️ ${esc(m.us.name)} <span class="muted">vs</span> ${esc(m.them.name)}</div>
        <div class="muted small">Ranked war #${m.war.id} · ${wrDate(m.war.start)} → ${wrDate(m.war.end)}</div></div>
      <div class="wr-result ${m.war.won ? 'win' : 'loss'}">${res}</div>
    </div>
    <div class="wr-score"><b>${wrNum(m.us.score)}</b> <span class="muted">–</span> <b>${wrNum(m.them.score)}</b></div>
    <div class="wr-facts">${facts.map(f => `<span>${f}</span>`).join('')}</div>
    <h4>Top scorers</h4>
    <div class="wr-tops">${[top.slice(0, 5), top.slice(5, 10)].filter(c => c.length).map((col, c) => `<table class="data wr-top">${col.map((x, i) => `<tr><td class="num muted">${c * 5 + i + 1}</td><td>${esc(x.name)}</td><td class="num">${wrPts(x.score)} pts</td><td class="num muted">${x.attacks} hits</td></tr>`).join('')}</table>`).join('') || '<div class="muted">Nobody scored.</div>'}</div>
    <div class="wr-cols">
      <div><h4>Accolades</h4><div class="wr-acc">${m.accolades.map(a => `<div><span class="wr-emoji">${a.emoji}</span><b>${esc(a.title)}</b> <span class="muted small">${esc(a.blurb)}</span><div>${a.winners.map(w => `${esc(w.name)} <span class="muted">· ${esc(w.text)}</span>`).join('<br>')}</div></div>`).join('') || '<div class="muted">No accolades.</div>'}</div></div>
    </div>
    ${enemy.length ? `<div class="wr-enemy">😈 ${enemy.join(' · ')}</div>` : ''}
    <div class="wr-foot muted small">Built with Mentat${m.sources.attacks === null ? ' · no attack log (needs faction API access)' : ''}</div>
  </div>`;
}

function renderWarReport() {
  const body = $('#wr-body');
  if (!body || !wrState.open) return;
  const f = S.features.warreport || {};
  const isWeb = document.documentElement.classList.contains('web');
  if (!wrState.warId) {
    const wars = wrState.wars;
    const war = S.features.war || {};
    const live = war.wars && war.wars.ranked && !(war.wars.ranked.end && war.wars.ranked.end <= Date.now()) ? war.wars.ranked : null;
    body.innerHTML = `<h3 style="margin-top:0">War report</h3>
      <div class="note">Pick a finished ranked war. The report has the result, the top scorers and fun accolades, ready to paste into Discord.</div>
      ${wrState.error ? `<div class="note neg">${esc(wrState.error)}</div>` : ''}
      ${live ? `<div class="note">The current war (#${live.id}) can be reported once it ends.</div>` : ''}
      ${!wars ? '<div class="muted">Loading your wars…</div>' : !wars.length ? '<div class="muted">No ranked wars found.</div>'
    : `<table class="data">${wars.map(w => {
      const done = w.end && w.end <= Date.now();
      const won = w.winner && war.own && w.winner === war.own.id;
      return `<tr><td>${wrDate(w.start)}</td><td>vs <b>${esc(w.opponent || '?')}</b></td><td class="num">${wrNum(w.us)} – ${wrNum(w.them)}</td>
        <td>${done ? `<span class="pill ${won ? 'ok' : 'bad'}">${won ? 'Won' : 'Lost'}</span>` : '<span class="pill info">In progress</span>'}</td>
        <td><button data-wr-war="${w.id}" ${done ? '' : 'disabled'}>${(f.built || []).includes(w.id) ? 'Open report' : 'Build report'}</button></td></tr>`;
    }).join('')}</table>`}`;
    return;
  }
  const r = wrState.result;
  if (!r) {
    body.innerHTML = `<h3 style="margin-top:0">War report #${wrState.warId}</h3>
      ${wrState.error ? `<div class="note neg">${esc(wrState.error)}</div><button data-wr-back>Back</button>` : `<div class="muted">Building… ${esc(f.progress || '')}</div><div class="note">This reads the war report, your chains during the war and (with faction API access) every attack, at low priority.</div>`}`;
    return;
  }
  const parts = r.parts;
  body.innerHTML = `<div class="row between wrap" style="gap:6px;margin-bottom:8px">
      <button data-wr-back>← Wars</button>
      <span class="row wrap" style="gap:6px">
        <label class="row"><input type="checkbox" id="wr-spect" ${wrState.spectators ? 'checked' : ''}> List members with 0 hits</label>
        ${parts.map((p, i) => { const label = parts.length > 1 ? `Copy for Discord (${i + 1}/${parts.length})` : 'Copy for Discord'; return `<button class="primary" data-wr-copy="${i}" data-label="${label}" title="${p.length} characters">${label}</button>`; }).join('')}
        ${isWeb ? '' : '<button data-wr-image title="The card below as an image, for pasting into Discord">Copy image</button>'}
        <button data-wr-rebuild title="Fetch everything again">Rebuild</button>
      </span>
    </div>
    ${parts.length > 1 ? '<div class="note">Discord allows 2,000 characters a message, so the text comes in parts: paste them in order.</div>' : ''}
    ${wrState.error ? `<div class="note neg">${esc(wrState.error)}</div>` : ''}
    ${wrCardHtml(r.model)}
    <details style="margin-top:10px"><summary>Discord text</summary><pre class="wr-text">${esc(parts.join('\n\n— next message —\n\n'))}</pre></details>`;
}
