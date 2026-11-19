'use strict';
/* global app */
// The collapsed chat bubble: click to open the chat, drag to move, right-click for options.
// It shows a count when Torn's chat has played its new-message sound since you last looked.

const bubble = document.getElementById('bubble');
const badge = document.getElementById('badge');

function render(s) {
  const n = s.unread || 0;
  const showing = !!s.open && !s.collapsed;
  bubble.classList.toggle('unread', n > 0);
  bubble.classList.toggle('showing', showing);
  badge.hidden = !n;
  badge.textContent = n > 9 ? '9+' : String(n);
  bubble.title = showing
    ? 'Torn chat is open: click to hide it, drag to move, right-click for options'
    : n ? `Torn chat: new message${n === 1 ? '' : 's'} (click to open)` : 'Torn chat: click to open, drag to move, right-click for options';
}

// The main process moves the window with the pointer; a press that doesn't move is a click.
bubble.addEventListener('pointerdown', e => {
  if (e.button !== 0) return;
  bubble.setPointerCapture(e.pointerId);
  app.cmd('chatwin.bubbleDrag', 'start');
});
bubble.addEventListener('pointerup', e => {
  if (e.button !== 0) return;
  app.cmd('chatwin.bubbleDrag', 'end');
});
bubble.addEventListener('lostpointercapture', () => app.cmd('chatwin.bubbleDrag', 'end'));
bubble.addEventListener('contextmenu', e => { e.preventDefault(); app.cmd('chatwin.bubbleMenu'); });

app.on('chatwin', render);
app.cmd('chatwin.init').then(render);
