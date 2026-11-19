'use strict';
/* global app */
// One Mentat popup: title, text, Open (goes to the Torn page) and close. Hovering
// holds it open; a thin bar shows the time left.

const card = document.getElementById('card');
const bar = document.getElementById('bar');
let canOpen = false;

app.on('popup', p => {
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
card.addEventListener('click', () => { if (canOpen) app.cmd('popup.action', 'open'); });
card.addEventListener('mouseenter', () => { bar.style.animationPlayState = 'paused'; app.cmd('popup.action', 'hold'); });
card.addEventListener('mouseleave', () => {
  // Leaving restarts a short countdown so it doesn't vanish the instant you look away.
  if (bar.style.display === 'none') return;
  bar.style.animation = 'none';
  void bar.offsetWidth;
  bar.style.animation = 'drain 5s linear forwards';
  app.cmd('popup.action', 'release');
});
