'use strict';
/* global app */
// One Mentat popup: title, text, Open (goes to the Torn page) and close. Hovering
// holds it open; a thin bar shows the time left.

const card = document.getElementById('card');
const bar = document.getElementById('bar');
let canOpen = false;

let urgent = false;
let shownAt = 0;
app.on('popup', p => {
  urgent = !!p.urgent;
  document.body.classList.toggle('urgent', urgent);
  if (urgent) {
    document.querySelector('.app').textContent = 'Mentat · urgent';
    shownAt = p.shownAt || Date.now();
    document.getElementById('u-open').hidden = !p.canOpen;
    tickSince();
  }
  document.getElementById('title').textContent = p.title;
  document.getElementById('body').textContent = p.body;
  document.title = p.title;
  canOpen = !!p.canOpen;
  document.getElementById('open').hidden = !canOpen;
  card.classList.toggle('clickable', canOpen);
  if (p.seconds > 0) bar.style.animation = `drain ${p.seconds}s linear forwards`;
  else bar.style.display = 'none';
});

document.getElementById('close').addEventListener('click', e => { e.stopPropagation(); app.cmd('popup.action', 'close'); });
document.getElementById('open').addEventListener('click', e => { e.stopPropagation(); app.cmd('popup.action', 'open'); });
card.addEventListener('click', () => { if (canOpen && !urgent) app.cmd('popup.action', 'open'); });
// Urgent card: Open in Torn, snooze (shows again later), dismiss. "Since" counts up so a card
// you come back to says how long it has been waiting.
document.getElementById('u-open').addEventListener('click', () => app.cmd('popup.action', 'open'));
document.getElementById('u-snooze2').addEventListener('click', () => app.cmd('popup.action', 'snooze2'));
document.getElementById('u-snooze5').addEventListener('click', () => app.cmd('popup.action', 'snooze5'));
document.getElementById('u-dismiss').addEventListener('click', () => app.cmd('popup.action', 'close'));
function tickSince() {
  const m = Math.floor((Date.now() - shownAt) / 60000);
  document.getElementById('since').textContent = m < 1 ? '' : `waiting ${m} min`;
}
setInterval(() => { if (urgent) tickSince(); }, 15000);
app.on('popup-snoozed', () => tickSince());
card.addEventListener('mouseenter', () => {
  if (urgent) return; bar.style.animationPlayState = 'paused'; app.cmd('popup.action', 'hold'); });
card.addEventListener('mouseleave', () => {
  if (urgent) return;
  // Leaving restarts a short countdown so it doesn't vanish the instant you look away.
  if (bar.style.display === 'none') return;
  bar.style.animation = 'none';
  void bar.offsetWidth;
  bar.style.animation = 'drain 5s linear forwards';
  app.cmd('popup.action', 'release');
});
