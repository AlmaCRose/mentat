'use strict';
/* global S, $, panel, esc, cmd, countdown, tct, fmtAgo, renderSafe, syncSettingInputs, popupStyleSettings, prefs */
/* exported restockAlerts, refreshRestockAlerts */
// Custom timer alerts: "alert me N minutes/seconds before <timer>", each with its own sound
// and optional desktop popup.

const ALERT_PRESETS = [
  { timer: 'energy', before: 300, sound: 'softchime', text: 'Energy full · 5 min before' },
  { timer: 'nerve', before: 300, sound: 'marimba', text: 'Nerve full · 5 min before' },
  { timer: 'travel', before: 120, sound: 'harp', text: 'Landing · 2 min before' },
  { timer: 'drug', before: 0, sound: 'doorbell', text: 'Drug cooldown · when it ends' },
  { timer: 'booster', before: 0, sound: 'drop', text: 'Booster cooldown · when it ends' },
  { timer: 'chain', before: 60, sound: 'glass', text: 'Chain · 60 s left' },
  { timer: 'target', before: 60, sound: 'drop', text: 'Any target out · 1 min before' },
  { timer: 'enemy', before: 60, sound: 'drop', text: 'War enemy out · 1 min before' },
  { timer: 'warstart', before: 900, sound: 'doorbell', text: 'Ranked war · 15 min before start' },
  { timer: 'reset', before: 600, sound: 'pad', text: 'Daily reset · 10 min before' },
];

// Seconds -> [number, unit] for the editors: whole minutes show as minutes.
const splitBefore = sec => (sec && sec % 60 === 0 ? [sec / 60, 'min'] : sec && sec < 60 ? [sec, 'sec'] : sec ? [sec, 'sec'] : [0, 'min']);
const beforeText = sec => {
  if (!sec) return 'when it ends';
  if (sec % 60 === 0) return `${sec / 60} min before`;
  return sec < 60 ? `${sec} s before` : `${Math.floor(sec / 60)} min ${sec % 60} s before`;
};

// "<item> in <country>" for an abroad item key, from the alerts snapshot.
function abroadName(a, key) {
  const x = (a.abroad || []).find(i => i.key === key);
  return x ? `${x.name} in ${x.country}` : key;
}
function alertTimerLabel(a, rule) {
  const label = (a.timers || {})[rule.timer] || rule.timer;
  if (rule.item) return `${{ restock: 'Restock', restockleave: 'Leave for restock', restocked: 'Restock seen' }[rule.timer] || label}: ${abroadName(a, rule.item)}`;
  if (rule.timer !== 'target') return label;
  if (!rule.target) return 'Any target out of hospital / jail';
  const t = (a.targets || []).find(x => x.id === rule.target);
  return `${t ? t.name : '#' + rule.target} out of hospital / jail`;
}

function soundOptions(a, sel) {
  const short = l => l.replace(/^Classic (.)/, (_, c) => c.toUpperCase());
  const opt = ([k, l]) => `<option value="${k}" ${k === sel ? 'selected' : ''}>${esc(short(l))}</option>`;
  const all = Object.entries(a.sounds || {});
  const soft = all.filter(([k, l]) => !/^Classic /.test(l) && k !== 'none');
  const classic = all.filter(([, l]) => /^Classic /.test(l));
  return `<optgroup label="Soft">${soft.map(opt).join('')}</optgroup><optgroup label="Classic beeps">${classic.map(opt).join('')}</optgroup><option value="none" ${sel === 'none' ? 'selected' : ''}>No sound</option>`;
}

function renderAlerts() {
  const el = panel('alerts');
  if (!el) return;
  const a = S.features.alerts;
  if (!a) { el.innerHTML = '<div class="empty">Loading…</div>'; return; }
  const draft = Object.assign({ timer: 'energy', n: 5, unit: 'min', sound: 'softchime', desktop: true, urgent: false, target: 0, item: '' }, S.alertDraft || {});
  const itemTimer = (a.itemTimers || []).includes(draft.timer);
  const timers = Object.entries(a.timers || {});
  const next = id => a.upcoming.find(u => u.rule === id);
  el.innerHTML = `
  <div>
    <h3>Custom alerts</h3>
    <div class="note">A sound and/or a desktop popup a set time before any timer ends: 5 minutes before energy is full, 7 before nerve, 60 seconds before the chain drops… Uses timers the app already tracks, so no extra API requests. Alerts go off while the app is running (closing the window keeps it running in the tray), and only for timers it saw counting down, so opening the app never sets off a burst of them.</div>

    <form id="alert-add" class="alert-form">
      <span>Alert me</span>
      <input type="number" name="n" min="0" max="1440" step="1" value="${esc(draft.n)}" style="width:64px" title="0 = when it ends">
      <select name="unit"><option value="min" ${draft.unit === 'min' ? 'selected' : ''}>minutes</option><option value="sec" ${draft.unit === 'sec' ? 'selected' : ''}>seconds</option></select>
      <span>before</span>
      <select name="timer">${timers.map(([k, l]) => `<option value="${k}" ${k === draft.timer ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>
      <select name="item" ${itemTimer ? '' : 'hidden'} title="Abroad item">${(a.abroad || []).length ? (a.abroad || []).map(i => `<option value="${i.key}" ${i.key === draft.item ? 'selected' : ''}>${esc(i.name)} (${esc(i.country)})</option>`).join('') : '<option value="">No abroad stock data yet</option>'}</select>
      <select name="target" ${draft.timer === 'target' ? '' : 'hidden'}><option value="0">Any target</option>${(a.targets || []).map(t => `<option value="${t.id}" ${t.id === Number(draft.target) ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}</select>
      <span>with</span>
      <select name="sound">${soundOptions(a, draft.sound)}</select>
      <button type="button" class="icon-btn" data-alert-preview title="Play this sound">&#9654;</button>
      <label class="row small"><input type="checkbox" name="desktop" ${draft.desktop ? 'checked' : ''}> popup</label>
      <label class="row small" title="A large popup in the middle of the screen that stays until you dismiss or snooze it, its sound repeating"><input type="checkbox" name="urgent" ${draft.urgent ? 'checked' : ''}> urgent</label>
      <button class="primary">Add alert</button>
    </form>
    <div class="chips"><span class="muted small">0 = when it ends. Quick add:</span>${ALERT_PRESETS.map((p, i) => `<button type="button" data-alert-preset="${i}">${esc(p.text)}</button>`).join('')}</div>

    <h3>Your alerts (${a.rules.length})</h3>
    ${a.rules.length ? `<div class="table-wrap"><table class="data alerts-table">
      <tr><th>On</th><th>Alert</th><th>When</th><th>Sound</th><th>Popup</th><th title="Large popup in the middle of the screen that stays until dismissed">Urgent</th><th class="num">Next</th><th></th></tr>
      ${a.rules.map(r => {
        const [n, unit] = splitBefore(r.before);
        const nx = next(r.id);
        return `<tr class="${r.enabled ? '' : 'dim'}">
          <td><input type="checkbox" data-alert-field="enabled" data-alert-id="${r.id}" ${r.enabled ? 'checked' : ''} title="On / off"></td>
          <td>${esc(alertTimerLabel(a, r))}</td>
          <td class="nowrap">${r.timer === 'restocked' ? '<span class="muted small">when seen</span>' : `<input type="number" min="0" max="1440" step="1" value="${n}" style="width:56px" data-alert-field="n" data-alert-id="${r.id}">`}
            ${r.timer === 'restocked' ? '' : `<select data-alert-field="unit" data-alert-id="${r.id}"><option value="min" ${unit === 'min' ? 'selected' : ''}>min</option><option value="sec" ${unit === 'sec' ? 'selected' : ''}>sec</option></select>
            <span class="muted small">${r.before ? 'before' : '(when it ends)'}</span>`}</td>
          <td><select data-alert-field="sound" data-alert-id="${r.id}">${soundOptions(a, r.sound)}</select></td>
          <td><input type="checkbox" data-alert-field="desktop" data-alert-id="${r.id}" ${r.desktop ? 'checked' : ''}></td>
          <td><input type="checkbox" data-alert-field="urgent" data-alert-id="${r.id}" ${r.urgent ? 'checked' : ''} title="Middle of the screen, stays until dismissed"></td>
          <td class="num">${!r.enabled ? '<span class="muted">off</span>' : nx ? `${countdown(nx.fireAt, 'now')}<div class="muted small">${tct(nx.fireAt)} TCT${nx.name ? ' · ' + esc(nx.name) : ''}</div>` : '<span class="muted small">no timer running</span>'}</td>
          <td class="nowrap"><button data-alert-test="${r.id}" title="Play the sound and show the popup now">Test</button> <button class="danger" data-alert-remove="${r.id}" title="Delete">&times;</button></td>
        </tr>`;
      }).join('')}
    </table></div>` : '<div class="empty">No custom alerts yet. Add one above or pick a quick add.</div>'}

    <div class="cols2" style="margin-top:12px">
      <div>
        <h3>Coming up</h3>
        ${a.upcoming.length ? `<table class="data">${a.upcoming.slice(0, 12).map(u => {
          const r = a.rules.find(x => x.id === u.rule);
          const label = !r ? u.timer : u.timer === 'target' || u.timer === 'enemy' ? `${u.name || 'Target'} out of hospital / jail` : alertTimerLabel(a, r);
          return `<tr><td>${esc(label)}<div class="muted small">${esc(r ? beforeText(r.before) : '')}</div></td><td class="num">${countdown(u.fireAt, 'now')}<div class="muted small">${tct(u.fireAt)} TCT</div></td></tr>`;
        }).join('')}</table>` : '<div class="muted small">Nothing scheduled right now.</div>'}
      </div>
      <div>
        <h3>Recently fired</h3>
        ${a.recent.length ? `<table class="data">${a.recent.slice(0, 8).map(f => `<tr><td>${esc(f.title)}</td><td class="num muted small">${fmtAgo(f.at)}</td></tr>`).join('')}</table>` : '<div class="muted small">None since the app started.</div>'}
        <div class="setting" style="margin-top:10px"><label>Alert volume</label><input type="range" min="0" max="1" step="0.05" data-set="alerts.volume" data-num></div>
        ${popupStyleSettings()}
        <div class="note">The built-in "when it's done" popups (energy full, landed, …) and which of them are urgent are in Settings → Notifications.</div>
      </div>
    </div>
  </div>`;
  syncSettingInputs();
}

function initAlerts() {
  const el = panel('alerts');
  const readForm = f => ({
    timer: f.timer.value, n: Number(f.n.value) || 0, unit: f.unit.value, sound: f.sound.value,
    desktop: f.desktop.checked, urgent: f.urgent.checked, target: Number(f.target.value) || 0, item: f.item.value,
  });
  const toSec = (n, unit) => Math.max(0, Math.round(Number(n) || 0) * (unit === 'min' ? 60 : 1));
  el.addEventListener('submit', e => {
    const f = e.target.closest('#alert-add');
    if (!f) return;
    e.preventDefault();
    const d = readForm(f);
    S.alertDraft = d;
    cmd('alerts.add', { timer: d.timer, before: toSec(d.n, d.unit), sound: d.sound, desktop: d.desktop, urgent: d.urgent, target: d.target, item: d.item }).catch(err => alert(err.message));
  });
  el.addEventListener('change', e => {
    const t = e.target;
    const f = t.closest('#alert-add');
    if (f) {
      S.alertDraft = readForm(f);
      if (t.name === 'timer') renderAlerts();
      return;
    }
    const id = t.dataset.alertId;
    if (!id) return;
    const field = t.dataset.alertField;
    if (field === 'n' || field === 'unit') {
      const row = t.closest('tr');
      const n = row.querySelector('[data-alert-field="n"]').value;
      const unit = row.querySelector('[data-alert-field="unit"]').value;
      cmd('alerts.update', id, { before: toSec(n, unit) });
    } else if (field === 'sound') {
      cmd('alerts.update', id, { sound: t.value });
      cmd('alerts.preview', t.value);
    } else {
      cmd('alerts.update', id, { [field]: t.checked });
    }
  });
  el.addEventListener('click', e => {
    const t = e.target;
    if (t.closest('[data-alert-preview]')) { cmd('alerts.preview', $('#alert-add').sound.value); return; }
    const p = t.closest('[data-alert-preset]');
    if (p) {
      const pr = ALERT_PRESETS[Number(p.dataset.alertPreset)];
      cmd('alerts.add', { timer: pr.timer, before: pr.before, sound: pr.sound, desktop: true }).catch(err => alert(err.message));
      return;
    }
    const test = t.closest('[data-alert-test]');
    if (test) { cmd('alerts.test', test.dataset.alertTest); return; }
    const rm = t.closest('[data-alert-remove]');
    if (rm) cmd('alerts.remove', rm.dataset.alertRemove);
  });
}

// ---- Restock alerts for one abroad item ----
// A small "Restock alerts" box wherever one item's abroad stock is shown (Travel → Abroad items,
// trip details, the item pop-up). Quick adds create ordinary custom alerts (timer restock /
// restockleave / restocked with item "<country>:<id>"), so sound, timing and urgency can be changed
// in the Alerts tab like any other.
const RA_QUICK = [
  { timer: 'restocked', before: 0, text: 'When a restock shows up in the stock data' },
  { timer: 'restock', before: 300, text: '5 min before the predicted restock' },
  { timer: 'restockleave', before: 300, text: '5 min before it\'s time to leave' },
  { timer: 'restockleave', before: 0, text: 'When it\'s time to leave (to land just after it)' },
];
let raOpen = '';
function raRuleText(r) {
  if (r.timer === 'restocked') return 'When a restock shows up';
  const b = beforeText(r.before).replace('when it ends', 'at the time');
  return r.timer === 'restock' ? `Predicted restock · ${b}` : `Time to leave · ${b}`;
}
function restockAlerts(key, label = '') {
  const a = S.features.alerts;
  if (!a || !/^[a-z]{3}:\d+$/.test(key)) return '';
  const mine = (a.rules || []).filter(r => r.item === key);
  const has = new Set(mine.map(r => `${r.timer}|${r.before}`));
  return `<details class="ra" data-ra="${key}" ${raOpen === key ? 'open' : ''}>
    <summary>Restock alerts${mine.length ? ` <span class="pill ok">${mine.length}</span>` : ''}</summary>
    <div class="ra-body">
      ${label ? `<div class="ra-title">${esc(label)}</div>` : ''}
      ${mine.length ? `<ul class="ra-list">${mine.map(r => `<li class="${r.enabled ? '' : 'dim'}"><span>${esc(raRuleText(r))}</span>
        <span class="row"><label class="small row" title="Urgent: a large popup in the middle of the screen that stays until you dismiss or snooze it"><input type="checkbox" data-ra-urg="${r.id}" ${r.urgent ? 'checked' : ''}> urgent</label><button class="icon-btn danger" data-ra-rm="${r.id}" title="Delete this alert">&times;</button></span></li>`).join('')}</ul>` : ''}
      ${RA_QUICK.some(q => !has.has(`${q.timer}|${q.before}`)) ? `<label class="row small"><input type="checkbox" data-ra-urgent ${prefs.get('alerts.raUrgent', false) ? 'checked' : ''}> Add as urgent popups (middle of the screen)</label>
      <div class="ra-adds">${RA_QUICK.map((q, i) => has.has(`${q.timer}|${q.before}`) ? '' : `<button type="button" data-ra-add="${i}">+ ${esc(q.text)}</button>`).join('')}</div>` : ''}
      <div class="note">While a restock alert is on, Mentat reads YATA's stock every 10 seconds (one request covers every item). Predictions come from the restock rhythm learned for this item; "time to leave" uses Travel's flight method. Sounds and timing: Alerts tab.</div>
    </div></details>`;
}
// Redraw every restock box on the page (after alerts change), keeping open ones open.
function refreshRestockAlerts() {
  for (const d of document.querySelectorAll('details.ra[data-ra]')) {
    const label = (d.querySelector('.ra-title') || {}).textContent || '';
    d.outerHTML = restockAlerts(d.dataset.ra, label);
  }
}
document.addEventListener('toggle', e => {
  const d = e.target;
  if (d.matches && d.matches('details.ra')) raOpen = d.open ? d.dataset.ra : raOpen === d.dataset.ra ? '' : raOpen;
}, true);
document.addEventListener('change', e => {
  const t = e.target;
  if (!t.matches) return;
  if (t.matches('[data-ra-urgent]')) prefs.set('alerts.raUrgent', t.checked);
  else if (t.matches('[data-ra-urg]')) cmd('alerts.update', t.dataset.raUrg, { urgent: t.checked });
});
document.addEventListener('click', e => {
  const add = e.target.closest('[data-ra-add]');
  const rm = e.target.closest('[data-ra-rm]');
  if (!add && !rm) return;
  e.preventDefault();
  e.stopPropagation();
  if (rm) { cmd('alerts.remove', rm.dataset.raRm); return; }
  const box = add.closest('[data-ra]');
  const q = RA_QUICK[Number(add.dataset.raAdd)];
  add.disabled = true;
  cmd('alerts.add', { timer: q.timer, before: q.before, item: box.dataset.ra, sound: 'doorbell', desktop: true, urgent: prefs.get('alerts.raUrgent', false) })
    .catch(err => { add.disabled = false; alert(err.message); });
}, true);
