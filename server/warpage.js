'use strict';
// The shared war report page (the user's request, 2026-11-24): a link the team can open without
// signing in or waiting on Torn's API. The server builds each report once (features/warreport.js,
// with the server's key) and this file turns it into one ready-made page: side tabs for each
// section, tables written out in full, and the charts drawn in the browser from data in the page
// (web/war/report.js, which also sorts the tables). No API calls when someone opens it.
//
// Links are /war/<warId>-<sig> (that war) and /war/latest-<sig> (the newest report). sig is an
// HMAC of the id with a secret kept in the data folder, so links can't be guessed from war ids;
// only people signed in to Mentat can get one (route war/report-link).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const num = n => Math.round(Number(n) || 0).toLocaleString('en-US');
const pts = n => (Math.round((Number(n) || 0) * 100) / 100).toLocaleString('en-US', { maximumFractionDigits: 2 });
const pct = (a, b) => (b ? `${(Math.round((a / b) * 1000) / 10).toLocaleString('en-US')}%` : '–');
const dateTct = ms => (ms ? new Date(ms).toISOString().slice(0, 10) : '');
const timeTct = ms => (ms ? `${new Date(ms).toISOString().slice(5, 16).replace('T', ' ')}` : '');
function dur(ms) {
  const m = Math.round((Number(ms) || 0) / 60000);
  const d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60), mm = m % 60;
  return d ? `${d}d ${h}h ${mm}m` : h ? `${h}h ${mm}m` : `${mm}m`;
}
const profile = (id, name) => `<a href="https://www.torn.com/profiles.php?XID=${Number(id) || 0}" target="_blank" rel="noopener noreferrer">${esc(name)}</a>`;

const CLIENT = path.join(__dirname, '..', 'web', 'war', 'report.js');
let clientV = { mtime: 0, v: '0' };
function clientVersion() {
  try {
    const st = fs.statSync(CLIENT);
    if (st.mtimeMs !== clientV.mtime) clientV = { mtime: st.mtimeMs, v: crypto.createHash('sha256').update(fs.readFileSync(CLIENT)).digest('base64url').slice(0, 10) };
  } catch (e) { /* not there */ }
  return clientV.v;
}

// ---- Links ----
function linkSecret(dataDir) {
  const file = path.join(dataDir, 'report-secret');
  try { const s = fs.readFileSync(file, 'utf8').trim(); if (s.length >= 32) return s; } catch (e) { /* make one */ }
  const s = crypto.randomBytes(32).toString('base64url');
  fs.writeFileSync(file, s, { mode: 0o600 });
  return s;
}
const sign = (secret, id) => crypto.createHmac('sha256', secret).update(`war-report:${id}`).digest('base64url').slice(0, 12);
function sigOk(secret, id, sig) {
  const a = Buffer.from(sign(secret, id)), b = Buffer.from(String(sig || ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ---- Page parts ----
const CSS = `
:root{color-scheme:dark;--bg:#17120d;--card:#211a13;--card2:#2a2119;--line:#3e3226;--text:#f6f1e9;--muted:#c4b8a8;--accent:#debca0;--accent-ink:#17120d;
--us:#3987e5;--them:#d95926;--win-bg:#1f3a26;--win:#9be3ad;--loss-bg:#45201c;--loss:#ffb4a8;--grid:#3a3027;--stripe:#2b221a;--rowhover:#3a2e22}
@media (prefers-color-scheme:light){:root:not([data-theme="dark"]){color-scheme:light;--bg:#f5f0e8;--card:#fffdf9;--card2:#f8f2ea;--line:#e0d5c6;--text:#1d1710;--muted:#5c5144;--accent:#7a5a36;--accent-ink:#fff;
--us:#2a78d6;--them:#eb6834;--win-bg:#dcf2e1;--win:#1d5e30;--loss-bg:#fbe1dc;--loss:#8a2417;--grid:#e8dfd2;--stripe:#f6efe4;--rowhover:#efe4d3}}
*{box-sizing:border-box}
html,body{margin:0}
body{background:var(--bg);color:var(--text);font:15px/1.5 "Segoe UI",system-ui,-apple-system,Roboto,sans-serif;-webkit-text-size-adjust:100%}
a{color:var(--accent)}
.muted{color:var(--muted)}
.small{font-size:13px}
.wrap{max-width:1180px;margin:0 auto;padding:20px 16px 40px}
header.top{display:flex;gap:14px;align-items:center;flex-wrap:wrap;margin-bottom:18px}
header.top img{width:40px;height:40px}
header.top>div{min-width:0;flex:1}
header.top h1{font-size:22px;line-height:1.25;margin:0;overflow-wrap:anywhere}
main{min-width:0}
header.top .sub{color:var(--muted);font-size:13px}
.pill{display:inline-block;padding:3px 10px;border-radius:999px;font-weight:600;font-size:13px}
.pill.win{background:var(--win-bg);color:var(--win)}
.pill.loss{background:var(--loss-bg);color:var(--loss)}
.layout{display:grid;grid-template-columns:190px minmax(0,1fr);gap:20px;align-items:start}
nav.tabs{position:sticky;top:12px;display:flex;flex-direction:column;gap:2px;background:var(--card);border:1px solid var(--line);border-radius:10px;padding:6px}
nav.tabs a{display:flex;gap:8px;align-items:center;padding:8px 10px;border-radius:7px;color:var(--text);text-decoration:none;font-weight:500;white-space:nowrap}
nav.tabs a:hover{background:var(--card2)}
nav.tabs a.on{background:var(--accent);color:var(--accent-ink)}
nav.tabs .n{margin-left:auto;font-size:12px;opacity:.8}
section.sec{display:none;background:var(--card);border:1px solid var(--line);border-radius:10px;padding:18px}
section.sec.on{display:block}
section.sec h2{margin:0 0 12px;font-size:19px}
section.sec h3{margin:20px 0 8px;font-size:15px}
.score{font-size:40px;font-weight:700;letter-spacing:.5px;line-height:1.1}
.score .sep{color:var(--muted);font-weight:400;margin:0 8px}
.vs{display:flex;gap:24px;align-items:flex-end;flex-wrap:wrap;margin-bottom:14px}
.vs .side{font-size:13px;color:var(--muted)}
.key{display:inline-block;width:14px;height:3px;border-radius:2px;vertical-align:middle;margin-right:6px}
.key.us{background:var(--us)}.key.them{background:var(--them)}
.tiles{display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:8px;margin:12px 0}
.tile{background:var(--card2);border:1px solid var(--line);border-radius:8px;padding:9px 12px}
.tile .v{font-size:19px;font-weight:650}
.tile .l{font-size:12.5px;color:var(--muted)}
.chart{position:relative;margin:6px 0 4px}
.chart svg{display:block;width:100%;overflow:visible}
.chart text{fill:var(--muted);font-size:12px}
.chart .gridl{stroke:var(--grid);stroke-width:1}
.chart .axis{stroke:var(--line);stroke-width:1}
.chart .lus{stroke:var(--us);stroke-width:2;fill:none}
.chart .lthem{stroke:var(--them);stroke-width:2;fill:none}
.chart .bus{fill:var(--us)}.chart .bthem{fill:var(--them)}
.chart rect.hit{fill:transparent}
.chart .xh{stroke:var(--muted);stroke-width:1;stroke-dasharray:3 3}
.chart .dot{stroke:var(--card);stroke-width:2}
.chart .lab{font-weight:600;fill:var(--text)}
.tip{position:absolute;pointer-events:none;background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:7px 10px;font-size:13px;white-space:nowrap;box-shadow:0 4px 14px rgba(0,0,0,.3);z-index:2}
.tip b{font-size:14px}
.tip .k{display:inline-block;width:12px;height:2px;margin-right:6px;vertical-align:middle}
.legend{display:flex;gap:16px;font-size:13px;color:var(--muted);margin:2px 0 6px;flex-wrap:wrap}
.tablewrap{overflow-x:auto;border:1px solid var(--line);border-radius:8px}
table.data{border-collapse:collapse;width:100%;font-size:14px}
table.data th,table.data td{padding:6px 10px;text-align:left;border-bottom:1px solid var(--line);white-space:nowrap}
table.data tr:last-child td{border-bottom:0}
table.data th{background:var(--card2);font-weight:600;font-size:12.5px;color:var(--muted);position:sticky;top:0}
table.data th.sort{cursor:pointer;user-select:none}
table.data th.sort:hover{color:var(--text)}
table.data th[aria-sort="descending"]::after{content:" ▼";font-size:10px}
table.data th[aria-sort="ascending"]::after{content:" ▲";font-size:10px}
table.data td.num,table.data th.num{text-align:right;font-variant-numeric:tabular-nums}
table.data tr.zero td{color:var(--muted)}
table.data a{color:var(--text);text-decoration:none}
table.data a:hover{text-decoration:underline;color:var(--accent)}
.acc{display:grid;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:10px}
.acc .a{background:var(--card2);border:1px solid var(--line);border-radius:8px;padding:10px 12px}
.acc .t{font-weight:650}
.acc .e{font-size:20px;margin-right:6px}
.acc .w{margin-top:4px}
.note{background:var(--card2);border:1px solid var(--line);border-left:3px solid var(--accent);border-radius:6px;padding:8px 12px;margin:10px 0;font-size:14px}
.toggle{display:inline-flex;gap:6px;align-items:center;margin:8px 0;font-size:14px;cursor:pointer}
footer{margin-top:18px;font-size:13px;color:var(--muted)}
.cmp-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,420px),1fr));gap:18px;align-items:start}
/* Ahead: a ★, a tint and an edge bar in the side's colour (blue us, orange them: the chart pair,
   checked for colour blindness), so it never relies on colour alone; text stays in the text colour */
table.cmp td.lead{font-weight:700;color:var(--text)}
table.cmp td.lead.us,.aheadkey.us{background:color-mix(in srgb,var(--us) 26%,transparent);box-shadow:inset -3px 0 0 var(--us)}
table.cmp td.lead.them,.aheadkey.them{background:color-mix(in srgb,var(--them) 26%,transparent);box-shadow:inset -3px 0 0 var(--them)}
.ahead{font-size:12px;margin-right:5px;vertical-align:0}
td.lead.us .ahead,.aheadkey.us .ahead{color:var(--us)}
td.lead.them .ahead,.aheadkey.them .ahead{color:var(--them)}
.aheadkey{display:inline-block;padding:1px 8px 1px 6px;border-radius:4px;color:var(--text);font-weight:600}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
table.cmp td.num{color:var(--muted)}
table.mirror{width:100%;border-collapse:collapse;font-size:13px}
table.mirror th{font-weight:600;color:var(--muted);padding:2px 6px;font-size:12.5px}
table.mirror td{padding:2px 0;height:22px;white-space:nowrap}
table.mirror td.l,table.mirror td.r{width:50%}
table.mirror td.c{text-align:center;white-space:nowrap;color:var(--muted);padding:0 8px;width:1%}
table.mirror td.l{text-align:right}
table.mirror .bar{display:inline-block;height:14px;vertical-align:middle}
table.mirror .bar.them{background:var(--them);border-radius:4px 0 0 4px}
table.mirror .bar.us{background:var(--us);border-radius:0 4px 4px 0}
table.mirror .n{display:inline-block;min-width:22px;padding:0 5px;font-variant-numeric:tabular-nums}
table.mirror td.l .n{text-align:right}
.ht{font-weight:600;margin:8px 0 4px}
.heatwrap{border:0}
table.heat{border-collapse:separate;border-spacing:2px;width:100%;min-width:430px;table-layout:fixed;font-size:10.5px}
table.heat th{color:var(--muted);font-weight:500;padding:0;text-align:center}
table.heat th:first-child{width:30px;text-align:left}
table.heat td{height:20px;border-radius:3px;text-align:center;color:var(--text);font-variant-numeric:tabular-nums}
table.heat td.own{outline:1px dotted var(--muted);outline-offset:-2px}
table.heat td.e{background:repeating-linear-gradient(135deg,var(--card2),var(--card2) 3px,var(--line) 3px,var(--line) 6px)}
.tile b{font-variant-numeric:tabular-nums}
.tiles.tiles3{grid-template-columns:repeat(auto-fit,minmax(min(100%,230px),1fr))}
/* Alternating rows on every list (report.js re-stripes after sorting and filtering, so hidden rows
   don't break the pattern; without the script, plain even rows) */
table.data tbody tr.alt td,.irdoc .ir-t tbody tr.alt td{background:var(--stripe)}
body.nojs table.data tbody tr:nth-child(even) td,body.nojs .irdoc .ir-t tbody tr:nth-child(even) td{background:var(--stripe)}
table.data tbody tr:hover td,.irdoc .ir-t tbody tr:hover td{background:var(--rowhover)}
/* Member dossier lists: 10 rows on show, the rest scroll inside the box under fixed headings */
.tablewrap.rows10{max-height:calc(34px + 10 * 36px + 2px);overflow:auto;overscroll-behavior:contain}
table.dossier th{height:34px;z-index:1}
table.dossier td{height:36px;padding-top:0;padding-bottom:0}
a.filebtn{display:inline-flex;align-items:center;justify-content:center;width:24px;height:22px;margin-right:8px;vertical-align:middle;border:1px solid var(--accent);border-radius:5px;color:var(--accent)}
a.filebtn:hover,a.filebtn:focus-visible{background:var(--accent);color:var(--accent-ink)}
table.data a.filebtn{color:var(--accent);text-decoration:none}
table.data a.filebtn:hover{color:var(--accent-ink)}
nav.tabs a.pagelink{margin:0 0 6px;border:1px solid var(--accent);color:var(--accent);font-weight:600;white-space:normal;line-height:1.3;flex:none}
nav.tabs a.pagelink:hover{background:var(--accent);color:var(--accent-ink)}
.pagenav{display:flex;gap:8px;flex-wrap:wrap;margin:-6px 0 14px}
.pagenav a{display:inline-block;padding:7px 14px;border:1px solid var(--accent);border-radius:8px;color:var(--accent);text-decoration:none;font-weight:600}
.pagenav a:hover{background:var(--accent);color:var(--accent-ink)}
nav.tabs .grp{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:var(--muted);padding:10px 10px 4px}
nav.tabs .grp:first-child{padding-top:4px}
/* The intelligence report (src/ui/intel.js), styled like Mentat's own Research tab */
.irdoc{--bg-2:var(--card2);--bg-3:var(--card2);--bg-4:var(--line);--row-line:var(--line);--row-hover:var(--rowhover);--chart-grid:var(--grid);--blue:var(--us);
  --green:var(--win);--yellow:#e8c15a;--orange:var(--them);--red:var(--loss);--pos:var(--win);--neg:var(--loss);--accent:var(--accent);
  --pill-bad-bg:var(--loss-bg);--pill-bad:var(--loss);--pill-info-bg:#1d2f4a;--pill-info:#a9c8f5;--pill-warn-bg:#40311a;--pill-warn:#f2cf8a;--pill-ok-bg:var(--win-bg);--pill-ok:var(--win);font-size:13px}
@media (prefers-color-scheme:light){:root:not([data-theme="dark"]) .irdoc{--yellow:#8a6400;--pill-info-bg:#dfeafc;--pill-info:#1e4f99;--pill-warn-bg:#fbeccd;--pill-warn:#7a4b00}}
.irdoc h2{font-size:14px;margin:18px 0 4px;text-transform:uppercase;letter-spacing:.4px;color:var(--accent)}
.irdoc h3{font-size:13px;margin:12px 0 6px}
.irdoc .ir-subtitle,.irdoc .ir-note{color:var(--muted);font-size:12px;margin-bottom:6px}
.irdoc .ir-banner{display:grid;grid-template-columns:1fr 1fr;border-radius:6px;overflow:hidden;background:var(--bg-3)}
.irdoc .ir-banner>div{padding:8px 12px;font-weight:600;font-size:12px;text-transform:uppercase}
.irdoc .ir-banner .ir-level{background:var(--bg-4);font-size:16px}
.irdoc .ir-banner .ir-why{grid-column:1/3;text-transform:none;font-weight:400;color:var(--muted)}
.irdoc .lvl-low .ir-level,.irdoc .lvl-strong .ir-level,.irdoc .lvl-good .ir-level{color:var(--green)}.irdoc .lvl-moderate .ir-level,.irdoc .lvl-fair .ir-level{color:var(--yellow)}.irdoc .lvl-high .ir-level{color:var(--orange)}.irdoc .lvl-severe .ir-level,.irdoc .lvl-poor .ir-level{color:var(--red)}
.irdoc .ir-tiles{display:grid;grid-template-columns:repeat(auto-fill,minmax(170px,1fr));gap:6px;margin:8px 0}
.irdoc .ir-tile{background:var(--bg-3);border:1px solid var(--line);border-radius:6px;padding:7px 10px}
.irdoc .ir-k{font-size:11px;color:var(--muted)}.irdoc .ir-v{font-size:18px;font-weight:700}.irdoc .ir-sub{font-size:11px;color:var(--muted);font-weight:400}
.irdoc .ir-list{margin:0;padding-left:18px}.irdoc .ir-list li{margin:3px 0}.irdoc .ir-notes{font-size:12px;color:var(--muted)}
.irdoc .ir-hh,.irdoc .ir-callout{background:var(--bg-3);border-left:3px solid var(--accent);padding:6px 10px;margin:4px 0;border-radius:4px}
.irdoc .ir-wrap{overflow-x:auto;border:1px solid var(--line);border-radius:8px}
.irdoc table.ir-t{border-collapse:collapse;width:100%;font-size:12px}
.irdoc .ir-t th{text-align:left;padding:5px 7px;background:var(--bg-2);color:var(--muted);white-space:nowrap;position:sticky;top:0}
.irdoc .ir-t th[data-k]{cursor:pointer;user-select:none}.irdoc .ir-t th.asc::after{content:" ▲"}.irdoc .ir-t th.desc::after{content:" ▼"}
.irdoc .ir-t td{padding:4px 7px;border-bottom:1px solid var(--row-line);vertical-align:top}
.irdoc .ir-t tbody tr:hover td{background:var(--row-hover)}
.irdoc .ir-t .num,.irdoc .ir-cols .num{text-align:right;font-variant-numeric:tabular-nums}
.irdoc .ir-mini{font-size:10px;color:var(--muted)}
.irdoc .ir-role{font-size:11px;padding:1px 6px;border-radius:9px;background:var(--bg-4);white-space:nowrap}
.irdoc .r-heavy{background:var(--pill-bad-bg);color:var(--pill-bad)}.irdoc .r-core{background:var(--pill-info-bg);color:var(--pill-info)}
.irdoc .r-surge{background:var(--pill-warn-bg);color:var(--pill-warn)}.irdoc .r-reg{background:var(--pill-ok-bg);color:var(--pill-ok)}.irdoc .r-new{color:var(--blue)}
.irdoc .ir-res.win{color:var(--pos);font-weight:700}.irdoc .ir-res.loss{color:var(--neg);font-weight:700}
/* Activity: the windows table takes the width it needs, the chart the rest (they used to overlap) */
.irdoc .ir-cols{display:grid;grid-template-columns:auto minmax(0,1fr);gap:18px;align-items:start}
.irdoc .ir-cols>*{min-width:0}
.irdoc .ir-small{width:auto}
.irdoc .ir-small td,.irdoc .ir-small th{white-space:nowrap}
.irdoc .ir-svg{display:block;width:100%;height:auto;max-height:260px}
.irdoc table.ir-hm{display:block;overflow-x:auto;max-width:100%}.irdoc .ir-grid{stroke:var(--chart-grid)}.irdoc .ir-axis{font-size:11px;fill:var(--muted)}.irdoc .ir-line{stroke:var(--blue);stroke-width:2;fill:none}
.irdoc .ir-chart-title{font-size:12px;font-weight:600;margin:8px 0 4px}
.irdoc table.ir-hm{border-collapse:collapse;font-size:10px}.irdoc .ir-hm th{color:var(--muted);font-weight:400;padding:1px 3px}
.irdoc .ir-hm td{width:28px;height:18px;text-align:center;border:1px solid var(--card)}.irdoc .ir-hm-empty{background:var(--bg-3)}
.irdoc .ir-hmt td{text-align:center}
.irdoc .ir-tools{display:flex;gap:10px;align-items:center;margin:4px 0 6px}
.irdoc .ir-filter{width:min(320px,100%);padding:6px 9px;border:1px solid var(--line);border-radius:6px;background:var(--bg);color:var(--text);font:inherit}
.irdoc .ir-count{color:var(--muted);font-size:12px}
.irdoc a{color:var(--text)}
/* Full current roster and Momentum: 10 members on show, the rest scroll inside the box under fixed
   headings (rows are a set height so exactly 10 fit; roster rows have a second line for the position) */
.irdoc .ir-wrap:has(> table[id$="ir-roster"]){max-height:calc(32px + 10 * 42px + 2px);overflow:auto;overscroll-behavior:contain}
.irdoc .ir-wrap:has(> table[id$="ir-mom"]),.irdoc .ir-wrap:has(> table[id$="ir-commit"]){max-height:calc(32px + 10 * 34px + 2px);overflow:auto;overscroll-behavior:contain}
.irdoc table[id$="ir-roster"] th,.irdoc table[id$="ir-mom"] th,.irdoc table[id$="ir-commit"] th{height:32px;z-index:1}
.irdoc table[id$="ir-roster"] td{height:42px;padding-top:0;padding-bottom:0;vertical-align:middle}
.irdoc table[id$="ir-mom"] td,.irdoc table[id$="ir-commit"] td{height:34px;padding-top:0;padding-bottom:0;vertical-align:middle;white-space:nowrap}
@media (max-width:900px){.irdoc .ir-cols{grid-template-columns:1fr}}
@media (max-width:600px){.irdoc .ir-small td,.irdoc .ir-small th{white-space:normal}.irdoc .ir-small{width:100%}.irdoc .ir-axis{font-size:19px}}
.irdoc-head{display:flex;gap:10px;align-items:baseline;flex-wrap:wrap;margin-bottom:6px}
.nojs .sec{display:block;margin-bottom:14px}
body.js:not(.showzero) table:not(.enemy) tr.zero{display:none}
@media (max-width:760px){
  .layout{grid-template-columns:minmax(0,1fr);gap:10px}
  .tiles{grid-template-columns:repeat(auto-fill,minmax(140px,1fr))}
  header.top h1{font-size:19px}
  nav.tabs{flex-direction:row;overflow-x:auto;top:0;z-index:3;border-radius:0 0 10px 10px;margin:0 -16px;border-left:0;border-right:0;border-top:0;padding:6px 10px;scrollbar-width:none}
  nav.tabs::-webkit-scrollbar{display:none}
  nav.tabs a{padding:7px 11px}
  nav.tabs .n{display:none}
  nav.tabs .grp{display:none}
  .score{font-size:32px}
  table.cmp th,table.cmp td{padding:6px 7px}
  table.cmp td:first-child{white-space:normal}
  table.cmp th{white-space:normal}
  table.heat{min-width:0;font-size:8.5px;border-spacing:1px}
  table.heat th:first-child{width:24px}
  table.heat td{height:17px;border-radius:2px}
  section.sec{padding:14px}
}
@media print{nav.tabs{display:none}.layout{display:block}section.sec{display:block!important;break-inside:avoid;margin-bottom:12px}}
`;

function head(title, extra = '') {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow"><meta name="referrer" content="no-referrer"><meta name="theme-color" content="#17120d">
<title>${esc(title)}</title><link rel="icon" href="/assets/mentat-mark.png">${extra}<style>${CSS}</style></head>`;
}

// A page while the report is being built (or couldn't be).
function waitingPage({ warId, error = '', progress = '' }) {
  const t = error ? 'War report unavailable' : 'Building the war report…';
  return `${head(t, error ? '' : '<meta http-equiv="refresh" content="10">')}<body><div class="wrap">
<header class="top"><img src="/assets/mentat-mark.png" alt=""><div><h1>${esc(t)}</h1><div class="sub">Ranked war${warId ? ` #${Number(warId)}` : ''}</div></div></header>
<section class="sec on">${error ? `<p>${esc(error)}</p><p class="muted small">Try again later.</p>`
    : `<p>Mentat is reading this war from Torn. This takes a minute the first time; after that the page opens straight away.</p><p class="muted small">${esc(progress || 'Starting…')} This page reloads itself.</p>`}</section>
</div></body></html>`;
}

function memberTable(rows, { chainBy = null, totalScore = 0, enemy = false } = {}) {
  const hasChain = !!chainBy && chainBy.size > 0;
  const cols = [
    ['#', 'num', 'rank'], ['Name', '', 'text'], ['Level', 'num', 'num'], ['War hits', 'num', 'num'], ['Score', 'num', 'num'], ['Pts / hit', 'num', 'num'], ['Share', 'num', 'num'],
    ...(hasChain ? [['Respect', 'num', 'num'], ['Best hit', 'num', 'num'], ['All hits', 'num', 'num'], ['Mugs', 'num', 'num'], ['Hosps', 'num', 'num'], ['Assists', 'num', 'num'], ['Retals', 'num', 'num'], ['Abroad', 'num', 'num'], ['Losses', 'num', 'num'], ['Bonus', 'num', 'num']] : []),
  ];
  let rank = 0;
  const body = rows.map(m => {
    const c = hasChain ? chainBy.get(m.id) : null;
    const zero = m.attacks === 0;
    if (!zero) rank++;
    const per = m.attacks ? m.score / m.attacks : 0;
    const cells = [
      [zero ? '' : rank, zero ? 9999 : rank], [profile(m.id, m.name), m.name.toLowerCase()], [m.level, m.level], [num(m.attacks), m.attacks], [pts(m.score), m.score], [m.attacks ? pts(per) : '–', per], [pct(m.score, totalScore), m.score],
      ...(hasChain ? (c ? [[pts(c.respect), c.respect], [pts(c.best), c.best], [num(c.total), c.total], [num(c.mug), c.mug], [num(c.hospitalize), c.hospitalize], [num(c.assists), c.assists], [num(c.retaliations), c.retaliations], [num(c.overseas), c.overseas], [num(c.losses), c.losses], [num(c.bonuses), c.bonuses]]
        : Array.from({ length: 10 }, () => ['–', -1])) : []),
    ];
    return `<tr${zero ? ' class="zero"' : ''}>${cells.map(([v, k], i) => `<td${cols[i][1] ? ` class="${cols[i][1]}"` : ''} data-k="${esc(k)}">${v}</td>`).join('')}</tr>`;
  }).join('');
  return `<div class="tablewrap"><table class="data sortable${enemy ? ' enemy' : ''}"><thead><tr>${cols.map(([l, cls, kind], i) => `<th class="sort${cls ? ` ${cls}` : ''}" data-kind="${kind}" data-col="${i}" tabindex="0" ${i === 4 ? 'aria-sort="descending"' : ''}>${esc(l)}</th>`).join('')}</tr></thead><tbody>${body}</tbody></table></div>`;
}

// ---- Comparison (server/compare.js buildComparison) ----
const DAYS = [['Mon', 1], ['Tue', 2], ['Wed', 3], ['Thu', 4], ['Fri', 5], ['Sat', 6], ['Sun', 0]];
const hourName = i => `${(DAYS.find(d => d[1] === Math.floor(i / 24)) || ['?'])[0]} ${String(i % 24).padStart(2, '0')}:00`;
function compact(n) {
  if (n == null || !Number.isFinite(n)) return '–';
  const a = Math.abs(n);
  if (a >= 1e12) return `${(n / 1e12).toFixed(2)}t`;
  if (a >= 1e9) return `${(n / 1e9).toFixed(2)}b`;
  if (a >= 1e6) return `${(n / 1e6).toFixed(a >= 1e8 ? 0 : 1)}m`;
  if (a >= 1e4) return `${(n / 1e3).toFixed(0)}k`;
  return num(n);
}
const ago = ms => { const m = Math.round((Date.now() - ms) / 60000); return m < 60 ? `${m} min ago` : m < 2880 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} days ago`; };

function mirrorBars(labels, them, us, T, U) {
  const max = Math.max(1, ...them, ...us);
  return `<table class="mirror"><thead><tr><th class="num">${esc(T)}</th><th></th><th>${esc(U)}</th></tr></thead><tbody>
    ${labels.map((l, i) => `<tr><td class="l"><span class="n">${them[i] || ''}</span><span class="bar them" style="width:${(them[i] / max) * 70}%"></span></td><td class="c">${esc(l)}</td><td class="r"><span class="bar us" style="width:${(us[i] / max) * 70}%"></span><span class="n">${us[i] || ''}</span></td></tr>`).join('')}
  </tbody></table>`;
}

const SRC_NAME = { f: 'FFScouter', o: "Mentat's activity history", m: "Mentat's research checks" };
function heat(cells, name, max, cls) {
  // Dotted: an hour filled from Mentat because FFScouter had none (only when the map is mostly FFScouter's)
  const hasF = cells.some(c => c && c[1] === 'f');
  const td = (c, i) => {
    if (!c) return `<td class="e" title="${hourName(i)} TCT: no data"></td>`;
    const p = Math.round(8 + Math.min(1, c[0] / max) * 82);
    return `<td class="${hasF && c[1] !== 'f' ? 'own' : ''}" style="background:color-mix(in srgb, var(--${cls}) ${p}%, var(--card2))" title="${esc(name)} · ${hourName(i)} TCT: ${c[0]} active on average (${SRC_NAME[c[1]] || 'Mentat'})">${c[0] >= 0.5 ? Math.round(c[0]) : ''}</td>`;
  };
  return `<div class="tablewrap heatwrap"><table class="heat"><thead><tr><th></th>${Array.from({ length: 24 }, (_, h) => `<th>${h % 3 === 0 ? String(h).padStart(2, '0') : ''}</th>`).join('')}</tr></thead><tbody>
    ${DAYS.map(([d, n]) => `<tr><th>${d}</th>${Array.from({ length: 24 }, (_, h) => td(cells[n * 24 + h], n * 24 + h)).join('')}</tr>`).join('')}</tbody></table></div>`;
}

// when: 'pre' (snapshot before the war, or rebuilt for its start), 'post' (made with the report),
// 'now' (a war announced or running). before: the pre-war comparison, for "Change during the war".
function comparisonHtml(c, { when = 'now', before = null, warStart = 0, files = '' } = {}) {
  const T = c.them, U = c.us;
  const lead = c.rebuilt
    ? `<div class="note">Rebuilt from research collected before the war: personal stats, past wars and chains as of the war's start (${timeTct(c.asOf)} TCT). Members, faction details, activity and FFScouter estimates are as they were when this was made (${timeTct(c.at)} TCT); Mentat takes a real snapshot before the war from now on.</div>`
    : when === 'pre' ? `<div class="note">Snapshot taken ${timeTct(c.at)} TCT${warStart && warStart > c.at ? `, ${dur(warStart - c.at)} before the war began` : ''}.</div>`
      : when === 'post' ? `<div class="note">As of ${timeTct(c.at)} TCT, after the war.</div>`
        : before ? `<div class="note">As of ${timeTct(c.at)} TCT, during the war.</div>`
          : `<div class="note">As of ${timeTct(c.at)} TCT. Refreshed every 10 minutes until the war begins, then frozen as the pre-war comparison.</div>`;
  const delta = (label, a, b, f) => {
    const d = (x, y) => (Number.isFinite(x) && Number.isFinite(y) ? y - x : null);
    const cell = v => (v == null ? '–' : `${v > 0 ? '+' : v < 0 ? '−' : ''}${f(Math.abs(v))}`);
    return `<tr><td>${label}</td><td class="num">${cell(d(a[0], a[1]))}</td><td class="num">${cell(d(b[0], b[1]))}</td></tr>`;
  };
  // A rebuilt pre-war comparison only has personal stats from before the war, so only those compare.
  const changes = before ? `<h3>Change during the war</h3><div class="muted small">${before.rebuilt ? `Personal stats from the war's start (${timeTct(before.asOf)} TCT)` : `Pre-war snapshot (${timeTct(before.at)} TCT)`} to ${timeTct(c.asOf)} TCT. Medians are of each side's members at each time.</div>
    <div class="tablewrap"><table class="data cmp"><thead><tr><th></th><th class="num"><span class="key them"></span>${esc(T.name)}</th><th class="num"><span class="key us"></span>${esc(U.name)}</th></tr></thead><tbody>
      ${before.rebuilt ? '' : `${delta('Members', [before.them.members, T.members], [before.us.members, U.members], num)}
      ${delta('Respect', [before.them.respect, T.respect], [before.us.respect, U.respect], compact)}
      ${delta('Est. battle stats, total', [before.them.bs && before.them.bs.total, T.bs && T.bs.total], [before.us.bs && before.us.bs.total, U.bs && U.bs.total], compact)}
      ${delta('Est. battle stats, top 5 average', [before.them.bs && before.them.bs.top5, T.bs && T.bs.top5], [before.us.bs && before.us.bs.top5, U.bs && U.bs.top5], compact)}`}
      ${c.psRows.map(([k, l]) => delta(`${l} (median)`, [before.them.ps[k], T.ps[k]], [before.us.ps[k], U.ps[k]], k === 'activity' ? v => `${compact(v / 3600)} h` : k === 'networth' ? v => `$${compact(v)}` : compact)).join('')}
    </tbody></table></div>` : '';
  const row = (label, a, b, f = num, more = 'high') => {
    const fa = a == null || a === '' ? '–' : f(a), fb = b == null || b === '' ? '–' : f(b);
    const better = more && Number.isFinite(a) && Number.isFinite(b) && a !== b ? ((more === 'high' ? b > a : b < a) ? 'us' : 'them') : '';
    // Ahead: a ★, a tint and an edge bar in that side's colour (never colour alone)
    const ahead = v => `<span class="ahead" aria-hidden="true">★</span>${v}<span class="sr"> (ahead)</span>`;
    return `<tr><td>${label}</td><td class="num${better === 'them' ? ' lead them' : ''}">${better === 'them' ? ahead(fa) : fa}</td><td class="num${better === 'us' ? ' lead us' : ''}">${better === 'us' ? ahead(fb) : fb}</td></tr>`;
  };
  const head = `<thead><tr><th></th><th class="num"><span class="key them"></span>${esc(T.name)}</th><th class="num"><span class="key us"></span>${esc(U.name)}</th></tr></thead>`;
  const max = Math.max(1, ...[...T.activity, ...U.activity].filter(Boolean).map(x => x[0]));
  const src = s => {
    const a = s.activityFrom;
    const parts = [];
    if (a.ffsHours) parts.push(`FFScouter ${a.ffsDays} days${a.ffsHours < 168 ? ` (${a.ffsHours} h)` : ''}`);
    if (a.obsHours) parts.push(`${parts.length ? '+ ' : ''}Mentat's activity history ${a.obsDays} day${a.obsDays === 1 ? '' : 's'}${parts.length ? ` (${a.obsHours} h)` : ''}`);
    if (a.ownHours) parts.push(`${parts.length ? '+ ' : ''}${a.ownHours} h from research checks`);
    return parts.join(' ') || 'no data yet';
  };
  const topTable = s => (s.top.length ? `<div class="tablewrap"><table class="data"><thead><tr><th>Member</th><th class="num">Level</th><th class="num">Est. stats</th><th>Usual hours (TCT)</th></tr></thead><tbody>
    ${s.top.map(x => `<tr><td>${profile(x.id, x.name)}${x.position ? ` <span class="muted small">${esc(x.position)}</span>` : ''}</td><td class="num">${num(x.level)}</td><td class="num">${compact(x.bs)}</td><td>${x.uh ? `${String(x.uh[0]).padStart(2, '0')}–${String(x.uh[1]).padStart(2, '0')} <span class="muted small">${Math.round(x.uh[2] * 100)}%</span>` : '–'}</td></tr>`).join('')}</tbody></table></div>` : '<div class="muted small">No FFScouter estimates shared yet.</div>');
  const wl = s => `${s.wins}–${s.losses}`;
  return `${lead}
    <div class="muted small" style="margin-bottom:8px"><span class="aheadkey us"><span class="ahead">★</span>us</span> <span class="aheadkey them"><span class="ahead">★</span>them</span> marks who is ahead. Battle stats and activity are from FFScouter${c.ffsAt ? ` (loaded ${ago(c.ffsAt)})` : ' (none shared yet)'}; everything else is from Torn's API, read ${ago(c.at)}.</div>
    <div class="cmp-grid">
      <div><h3 style="margin-top:0">Head to head</h3><div class="tablewrap"><table class="data cmp">${head}<tbody>
        ${row('Members', T.members, U.members)}
        ${row('Respect', T.respect, U.respect, compact)}
        ${row('Rank', T.rank, U.rank, esc, '')}
        ${row('Ranked wars won–lost (last 20)', wl(T), wl(U), x => x, '')}
        ${row('Best chain ever', T.bestChain, U.bestChain)}
        ${row('Chains, last 30 days', T.chains30, U.chains30)}
        ${row('Longest chain, last 30 days', T.longest30, U.longest30)}
        ${row('Median level', T.levelMedian, U.levelMedian)}
        ${row('Inactive 3+ days', T.inactive, U.inactive, num, 'low')}
        ${row('Revivers (skill 50+ or 500+ revives)', T.revivers, U.revivers)}
        ${row('Faction age (days)', T.daysOld, U.daysOld, num, '')}
      </tbody></table></div></div>
      <div><h3 style="margin-top:0">Estimated battle stats</h3>
        ${T.bs || U.bs ? `<div class="tablewrap"><table class="data cmp">${head}<tbody>
          ${row('Total', T.bs && T.bs.total, U.bs && U.bs.total, compact)}
          ${row('Median member', T.bs && T.bs.median, U.bs && U.bs.median, compact)}
          ${row('Top 5 average', T.bs && T.bs.top5, U.bs && U.bs.top5, compact)}
          ${row('Estimates known', T.bs ? `${T.bs.known}/${T.members}` : null, U.bs ? `${U.bs.known}/${U.members}` : null, x => x, '')}
        </tbody></table></div>
        <h3>Spread</h3>${mirrorBars(c.bsBuckets, T.bs ? T.bs.buckets : c.bsBuckets.map(() => 0), U.bs ? U.bs.buckets : c.bsBuckets.map(() => 0), T.name, U.name)}`
    : '<div class="note">No FFScouter estimates shared yet. They come from a Mentat device with an FFScouter key.</div>'}
        <h3>Levels</h3>${mirrorBars(c.lvlBuckets, T.levels, U.levels, T.name, U.name)}</div>
    </div>

    <h3>Activity by hour (TCT)</h3>
    <div class="muted small">Average members active in each hour of the week. FFScouter's activity scanner first; hours it has no data for come from Mentat's own activity history (dotted), which covers every faction around our rank for weeks before a war. Darker = more active.</div>
    <div class="cmp-grid">
      <div><div class="ht"><span class="key them"></span>${esc(T.name)} <span class="muted small">· ${src(T)}</span></div>${heat(T.activity, T.name, max, 'them')}</div>
      <div><div class="ht"><span class="key us"></span>${esc(U.name)} <span class="muted small">· ${src(U)}</span></div>${heat(U.activity, U.name, max, 'us')}</div>
    </div>
    <div class="tiles tiles3">
      <div class="tile"><div class="l">Their busiest hours</div>${c.peak.map(([i, v]) => `<div>${hourName(i)} <b>${v}</b></div>`).join('') || '<div class="muted">no data</div>'}</div>
      <div class="tile"><div class="l">Their quietest hours</div>${c.quiet.map(([i, v]) => `<div>${hourName(i)} <b>${v}</b></div>`).join('') || '<div class="muted">no data</div>'}</div>
      <div class="tile"><div class="l">Our best hours (us vs them)</div>${c.edge.map(([i, d, u, t]) => `<div>${hourName(i)} <b>${d >= 0 ? '+' : ''}${d}</b> <span class="muted small">${u} vs ${t}</span></div>`).join('') || '<div class="muted">no data</div>'}</div>
    </div>

    <h3>Personal stats (median member)</h3>
    <div class="tablewrap"><table class="data cmp">${head}<tbody>
      ${c.psRows.map(([k, l]) => row(l, T.ps[k], U.ps[k], k === 'activity' ? v => `${compact(v / 3600)} h` : k === 'networth' ? v => `$${compact(v)}` : compact)).join('')}
      ${row('Xanax per day', T.xanPace, U.xanPace, v => v.toFixed(1))}
      ${row('Members with personal stats read', T.psKnown, U.psKnown, num, '')}
    </tbody></table></div>

    <div class="cmp-grid">
      <div><h3>Their strongest (est. stats)</h3>${topTable(T)}</div>
      <div><h3>Our strongest (est. stats)</h3>${topTable(U)}</div>
    </div>
    ${T.dossier ? `<h3>Member dossiers</h3><div class="muted small">Every member: FFScouter's estimate and usual hours, how often Mentat's checks saw them online, and their public personal stats${c.rebuilt ? ' as of the war start' : ''}. Click a column to sort.</div>
      <div class="ht" style="margin-top:10px"><span class="key them"></span>${esc(T.name)} <span class="muted small">· ${T.dossier.length} members${T.dossier.length > 10 ? ', scroll the list for the rest' : ''}</span></div>${dossierTable(T, c.asOf, files)}
      <div class="ht" style="margin-top:14px"><span class="key us"></span>${esc(U.name)} <span class="muted small">· ${U.dossier.length} members${U.dossier.length > 10 ? ', scroll the list for the rest' : ''}</span></div>${dossierTable(U, c.asOf, files)}` : ''}
    ${changes}`;
}

const DOSSIER_COLS = [['Member', 'text'], ['Lvl', 'num'], ['Est. stats', 'num'], ['Usual hours (TCT)', 'text'], ['Online', 'num'], ['Last action', 'num'], ['Xanax', 'num'], ['Xan / day', 'num'], ['Refills', 'num'], ['Elo', 'num'], ['RW hits', 'num'], ['Revives', 'num'], ['Streak', 'num']];
// A small case-folder icon: the button before a member's name that opens their dossier
const FILE_ICON = '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M1.5 3.5a1 1 0 0 1 1-1h3.6l1.5 1.6h5.9a1 1 0 0 1 1 1v7.4a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/><path d="M4.5 8.2h7M4.5 10.6h4.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>';
function dossierTable(s, asOf, files = '') {
  const n = v => (Number.isFinite(v) ? v : -1);
  const cell = (k, text, cls = 'num') => `<td class="${cls}" data-k="${esc(k)}">${text}</td>`;
  const rows = s.dossier.map(d => `<tr>
    ${cell(d.name.toLowerCase(), `${files ? `<a class="filebtn" href="${esc(files)}#m-${d.id}" title="Open ${esc(d.name)}'s dossier" aria-label="Open ${esc(d.name)}'s dossier">${FILE_ICON}</a>` : ''}${profile(d.id, d.name)}${d.position ? ` <span class="muted small">${esc(d.position)}</span>` : ''}`, '')}
    ${cell(n(d.level), num(d.level))}${cell(n(d.bs), d.bs ? compact(d.bs) : '–')}
    ${cell(d.uh ? String(d.uh[0]).padStart(2, '0') : 'zz', d.uh ? `${String(d.uh[0]).padStart(2, '0')}–${String(d.uh[1]).padStart(2, '0')} <span class="muted small">${Math.round(d.uh[2] * 100)}%</span>` : '–', '')}
    ${cell(n(d.online), d.online == null ? '–' : `${Math.round(d.online * 100)}%`)}
    ${cell(n(d.lastAt), d.lastAt ? (asOf - d.lastAt > 0 ? `${dur(asOf - d.lastAt)} before` : 'after') : '–')}
    ${cell(n(d.xanax), d.xanax == null ? '–' : compact(d.xanax))}${cell(n(d.xanPace), d.xanPace == null ? '–' : d.xanPace.toFixed(1))}
    ${cell(n(d.refills), d.refills == null ? '–' : compact(d.refills))}${cell(n(d.elo), d.elo == null ? '–' : num(d.elo))}
    ${cell(n(d.rwHits), d.rwHits == null ? '–' : compact(d.rwHits))}${cell(n(d.revives), d.revives == null ? '–' : compact(d.revives))}${cell(n(d.streak), d.streak == null ? '–' : num(d.streak))}</tr>`).join('');
  return `<div class="tablewrap rows10"><table class="data sortable dossier"><thead><tr>${DOSSIER_COLS.map(([l, k], i) => `<th class="sort${k === 'num' ? ' num' : ''}" data-kind="${k}" data-col="${i}" tabindex="0"${i === 2 ? ' aria-sort="descending"' : ''}>${esc(l)}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table></div>`;
}

// Navigation + sections. sections: [id, label, count, html, group]; a group heading shows in the
// side bar whenever the group changes (hidden on phones, where the tabs run across the top).
// links: [[path, label]] to the other page(s): at the top of the side bar, and as buttons under the
// page title (pageNav), so moving between the report and the member dossiers is always one click.
function pageNav(links) {
  return links.length ? `<div class="pagenav">${links.map(([href, label]) => `<a href="${esc(href)}">${esc(label)}</a>`).join('')}</div>` : '';
}
function layoutHtml(sections, { links = [], find = '' } = {}) {
  let grp = null;
  // [5]: the side bar's own label (HTML), when it differs from the section title
  const nav = sections.map(([id, label, n, , g, navHtml], i) => {
    const head = g && g !== grp ? `<div class="grp">${esc(g)}</div>` : '';
    grp = g || grp;
    return `${head}<a href="#${id}" data-tab="${id}"${i === 0 ? ' class="on" aria-current="true"' : ''}>${navHtml || label}${n !== '' && n != null ? `<span class="n">${esc(n)}</span>` : ''}</a>`;
  }).join('');
  const extra = links.map(([href, label]) => `<a class="pagelink" href="${esc(href)}">${esc(label)}</a>`).join('');
  // With a find box (the member list): the box and the page links stay put, only the list scrolls.
  const list = find ? `<div class="navlist">${nav}</div>` : nav;
  return `${pageNav(links)}<div class="layout"><nav class="tabs" aria-label="Report sections">${find ? `<input class="navfind" type="search" placeholder="${esc(find)}" aria-label="${esc(find)}">` : ''}${extra}${list}</nav>
<main>${sections.map(([id, label, , html], i) => `<section class="sec${i === 0 ? ' on' : ''}" id="sec-${id}" data-tab="${id}" aria-label="${label}"><h2>${label}</h2>${html}</section>`).join('\n')}</main></div>`;
  // Sections' ids differ from the links (#m-123 shows section sec-m-123), so the browser doesn't
  // scroll down to them past the title and its buttons; report.js shows them as tabs.
}

// The app's intelligence report for one faction (server/intelrun.js), in a section.
function intelSection(x, note) {
  return `<div class="muted small irdoc-head">${note}</div><div class="irdoc">${x.html}</div>`;
}

// The Opposition Research Report's sections: comparison, the enemy's intelligence report and ours.
// pre: { comparison, intel: { them, us }, at, rebuilt } as kept by the server.
function oppoSections(pre, { warStart = 0, live = false, files = '' } = {}) {
  const G = 'Opposition Research Report';
  const out = [];
  const c = pre.comparison;
  const T = c.them.name, U = c.us.name;
  out.push(['prewar', 'Comparison', '', comparisonHtml(c, { when: live ? 'now' : 'pre', warStart, files }), G]);
  const when = pre.rebuilt ? `Rebuilt for the war's start: wars and chains before ${timeTct(warStart)} TCT; members and activity as of ${timeTct(pre.at)} TCT.`
    : live ? `As of ${timeTct(pre.at)} TCT; refreshed every 10 minutes until the war begins.` : `Snapshot taken ${timeTct(pre.at)} TCT, before the war began.`;
  if (pre.intel && pre.intel.them) out.push(['intel-them', `${T.length > 16 ? 'Enemy' : esc(T)} intel`, pre.intel.them.wars || '', intelSection(pre.intel.them, `Enemy historical intelligence: the same report as Mentat's Research → Report. ${when}`), G]);
  if (pre.intel && pre.intel.us) out.push(['intel-us', `${U.length > 16 ? 'Our' : esc(U)} record`, pre.intel.us.wars || '', intelSection(pre.intel.us, `Our own war performance: the same report as Mentat's My Faction tab. ${when}`), G]);
  return out;
}

// A ranked war announced or running, its report not made yet. Before it starts: the comparison as
// it is now (this is what gets frozen as the pre-war one). While it runs: the frozen pre-war one
// and, when given, the comparison now.
function oppoPage({ pre = null, now = null, war = null, base = '' }) {
  const c = (pre && pre.comparison) || now;
  const T = c.them, U = c.us;
  const started = war && war.start <= Date.now();
  const when = war ? (!started ? `starts ${timeTct(war.start)} TCT` : `running since ${timeTct(war.start)} TCT`) : '';
  const sections = pre ? oppoSections(pre, { warStart: war ? war.start : 0, live: !started, files: pre.dossiers ? `${base}/members` : '' }) : [];
  if (started && now) sections.push(['now', 'Comparison now', '', comparisonHtml(now, { when: 'now', before: pre && pre.comparison }), 'During the war']);
  return `${head(`Opposition Research Report · ${U.name} vs ${T.name}`)}<body class="nojs"><div class="wrap">
<header class="top"><img src="/assets/mentat-mark.png" alt=""><div><h1>Opposition Research Report<br><span style="font-size:.8em">${esc(U.name)} <span class="muted">vs</span> ${esc(T.name)}</span></h1>
<div class="sub">${war ? `Ranked war #${Number(war.id)} ${when}` : ''}${war ? ' · the war report joins this page at the same link when the war ends' : ''}</div></div></header>
${layoutHtml(sections, { links: pre && pre.dossiers ? [[`${base}/members`, 'Member dossiers →']] : [] })}
<footer>Made by Mentat from Torn's API and FFScouter. ${started ? 'The Opposition Research Report was frozen when the war began; "Comparison now"' : 'It'} refreshes every 10 minutes.</footer>
</div><script type="application/json" id="wr-data">{}</script><script src="/war/report.js?v=${clientVersion()}"></script></body></html>`;
}

// ---- Member dossiers: a second page, one file per member of both factions ----
// (the user's request, 2026-11-24: "look like a government file, for fun, while keeping the
// Mentat theme"). pre.dossiers = { them: [...], us: [...] } from server/dossier.js; photos: id -> url.
const FILE_CSS = `
.file{position:relative;background:linear-gradient(180deg,var(--card),var(--card2));border:1px solid var(--line);border-radius:4px 10px 10px 10px;padding:26px 26px 22px;margin-top:22px;font-family:ui-monospace,"Cascadia Mono","Consolas","Courier New",monospace;font-size:13.5px}
.file::before{content:"";position:absolute;inset:0;pointer-events:none;border-radius:inherit;background:repeating-linear-gradient(0deg,transparent 0 3px,rgba(222,188,160,.035) 3px 4px)}
.file .tab{position:absolute;top:-21px;left:-1px;background:var(--card2);border:1px solid var(--line);border-bottom:0;border-radius:8px 8px 0 0;padding:3px 14px;font-size:11.5px;letter-spacing:1.5px;color:var(--accent)}
.file .hud{position:absolute;width:16px;height:16px;border:2px solid var(--accent);opacity:.7}
.file .hud.tl{top:8px;left:8px;border-right:0;border-bottom:0}.file .hud.tr{top:8px;right:8px;border-left:0;border-bottom:0}
.file .hud.bl{bottom:8px;left:8px;border-right:0;border-top:0}.file .hud.br{bottom:8px;right:8px;border-left:0;border-top:0}
.file .agency{display:grid;grid-template-columns:1fr auto 1fr;align-items:center;gap:10px;border-bottom:2px solid var(--accent);padding-bottom:8px;margin-bottom:16px;letter-spacing:1.2px;font-size:11.5px;color:var(--muted)}
.file .agency b{color:var(--accent);font-size:13px}
.file .stamp{justify-self:center;transform:rotate(-8deg);border:3px double var(--stamp);color:var(--stamp);padding:4px 12px;font-weight:800;letter-spacing:3px;font-size:20px;opacity:.85;text-transform:uppercase;pointer-events:none;mix-blend-mode:normal}
.file.hostile{--stamp:#e0574b}.file.friendly{--stamp:#5fbf7f}
.file .top{display:grid;grid-template-columns:200px minmax(0,1fr);gap:22px;align-items:start}
.file .photo{position:relative;background:#e9dcc6;padding:8px 8px 26px;transform:rotate(-2deg);box-shadow:0 6px 16px rgba(0,0,0,.45);width:190px}
.file .photo img,.file .photo .none{display:block;width:174px;height:200px;object-fit:cover;object-position:50% 15%;background:#2a2119;filter:sepia(.25) contrast(1.05)}
.file .photo .none{display:flex;align-items:center;justify-content:center;text-align:center;color:#b99573;font-size:12px;letter-spacing:1px}
.file .photo .cap{position:absolute;left:0;right:0;bottom:5px;text-align:center;color:#3b2e22;font-size:11px;letter-spacing:1px}
.file .photo .clip{position:absolute;top:-14px;left:22px;width:16px;height:46px;border:3px solid #9aa1a8;border-radius:9px;border-bottom-color:transparent;transform:rotate(8deg)}
.file .fields{display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:6px 18px}
.file .f{border-bottom:1px dashed var(--line);padding:3px 0}
.file .f .k{font-size:10.5px;letter-spacing:1.4px;color:var(--muted);text-transform:uppercase}
.file .f .v{font-size:15px;color:var(--text);font-weight:600;overflow-wrap:anywhere}
.file .redact{display:inline-block;background:#050403;border:1px solid var(--line);color:transparent;border-radius:2px;user-select:none;line-height:1.1}
.file h4{margin:22px 0 8px;font-size:12.5px;letter-spacing:2px;color:var(--accent);text-transform:uppercase;border-bottom:1px solid var(--line);padding-bottom:4px}
.file .meter{height:8px;background:var(--line);border-radius:4px;overflow:hidden;margin-top:4px}
.file .meter i{display:block;height:100%;background:var(--accent)}
.file table.data{font-family:inherit;font-size:12.5px}
.file .bars{display:block;width:100%;height:auto;overflow:visible}
.file .bars rect.b{fill:var(--accent)}.file .bars rect.e{fill:var(--line)}
.file .bars text{fill:var(--muted);font-size:10px;font-family:inherit}
.file .bars .gridl{stroke:var(--grid)}
.file .foot{margin-top:22px;border-top:2px solid var(--accent);padding-top:8px;font-size:10.5px;letter-spacing:1.2px;color:var(--muted);text-transform:uppercase;display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap}
.file .note{font-family:"Segoe UI",system-ui,sans-serif}
nav.tabs .navfind{width:100%;margin:2px 0 6px;padding:7px 9px;border:1px solid var(--line);border-radius:6px;background:var(--bg);color:var(--text);font:inherit;font-size:14px}
nav.tabs [hidden]{display:none}
nav.tabs a .lv{margin-left:auto;font-size:11.5px;color:var(--muted)}
nav.tabs a.on .lv{color:inherit}
nav.tabs.members{max-height:calc(100vh - 24px);overflow:hidden}
nav.tabs .navlist{position:relative;display:flex;flex-direction:column;gap:2px;overflow-y:auto;min-height:0;scrollbar-width:thin}
@media (max-width:760px){
  .file{padding:22px 14px 16px}
  .file .top{grid-template-columns:1fr}
  .file .photo{margin:0 auto 8px}
  .file .agency{grid-template-columns:1fr auto}.file .agency>span:last-child{grid-column:1/3;text-align:left!important}.file .stamp{font-size:14px;letter-spacing:2px;padding:3px 8px}
  nav.tabs.members{max-height:none;overflow:hidden;align-items:center}
  nav.tabs .navlist{flex-direction:row;overflow-x:auto;overflow-y:visible;flex:1;min-width:0;scrollbar-width:none}
  nav.tabs .navlist::-webkit-scrollbar{display:none}
  nav.tabs .navfind{width:110px;flex:none;margin:0 6px 0 0}
  nav.tabs a.pagelink{margin:0 6px 0 0;flex:none;max-width:42vw;overflow:hidden;text-overflow:ellipsis}
}`;

const fmtPct = x => (x == null ? '–' : `${Math.round(x * 100)}%`);
const fmtSigned = x => (x == null ? '–' : `${x >= 0 ? '+' : '−'}${Math.round(Math.abs(x) * 100)}%`);
const PS_LABELS = [['xanax', 'Xanax taken'], ['refills', 'Energy refills'], ['ses', 'Stat enhancers'], ['cans', 'Energy drinks'], ['boosters', 'Boosters'], ['attacksWon', 'Attacks won'], ['attacksLost', 'Attacks lost'],
  ['defendsWon', 'Defends won'], ['defendsLost', 'Defends lost'], ['elo', 'Elo rating'], ['rwHits', 'Ranked war hits'], ['rwWins', 'Ranked war wins'], ['respect', 'Respect earned'], ['bestDamage', 'Best damage'],
  ['killstreak', 'Best kill streak'], ['reviveSkill', 'Revive skill'], ['revives', 'Revives given'], ['activity', 'Time played'], ['streak', 'Login streak'], ['networth', 'Net worth']];
const psFmt = (k, v) => (v == null ? '–' : k === 'activity' ? `${num(v / 3600)} h` : k === 'networth' ? `$${compact(v)}` : k === 'elo' || k === 'reviveSkill' || k === 'streak' ? num(v) : compact(v));

function hoursSvg(h) {
  if (!h || !h.h.some(v => v != null)) return '<div class="muted small">No activity readings on file.</div>';
  const W = 720, H = 150, pl = 34, pb = 20, pt = 8, bw = (W - pl) / 24;
  const y = v => pt + (1 - v) * (H - pt - pb);
  const grid = [0, 0.5, 1].map(f => `<line class="gridl" x1="${pl}" x2="${W}" y1="${y(f)}" y2="${y(f)}"/><text x="${pl - 6}" y="${y(f) + 3}" text-anchor="end">${f * 100}%</text>`).join('');
  const bars = h.h.map((v, i) => {
    const x = pl + i * bw + 1;
    const lab = `${String(i).padStart(2, '0')}:00–${String((i + 1) % 24).padStart(2, '0')}:00 TCT: ${v == null ? 'no readings' : `active ${Math.round(v * 100)}% of the time`}`;
    if (v == null) return `<rect class="e" x="${x}" y="${y(0) - 2}" width="${bw - 2}" height="2"><title>${lab}</title></rect>`;
    const top = y(v), r = Math.min(3, (bw - 2) / 2, y(0) - top);
    return `<path class="b" d="M${x},${y(0)}V${top + r}Q${x},${top} ${x + r},${top}H${x + bw - 2 - r}Q${x + bw - 2},${top} ${x + bw - 2},${top + r}V${y(0)}Z" style="fill:var(--accent)"><title>${lab}</title></path>`;
  }).join('');
  const xs = [0, 3, 6, 9, 12, 15, 18, 21].map(i => `<text x="${pl + i * bw + bw / 2}" y="${H - 5}" text-anchor="middle">${String(i).padStart(2, '0')}</text>`).join('');
  return `<svg class="bars" viewBox="0 0 ${W} ${H}" role="img" aria-label="Share of time active in each hour of the day">${grid}${bars}${xs}</svg>
    <div class="muted small">Share of ${h.from === 'f' ? "FFScouter's 15-minute readings" : h.from === 'o' ? "Mentat's activity history (15-minute slots)" : "Mentat's research checks"} in which they were active, by hour of the day (TCT). Hover a bar for the number.</div>`;
}

function dossierFile(d, { side, faction, warId, photo, asOf }) {
  const hostile = side === 'them';
  const ref = `MTD-${Number(warId) || 0}-${d.id}`;
  const field = (k, v) => `<div class="f"><div class="k">${k}</div><div class="v">${v}</div></div>`;
  const lastSeen = d.lastAt ? (asOf - d.lastAt >= 0 ? `${dur(asOf - d.lastAt)} before filing` : 'after filing') : '–';
  const threat = d.threat == null ? '–' : `${d.threat.toFixed(1)} / 100<div class="meter"><i style="width:${Math.max(2, Math.min(100, d.threat))}%"></i></div>`;
  const tbl = (head, rows) => `<div class="tablewrap"><table class="data"><thead><tr>${head.map(([l, n]) => `<th${n ? ' class="num"' : ''}>${l}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table></div>`;
  const c = d.chain, mo = d.momentum;
  return `<div class="file ${hostile ? 'hostile' : 'friendly'}">
  <div class="tab">CASE FILE No. ${esc(ref)}</div>
  <span class="hud tl"></span><span class="hud tr"></span><span class="hud bl"></span><span class="hud br"></span>
  <div class="agency"><span><b>MENTAT INTELLIGENCE DIRECTORATE</b><br>OPPOSITION RESEARCH DIVISION</span><span class="stamp">${hostile ? 'Classified' : 'Personnel'}</span><span style="text-align:right">${hostile ? 'SUBJECT FILE · HOSTILE' : 'PERSONNEL FILE · FRIENDLY'}<br>FILED ${esc(timeTct(asOf))} TCT</span></div>
  <div class="top">
    <div class="photo"><span class="clip"></span>${photo ? `<img src="${esc(photo)}" alt="Profile picture of ${esc(d.name)}" loading="lazy" referrerpolicy="no-referrer">` : '<div class="none">NO PHOTO<br>ON FILE</div>'}<div class="cap">EXHIBIT A · ${d.id}</div></div>
    <div><div class="fields">
      ${field('Subject', profile(d.id, d.name))}${field('Torn ID', d.id)}
      ${field('Affiliation', esc(faction))}${field('Position', esc(d.position || '–'))}
      ${field('Level', num(d.level))}${field('Tenure', `${num(d.days)} days`)}
      ${field('Classification', esc(d.role || 'Unassessed'))}${field(hostile ? 'Threat rating' : 'Impact rating', threat)}
      ${field('Estimated battle stats', d.est ? `${compact(d.est)}${d.growth10 != null ? ` <span class="muted small">${fmtSigned(d.growth10)} in 10 wk</span>` : ''}` : '–')}
      ${field('Usual hours (TCT)', esc(d.usual || '–'))}
      ${field('Last seen', esc(lastSeen))}${field('Status at filing', esc(d.status || '–'))}
      ${field('Revivable', d.revivable ? 'Yes' : 'No')}${field('Known residence', '<span class="redact">██████████</span> <span class="muted small">[REDACTED]</span>')}
    </div></div>
  </div>

  <h4>§1 Assessment</h4>
  <div class="fields">
    ${field('Wars eligible / active', `${d.eligible} / ${d.active}`)}${field('Participation', fmtPct(d.participation))}
    ${field('Hits per war', d.avgWar == null ? '–' : d.avgWar.toFixed(1))}${field('Hits when active', d.avgActive == null ? '–' : d.avgActive.toFixed(1))}
    ${field('Peak war', `${num(d.peak)} hits`)}${field('Share of faction hits', fmtPct(d.share))}
    ${field('Score per hit', d.perHit == null ? '–' : d.perHit.toFixed(2))}${field('Consistency', fmtPct(d.consistency))}
    ${field('In wins / losses', `${d.avgWin == null ? '–' : d.avgWin.toFixed(1)} / ${d.avgLoss == null ? '–' : d.avgLoss.toFixed(1)} hits`)}${field('Trend', esc(d.trend || '–'))}
  </div>

  <h4>§2 Combat record (ranked wars)</h4>
  ${d.wars.length ? tbl([['Ended'], ['Opponent'], ['Result'], ['Hits', 1], ['Score', 1]], d.wars.map(w => `<tr><td>${dateTct(w.end)}</td><td>${esc(w.opp)}</td><td>${w.decided ? (w.won ? 'Won' : 'Lost') : '–'}</td><td class="num">${num(w.hits)}</td><td class="num">${pts(w.score)}</td></tr>`).join(''))
    : '<div class="muted small">No ranked war hits on file for this faction.</div>'}

  <h4>§3 Chain activity (during those wars)</h4>
  ${c ? `<div class="fields">${field('Chains joined', num(c.chains))}${field('Sat out', num(d.sitOuts))}${field('Hits', num(c.total))}${field('War hits', num(c.war))}
    ${field('Assists', num(c.assists))}${field('Retaliations', num(c.retals))}${field('Hits abroad', num(c.overseas))}${field('Losses', num(c.losses))}
    ${field('Hospitalise / leave / mug', c.total ? `${fmtPct(c.hosp / c.total)} / ${fmtPct(c.leave / c.total)} / ${fmtPct(c.mug / c.total)}` : '–')}${field('Respect per hit', c.total ? (c.respect / c.total).toFixed(2) : '–')}
    ${field('Best hit', c.best == null ? '–' : `${c.best} respect`)}${field('Bonus hits', num(c.bonuses))}</div>` : '<div class="muted small">No chain activity on file.</div>'}

  <h4>§4 Habits &amp; momentum (per week, last ${mo && mo.weeks ? Math.round(mo.weeks) : 10} weeks)</h4>
  ${mo ? `<div class="fields">${field('Hours played', `${mo.hours == null ? '–' : mo.hours.toFixed(1)}${mo.hoursRecent != null ? ` <span class="muted small">last 2 wk ${mo.hoursRecent.toFixed(1)}</span>` : ''}`)}
    ${field('Xanax', mo.xan == null ? '–' : mo.xan.toFixed(1))}${field('Energy refills', mo.refills == null ? '–' : mo.refills.toFixed(1))}${field('Energy drinks', mo.cans == null ? '–' : mo.cans.toFixed(1))}
    ${field('Stat enhancers', mo.se == null ? '–' : mo.se.toFixed(1))}${field('Attacks won', mo.attacks == null ? '–' : mo.attacks.toFixed(1))}${field('Ranked war hits', mo.rwhits == null ? '–' : mo.rwhits.toFixed(1))}
    ${field('Active streak', mo.streak == null ? '–' : `${num(mo.streak)} days`)}</div>` : '<div class="muted small">No weekly snapshots on file yet.</div>'}

  ${d.commit.length ? `<h4>§5 Commitment during recent wars</h4>${tbl([['War'], ['Xanax', 1], ['Refills', 1], ['Cans', 1], ['Hours on', 1], ['RW hits', 1]], d.commit.map(x => `<tr><td>vs ${esc(x.opp)} <span class="muted small">${dateTct(x.end)}</span></td><td class="num">${x.xan == null ? '–' : num(x.xan)}</td><td class="num">${x.refills == null ? '–' : num(x.refills)}</td><td class="num">${x.cans == null ? '–' : num(x.cans)}</td><td class="num">${x.hours == null ? '–' : x.hours.toFixed(1)}</td><td class="num">${x.rwhits == null ? '–' : num(x.rwhits)}</td></tr>`).join(''))}` : ''}

  <h4>§6 Activity pattern</h4>
  ${hoursSvg(d.hours)}

  <h4>§7 Personal statistics (public)</h4>
  ${d.ps ? `<div class="fields">${PS_LABELS.filter(([k]) => d.ps[k] != null).map(([k, l]) => field(l, `${psFmt(k, d.ps[k])}${d.pace[k] != null ? ` <span class="muted small">${k === 'activity' ? `${(d.pace[k] / 3600).toFixed(1)} h` : d.pace[k].toFixed(1)}/day</span>` : ''}`)).join('')}</div>
    <div class="muted small" style="margin-top:6px">As read ${esc(timeTct(d.psAt))} TCT.</div>` : '<div class="muted small">Not read yet.</div>'}

  <h4>§8 Known associations</h4>
  ${d.prior.length ? tbl([['Faction'], ['War'], ['Ended'], ['Hits', 1]], d.prior.map(p => `<tr><td>${esc(p.faction)}</td><td>vs ${esc(p.opp)}</td><td>${dateTct(p.end)}</td><td class="num">${num(p.hits)}</td></tr>`).join(''))
    : '<div class="muted small">No ranked wars on file with other factions.</div>'}

  <div class="foot"><span>Distribution: faction members only</span><span>Ref ${esc(ref)} · Mentat</span></div>
</div>`;
}

function membersPage({ pre, war = null, photos = {}, back = '', finished = false }) {
  const c = pre.comparison;
  const T = c.them.name, U = c.us.name;
  const asOf = c.asOf || pre.at;
  const warId = war ? war.id : 0;
  const sections = [];
  for (const [side, name, list] of [['them', T, pre.dossiers.them || []], ['us', U, pre.dossiers.us || []]]) {
    for (const d of list) {
      sections.push([`m-${d.id}`, esc(d.name), '', dossierFile(d, { side, faction: name, warId, photo: photos[d.id] || '', asOf }), name,
        `${esc(d.name)}<span class="lv">${d.threat == null ? `Lv ${d.level}` : d.threat.toFixed(0)}</span>`]);
    }
  }
  // Back to the report: after a war, its war report and its Opposition Research Report tabs
  const backLinks = !back ? [] : finished ? [[back, '← War report'], [`${back}#prewar`, '← Opposition Research Report']] : [[back, '← Opposition Research Report']];
  const layout = layoutHtml(sections, { links: backLinks, find: 'Find a member…' }).replace('<nav class="tabs"', '<nav class="tabs members"');
  return `${head(`Member dossiers · ${U} vs ${T}`, `<style>${FILE_CSS}</style>`)}<body class="nojs"><div class="wrap">
<header class="top"><img src="/assets/mentat-mark.png" alt=""><div><h1>Member dossiers<br><span style="font-size:.8em">${esc(U)} <span class="muted">vs</span> ${esc(T)}</span></h1>
<div class="sub">${war ? `Ranked war #${Number(war.id)} · ` : ''}Opposition Research Report, filed ${esc(timeTct(pre.at))} TCT${pre.rebuilt ? ' (rebuilt after the war)' : ''} · sorted by ${'threat'}; numbers in the list are threat / impact ratings</div></div></header>
${layout}
<footer>Made by Mentat from Torn's API and FFScouter. Pictures are the members' Torn profile pictures.</footer>
</div><script type="application/json" id="wr-data">{}</script><script src="/war/report.js?v=${clientVersion()}"></script></body></html>`;
}

// The whole page for one built report (model from features/warreport.js buildModel).
// pre: the war's Opposition Research Report as the server kept it ({ comparison, intel, at,
// rebuilt }), shown after the war report's own tabs (the user wants both, 2026-11-24).
function reportPage(m, { builtNote = '', pre = null, base = '' } = {}) {
  const w = m.war;
  const res = w.forfeit ? (w.won ? 'Victory · forfeit' : 'Defeat · forfeit') : w.won ? 'Victory' : 'Defeat';
  const title = `${m.us.name} vs ${m.them.name}`;
  const t = m.timeline;
  const sections = [];

  // Overview
  const tiles = [
    [dur(w.duration), 'long'],
    [`${num(m.us.attacks)} / ${num(m.them.attacks)}`, 'war hits, ours / theirs'],
    [`${m.hitters} of ${m.members}`, 'of us landed a hit'],
    [w.margin >= 0 ? `+${num(w.margin)}` : num(w.margin), 'final margin'],
    m.us.rankBefore || m.us.rankAfter ? [`${esc(m.us.rankBefore || '?')} → ${esc(m.us.rankAfter || '?')}`, 'our rank'] : null,
    m.us.respect ? [num(m.us.respect), 'respect earned'] : null,
    m.us.points ? [num(m.us.points), 'points earned'] : null,
    m.longestChain && m.longestChain.chain ? [num(m.longestChain.chain), `longest chain (${num(m.longestChain.respect)} respect)`] : null,
    t ? [num(t.leadChanges), `lead change${t.leadChanges === 1 ? '' : 's'}`] : null,
    t && t.biggestLead > 0 ? [num(t.biggestLead), `biggest lead${t.biggestLeadAt ? `, ${timeTct(t.biggestLeadAt)} TCT` : ''}`] : null,
    t && t.biggestDeficit > 0 ? [num(t.biggestDeficit), `${w.won ? 'came back from' : 'trailed by up to'}${t.biggestDeficitAt ? `, ${timeTct(t.biggestDeficitAt)} TCT` : ''}`] : null,
    m.enemyTop && m.enemyTop[0] ? [esc(m.enemyTop[0].name), `their MVP, ${pts(m.enemyTop[0].score)} pts`] : null,
  ].filter(Boolean);
  const items = (m.us.items || []).map(i => `${i.quantity > 1 ? `${num(i.quantity)}× ` : ''}${esc(i.name)}`);
  const hasLine = t && Array.isArray(t.line) && t.line.length > 1;
  sections.push(['overview', 'Overview', '', `
    <div class="vs"><div><div class="side"><span class="key us"></span>${esc(m.us.name)} <span class="sep">vs</span> <span class="key them"></span>${esc(m.them.name)}</div>
      <div class="score">${num(m.us.score)}<span class="sep">–</span>${num(m.them.score)}</div></div>
      <span class="pill ${w.won ? 'win' : 'loss'}">${res}</span></div>
    <div class="tiles">${tiles.map(([v, l]) => `<div class="tile"><div class="v">${v}</div><div class="l">${l}</div></div>`).join('')}</div>
    ${items.length ? `<div class="note">Rewards: ${items.join(', ')}</div>` : ''}
    ${hasLine ? `<h3>Score over the war</h3><div class="legend"><span><span class="key us"></span>${esc(m.us.name)}</span><span><span class="key them"></span>${esc(m.them.name)}</span></div>
      <div class="chart" data-chart="score" role="img" aria-label="War score over time for both factions"></div>
      <h3>Score gained each hour</h3><div class="legend"><span><span class="key us"></span>${esc(m.us.name)}</span><span><span class="key them"></span>${esc(m.them.name)}</span></div>
      <div class="chart" data-chart="hourly" role="img" aria-label="War score gained per hour by each faction"></div>
      <div class="muted small">Times are TCT. From Mentat's score readings during the war.</div>` : ''}`]);

  // Scoreboard
  const chainBy = new Map((m.chainStats || []).map(c => [c.id, c]));
  const zero = m.top.filter(x => x.attacks === 0).length;
  sections.push(['scoreboard', 'Scoreboard', m.hitters, `
    <div class="muted small" style="margin-bottom:8px">${m.hitters} of ${m.members} members hit. Click a column to sort.${chainBy.size ? ' Respect to Bonus come from our chain reports during the war, so they count every hit, not only war hits.' : ''}</div>
    ${zero ? `<label class="toggle"><input type="checkbox" data-show-zero> Show the ${zero} member${zero === 1 ? '' : 's'} with no war hits</label>` : ''}
    ${memberTable(m.top, { chainBy, totalScore: m.us.score })}`]);

  // Accolades
  if (m.accolades && m.accolades.length) {
    sections.push(['accolades', 'Accolades', m.accolades.length, `<div class="acc">${m.accolades.map(a => `<div class="a"><div class="t"><span class="e">${a.emoji}</span>${esc(a.title)}</div><div class="muted small">${esc(a.blurb)}</div>
      <div class="w">${a.winners.map(x => `${profile(x.id, x.name)} <span class="muted">· ${esc(x.text)}</span>`).join('<br>')}</div></div>`).join('')}</div>`]);
  }

  // Chains
  if (m.chains && m.chains.length) {
    const bonus = m.chains.flatMap(c => c.bonuses || []).sort((a, b) => b.respect - a.respect);
    sections.push(['chains', 'Chains', m.chains.length, `
      <div class="tiles"><div class="tile"><div class="v">${m.chains.length}</div><div class="l">chain${m.chains.length === 1 ? '' : 's'} during the war</div></div>
        <div class="tile"><div class="v">${num(m.chains.reduce((s, c) => s + c.chain, 0))}</div><div class="l">chain hits in all</div></div>
        <div class="tile"><div class="v">${pts(m.chains.reduce((s, c) => s + c.respect, 0))}</div><div class="l">respect from chains</div></div></div>
      <div class="tablewrap"><table class="data"><thead><tr><th>Started (TCT)</th><th class="num">Length</th><th class="num">Respect</th><th class="num">Resp / hit</th><th class="num">War hits</th><th class="num">Hitters</th><th>Lasted</th></tr></thead><tbody>
      ${m.chains.map(c => `<tr><td>${timeTct(c.start)}</td><td class="num">${num(c.chain)}</td><td class="num">${pts(c.respect)}</td><td class="num">${c.chain ? pts(c.respect / c.chain) : '–'}</td><td class="num">${c.war ? num(c.war) : '–'}</td><td class="num">${num(c.members)}</td><td>${c.end ? dur(c.end - c.start) : 'still going'}</td></tr>`).join('')}
      </tbody></table></div>
      ${bonus.length ? `<h3>Bonus hits</h3><div class="tablewrap"><table class="data"><thead><tr><th>Who</th><th class="num">Hit #</th><th class="num">Respect</th></tr></thead><tbody>${bonus.map(b => `<tr><td>${profile(b.id, b.name)}</td><td class="num">${num(b.chain)}</td><td class="num">${pts(b.respect)}</td></tr>`).join('')}</tbody></table></div>` : ''}`]);
  }

  // Attacks (only with the faction's attack log)
  const a = m.attackStats;
  if (a) {
    const results = Object.entries(a.results || {}).sort((x, y) => y[1] - x[1]);
    sections.push(['attacks', 'Attacks', num(a.outgoing), `
      <div class="tiles"><div class="tile"><div class="v">${num(a.outgoing)}</div><div class="l">war attacks we made</div></div>
        <div class="tile"><div class="v">${num(a.won)} <span class="muted small">${pct(a.won, a.outgoing)}</span></div><div class="l">of them won</div></div>
        <div class="tile"><div class="v">${num(a.enemyHospitalised)}</div><div class="l">enemies hospitalised</div></div>
        <div class="tile"><div class="v">${num(a.incoming)}</div><div class="l">their attacks on us</div></div>
        ${a.incomingWon != null ? `<div class="tile"><div class="v">${num(a.incomingWon)} <span class="muted small">${pct(a.incomingWon, a.incoming)}</span></div><div class="l">of theirs that won</div></div>` : ''}</div>
      ${Array.isArray(a.byHour) && a.byHour.length > 1 ? `<h3>War hits each hour</h3><div class="legend"><span><span class="key us"></span>our wins</span><span><span class="key them"></span>their attacks on us</span></div>
        <div class="chart" data-chart="attacks" role="img" aria-label="War hits per hour"></div>` : ''}
      ${results.length ? `<h3>How our attacks ended</h3><div class="tablewrap"><table class="data"><thead><tr><th>Result</th><th class="num">Attacks</th><th class="num">Share</th></tr></thead><tbody>${results.map(([k, v]) => `<tr><td>${esc(k)}</td><td class="num">${num(v)}</td><td class="num">${pct(v, a.outgoing)}</td></tr>`).join('')}</tbody></table></div>` : ''}
      ${(a.bags || []).length ? `<h3>Enemies we hit most</h3><div class="tablewrap"><table class="data"><thead><tr><th>Enemy</th><th class="num">Times hit</th></tr></thead><tbody>${a.bags.map(b => `<tr><td>${profile(b.id, b.name)}</td><td class="num">${num(b.hits)}</td></tr>`).join('')}</tbody></table></div>` : ''}`]);
  }

  // Enemy
  if (m.enemyMembers && m.enemyMembers.length) {
    const hit = m.enemyMembers.filter(x => x.attacks > 0).length;
    sections.push(['enemy', m.them.name.length > 16 ? 'Enemy' : esc(m.them.name), hit, `
      <div class="tiles"><div class="tile"><div class="v">${num(m.them.score)}</div><div class="l">their score</div></div>
        <div class="tile"><div class="v">${num(m.them.attacks)}</div><div class="l">their war hits</div></div>
        <div class="tile"><div class="v">${hit} of ${m.enemyMembers.length}</div><div class="l">of them landed a hit</div></div>
        ${m.them.rankBefore || m.them.rankAfter ? `<div class="tile"><div class="v">${esc(m.them.rankBefore || '?')} → ${esc(m.them.rankAfter || '?')}</div><div class="l">their rank</div></div>` : ''}</div>
      ${memberTable(m.enemyMembers, { totalScore: m.them.score, enemy: true })}`]);
  }

  // Groups: the war report, then the war's Opposition Research Report (frozen before it began).
  const all = sections.map(s => [s[0], s[1], s[2], s[3], 'War report']);
  if (m.comparison) all.push(['postwar', 'Post-war comparison', '', comparisonHtml(m.comparison, { when: 'post', before: (pre && pre.comparison) || m.preWar || null }), 'War report']);
  if (pre) all.push(...oppoSections(pre, { warStart: w.start, files: pre.dossiers ? `${base}/members` : '' }));
  else if (m.preWar) all.push(['prewar', 'Comparison', '', comparisonHtml(m.preWar, { when: 'pre', warStart: w.start }), 'Opposition Research Report']);

  // Chart data for web/war/report.js (inert JSON; < escaped so it can't close the tag).
  const data = {
    us: m.us.name, them: m.them.name, start: w.start, end: w.end,
    line: hasLine ? t.line : null,
    attacks: a && Array.isArray(a.byHour) ? a.byHour : null,
  };
  const json = JSON.stringify(data).replace(/</g, '\\u003c');
  const missing = [];
  if (m.sources && m.sources.attacks === null) missing.push("no attack log (the server's key has no faction API access), so the Attacks tab and some accolades are left out");
  if (!hasLine) missing.push('no score readings for this war, so there are no charts');

  return `${head(`${title} · War report`)}<body class="nojs"><div class="wrap">
<header class="top"><img src="/assets/mentat-mark.png" alt=""><div><h1>⚔️ ${esc(m.us.name)} <span class="muted">vs</span> ${esc(m.them.name)}</h1>
<div class="sub">Ranked war #${Number(w.id)} · ${dateTct(w.start)} → ${dateTct(w.end)} TCT · <span class="pill ${w.won ? 'win' : 'loss'}">${res}</span></div></div></header>
${layoutHtml(all, { links: pre && pre.dossiers ? [[`${base}/members`, 'Member dossiers →']] : [] })}
<footer>Built ${timeTct(m.builtAt)} TCT by Mentat from Torn's API${builtNote ? ` · ${esc(builtNote)}` : ''}.${missing.length ? ` Note: ${missing.join('; ')}.` : ''}</footer>
</div><script type="application/json" id="wr-data">${json}</script><script src="/war/report.js?v=${clientVersion()}"></script></body></html>`;
}

module.exports = { reportPage, oppoPage, membersPage, waitingPage, linkSecret, sign, sigOk, esc };
