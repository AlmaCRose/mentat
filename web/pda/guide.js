'use strict';
// Copy buttons for the script addresses on the guide pages: #copy copies #u (Torn PDA), and any
// button with data-copy="<input id>" copies that input.
document.querySelectorAll('#copy, [data-copy]').forEach(btn => btn.addEventListener('click', async () => {
  const u = document.getElementById(btn.dataset.copy || 'u');
  try { await navigator.clipboard.writeText(u.value); } catch (e) { u.select(); document.execCommand('copy'); }
  const note = document.getElementById(btn.dataset.note || 'copied');
  if (note) note.textContent = btn.dataset.done || 'Copied. Paste it into Torn PDA.';
}));
