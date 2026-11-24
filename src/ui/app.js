'use strict';
/* global app, S, $, $, panel, esc, PICTURE_TABS, renderWarReport, fmtDur, fmtAgo, num, countdown, ago, profileUrl, attackUrl, link, statusPill, cmd, renderTravel, renderMarket, initTravel, initMarket, loadCatalog, renderAlerts, initAlerts, initItemModal, renderItemModal, renderWar, initWar, renderResearch, initResearch, renderFaction, initFaction, navModel, navLabel, navIcon, navResolve, navParent, renderNavEditor, NAV_PANELS */
/* exported showPanel */
// navActive is nav.js's (the main-bar entry on show).
/* global navActive:writable */

// ---- Header: Torn browser + pages ----
$('#btn-torn').addEventListener('click', () => cmd('torn.show'));
$('#btn-chat').addEventListener('click', () => cmd('chatwin.toggle'));
$('#btn-pages').addEventListener('click', e => {
  const r = e.currentTarget.getBoundingClientRect();
  cmd('pages.menu', r.left, r.bottom);
});
// ---- Navigation: tabs along the top bar, or a side bar that collapses to icons ----
// The main bar's buttons come from the tab layout (nav.js). Ctrl+1…9, 0 open the first ten.
let navDrawn = '';
function renderNav() {
  const m = navModel();
  const collapsed = document.body.classList.contains('nav-collapsed');
  // Expanded side bar: a small sub-menu under each tab with sub-tabs (nav.js navSubsInBar).
  const side = navSubsInBar();
  const hasMenu = id => side && NAV_SUBS[id] && m.subs[id].length > 1;
  const key = `${m.main.join()}|${collapsed}|${side}|${m.main.filter(hasMenu).map(p => `${p}:${navSubsOpen(p)}:${m.subs[p].join('.')}`).join()}`;
  if (key !== navDrawn) {
    navDrawn = key;
    $('#panel-nav').innerHTML = m.main.map((id, i) => {
      const label = navLabel(id);
      const keys = i < 10 ? `Ctrl+${(i + 1) % 10}` : '';
      const tip = keys ? `${label} (${keys})` : label;
      const open = hasMenu(id) && navSubsOpen(id);
      const chev = hasMenu(id) ? `<span class="nav-chev${open ? ' open' : ''}" data-nav-toggle="${id}" role="button" aria-expanded="${open}" title="${open ? 'Hide' : 'Show'} ${esc(label)}'s sub-tabs"><svg viewBox="0 0 12 12" aria-hidden="true"><path d="M4 2.5 7.5 6 4 9.5" /></svg></span>` : '';
      const subs = open ? `<div class="nav-subs" data-nav-subbar="${id}" role="group" aria-label="${esc(label)}">${m.subs[id].map(v => `<button class="nav-sub" data-nav-sub="${id}:${v}" draggable="true">${esc(navLabel(`${id}:${v}`))}</button>`).join('')}</div>` : '';
      return `<button data-panel="${id}" draggable="true" aria-label="${esc(label)}" title="${esc(collapsed ? tip : keys || label)}"><svg class="nav-icon" viewBox="0 0 24 24" aria-hidden="true">${navIcon(id)}</svg><span class="nav-label">${esc(label)}</span>${chev}</button>${subs}`;
    }).join('') + (m.main.length > 4 && document.documentElement.classList.contains('phone') ? '<button class="nav-more" data-nav-more aria-haspopup="true" aria-expanded="false"><svg class="nav-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 10a2 2 0 1 0 0 4 2 2 0 0 0 0-4zm7 0a2 2 0 1 0 0 4 2 2 0 0 0 0-4zm7 0a2 2 0 1 0 0 4 2 2 0 0 0 0-4z"/></svg><span class="nav-label">More</span></button>' : '');
  }
  for (const b of $$('#panel-nav [data-panel]')) b.classList.toggle('active', b.dataset.panel === navActive);
  const more = $('#panel-nav [data-nav-more]');
  if (more) more.classList.toggle('has-active', m.main.indexOf(navActive) >= 4);
  for (const b of $$('#panel-nav [data-nav-sub]')) {
    const p = navParent(b.dataset.navSub);
    b.classList.toggle('active', navActive === p && navView(p) === navSubOf(b.dataset.navSub));
  }
}
let navApplied = '';
function applyNavLayout() {
  if (NAV_POP) return; // a pop-out has no tab bar
  const u = (S.settings && S.settings.ui) || {};
  const side = u.navLayout === 'side' && !document.documentElement.classList.contains('phone'); // phones: the bottom bar
  const collapsed = side && !!u.navCollapsed;
  const key = `${side}|${collapsed}`;
  if (key === navApplied) return;
  navApplied = key;
  const nav = $('#panel-nav');
  const clocks = $('#clocks');
  if (side) {
    $('#sidebar-nav').appendChild(nav);
    $('#sidebar').prepend(clocks); // times at the top of the side bar
  } else {
    $('#toolbar .brand').after(nav);
    $('#btn-chat').before(clocks);
  }
  // "YOU SHOULD BE STACKING" stays right after the name in both layouts (stacking.js).
  const nag = $('#stack-nag');
  if (nag) $('#toolbar .brand').after(nag);
  $('#sidebar').hidden = !side;
  document.body.classList.toggle('nav-side', side);
  document.body.classList.toggle('nav-collapsed', collapsed);
  renderNav(); // collapsed: names show as tooltips
  // Sub-tabs move between the side bar and the panels: redraw the open panel.
  if ($('#panels > section.active')) showPanel(navActive);
  const t = $('#sidebar-toggle');
  t.querySelector('.nav-icon').innerHTML = collapsed ? '&#187;' : '&#171;';
  t.title = collapsed ? 'Expand the side bar (Ctrl+B)' : 'Collapse the side bar (Ctrl+B)';
  renderClocks();
}
// Top bar buttons and clocks the user turned off (Settings → Customization, or the first-run setup).
function applyButtons() {
  const b = (S.settings && S.settings.ui && S.settings.ui.buttons) || {};
  for (const k of ['torn', 'pages', 'chat', 'clocks', 'account']) document.body.classList.toggle(`hide-${k}`, b[k] === false);
}
function toggleSidebar() {
  const u = (S.settings && S.settings.ui) || {};
  if (u.navLayout === 'side') cmd('settings.set', 'ui.navCollapsed', !u.navCollapsed);
}
$('#sidebar-toggle').addEventListener('click', toggleSidebar);
document.addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'b') { e.preventDefault(); toggleSidebar(); }
});

// ---- Clocks: local, Torn City Time (UTC) and a chosen third zone ----
const clockFormats = new Map();
function clockFmt(zone, h24, withDate = false) {
  const key = `${zone}|${h24}|${withDate}`;
  if (!clockFormats.has(key)) {
    const opts = withDate
      ? { timeZone: zone, weekday: 'short', year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: !h24, timeZoneName: 'short' }
      : { timeZone: zone, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: !h24 };
    clockFormats.set(key, new Intl.DateTimeFormat('en-US', opts));
  }
  return clockFormats.get(key);
}
const zoneLabel = z => (z === 'UTC' ? 'UTC' : z.split('/').pop().replace(/_/g, ' '));
const LOCAL_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;
function renderClocks() {
  const el = $('#clocks');
  if (!el || !S.settings) return;
  const u = S.settings.ui || {};
  const h24 = u.clock24 !== false;
  const third = u.clockZone || 'America/New_York';
  const now = new Date();
  const showThird = u.clockThird !== false;
  const clocks = [
    ['Local', LOCAL_ZONE, `Your time (${LOCAL_ZONE})`],
    ['TCT', 'UTC', 'Torn City Time (UTC)'],
  ];
  if (showThird) clocks.push([zoneLabel(third), third, `${third} · click to change`]);
  const sel = $('#clock-zone');
  if (sel) sel.disabled = !showThird;
  // Collapsed side bar: only Torn time fits (HH:MM); its tooltip lists every clock.
  const collapsed = document.body.classList.contains('nav-collapsed');
  const all = clocks.map(([label, zone]) => `${label}: ${clockFmt(zone, h24).format(now)}`).join('\n');
  el.innerHTML = clocks.map(([label, zone, title], i) => `
    <div class="clock ${i === 1 ? 'tct' : ''}" ${i === 2 ? 'data-goto-clock' : ''} title="${esc(collapsed && i === 1 ? all : `${title}\n${clockFmt(zone, h24, true).format(now)}`)}">
      <span class="clock-label">${esc(label)}</span><span class="clock-time">${esc(clockFmt(zone, h24).format(now))}</span>${i === 1 ? `<span class="clock-short">${now.toISOString().slice(11, 16)}</span>` : ''}
    </div>`).join('');
}
// Tick on the second boundary so the seconds change together with the system clock.
(function clockLoop() {
  renderClocks();
  setTimeout(clockLoop, 1000 - (Date.now() % 1000) + 5);
})();
$('#clocks').addEventListener('click', e => {
  if (!e.target.closest('[data-goto-clock]')) return;
  showPanel('settings');
  cmd('settings.set', 'ui.panel', 'settings');
  const sel = $('#clock-zone');
  if (sel) { sel.scrollIntoView({ block: 'center' }); sel.focus(); }
});

function renderBrowserButton() {
  const b = S.browser || {};
  $('#btn-torn').textContent = b.open ? `Show Torn (${b.tabs} tab${b.tabs === 1 ? '' : 's'})` : 'Open Torn';
}

// ---- Generic click handling ----
// Every Torn link in the tool opens as a new tab in the Torn browser window.
document.addEventListener('click', e => {
  const open = e.target.closest('[data-open]');
  if (open) {
    e.preventDefault();
    cmd('torn.open', open.dataset.open, true);
    return;
  }
  const b = e.target.closest('[data-cmd]');
  if (b && !b.disabled) {
    // data-arg, and data-arg2 for a second argument
    const args = b.dataset.arg === undefined ? [] : [b.dataset.arg, b.dataset.arg2].filter(v => v !== undefined).map(v => (isNaN(v) ? v : Number(v)));
    cmd(b.dataset.cmd, ...args);
    return;
  }
  const p = e.target.closest('#panel-nav [data-panel]');
  if (p) {
    showPanel(p.dataset.panel);
    cmd('settings.set', 'ui.panel', p.dataset.panel);
  }
});
document.addEventListener('auxclick', e => {
  const open = e.target.closest('[data-open]');
  if (open && e.button === 1) { e.preventDefault(); cmd('torn.open', open.dataset.open, true); }
});

function showPanel(entry) {
  if (NAV_POP && String(entry) !== NAV_POP) {
    const same = !NAV_POP.includes(':') && navParent(entry) === NAV_POP;
    if (!same) { cmd('pop.toMain', String(entry)); return; }
    const v = navSubOf(entry);
    if (v) prefs.set(NAV_SUBS[NAV_POP].pref, v);
    entry = NAV_POP;
  }
  const id = navResolve(entry);
  navActive = id;
  const name = navParent(id);
  renderNav();
  $$('#panels > section').forEach(s => s.classList.toggle('active', s.dataset.panel === name));
  if (name === 'targets') renderTargetsShell();
  if (name === 'travel') renderTravel();
  if (name === 'market') renderMarket();
  if (name === 'alerts') renderAlerts();
  if (name === 'casino') renderCasino();
  if (name === 'planner') renderPlanner();
  if (name === 'war') renderWar();
  if (name === 'research') renderResearch();
  if (name === 'faction') renderFaction();
}

// ---- Banner + footer ----
function renderApi() {
  const a = S.api;
  const banner = $('#banner');
  let msg = a.banner || '';
  if (!a.hasKey && !msg) msg = 'Add your Torn API key in Settings to turn on the tools.';
  banner.hidden = !msg;
  banner.textContent = msg;
  const paused = a.pausedUntil ? ` · paused ${countdown(a.pausedUntil, 'resuming')}` : '';
  // With a Mentat server: everything Mentat did with your key in the last minute (this device,
  // the server, phone alerts, your other devices) against Torn's 100 per player.
  let all = '';
  if (a.total != null) {
    const d = a.othersDetail || {};
    const parts = [`this device ${a.usedLastMinute}`, `the server ${d.server || 0}`];
    if (d.push) parts.push(`phone alerts ${d.push}`);
    parts.push(`other devices ${d.devices || 0}${d.deviceCount ? ` (${d.deviceCount})` : ''}`);
    const tip = `Calls made with your key in the last minute: ${parts.join(', ')}. Torn allows ${a.tornLimit} per minute across all your keys; Mentat keeps everything together under 95. Other tools (Torn PDA, TornTools, the Mentat PDA bubbles) aren't counted.`;
    const near = a.total >= 80;
    all = ` · <span title="${esc(tip)}"${near ? ' style="color:var(--text);font-weight:700"' : ''}>all Mentat ${a.total}/${a.tornLimit}${near ? ' (near limit)' : ''}</span>`;
  }
  $('#api-footer').innerHTML = a.hasKey
    ? `<span>${a.account ? `${esc(a.account.name)} [${a.account.id}]` : 'Key set'}</span><span class="mono">API ${a.usedLastMinute}/${a.budget || a.maxPerMinute} per min${all}${paused}</span>`
    : '<span>No API key</span><span>api.torn.com only</span>';
  renderSettingsAccount();
}

// ---- Overview ----
// Buttons under each bar: where to spend it or what refills it. Each opens a new Torn tab.
// Inventory buttons open your Items page on that category.
const BAR_ACTIONS = {
  Energy: [['Gym', 'gym.php'], ['Points Store', 'points.php'], ['Energy Drinks', 'item.php#energy-drink-items']],
  Nerve: [['Crimes', 'page.php?sid=crimes'], ['Alcohol', 'item.php#alcohol-items']],
  Happy: [['Boosters', 'item.php#boosters-items'], ['Candy', 'item.php#candy-items'], ['Drugs', 'item.php#drugs-items']],
  Life: [['Medical', 'item.php#medical-items'], ['Faction Medical', 'factions.php?step=your#/tab=armoury&start=0&sub=medical']],
};

const QUICK_LINKS = [
  ['Home', 'index.php'], ['Gym', 'gym.php'], ['Crimes', 'page.php?sid=crimes'],
  ['Items', 'item.php'], ['Travel', 'travelagency.php'], ['Hospital', 'hospitalview.php'],
  ['Faction', 'factions.php?step=your'], ['Item Market', 'page.php?sid=ItemMarket'], ['Bazaars', 'bazaar.php'],
  ['Stocks', 'page.php?sid=stocks'], ['Education', 'page.php?sid=education'], ['Missions', 'page.php?sid=missions'],
];

function renderOverview() {
  const el = panel('overview');
  const f = S.features.user;
  const d = f && f.data;
  if (!S.api.hasKey) { el.innerHTML = `${winAppCard()}<div class="empty">No API key yet.<br><br><button class="primary" data-goto="settings">Open settings</button></div>${quickLinks()}`; return; }
  if (!d) { el.innerHTML = `${winAppCard()}<div class="empty">${f && f.error ? esc(f.error) : 'Loading your status…'}</div>${quickLinks()}`; return; }

  const bar = (name, b, color) => {
    if (!b) return '';
    const pct = b.maximum ? Math.min(100, (b.current / b.maximum) * 100) : 0;
    const full = b.current >= b.maximum || b.fullAt <= Date.now();
    const right = full ? '<span class="muted">full</span>' : `<span class="muted">full in</span> ${countdown(b.fullAt, 'full')}`;
    const actions = (BAR_ACTIONS[name] || []).map(([label, page]) => `<button data-open="https://www.torn.com/${page}">${label}</button>`).join('');
    return `<div class="bar"><div class="label"><span><b>${name}</b> <span class="mono">${num(b.current)} / ${num(b.maximum)}</span></span><span>${right}</span></div>
      <div class="track"><div class="fill" style="width:${pct}%;background:${color}"></div></div>
      ${actions ? `<div class="bar-actions">${actions}</div>` : ''}</div>`;
  };
  const cd = (name, until) => `<div class="stat"><div class="k">${name}</div><div class="v">${countdown(until, 'ready')}</div></div>`;
  const st = d.status;
  const travel = d.travel && d.travel.arriveAt > Date.now()
    ? `<div class="card" style="margin-top:8px">Flying to <b>${esc(d.travel.destination)}</b> · lands in ${countdown(d.travel.arriveAt, 'landed')}</div>`
    : '';
  const n = d.notifications;
  const refills = d.refills;

  el.innerHTML = `${winAppCard()}
    <div class="player">
      <div class="me-row">${avatar(d.me.id, 'av-lg')}<div><div class="name">${link(profileUrl(d.me.id), esc(d.me.name))} <span class="muted small">[${d.me.id}] · Lv ${d.me.level}</span></div>
      <div class="muted small">${esc(st.description)}</div></div></div>
      ${statusPill(st, st.until)}
    </div>
    ${travel}
    ${f.limited ? '<div class="note">Your key is a Public key, so bars and cooldowns are hidden. A Minimal key unlocks them.</div>' : ''}
    ${d.bars ? `<h3>Bars</h3>
      ${bar('Energy', d.bars.energy, 'var(--energy)')}
      ${bar('Nerve', d.bars.nerve, 'var(--nerve)')}
      ${bar('Happy', d.bars.happy, 'var(--happy)')}
      ${bar('Life', d.bars.life, 'var(--life)')}` : ''}
    ${d.cooldowns ? `<h3>Cooldowns</h3><div class="grid3">${cd('Drug', d.cooldowns.drug)}${cd('Booster', d.cooldowns.booster)}${cd('Medical', d.cooldowns.medical)}</div>` : ''}
    ${refills ? `<h3>Daily refills</h3><div class="row">
      ${['energy', 'nerve', 'token'].map(k => `<span class="pill ${refills[k] ? '' : 'ok'}">${k[0].toUpperCase() + k.slice(1)} ${refills[k] ? 'used' : 'available'}</span>`).join('')}
    </div>` : ''}
    ${n ? `<h3>Unread</h3><div class="grid3">
      <div class="stat">${link('https://www.torn.com/events.php', '<div class="k">Events</div>')}<div class="v">${n.events}</div></div>
      <div class="stat">${link('https://www.torn.com/messages.php', '<div class="k">Messages</div>')}<div class="v">${n.messages}</div></div>
      <div class="stat">${link('https://www.torn.com/awards.php', '<div class="k">Awards</div>')}<div class="v">${n.awards}</div></div>
    </div>` : ''}
    ${quickLinks()}
    <div class="row between note"><span>Updated ${ago(f.fetchedAt)}</span><a data-cmd="user.refresh">Refresh</a></div>`;
}

function quickLinks() {
  return `<h3>Quick links</h3><div class="links">${QUICK_LINKS.map(([n, u]) => `<button data-open="https://www.torn.com/${u}">${n}</button>`).join('')}</div>`;
}

// ---- Chain ----
function chainClass(sec) {
  if (sec > 150) return 'ok';
  if (sec > 90) return 'warn';
  if (sec > 30) return 'hot';
  return 'crit';
}

function renderChain() {
  const el = panel('chain');
  const s = S.settings && S.settings.chain;
  if (!S.api.hasKey) { el.innerHTML = '<div class="empty">Add an API key in Settings to see your faction chain.</div>'; return; }
  if (s && !s.enabled) { el.innerHTML = '<div class="empty">The chain timer is turned off.<br><br><button data-set="chain.enabled" data-value="true">Turn it on</button></div>'; return; }
  const f = S.features.chain || {};
  const c = f.chain;
  if (!c) { el.innerHTML = '<div class="empty">Loading chain…</div>'; return; }
  if (c.noFaction) { el.innerHTML = '<div class="empty">You are not in a faction (or your key can\'t see its chain).</div>'; return; }

  const now = Date.now();
  const active = c.current > 0 && !c.cooldown && c.expiresAt > now;
  let timer;
  if (c.cooldown) timer = `<div class="time warn mono">${countdown(c.cooldownUntil, 'over')}</div><div class="count">Chain cooldown · ${num(c.current)} hits</div>`;
  else if (active) timer = `<div class="time mono ${chainClass((c.expiresAt - now) / 1000)}" data-chain-until="${c.expiresAt}">${fmtDur((c.expiresAt - now) / 1000)}</div>
      <div class="count"><b>${num(c.current)}</b> / ${num(c.max)} hits · ×${c.modifier}</div>`;
  else timer = '<div class="time muted mono">0:00</div><div class="count muted">No chain running</div>';

  const r = f.report;
  const names = (f.members && f.members.names) || {};
  const who = id => `${avatar(id)}${link(profileUrl(id), esc(names[id] || `#${id}`))}`;
  let report = '';
  if (r && !r.none && r.top && r.top.length) {
    const mine = r.mine ? `<div class="grid3" style="margin-bottom:8px">
        <div class="stat"><div class="k">Your rank</div><div class="v">${r.rank} / ${r.count}</div></div>
        <div class="stat"><div class="k">Your hits</div><div class="v">${num(r.mine.attacks)}</div></div>
        <div class="stat"><div class="k">Your respect</div><div class="v">${num(r.mine.total)}</div></div></div>` : '';
    report = `<h3>Top hitters <span class="small" style="text-transform:none">${ago(r.fetchedAt)}</span></h3>${mine}
      <table><tr><th>#</th><th>Member</th><th class="num">Hits</th><th class="num">Respect</th><th class="num">Best</th></tr>
      ${r.top.map((a, i) => `<tr class="${r.mine && a.id === r.mine.id ? 'me' : ''}"><td>${i + 1}</td><td>${who(a.id)}</td><td class="num">${num(a.attacks)}</td><td class="num">${num(a.total)}</td><td class="num">${num(a.best)}</td></tr>`).join('')}
      </table>`;
  }

  const m = f.members;
  let online = '';
  if (m && !m.denied) {
    online = `<h3>Online now <span class="small" style="text-transform:none">${m.online.filter(x => x.action === 'Online').length} online · ${m.online.filter(x => x.action === 'Idle').length} idle of ${m.total}</span></h3>
      <table>${m.online.slice(0, 60).map(x => `<tr><td>${avatar(x.id)}${link(profileUrl(x.id), esc(x.name))}</td><td><span class="pill ${x.action === 'Online' ? 'ok' : 'warn'}">${x.action}</span></td><td>${statusPill({ state: x.state, description: x.description }, x.until)}</td></tr>`).join('')}</table>`;
  }

  const alertsOn = s && s.alerts;
  el.innerHTML = `
    <div class="card chain-timer">${timer}</div>
    <div class="row between" style="margin-top:8px">
      <label class="row"><input type="checkbox" data-set="chain.alerts" ${alertsOn ? 'checked' : ''}> Alerts at ${[150, 90, 60, 30].filter(x => s && s[`t${x}`]).map(x => fmtDur(x)).join(', ') || 'none'}</label>
      <span class="row"><button data-test-beep>Test</button><button data-cmd="chain.refresh">Refresh</button></span>
    </div>
    <div class="note">Updated ${ago(c.fetchedAt)}${s && s.minChain ? ` · alerts start at ${s.minChain} hits` : ''}</div>
    ${report}${online}`;
}

// ---- Targets ----
// Two sub-tabs: Targets (your list) and Abroad (players abroad: ready when they're in the country
// you're in; anyone who leaves that country is removed from it, the user's rule, 2026-11-21).
function renderTargetsShell() {
  const el = panel('targets');
  if (!el) return;
  const view = navView('targets');
  el.dataset.view = view;
  if (view === 'abroad') {
    el.innerHTML = `
      ${navSubnav('targets', 'tgsub')}
      <div id="abroad-where" class="card" style="padding:8px 10px"></div>
      <div class="note">Add players: on Torn's page of the people in a country, right-click a name → <b>Add all players in this list to Abroad targets</b> (while you're abroad or flying out). Players in the country you're in show as ready; anyone who leaves it is removed from this list.</div>
      <div class="row between" style="margin-top:6px">
        <label>Then by <select id="target-sort">
          <option value="status">Name</option>
          <option value="ffLow">Fair fight, easiest first</option>
          <option value="ffHigh">Fair fight, best respect first</option>
          <option value="bsLow">Estimated stats, lowest first</option>
          <option value="bsHigh">Estimated stats, highest first</option>
          <option value="level">Level</option>
        </select></label>
        <span class="row"><button data-cmd="targets.refreshAll">Refresh all</button><button id="abroad-clear" class="danger">Clear list</button></span>
      </div>
      <div id="target-rate" class="note"></div>
      <div id="target-msg" class="note"></div>
      <div id="abroad-list" style="margin-top:6px"></div>`;
    $('#target-sort').value = prefs.get('targets.sort', 'status');
    $('#target-sort').addEventListener('change', e => { prefs.set('targets.sort', e.target.value); renderTargets(); });
    $('#abroad-clear').addEventListener('click', async () => {
      if (!confirm('Remove everyone from the Abroad list? Players also on your Targets list stay there.')) return;
      await cmd('targets.clear', 'abroad');
    });
    renderTargets();
    return;
  }
  el.innerHTML = `
    ${navSubnav('targets', 'tgsub')}
    <form id="target-add" class="keyrow">
      <input id="target-input" placeholder="Player IDs or profile links" spellcheck="false">
      <button class="primary">Add</button>
    </form>
    <div class="row between" style="margin-top:6px">
      <button data-cmd="targets.addCurrent" title="Adds the player whose profile or attack page is open">Add player from this page</button>
      <button data-cmd="targets.refreshAll">Refresh all</button>
    </div>
    <div class="row between" style="margin-top:6px">
      <label class="row"><input type="checkbox" data-set="targets.autoRefresh"> Auto refresh every</label>
      <select data-set="targets.interval" data-num>
        ${TARGET_INTERVALS.map(v => `<option value="${v}">${intervalLabel(v)}</option>`).join('')}
      </select>
    </div>
    <div id="target-rate" class="note" style="margin-top:2px"></div>
    <div class="row between" style="margin-top:6px">
      <label>Sort by <select id="target-sort">
        <option value="status">Status (ready first)</option>
        <option value="ffLow">Fair fight, easiest first</option>
        <option value="ffHigh">Fair fight, best respect first</option>
        <option value="bsLow">Estimated stats, lowest first</option>
        <option value="bsHigh">Estimated stats, highest first</option>
        <option value="level">Level</option>
      </select></label>
      <span id="ffs-status" class="muted small"></span>
    </div>
    <div id="list-remove" class="row" style="margin-top:6px"></div>
    <div id="target-msg" class="note"></div>
    <div id="target-list" style="margin-top:6px"></div>
    <h3>Find targets <span class="small" style="text-transform:none;font-weight:400">from FFScouter</span></h3>
    <div id="ffs-finder"></div>`;
  $('#target-sort').value = prefs.get('targets.sort', 'status');
  $('#target-sort').addEventListener('change', e => { prefs.set('targets.sort', e.target.value); renderTargets(); });
  $('#target-add').addEventListener('submit', async e => {
    e.preventDefault();
    const input = $('#target-input');
    const r = await cmd('targets.add', input.value);
    // The list is keyed by player ID: anyone already on it is never added twice.
    $('#target-msg').textContent = !r.found ? 'No player IDs found.'
      : `Added ${r.added} new target${r.added === 1 ? '' : 's'}${r.already ? `; ${r.already} already on your list` : ''}.`;
    if (r.found) input.value = '';
  });
  // Targets added with "Add all players in this list" (right-click in a Torn tab) can go together.
  $('#list-remove').addEventListener('click', async e => {
    if (e.target.id !== 'list-remove-btn') return;
    const r = await cmd('targets.removeFrom', 'list');
    $('#target-msg').textContent = `Removed ${r.removed} target${r.removed === 1 ? '' : 's'} added from lists.`;
  });
  renderTargets();
}
document.addEventListener('click', e => {
  const s = e.target.closest('[data-tgsub]');
  if (s) { prefs.set('targets.sub', s.dataset.tgsub); renderTargetsShell(); }
});

// Auto refresh choices, and what they cost: one request per target per refresh.
const TARGET_INTERVALS = [3, 5, 10, 15, 30, 60, 120, 300, 600, 1800];
const intervalLabel = v => (v < 60 ? `${v} s` : v < 3600 ? `${v / 60} min` : `${v / 3600} h`);
function renderTargetRate(f) {
  const el = $('#target-rate');
  if (!el) return;
  const s = (S.settings && S.settings.targets) || {};
  const n = f.targets.filter(t => !t.invalid).length;
  if (!s.autoRefresh) { el.textContent = 'Auto refresh is off: targets update only when you press Refresh.'; return; }
  const every = Math.max(3, Number(s.interval) || 120);
  const perMin = n * 60 / every;
  // What Targets can really get: this device's allowance (less what your other Mentat devices
  // and the server use), and other tabs go first, so count on about 80% of it.
  const budget = Math.max(1, Number(S.api.budget || S.api.maxPerMinute) || 40);
  const room = budget * 0.8;
  const est = `≈ ${perMin < 10 ? perMin.toFixed(1).replace(/.0$/, '') : Math.round(perMin)} calls/min for ${n} target${n === 1 ? '' : 's'} (both lists) at every ${intervalLabel(every)}`;
  if (perMin <= room) { el.innerHTML = `${est} · fine for your ${budget}/min allowance.`; return; }
  const real = Math.ceil(n * 60 / room);
  el.innerHTML = `<b>${est}: more than your ${budget}/min allowance can take.</b> Each target will really update about every ${real < 60 ? `${real} s` : fmtDur(real)}. Torn allows 100 calls a minute across all your keys; Mentat keeps you under it by slowing down.`;
}

function targetRank(t, now) {
  if (t.invalid || !t.status) return [3, 0];
  if (t.status.state === 'Okay') return [0, 0];
  if ((t.status.state === 'Hospital' || t.status.state === 'Jail') && t.status.until) return [1, Math.max(0, t.status.until - now)];
  return [2, 0];
}

// ---- Abroad list: where players are, from Torn's status text ----
const sameCountry = (a, b) => !!a && !!b && String(a).trim().replace(/\.$/, '').toLowerCase() === String(b).trim().replace(/\.$/, '').toLowerCase();
const abroadIn = st => { const m = st && st.state === 'Abroad' ? /^In (.+?)\.?$/i.exec(String(st.description || '').trim()) : null; return m ? m[1] : ''; };
// "Traveling from Torn to Japan" (older wording "Traveling to Japan") -> 'Japan'
const flyingTo = st => {
  if (!st || st.state !== 'Traveling') return '';
  const s = String(st.description || '').trim();
  const m = /^Traveling from .+? to (.+?)\.?$/i.exec(s) || /^Traveling to (.+?)\.?$/i.exec(s);
  return m && m[1].toLowerCase() !== 'torn' ? m[1] : '';
};
// Ready = in the country you're in; then on their way there; then hospital (soonest out first).
function abroadRank(t, here, now) {
  if (t.invalid || !t.status) return [4, 0];
  if (here && sameCountry(abroadIn(t.status), here)) return [0, 0];
  if (here && sameCountry(flyingTo(t.status), here)) return [1, 0];
  if ((t.status.state === 'Hospital' || t.status.state === 'Jail') && t.status.until) return [2, Math.max(0, t.status.until - now)];
  return [3, 0];
}

// One row of either list. which = 'home' or 'abroad' (for its remove button); pill = status pill HTML.
function targetRow(t, est, which, pill) {
  const meta = t.invalid ? esc(t.error || 'Invalid player')
    : [t.level ? `Lv ${t.level}` : '', t.life ? `Life ${num(t.life.current)}/${num(t.life.maximum)}` : '', t.faction ? esc(t.faction) : '', t.lastAction ? esc(t.lastAction.relative) : '', t.lastFetched ? `checked ${fmtAgo(t.lastFetched)}` : 'loading…'].filter(Boolean).join(' · ');
  return `<div class="target ${t.invalid ? 'invalid' : ''}">
      <div class="tname">${avatar(t.id, 'av-md')}${link(profileUrl(t.id), esc(t.name || `#${t.id}`))} <span class="muted small">[${t.id}]</span> ${ffPill(est[t.id])}</div>
      <div>${pill}</div>
      <div class="meta" title="${esc(t.status ? t.status.description : '')}">${meta}</div>
      <div class="actions">
        <button data-open="${attackUrl(t.id)}" title="Open the attack page in a new Torn tab">Attack</button>
        <button data-cmd="targets.refresh" data-arg="${t.id}" title="Refresh">&#8635;</button>
        <button class="danger" data-cmd="targets.remove" data-arg="${t.id}" data-arg2="${which}" title="Remove from this list">&times;</button>
      </div>
    </div>`;
}

function renderAbroadTargets(f, est, sorters) {
  const list = $('#abroad-list');
  if (!list) return;
  const now = Date.now();
  const here = f.here || '';
  const u = (S.features.user && S.features.user.data) || {};
  const flying = u.status && u.status.state === 'Traveling';
  const sort = prefs.get('targets.sort', 'status');
  const ts = f.targets.filter(t => t.abroad).sort((a, b) => {
    const ra = abroadRank(a, here, now), rb = abroadRank(b, here, now);
    return ra[0] - rb[0] || ra[1] - rb[1] || (sort !== 'status' && sorters[sort] ? sorters[sort](a, b) : 0) || (a.name || '').localeCompare(b.name || '');
  });
  const ready = ts.filter(t => abroadRank(t, here, now)[0] === 0).length;
  const left = f.left && f.left.count && sameCountry(f.left.country, here) ? f.left : null;
  $('#abroad-where').innerHTML = here
    ? `${flying ? 'Flying to' : "You're in"} <b>${esc(here)}</b> · <b>${ready}</b> ready of ${ts.length}${left ? ` · ${left.count} left ${esc(here)} and ${left.count === 1 ? 'was' : 'were'} removed (latest: ${esc(left.names.join(', '))})` : ''}`
    : "You're in Torn. This list comes into play when you fly out: players in the country you go to show as ready.";
  $('#target-msg').textContent = f.queue || '';
  if (!ts.length) { list.innerHTML = '<div class="empty">Nobody on the Abroad list yet.</div>'; return; }
  list.innerHTML = ts.map(t => {
    const r = abroadRank(t, here, now)[0];
    const pill = r === 0 ? `<span class="pill ok" title="${esc(t.status.description)}">Ready · in ${esc(here)}</span>`
      : r === 1 ? `<span class="pill info" title="${esc(t.status.description)}">On the way to ${esc(here)}</span>`
        : t.status ? statusPill(t.status, t.status.until) : '';
    return targetRow(t, est, 'abroad', pill);
  }).join('');
}

// Fair fight (FFScouter): 1 = much weaker than you, 3 = as strong or stronger (max respect).
function ffPill(e) {
  if (!e || e.ff === null || e.ff === undefined) return '';
  const cls = e.ff < 2 ? 'ok' : e.ff < 2.75 ? 'warn' : 'bad';
  const tip = `Fair fight ${e.ff.toFixed(2)} (FFScouter${e.source ? `, ${e.source}` : ''}): higher = tougher fight, more respect.${e.bsHuman ? ` Estimated battle stats ${e.bsHuman}.` : ''}${e.distribution ? ` ${e.distribution}.` : ''}${e.updated ? ` Estimate from ${new Date(e.updated).toLocaleDateString()}.` : ''}`;
  return `<span class="pill ${cls}" title="${esc(tip)}">FF ${e.ff.toFixed(2)}${e.bsHuman ? ` · ${esc(e.bsHuman)}` : ''}</span>`;
}

function renderTargets() {
  const f = S.features.targets;
  const el = panel('targets');
  if (!f || !el) return;
  renderTargetRate(f);
  if (el.dataset.view === 'abroad') {
    const est0 = (S.features.ffscouter || {}).stats || {};
    const v0 = (t, k) => (est0[t.id] && est0[t.id][k] !== null && est0[t.id][k] !== undefined ? est0[t.id][k] : null);
    const by0 = (k, dir) => (a, b) => { const x = v0(a, k), y = v0(b, k); return x === null && y === null ? 0 : x === null ? 1 : y === null ? -1 : dir * (x - y); };
    renderAbroadTargets(f, est0, { ffLow: by0('ff', 1), ffHigh: by0('ff', -1), bsLow: by0('bs', 1), bsHigh: by0('bs', -1), level: (a, b) => (b.level || 0) - (a.level || 0) });
    return;
  }
  const list = $('#target-list');
  if (!list) return;
  const home = f.targets.filter(t => t.home !== false);
  const fromLists = home.filter(t => t.from === 'list').length;
  const lr = $('#list-remove');
  if (lr && lr.dataset.n !== String(fromLists)) {
    lr.dataset.n = String(fromLists);
    lr.innerHTML = fromLists ? `<button id="list-remove-btn" title="Removes only the targets added with Add all players in this list">Remove the ${fromLists} added from lists</button>` : '';
  }
  const ffs = S.features.ffscouter || {};
  const est = ffs.stats || {};
  const now = Date.now();
  const sort = prefs.get('targets.sort', 'status');
  const val = (t, k) => (est[t.id] && est[t.id][k] !== null && est[t.id][k] !== undefined ? est[t.id][k] : null);
  const byNum = (k, dir) => (a, b) => {
    const x = val(a, k), y = val(b, k);
    if (x === null && y === null) return 0;
    if (x === null) return 1;
    if (y === null) return -1;
    return dir * (x - y);
  };
  const byStatus = (a, b) => {
    const ra = targetRank(a, now), rb = targetRank(b, now);
    return ra[0] - rb[0] || ra[1] - rb[1] || (a.name || '').localeCompare(b.name || '');
  };
  const sorters = { status: byStatus, ffLow: byNum('ff', 1), ffHigh: byNum('ff', -1), bsLow: byNum('bs', 1), bsHigh: byNum('bs', -1), level: (a, b) => (b.level || 0) - (a.level || 0) };
  const ts = home.sort((a, b) => (sorters[sort] || byStatus)(a, b) || byStatus(a, b));
  $('#target-msg').textContent = f.queue || $('#target-msg').textContent;

  const known = ts.filter(t => val(t, 'ff') !== null).length;
  const latest = Math.max(0, ...ts.map(t => (est[t.id] && est[t.id].fetchedAt) || 0));
  $('#ffs-status').innerHTML = ffs.hasKey
    ? `${ffs.error ? `<span class="neg">${esc(ffs.error)}</span> · ` : ''}FFScouter estimates ${known}/${ts.length}${latest ? ` · ${fmtAgo(latest)}` : ''} · <a data-cmd="ffscouter.refresh">refresh</a>`
    : `<a data-goto="settings">Add your FFScouter key</a> for fair fight and stat estimates`;

  if (!ts.length) { list.innerHTML = '<div class="empty">No targets yet. Add player IDs above, use the FFScouter finder below, or right-click a player link in Torn.</div>'; renderFinder(); return; }
  list.innerHTML = `<div class="muted small" style="margin-bottom:4px">${ts.length} target${ts.length === 1 ? '' : 's'} · ${ts.filter(t => t.status && t.status.state === 'Okay').length} okay</div>`
    + ts.map(t => targetRow(t, est, 'home', t.status ? statusPill(t.status, t.status.until) : '')).join('');
  renderFinder();
}

// ---- FFScouter target finder ----
function renderFinder() {
  const el = $('#ffs-finder');
  if (!el) return;
  const ffs = S.features.ffscouter || {};
  if (!ffs.hasKey) {
    el.innerHTML = '<div class="muted small">Add your FFScouter key in <a data-goto="settings">Settings → Integrations</a> to search FFScouter\'s target lists by level, fair fight and activity.</div>';
    return;
  }
  if (el.querySelector('form') && el.contains(document.activeElement)) return; // don't wipe while typing
  const p = prefs.get('ffs.finder', { preset: '', minlevel: '', maxlevel: '', minff: 1.5, maxff: 2.5, inactiveonly: true, factionless: false });
  const fr = ffs.finder || {};
  const have = new Set((S.features.targets ? S.features.targets.targets : []).map(t => t.id));
  const fresh = (fr.results || []).filter(r => !have.has(r.id));
  el.innerHTML = `
    <form id="ffs-form" class="toolbar">
      <label>List <select name="preset"><option value="">Custom filters</option><option value="respect" ${p.preset === 'respect' ? 'selected' : ''}>Best respect</option><option value="level" ${p.preset === 'level' ? 'selected' : ''}>Level hunting</option></select></label>
      <label>Level <input name="minlevel" type="number" min="1" max="100" style="width:56px" value="${esc(p.minlevel)}" placeholder="1">–<input name="maxlevel" type="number" min="1" max="100" style="width:56px" value="${esc(p.maxlevel)}" placeholder="100"></label>
      <label>Fair fight <input name="minff" type="number" min="1" max="3" step="0.05" style="width:60px" value="${esc(p.minff)}">–<input name="maxff" type="number" min="1" max="3" step="0.05" style="width:60px" value="${esc(p.maxff)}"></label>
      <label class="row"><input name="inactiveonly" type="checkbox" ${p.inactiveonly ? 'checked' : ''}> Inactive only</label>
      <label class="row"><input name="factionless" type="checkbox" ${p.factionless ? 'checked' : ''}> No faction</label>
      <button class="primary" ${fr.loading ? 'disabled' : ''}>${fr.loading ? 'Searching…' : 'Search'}</button>
    </form>
    ${fr.error ? `<div class="error">${esc(fr.error)}</div>` : ''}
    ${fr.results && fr.results.length ? `
      <div class="row between"><span class="muted small">${fr.results.length} found · ${fresh.length} not in your list yet · ${fmtAgo(fr.fetchedAt)}</span>
        <button data-ffsaddall="${fresh.map(r => r.id).join(',')}" ${fresh.length ? '' : 'disabled'}>Add all ${fresh.length}</button></div>
      <table class="data"><tr><th>Player</th><th class="num">Level</th><th class="num">Fair fight</th><th class="num">Est. stats</th><th class="num">Last action</th><th></th></tr>
        ${fr.results.map(r => `<tr class="${have.has(r.id) ? 'dim' : ''}"><td>${avatar(r.id)}${link(profileUrl(r.id), esc(r.name || `#${r.id}`))} <span class="muted small">[${r.id}]</span></td>
          <td class="num">${r.level || '–'}</td><td class="num">${r.ff !== null ? r.ff.toFixed(2) : '–'}</td><td class="num">${esc(r.bsHuman || '–')}</td>
          <td class="num muted small">${r.lastAction ? fmtAgo(r.lastAction) : '–'}</td>
          <td>${have.has(r.id) ? '<span class="muted small">in list</span>' : `<button data-ffsadd="${r.id}">Add</button>`}</td></tr>`).join('')}
      </table>` : ''}
    <div class="note">Target data from <a data-open="https://ffscouter.com/target-finder">FFScouter</a> (${esc((ffs.account && ffs.account.premium) ? 'premium' : 'free')} account). Estimates and lists use your FFScouter key and don't use Torn API requests.</div>`;
  $('#ffs-form').addEventListener('submit', e => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const q = { preset: fd.get('preset'), minlevel: fd.get('minlevel'), maxlevel: fd.get('maxlevel'), minff: fd.get('minff'), maxff: fd.get('maxff'), inactiveonly: fd.get('inactiveonly') === 'on', factionless: fd.get('factionless') === 'on' };
    prefs.set('ffs.finder', q);
    cmd('ffscouter.find', q);
  });
}
document.addEventListener('click', e => {
  const one = e.target.closest('[data-ffsadd]');
  const all = e.target.closest('[data-ffsaddall]');
  const ids = one ? one.dataset.ffsadd : all ? all.dataset.ffsaddall : '';
  if (ids) { cmd('targets.add', ids).then(r => { $('#target-msg').textContent = `Added ${r.added} target${r.added === 1 ? '' : 's'} from FFScouter.`; }); }
});

// ---- Settings ----
const TAB_LIST = NAV_PANELS;
// Each tab's content: aligned left / centre / right, at one of four widths.
const TAB_WIDTHS = { narrow: '820px', medium: '1100px', wide: '1400px', full: 'none' };
// ---- Settings: grouped sections with quick links down the side (a row at the top when narrow) ----
const SET_NAV_W = 184; // link column + gap
document.addEventListener('click', e => {
  const b = e.target.closest('[data-set-jump]');
  if (!b) return;
  const g = document.getElementById(`set-${b.dataset.setJump}`);
  if (!g) return;
  const smooth = !matchMedia('(prefers-reduced-motion: reduce)').matches;
  setJumpUntil = Date.now() + 1500; // the clicked one stays marked while the page scrolls there
  g.scrollIntoView({ block: 'start', behavior: smooth ? 'smooth' : 'auto' });
  markSettingsSection(b.dataset.setJump);
});
let setJumpUntil = 0;
// The link for the section at the top of the view is highlighted while scrolling.
function markSettingsSection(id) {
  for (const b of $$('[data-set-jump]')) {
    const on = b.dataset.setJump === id;
    b.classList.toggle('active', on);
    if (on) b.setAttribute('aria-current', 'true'); else b.removeAttribute('aria-current');
  }
}
let setSpyQueued = false;
$('#panels').addEventListener('scroll', () => {
  if (setSpyQueued || Date.now() < setJumpUntil || !panel('settings').classList.contains('active')) return;
  setSpyQueued = true;
  requestAnimationFrame(() => {
    setSpyQueued = false;
    const top = $('#panels').getBoundingClientRect().top + 90;
    const groups = $$('.set-group');
    if (!groups.length) return;
    const atEnd = $('#panels').scrollTop + $('#panels').clientHeight >= $('#panels').scrollHeight - 4;
    let cur = groups[0];
    for (const g of groups) if (g.getBoundingClientRect().top <= top) cur = g;
    if (atEnd) cur = groups[groups.length - 1];
    markSettingsSection(cur.id.slice(4));
  });
}, { passive: true });

function applyTabLayout() {
  const layout = (S.settings && S.settings.ui && S.settings.ui.tabLayout) || {};
  for (const [k] of TAB_LIST) {
    const sec = panel(k);
    const l = layout[k] || {};
    if (!sec) continue;
    if (NAV_POP) { sec.style.maxWidth = 'none'; sec.style.marginLeft = sec.style.marginRight = 'auto'; continue; }
    const w = TAB_WIDTHS[l.width] || TAB_WIDTHS.narrow;
    // Settings has its section links beside it; they don't take from the settings' own width.
    sec.style.maxWidth = k === 'settings' && w !== 'none' ? `calc(${w} + ${SET_NAV_W}px)` : w;
    sec.style.marginLeft = l.align === 'left' ? '0' : 'auto';
    sec.style.marginRight = l.align === 'right' ? '0' : 'auto';
  }
  for (const b of $$('[data-seg]')) {
    const [k, field] = b.dataset.seg.split('.');
    b.classList.toggle('on', ((layout[k] || {})[field]) === b.dataset.segval);
  }
}
const THEMES = [['mentat', 'Mentat'], ['dark', 'Torn Dark'], ['midnight', 'Midnight'], ['oled', 'OLED Black'], ['slate', 'Slate'], ['crimson', 'Crimson'], ['amethyst', 'Amethyst'], ['sepia', 'Sepia']];
const LIGHT_THEMES = [['light', 'Daylight'], ['sand', 'Sand'], ['paper', 'Paper'], ['frost', 'Frost'], ['sage', 'Sage'], ['rose', 'Rose'], ['lavender', 'Lavender'], ['contrast', 'High contrast']];
const themeCards = list => `<div class="theme-grid">${list.map(([k, label]) => `
      <button class="theme-card" data-set="ui.theme" data-value='"${k}"' data-theme-pick="${k}" title="${label} theme">
        <div data-theme="dark"><div class="theme-swatch" data-theme="${k}">
          <span class="sw-top"></span><span class="sw-side"></span>
          <span class="sw-body"><i class="sw-line"></i><i class="sw-line short"></i><i class="sw-btn"></i></span>
        </div></div>
        <span class="theme-name">${label}</span><span class="theme-mode"></span>
      </button>`).join('')}</div>`;
// TornTools in the Torn browser: status and controls (Settings).
function renderExtBox(st) {
  const el = $('#ext-box');
  if (!el || !st) return;
  S.ext = st;
  const on = st.enabled && st.loaded;
  el.innerHTML = `
    <div class="note" style="margin-top:0">Runs the TornTools extension you use in Chrome inside the Torn browser: its page features, settings and pop-up dashboard. Mentat works on its own copy, so your Chrome install isn't touched. TornTools keeps its own settings and API key here, so enter your key once in its settings (or use TornTools' own export/import to bring your settings over).</div>
    <div class="setting"><label>Use TornTools in the Torn browser<div class="note" style="margin:0">${
      st.chrome ? `Found TornTools ${esc(st.chrome.version)} in Chrome (${esc(st.chrome.profile)}).` : 'TornTools was not found in Chrome on this PC.'
    }${st.installed ? ` Using a copy of ${esc(st.installed.version)}.` : ''}${st.updateAvailable ? ' <b>A newer version is in Chrome.</b>' : ''}${st.error ? ` <span class="neg">${esc(st.error)}</span>` : ''}</div></label>
      <input type="checkbox" id="ext-on" ${st.enabled ? 'checked' : ''} ${st.chrome || st.installed ? '' : 'disabled'}></div>
    <div class="row wrap" style="gap:6px">
      <button data-ext="options" ${on ? '' : 'disabled'}>Open TornTools settings</button>
      <button data-ext="popup" ${on ? '' : 'disabled'}>Open TornTools dashboard</button>
      <button data-ext="update" ${st.installed && st.chrome ? '' : 'disabled'}>${st.updateAvailable ? 'Update from Chrome' : 'Re-copy from Chrome'}</button>
      <button class="danger" data-ext="remove" ${st.installed ? '' : 'disabled'}>Remove copy</button>
    </div>
    <div class="note">TornTools' desktop notifications show as Mentat alerts. If you also use Mentat's own alerts for the same things, turn one of them off to avoid doubles. TornTools is a separate project; check its settings for what each feature does.</div>`;
}
document.addEventListener('change', e => {
  if (e.target.id !== 'ext-on') return;
  const box = e.target;
  box.disabled = true;
  cmd('ext.enable', box.checked).then(renderExtBox).catch(err => { alert(err.message); cmd('ext.status').then(renderExtBox); });
});
document.addEventListener('click', e => {
  const b = e.target.closest('[data-ext]');
  if (!b || b.disabled) return;
  const a = b.dataset.ext;
  if (a === 'options') cmd('ext.options');
  else if (a === 'popup') cmd('ext.popup');
  else if (a === 'update') { b.textContent = 'Copying…'; b.disabled = true; cmd('ext.update').then(renderExtBox).catch(err => { alert(err.message); cmd('ext.status').then(renderExtBox); }); }
  else if (a === 'remove' && confirm('Remove Mentat\'s copy of TornTools (and turn it off)? Chrome\'s TornTools is not affected.')) cmd('ext.remove').then(renderExtBox);
});

// Sounds offered for urgent popups (keys of SOUNDS in features/alerts.js).
const URGENT_SOUNDS = [['doorbell', 'Doorbell'], ['softchime', 'Soft chime'], ['harp', 'Harp'], ['glass', 'Glass'], ['marimba', 'Marimba'], ['bell', 'Classic bell'], ['rise', 'Classic rising'], ['alarm', 'Classic alarm'], ['none', 'No sound']];

// Popup style choice, shared by Settings and the Alerts tab.
function popupStyleSettings() {
  return `
    <div class="setting"><label>Show alerts as<div class="note" style="margin:0">Mentat popups are cards in a corner of your screen that stay on top, with an Open button for the Torn page. Windows notifications use the Windows notification center (and Focus assist / Do not disturb).</div></label>
      <select data-set="ui.popupStyle"><option value="app">Mentat popups</option><option value="windows">Windows notifications</option></select></div>
    <div class="setting popup-only"><label>Popups stay for</label>
      <select data-set="ui.popupSeconds" data-num><option value="6">6 seconds</option><option value="12">12 seconds</option><option value="20">20 seconds</option><option value="45">45 seconds</option><option value="120">2 minutes</option><option value="0">Until I close them</option></select></div>
    <div class="setting popup-only"><label>Popup corner</label>
      <select data-set="ui.popupCorner"><option value="bottom-right">Bottom right</option><option value="top-right">Top right</option><option value="bottom-left">Bottom left</option><option value="top-left">Top left</option></select></div>
    <div class="setting"><label>Try it</label><button data-cmd="popup.test">Show a test alert</button></div>`;
}

function renderSettingsShell() {
  const el = panel('settings');
  const urgentLabels = { trip: 'Planned trips', plan: 'Other planned items', travel: 'Landed', energy: 'Energy full', nerve: 'Nerve full', drug: 'Drug cooldown', booster: 'Booster cooldown', medical: 'Medical cooldown', hospital: 'Out of hospital/jail', events: 'New events', messages: 'New messages', chain: 'Chain timer', targets: 'Target out of hospital', market: 'Watchlist price' };
  const notifyLabels = { energy: 'Energy full', nerve: 'Nerve full', drug: 'Drug cooldown', booster: 'Booster cooldown', medical: 'Medical cooldown', travel: 'Landed', hospital: 'Out of hospital/jail', events: 'New events', messages: 'New messages' };
  el.innerHTML = `
    <div class="set-layout">
    <nav class="set-nav" aria-label="Settings sections"><button data-set-jump="account">Account</button><button data-set-jump="notifications">Notifications</button><button data-set-jump="customization">Customization</button><button data-set-jump="chat">Chat window</button><button data-set-jump="integrations">Integrations</button><button data-set-jump="app">App &amp; browser</button><button data-set-jump="privacy">Data &amp; privacy</button></nav>
    <div class="set-body">
    <section class="set-group" id="set-account" aria-labelledby="set-account-h"><h2 id="set-account-h">Account</h2>
    <h3>Torn API key</h3>
    <div id="account"></div>
    <form id="key-form" class="keyrow" style="margin-top:6px">
      <input id="key-input" type="password" placeholder="16-character API key" maxlength="16" spellcheck="false" autocomplete="off">
      <button class="primary" id="key-save">Save</button>
    </form>
    <div id="key-error" class="error" hidden></div>
    <div class="note">A <b>Limited</b> key covers every current feature (Minimal works for most).
      ${link('https://www.torn.com/preferences.php#tab=api?step=addNewKey&title=Mentat&type=3', 'Create a key for this app')}.</div>

    <h3>Requests</h3>
    <div class="setting"><label>Your status refresh</label>
      <select data-set="user.interval" data-num>${[30, 60, 120, 300].map(v => `<option value="${v}">every ${fmtDur(v)}</option>`).join('')}</select></div>
    <div class="setting"><label>Max API requests per minute</label>
      <select data-set="api.maxPerMinute" data-num>${[20, 30, 40, 60, 80].map(v => `<option value="${v}">${v}</option>`).join('')}</select></div>
    <div class="note">Torn allows 100 requests per minute across all your keys and tools. Leave room for anything else you use.</div>

    <h3>Data source</h3>
    <div class="setting"><label>Where collected data is kept<div class="note" style="margin:0"><b>This PC</b>: collected while the app runs and kept here. <b>Server</b>: a Mentat sync server you run collects around the clock, and every PC you connect shows the same history and settings.</div></label>
      <div class="seg" role="group" aria-label="Data source"><button data-sync-mode="local">This PC</button><button data-sync-mode="server">Server</button></div></div>
    <form id="sync-form" hidden autocomplete="off">
      <div class="setting"><label>Server address</label><input id="sync-url" type="text" placeholder="https://example.com/torn-desktop" spellcheck="false" style="width:300px"></div>
      <div class="setting"><label>Access token<div class="note" style="margin:0">Shown by the server: <code>node server/server.js token</code></div></label><input id="sync-token" type="password" spellcheck="false" style="width:300px"></div>
      <details class="sync-cf"><summary class="small">Behind Cloudflare Access? (optional)</summary>
        <div class="note" style="margin:4px 0">A service token for the Access application in front of the server, sent as CF-Access-Client-Id and CF-Access-Client-Secret.</div>
        <div class="setting"><label>Client ID</label><input id="sync-cfid" type="password" spellcheck="false" style="width:300px"></div>
        <div class="setting"><label>Client secret</label><input id="sync-cfsecret" type="password" spellcheck="false" style="width:300px"></div>
        <label class="row small" id="sync-cfclear-row"><input type="checkbox" id="sync-cfclear"> Remove the saved Cloudflare details</label>
      </details>
      <div class="row" style="margin-top:6px"><button class="primary" id="sync-save">Connect</button><span class="muted small" id="sync-form-note"></span></div>
      <div id="sync-error" class="error" hidden></div>
    </form>
    <div id="sync-status" style="margin-top:6px"></div>
    <div id="members-box"></div>
    </section>

    <section class="set-group" id="set-notifications" aria-labelledby="set-notifications-h"><h2 id="set-notifications-h">Notifications</h2>
    <h3>Alerts &amp; popups</h3>
    ${popupStyleSettings()}
    <div class="note">Built-in alerts when something is done:</div>
    <div class="checks">${Object.entries(notifyLabels).map(([k, l]) => `<label><input type="checkbox" data-set="user.notify.${k}"> ${l}</label>`).join('')}</div>
    <div class="setting"><label>Target out of hospital</label><input type="checkbox" data-set="targets.notify"></div>

    <h3>Urgent popups</h3>
    <div class="note">For alerts you mustn't miss. An urgent popup is a large card in the middle of the screen, on top of everything, that stays until you open, snooze or dismiss it. Its sound repeats until then (for up to 10 minutes). It doesn't take the keyboard, so typing elsewhere isn't interrupted. Pick which alerts are urgent:</div>
    <div class="checks">${Object.entries(urgentLabels).map(([k, l]) => `<label><input type="checkbox" data-set="ui.urgent.${k}"> ${l}</label>`).join('')}</div>
    <div class="note">A planned item can also choose for itself (Planner → edit → Reminder style), and so can each custom alert (Alerts tab, "Urgent" column).</div>
    <div class="setting"><label>Urgent sound</label><select data-set="ui.urgentSound">${URGENT_SOUNDS.map(([k, l]) => `<option value="${k}">${l}</option>`).join('')}</select></div>
    <div class="setting"><label>Repeat the sound</label><select data-set="ui.urgentRepeat" data-num><option value="0">Once only</option><option value="10">Every 10 seconds</option><option value="15">Every 15 seconds</option><option value="30">Every 30 seconds</option><option value="60">Every minute</option><option value="120">Every 2 minutes</option></select></div>
    <div class="setting"><label>Try it</label><button data-cmd="popup.testUrgent">Show a test urgent popup</button></div>

    <h3>Chain alerts</h3>
    <div class="setting"><label>Chain timer</label><input type="checkbox" data-set="chain.enabled"></div>
    <div class="setting"><label>Beep alerts</label><input type="checkbox" data-set="chain.alerts"></div>
    <div class="checks" style="margin:2px 0 4px">${[150, 90, 60, 30].map(x => `<label><input type="checkbox" data-set="chain.t${x}"> At ${fmtDur(x)}</label>`).join('')}</div>
    <div class="setting"><label>Desktop popup with each beep</label><input type="checkbox" data-set="chain.desktop"></div>
    <div class="setting"><label>Sound</label><select data-set="chain.sound"><option value="soft">Soft bell tones</option><option value="classic">Classic beeps</option></select></div>
    <div class="setting"><label>Volume</label><input type="range" min="0" max="1" step="0.05" data-set="chain.volume" data-num style="width:130px"></div>
    <div class="setting"><label>Only alert from this many hits</label><input type="number" min="0" max="100000" style="width:80px" data-set="chain.minChain" data-num></div>
    </section>

    <section class="set-group" id="set-customization" aria-labelledby="set-customization-h"><h2 id="set-customization-h">Customization</h2>
    <h3>Theme</h3>
    <div class="setting"><label>Match Windows light/dark mode<div class="note" style="margin:0">Switches between your dark pick and your light pick when Windows does. Click a theme in each group to choose them.</div></label><input type="checkbox" data-set="ui.themeAuto"></div>
    <div class="theme-group-label muted small">Dark</div>
    ${themeCards(THEMES)}
    <div class="theme-group-label muted small">Light</div>
    ${themeCards(LIGHT_THEMES)}
    <div class="setting"><label>Accent colour<div class="note" style="margin:0">Buttons, highlights and the active tab. Default uses the theme's own.</div></label>
      <span class="row"><input type="color" data-set="ui.accent" style="width:46px;height:28px;padding:2px"><button data-set="ui.accent" data-value='""'>Default</button></span></div>

    <h3>Tabs &amp; layout</h3>
    <div class="setting"><label>Tab bar<div class="note" style="margin:0">Along the top, or down a side bar on the left (with sub-tabs in small menus under their tab).</div></label>
      <select data-set="ui.navLayout"><option value="top">Top bar</option><option value="side">Side bar</option></select></div>
    <div class="setting nav-side-only"><label>Collapse the side bar to icons<div class="note" style="margin:0">Also with the &#171; button at the bottom of the side bar, or Ctrl+B.</div></label><input type="checkbox" data-set="ui.navCollapsed"></div>
    <div class="setting"><label>Tabs<div class="note" style="margin:0">Which tabs show, in what order, and which sub-tabs get their own place on the main bar. You can also drag tabs on either bar, or right-click one. Ctrl+1…9 and Ctrl+0 open the first ten main tabs.</div></label><button data-nav-ed="reset">Reset tabs</button></div>
    <div id="nav-editor"></div>
    <div class="setting"><label>Tab width<div class="note" style="margin:0">Where each tab's content sits in the window, and how wide it gets. Sub-tabs on the main bar use their tab's.</div></label><button data-set="ui.tabLayoutReset" data-value="true">Reset all</button></div>
    <table class="data tab-layout-table">
      <tr><th>Tab</th><th>Alignment</th><th>Width</th></tr>
      ${TAB_LIST.map(([k, label]) => `<tr><td>${label}</td>
        <td><div class="seg" role="group" aria-label="${label} alignment">${[['left', 'Left'], ['center', 'Centre'], ['right', 'Right']].map(([v, l]) => `<button data-set="ui.tabLayout.${k}.align" data-value='"${v}"' data-seg="${k}.align" data-segval="${v}">${l}</button>`).join('')}</div></td>
        <td><div class="seg" role="group" aria-label="${label} width">${[['narrow', 'Narrow'], ['medium', 'Medium'], ['wide', 'Wide'], ['full', 'Full']].map(([v, l]) => `<button data-set="ui.tabLayout.${k}.width" data-value='"${v}"' data-seg="${k}.width" data-segval="${v}">${l}</button>`).join('')}</div></td></tr>`).join('')}
    </table>

    <h3>Top bar buttons</h3>
    <div class="note">Which buttons the top bar shows. <span class="desktop-only">Ctrl+D (Torn) and Ctrl+K (chat) work either way.</span></div>
    <div class="checks"><label><input type="checkbox" data-set="ui.buttons.torn"> Open Torn</label><label><input type="checkbox" data-set="ui.buttons.pages"> Pages menu</label><label><input type="checkbox" data-set="ui.buttons.chat"> Chat</label><label><input type="checkbox" data-set="ui.buttons.clocks"> Clocks</label><label><input type="checkbox" data-set="ui.buttons.account"> Account (Sign out)</label></div>

    <h3>Clocks</h3>
    <div class="setting"><label>Show a third clock<div class="note" style="margin:0">Local time and Torn City Time (UTC) are always shown.</div></label><input type="checkbox" data-set="ui.clockThird"></div>
    <div class="setting"><label>Third clock time zone</label>
      <select id="clock-zone" data-set="ui.clockZone">${zoneOptions()}</select></div>
    <div class="setting"><label>24-hour clocks</label><input type="checkbox" data-set="ui.clock24"></div>
    <div class="setting"><label>Profile pictures and faction images<div class="note" style="margin:0">Shown next to players in Targets, faction lists, war boards and Oppo Research. Pictures you haven't seen yet are looked up a few a minute at the lowest priority, so they barely touch your API limit. Some pictures are large (animated): turn this off on a slow or metered connection.</div></label><input type="checkbox" data-set="ui.avatars"></div>
    <div class="setting"><label>Condensed tabs<div class="note" style="margin:0">No pictures in these tabs, and tighter rows. You can also right-click a tab.</div></label>
      <span class="row wrap" style="gap:4px 12px">${PICTURE_TABS.map(t => `<label class="row"><input type="checkbox" data-condense="${t}"> ${esc(navLabel(t))}</label>`).join('')}</span></div>
    <div class="setting"><label>Clocks in the Torn browser too<div class="note" style="margin:0">Shows the same clocks in the browser window's toolbar.</div></label><input type="checkbox" data-set="ui.browserClocks"></div>
    </section>

    <section class="set-group" id="set-chat" aria-labelledby="set-chat-h"><h2 id="set-chat-h">Chat window</h2>
    <div class="note">The Chat button (Ctrl+K) opens Torn's own page and chat in a compact window with your Torn login. Links you click in it open in the Torn browser. Torn's API has no chat access, so the app doesn't read or send chat itself.</div>
    <div class="setting"><label>Compact chat: chat only, one chat at a time<div class="note" style="margin:0">Hides the rest of Torn's page in the chat window and shows one open chat at a time, filling the window. The chat buttons along the bottom switch between your open chats (the one showing has a green ring); clicking the one showing closes it as usual. Display only: nothing is clicked or sent for you. If Torn changes its chat, this may need an update; turn it off if the chat looks wrong.</div></label><input type="checkbox" data-set="chatwin.compact"></div>
    <div class="setting"><label>Hide Torn's chat in the Torn browser<div class="note" style="margin:0">Torn pages in the Torn browser load without the chat; use the chat window (Ctrl+K) instead. This also makes the chat bubble's new-message sign come only from the chat window. Changing it reloads your Torn tabs.</div></label><input type="checkbox" data-set="chatwin.hideInBrowser"></div>
    <div class="setting"><label>Keep the chat window on top of other windows</label><input type="checkbox" data-set="chatwin.onTop"></div>
    <div class="setting"><label>Minimizing the chat collapses it to a bubble<div class="note" style="margin:0">The bubble stays on top, can be dragged anywhere, and lights up with a count when Torn's chat plays its new-message sound. Keep chat sounds on in Torn's chat settings for this to work. Ctrl+K or the &#9472; button also collapses it.</div></label><input type="checkbox" data-set="chatwin.minimizeToBubble"></div>
    <div class="setting"><label>Quick emojis<div class="note" style="margin:0">Shown above the chat. Click in Torn's chat box, then an emoji to type it. Paste or type the ones you use most (Win + . opens the Windows emoji panel).</div></label>
      <input type="text" data-set="chatwin.emojis" style="width:220px" maxlength="300" spellcheck="false"></div>
    </section>

    <section class="set-group" id="set-integrations" aria-labelledby="set-integrations-h"><h2 id="set-integrations-h">Integrations</h2>
    <h3>FFScouter</h3>
    <div class="card">
      <div class="row between"><b>FFScouter</b> <a data-open="https://ffscouter.com/">ffscouter.com</a></div>
      <div class="note" style="margin-top:2px">Fair fight and battle stat estimates on your targets, plus FFScouter's target finder. Uses your own FFScouter key: your Torn API key after you've signed up at ffscouter.com. Requests go only to ffscouter.com and don't use your Torn API budget.</div>
      <div id="ffs-account" style="margin-top:6px"></div>
      <form id="ffs-key-form" style="margin-top:6px">
        <div class="keyrow"><input id="ffs-key-input" type="password" placeholder="FFScouter key (16 characters)" maxlength="16" spellcheck="false" autocomplete="off"><button class="primary" id="ffs-key-save">Save</button></div>
        <label class="row small" style="margin-top:6px"><input type="checkbox" id="ffs-ack"> I have read FFScouter's current <a data-open="https://ffscouter.com/privacy">data policy</a> and agree to it.</label>
      </form>
      <div id="ffs-key-error" class="error" hidden></div>
      <div class="setting"><label>Refresh target estimates every</label><select data-set="ffscouter.intervalHours" data-num>${[1, 3, 6, 12, 24, 48].map(h => `<option value="${h}">${h} hour${h === 1 ? '' : 's'}</option>`).join('')}</select></div>
      <div class="note">Data courtesy of FFScouter. FFScouter is free to use; <a data-open="https://ffscouter.com/premium">premium</a> adds more accurate estimates and supports the service.</div>
    </div>

    <h3>Bazaar prices</h3>
    <div class="setting"><label>Bazaar prices from Weav3r<div class="note" style="margin:0">Community service that tracks player bazaars (Torn's API has no bazaar prices). No key or personal data is sent.</div></label><input type="checkbox" data-set="market.bazaar"></div>
    <div class="setting"><label>Prices from</label><select data-set="market.priceSource"><option value="both">Market + bazaars</option><option value="market">Item market</option><option value="bazaar">Bazaars</option></select></div>

    <h3>TornTools</h3>
    <div id="ext-box"><div class="muted small">Checking…</div></div>
    </section>

    <section class="set-group" id="set-app" aria-labelledby="set-app-h"><h2 id="set-app-h">App &amp; browser</h2>
    <h3>Startup &amp; tray</h3>
    <div class="setting"><label>Keep running in the system tray when this window is closed<div class="note" style="margin:0">Keeps collecting travel restock data, chain alerts and notifications. Quit from the tray icon.</div></label><input type="checkbox" data-set="ui.closeToTray"></div>
    <div class="setting"><label>Open the Torn browser when the app starts</label><input type="checkbox" data-set="ui.openTornOnStart"></div>
    <div class="web-only">
      <h3>This device</h3>
      <div class="setting win-app-only"><label>Mentat for Windows<div class="note" style="margin:0">The desktop app: Torn in its own browser window with tabs, a pop-out chat window, tabs you can pop out into bubbles that stay on top, and alerts while it runs in the tray. Same sign-in, and your settings and plan follow you.</div></label><a class="btn primary" href="/download" data-winapp>Download the Windows app</a></div>
      <div class="setting"><label>Alerts as notifications<div class="note" style="margin:0" id="web-notify-note">Your browser shows Mentat's alerts (landing, chain, full bars, cooldowns) as notifications while Mentat is open.</div></label><button data-web="notify">Allow notifications</button></div>
      <div class="setting"><label>Alerts while Mentat is closed<div class="note" style="margin:0" id="push-note">Landing, the chain timer, full bars and cooldowns on this phone or computer even when Mentat isn't open. Your API key is then kept on the Mentat server, encrypted, and used only to check your own bars, cooldowns, travel and chain (about once a minute) for these alerts. Turning this off deletes it.</div></label><button data-web="push">Turn on</button></div>
      <div class="checks" id="push-prefs" hidden>
        <label><input type="checkbox" data-push-pref="travel"> Landed</label><label><input type="checkbox" data-push-pref="chain"> Chain timer running low</label>
        <label><input type="checkbox" data-push-pref="energy"> Energy full</label><label><input type="checkbox" data-push-pref="nerve"> Nerve full</label>
        <label><input type="checkbox" data-push-pref="life"> Life full</label><label><input type="checkbox" data-push-pref="drug"> Drug cooldown over</label>
        <label><input type="checkbox" data-push-pref="booster"> Booster cooldown over</label><label><input type="checkbox" data-push-pref="medical"> Medical cooldown over</label>
      </div>
      <div class="row" id="push-actions" hidden style="margin:4px 0 8px"><button data-web="push-test">Send a test alert</button><span class="muted small" id="push-status"></span></div>
      <div class="setting"><label>Open Torn links in Torn PDA<div class="note" style="margin:0">Automatic: on Android, Torn links open in Torn PDA when it's installed and in the browser when it isn't. iPhones can't tell, so pick "Always" there if you have Torn PDA.</div></label>
        <select data-set="ui.pdaLinks"><option value="auto">Automatic (Android)</option><option value="on">Always: I have Torn PDA</option><option value="off">Never: open in the browser</option></select></div>
      <div class="setting"><label>Install Mentat as an app<div class="note" style="margin:0" id="web-install-note">Adds Mentat to your home screen or desktop, opening full screen like an app.</div></label><button data-web="install">Install</button></div>
      <div class="setting"><label>Mentat bubbles in Torn PDA<div class="note" style="margin:0">Floating bubbles over Torn pages in Torn PDA: landing time, chain timer, energy and nerve, cooldowns, war lead.</div></label><a href="/pda/" target="_blank" rel="noopener">How to add them</a></div>
    </div>
    <h3>Updates</h3>
    <div id="updates-box"></div>
    <div class="setting"><label>Check for updates automatically<div class="note" style="margin:0">New versions come from the Mentat server, download in the background and install when you restart Mentat.</div></label><input type="checkbox" data-set="updates.auto"></div>
    <div class="setting"><label>The Mentat tour<div class="note" style="margin:0">A one-minute look at where everything is: tabs, pop-outs and bubbles, the Torn browser, chat and clocks.</div></label><button data-tour="replay">Show the tour</button></div>
    <div class="setting"><label>First-run setup<div class="note" style="margin:0">Colours, top or side tabs, which tabs and top bar buttons you want, and a starter set of alerts, in a few quick steps.</div></label><button data-setup-open>Run the setup again</button></div>
    <div class="setting"><label>Minimizing a popped-out tab collapses it to a bubble<div class="note" style="margin:0">Right-click any tab and pick "Pop out" to give it its own window. Its bubble stays on top, can be dragged anywhere, and shows a live badge for some tabs (chain timer, energy or landing time, targets okay, war lead).</div></label><input type="checkbox" data-set="popouts.minimizeToBubble"></div>
    <div class="note desktop-only">Links in these tools always open as new tabs in the Torn browser window.<br>
      Tools window: Ctrl+1…9, 0 open the main tabs in their order · Ctrl+B collapse the side bar · Ctrl+D show Torn · Ctrl+T new Torn tab.<br>
      Torn browser: Ctrl+T new tab · Ctrl+W close · Ctrl+Tab switch · Ctrl+L address · Ctrl+D tools · Ctrl +/−/0 zoom · F5 reload · F11 full screen</div>
    </section>

    <section class="set-group" id="set-privacy" aria-labelledby="set-privacy-h"><h2 id="set-privacy-h">Data &amp; privacy</h2>
    <table class="privacy">
      <tr><td>Data storage</td><td>On this device: the Windows app's data folder, or this browser's own storage for the web app. If you connect a sync server (Data source above), your synced settings and collected history are also kept on that server.</td></tr>
      <tr><td>Data sharing</td><td>Nobody. Requests go to api.torn.com, plus two public community services with no key or personal data sent: YATA (abroad stock; can be turned off in Travel) and Weav3r (bazaar prices; can be turned off above).</td></tr>
      <tr><td>Purpose</td><td>Personal use: your status, chain, targets, travel planning and market prices.</td></tr>
      <tr><td>History</td><td>Prices and abroad stock levels are recorded on this PC to show trends and restock patterns.</td></tr>
      <tr><td>Sync server</td><td>Optional and yours: the app talks only to the address you enter, with your access token. The app never sends your Torn key to it; the server uses its own.</td></tr>
      <tr><td>Key storage</td><td>Encrypted with Windows (DPAPI) and never shown again (the sync server's tokens too). Your Torn key is only sent to api.torn.com; your FFScouter key only to ffscouter.com.</td></tr>
      <tr><td>FFScouter</td><td>Optional. When you add an FFScouter key, your target IDs are sent to ffscouter.com to get estimates. Their <a data-open="https://ffscouter.com/privacy">data policy</a> applies.</td></tr>
      <tr><td>Torn pages</td><td>Loaded like a normal browser. Nothing is injected, read or automated.</td></tr>
    </table>
    </section>
    </div>
    </div>`;
  markSettingsSection('account');

  $('#ffs-key-form').addEventListener('submit', async e => {
    e.preventDefault();
    const err = $('#ffs-key-error');
    const btn = $('#ffs-key-save');
    err.hidden = true;
    btn.disabled = true;
    btn.textContent = 'Checking…';
    try {
      await cmd('ffscouter.saveKey', $('#ffs-key-input').value, $('#ffs-ack').checked);
      $('#ffs-key-input').value = '';
    } catch (ex) {
      err.textContent = String(ex.message || ex).replace(/^Error invoking remote method 'cmd': (Error: )?/, '');
      err.hidden = false;
    } finally {
      btn.disabled = false;
      btn.textContent = 'Save';
    }
  });
  initSyncForm();
  $('#key-form').addEventListener('submit', async e => {
    e.preventDefault();
    const err = $('#key-error');
    const btn = $('#key-save');
    err.hidden = true;
    btn.disabled = true;
    btn.textContent = 'Checking…';
    try {
      await cmd('key.save', $('#key-input').value);
      $('#key-input').value = '';
    } catch (ex) {
      err.textContent = String(ex.message || ex).replace(/^Error invoking remote method 'cmd': (Error: )?/, '');
      err.hidden = false;
    } finally {
      btn.disabled = false;
      btn.textContent = 'Save';
    }
  });
}

// Every IANA time zone, grouped by region, with its current UTC offset.
function zoneOptions() {
  const now = new Date();
  const offset = z => {
    try {
      const p = new Intl.DateTimeFormat('en-US', { timeZone: z, timeZoneName: 'shortOffset' }).formatToParts(now).find(x => x.type === 'timeZoneName');
      return p ? p.value.replace('GMT', 'UTC') : '';
    } catch (e) { return ''; }
  };
  const groups = {};
  for (const z of Intl.supportedValuesOf('timeZone')) {
    const region = z.includes('/') ? z.split('/')[0] : 'Other';
    (groups[region] = groups[region] || []).push(z);
  }
  return Object.keys(groups).sort().map(r => `<optgroup label="${esc(r)}">${groups[r].map(z => `<option value="${esc(z)}">${esc(z.split('/').slice(1).join(' / ').replace(/_/g, ' ') || z)} (${offset(z)})</option>`).join('')}</optgroup>`).join('');
}

function renderFFSAccount() {
  const el = $('#ffs-account');
  if (!el) return;
  const f = S.features.ffscouter || {};
  const a = f.account;
  el.innerHTML = f.hasKey
    ? `<div class="row between"><span>Connected${a ? ` · <span class="muted">${a.premium ? `premium${a.premiumUntil ? ` until ${new Date(a.premiumUntil).toLocaleDateString()} · a reminder pops up 24 hours before, on whichever device you're using (checked every 6 hours)` : ''}` : 'free account (checked again every hour)'}</span>` : ''}${a && a.policyUpdate ? ' · <span class="neg">FFScouter\'s data policy changed; please re-read it on their site</span>' : ''}</span><button class="danger" data-cmd="ffscouter.removeKey">Remove</button></div>`
    : `<div class="muted">${f.error ? `<span class="neg">${esc(f.error)}</span>` : 'No FFScouter key saved.'}</div>`;
  $('#ffs-key-form').hidden = !!f.hasKey;
}

function renderSettingsAccount() {
  const el = $('#account');
  if (!el) return;
  const a = S.api;
  el.innerHTML = a.hasKey
    ? `<div class="card row between"><span>Connected as <b>${a.account ? esc(a.account.name) : '?'}</b>${a.account ? ` [${a.account.id}]` : ''}${a.account && a.account.access ? ` · <span class="muted">${esc(a.account.access)} key</span>` : ''}</span><button class="danger" data-cmd="key.remove">Remove</button></div>`
    : '<div class="muted">No key saved.</div>';
}

// ---- Updates: the version, its status, and a banner when a new one is ready ----
function renderUpdates() {
  const u = S.features.updates;
  const box = $('#updates-box');
  if (!u) return;
  const txt = {
    source: 'Running from source: updates come from your own copy.',
    idle: 'Not checked yet.',
    checking: 'Checkingâ€¦',
    current: `Up to date${u.checkedAt ? ` (checked ${fmtAgo(u.checkedAt)})` : ''}.`,
    downloading: `Downloading version ${esc(u.latest)}â€¦ ${u.percent || 0}%`,
    available: `Version ${esc(u.latest)} is out.`,
    ready: `Version ${esc(u.latest)} is ready.`,
    error: `<span class="neg">${esc(u.error)}</span>`,
  }[u.status] || '';
  if (box) {
    box.innerHTML = `<div class="setting"><label>Mentat ${esc(u.version)}<div class="note" style="margin:0">${txt}</div></label>
      <span class="row">${u.status === 'ready' ? '<button class="primary" data-upd="install">Restart to update</button>' : u.status === 'available' && u.portable ? `<button data-open-ext="${esc(u.downloadPage)}">Download</button>` : u.status !== 'source' ? `<button data-upd="check" ${['checking', 'downloading'].includes(u.status) ? 'disabled' : ''}>Check now</button>` : ''}</span></div>`;
  }
  // A banner once a new version is ready (or, for the portable copy, out), until dismissed.
  let bar = $('#update-bar');
  const show = (u.status === 'ready' || (u.status === 'available' && u.portable)) && prefs.get('updates.dismissed', '') !== u.latest && !NAV_POP;
  if (!show) { if (bar) bar.remove(); return; }
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'update-bar';
    bar.setAttribute('role', 'status');
    document.body.appendChild(bar);
  }
  bar.innerHTML = `<img src="../assets/mentat-mark.png" alt=""><span>${u.status === 'ready' ? `Mentat ${esc(u.latest)} is ready.` : `Mentat ${esc(u.latest)} is out.`}${u.notes ? ` <span class="muted small">${esc(u.notes.slice(0, 140))}</span>` : ''}</span>
    ${u.status === 'ready' ? '<button class="primary" data-upd="install">Restart now</button>' : `<button class="primary" data-open-ext="${esc(u.downloadPage)}">Download</button>`}<button data-upd="later">Later</button>`;
}
document.addEventListener('click', e => {
  const b = e.target.closest('[data-upd]');
  if (b) {
    const a = b.dataset.upd;
    const u = S.features.updates || {};
    if (a === 'check') cmd('updates.check');
    else if (a === 'install') cmd('updates.install');
    else if (a === 'later') { prefs.set('updates.dismissed', u.latest); renderUpdates(); if (u.status === 'ready') toast('It installs by itself the next time you quit Mentat.', 6000); }
    return;
  }
  const x = e.target.closest('[data-open-ext]');
  if (x) { e.preventDefault(); cmd('torn.open', x.dataset.openExt); }
});

// ---- Data source (sync server) ----
let syncFormOpen = false;
const errText = ex => String(ex.message || ex).replace(/^Error invoking remote method 'cmd': (Error: )?/, '');

function initSyncForm() {
  for (const b of $$('[data-sync-mode]')) b.addEventListener('click', async () => {
    const y = S.features.sync || {};
    if (b.dataset.syncMode === 'local') {
      syncFormOpen = false;
      if (y.mode === 'server') await cmd('sync.configure', { mode: 'local' }).catch(() => {});
    } else syncFormOpen = true;
    renderSync();
  });
  $('#sync-form').addEventListener('submit', async e => {
    e.preventDefault();
    const err = $('#sync-error');
    const btn = $('#sync-save');
    err.hidden = true;
    btn.disabled = true;
    btn.textContent = 'Connecting…';
    try {
      const s = await cmd('sync.configure', { mode: 'server', url: $('#sync-url').value, token: $('#sync-token').value, cfId: $('#sync-cfid').value, cfSecret: $('#sync-cfsecret').value, clearCf: $('#sync-cfclear').checked });
      for (const id of ['#sync-token', '#sync-cfid', '#sync-cfsecret']) $(id).value = '';
      $('#sync-cfclear').checked = false;
      if (s && s.error) { err.textContent = s.error; err.hidden = false; } else syncFormOpen = false;
    } catch (ex) {
      err.textContent = errText(ex);
      err.hidden = false;
    } finally {
      btn.disabled = false;
      btn.textContent = 'Connect';
      renderSync();
    }
  });
  $('#sync-status').addEventListener('click', async e => {
    const b = e.target.closest('[data-sync]');
    if (!b) return;
    const what = b.dataset.sync;
    if (what === 'edit') { syncFormOpen = true; renderSync(); return; }
    if (what === 'forget' && !confirm('Forget the server address and tokens on this PC? Data already on this PC stays.')) return;
    if (what === 'logout' && !confirm('Sign out of Mentat on this PC? You can sign in again with your API key.')) return;
    if (what === 'logout') { b.disabled = true; await cmd('auth.logout').catch(() => {}); return; }
    if (what === 'upload' && !confirm("Send what this PC has collected (research, war, abroad stock and price history) to the server again? It's combined with the server's own; nothing there is replaced by older data.")) return;
    b.disabled = true;
    try { await cmd(`sync.${what}`); } catch (ex) { alert(errText(ex)); }
    renderSync();
  });
}

function renderSync() {
  const y = S.features.sync;
  const box = $('#sync-status');
  if (!y || !box) return;
  const server = y.mode === 'server';
  const member = y.kind === 'session' && y.signedIn;
  const seg = $('[aria-label="Data source"]');
  if (seg) seg.closest('.setting').hidden = member;
  for (const b of $$('[data-sync-mode]')) b.classList.toggle('on', b.dataset.syncMode === (server || syncFormOpen ? 'server' : 'local'));
  const form = $('#sync-form');
  const showForm = syncFormOpen || (server && !y.hasToken);
  form.hidden = !showForm;
  if (showForm) {
    if (document.activeElement !== $('#sync-url') && !$('#sync-url').value) $('#sync-url').value = y.url || '';
    $('#sync-token').placeholder = y.hasToken ? 'saved (leave blank to keep)' : 'paste the access token';
    $('#sync-cfid').placeholder = y.hasCf ? 'saved (leave blank to keep)' : '';
    $('#sync-cfsecret').placeholder = y.hasCf ? 'saved (leave blank to keep)' : '';
    $('#sync-cfclear-row').hidden = !y.hasCf;
    $('#sync-form-note').textContent = server ? '' : 'Connecting switches this PC to the server.';
  }
  if (!server) {
    box.innerHTML = `<div class="note">Collecting on this PC.${y.url ? ` Saved server: ${esc(y.url)} · <a data-sync="forget">forget it</a>` : " To run your own server (Node.js, no extra packages), see server/README.md in the app's source."}</div>`;
    return;
  }
  const s = y.server;
  const when = t => (t ? fmtAgo(t) : 'not yet');
  const rows = [];
  if (s) {
    const r = s.research || {};
    const tracked = (r.tracked || []).filter(x => !/your faction/.test(x.why));
    rows.push(['Server', `v${esc(s.version || '?')}${s.account ? ` · collecting as <b>${esc(s.account.name)}</b> [${s.account.id}]` : ''}${s.banner ? ` · <span class="neg">${esc(s.banner)}</span>` : ''} · up ${fmtDur((Date.now() - s.startedAt) / 1000)}`]);
    rows.push(['Oppo research', tracked.length
      ? tracked.map(x => `${esc(x.name || `#${x.id}`)} <span class="muted">(${esc(x.why)})</span>`).join(', ') + (r.personalQueue ? ` · ${r.personalQueue} personal stats to fetch` : '')
      : '<span class="muted">nothing yet (starts when a war is announced)</span>']);
    const w = s.war || {};
    rows.push(['War', w.ranked ? `ranked war ${esc(w.phase || '')} · ${w.ranked.factions.map(f => `${esc(f.name)} ${num(f.score)}`).join(' vs ')}` : `<span class="muted">no ranked war${w.own ? ` for ${esc(w.own.name)}` : ''}</span>`]);
    rows.push(['Abroad stock', s.collect && s.collect.travel === false ? '<span class="muted">off on the server</span>' : `YATA ${when(s.travel && s.travel.fetchedAt)}${s.travel && s.travel.error ? ` · <span class="neg">${esc(s.travel.error)}</span>` : ''}`]);
    const p = y.pulled || {};
    const names = { research: 'oppo research', war: 'wars', travel: 'abroad stock', prices: 'price history', bazaar: 'bazaars', scout: 'scouting' };
    const got = Object.entries(p).filter(([n]) => names[n] && !(s.collect && s.collect[n] === false));
    rows.push(['On this device', got.map(([n, x]) => (x.error ? `<span class="neg">${names[n]}: ${esc(x.error)}</span>` : x.ok ? `${names[n]} ${fmtAgo(x.at)}` : `<span class="muted">${names[n]}: not yet</span>`)).join(' · ') || '<span class="muted">nothing yet</span>']);
    rows.push(['Prices', `market values ${when(s.prices && s.prices.catalogAt)} · bazaars ${when(s.bazaar && s.bazaar.fetchedAt)}${s.bazaar && s.bazaar.error ? ` · <span class="neg">${esc(s.bazaar.error)}</span>` : ''}`]);
  }
  if (s && s.scout) rows.push(['Scouting', `${s.scout.pool || 0} factions around ${s.scout.own ? esc(s.scout.own.rank) : 'your rank'} · ${s.scout.samplesLastHour || 0} checks in the last hour${s.scout.error ? ` · <span class="neg">${esc(s.scout.error)}</span>` : ''}`]);
  if (s && s.cloudBackup && s.cloudBackup.enabled) {
    const cb = s.cloudBackup;
    rows.push(['Cloud backup', !cb.configured ? '<span class="muted">not set up on the server yet</span>'
      : `${cb.lastSuccess ? `last copy ${when(cb.lastSuccess * 1000)}${cb.lastSize ? ` (${(cb.lastSize / 1048576).toFixed(1)} MB${cb.copies != null ? `, ${cb.copies} kept` : ''})` : ''}` : 'no copy yet'}${cb.bucket ? ` · bucket ${esc(cb.bucket)}` : ''}${cb.lastError ? ` · <span class="neg">${esc(cb.lastError)}</span>` : ''}`]);
  }
  rows.push(['Settings', y.pending ? `${y.pending} change${y.pending === 1 ? '' : 's'} waiting to send` : 'in sync (targets, alerts, watched items, appearance and more)']);
  const up = y.upload;
  const upNote = !up ? '' : up.running ? ` Sending… (${up.done.length}/5)` : up.error ? ` <span class="neg">${esc(up.error)}</span>` : ` Done ${fmtAgo(up.at)}.`;
  box.innerHTML = `
    <div class="card">
      <div class="row between wrap"><span>${y.error ? `<span class="neg">${esc(y.error)}</span>` : y.connected ? '<span class="pos">Connected</span>' : 'Connecting…'} · ${esc(y.url)}${y.lastOkAt ? ` · synced ${fmtAgo(y.lastOkAt)}` : ''}</span>
        <span class="row"><button data-sync="now" ${y.busy ? 'disabled' : ''}>Sync now</button>${member ? '<button data-sync="logout" class="danger">Sign out</button>' : '<button data-sync="edit">Change</button><button data-sync="forget" class="danger">Forget</button>'}</span></div>
      ${member && y.me ? `<div class="note" style="margin-top:2px">Signed in as <b>${esc(y.me.name)}</b> [${y.me.id}] · ${esc(y.me.role === 'allowed' ? 'on the allow-list' : y.me.role)}${y.me.faction && y.me.faction.name ? ` · ${esc(y.me.faction.name)}'s Mentat server` : ''}</div>` : ''}
      ${y.error ? `<div class="note">${y.covering ? 'This PC takes over collecting if the server stays unreachable for 10 minutes.' : 'This PC is collecting until the server can be reached again.'}</div>` : ''}
      <table class="data sync-table">${rows.map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join('')}</table>
      ${member ? '' : `<div class="row between wrap" style="margin-top:6px"><span class="note" style="margin:0">${up && up.auto ? "First connection: this PC's collected data is added to the server's." : "Send what this PC has collected to the server again (it's combined, not replaced)."}${upNote}</span>
        <button data-sync="upload" ${up && up.running ? 'disabled' : ''}>Send this PC's data</button></div>`}
    </div>`;
}

// Fills every [data-set] input from settings. Called when settings change.
function syncSettingInputs() {
  if (!S.settings) return;
  applyNavLayout();
  applyTabLayout();
  applyButtons();
  document.body.classList.toggle('popups-app', !!(S.settings.ui && S.settings.ui.popupStyle === 'app'));
  document.documentElement.classList.toggle('no-av', !!(S.settings.ui && S.settings.ui.avatars === false));
  // Condensed tabs (ui.condensed): that tab's pictures are hidden and its rows are tighter.
  const condensed = new Set((S.settings.ui && S.settings.ui.condensed) || []);
  for (const sec of $$('#panels > section[data-panel]')) sec.classList.toggle('condensed', condensed.has(sec.dataset.panel));
  for (const cb of $$('[data-condense]')) cb.checked = condensed.has(cb.dataset.condense);
  if (S.features.targets) renderTargetRate(S.features.targets); // the interval may have changed
  for (const input of $$('[data-set]')) {
    if (input === document.activeElement && input.type !== 'checkbox' && input.type !== 'color') continue;
    const v = input.dataset.set.split('.').reduce((o, k) => (o == null ? undefined : o[k]), S.settings);
    if (input.type === 'checkbox') input.checked = !!v;
    // An empty accent means "the theme's own": show that colour in the picker.
    else if (input.type === 'color') input.value = v || getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#74b816';
    else if (v !== undefined && input.tagName !== 'BUTTON') input.value = String(v);
  }
  // With "match Windows" on, both picks are marked, each with the mode it's for.
  const u = S.settings.ui || {};
  const theme = u.theme || 'dark';
  for (const b of $$('[data-theme-pick]')) {
    const k = b.dataset.themePick;
    const slot = u.themeAuto ? (k === u.themeDark ? 'Dark mode' : k === u.themeLight ? 'Light mode' : '') : '';
    b.classList.toggle('active', u.themeAuto ? !!slot : k === theme);
    const m = b.querySelector('.theme-mode');
    if (m) m.textContent = slot;
  }
}

document.addEventListener('change', e => {
  const input = e.target.closest('[data-set]');
  if (!input || input.tagName === 'BUTTON') return;
  let v = input.type === 'checkbox' ? input.checked : input.value;
  if ('num' in input.dataset) v = Number(v);
  cmd('settings.set', input.dataset.set, v).catch(() => syncSettingInputs());
});
document.addEventListener('click', e => {
  const b = e.target.closest('button[data-set]');
  if (b) cmd('settings.set', b.dataset.set, JSON.parse(b.dataset.value));
  const g = e.target.closest('[data-goto]');
  if (g) { showPanel(g.dataset.goto); cmd('settings.set', 'ui.panel', g.dataset.goto); }
  if (e.target.closest('[data-test-beep]')) {
    const s = S.settings.chain;
    beep(chainSound({ count: 3, freq: 880, len: 0.2, gap: 0.1, volume: s.volume }));
  }
});

// Chain timer warnings (more notes, higher pitch as time runs low) as soft bell tones,
// unless "Classic beeps" is picked in Settings → Chain alerts.
function chainSound(a) {
  const style = (S.settings && S.settings.chain && S.settings.chain.sound) || 'soft';
  if (style !== 'soft') return a;
  return { ...a, env: 'bell', wave: 'sine', len: 1.1, step: 0.26, freqs: [a.freq * 1.19], partials: [[1, 1, 1], [2, 0.22, 0.5], [3, 0.07, 0.3]] };
}

// ---- Sound ----
// Sounds are synthesized (no audio files). Classic beeps are flat square/sine tones; the
// soft sounds use pure tones with natural fades (env):
//   pluck: instant attack, quick exponential fade (marimba, harp, drop)
//   bell:  instant attack, long fade with inharmonic overtones (chimes, glass)
//   pad:   slow swell in and out (warm pad)
// partials: [[frequency ratio, level, fade multiplier]] add overtones for timbre.
// step: time between note starts (notes may overlap and ring); chord: all notes at once;
// glide: pitch slides to freq × glide (water drop). Soft sounds also go through a gentle
// low-pass filter and a quiet echo so they sound less "computery".
let audio = null;
let softBus = null;
function soundBus() {
  if (softBus) return softBus;
  const input = audio.createGain();
  const lp = audio.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = 5200;
  const delay = audio.createDelay(1);
  delay.delayTime.value = 0.13;
  const fb = audio.createGain();
  fb.gain.value = 0.22;
  const wet = audio.createGain();
  wet.gain.value = 0.18;
  input.connect(lp).connect(audio.destination);
  lp.connect(delay);
  delay.connect(fb).connect(delay);
  delay.connect(wet).connect(audio.destination);
  softBus = input;
  return softBus;
}
function beep(a) {
  try {
    audio = audio || new AudioContext();
    if (audio.state === 'suspended') audio.resume();
    const env = a.env || 'flat';
    const soft = env !== 'flat';
    const out = soft ? soundBus() : audio.destination;
    const vol = Math.max(0, Math.min(1, a.volume ?? 0.6)) * (soft ? 0.32 : 0.4);
    const freqs = a.freqs || [a.freq];
    const notes = a.chord ? [freqs] : Array.from({ length: a.count }, (_, i) => [freqs[i % freqs.length]]);
    let t = audio.currentTime + 0.03;
    for (const group of notes) {
      for (const f of group) {
        const partials = a.partials || [[1, 1, 1]];
        const level = vol / Math.sqrt(group.length);
        for (const [ratio, amp, fade] of partials) {
          const osc = audio.createOscillator();
          const g = audio.createGain();
          osc.type = a.wave || (soft ? 'sine' : 'square');
          osc.frequency.setValueAtTime(f * ratio, t);
          if (a.glide) osc.frequency.exponentialRampToValueAtTime(f * ratio * a.glide, t + a.len * 0.6);
          const peak = Math.max(0.0001, level * amp);
          const dur = a.len * (fade || 1);
          g.gain.setValueAtTime(0.0001, t);
          if (env === 'flat') {
            g.gain.linearRampToValueAtTime(peak, t + 0.01);
            g.gain.setValueAtTime(peak, t + dur - 0.02);
            g.gain.linearRampToValueAtTime(0.0001, t + dur);
          } else if (env === 'pad') {
            g.gain.linearRampToValueAtTime(peak, t + dur * 0.35);
            g.gain.linearRampToValueAtTime(0.0001, t + dur);
          } else {
            // pluck / bell: near-instant attack, natural exponential fade
            g.gain.exponentialRampToValueAtTime(peak, t + (env === 'bell' ? 0.006 : 0.004));
            g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
          }
          osc.connect(g).connect(out);
          osc.start(t);
          osc.stop(t + dur + 0.05);
        }
      }
      t += a.step ?? (a.len + (a.gap || 0));
    }
  } catch (e) { console.error(e); }
}

// ---- 1s ticker: countdowns + "x ago" ----
setInterval(() => {
  const now = Date.now();
  for (const el of $$('[data-until]')) {
    const u = Number(el.dataset.until);
    el.textContent = u > now ? fmtDur((u - now) / 1000) : el.dataset.done;
  }
  for (const el of $$('[data-ago]')) el.textContent = fmtAgo(Number(el.dataset.ago));
  // Chain timers (Chain tab and both chains on the War tab), coloured as time runs low.
  for (const ct of $$('[data-chain-until]')) {
    const sec = Math.max(0, (Number(ct.dataset.chainUntil) - now) / 1000);
    ct.textContent = fmtDur(sec);
    ct.classList.remove('ok', 'warn', 'hot', 'crit');
    ct.classList.add(chainClass(sec));
  }
}, 1000);

// ---- Wiring ----
// Panels with inputs are not redrawn while you are typing in them; they catch up on blur.
const deferred = new Set();
function renderSafe(name, fn) {
  const sec = panel(name);
  const a = document.activeElement;
  if (sec && a && sec.contains(a) && /^(INPUT|SELECT|TEXTAREA)$/.test(a.tagName) && a.type !== 'checkbox') { deferred.add(fn); return; }
  fn();
}
document.addEventListener('focusout', () => setTimeout(() => {
  const a = document.activeElement;
  if (a && /^(INPUT|SELECT|TEXTAREA)$/.test(a.tagName)) return;
  const fns = [...deferred];
  deferred.clear();
  fns.forEach(fn => fn());
}, 0));

let lastCatalogAt = 0;
const RENDER = {
  user: () => { renderOverview(); renderSafe('planner', renderPlanner); renderTargets(); }, // Abroad: where you are
  chain: () => { renderChain(); renderSafe('war', renderWar); },
  targets: renderTargets,
  travel: () => { renderSafe('travel', renderTravel); renderSafe('planner', renderPlanner); },
  planner: () => { renderSafe('planner', renderPlanner); renderSafe('travel', renderTravel); }, // Travel marks trips already planned
  avatars: () => { fillAvatars(); renderAccountButton(); },
  market: () => {
    const m = S.features.market;
    if (m && m.catalogAt !== lastCatalogAt) {
      lastCatalogAt = m.catalogAt;
      loadCatalog(true).then(() => { renderSafe('travel', renderTravel); renderSafe('market', renderMarket); });
      return;
    }
    renderSafe('market', renderMarket);
    renderSafe('travel', renderTravel); // the planner uses live prices
    renderItemModal();
  },
  bazaar: () => loadBazaar().then(() => { renderSafe('market', renderMarket); renderSafe('travel', renderTravel); renderItemModal(); }),
  ffscouter: () => { renderTargets(); renderFFSAccount(); renderSafe('war', renderWar); renderSafe('research', renderResearch); renderSafe('faction', renderFaction); },
  research: () => { renderSafe('research', renderResearch); renderSafe('faction', renderFaction); },
  scout: () => renderSafe('research', renderResearch),
  alerts: () => { renderSafe('alerts', renderAlerts); refreshRestockAlerts(); },
  casino: () => renderSafe('casino', renderCasino),
  war: () => { renderSafe('war', renderWar); updateStackNag(); },
  claims: () => renderSafe('war', renderWar),
  warreport: () => renderWarReport(), // building progress
  sync: () => { renderSync(); renderGate(); renderMembers(); renderAccountButton(); },
  updates: () => renderUpdates(),
};

app.on('browser', b => { S.browser = b; renderBrowserButton(); });
app.on('panel', name => { showPanel(name); cmd('settings.set', 'ui.panel', name); });
// ---- Pop-out window: a bar with the tab's name, keep-on-top, collapse to bubble, tools window ----
function initPopout() {
  document.title = `${navLabel(NAV_POP)} · Mentat`;
  const bar = document.createElement('header');
  bar.id = 'pop-bar';
  bar.innerHTML = `<svg class="nav-icon" viewBox="0 0 24 24" aria-hidden="true">${navIcon(NAV_POP)}</svg><b>${esc(navLabel(NAV_POP))}</b><span class="spacer"></span>
    <button data-pop-act="top" title="Keep this window on top of other windows">On top</button>
    <button data-pop-act="collapse" title="Collapse to a bubble (minimizing does this too)">Bubble</button>
    <button data-pop-act="main" title="Show this tab in the tools window">Tools window</button>`;
  document.body.prepend(bar);
  bar.addEventListener('click', e => {
    const b = e.target.closest('[data-pop-act]');
    if (!b) return;
    const a = b.dataset.popAct;
    if (a === 'top') cmd('pop.onTop', b.getAttribute('aria-pressed') !== 'true');
    else if (a === 'collapse') cmd('pop.collapse');
    else if (a === 'main') cmd('pop.toMain', NAV_POP);
  });
  const show = s => {
    if (!s || s.id !== NAV_POP) return;
    bar.querySelector('[data-pop-act="top"]').setAttribute('aria-pressed', String(!!s.onTop));
  };
  app.on('popout', show);
  cmd('pop.state').then(show);
  // The bubble's badge, worked out here once a second (this page has the live data).
  let last = '';
  setInterval(() => {
    let b = null;
    try { b = popBadge(NAV_POP); } catch (e) { b = null; }
    const k = JSON.stringify(b);
    if (k !== last) { last = k; cmd('pop.badge', b); }
  }, 1000);
}
// Short times for a badge: 4:32, 2h05, 3d4h.
function shortDur(sec) {
  sec = Math.max(0, Math.floor(sec));
  if (sec < 3600) return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h${String(Math.floor(sec % 3600 / 60)).padStart(2, '0')}`;
  return `${Math.floor(sec / 86400)}d${Math.floor(sec % 86400 / 3600)}h`;
}
const badgeNum = n => (Math.abs(n) >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : Math.abs(n) >= 1e4 ? `${Math.round(n / 1e3)}k` : Math.abs(n) >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(Math.round(n)));
// What a tab's bubble shows: { text, tone (ok / warn / bad / info), title } or nothing.
function popBadge(id) {
  const now = Date.now();
  const p = navParent(id);
  const user = S.features.user && S.features.user.data;
  const flying = user && user.travel && user.travel.arriveAt > now ? user.travel : null;
  if (p === 'chain') {
    const c = S.features.chain && S.features.chain.chain;
    if (!c || c.noFaction) return null;
    if (c.cooldown) return { text: shortDur((c.cooldownUntil - now) / 1000), tone: 'info', title: `chain cooldown after ${num(c.current)} hits` };
    if (c.current > 0 && c.expiresAt > now) {
      const s = (c.expiresAt - now) / 1000;
      return { text: shortDur(s), tone: s < 60 ? 'bad' : s < 120 ? 'warn' : 'ok', title: `chain ${num(c.current)}, ${fmtDur(s)} left` };
    }
    return { text: '–', title: 'no chain running' };
  }
  if (p === 'overview') {
    if (flying) return { text: shortDur((flying.arriveAt - now) / 1000), tone: 'info', title: `landing in ${flying.destination}` };
    const e = user && user.bars && user.bars.energy;
    if (!e) return null;
    const full = e.current >= e.maximum || e.fullAt <= now;
    return { text: `E ${e.current}`, tone: full ? 'ok' : '', title: `energy ${e.current}/${e.maximum}${full ? ', full' : `, full in ${fmtDur((e.fullAt - now) / 1000)}`}` };
  }
  if (p === 'travel') {
    if (flying) return { text: shortDur((flying.arriveAt - now) / 1000), tone: 'info', title: `landing in ${flying.destination}` };
    return null;
  }
  if (p === 'targets') {
    const ts = (S.features.targets && S.features.targets.targets) || [];
    if (!ts.length) return null;
    const ok = ts.filter(t => t.status && t.status.state === 'Okay').length;
    return { text: `${ok} ok`, tone: ok ? 'ok' : '', title: `${ok} of ${ts.length} targets okay` };
  }
  if (p === 'war' || p === 'faction') {
    const w = S.features.war;
    const r = w && w.wars && w.wars.ranked;
    if (!r) return null;
    if (w.phase === 'upcoming') return { text: shortDur((r.start - now) / 1000), tone: 'info', title: 'ranked war starts in' };
    const own = w.own ? w.own.id : 0;
    const us = r.factions.find(f => f.id === own) || r.factions[0];
    const them = r.factions.find(f => f !== us) || r.factions[1];
    if (!us || !them) return null;
    const lead = us.score - them.score;
    return { text: `${lead >= 0 ? '+' : '−'}${badgeNum(Math.abs(lead))}`, tone: lead >= 0 ? 'ok' : 'bad', title: `${num(us.score)} to ${num(them.score)} vs ${them.name}` };
  }
  return null;
}

app.on('panelSlot', i => {
  const id = navModel().main[i];
  if (id) { showPanel(id); cmd('settings.set', 'ui.panel', id); }
});
app.on('api', a => {
  const keyChanged = a.hasKey !== S.api.hasKey;
  S.api = a;
  renderApi();
  if (keyChanged) { renderOverview(); renderChain(); }
});
let navSeen = null;
app.on('settings', s => {
  S.settings = s;
  const navNow = JSON.stringify((s.ui && s.ui.nav) || null);
  if (navSeen !== null && navNow !== navSeen) { showPanel(navActive); renderNavEditor(); }
  navSeen = navNow;
  renderClocks();
  renderChain();
  renderSafe('travel', renderTravel);
  renderSafe('market', renderMarket);
  renderSafe('planner', renderPlanner); // a new theme means new bar colours in its charts
  syncSettingInputs();
  renderItemModal();
});
app.on('feature', ({ name, state }) => { S.features[name] = state; (RENDER[name] || (() => {}))(); syncSettingInputs(); });
// Chain warnings carry the seconds they're for (a.sec); alert sounds come ready-made.
app.on('beep', a => beep(a.sec ? chainSound(a) : a));
app.on('extensions', renderExtBox);
app.on('chatwin', c => {
  const b = $('#btn-chat');
  b.classList.toggle('active', !!c.open);
  b.classList.toggle('unread', !!c.unread);
  b.textContent = c.unread ? `Chat (${c.unread > 9 ? '9+' : c.unread})` : 'Chat';
});

(async function init() {
  const s = await cmd('init');
  Object.assign(S, s);
  renderSettingsShell();
  renderSync();
  initWelcome(); // first, so nobody sees the tools before signing in
  renderMembers();
  renderUpdates();
  renderTargetsShell();
  initTravel();
  initMarket();
  initCasino();
  initPlanner();
  initItemModal();
  initAlerts();
  initWar();
  initResearch();
  initFaction();
  cmd('ext.status').then(renderExtBox);
  if (S.features.market && S.features.market.catalogAt) {
    lastCatalogAt = S.features.market.catalogAt;
    await loadCatalog(true);
  }
  await loadBazaar(true);
  renderBrowserButton();
  renderAccountButton();
  renderFFSAccount();
  renderApi();
  renderOverview();
  renderChain();
  renderTargets();
  syncSettingInputs();
  navSeen = JSON.stringify(S.settings.ui.nav || null);
  renderNavEditor();
  showPanel(NAV_POP || S.settings.ui.panel || 'overview');
  if (NAV_POP) initPopout();
  if (S.features.sync && S.features.sync.signedIn) afterSignIn(S.features.sync.me);
})();
