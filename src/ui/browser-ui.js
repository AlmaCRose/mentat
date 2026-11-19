'use strict';
/* global app */
// Tab strip + address bar of the Torn browser window.

const $ = sel => document.querySelector(sel);
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const cmd = (name, ...args) => app.cmd(name, ...args).catch(e => console.error(e));
let tabs = [];

function renderTabs() {
  $('#tabs').innerHTML = tabs.map(t => `
    <div class="tab ${t.active ? 'active' : ''}" data-tab="${t.id}" title="${esc(t.title)}\n${esc(t.url)}">
      ${t.loading ? '<span class="spinner"></span>' : t.favicon ? `<img src="${esc(t.favicon)}" alt="">` : '<span style="width:14px"></span>'}
      <span class="title">${esc(t.title || 'Torn')}</span>
      <button class="close" data-close="${t.id}" title="Close (Ctrl+W)">&times;</button>
    </div>`).join('');
  const a = tabs.find(t => t.active);
  $('#btn-back').disabled = !a || !a.canGoBack;
  $('#btn-forward').disabled = !a || !a.canGoForward;
  $('#btn-reload').innerHTML = a && a.loading ? '&#10005;' : '&#8635;';
  $('#btn-reload').title = a && a.loading ? 'Stop' : 'Reload (F5)';
  if (document.activeElement !== $('#address')) $('#address').value = a ? a.url : '';
}

$('#tabs').addEventListener('mousedown', e => {
  const tab = e.target.closest('[data-tab]');
  if (!tab) return;
  if (e.button === 1) { e.preventDefault(); cmd('tabs.close', Number(tab.dataset.tab)); return; }
  if (e.button === 0 && !e.target.closest('[data-close]')) cmd('tabs.activate', Number(tab.dataset.tab));
});
$('#tabs').addEventListener('click', e => {
  const c = e.target.closest('[data-close]');
  if (c) cmd('tabs.close', Number(c.dataset.close));
});
$('#tabstrip').addEventListener('dblclick', e => { if (e.target === $('#tabstrip') || e.target === $('#tabs')) cmd('tabs.new'); });
$('#new-tab').addEventListener('click', () => cmd('tabs.new'));
$('#btn-back').addEventListener('click', () => cmd('tabs.back'));
$('#btn-forward').addEventListener('click', () => cmd('tabs.forward'));
$('#btn-home').addEventListener('click', () => cmd('tabs.home'));
$('#btn-reload').addEventListener('click', () => {
  const a = tabs.find(t => t.active);
  cmd(a && a.loading ? 'tabs.stop' : 'tabs.reload');
});
$('#btn-tool').addEventListener('click', () => cmd('tool.focus'));
$('#btn-chat').addEventListener('click', () => cmd('chatwin.open'));
// TornTools dashboard button, shown while TornTools is turned on.
const showTT = st => { $('#btn-tt').hidden = !(st && st.enabled && st.loaded); };
$('#btn-tt').addEventListener('click', () => cmd('ext.popup'));
cmd('ext.status').then(showTT).catch(() => {});
app.on('extensions', showTT);
$('#btn-pages').addEventListener('click', e => {
  const r = e.currentTarget.getBoundingClientRect();
  cmd('pages.menu', r.left, r.bottom);
});
$('#address-form').addEventListener('submit', e => {
  e.preventDefault();
  const v = $('#address').value.trim();
  if (!v) return;
  $('#address').blur();
  cmd('tabs.open', v, false).then(() => cmd('tabs.focus'));
});
$('#address').addEventListener('focus', () => $('#address').select());
$('#address').addEventListener('keydown', e => {
  if (e.key === 'Escape') { renderTabs(); $('#address').blur(); cmd('tabs.focus'); }
});

// ---- Clocks: local, Torn City Time (UTC) and the third zone, as in the tools window ----
let clockCfg = null;
const clockFormats = new Map();
function clockFmt(zone, h24, withDate = false) {
  const key = `${zone}|${h24}|${withDate}`;
  if (!clockFormats.has(key)) {
    const opts = withDate
      ? { timeZone: zone, weekday: 'short', year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: !h24, timeZoneName: 'short' }
      : { timeZone: zone, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: !h24 };
    try { clockFormats.set(key, new Intl.DateTimeFormat('en-US', opts)); } catch (e) { clockFormats.set(key, new Intl.DateTimeFormat('en-US', { ...opts, timeZone: 'UTC' })); }
  }
  return clockFormats.get(key);
}
const LOCAL_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;
function renderClocks() {
  const el = $('#clocks');
  const c = clockCfg;
  el.hidden = !c || !c.show;
  if (el.hidden) return;
  const now = new Date();
  const third = c.zone || 'America/New_York';
  const list = [['Local', LOCAL_ZONE, `Your time (${LOCAL_ZONE})`], ['TCT', 'UTC', 'Torn City Time (UTC)']];
  if (c.third) list.push([third === 'UTC' ? 'UTC' : third.split('/').pop().replace(/_/g, ' '), third, third]);
  el.innerHTML = list.map(([label, zone, title], i) => `<div class="clock ${i === 1 ? 'tct' : ''}" title="${esc(`${title}
${clockFmt(zone, c.h24, true).format(now)}`)}"><span class="clock-label">${esc(label)}</span><span class="clock-time">${esc(clockFmt(zone, c.h24).format(now))}</span></div>`).join('');
}
(function clockLoop() {
  renderClocks();
  setTimeout(clockLoop, 1000 - (Date.now() % 1000) + 5);
})();
app.on('clocks', c => { clockCfg = c; renderClocks(); });

app.on('tabs', t => { tabs = t; renderTabs(); });
app.on('focus-address', () => { $('#address').focus(); $('#address').select(); });
cmd('browser.init').then(s => { if (s) { tabs = s.tabs; renderTabs(); if (s.clocks) { clockCfg = s.clocks; renderClocks(); } } });
