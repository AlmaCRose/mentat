'use strict';
/* global S, $, panel, esc, cmd, countdown, tct, fmtAgo, renderSafe, syncSettingInputs, popupStyleSettings */
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

function alertTimerLabel(a, rule) {
  const label = (a.timers || {})[rule.timer] || rule.timer;
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
  const draft = Object.assign({ timer: 'energy', n: 5, unit: 'min', sound: 'softchime', desktop: true, target: 0 }, S.alertDraft || {});
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
      <select name="target" ${draft.timer === 'target' ? '' : 'hidden'}><option value="0">Any target</option>${(a.targets || []).map(t => `<option value="${t.id}" ${t.id === Number(draft.target) ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}</select>
      <span>with</span>
      <select name="sound">${soundOptions(a, draft.sound)}</select>
      <button type="button" class="icon-btn" data-alert-preview title="Play this sound">&#9654;</button>
      <label class="row small"><input type="checkbox" name="desktop" ${draft.desktop ? 'checked' : ''}> popup</label>
      <button class="primary">Add alert</button>
    </form>
    <div class="chips"><span class="muted small">0 = when it ends. Quick add:</span>${ALERT_PRESETS.map((p, i) => `<button type="button" data-alert-preset="${i}">${esc(p.text)}</button>`).join('')}</div>

    <h3>Your alerts (${a.rules.length})</h3>
    ${a.rules.length ? `<div class="table-wrap"><table class="data alerts-table">
      <tr><th>On</th><th>Alert</th><th>When</th><th>Sound</th><th>Popup</th><th class="num">Next</th><th></th></tr>
      ${a.rules.map(r => {
        const [n, unit] = splitBefore(r.before);
        const nx = next(r.id);
        return `<tr class="${r.enabled ? '' : 'dim'}">
          <td><input type="checkbox" data-alert-field="enabled" data-alert-id="${r.id}" ${r.enabled ? 'checked' : ''} title="On / off"></td>
          <td>${esc(alertTimerLabel(a, r))}</td>
          <td class="nowrap"><input type="number" min="0" max="1440" step="1" value="${n}" style="width:56px" data-alert-field="n" data-alert-id="${r.id}">
            <select data-alert-field="unit" data-alert-id="${r.id}"><option value="min" ${unit === 'min' ? 'selected' : ''}>min</option><option value="sec" ${unit === 'sec' ? 'selected' : ''}>sec</option></select>
            <span class="muted small">${r.before ? 'before' : '(when it ends)'}</span></td>
          <td><select data-alert-field="sound" data-alert-id="${r.id}">${soundOptions(a, r.sound)}</select></td>
          <td><input type="checkbox" data-alert-field="desktop" data-alert-id="${r.id}" ${r.desktop ? 'checked' : ''}></td>
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
        <div class="note">The built-in "when it's done" popups (energy full, landed, …) are in Settings → Desktop notifications.</div>
      </div>
    </div>
  </div>`;
  syncSettingInputs();
}

function initAlerts() {
  const el = panel('alerts');
  const readForm = f => ({
    timer: f.timer.value, n: Number(f.n.value) || 0, unit: f.unit.value, sound: f.sound.value,
    desktop: f.desktop.checked, target: Number(f.target.value) || 0,
  });
  const toSec = (n, unit) => Math.max(0, Math.round(Number(n) || 0) * (unit === 'min' ? 60 : 1));
  el.addEventListener('submit', e => {
    const f = e.target.closest('#alert-add');
    if (!f) return;
    e.preventDefault();
    const d = readForm(f);
    S.alertDraft = d;
    cmd('alerts.add', { timer: d.timer, before: toSec(d.n, d.unit), sound: d.sound, desktop: d.desktop, target: d.target }).catch(err => alert(err.message));
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
