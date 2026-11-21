'use strict';
// "Add all players in this list to targets" (right-click a player's link in a Torn tab).
// readPlayerList is not called here: main.js sends its source to the Torn page once, into an
// isolated world, when you pick the menu item. So it must stay self-contained (no outside names).
// It only reads: the player links of the list around the link you right-clicked, and each row's
// level, status and faction when the row shows them. It changes nothing on the page.

// x, y: where you right-clicked (CSS pixels); href: the link's address (fallback lookup).
// -> { players: [{ id, name, level, status, factionId }] }, at most 300
function readPlayerList(x, y, href) {
  const idOf = a => { const m = /[?&](?:XID|user2ID)=(\d+)/i.exec((a && a.getAttribute && a.getAttribute('href')) || ''); return m ? Number(m[1]) : 0; };
  const playerLinks = el => (el.matches && el.matches('a[href]') ? [el] : []).concat([...el.querySelectorAll('a[href]')]).filter(a => idOf(a));
  let link = null;
  const at = document.elementFromPoint(x, y);
  if (at && at.closest) link = at.closest('a[href]');
  if (!link || !idOf(link)) link = [...document.querySelectorAll('a[href]')].find(a => a.href === href) || null;
  if (!link) return { players: [] };
  // The list: the nearest box around the link whose children hold at least two different players.
  // (Inside one row the name and the attack button both link to the same player, so a row isn't it.)
  const rowsOf = el => [...el.children].map(c => ({ c, ids: new Set(playerLinks(c).map(idOf)) })).filter(r => r.ids.size);
  let list = link.parentElement;
  let rows = [];
  while (list && list !== document.body && list !== document.documentElement) {
    rows = rowsOf(list);
    if (rows.length >= 2 && new Set(rows.flatMap(r => [...r.ids])).size >= 2) break;
    list = list.parentElement;
  }
  if (!list || list === document.body || list === document.documentElement) return { players: [] };
  // A real list has rows of one kind (like the clicked one); a link on its own (a header, a
  // sidebar box next to other boxes) isn't in one.
  const mine = rows.find(r => r.c.contains(link));
  rows = rows.filter(r => r.c.tagName === mine.c.tagName);
  if (rows.length < 2) return { players: [] };
  const out = [];
  const seen = new Set();
  for (const { c: row } of rows) {
    const t = (row.textContent || '').replace(/\s+/g, ' ');
    const level = /LEVEL:\s*(\d+)/i.exec(t);
    const status = /STATUS:\s*([A-Z][a-z]+)/.exec(t);
    const fac = row.querySelector('a[href*="factions.php"]');
    const facId = fac ? /[?&]ID=(\d+)/i.exec(fac.getAttribute('href') || '') : null;
    for (const a of playerLinks(row)) {
      const id = idOf(a);
      if (seen.has(id)) continue;
      seen.add(id);
      const label = a.getAttribute('title') || a.getAttribute('aria-label') || a.getAttribute('data-placeholder') || a.textContent || '';
      out.push({
        id,
        name: label.replace(/\s*\[\d+\]\s*$/, '').trim().slice(0, 40),
        level: level ? Number(level[1]) : 0,
        status: status ? status[1] : '',
        factionId: facId ? Number(facId[1]) : 0,
      });
      if (out.length >= 300) return { players: out };
    }
  }
  return { players: out };
}

module.exports = { readPlayerList };
