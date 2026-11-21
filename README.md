# Mentat

A free Windows app for playing Torn: browser tabs on torn.com, plus a sidebar of built-in tools
that use only the official Torn API. (It was called Torn Desktop until 2026-11-18.)

## Run it

- Double-click **`Start Mentat.cmd`** (runs the code in this folder, so changes show up on restart). It starts
  Electron as `node_modules\electron\dist\Mentat.exe`, a copy with Mentat's name and icon (`scripts\brand-dev.js`),
  so Task Manager and the taskbar say Mentat.
- Or run the built app: `dist\win-unpacked\Mentat.exe` (rebuild after changes with `npm.cmd run pack`).
- From PowerShell use `npm.cmd start` (plain `npm` is blocked by PowerShell's script policy).

Build an installer (Start menu shortcut) and a portable .exe into `dist/`: `npm.cmd run dist`.

**Your Mentat server.** Signing in needs a Mentat server (`server/`, see `server/README.md`).
Copy `mentat.local.example.json` to `mentat.local.json` and put your server's address in it.
Running from source then signs in to it by default, and `npm.cmd run dist` / `pack` build it
into the app and take updates from `<server>/downloads/`. Without that file there's no default
server (enter one on the sign-in screen) and no automatic updates. `mentat.local.json` is not
in git.
Both ways share the same settings and data in `%APPDATA%\Mentat`. The first start after the rename
moves the old `%APPDATA%\Torn Desktop` folder there (or keeps using it while an old copy is still running).
The icons in `src/assets/` are made from the transparent Mentat symbol.

## Windows

- **Tools window**: Overview, Chain, Targets, Travel, Market, Settings. Closing it quits the app.
- **Torn browser**: opened with *Open Torn* (Ctrl+D), its own tabs, remembers them. Every Torn
  link in the tools, the *Pages* menu and notification clicks open there as new tabs.

## How it's put together

| Path | What it does |
|---|---|
| `src/main/main.js` | Window, layout, keyboard shortcuts, right-click menu, commands from the UI |
| `src/main/tabs.js` | Browser tabs. Plain sandboxed Chromium views of torn.com (see the two exceptions under Rules) |
| `src/main/api.js` | The only Torn API client. One shared queue, rate-capped (default 40/min), error backoff, key encrypted with Windows DPAPI |
| `src/main/features/*.js` | One module per feature. Each has `tick(now)` (called every second), `snapshot()`, and emits `state` |
| `src/ui/` | The tab strip, address bar and sidebar (plain HTML/CSS/JS, no build step) |

To add a feature, create a module in `src/main/features/`, register it in `features` in
`main.js`, and add a renderer to `RENDER` in `src/ui/app.js`.

## Rules this app follows

- Torn pages load like a normal browser. The app never makes non-API requests to torn.com or
  performs game actions, and it doesn't read or change Torn pages, with two exceptions you
  choose to use:
  - the chat window's compact view (`chatwin.compact`) hides parts of Torn's chat page; display only.
  - right-click a player's link → **Add all players in this list to targets** reads the player
    links of that one list, once, when you pick it (`src/main/playerlist.js`, run in an isolated
    world). Nothing on the page changes.
- All data comes from `api.torn.com`, through one rate-limited queue.
- Data and the key stay on this PC.

## Features

- Overview: energy/nerve/happy/life, cooldowns, travel, refills, unread events/messages, quick links
- Chain: timer with beeps at 2:30/1:30/1:00/0:30, top hitters, your rank, online members
- Targets: status and hospital timers, attack links, auto refresh
- Desktop notifications for bars, cooldowns, landing, hospital release, events, messages, targets
- Travel (widen the sidebar with the ⇤ button):
  - Trip planner: every destination ranked by profit per hour for your method, capacity
    (from your key, incl. flower/plushie slots) and ticket cost; best loadout; optional
    outbound leg (items that sell abroad for more than they cost at home); stock projected
    to your landing time; departure times aligned to restocks; restock-minute chart
  - Abroad items: sortable table with ROI, measured sell rate, sell-out time, stock at
    landing and 7-day market value trend; per-item stock and price charts and restock log
  - Flights & settings: wiki flight times, auto-measured from your own flights, overrides
- Market: item lookup (live listings, spread, depth, Torn shop prices, price history chart),
  watchlist with desktop price alerts, category deal finder, trade calculator, points market

Data sources: api.torn.com, and YATA's public abroad-stock export (no key sent). Price and
stock history is recorded locally (`history.json`, `travel-history.json`) to build trends.
