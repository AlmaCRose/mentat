// Compatibility layer added to Mentat's COPY of a browser extension (never the
// original in Chrome). Electron doesn't provide chrome.notifications or chrome.tabs.create,
// which TornTools' background worker uses at start-up. These stand-ins pass notifications
// to Mentat's own alerts and open tab requests in the Torn browser, by fetching a
// reserved address that Mentat intercepts (nothing is sent anywhere).
(() => {
  const c = globalThis.chrome;
  if (!c) return;
  const BRIDGE = 'https://torndesktop.invalid/';
  const send = (what, params) => {
    try { fetch(`${BRIDGE}${what}?${new URLSearchParams(params)}`, { mode: 'no-cors', cache: 'no-store' }).catch(() => {}); } catch (e) { /* ignore */ }
  };
  const event = () => {
    const fns = new Set();
    return { addListener: f => fns.add(f), removeListener: f => fns.delete(f), hasListener: f => fns.has(f), hasListeners: () => fns.size > 0 };
  };
  const done = (cb, value) => { if (typeof cb === 'function') try { cb(value); } catch (e) { /* ignore */ } return Promise.resolve(value); };
  if (!c.notifications) {
    let n = 0;
    c.notifications = {
      create(id, opts, cb) {
        if (typeof id === 'object') { cb = opts; opts = id; id = ''; }
        id = id || `td${Date.now()}${n++}`;
        opts = opts || {};
        send('notify', { title: opts.title || 'TornTools', body: opts.message || opts.contextMessage || '' });
        return done(cb, id);
      },
      update: (id, opts, cb) => done(cb, true),
      clear: (id, cb) => done(cb, true),
      getAll: cb => done(cb, {}),
      getPermissionLevel: cb => done(cb, 'granted'),
      onClicked: event(), onClosed: event(), onButtonClicked: event(), onShowSettings: event(), onPermissionLevelChanged: event(),
    };
  }
  if (!c.tabs) c.tabs = {};
  if (!c.tabs.create) {
    c.tabs.create = (opts, cb) => {
      if (opts && opts.url) send('open', { url: new URL(opts.url, globalThis.location ? globalThis.location.href : 'https://www.torn.com/').href });
      return done(cb, { id: -1 });
    };
  }
  // Electron doesn't send runtime.onInstalled / onStartup, which TornTools uses to set up
  // its settings and timers. In the background worker, remember its listeners and call
  // them the way Chrome would: "install"/"update" once per version, "startup" once per
  // app session.
  const isWorker = typeof ServiceWorkerGlobalScope !== 'undefined' && globalThis instanceof ServiceWorkerGlobalScope;
  if (isWorker && c.runtime && c.storage && c.storage.local) {
    const wrap = ev => {
      const fns = [];
      if (ev && ev.addListener) {
        const add = ev.addListener.bind(ev);
        ev.addListener = fn => { fns.push(fn); try { add(fn); } catch (e) { /* ignore */ } };
      }
      return fns;
    };
    const installed = wrap(c.runtime.onInstalled);
    const startup = wrap(c.runtime.onStartup);
    const call = (fns, arg) => fns.forEach(fn => { try { const r = fn(arg); if (r && r.catch) r.catch(() => {}); } catch (e) { /* ignore */ } });
    setTimeout(async () => {
      const version = c.runtime.getManifest().version;
      const KEY = '__tornDesktopInstalledVersion';
      try {
        const got = await c.storage.local.get(KEY);
        const prev = got && got[KEY];
        if (prev !== version) {
          call(installed, prev ? { reason: 'update', previousVersion: prev } : { reason: 'install' });
          await c.storage.local.set({ [KEY]: version });
        }
        const session = c.storage.session;
        const started = session ? (await session.get('__tornDesktopStarted')).__tornDesktopStarted : false;
        if (!started) {
          if (prev === version) call(startup);
          if (session) await session.set({ __tornDesktopStarted: true });
        }
      } catch (e) { /* storage unavailable */ }
    }, 300);
  }

  // Some code uses the "browser" namespace (WebExtension polyfill) taken from chrome.
  if (globalThis.browser && globalThis.browser !== c) {
    if (!globalThis.browser.notifications) globalThis.browser.notifications = c.notifications;
    if (globalThis.browser.tabs && !globalThis.browser.tabs.create) globalThis.browser.tabs.create = c.tabs.create;
  }
})();
