'use strict';
/* global S, $, showPanel */
/* exported updateStackNag */
// "YOU SHOULD BE STACKING": rainbow bouncing bubble letters (and smiling slimes) next to the
// Mentat name in the top bar from 60 hours before a ranked war starts until it starts.
// Hover for the countdown; click for the War tab. Still when the system asks for reduced motion.

const STACK_WINDOW = 60 * 3600e3;

// A smiling slime: a soft blob with a shine, two eyes and a grin. `hue` picks its colour.
function slimeSvg(hue, id) {
  return `<svg viewBox="0 0 40 34" width="26" height="22" aria-hidden="true" focusable="false">
    <defs><radialGradient id="sl-${id}" cx="40%" cy="30%" r="75%">
      <stop offset="0" stop-color="hsl(${hue} 95% 82%)"/><stop offset=".55" stop-color="hsl(${hue} 85% 58%)"/><stop offset="1" stop-color="hsl(${hue} 80% 40%)"/>
    </radialGradient></defs>
    <path d="M4 31 C1 31 1 27 3 24 C5 12 12 3 20 3 C28 3 35 12 37 24 C39 27 39 31 36 31 Z" fill="url(#sl-${id})" stroke="hsl(${hue} 70% 30%)" stroke-width="1.2"/>
    <ellipse cx="13" cy="10" rx="4.5" ry="2.6" fill="#fff" opacity=".55" transform="rotate(-25 13 10)"/>
    <ellipse cx="15" cy="18" rx="2.3" ry="3" fill="#1b1b1b"/><ellipse cx="25" cy="18" rx="2.3" ry="3" fill="#1b1b1b"/>
    <circle cx="15.8" cy="16.8" r=".9" fill="#fff"/><circle cx="25.8" cy="16.8" r=".9" fill="#fff"/>
    <path d="M14.5 23 Q20 28.5 25.5 23" fill="none" stroke="#1b1b1b" stroke-width="1.6" stroke-linecap="round"/>
    <ellipse cx="11.5" cy="22.5" rx="2" ry="1.1" fill="hsl(340 90% 70%)" opacity=".7"/><ellipse cx="28.5" cy="22.5" rx="2" ry="1.1" fill="hsl(340 90% 70%)" opacity=".7"/>
  </svg>`;
}

function stackNagHtml() {
  const text = 'YOU SHOULD BE STACKING';
  let i = 0;
  const letters = [...text].map(ch => (ch === ' ' ? '<span class="sn-sp"> </span>' : `<span class="sn-l" style="--i:${i++}">${ch}</span>`)).join('');
  return `<span class="sn-slime sn-s1">${slimeSvg(120, 'a')}</span>
    <span class="sn-text" aria-hidden="true">${letters}</span>
    <span class="sn-slime sn-s2">${slimeSvg(320, 'b')}</span>
    <span class="sn-slime sn-s3">${slimeSvg(200, 'c')}</span>`;
}

function updateStackNag() {
  const el = $('#stack-nag');
  if (!el) return;
  const w = S.features && S.features.war;
  const r = w && w.wars && w.wars.ranked;
  const left = r && r.start ? r.start - Date.now() : -1;
  const show = left > 0 && left <= STACK_WINDOW;
  if (!show) { if (!el.hidden) { el.hidden = true; el.textContent = ''; } return; }
  if (el.hidden || !el.firstChild) { el.innerHTML = stackNagHtml(); el.hidden = false; }
  const h = Math.floor(left / 3600e3), m = Math.floor((left % 3600e3) / 60e3);
  const when = new Date(r.start).toUTCString().slice(0, 3) + ' ' + new Date(r.start).toISOString().slice(11, 16);
  const tip = `Ranked war starts in ${h}h ${String(m).padStart(2, '0')}m (${when} TCT). You should be stacking! Click for the War tab.`;
  el.title = tip;
  el.setAttribute('aria-label', `You should be stacking: ranked war starts in ${h} hours ${m} minutes`);
}

(function initStackNag() {
  const el = $('#stack-nag');
  if (!el) return;
  el.addEventListener('click', () => { if (typeof showPanel === 'function') showPanel('war'); });
  el.addEventListener('keydown', e => { if ((e.key === 'Enter' || e.key === ' ') && typeof showPanel === 'function') { e.preventDefault(); showPanel('war'); } });
  setInterval(updateStackNag, 30000);
})();
