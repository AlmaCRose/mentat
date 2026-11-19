'use strict';
/* global pad */
// Small SVG charts: line charts with a crosshair tooltip, and column charts with
// per-bar tooltips. 2px lines, hairline grid, legend for 2+ series.
// Palette (validated for the dark surface): blue, orange, aqua.

const CHART_COLORS = ['#3987e5', '#d95926', '#199e70'];
const SVGNS = 'http://www.w3.org/2000/svg';

function svgEl(tag, attrs = {}) {
  const e = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  return e;
}

// Rounded tick values covering [lo, hi].
function niceTicks(lo, hi, count = 4) {
  if (lo === hi) { hi = lo + 1; lo = Math.max(0, lo - 1); }
  const raw = (hi - lo) / count;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 2.5, 5, 10].map(m => m * mag).find(s => s >= raw) || raw;
  const start = Math.floor(lo / step) * step;
  const ticks = [];
  for (let v = start; v <= hi + step * 0.001; v += step) ticks.push(Math.round(v * 1e6) / 1e6);
  if (ticks[ticks.length - 1] < hi) ticks.push(ticks[ticks.length - 1] + step);
  return ticks;
}

function compactNum(v) {
  const a = Math.abs(v);
  if (a >= 1e9) return `${+(v / 1e9).toFixed(1)}B`;
  if (a >= 1e6) return `${+(v / 1e6).toFixed(1)}M`;
  if (a >= 1e4) return `${+(v / 1e3).toFixed(0)}K`;
  return Math.round(v).toLocaleString('en-US');
}

function timeLabel(t, span) {
  const d = new Date(t);
  if (span > 6 * 86400 * 1000) return `${pad(d.getUTCMonth() + 1)}/${pad(d.getUTCDate())}`;
  if (span > 36 * 3600 * 1000) return `${pad(d.getUTCMonth() + 1)}/${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}
function fullTime(t) {
  const d = new Date(t);
  return `${pad(d.getUTCMonth() + 1)}/${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} TCT`;
}

function makeTooltip(host) {
  const tip = document.createElement('div');
  tip.className = 'chart-tip';
  tip.hidden = true;
  host.appendChild(tip);
  return {
    show(x, y, rows, title) {
      tip.textContent = '';
      if (title) {
        const h = document.createElement('div');
        h.className = 'chart-tip-title';
        h.textContent = title;
        tip.appendChild(h);
      }
      for (const r of rows) {
        const row = document.createElement('div');
        row.className = 'chart-tip-row';
        if (r.color) {
          const key = document.createElement('span');
          key.className = 'chart-key';
          key.style.background = r.color;
          row.appendChild(key);
        }
        const v = document.createElement('b');
        v.textContent = r.value;
        row.appendChild(v);
        if (r.label) {
          const l = document.createElement('span');
          l.className = 'muted';
          l.textContent = ` ${r.label}`;
          row.appendChild(l);
        }
        tip.appendChild(row);
      }
      tip.hidden = false;
      const hw = host.clientWidth;
      const tw = tip.offsetWidth;
      tip.style.left = `${Math.min(Math.max(0, x + 12), hw - tw)}px`;
      tip.style.top = `${Math.max(0, y - 10)}px`;
    },
    hide() { tip.hidden = true; },
  };
}

// series: [{ name, color?, points: [[t, v], ...], step? }]
function lineChart(host, { series, height = 150, yFmt = compactNum, tipFmt = null, yZero = false, empty = 'Not enough data yet' }) {
  host.textContent = '';
  host.classList.add('chart');
  series = series.filter(s => s.points && s.points.length);
  if (!series.length) {
    host.innerHTML = `<div class="chart-empty">${empty}</div>`;
    return;
  }
  series.forEach((s, i) => { s.color = s.color || CHART_COLORS[i % CHART_COLORS.length]; });

  if (series.length > 1) {
    const legend = document.createElement('div');
    legend.className = 'chart-legend';
    for (const s of series) {
      const it = document.createElement('span');
      const key = document.createElement('span');
      key.className = 'chart-key';
      key.style.background = s.dash ? `repeating-linear-gradient(90deg, ${s.color} 0 4px, transparent 4px 7px)` : s.color;
      it.appendChild(key);
      it.appendChild(document.createTextNode(s.name));
      legend.appendChild(it);
    }
    host.appendChild(legend);
  }

  const W = Math.max(200, host.clientWidth || 320);
  const H = height;
  const M = { l: 46, r: 14, t: 10, b: 20 };
  const all = series.flatMap(s => s.points);
  let x0 = Math.min(...all.map(p => p[0])), x1 = Math.max(...all.map(p => p[0]));
  if (x0 === x1) { x0 -= 3600e3; x1 += 60e3; }
  let y0 = Math.min(...all.map(p => p[1])), y1 = Math.max(...all.map(p => p[1]));
  if (yZero) y0 = Math.min(0, y0);
  const ticks = niceTicks(y0, y1);
  y0 = ticks[0];
  y1 = ticks[ticks.length - 1];
  const X = t => M.l + ((t - x0) / (x1 - x0)) * (W - M.l - M.r);
  const Y = v => M.t + (1 - (v - y0) / (y1 - y0 || 1)) * (H - M.t - M.b);

  const svg = svgEl('svg', { width: W, height: H, viewBox: `0 0 ${W} ${H}`, class: 'chart-svg' });
  for (const v of ticks) {
    svg.appendChild(svgEl('line', { x1: M.l, x2: W - M.r, y1: Y(v), y2: Y(v), class: 'chart-grid' }));
    const tx = svgEl('text', { x: M.l - 6, y: Y(v) + 4, class: 'chart-axis', 'text-anchor': 'end' });
    tx.textContent = yFmt(v);
    svg.appendChild(tx);
  }
  const span = x1 - x0;
  for (let i = 0; i <= 3; i++) {
    const t = x0 + (span * i) / 3;
    const tx = svgEl('text', { x: X(t), y: H - 5, class: 'chart-axis', 'text-anchor': i === 0 ? 'start' : i === 3 ? 'end' : 'middle' });
    tx.textContent = timeLabel(t, span);
    svg.appendChild(tx);
  }

  for (const s of series) {
    let d = '';
    s.points.forEach(([t, v], i) => {
      if (i === 0) d += `M${X(t)},${Y(v)}`;
      else if (s.step) d += `H${X(t)}V${Y(v)}`;
      else d += `L${X(t)},${Y(v)}`;
    });
    if (series.length === 1) {
      const last = s.points[s.points.length - 1];
      const area = `${d}L${X(last[0])},${Y(y0)}L${X(s.points[0][0])},${Y(y0)}Z`;
      svg.appendChild(svgEl('path', { d: area, fill: s.color, 'fill-opacity': 0.1, stroke: 'none' }));
    }
    svg.appendChild(svgEl('path', { d, fill: 'none', stroke: s.color, 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': s.dash ? 'butt' : 'round', ...(s.dash ? { 'stroke-dasharray': s.dash } : {}) }));
    const [lt, lv] = s.points[s.points.length - 1];
    svg.appendChild(svgEl('circle', { cx: X(lt), cy: Y(lv), r: 4, fill: s.color, class: 'chart-dot' }));
  }

  const cross = svgEl('line', { y1: M.t, y2: H - M.b, class: 'chart-cross', visibility: 'hidden' });
  svg.appendChild(cross);
  const hit = svgEl('rect', { x: M.l, y: 0, width: W - M.l - M.r, height: H, fill: 'transparent' });
  svg.appendChild(hit);
  host.appendChild(svg);
  const tip = makeTooltip(host);

  // Value of a series at time t (last point at or before t).
  const at = (s, t) => {
    let v = null;
    for (const p of s.points) { if (p[0] <= t) v = p[1]; else break; }
    return v;
  };
  const times = [...new Set(all.map(p => p[0]))].sort((a, b) => a - b);
  hit.addEventListener('pointermove', e => {
    const r = svg.getBoundingClientRect();
    const px = e.clientX - r.left;
    const t = x0 + ((px - M.l) / (W - M.l - M.r)) * span;
    let best = times[0];
    for (const tt of times) if (Math.abs(tt - t) < Math.abs(best - t)) best = tt;
    cross.setAttribute('x1', X(best));
    cross.setAttribute('x2', X(best));
    cross.setAttribute('visibility', 'visible');
    const rows = series.map(s => {
      const v = at(s, best);
      return { color: s.color, value: v === null ? '–' : (tipFmt || yFmt)(v), label: series.length > 1 ? s.name : '' };
    });
    tip.show(X(best), e.clientY - r.top, rows, fullTime(best));
  });
  hit.addEventListener('pointerleave', () => { cross.setAttribute('visibility', 'hidden'); tip.hide(); });
}

// bars: [{ label, value, tip }]
function columnChart(host, { bars, height = 110, color = CHART_COLORS[0], yFmt = compactNum, empty = 'Not enough data yet' }) {
  host.textContent = '';
  host.classList.add('chart');
  if (!bars.length || bars.every(b => !b.value)) {
    host.innerHTML = `<div class="chart-empty">${empty}</div>`;
    return;
  }
  const W = Math.max(200, host.clientWidth || 320);
  const H = height;
  const M = { l: 30, r: 6, t: 8, b: 18 };
  const max = Math.max(...bars.map(b => b.value));
  const ticks = niceTicks(0, max, 3);
  const top = ticks[ticks.length - 1];
  const Y = v => M.t + (1 - v / top) * (H - M.t - M.b);
  const slot = (W - M.l - M.r) / bars.length;
  const bw = Math.min(24, slot - 2);
  const svg = svgEl('svg', { width: W, height: H, viewBox: `0 0 ${W} ${H}`, class: 'chart-svg' });
  for (const v of ticks) {
    svg.appendChild(svgEl('line', { x1: M.l, x2: W - M.r, y1: Y(v), y2: Y(v), class: 'chart-grid' }));
    const tx = svgEl('text', { x: M.l - 5, y: Y(v) + 4, class: 'chart-axis', 'text-anchor': 'end' });
    tx.textContent = yFmt(v);
    svg.appendChild(tx);
  }
  const tip = makeTooltip(host);
  bars.forEach((b, i) => {
    const cx = M.l + slot * i + slot / 2;
    const y = Y(b.value);
    const h = Y(0) - y;
    if (h > 0) {
      const r = Math.min(4, h, bw / 2);
      // Rounded data-end, square at the baseline.
      const x = cx - bw / 2;
      const d = `M${x},${Y(0)}V${y + r}Q${x},${y} ${x + r},${y}H${x + bw - r}Q${x + bw},${y} ${x + bw},${y + r}V${Y(0)}Z`;
      svg.appendChild(svgEl('path', { d, fill: color, class: 'chart-bar' }));
    }
    if (i % Math.ceil(bars.length / 6) === 0) {
      const tx = svgEl('text', { x: cx, y: H - 4, class: 'chart-axis', 'text-anchor': 'middle' });
      tx.textContent = b.label;
      svg.appendChild(tx);
    }
    const hit = svgEl('rect', { x: M.l + slot * i, y: M.t, width: slot, height: H - M.t - M.b, fill: 'transparent' });
    hit.addEventListener('pointermove', e => {
      const rr = svg.getBoundingClientRect();
      tip.show(cx, e.clientY - rr.top, [{ color, value: yFmt(b.value), label: b.tip || '' }], b.label);
    });
    hit.addEventListener('pointerleave', () => tip.hide());
    svg.appendChild(hit);
  });
  host.appendChild(svg);
}
