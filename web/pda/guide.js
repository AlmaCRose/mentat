'use strict';
// Copy button for the script address on the guide page.
document.getElementById('copy').addEventListener('click', async () => {
    const u = document.getElementById('u');
    try { await navigator.clipboard.writeText(u.value); } catch (e) { u.select(); document.execCommand('copy'); }
    document.getElementById('copied').textContent = 'Copied. Paste it into Torn PDA.';
  });
