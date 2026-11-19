'use strict';
// pda.html: hands a Torn link to Torn PDA from the installed web app on iPhone (see the page's note).
// The link comes in the address's #fragment (never sent to the server): #to=tornpda://…&web=https://www.torn.com/…
(function () {
  const q = new URLSearchParams(location.hash.slice(1));
  const to = q.get('to') || '';
  const web = q.get('web') || '';
  const okTo = /^tornpda:\/\/(www\.)?torn\.com\//i.test(to);
  const okWeb = /^https:\/\/(www\.)?torn\.com\//i.test(web);
  const again = document.getElementById('again');
  const site = document.getElementById('web');
  if (okTo) again.href = to; else again.hidden = true;
  if (okWeb) site.href = web; else site.hidden = true;
  // Coming back from PDA: try to close this sheet (iOS may not allow it), else say how.
  let left = false;
  const back = () => {
    document.body.classList.add('back');
    try { window.close(); } catch (e) { /* not allowed: the page says to tap ✕ */ }
  };
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) left = true;
    else if (left) back();
  });
  window.addEventListener('pageshow', e => { if (e.persisted) back(); });
  if (okTo) setTimeout(() => { location.href = to; }, 60);
})();
