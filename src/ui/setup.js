'use strict';
/* global S, $, esc, cmd, NAV_POP, NAV_PANELS, navModel, navEdit, navIcon, themeCards, THEMES, LIGHT_THEMES, ALERT_PRESETS, syncSettingInputs, offerTour, startTour, toast */
/* exported afterSignIn, openSetup */
// First-run setup: the first time someone signs in, a few quick choices before they start:
// colours, tabs along the top or down the side, which tabs and top bar buttons they want (if any),
// and a starter set of alerts. Each choice applies at once (the app behind the card changes), so
// "Skip" at any point keeps what was picked so far. Shown once per person: ui.setupDone is synced,
// and someone whose settings were already on the server before the setup existed never sees it
// (sync.js). Run it again from Settings → App & browser.

const SETUP_TAB_NOTES = {
  overview: 'Your bars, cooldowns, travel and events at a glance',
  chain: 'Chain timer, with alerts before it drops',
  targets: 'Your target list: who is out of hospital',
  mugger: 'Mug targets abroad: traders near you, their cash on hand, the mug take and the fight',
  faction: "Your faction's members, activity and war record",
  war: 'Ranked wars live: the score and enemies coming out',
  research: 'Oppo research on enemy factions, war reports, scouting',
  market: 'Item prices, watchlist alerts, deals, trade calculator',
  travel: 'What to buy abroad, and when to fly',
  planner: 'Plan the next few days: trips timed to restocks, gym, crimes, boosts, blood bags',
  casino: 'Blackjack, poker, High-Low and bookie helpers, plus a betting tracker',
  alerts: 'Your own timer alerts (sounds and popups)',
};
// The starter alerts ticked unless the person changes them.
const SETUP_RECOMMENDED = ['energy', 'nerve', 'travel', 'chain', 'warstart'];

let SU = null; // the open setup: { steps, i, me, hidden: Set of nav ids, alerts: Set of preset indexes, added: Map preset index -> rule id }
let setupWaiting = false;
const setupPhone = () => document.documentElement.classList.contains('phone');
const setupWeb = () => document.documentElement.classList.contains('web');

// After signing in (or starting signed in): the setup the first time, else the tour offer.
// Waits for the first sync with the server, which brings this person's settings from their
// other devices (and so whether they've done the setup already).
async function afterSignIn(me) {
  if (NAV_POP || !S.settings || setupWaiting || SU) return;
  if (S.settings.ui.setupDone) { offerTour(me); return; }
  setupWaiting = true;
  const t0 = Date.now();
  while (Date.now() - t0 < 12000) {
    const y = S.features.sync || {};
    if (!y.signedIn) { setupWaiting = false; return; }
    if ((y.lastOkAt && !y.busy) || y.error) break;
    await new Promise(r => setTimeout(r, 300));
  }
  setupWaiting = false;
  if (!S.settings || !(S.features.sync || {}).signedIn) return;
  if (S.settings.ui.setupDone) offerTour(me);
  else openSetup(me);
}

function setupRules() { return (S.features.alerts && S.features.alerts.rules) || []; }
const setupHasPreset = p => setupRules().some(r => r.timer === p.timer && r.before === p.before && !r.target);

function openSetup(me) {
  if (NAV_POP || !S.settings) return;
  const offer = $('#tour-offer');
  if (offer) offer.remove();
  SU = {
    steps: ['look', ...(setupPhone() ? [] : ['layout']), 'tabs', 'buttons', 'alerts', 'done'],
    i: 0,
    me: me || (S.features.sync && S.features.sync.me) || null,
    hidden: new Set(navModel().hidden),
    alerts: new Set(ALERT_PRESETS.map((p, i) => (SETUP_RECOMMENDED.includes(p.timer) && !setupHasPreset(p) ? i : -1)).filter(i => i >= 0)),
    added: new Map(),
  };
  let el = $('#setup');
  if (!el) {
    el = document.createElement('div');
    el.id = 'setup';
    document.body.appendChild(el);
  }
  el.hidden = false;
  renderSetup();
}

const SETUP_TITLES = {
  look: 'Pick your colours', layout: 'Tabs along the top, or down the side?', tabs: 'Which tabs do you want?',
  buttons: 'Top bar buttons', alerts: 'Start with some alerts?', done: "You're all set",
};

function setupCheck({ attr, checked, disabled, icon, title, text, extra = '' }) {
  return `<label class="setup-check"><input type="checkbox" ${attr}${checked ? ' checked' : ''}${disabled ? ' disabled' : ''}>
    ${icon ? `<svg class="setup-icon" viewBox="0 0 24 24" aria-hidden="true">${icon}</svg>` : ''}
    <span><b>${esc(title)}</b>${text ? `<span class="muted small">${text}</span>` : ''}</span>${extra}</label>`;
}

function setupBody(step) {
  const u = S.settings.ui;
  if (step === 'look') {
    const name = SU.me && SU.me.name ? `, ${esc(SU.me.name)}` : '';
    return `<p>Welcome${name}! A few quick choices to make Mentat yours. Each one shows straight away, and you can change any of it later in Settings.</p>
      <div class="theme-group-label muted small">Dark</div>${themeCards(THEMES)}
      <div class="theme-group-label muted small">Light</div>${themeCards(LIGHT_THEMES)}
      <div class="setting"><label>Match ${setupWeb() ? "this device's" : "Windows'"} light/dark mode<div class="note" style="margin:0">Switches between your dark pick and your light pick. With this on, click one theme in each group.</div></label><input type="checkbox" data-set="ui.themeAuto"></div>
      <div class="setting"><label>Accent colour<div class="note" style="margin:0">Buttons, highlights and the active tab. Default uses the theme's own.</div></label>
        <span class="row"><input type="color" data-set="ui.accent" style="width:46px;height:28px;padding:2px"><button data-set="ui.accent" data-value='""'>Default</button></span></div>`;
  }
  if (step === 'layout') {
    const side = u.navLayout === 'side';
    const opt = (v, label, text) => `<button class="setup-opt" data-setup-layout="${v}" aria-pressed="${(v === 'side') === side}">
      <span class="lay-demo ${v}" aria-hidden="true"><i class="lay-bar"></i><i class="lay-body"></i></span><b>${label}</b><span class="muted small">${text}</span></button>`;
    return `<p>Where your tabs go. You can switch any time (Settings → Customization).</p>
      <div class="setup-opts">${opt('top', 'Top bar', 'Tabs in a row along the top. Pages with sub-tabs show them across the top of the page.')}
      ${opt('side', 'Side bar', 'Tabs down the left. Sub-tabs sit in small menus under their tab, and the bar folds down to icons (Ctrl+B).')}</div>
      ${side ? '<div class="setting"><label>Start with the side bar folded down to icons</label><input type="checkbox" data-set="ui.navCollapsed"></div>' : ''}`;
  }
  if (step === 'tabs') {
    const tabs = NAV_PANELS.filter(([id]) => id !== 'settings');
    return `<p>Untick the ones you won't use. Settings always stays. ${setupPhone() ? 'Later you can bring tabs back or reorder them (long-press a tab, or Settings → Customization). On a phone the first four are along the bottom and the rest are under More.' : 'Later you can bring tabs back, drag them into any order, or right-click one for more.'}</p>
      <div class="setup-quick"><button data-setup-tabs="all">Show all</button></div>
      <div class="setup-list">${tabs.map(([id, label]) => setupCheck({ attr: `data-setup-tab="${id}"`, checked: !SU.hidden.has(id), icon: navIcon(id), title: label, text: esc(SETUP_TAB_NOTES[id] || '') })).join('')}</div>`;
  }
  if (step === 'buttons') {
    const b = u.buttons || {};
    const list = [
      ['torn', 'Open Torn', setupWeb() ? 'Opens Torn in a new tab (or in Torn PDA on a phone).' : "Opens Torn in Mentat's own browser window, with tabs."],
      ['pages', 'Pages', 'A menu of Torn pages to jump to: gym, items, travel agency and more.'],
      ...(setupWeb() ? [] : [['chat', 'Chat', "Torn's chat in a small window of its own that can stay on top."]]),
      ['clocks', 'Clocks', setupPhone() ? 'Torn City Time.' : 'Your time and Torn City Time (a third time zone can be added in Settings).'],
      ['account', 'Account', "Your name, with your account settings and Sign out. Sign out is in Settings → Account either way."],
    ];
    return `<p>Pick the ones you want on the top bar, or none at all.${setupWeb() ? '' : ' Ctrl+D (Torn) and Ctrl+K (chat) work either way.'}</p>
      <div class="setup-quick"><button data-setup-btns="all">All</button><button data-setup-btns="none">None</button></div>
      <div class="setup-list">${list.map(([k, title, text]) => setupCheck({ attr: `data-set="ui.buttons.${k}"`, checked: b[k] !== false, title, text: esc(text) })).join('')}</div>`;
  }
  if (step === 'alerts') {
    return `<p>Mentat can play a sound and show a popup a little before a timer runs out. The recommended ones are ticked; press &#9654; to hear one. You can change times and sounds, or add your own, in the Alerts tab.</p>
      <div class="setup-quick"><button data-setup-alerts="rec">Recommended</button><button data-setup-alerts="none">None</button></div>
      <div class="setup-list">${ALERT_PRESETS.map((p, i) => {
        const have = setupHasPreset(p) && !SU.added.has(i);
        const [what, when] = p.text.split(' · ');
        return setupCheck({ attr: `data-setup-alert="${i}"`, checked: have || SU.alerts.has(i), disabled: have, title: what, text: esc(have ? `${when} (you have this one)` : when),
          extra: `<button type="button" class="icon-btn" data-setup-sound="${esc(p.sound)}" title="Play this sound" aria-label="Play the ${esc(what)} sound">&#9654;</button>` });
      }).join('')}</div>
      <div class="note">Built-in "it's done" popups (energy full, landed, drug cooldown over…) are already on. Change them in Settings → Notifications.</div>`;
  }
  // Done: what was picked.
  const all = [...THEMES, ...LIGHT_THEMES];
  const tname = k => (all.find(t => t[0] === k) || [k, k])[1];
  const look = u.themeAuto ? `${tname(u.themeDark)} (dark) and ${tname(u.themeLight)} (light), following ${setupWeb() ? 'this device' : 'Windows'}` : tname(u.theme);
  const m = navModel();
  const b = u.buttons || {};
  const btns = [['torn', 'Open Torn'], ['pages', 'Pages'], ...(setupWeb() ? [] : [['chat', 'Chat']]), ['clocks', 'Clocks'], ['account', 'Account']].filter(([k]) => b[k] !== false).map(x => x[1]);
  // The alerts just added may not be in the alerts list yet.
  const nAlerts = new Set([...setupRules().map(r => r.id), ...SU.added.values()]).size;
  const rows = [
    ['Colours', esc(look)],
    ...(setupPhone() ? [] : [['Tabs', u.navLayout === 'side' ? `Side bar${u.navCollapsed ? ', folded to icons' : ''}` : 'Top bar']]),
    ['Showing', `${m.main.length} tab${m.main.length === 1 ? '' : 's'}: ${m.main.map(id => esc(NAV_PANELS.find(p => p[0] === id) ? NAV_PANELS.find(p => p[0] === id)[1] : id)).join(', ')}`],
    ['Top bar', btns.length ? esc(btns.join(', ')) : 'No buttons'],
    ['Alerts', nAlerts ? `${nAlerts} alert${nAlerts === 1 ? '' : 's'}` : 'None yet'],
  ];
  return `<p>Mentat is ready. Everything here can be changed in Settings → Customization, and alerts in the Alerts tab.</p>
    <table class="data setup-summary">${rows.map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join('')}</table>
    <p class="muted small" style="margin-top:10px">New here? The tour takes about a minute and shows where everything is.</p>`;
}

function renderSetup() {
  const el = $('#setup');
  if (!SU || !el) return;
  const step = SU.steps[SU.i];
  const count = SU.steps.length - 1; // "done" isn't counted
  const foot = step === 'done'
    ? `<button data-setup="back">Back</button><span class="row"><button data-setup="finish">Start using Mentat</button><button class="primary" data-setup="tour">Show me around</button></span>`
    : `<button data-setup="skip" title="Keeps what you've picked so far">Skip setup</button><span class="row">${SU.i > 0 ? '<button data-setup="back">Back</button>' : ''}<button class="primary" data-setup="next">Next</button></span>`;
  el.innerHTML = `<div class="setup-card" role="dialog" aria-modal="true" aria-labelledby="setup-title">
    <div class="setup-head"><img src="../assets/mentat-mark.png" alt=""><div><div class="muted small">${step === 'done' ? 'Set up Mentat · done' : `Set up Mentat · step ${SU.i + 1} of ${count}`}</div><h2 id="setup-title">${esc(SETUP_TITLES[step])}</h2></div></div>
    <div class="setup-dots" aria-hidden="true">${SU.steps.slice(0, -1).map((s, i) => `<i class="${i < SU.i ? 'done' : i === SU.i ? 'on' : ''}"></i>`).join('')}</div>
    <div class="setup-body">${setupBody(step)}</div>
    <div class="setup-foot">${foot}</div></div>`;
  syncSettingInputs(); // theme picks marked, checkboxes filled
  const first = el.querySelector('.setup-body [aria-pressed="true"], .setup-body .theme-card.active, .setup-body input:not(:disabled), [data-setup="next"], [data-setup="tour"]');
  if (first) first.focus({ preventScroll: true });
}

// Starter alerts: added when leaving that step; going back and changing them adds or removes the difference.
async function setupApplyAlerts() {
  for (const [i, id] of [...SU.added]) {
    if (SU.alerts.has(i)) continue;
    try { await cmd('alerts.remove', id); } catch (e) { /* already gone */ }
    SU.added.delete(i);
  }
  for (const i of [...SU.alerts]) {
    if (SU.added.has(i)) continue;
    const p = ALERT_PRESETS[i];
    if (setupHasPreset(p)) continue;
    try {
      const r = await cmd('alerts.add', { timer: p.timer, before: p.before, sound: p.sound, desktop: true });
      if (r && r.id) SU.added.set(i, r.id);
    } catch (e) { toast(`Couldn't add the "${p.text}" alert: ${e.message || e}`); }
  }
}

function setupClose() {
  const el = $('#setup');
  if (el) { el.hidden = true; el.innerHTML = ''; }
  SU = null;
  if (!S.settings.ui.setupDone) cmd('settings.set', 'ui.setupDone', true);
}

async function setupGo(dir) {
  if (!SU) return;
  if (dir > 0 && SU.steps[SU.i] === 'alerts') {
    const btn = $('#setup [data-setup="next"]');
    if (btn) { btn.disabled = true; btn.textContent = 'Adding alerts…'; }
    await setupApplyAlerts();
    if (!SU) return;
  }
  SU.i = Math.max(0, Math.min(SU.steps.length - 1, SU.i + dir));
  renderSetup();
}

document.addEventListener('click', e => {
  if (e.target.closest('[data-setup-open]')) { openSetup(); return; }
  if (!SU || !e.target.closest('#setup')) return;
  const a = e.target.closest('[data-setup]');
  if (a) {
    const act = a.dataset.setup;
    if (act === 'next') setupGo(1);
    else if (act === 'back') setupGo(-1);
    else if (act === 'skip') {
      const me = SU.me;
      setupClose();
      toast('Setup skipped. Run it again any time from Settings → App & browser.', 7000);
      offerTour(me);
    } else if (act === 'finish') {
      setupClose();
      if (!S.settings.ui.tourDone) { cmd('settings.set', 'ui.tourDone', true); toast('The tour is in Settings → App & browser whenever you want it.', 6000); }
    } else if (act === 'tour') { setupClose(); startTour(); }
    return;
  }
  const lay = e.target.closest('[data-setup-layout]');
  if (lay) {
    const v = lay.dataset.setupLayout;
    cmd('settings.set', 'ui.navLayout', v).then(() => {
      if (!SU) return;
      renderSetup();
      const b = $(`#setup [data-setup-layout="${v}"]`);
      if (b) b.focus();
    });
    return;
  }
  const snd = e.target.closest('[data-setup-sound]');
  if (snd) { e.preventDefault(); cmd('alerts.preview', snd.dataset.setupSound); return; }
  const tabs = e.target.closest('[data-setup-tabs]');
  if (tabs) {
    for (const [id] of NAV_PANELS) SU.hidden.delete(id);
    navEdit(n => { n.hidden = [...SU.hidden]; });
    for (const c of document.querySelectorAll('#setup [data-setup-tab]')) c.checked = true;
    return;
  }
  const btns = e.target.closest('[data-setup-btns]');
  if (btns) {
    const on = btns.dataset.setupBtns === 'all';
    for (const c of document.querySelectorAll('#setup [data-set^="ui.buttons."]')) { c.checked = on; cmd('settings.set', c.dataset.set, on); }
    return;
  }
  const al = e.target.closest('[data-setup-alerts]');
  if (al) {
    const rec = al.dataset.setupAlerts === 'rec';
    SU.alerts = new Set(rec ? ALERT_PRESETS.map((p, i) => (SETUP_RECOMMENDED.includes(p.timer) ? i : -1)).filter(i => i >= 0) : []);
    for (const c of document.querySelectorAll('#setup [data-setup-alert]:not(:disabled)')) c.checked = SU.alerts.has(Number(c.dataset.setupAlert));
  }
});

document.addEventListener('change', e => {
  if (!SU) return;
  const t = e.target;
  if (t.matches('#setup [data-setup-tab]')) {
    const id = t.dataset.setupTab;
    if (t.checked) SU.hidden.delete(id); else SU.hidden.add(id);
    navEdit(n => { n.hidden = [...SU.hidden]; });
  } else if (t.matches('#setup [data-setup-alert]')) {
    const i = Number(t.dataset.setupAlert);
    if (t.checked) SU.alerts.add(i); else SU.alerts.delete(i);
  }
});

document.addEventListener('keydown', e => {
  if (!SU || e.key !== 'Escape' || e.target.closest('input[type="color"]')) return;
  e.preventDefault();
  const me = SU.me;
  setupClose();
  toast('Setup skipped. Run it again any time from Settings → App & browser.', 7000);
  offerTour(me);
});
