'use strict';
// Torn pages for the "Pages" menu. Each opens as a new tab in the Torn browser.
const T = p => `https://www.torn.com/${p}`;

const PAGES = [
  ['You', [
    ['Home', T('index.php')], ['Items', T('item.php')], ['Events', T('events.php')], ['Messages', T('messages.php')],
    ['Personal Stats', T('personalstats.php')], ['Properties', T('properties.php')], ['Education', T('page.php?sid=education')],
  ]],
  ['Train & Earn', [
    ['Gym', T('gym.php')], ['Crimes', T('page.php?sid=crimes')], ['Missions', T('page.php?sid=missions')],
    ['Job / Company', T('companies.php')], ['Racing', T('page.php?sid=racing')], ['Casino', T('casino.php')],
  ]],
  ['Travel', [
    ['Travel Agency', T('travelagency.php')], ['Hospital', T('hospitalview.php')], ['Jail', T('jailview.php')], ['City', T('city.php')],
  ]],
  ['Money & Trading', [
    ['Item Market', T('page.php?sid=ItemMarket')], ['Your Bazaar', T('bazaar.php')], ['Points Market', T('pmarket.php')],
    ['Trades', T('trade.php')], ['Stock Market', T('page.php?sid=stocks')], ['Bank', T('bank.php')], ['Points Store', T('points.php')],
  ]],
  ['Faction & War', [
    ['Your Faction', T('factions.php?step=your')], ['Faction Armory', T('factions.php?step=your#/tab=armoury')],
    ['Bounties', T('bounties.php')], ['Hall of Fame', T('halloffame.php')],
  ]],
  ['Community', [
    ['Forums', T('forums.php')], ['Newspaper', T('newspaper.php')],
  ]],
];

module.exports = { PAGES };
