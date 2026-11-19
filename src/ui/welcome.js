'use strict';
/* global S, $, $$, esc, cmd, fmtAgo, NAV_POP, showPanel, errText, afterSignIn, prefs */
// Signing in, the first-run tour, and the admins' member list.
//
// Welcome screen: shown until you're signed in to a Mentat server. Your Torn API key goes to
// the server, which checks with Torn that you're in the faction (or on its allow-list) and
// then forgets it; the app keeps the key on this PC, encrypted, for your own tools.
// Tour: offered once after signing in; every step can be skipped. Replay it from Settings.

// ---- Welcome screen ----
let welcomeFaction = null; // { id, name } from the server's /health, for "for members of …"
let welcomeHealthFor = '';

function renderGate() {
  if (NAV_POP) return; // pop-outs close when you sign out
  const y = S.features.sync;
  const el = $('#welcome');
  if (!el || !y) return;
  const need = !y.signedIn;
  el.hidden = !need;
  document.body.classList.toggle('gated', need);
  if (!need) return;
  const msg = $('#wel-msg');
  const why = y.signedOut && y.signedOut !== 'You signed out.' ? y.signedOut : '';
  msg.hidden = !why;
  msg.textContent = why;
  const url = $('#wel-url');
  if (!url.value) url.value = y.url || y.defaultServer || '';
  // No server built in (see mentat.local.example.json): show the address field straight away.
  if (!url.value && !y.defaultServer) url.closest('details').open = true;
  const target = url.value.trim();
  if (target && target !== welcomeHealthFor) {
    welcomeHealthFor = target;
    cmd('auth.health', target).then(h => {
      welcomeFaction = h.faction;
      decodeText($('#wel-fac'), h.faction && h.faction.name ? `for members of ${h.faction.name}` : 'for your faction');
    }).catch(() => { decodeText($('#wel-fac'), 'for your faction'); });
  }
  if (document.activeElement === document.body) $('#wel-key').focus();
}

// The sign-in screen's "digital" touches: text that decodes from scrambled characters. Decoration
// only (screen readers get the final text at once), and off for reduced motion.
const reduceMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
// The faction line resolves slowly, over about 10 seconds (the user's choice, 2026-11-18).
function decodeText(node, text, ms = 10000) {
  if (!node) return;
  clearInterval(node.decodeTimer);
  node.setAttribute('aria-label', text);
  if (reduceMotion()) { node.textContent = text; return; }
  const glyphs = '01ABCDEF#%$&@<>/\\|=+*';
  let frame = 0;
  const total = Math.max(18, Math.round(ms / 60));
  node.decodeTimer = setInterval(() => {
    frame++;
    const shown = Math.floor((frame / total) * text.length);
    node.textContent = [...text].map((c, i) => (i < shown || c === ' ' ? c : glyphs[(i * 7 + frame * 3) % glyphs.length])).join('');
    if (frame >= total) { clearInterval(node.decodeTimer); node.textContent = text; }
  }, 60);
}

function initWelcome() {
  if (NAV_POP) return;
  const el = document.createElement('div');
  el.id = 'welcome';
  el.hidden = true;
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-modal', 'true');
  el.setAttribute('aria-labelledby', 'wel-title');
  el.innerHTML = `
    <div class="wel-fx" aria-hidden="true"><div class="wel-grid"></div><div class="wel-beam"></div><div class="wel-lines"></div></div>
    <div class="wel-status" aria-hidden="true">MENTAT // SECURE LINK // FACTION CHECK VIA TORN API<span class="wel-cursor">_</span></div>
    <div class="wel-card">
      <span class="wel-corner tl" aria-hidden="true"></span><span class="wel-corner tr" aria-hidden="true"></span><span class="wel-corner bl" aria-hidden="true"></span><span class="wel-corner br" aria-hidden="true"></span>
      <div class="wel-markwrap"><img class="wel-mark" src="../assets/mentat.png" alt=""></div>
      <h1 id="wel-title" data-text="Mentat">Mentat</h1>
      <p class="wel-sub">Torn tools <span id="wel-fac">for your faction</span></p>
      <div id="wel-msg" class="wel-msg" role="status" hidden></div>
      <form id="wel-form" autocomplete="off">
        <label for="wel-key">Your Torn API key</label>
        <div class="wel-keyrow">
          <input id="wel-key" type="password" maxlength="64" spellcheck="false" placeholder="16 letters and numbers" aria-describedby="wel-help">
          <button type="button" id="wel-show" aria-pressed="false">Show</button>
        </div>
        <button class="primary" id="wel-go" type="submit">Sign in</button>
        <div id="wel-error" class="error" role="alert" hidden></div>
      </form>
      <p class="wel-help" id="wel-help">Use a <b>Limited</b> key. <a data-open="https://www.torn.com/preferences.php#tab=api?step=addNewKey&title=Mentat&type=3">Create one for Mentat</a> (opens Torn's key page).</p>
      <details class="wel-more"><summary>What happens to my key?</summary>
        <p>The Mentat server asks Torn whose key it is and which faction they're in, lets you in if you're a member (or an officer added you), and then forgets the key: it isn't stored or logged there.</p>
        <p class="desktop-key">Mentat keeps your key on this PC, encrypted by Windows, for your own tools (your bars, chain timer, targets, travel). It's only ever sent to api.torn.com, and to ffscouter.com if you add FFScouter.</p>
        <p class="web-key">Mentat keeps your key in this browser on this device (this site's own storage), for your own tools (your bars, chain timer, targets, travel). It's only ever sent to api.torn.com, and to ffscouter.com if you add FFScouter. Signing out removes it.</p>
        <p>Shared data (oppo research, war records, market and abroad stock history) comes from the faction's server, so it costs your key nothing.</p>
      </details>
      <details class="wel-more"><summary>Use a different Mentat server</summary>
        <input id="wel-url" type="text" spellcheck="false" placeholder="https://mentat.example.com">
      </details>
    </div>`;
  document.body.appendChild(el);
  $('#wel-show').addEventListener('click', e => {
    const k = $('#wel-key');
    const show = k.type === 'password';
    k.type = show ? 'text' : 'password';
    e.currentTarget.textContent = show ? 'Hide' : 'Show';
    e.currentTarget.setAttribute('aria-pressed', String(show));
  });
  $('#wel-url').addEventListener('change', () => renderGate());
  $('#wel-form').addEventListener('submit', async e => {
    e.preventDefault();
    const err = $('#wel-error');
    const btn = $('#wel-go');
    const key = $('#wel-key').value.replace(/[^A-Za-z0-9]/g, '');
    err.hidden = true;
    if (key.length !== 16) { err.textContent = 'A Torn API key is 16 letters and numbers.'; err.hidden = false; $('#wel-key').focus(); return; }
    btn.disabled = true;
    btn.textContent = 'Checking with Torn…';
    try {
      const r = await cmd('auth.login', key, $('#wel-url').value.trim());
      $('#wel-key').value = '';
      S.features.sync = r;
      renderGate();
      if (r.keyError) toast(`Signed in. Your key couldn't be saved for your own tools: ${r.keyError}`);
      afterSignIn(r.me); // the first-run setup, or the tour
    } catch (ex) {
      err.textContent = errText(ex);
      err.hidden = false;
      $('#wel-key').select();
    } finally {
      btn.disabled = false;
      btn.textContent = 'Sign in';
    }
  });
  renderGate();
}

// ---- The Windows app, offered on the web app on a Windows PC ----
// A card at the top of Overview (until "Not now"), an item in the account menu, and a row in
// Settings → This device. /download on the Mentat server redirects to the newest installer.
const winAppOffer = () => document.documentElement.classList.contains('web') && document.documentElement.classList.contains('windows');
function winAppCard() {
  if (!winAppOffer() || prefs.get('winapp.dismissed', false)) return '';
  return `<div class="card winapp-card" role="region" aria-label="Mentat for Windows">
    <img src="../assets/mentat-mark.png" alt="">
    <div class="winapp-text"><b>Get Mentat for Windows</b>
      <div class="muted small">Torn in its own browser window with tabs, a pop-out chat, tabs that pop out into bubbles on top of other windows, and alerts while it runs in the tray. Sign in the same way; your settings and plan come with you.</div></div>
    <span class="row"><a class="btn primary" href="/download" data-winapp>Download</a><button data-winapp-hide>Not now</button></span>
  </div>`;
}
document.addEventListener('click', e => {
  if (e.target.closest('[data-winapp]')) { toast('Downloading Mentat for Windows. Open the file when it finishes to install it, then sign in with your API key.', 9000); return; }
  if (e.target.closest('[data-winapp-hide]')) {
    prefs.set('winapp.dismissed', true);
    const c = e.target.closest('.winapp-card');
    if (c) c.remove();
    toast('The Windows app stays in Settings → This device and in your account menu.', 6000);
  }
});

// ---- Account button (top bar): who's signed in, Account settings, Sign out ----
function renderAccountButton() {
  const b = $('#btn-account');
  if (!b || NAV_POP) return;
  const y = S.features.sync || {};
  b.hidden = !y.signedIn;
  const me = y.me;
  b.querySelector('.acct-name').textContent = me && me.name ? me.name : 'Account';
  const pic = me && me.id && avatarsOn() && S.features.avatars && S.features.avatars.map ? S.features.avatars.map[me.id] : '';
  let img = b.querySelector('img.acct-av');
  if (pic) {
    if (!img) { img = document.createElement('img'); img.className = 'acct-av'; img.alt = ''; img.referrerPolicy = 'no-referrer'; b.prepend(img); }
    if (img.src !== pic) img.src = pic;
    b.classList.add('has-av');
  } else {
    if (img) img.remove();
    b.classList.remove('has-av');
    if (me && me.id && avatarsOn() && typeof cmd === 'function') cmd('avatars.want', [me.id]).catch(() => {});
  }
  b.title = me && me.name ? `Signed in as ${me.name} [${me.id}]: account and Sign out` : 'Your account and Sign out';
  if (!y.signedIn) accountMenu(false);
}

function accountMenu(open) {
  const old = $('#account-menu');
  const b = $('#btn-account');
  if (old) old.remove();
  if (b) b.setAttribute('aria-expanded', String(!!open));
  if (!open || !b) return;
  const y = S.features.sync || {};
  const me = y.me || {};
  const role = me.role === 'allowed' ? 'on the allow-list' : me.role || '';
  const m = document.createElement('div');
  m.id = 'account-menu';
  m.setAttribute('role', 'menu');
  m.innerHTML = `<div class="am-who"><b>${esc(me.name || 'Signed in')}</b>${me.id ? ` <span class="muted small">[${me.id}]</span>` : ''}
      <div class="muted small">${[role, me.faction && me.faction.name].filter(Boolean).map(esc).join(' · ')}</div></div>
    <button role="menuitem" data-acct="settings">Account settings</button>
    ${winAppOffer() ? '<button role="menuitem" data-acct="winapp">Download the Windows app</button>' : ''}
    <button role="menuitem" data-acct="signout" class="am-out">Sign out</button>`;
  document.body.appendChild(m);
  const r = b.getBoundingClientRect();
  m.style.top = `${Math.round(r.bottom + 6)}px`;
  m.style.left = `${Math.round(Math.max(8, Math.min(r.right - m.offsetWidth, innerWidth - m.offsetWidth - 8)))}px`;
  m.querySelector('button').focus();
}

document.addEventListener('click', async e => {
  if (e.target.closest('#btn-account')) { accountMenu(!$('#account-menu')); return; }
  const a = e.target.closest('[data-acct]');
  if (!a) { if ($('#account-menu') && !e.target.closest('#account-menu')) accountMenu(false); return; }
  accountMenu(false);
  if (a.dataset.acct === 'settings') {
    showPanel('settings');
    cmd('settings.set', 'ui.panel', 'settings');
    const sec = $('#set-account');
    if (sec) sec.scrollIntoView({ block: 'start' });
  } else if (a.dataset.acct === 'winapp') {
    toast('Downloading Mentat for Windows. Open the file when it finishes to install it, then sign in with your API key.', 9000);
    location.href = '/download';
  } else if (a.dataset.acct === 'signout') {
    const web = document.documentElement.classList.contains('web');
    if (!confirm(`Sign out of Mentat on this ${web ? 'device' : 'PC'}? You can sign in again with your API key.${web ? ' Your key is removed from this browser.' : ''}`)) return;
    await cmd('auth.logout').catch(() => {});
  }
});
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && $('#account-menu')) { accountMenu(false); const b = $('#btn-account'); if (b) b.focus(); }
});
window.addEventListener('resize', () => accountMenu(false));

// A short message in the corner.
function toast(text, ms = 9000) {
  const t = document.createElement('div');
  t.className = 'toast';
  t.setAttribute('role', 'status');
  t.textContent = text;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), ms);
}

// ---- First-run tour ----
const TOUR = [
  { title: 'Welcome to Mentat', text: 'A quick look at where everything is. It takes about a minute, and you can stop any time (Esc).' },
  { at: '#panel-nav', title: 'Your tabs', text: 'Every tool has a tab. Drag a tab to move it; right-click one to hide it, pop it out or customise the bar. Ctrl+1 to Ctrl+0 jump to the first ten.' },
  { at: '#panel-nav [data-panel="research"], #panel-nav [data-panel="travel"]', title: 'Sub-tabs', text: 'Some tabs have sub-tabs (Oppo Research, Travel, Market). Drag a sub-tab onto the main bar to give it a tab of its own, or drag tabs into any order.' },
  { at: '#panel-nav [data-panel="chain"], #panel-nav', title: 'Pop-outs and bubbles', text: 'Right-click any tab and pick "Pop out" to give it its own small window. Minimise it and it turns into a bubble that floats on top with a live badge: the chain timer, your energy or landing time, targets ready, the war lead.' },
  { at: '#btn-torn', title: 'The Torn browser', text: 'Torn opens in Mentat\'s own browser window, with tabs. Every Torn link in the tools opens there (Ctrl+D).' },
  { at: '#btn-pages', title: 'Pages', text: 'Jump straight to a Torn page (gym, items, travel agency…) in a new browser tab.' },
  { at: '#btn-chat', title: 'Chat', text: 'Torn\'s chat in a compact window of its own that can stay on top, and collapses to a bubble that lights up with new messages (Ctrl+K).' },
  { at: '#clocks', title: 'Clocks', text: 'Your time, Torn City Time and a third time zone of your choice (click it to change).' },
  { at: '#panel-nav [data-panel="war"], #panel-nav [data-panel="research"]', title: 'War and Oppo Research', text: 'War follows ranked wars live. Oppo Research, the war reports and scouting come from the faction\'s Mentat server, which collects around the clock, so they cost your key nothing.' },
  { at: '#btn-account', title: 'Your account', text: 'Who you\'re signed in as. Click it for your account settings, or to sign out.' },
  { at: '#panel-nav [data-panel="settings"]', title: 'Settings', text: 'Themes (dark and light), the tab layout, alerts and your account. You can replay this tour from Settings → App & browser.' },
];
// On the web and phones some steps read differently (no Torn browser window, chat window or pop-outs).
const TOUR_WEB = {
  'Your tabs': 'Every tool has a tab. Right-click (or long-press) a tab to hide it or customise the bar; your layout follows you between devices.',
  'Pop-outs and bubbles': 'In Torn PDA you can have Mentat bubbles over Torn pages: the chain timer, landing time, energy and more. Settings → This device shows how to add them.',
  'The Torn browser': 'Torn links open in a new tab here, or in Torn PDA on a phone (Settings → This device).',
};
const TOUR_PHONE = {
  'Your tabs': 'Your tabs are along the bottom: the first four, then More for the rest, in the same order as on your other devices.',
  'Sub-tabs': 'Some tabs have sub-tabs (Oppo Research, Travel, Market) along the top of the page.',
};
const tourText = s => (document.documentElement.classList.contains('phone') && TOUR_PHONE[s.title]) || (document.documentElement.classList.contains('web') && TOUR_WEB[s.title]) || s.text;
let tourStep = -1;

function offerTour(me) {
  if (NAV_POP || !S.settings || S.settings.ui.tourDone || $('#tour-offer') || tourStep >= 0) return;
  const d = document.createElement('div');
  d.id = 'tour-offer';
  d.setAttribute('role', 'dialog');
  d.setAttribute('aria-labelledby', 'tour-offer-title');
  d.innerHTML = `<img src="../assets/mentat-mark.png" alt=""><div><b id="tour-offer-title">Welcome${me && me.name ? `, ${esc(me.name)}` : ''}!</b>
    <div class="muted small">Want a quick look at where everything is? About a minute; skip any time.</div>
    <div class="row" style="margin-top:8px"><button class="primary" data-tour-offer="go">Show me around</button><button data-tour-offer="no">Not now</button></div></div>`;
  document.body.appendChild(d);
  d.querySelector('[data-tour-offer="go"]').focus();
}

function startTour() {
  const offer = $('#tour-offer');
  if (offer) offer.remove();
  if (S.settings && S.settings.ui.panel === 'settings') showPanel('overview');
  tourStep = 0;
  let el = $('#tour');
  if (!el) {
    el = document.createElement('div');
    el.id = 'tour';
    el.innerHTML = `<div class="tour-hole"></div><div class="tour-card" role="dialog" aria-live="polite" aria-labelledby="tour-title">
      <div class="tour-count muted small"></div><h3 id="tour-title"></h3><p class="tour-text"></p>
      <div class="row between"><button data-tour="skip">Skip tour</button><span class="row"><button data-tour="back">Back</button><button class="primary" data-tour="next">Next</button></span></div></div>`;
    document.body.appendChild(el);
  }
  el.hidden = false;
  showTourStep();
}

// The first visible element for a step (tabs can be hidden or moved).
function tourTarget(step) {
  if (!step.at) return null;
  for (const sel of step.at.split(',')) {
    const t = $(sel.trim());
    if (t) { const r = t.getBoundingClientRect(); if (r.width > 0 && r.height > 0) return t; }
  }
  return null;
}

function showTourStep() {
  const el = $('#tour');
  const step = TOUR[tourStep];
  if (!el || !step) return endTour();
  const target = tourTarget(step);
  if (step.at && !target) { tourStep += 1; return showTourStep(); } // not on screen in this layout
  const hole = el.querySelector('.tour-hole');
  const card = el.querySelector('.tour-card');
  el.querySelector('.tour-count').textContent = `${tourStep + 1} of ${TOUR.length}`;
  el.querySelector('#tour-title').textContent = step.title;
  el.querySelector('.tour-text').textContent = tourText(step);
  el.querySelector('[data-tour="back"]').disabled = tourStep === 0;
  el.querySelector('[data-tour="next"]').textContent = tourStep === TOUR.length - 1 ? 'Done' : 'Next';
  const pad = 6;
  if (target) {
    const r = target.getBoundingClientRect();
    Object.assign(hole.style, { display: 'block', left: `${r.left - pad}px`, top: `${r.top - pad}px`, width: `${r.width + pad * 2}px`, height: `${r.height + pad * 2}px` });
    // The card goes below the target if there's room, else above, else beside it.
    const cw = Math.min(360, innerWidth - 24);
    const ch = card.offsetHeight || 170;
    let left = Math.min(Math.max(12, r.left), innerWidth - cw - 12);
    let top = r.bottom + 14;
    if (top + ch > innerHeight - 12) top = r.top - ch - 14;
    if (top < 12) { top = Math.min(Math.max(12, r.top), innerHeight - ch - 12); left = r.right + 14 + cw < innerWidth ? r.right + 14 : Math.max(12, r.left - cw - 14); }
    Object.assign(card.style, { left: `${left}px`, top: `${top}px`, width: `${cw}px`, transform: 'none' });
  } else {
    hole.style.display = 'none';
    Object.assign(card.style, { left: '50%', top: '40%', width: `${Math.min(380, innerWidth - 24)}px`, transform: 'translate(-50%, -50%)' });
  }
  el.querySelector('[data-tour="next"]').focus();
}

function endTour() {
  tourStep = -1;
  const el = $('#tour');
  if (el) el.hidden = true;
  if (S.settings && !S.settings.ui.tourDone) cmd('settings.set', 'ui.tourDone', true);
}

document.addEventListener('click', e => {
  const o = e.target.closest('[data-tour-offer]');
  if (o) {
    if (o.dataset.tourOffer === 'go') startTour();
    else { $('#tour-offer').remove(); cmd('settings.set', 'ui.tourDone', true); toast('You can take the tour any time from Settings → App & browser.', 6000); }
    return;
  }
  const b = e.target.closest('[data-tour]');
  if (b) {
    const a = b.dataset.tour;
    if (a === 'skip') endTour();
    else if (a === 'next') { tourStep += 1; showTourStep(); }
    else if (a === 'back') {
      // Back to the previous step that's on screen.
      let i = tourStep - 1;
      while (i > 0 && TOUR[i].at && !tourTarget(TOUR[i])) i--;
      tourStep = Math.max(0, i);
      showTourStep();
    } else if (a === 'replay') startTour();
  }
});
document.addEventListener('keydown', e => {
  if (tourStep < 0) return;
  if (e.key === 'Escape') { e.preventDefault(); endTour(); }
  else if (e.key === 'ArrowRight') { tourStep += 1; showTourStep(); }
  else if (e.key === 'ArrowLeft' && tourStep > 0) { tourStep -= 1; showTourStep(); }
});
window.addEventListener('resize', () => { if (tourStep >= 0) showTourStep(); });

// ---- Admins: members and the allow-list (Settings → Account) ----
let membersData = null;
let membersError = '';
let membersLoading = false;

function isAdmin() {
  const y = S.features.sync || {};
  const role = y.me && y.me.role;
  return y.signedIn && (role === 'admin' || role === 'owner' || (y.kind === 'token' && y.mode === 'server'));
}

async function loadMembers() {
  membersLoading = true;
  renderMembers();
  try { membersData = await cmd('members.list'); membersError = ''; } catch (ex) { membersError = errText(ex); }
  membersLoading = false;
  renderMembers();
}

function renderMembers() {
  const box = $('#members-box');
  if (!box) return;
  if (!isAdmin()) { box.innerHTML = ''; return; }
  const d = membersData;
  const roleText = { admin: 'admin', allowed: 'allow-list', member: 'member' };
  const head = `<h3>Members <span class="row"><button data-mem="load" ${membersLoading ? 'disabled' : ''}>${d ? 'Refresh' : "Show who's using Mentat"}</button></span></h3>
    <div class="note">Who has signed in to the server${d && d.faction && d.faction.name ? `: members of ${esc(d.faction.name)} [${d.faction.id}] get in automatically` : ''}. Players on the allow-list get in from any faction. Anyone who leaves the faction is signed out within half an hour.</div>`;
  if (!d) { box.innerHTML = head + (membersError ? `<div class="error">${esc(membersError)}</div>` : ''); return; }
  const rows = d.members.map(m => `<tr>
      <td>${esc(m.name || `#${m.id}`)} <span class="muted small">[${m.id}]</span>${m.allowNote ? `<div class="muted small">${esc(m.allowNote)}</div>` : ''}</td>
      <td>${roleText[m.role] || m.role}${m.removedAt ? ' <span class="pill bad">left</span>' : !m.inFaction && !m.allowed && m.role !== 'admin' ? ' <span class="pill warn">not in faction</span>' : ''}</td>
      <td>${m.lastSeen ? fmtAgo(m.lastSeen) : '<span class="muted">never</span>'}</td>
      <td>${m.devices.length}</td>
      <td><span class="row">${m.allowed ? `<button data-mem="disallow" data-id="${m.id}">Remove from allow-list</button>` : ''}${m.devices.length && m.role !== 'admin' ? `<button data-mem="signout" data-id="${m.id}">Sign out</button>` : ''}</span></td></tr>`).join('');
  box.innerHTML = `${head}
    <table class="data"><tr><th>Player</th><th>Access</th><th>Last seen</th><th>Devices</th><th></th></tr>${rows || '<tr><td colspan="5" class="muted">Nobody has signed in yet.</td></tr>'}</table>
    <form id="mem-allow" class="row wrap" style="margin-top:8px" autocomplete="off">
      <label for="mem-id">Add to the allow-list</label>
      <input id="mem-id" type="text" inputmode="numeric" placeholder="Player ID" style="width:110px">
      <input id="mem-note" type="text" placeholder="Note (optional)" maxlength="120" style="width:200px">
      <button class="primary">Add</button>
    </form>
    ${membersError ? `<div class="error">${esc(membersError)}</div>` : ''}`;
}

document.addEventListener('click', async e => {
  const b = e.target.closest('[data-mem]');
  if (!b) return;
  const a = b.dataset.mem;
  if (a === 'load') { loadMembers(); return; }
  const id = Number(b.dataset.id);
  const m = membersData && membersData.members.find(x => x.id === id);
  const who = m ? `${m.name || 'player'} [${id}]` : `[${id}]`;
  if (a === 'disallow' && !confirm(`Remove ${who} from the allow-list? If they're not in the faction they're signed out.`)) return;
  if (a === 'signout' && !confirm(`Sign ${who} out on every device? They can sign in again with their key while they're allowed.`)) return;
  b.disabled = true;
  try { membersData = await cmd(a === 'disallow' ? 'members.disallow' : 'members.signout', id); membersError = ''; } catch (ex) { membersError = errText(ex); }
  renderMembers();
});
document.addEventListener('submit', async e => {
  if (e.target.id !== 'mem-allow') return;
  e.preventDefault();
  const id = Number($('#mem-id').value.replace(/\D/g, ''));
  if (!id) { membersError = 'Enter a player ID.'; renderMembers(); return; }
  try { membersData = await cmd('members.allow', id, $('#mem-note').value); membersError = ''; } catch (ex) { membersError = errText(ex); }
  renderMembers();
});
