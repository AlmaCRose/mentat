'use strict';
// Alerts as Windows notifications or as Mentat's own popups (popups.js), whichever
// the user picked (ui.popupStyle). Clicking / "Open" brings up the alert's Torn page in a
// new tab; nothing is ever done in Torn.

const { Notification } = require('electron');

function createNotifier({ getWindow, openUrl, popups, getStyle }) {
  return function notify(title, body, url = '') {
    if (popups && getStyle && getStyle() === 'app') {
      popups.show(title, body, url);
      return;
    }
    if (!Notification.isSupported()) return;
    const n = new Notification({ title, body });
    n.on('click', () => {
      const win = getWindow();
      if (win) {
        if (win.isMinimized()) win.restore();
        win.show();
        win.focus();
      }
      if (url) openUrl(url);
    });
    n.show();
    const win = getWindow();
    if (win && !win.isFocused()) win.flashFrame(true);
  };
}

module.exports = { createNotifier };
