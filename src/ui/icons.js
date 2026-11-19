'use strict';
// Tab icons, shared by the tools window (nav.js) and the pop-out bubbles (popbubble.html).
// Icons (24×24, filled; sub-tab icons use even-odd holes) for the side bar and the editor.
const NAV_ICONS = {
  overview: '<path d="M3 11.5 12 4l9 7.5V20a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z"/>',
  chain: '<path d="M10.6 13.4a1 1 0 0 1 0-1.4l3-3a1 1 0 1 1 1.4 1.4l-3 3a1 1 0 0 1-1.4 0zM8 18.5a3.5 3.5 0 0 1-2.5-6l2.3-2.3 1.4 1.4-2.3 2.3a1.5 1.5 0 0 0 2.1 2.1l2.3-2.3 1.4 1.4-2.3 2.3a3.5 3.5 0 0 1-2.4 1.1zm8.3-4.7-1.4-1.4 2.3-2.3a1.5 1.5 0 0 0-2.1-2.1l-2.3 2.3-1.4-1.4 2.3-2.3a3.5 3.5 0 0 1 5 5z"/>',
  research: '<path d="M10 3a7 7 0 0 1 5.6 11.2l5.1 5.1-1.4 1.4-5.1-5.1A7 7 0 1 1 10 3zm0 2a5 5 0 1 0 0 10 5 5 0 0 0 0-10zM7 11h1.5v2H7zm2.25-3h1.5v5h-1.5zm2.25 1.5H13V13h-1.5z"/>',
  faction: '<path d="M5 2h2v20H5zm3 1h11l-2.5 4L19 11H8z"/>',
  war: '<path d="M6.9 3 3 6.9l4.6 4.6-1.9 1.9 1.4 1.4 1.4-1.4 2.1 2.1-3.2 3.2a1.5 1.5 0 0 0 2.1 2.1l3.2-3.2 2.1 2.1-1.4 1.4 1.4 1.4 1.9-1.9 4.6 4.6L21 17.1 6.9 3zm10.2 0-5.3 5.3 3.9 3.9L21 6.9V3h-3.9z"/>',
  targets: '<path d="M11 2h2v3.1A7 7 0 0 1 18.9 11H22v2h-3.1A7 7 0 0 1 13 18.9V22h-2v-3.1A7 7 0 0 1 5.1 13H2v-2h3.1A7 7 0 0 1 11 5.1zm1 5a5 5 0 1 0 0 10 5 5 0 0 0 0-10zm0 3a2 2 0 1 1 0 4 2 2 0 0 1 0-4z"/>',
  travel: '<path d="M21 16v-2l-8-5V3.5a1.5 1.5 0 0 0-3 0V9l-8 5v2l8-2.5V19l-2 1.5V22l3.5-1 3.5 1v-1.5L13 19v-5.5z"/>',
  market: '<path d="M7 18a2 2 0 1 0 0 4 2 2 0 0 0 0-4zm10 0a2 2 0 1 0 0 4 2 2 0 0 0 0-4zM5.2 4H2V2h4.6l.9 2H21a1 1 0 0 1 .9 1.4l-3.4 7A2 2 0 0 1 16.7 14H8.1l-1 2H19v2H5.4a1 1 0 0 1-.9-1.5L6 13.2z"/>',
  alerts: '<path d="M12 2a7 7 0 0 0-7 7v4.3L3.3 16a1 1 0 0 0 .9 1.5h15.6a1 1 0 0 0 .9-1.5L19 13.3V9a7 7 0 0 0-7-7zm0 21a3 3 0 0 0 3-3H9a3 3 0 0 0 3 3z"/>',
  settings: '<path d="M19.4 13a7.6 7.6 0 0 0 0-2l2.1-1.6-2-3.5-2.5 1a7.4 7.4 0 0 0-1.7-1L15 3h-4l-.4 2.6a7.4 7.4 0 0 0-1.7 1l-2.5-1-2 3.5L6.5 11a7.6 7.6 0 0 0 0 2l-2.1 1.6 2 3.5 2.5-1a7.4 7.4 0 0 0 1.7 1L11 21h4l.4-2.6a7.4 7.4 0 0 0 1.7-1l2.5 1 2-3.5zM13 15.5a3.5 3.5 0 1 1 0-7 3.5 3.5 0 0 1 0 7z" transform="translate(-1 0)"/>',
  planner: '<path fill-rule="evenodd" d="M7 2h2v2h6V2h2v2h2a2 2 0 0 1 2 2v13a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2zM5 9v10h14V9zm2 2h4v3H7zm6 0h4v3h-4zm-6 5h4v2H7z"/>',
  casino: '<path fill-rule="evenodd" d="M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2zm3 3a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3zm8 0a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3zm-4 4.5a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3zM8 15a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3zm8 0a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3z"/>',
  'casino:blackjack': '<path fill-rule="evenodd" d="M6 2h12a1 1 0 0 1 1 1v18a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1zm6 5c-1 1.8-4 3.4-4 5.6a2.1 2.1 0 0 0 3 1.7L10 17h4l-1-2.7a2.1 2.1 0 0 0 3-1.7C16 10.4 13 8.8 12 7z"/>',
  'casino:poker': '<path fill-rule="evenodd" d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm0 4a6 6 0 1 1 0 12 6 6 0 0 1 0-12zm0 3a3 3 0 1 0 0 6 3 3 0 0 0 0-6z"/>',
  'casino:highlow': '<path d="M7 2l5 6H8.5v5h-3V8H2zm10 20-5-6h3.5v-5h3v5H22z"/>',
  'casino:bookie': '<path fill-rule="evenodd" d="M3 5h18v4.2a2.8 2.8 0 0 0 0 5.6V19H3v-4.2a2.8 2.8 0 0 0 0-5.6zm11 2v2h2V7zm0 4v2h2v-2zm0 4v2h2v-2z"/>',
  'casino:tracker': '<path d="M3 3h2v16h16v2H3zm4 11 4-5 3 3 5-6 1.5 1.3-6.4 7.6-3-3-2.6 3.3z"/>',
  'research:report': '<path fill-rule="evenodd" d="M5 2h10l5 5v15H5zm9 1.5V8h4.5zM8 11h8v1.6H8zm0 3.5h8v1.6H8zm0 3.5h5v1.6H8z"/>',
  'research:scout': '<path d="M7 9a5 5 0 1 0 0 10A5 5 0 0 0 7 9zm10 0a5 5 0 1 0 0 10 5 5 0 0 0 0-10zM5.5 4h3l1.2 5.5H4.3zm10 0h3l1.2 5.5h-5.4zM10 11.5h4v3h-4z"/>',
  'market:lookup': '<path fill-rule="evenodd" d="M10 3a7 7 0 0 1 5.6 11.2l5.1 5.1-1.4 1.4-5.1-5.1A7 7 0 1 1 10 3zm0 2a5 5 0 1 0 0 10 5 5 0 0 0 0-10z"/>',
  'market:watch': '<path fill-rule="evenodd" d="M12 5C6.5 5 2.7 8.6 1 12c1.7 3.4 5.5 7 11 7s9.3-3.6 11-7c-1.7-3.4-5.5-7-11-7zm0 3a4 4 0 1 1 0 8 4 4 0 0 1 0-8zm0 2a2 2 0 1 0 0 4 2 2 0 0 0 0-4z"/>',
  'market:deals': '<path fill-rule="evenodd" d="M3 3h8.5L21 12.5 12.5 21 3 11.5zm4.5 2.5a2 2 0 1 0 0 4 2 2 0 0 0 0-4z"/>',
  'market:trade': '<path fill-rule="evenodd" d="M6 2h12a1 1 0 0 1 1 1v18a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1zm1.5 2v4h9V4zm0 6v2h2v-2zm3.5 0v2h2v-2zm3.5 0v2h2v-2zm-7 3.5v2h2v-2zm3.5 0v2h2v-2zm3.5 0V20h2v-6.5zM7.5 17v2h2v-2zm3.5 0v2h2v-2z"/>',
  'travel:timed': '<path fill-rule="evenodd" d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm0 2a8 8 0 1 1 0 16 8 8 0 0 1 0-16zm-1 3h2v5.2l3.6 2.1-1 1.7L11 13.4z"/>',
  'travel:items': '<path fill-rule="evenodd" d="M12 2 3 6.5v11L12 22l9-4.5v-11zm0 2.2 6.5 3.3L12 10.8 5.5 7.5zM5 9.2l6 3v7.4l-6-3zm14 0v7.4l-6 3v-7.4z"/>',
  'travel:sell': '<path fill-rule="evenodd" d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm1 4v1.1c1.5.3 2.6 1.2 2.8 2.6h-2c-.2-.6-.8-1-1.8-1-1.1 0-1.7.4-1.7 1 0 .7.7.9 2.1 1.2 2.1.5 3.6 1.1 3.6 3 0 1.4-1.1 2.4-3 2.7V18h-2v-1.4c-1.7-.3-2.9-1.3-3-2.9h2c.1.8.9 1.3 2 1.3 1.2 0 1.9-.4 1.9-1.1 0-.6-.5-.9-2-1.2-2.3-.5-3.6-1.1-3.6-3 0-1.3 1-2.3 2.7-2.6V6z"/>',
  'travel:flights': '<path d="M3 6h9v2H3zm13 0h5v2h-5zm-4-2h4v6h-4zM3 16h4v2H3zm8 0h10v2H11zm-4-2h4v6H7z"/>',
};
// A sub-tab without its own icon uses its tab's.
const navIcon = id => NAV_ICONS[id] || NAV_ICONS[String(id).split(':')[0]] || '';
