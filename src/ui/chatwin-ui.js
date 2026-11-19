'use strict';
/* global app */
// Bar above the pop-out chat: pin on top, quick emojis, Windows emoji panel, reload.

const DEFAULT_EMOJIS = '😂 👍 ❤️ 😭 🙏 🔥 💀 👀 🎉 😅';
const $ = s => document.querySelector(s);

// Splits a string into whole emojis (keeps skin tones, flags and ❤️-style sequences together).
function splitEmojis(text) {
  const seg = new Intl.Segmenter('en', { granularity: 'grapheme' });
  return [...seg.segment(String(text || ''))].map(s => s.segment).filter(s => s.trim());
}

function render(state) {
  $('#cb-pin').classList.toggle('active', !!state.onTop);
  $('#cb-pin').title = state.onTop ? 'On top of other windows (click to turn off)' : 'Keep this window on top of other windows';
  const list = splitEmojis(state.emojis || DEFAULT_EMOJIS).slice(0, 30);
  $('#cb-emojis').innerHTML = '';
  for (const e of list) {
    const b = document.createElement('button');
    b.className = 'emoji-btn';
    b.textContent = e;
    b.dataset.emoji = e;
    $('#cb-emojis').appendChild(b);
  }
}

let state = { onTop: true, emojis: DEFAULT_EMOJIS };
// Clicking a bar button would take keyboard focus away from the chat box; keep it there.
document.addEventListener('mousedown', e => { if (e.target.closest('button')) e.preventDefault(); });
document.addEventListener('click', e => {
  const em = e.target.closest('[data-emoji]');
  if (em) return app.cmd('chatwin.insert', em.dataset.emoji);
  if (e.target.closest('#cb-pin')) return app.cmd('chatwin.onTop', !state.onTop);
  if (e.target.closest('#cb-more')) return app.cmd('chatwin.emojiPanel');
  if (e.target.closest('#cb-reload')) return app.cmd('chatwin.reload');
  if (e.target.closest('#cb-tool')) return app.cmd('tool.focus');
  if (e.target.closest('#cb-collapse')) return app.cmd('chatwin.collapse');
  return null;
});
// Scroll the emoji row sideways with the mouse wheel when it doesn't fit.
$('#cb-emojis').addEventListener('wheel', e => { $('#cb-emojis').scrollLeft += e.deltaY; e.preventDefault(); }, { passive: false });

app.on('chatwin', s => { state = s; render(s); });
app.cmd('chatwin.init').then(s => { state = s; render(s); });
