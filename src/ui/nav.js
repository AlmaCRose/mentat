'use strict';
/* global S, $, $$, esc, cmd, prefs, showPanel */
// Tab layout: the order of the main tabs and of each tab's sub-tabs, which ones are hidden, and
// which sub-tabs sit on the main bar as tabs of their own ("Scouting" next to "War", say).
// Changed by dragging tabs, by right-clicking one, or in Settings → Appearance → Tabs.
// Stored as ui.nav = { order: [main ids], sub: { panel: [view ids] }, hidden: [ids] }, where a
// main id is a panel ('market') or a lifted sub-tab ('market:watch'). Anything missing (a new
// tab in a later version, say) goes back to its default place.

// Default order (the user's choice, 2026-11-18).
const NAV_PANELS = [['overview', 'Overview'], ['chain', 'Chain'], ['targets', 'Targets'], ['faction', 'My Faction'], ['war', 'War'], ['research', 'Oppo Research'], ['market', 'Market'], ['travel', 'Travel'], ['planner', 'Planner'], ['casino', 'Casino'], ['alerts', 'Alerts'], ['settings', 'Settings']];
// Sub-tabs. `pref` remembers the one last open when they sit under their tab.
const NAV_SUBS = {
  targets: { pref: 'targets.sub', views: [['list', 'Targets'], ['abroad', 'Abroad']] },
  research: { pref: 'research.view', views: [['overview', 'Research'], ['report', 'War report'], ['scout', 'Scouting']] },
  travel: { pref: 'travel.sub', views: [['timed', 'Timed trips'], ['plan', 'Leave now'], ['items', 'Abroad items'], ['sell', 'Sell abroad'], ['flights', 'Flights & settings']] },
  casino: { pref: 'casino.sub', views: [['blackjack', 'Blackjack'], ['poker', 'Poker'], ['highlow', 'High-Low'], ['games', 'Other games'], ['bookie', 'Bookie'], ['tracker', 'Tracker']] },
  market: { pref: 'market.sub', views: [['lookup', 'Item lookup'], ['watch', 'Watchlist'], ['deals', 'Deal finder'], ['trade', 'Trade calculator']] },
};

const NAV_KNOWN = new Set(NAV_PANELS.map(p => p[0]));
for (const [p, d] of Object.entries(NAV_SUBS)) for (const [v] of d.views) NAV_KNOWN.add(`${p}:${v}`);

let navActive = 'overview';
// In a pop-out window (index.html?pop=<tab>), the one tab it shows.
const NAV_POP = new URLSearchParams(location.search).get('pop') || '';
if (NAV_POP) { document.body.classList.add('popout'); document.body.classList.remove('gated'); } // the tools window does the signing in
let navCache = { raw: null, model: null };

const navParent = id => String(id).split(':')[0];
const navSubOf = id => String(id).split(':')[1] || '';
function navLabel(id) {
  const [p, v] = String(id).split(':');
  if (v) return ((NAV_SUBS[p] && NAV_SUBS[p].views.find(x => x[0] === v)) || [v, v])[1];
  return (NAV_PANELS.find(x => x[0] === p) || [p, p])[1];
}

function navNormalize(raw) {
  raw = raw && typeof raw === 'object' ? raw : {};
  const seen = new Set();
  const order = [];
  for (const id of Array.isArray(raw.order) ? raw.order : []) {
    if (NAV_KNOWN.has(id) && !seen.has(id)) { seen.add(id); order.push(id); }
  }
  // Main tabs that are missing go back after their default neighbour.
  NAV_PANELS.forEach(([id], i) => {
    if (seen.has(id)) return;
    let at = 0;
    for (let j = i - 1; j >= 0; j--) {
      const k = order.indexOf(NAV_PANELS[j][0]);
      if (k >= 0) { at = k + 1; break; }
    }
    order.splice(at, 0, id);
    seen.add(id);
  });
  const sub = {};
  for (const [p, d] of Object.entries(NAV_SUBS)) {
    const given = raw.sub && Array.isArray(raw.sub[p]) ? raw.sub[p] : [];
    const list = [];
    for (const v of [...given, ...d.views.map(x => x[0])]) {
      if (d.views.some(x => x[0] === v) && !seen.has(`${p}:${v}`) && !list.includes(v)) list.push(v);
    }
    sub[p] = list;
  }
  const hidden = [...new Set((Array.isArray(raw.hidden) ? raw.hidden : []).filter(id => NAV_KNOWN.has(id) && id !== 'settings'))];
  return { order, sub, hidden };
}

// The layout as shown: `main` = the main bar's tabs, `subs[panel]` = that tab's sub-tabs.
function navModel() {
  const raw = (S.settings && S.settings.ui && S.settings.ui.nav) || null;
  const key = JSON.stringify(raw);
  if (navCache.raw === key) return navCache.model;
  const n = navNormalize(raw);
  const hidden = new Set(n.hidden);
  const subs = {};
  for (const p of Object.keys(NAV_SUBS)) subs[p] = n.sub[p].filter(v => !hidden.has(`${p}:${v}`));
  // A tab whose sub-tabs are all hidden or lifted out has nothing left to show.
  const main = n.order.filter(id => !hidden.has(id) && (id.includes(':') || !NAV_SUBS[id] || subs[id].length));
  navCache = { raw: key, model: { ...n, hiddenSet: hidden, subs, main } };
  return navCache.model;
}
// Expanded side bar: each tab's sub-tabs sit in a small menu under it, instead of across the panel.
const navSubsInBar = () => document.body.classList.contains('nav-side') && !document.body.classList.contains('nav-collapsed');
// A sub-menu is open for the tab on show, or when its arrow was clicked open (closing it sticks).
function navSubsOpen(p) {
  const o = prefs.get('nav.subsOpen', {}) || {};
  if (o[p] === true) return true;
  return navActive === p && o[p] !== false;
}
const navSig = () => `${navActive}|${navCache.raw}|${navSubsInBar()}|${prefs.get('research.view', '')}`;

// An entry that can be shown: a lifted sub-tab that has been put back opens under its tab.
function navResolve(id) {
  id = String(id || '');
  if (!NAV_KNOWN.has(id)) return 'overview';
  if (NAV_POP && id === NAV_POP) return id; // a popped-out sub-tab shows on its own
  if (!id.includes(':')) return id;
  if (navModel().order.includes(id)) return id;
  const p = navParent(id);
  prefs.set(NAV_SUBS[p].pref, navSubOf(id));
  return p;
}

// The sub-tab a panel should draw now.
function navView(p) {
  const d = NAV_SUBS[p];
  if (navActive.includes(':') && navParent(navActive) === p) return navSubOf(navActive);
  const vis = navModel().subs[p];
  const all = navModel().sub[p];
  const pref = prefs.get(d.pref, '');
  if (vis.includes(pref)) return pref;
  return vis[0] || (all.includes(pref) ? pref : all[0] || d.views[0][0]);
}

// The sub-tab bar for a panel (none when it shows one lifted sub-tab, or has one sub-tab left).
// `attr` is the panel's own click attribute (data-<attr>="view"); `labels` overrides labels.
function navSubnav(p, attr, style = '', labels = {}) {
  if (navActive.includes(':') && navParent(navActive) === p) return '';
  if (navSubsInBar()) return ''; // they're in the side bar
  const vis = navModel().subs[p];
  if (vis.length < 2) return '';
  const cur = navView(p);
  return `<div class="subnav" data-nav-subbar="${p}"${style ? ` style="${style}"` : ''}>${vis.map(v => `<button data-${attr}="${v}" data-nav-sub="${p}:${v}" draggable="true" class="${v === cur ? 'active' : ''}">${esc(labels[v] || navLabel(`${p}:${v}`))}</button>`).join('')}</div>`;
}

// Open a panel on one of its sub-tabs, wherever that sub-tab lives now.
function navOpen(p, v) {
  const id = `${p}:${v}`;
  if (NAV_POP) { // a pop-out shows its own tab; anything else opens in the tools window
    if (NAV_POP === p) { prefs.set(NAV_SUBS[p].pref, v); showPanel(p); } else showPanel(id);
    return;
  }
  if (navModel().order.includes(id)) { showPanel(id); cmd('settings.set', 'ui.panel', id); return; }
  prefs.set(NAV_SUBS[p].pref, v);
  if (navActive !== p) { showPanel(p); cmd('settings.set', 'ui.panel', p); } else showPanel(p);
}

// ---- Changing the layout ----
function navSave(n) {
  return cmd('settings.set', 'ui.nav', { order: n.order, sub: n.sub, hidden: n.hidden });
}
function navEdit(fn) {
  const m = navModel();
  const n = { order: [...m.order], sub: Object.fromEntries(Object.entries(m.sub).map(([k, v]) => [k, [...v]])), hidden: [...m.hidden] };
  if (fn(n) === false) return;
  navSave(n);
}
// Put `id` on the main bar (ref = a main id to go next to) or in its tab's sub-tab bar.
function navPlace(id, bar, ref, after) {
  navEdit(n => {
    const p = navParent(id);
    const v = navSubOf(id);
    if (bar === 'sub' && !v) return false;
    if (bar === 'sub' && ref && navParent(ref) !== p) return false;
    n.order = n.order.filter(x => x !== id);
    if (v) n.sub[p] = n.sub[p].filter(x => x !== v);
    if (bar === 'main') {
      let at = ref ? n.order.indexOf(ref) : -1;
      at = at < 0 ? n.order.length : at + (after ? 1 : 0);
      n.order.splice(at, 0, id);
    } else {
      const list = n.sub[p];
      let at = ref ? list.indexOf(navSubOf(ref)) : -1;
      at = at < 0 ? list.length : at + (after ? 1 : 0);
      list.splice(at, 0, v);
    }
    n.hidden = n.hidden.filter(x => x !== id);
  });
}
// One step along the visible tabs of its bar.
function navStep(id, dir) {
  const m = navModel();
  const lifted = m.order.includes(id);
  const vis = lifted ? m.main : m.subs[navParent(id)].map(v => `${navParent(id)}:${v}`);
  const i = vis.indexOf(id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= vis.length) return;
  navPlace(id, lifted ? 'main' : 'sub', vis[j], dir > 0);
}
function navSetHidden(id, hide) {
  if (id === 'settings') return;
  navEdit(n => {
    n.hidden = n.hidden.filter(x => x !== id);
    if (hide) n.hidden.push(id);
  });
}
function navReset() { cmd('settings.set', 'ui.nav', { order: [], sub: {}, hidden: [] }); }

// Condensed tabs (ui.condensed): no profile pictures, faction tags or banners in that tab, with
// tighter rows. Only the tabs that show pictures offer it; a sub-tab condenses its whole tab.
const PICTURE_TABS = ['overview', 'chain', 'targets', 'research', 'faction', 'war'];
const condensedTabs = () => (S.settings && S.settings.ui && Array.isArray(S.settings.ui.condensed) ? S.settings.ui.condensed : []);
function setCondensed(tab, on) {
  if (!PICTURE_TABS.includes(tab)) return;
  const next = condensedTabs().filter(x => x !== tab);
  if (on) next.push(tab);
  cmd('settings.set', 'ui.condensed', next);
}
// The checkboxes in Settings → Customization
document.addEventListener('change', e => {
  const t = e.target && e.target.dataset && e.target.dataset.condense;
  if (t) setCondensed(t, e.target.checked);
});

// ---- Drag and drop: on the main bar and on sub-tab bars ----
let navDrag = '';
const navVertical = el => document.body.classList.contains('nav-side') && !!el.closest('#panel-nav');
function navDropTarget(e) {
  if (!navDrag) return null;
  const main = e.target.closest('#panel-nav');
  const subbar = e.target.closest('[data-nav-subbar]');
  let bar = null;
  // A sub-tab over its own tab's sub-tabs (in the panel or the side bar's sub-menu) reorders them;
  // anywhere else on the main bar it becomes a main tab there.
  if (subbar && subbar.dataset.navSubbar === navParent(navDrag) && navSubOf(navDrag)) bar = { el: subbar, kind: 'sub', sel: '[data-nav-sub]', key: 'navSub' };
  else if (main) bar = { el: main, kind: 'main', sel: '[data-panel]', key: 'panel' };
  if (!bar) return null;
  const btns = $$(bar.sel, bar.el).filter(b => b.dataset[bar.key] !== navDrag);
  const vert = navVertical(bar.el);
  let ref = null, after = false;
  for (const b of btns) {
    const r = b.getBoundingClientRect();
    const mid = vert ? r.top + r.height / 2 : r.left + r.width / 2;
    ref = b; after = (vert ? e.clientY : e.clientX) > mid;
    if (!after) break;
  }
  return { ...bar, ref, after };
}
function navClearMarks() { for (const b of $$('.drop-before, .drop-after')) b.classList.remove('drop-before', 'drop-after'); }
document.addEventListener('dragstart', e => {
  const b = e.target.closest && e.target.closest('#panel-nav [data-panel], [data-nav-sub]');
  if (!b) return;
  navDrag = b.dataset.panel || b.dataset.navSub;
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', navLabel(navDrag));
  document.body.classList.add('nav-dragging', navSubOf(navDrag) ? 'nav-dragging-sub' : 'nav-dragging-main');
});
document.addEventListener('dragover', e => {
  const t = navDropTarget(e);
  navClearMarks();
  if (!t) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  if (t.ref) t.ref.classList.add(t.after ? 'drop-after' : 'drop-before');
});
document.addEventListener('drop', e => {
  const t = navDropTarget(e);
  navClearMarks();
  if (!t) return;
  e.preventDefault();
  const ref = t.ref ? t.ref.dataset[t.key] : null;
  navPlace(navDrag, t.kind, ref, t.after);
});
document.addEventListener('dragend', () => {
  navDrag = '';
  navClearMarks();
  document.body.classList.remove('nav-dragging', 'nav-dragging-sub', 'nav-dragging-main');
});

// ---- Right-click menu on a tab ----
function navMenuClose() { const m = $('#nav-menu'); if (m) m.remove(); }
document.addEventListener('contextmenu', e => {
  const b = e.target.closest('#panel-nav [data-panel], [data-nav-sub]');
  if (!b) return;
  e.preventDefault();
  navMenuClose();
  const id = b.dataset.panel || b.dataset.navSub;
  const m = navModel();
  const lifted = m.order.includes(id);
  const p = navParent(id);
  const vert = document.body.classList.contains('nav-side') && !!b.closest('#panel-nav');
  const bar = lifted ? m.main : m.subs[p].map(v => `${p}:${v}`);
  const i = bar.indexOf(id);
  const items = [
    ['back', vert ? 'Move up' : 'Move left', i <= 0],
    ['fwd', vert ? 'Move down' : 'Move right', i < 0 || i >= bar.length - 1],
  ];
  if (navSubOf(id)) items.push(lifted ? ['demote', `Put back under ${navLabel(p)}`] : ['promote', 'Show on the main bar']);
  if (id !== 'settings') items.push(['hide', 'Hide this tab', lifted && m.main.length <= 2]);
  if (!document.documentElement.classList.contains('web')) items.push(['pop', 'Pop out into its own window']);
  const tab = id.split(':')[0];
  if (PICTURE_TABS.includes(tab)) items.push(['condense', condensedTabs().includes(tab) ? 'Show pictures in this tab' : 'Condensed view (no pictures)']);
  items.push(['-'], ['edit', 'Customize tabs…']);
  const menu = document.createElement('div');
  menu.id = 'nav-menu';
  menu.setAttribute('role', 'menu');
  menu.innerHTML = items.map(([k, l, off]) => (k === '-' ? '<hr>' : `<button role="menuitem" data-nav-menu="${k}"${off ? ' disabled' : ''}>${esc(l)}</button>`)).join('');
  document.body.appendChild(menu);
  const r = menu.getBoundingClientRect();
  menu.style.left = `${Math.min(e.clientX, innerWidth - r.width - 4)}px`;
  menu.style.top = `${Math.min(e.clientY, innerHeight - r.height - 4)}px`;
  menu.dataset.id = id;
  menu.querySelector('button:not([disabled])')?.focus();
});
document.addEventListener('click', e => {
  const menu = $('#nav-menu');
  if (!menu) return;
  const b = e.target.closest('[data-nav-menu]');
  if (!b) { if (!e.target.closest('#nav-menu')) navMenuClose(); return; }
  const id = menu.dataset.id;
  navMenuClose();
  const k = b.dataset.navMenu;
  if (k === 'back' || k === 'fwd') navStep(id, k === 'back' ? -1 : 1);
  else if (k === 'pop') cmd('pop.open', id);
  else if (k === 'condense') { const tab = id.split(':')[0]; setCondensed(tab, !condensedTabs().includes(tab)); }
  else if (k === 'promote') {
    const p = navParent(id);
    navPlace(id, 'main', p, true); // right after its tab
  } else if (k === 'demote') navPlace(id, 'sub', null, false);
  else if (k === 'hide') {
    if (navActive === id) { const next = navModel().main.find(x => x !== id) || 'overview'; showPanel(next); cmd('settings.set', 'ui.panel', next); }
    navSetHidden(id, true);
  } else if (k === 'edit') {
    showPanel('settings');
    cmd('settings.set', 'ui.panel', 'settings');
    const ed = $('#nav-editor');
    if (ed) ed.scrollIntoView({ block: 'start' });
  }
}, true);
document.addEventListener('keydown', e => { if (e.key === 'Escape') navMenuClose(); });
window.addEventListener('blur', navMenuClose);
window.addEventListener('resize', navMenuClose);

// Side bar sub-menus: a sub-tab opens its tab on that view; the arrow opens or closes the menu.
document.addEventListener('click', e => {
  const t = e.target.closest('[data-nav-toggle]');
  if (!t) return;
  e.preventDefault();
  e.stopPropagation(); // not a click on the tab itself
  const p = t.dataset.navToggle;
  prefs.set('nav.subsOpen', { ...(prefs.get('nav.subsOpen', {}) || {}), [p]: !navSubsOpen(p) });
  renderNav();
}, true);
document.addEventListener('click', e => {
  const s = e.target.closest('#panel-nav [data-nav-sub]');
  if (s) navOpen(navParent(s.dataset.navSub), navSubOf(s.dataset.navSub));
});

// The main bar scrolls sideways with the mouse wheel when its tabs don't fit.
document.addEventListener('wheel', e => {
  const nav = e.target.closest && e.target.closest('#panel-nav');
  if (!nav || document.body.classList.contains('nav-side') || nav.scrollWidth <= nav.clientWidth || e.deltaX) return;
  nav.scrollLeft += e.deltaY;
  e.preventDefault();
}, { passive: false });

// ---- Phones: "More" opens every tab, in your order, as a sheet above the bottom bar ----
function navSheet(open) {
  let sheet = $('#nav-sheet');
  let scrim = $('#nav-scrim');
  if (!sheet) {
    scrim = document.createElement('div');
    scrim.id = 'nav-scrim';
    sheet = document.createElement('div');
    sheet.id = 'nav-sheet';
    sheet.hidden = true;
    scrim.hidden = true;
    sheet.setAttribute('role', 'menu');
    document.body.append(scrim, sheet);
    scrim.addEventListener('click', () => navSheet(false));
    sheet.addEventListener('click', e => {
      const b = e.target.closest('[data-sheet]');
      if (!b) return;
      navSheet(false);
      showPanel(b.dataset.sheet);
      cmd('settings.set', 'ui.panel', b.dataset.sheet);
    });
  }
  const show = open === undefined ? sheet.hidden : open;
  if (show) {
    const m = navModel();
    sheet.innerHTML = `<div class="sheet-title">All tabs</div>${m.main.map(id => `<button role="menuitem" data-sheet="${id}" class="${id === navActive ? 'active' : ''}"><svg viewBox="0 0 24 24" aria-hidden="true">${navIcon(id)}</svg>${esc(navLabel(id))}</button>`).join('')}`;
  }
  sheet.hidden = !show;
  scrim.hidden = !show;
  const more = $('#panel-nav [data-nav-more]');
  if (more) more.setAttribute('aria-expanded', String(show));
}
document.addEventListener('click', e => {
  if (e.target.closest('[data-nav-more]')) { e.preventDefault(); navSheet(); }
});

// ---- Settings → Appearance → Tabs ----
const NAV_ARROW = '<svg class="nav-ed-arrow" viewBox="0 0 12 12" aria-hidden="true"><path d="M6 1.5 1.5 6.5h3V10.5h3V6.5h3z"/></svg>';
function renderNavEditor() {
  const el = $('#nav-editor');
  if (!el || !S.settings) return;
  const m = navModel();
  const icon = id => `<svg class="nav-ed-icon" viewBox="0 0 24 24" aria-hidden="true">${navIcon(id)}</svg>`;
  const ctl = (id, i, len, hidden, extra = '') => `
    <span class="nav-ed-ctl">
      <button data-nav-ed="up" data-id="${id}" title="Move earlier" aria-label="Move earlier"${i <= 0 ? ' disabled' : ''}>${NAV_ARROW}</button>
      <button data-nav-ed="down" data-id="${id}" title="Move later" aria-label="Move later" class="down"${i >= len - 1 ? ' disabled' : ''}>${NAV_ARROW}</button>
      ${extra}
      ${id === 'settings' ? '<span class="nav-ed-fixed muted small" title="Settings always stays, so you can get back here">always shown</span>'
    : `<label class="nav-ed-show"><input type="checkbox" data-nav-ed="show" data-id="${id}"${hidden ? '' : ' checked'}> Show</label>`}
    </span>`;
  const rows = m.order.map((id, i) => {
    const hidden = m.hiddenSet.has(id);
    const p = navParent(id);
    const lifted = id.includes(':');
    const empty = !lifted && NAV_SUBS[id] && !m.subs[id].length;
    const subs = !lifted && NAV_SUBS[id] ? `<ol class="nav-ed-subs">${m.sub[id].map((v, j) => {
      const sid = `${id}:${v}`;
      return `<li class="${m.hiddenSet.has(sid) ? 'off' : ''}"><span class="nav-ed-name">${icon(sid)}${esc(navLabel(sid))}</span>${ctl(sid, j, m.sub[id].length, m.hiddenSet.has(sid), `<button data-nav-ed="promote" data-id="${sid}" title="Show it as its own tab on the main bar">To main bar</button>`)}</li>`;
    }).join('')}</ol>` : '';
    return `<li class="${hidden || empty ? 'off' : ''}"><div class="nav-ed-row"><span class="nav-ed-name">${icon(id)}${esc(navLabel(id))}${lifted ? ` <span class="muted small">from ${esc(navLabel(p))}</span>` : ''}${empty ? ' <span class="muted small">(no sub-tabs left to show)</span>' : ''}</span>
      ${ctl(id, i, m.order.length, hidden, lifted ? `<button data-nav-ed="demote" data-id="${id}" title="Put it back as a sub-tab of ${esc(navLabel(p))}">Back to ${esc(navLabel(p))}</button>` : '')}</div>${subs}</li>`;
  }).join('');
  el.innerHTML = `<ol class="nav-ed">${rows}</ol>`;
}
document.addEventListener('click', e => {
  const b = e.target.closest('button[data-nav-ed]');
  if (!b) return;
  const id = b.dataset.id;
  const k = b.dataset.navEd;
  if (k === 'up' || k === 'down') {
    // Along the full list in the editor (hidden ones too), not just the visible tabs.
    const m = navModel();
    const lifted = m.order.includes(id);
    const list = lifted ? m.order : m.sub[navParent(id)].map(v => `${navParent(id)}:${v}`);
    const i = list.indexOf(id);
    const j = i + (k === 'up' ? -1 : 1);
    if (i >= 0 && j >= 0 && j < list.length) navPlace(id, lifted ? 'main' : 'sub', list[j], k === 'down');
  } else if (k === 'promote') navPlace(id, 'main', navParent(id), true);
  else if (k === 'demote') navPlace(id, 'sub', null, false);
  else if (k === 'reset') navReset();
});
document.addEventListener('change', e => {
  const c = e.target.closest('input[data-nav-ed="show"]');
  if (c) navSetHidden(c.dataset.id, !c.checked);
});
