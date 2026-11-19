'use strict';
/* global app, navIcon */
// A pop-out tab's bubble: click to show or hide its window, drag to move, right-click for
// options. The badge (a countdown, a count) comes from the pop-out's own page.

const ID = new URLSearchParams(location.search).get('id') || '';
const bubble = document.getElementById('bubble');
const badge = document.getElementById('badge');
bubble.querySelector('svg').innerHTML = navIcon(ID);

function render(s) {
  if (!s || s.id !== ID) return;
  const showing = s.open && !s.collapsed;
  bubble.classList.toggle('showing', showing);
  const b = s.badge;
  badge.hidden = !(b && b.text);
  badge.textContent = b ? b.text : '';
  badge.className = b && b.tone ? b.tone : '';
  bubble.classList.toggle('bad', !!b && b.tone === 'bad' && !showing);
  const what = b && b.title ? `${s.label}: ${b.title}` : s.label;
  bubble.title = `${what}\n${showing ? 'Click to hide' : 'Click to open'}, drag to move, right-click for options`;
  bubble.setAttribute('aria-label', what);
}

// The main process moves the window with the pointer; a press that doesn't move is a click.
bubble.addEventListener('pointerdown', e => {
  if (e.button !== 0) return;
  bubble.setPointerCapture(e.pointerId);
  app.cmd('pop.bubbleDrag', 'start');
});
bubble.addEventListener('pointerup', e => { if (e.button === 0) app.cmd('pop.bubbleDrag', 'end'); });
bubble.addEventListener('lostpointercapture', () => app.cmd('pop.bubbleDrag', 'end'));
bubble.addEventListener('contextmenu', e => { e.preventDefault(); app.cmd('pop.bubbleMenu'); });

app.on('popout', render);
app.cmd('pop.state').then(render);
