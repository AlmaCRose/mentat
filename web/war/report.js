'use strict';
// The shared war report page (server/warpage.js): side tabs, sortable tables, the "members with
// no hits" switch, and the charts, drawn from the data in the page. Makes no network requests.
(function () {
  const body = document.body;
  body.classList.remove('nojs');
  body.classList.add('js');
  let data = {};
  try { data = JSON.parse(document.getElementById('wr-data').textContent); } catch (e) { /* no charts */ }

  // ---- Tabs ----
  const tabs = [...document.querySelectorAll('nav.tabs a[data-tab]')];
  const secs = [...document.querySelectorAll('section.sec')];
  // Bring the active tab into view inside its own list only (scrollIntoView would also scroll the
  // page, hiding the title and its buttons).
  function reveal(a) {
    const box = a.closest('.navlist') || a.closest('nav');
    if (!box) return;
    if (box.scrollHeight > box.clientHeight + 1) {
      const top = a.offsetTop, bottom = top + a.offsetHeight;
      if (top < box.scrollTop || bottom > box.scrollTop + box.clientHeight) box.scrollTop = Math.max(0, top - box.clientHeight / 2 + a.offsetHeight / 2);
    }
    if (box.scrollWidth > box.clientWidth + 1) {
      const left = a.offsetLeft, right = left + a.offsetWidth;
      if (left < box.scrollLeft || right > box.scrollLeft + box.clientWidth) box.scrollLeft = Math.max(0, left - box.clientWidth / 2 + a.offsetWidth / 2);
    }
  }
  function show(id, push) {
    const tabOf = s => s.dataset.tab || s.id;
    if (!secs.some(s => tabOf(s) === id)) id = secs[0] && tabOf(secs[0]);
    for (const s of secs) s.classList.toggle('on', tabOf(s) === id);
    for (const a of tabs) {
      const on = a.dataset.tab === id;
      a.classList.toggle('on', on);
      if (on) { a.setAttribute('aria-current', 'true'); reveal(a); } else a.removeAttribute('aria-current');
    }
    if (push) try { history.replaceState(null, '', `#${id}`); } catch (e) { /* file:// */ }
    drawCharts();
  }
  for (const a of tabs) a.addEventListener('click', e => { e.preventDefault(); show(a.dataset.tab, true); window.scrollTo({ top: 0 }); });
  // Links to a member's file from other pages land on it (…/members#m-<id>)
  window.addEventListener('hashchange', () => show(location.hash.slice(1), false));

  // ---- Tables ----
  // Alternating rows among the rows on show (sorting, filters and hidden rows keep it even)
  function stripe(table) {
    let n = 0;
    for (const r of table.tBodies[0] ? table.tBodies[0].rows : []) {
      const shown = getComputedStyle(r).display !== 'none';
      r.classList.toggle('alt', shown && n++ % 2 === 1);
    }
  }
  const stripeAll = () => { for (const t of document.querySelectorAll('table.data, table.ir-t')) stripe(t); };
  for (const th of document.querySelectorAll('table.sortable th.sort')) {
    const sortBy = () => {
      const table = th.closest('table');
      const col = Number(th.dataset.col);
      const text = th.dataset.kind === 'text';
      const cur = th.getAttribute('aria-sort');
      const dir = cur ? (cur === 'descending' ? 'ascending' : 'descending') : (text || th.dataset.kind === 'rank' ? 'ascending' : 'descending');
      for (const o of table.querySelectorAll('th.sort')) o.removeAttribute('aria-sort');
      th.setAttribute('aria-sort', dir);
      const tb = table.tBodies[0];
      const key = tr => { const v = tr.cells[col].dataset.k; return text ? v : Number(v); };
      const rows = [...tb.rows].sort((a, b) => {
        const x = key(a), y = key(b);
        const c = text ? String(x).localeCompare(String(y)) : x - y;
        return dir === 'ascending' ? c : -c;
      });
      for (const r of rows) tb.appendChild(r);
      stripe(table);
    };
    th.addEventListener('click', sortBy);
    th.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); sortBy(); } });
  }
  for (const box of document.querySelectorAll('[data-show-zero]')) box.addEventListener('change', () => { body.classList.toggle('showzero', box.checked); stripeAll(); });

  // Member dossiers: find a member in the side list (name or ID)
  for (const find of document.querySelectorAll('nav.tabs .navfind')) {
    find.addEventListener('input', () => {
      const words = find.value.toLowerCase().split(/\s+/).filter(Boolean);
      const nav = find.closest('nav');
      for (const a of nav.querySelectorAll('a[data-tab]')) {
        const t = `${a.textContent} ${a.dataset.tab.replace('m-', '')}`.toLowerCase();
        a.hidden = !words.every(w => t.includes(w));
      }
      for (const g of nav.querySelectorAll('.grp')) {
        let n = g.nextElementSibling, any = false;
        while (n && !n.classList.contains('grp')) { if (n.matches('a[data-tab]') && !n.hidden) any = true; n = n.nextElementSibling; }
        g.hidden = !any;
      }
    });
    find.addEventListener('keydown', e => {
      if (e.key !== 'Enter') return;
      const first = [...find.closest('nav').querySelectorAll('a[data-tab]')].find(a => !a.hidden);
      if (first) { e.preventDefault(); show(first.dataset.tab, true); }
    });
  }

  // The intelligence report's tables (src/ui/intel.js): sort by a column heading, filter by text.
  document.addEventListener('click', e => {
    const th = e.target.closest('table.ir-t th[data-k]');
    if (!th) return;
    const table = th.closest('table');
    const idx = [...th.parentNode.children].indexOf(th);
    const dir = th.classList.contains('desc') ? 1 : th.classList.contains('asc') ? -1 : (th.getAttribute('data-k') === 'text' ? 1 : -1);
    table.querySelectorAll('th').forEach(x => x.classList.remove('asc', 'desc'));
    th.classList.add(dir === 1 ? 'asc' : 'desc');
    const val = td => {
      const v = td.getAttribute('data-v');
      if (v !== null && v !== '' && !isNaN(Number(v))) return Number(v);
      if (v === '') return null;
      return (v !== null ? v : td.textContent).trim().toLowerCase();
    };
    const tb = table.tBodies[0];
    const rows = [...tb.rows].sort((a, b) => {
      const x = val(a.cells[idx]), y = val(b.cells[idx]);
      if (x === null && y === null) return 0;
      if (x === null) return 1;
      if (y === null) return -1;
      return (x < y ? -1 : x > y ? 1 : 0) * dir;
    });
    for (const r of rows) tb.appendChild(r);
    stripe(table);
  });
  document.addEventListener('input', e => {
    const f = e.target.closest('.ir-filter');
    if (!f) return;
    const table = document.getElementById(f.getAttribute('data-for'));
    if (!table) return;
    const words = f.value.toLowerCase().split(/\s+/).filter(Boolean);
    let shown = 0;
    for (const r of table.tBodies[0].rows) {
      const ok = words.every(w => r.textContent.toLowerCase().includes(w));
      r.style.display = ok ? '' : 'none';
      if (ok) shown++;
    }
    const c = document.querySelector(`[data-count-for="${f.getAttribute('data-for')}"]`);
    stripe(table);
    if (c) c.textContent = words.length ? `${shown} of ${table.tBodies[0].rows.length} rows` : '';
  });

  // ---- Charts ----
  const NS = 'http://www.w3.org/2000/svg';
  const el = (name, attrs, parent) => {
    const e = document.createElementNS(NS, name);
    for (const [k, v] of Object.entries(attrs || {})) e.setAttribute(k, v);
    if (parent) parent.appendChild(e);
    return e;
  };
  const fmt = n => Math.round(n).toLocaleString('en-US');
  const two = n => String(n).padStart(2, '0');
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const clock = t => { const d = new Date(t); return `${two(d.getUTCHours())}:${two(d.getUTCMinutes())}`; };
  const day = t => { const d = new Date(t); return `${MON[d.getUTCMonth()]} ${d.getUTCDate()}`; };
  function niceMax(v, ticks = 4) {
    if (v <= 0) return { max: ticks, step: 1 };
    const raw = v / ticks;
    const mag = 10 ** Math.floor(Math.log10(raw));
    const step = [1, 2, 2.5, 5, 10].map(x => x * mag).find(x => x >= raw);
    return { max: Math.ceil(v / step) * step, step };
  }
  function tipFor(box) {
    let t = box.querySelector('.tip');
    if (!t) { t = document.createElement('div'); t.className = 'tip'; t.hidden = true; box.appendChild(t); }
    return t;
  }
  // rows: [[label, value, cssVar]] -> tooltip content, values first and strong
  function fillTip(tip, title, rows) {
    tip.textContent = '';
    const h = document.createElement('div');
    h.className = 'muted small';
    h.textContent = title;
    tip.appendChild(h);
    for (const [label, value, color] of rows) {
      const r = document.createElement('div');
      if (color) { const k = document.createElement('span'); k.className = 'k'; k.style.background = `var(${color})`; r.appendChild(k); }
      const b = document.createElement('b');
      b.textContent = value;
      r.appendChild(b);
      r.appendChild(document.createTextNode(` ${label}`));
      tip.appendChild(r);
    }
  }
  function placeTip(box, tip, x, y) {
    tip.hidden = false;
    const w = tip.offsetWidth, bw = box.clientWidth;
    tip.style.left = `${Math.max(0, Math.min(bw - w, x + 14 > bw - w ? x - w - 14 : x + 14))}px`;
    tip.style.top = `${Math.max(0, y - tip.offsetHeight - 10)}px`;
  }

  // Time axis ticks every 2/3/4/6/12/24 h, labelled with the clock, and the date at midnight.
  function timeTicks(t0, t1, width) {
    const hours = (t1 - t0) / 3600e3;
    const every = [1, 2, 3, 4, 6, 12, 24, 48].find(h => (hours / h) * 70 <= width) || 48;
    const out = [];
    let t = Math.ceil(t0 / (every * 3600e3)) * every * 3600e3;
    for (; t <= t1; t += every * 3600e3) out.push(t);
    return out;
  }

  function scoreChart(box) {
    const line = data.line;
    const W = box.clientWidth;
    if (!line || !W) return;
    const H = W < 500 ? 220 : 280;
    const pad = { l: 52, r: W < 500 ? 70 : 110, t: 12, b: 28 };
    const t0 = data.start || line[0][0], t1 = Math.max(line[line.length - 1][0], data.end || 0);
    const top = Math.max(...line.map(p => Math.max(p[1], p[2])));
    const { max, step } = niceMax(top);
    const x = t => pad.l + ((t - t0) / Math.max(1, t1 - t0)) * (W - pad.l - pad.r);
    const y = v => pad.t + (1 - v / max) * (H - pad.t - pad.b);
    box.textContent = '';
    const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, height: H }, box);
    for (let v = 0; v <= max; v += step) {
      el('line', { class: v ? 'gridl' : 'axis', x1: pad.l, x2: W - pad.r, y1: y(v), y2: y(v) }, svg);
      el('text', { x: pad.l - 8, y: y(v) + 4, 'text-anchor': 'end' }, svg).textContent = fmt(v);
    }
    let lastDay = '';
    for (const t of timeTicks(t0, t1, W - pad.l - pad.r)) {
      const d = day(t);
      el('text', { x: x(t), y: H - 8, 'text-anchor': 'middle' }, svg).textContent = d !== lastDay && new Date(t).getUTCHours() === 0 ? d : clock(t);
      lastDay = d;
    }
    // Step lines: the score holds until the next reading.
    const path = k => line.map((p, i) => `${i ? `H${x(p[0]).toFixed(1)}V` : `M${x(p[0]).toFixed(1)},`}${y(p[k]).toFixed(1)}`).join('');
    el('path', { class: 'lthem', d: path(2) }, svg);
    el('path', { class: 'lus', d: path(1) }, svg);
    // Direct labels at the end of each line (nudged apart when close)
    const last = line[line.length - 1];
    let yu = y(last[1]), yt = y(last[2]);
    if (Math.abs(yu - yt) < 16) { if (yu <= yt) { yu -= 8; yt += 8; } else { yu += 8; yt -= 8; } }
    const ex = x(last[0]) + 8;
    const short = s => (W < 500 && s.length > 9 ? `${s.slice(0, 8)}…` : s.length > 16 ? `${s.slice(0, 15)}…` : s);
    el('text', { class: 'lab', x: ex, y: yu + 4 }, svg).textContent = short(data.us);
    el('text', { class: 'lab', x: ex, y: yt + 4 }, svg).textContent = short(data.them);
    // Crosshair + tooltip
    const xh = el('line', { class: 'xh', y1: pad.t, y2: H - pad.b, visibility: 'hidden' }, svg);
    const du = el('circle', { class: 'dot bus', r: 4, visibility: 'hidden' }, svg);
    const dt = el('circle', { class: 'dot bthem', r: 4, visibility: 'hidden' }, svg);
    const hit = el('rect', { class: 'hit', x: pad.l, y: 0, width: W - pad.l - pad.r, height: H, tabindex: 0 }, svg);
    const tip = tipFor(box);
    let idx = line.length - 1;
    const at = i => {
      idx = Math.max(0, Math.min(line.length - 1, i));
      const p = line[idx];
      const px = x(p[0]);
      for (const n of [xh, du, dt]) n.setAttribute('visibility', 'visible');
      xh.setAttribute('x1', px); xh.setAttribute('x2', px);
      du.setAttribute('cx', px); du.setAttribute('cy', y(p[1]));
      dt.setAttribute('cx', px); dt.setAttribute('cy', y(p[2]));
      const lead = p[1] - p[2];
      fillTip(tip, `${day(p[0])} ${clock(p[0])} TCT`, [[data.us, fmt(p[1]), '--us'], [data.them, fmt(p[2]), '--them'], [lead >= 0 ? 'our lead' : 'behind', fmt(Math.abs(lead)), '']]);
      placeTip(box, tip, px, Math.min(y(p[1]), y(p[2])));
    };
    const nearest = px => {
      const t = t0 + ((px - pad.l) / (W - pad.l - pad.r)) * (t1 - t0);
      let lo = 0, hi = line.length - 1;
      while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (line[mid][0] <= t) lo = mid; else hi = mid - 1; }
      return lo;
    };
    const hide = () => { tip.hidden = true; for (const n of [xh, du, dt]) n.setAttribute('visibility', 'hidden'); };
    hit.addEventListener('pointermove', e => { const r = svg.getBoundingClientRect(); at(nearest(e.clientX - r.left)); });
    hit.addEventListener('pointerleave', hide);
    hit.addEventListener('focus', () => at(idx));
    hit.addEventListener('blur', hide);
    hit.addEventListener('keydown', e => {
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.preventDefault(); at(idx + (e.key === 'ArrowLeft' ? -1 : 1) * Math.max(1, Math.round(line.length / 50))); }
    });
  }

  // Grouped bars, one pair per hour of the war. rows: [[ours, theirs]] per hour.
  function barChart(box, rows, labels) {
    const W = box.clientWidth;
    if (!rows || !rows.length || !W) return;
    const H = W < 500 ? 190 : 230;
    const pad = { l: 46, r: 8, t: 10, b: 28 };
    const top = Math.max(1, ...rows.flat());
    const { max, step } = niceMax(top);
    const band = (W - pad.l - pad.r) / rows.length;
    const gap = 2;
    const bw = Math.max(1, Math.min(18, (band - 4) / 2 - gap / 2));
    const y = v => pad.t + (1 - v / max) * (H - pad.t - pad.b);
    box.textContent = '';
    const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, height: H }, box);
    for (let v = 0; v <= max; v += step) {
      el('line', { class: v ? 'gridl' : 'axis', x1: pad.l, x2: W - pad.r, y1: y(v), y2: y(v) }, svg);
      el('text', { x: pad.l - 8, y: y(v) + 4, 'text-anchor': 'end' }, svg).textContent = fmt(v);
    }
    const every = Math.max(1, Math.ceil(rows.length / Math.max(1, Math.floor((W - pad.l - pad.r) / 56))));
    const bar = (x0, v, cls) => {
      if (v <= 0) return;
      const yt = y(v), yb = y(0), r = Math.min(4, bw / 2, yb - yt);
      el('path', { class: cls, d: `M${x0},${yb}V${yt + r}Q${x0},${yt} ${x0 + r},${yt}H${x0 + bw - r}Q${x0 + bw},${yt} ${x0 + bw},${yt + r}V${yb}Z` }, svg);
    };
    const tip = tipFor(box);
    rows.forEach((r, i) => {
      const cx = pad.l + band * i + band / 2;
      bar(cx - gap / 2 - bw, r[0], 'bus');
      bar(cx + gap / 2, r[1], 'bthem');
      if (i % every === 0) el('text', { x: cx, y: H - 8, 'text-anchor': 'middle' }, svg).textContent = labels.short(i);
    });
    rows.forEach((r, i) => {
      const hitR = el('rect', { class: 'hit', x: pad.l + band * i, y: pad.t, width: band, height: H - pad.t - pad.b, tabindex: 0 }, svg);
      const on = () => {
        hitR.style.fill = 'var(--grid)'; hitR.style.opacity = '0.35';
        fillTip(tip, labels.long(i), [[labels.us, fmt(r[0]), '--us'], [labels.them, fmt(r[1]), '--them']]);
        placeTip(box, tip, pad.l + band * i + band / 2, y(Math.max(r[0], r[1])));
      };
      const off = () => { hitR.style.fill = ''; hitR.style.opacity = ''; tip.hidden = true; };
      hitR.addEventListener('pointerenter', on);
      hitR.addEventListener('pointerleave', off);
      hitR.addEventListener('focus', on);
      hitR.addEventListener('blur', off);
    });
  }

  // Score gained in each hour of the war, from the score readings (the score holds between them).
  function hourly() {
    const line = data.line;
    if (!line || line.length < 2) return null;
    const t0 = data.start || line[0][0];
    const t1 = Math.max(line[line.length - 1][0], data.end || 0);
    const scoreAt = t => { let s = [0, 0]; for (const p of line) { if (p[0] > t) break; s = [p[1], p[2]]; } return s; };
    const out = [];
    for (let t = t0; t < t1; t += 3600e3) {
      const a = scoreAt(t), b = scoreAt(Math.min(t + 3600e3, t1));
      out.push([Math.max(0, b[0] - a[0]), Math.max(0, b[1] - a[1])]);
    }
    return out;
  }
  const hourLabels = (us, them) => ({
    us, them,
    short: i => `${i}h`,
    long: i => { const t = (data.start || 0) + i * 3600e3; return `Hour ${i + 1} · ${day(t)} ${clock(t)}–${clock(t + 3600e3)} TCT`; },
  });

  function drawCharts() {
    for (const box of document.querySelectorAll('section.sec.on .chart[data-chart]')) {
      if (box.clientWidth === Number(box.dataset.w)) continue;
      box.dataset.w = box.clientWidth;
      const kind = box.dataset.chart;
      if (kind === 'score') scoreChart(box);
      else if (kind === 'hourly') barChart(box, hourly(), hourLabels(data.us, data.them));
      else if (kind === 'attacks') barChart(box, data.attacks, hourLabels('our wins', 'their attacks on us'));
    }
  }
  let rt = 0;
  window.addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(drawCharts, 120); });

  stripeAll();
  show(location.hash.slice(1), false);
}());
