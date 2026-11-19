'use strict';
// Compact view for the chat window: display-only changes to Torn's own chat page, applied
// to the chat window only (the user opted in; it's a setting). Nothing is automated and no
// requests are made: it hides the rest of the page and shows one open chat at a time.
//
// Torn's chat (#chatRoot) keeps every open chat as a full-size panel in a row; in a narrow
// window each new one lands off-screen. Here, the chat buttons along the bottom act as
// "bins": clicking a chat that's open but hidden brings it to the front (instead of Torn
// closing it); clicking the chat that's showing behaves as normal; a newly opened chat
// comes to the front.
//
// Hooks rely on Torn's stable ids (#chatRoot, chat_panel_button:<chat>, a panel with
// id=<chat>) and on class-name prefixes ("item___"), not on the generated hashes, so they
// should survive most Torn chat updates. If Torn changes its chat a lot, this may need
// updating; the chat itself keeps working (it just stacks again).

const CSS = `
html.td-chat, html.td-chat body { background: #191919 !important; overflow: hidden !important; }
html.td-chat body *:not(#chatRoot):not(#chatRoot *) { visibility: hidden !important; }
html.td-chat [data-td-hidden] { display: none !important; }
/* Torn slides each extra panel sideways (translateX); the one in front goes back in view. */
html.td-chat [data-td-shown] { transform: none !important; }
html.td-chat [data-td-active] { box-shadow: 0 0 0 2px #74b816 !important; border-radius: 50% !important; }
html.td-chat[data-td-empty] #chatRoot::before {
  content: "Pick a chat from the buttons below";
  position: fixed; left: 0; right: 0; top: 40%; text-align: center;
  color: #9a9a9a; font: 14px "Segoe UI", system-ui, sans-serif; visibility: visible;
}
`;

// Runs in Torn's page (chat window only). Idempotent per page load.
const JS = `(() => {
  if (window.__tdChatTrim) return 'already';
  window.__tdChatTrim = true;
  const root = () => document.getElementById('chatRoot');
  const isItem = el => el && typeof el.className === 'string' && /(^|\\s)item___/.test(el.className);
  const items = () => {
    const r = root();
    const first = r && r.querySelector('[class*="item___"]');
    return first ? [...first.parentElement.children].filter(isItem) : [];
  };
  const panelId = item => {
    const p = item.querySelector('[id]:not([id^="Dnd"])');
    return p ? p.id : '';
  };
  const isOpen = item => item.childElementCount > 0 && !!panelId(item);
  let active = null;
  const seen = new Map(); // item -> panel id it showed last time

  function apply() {
    // Only trim pages that have the chat (e.g. not the login page).
    document.documentElement.classList.toggle('td-chat', !!root());
    const open = items().filter(isOpen);
    if (active && !open.includes(active)) active = null;
    for (const i of items()) {
      i.toggleAttribute('data-td-hidden', isOpen(i) && i !== active);
      i.toggleAttribute('data-td-shown', i === active);
    }
    const id = active ? panelId(active) : '';
    for (const b of root() ? root().querySelectorAll('[id^="chat_panel_button:"]') : []) {
      b.toggleAttribute('data-td-active', !!id && b.id === 'chat_panel_button:' + id);
    }
    document.documentElement.toggleAttribute('data-td-empty', !active);
  }

  function scan() {
    // A chat that just opened (or a panel that now shows a different chat) comes to the front.
    for (const i of items()) {
      const id = isOpen(i) ? panelId(i) : '';
      if (id && seen.get(i) !== id) active = i;
      seen.set(i, id);
    }
    apply();
  }

  // Clicking the button of a chat that's open but hidden shows it instead of closing it.
  document.addEventListener('click', e => {
    const b = e.target && e.target.closest && e.target.closest('#chatRoot [id^="chat_panel_button:"]');
    if (!b) return;
    const id = b.id.slice('chat_panel_button:'.length);
    const item = items().find(i => isOpen(i) && panelId(i) === id);
    if (item && item !== active) {
      e.preventDefault();
      e.stopImmediatePropagation();
      active = item;
      apply();
    }
  }, true);

  let queued = false;
  new MutationObserver(() => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => { queued = false; scan(); });
  }).observe(document.documentElement, { childList: true, subtree: true });
  scan();
  return 'ok';
})()`;

module.exports = { CHAT_TRIM_CSS: CSS, CHAT_TRIM_JS: JS, CHAT_BUNDLE: 'https://www.torn.com/builds/tchat/*' };
