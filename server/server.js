#!/usr/bin/env node
'use strict';
// Mentat sync server (Mentat was called Torn Desktop until 2026-11-18; its ids and paths keep that name).
//
// Runs the app's own collectors around the clock with your Torn API key, so the history
// keeps growing while your PC is off, and serves it (plus your synced settings) to Torn
// Desktop on any PC you sign in from:
//   Oppo research   enemy activity by hour, personal stats, track record (war + research)
//   War history     score and availability over a ranked war, travel departures
//   Abroad stock    YATA readings for restock patterns
//   Prices          Torn market values, item market lows for watched items, bazaar lows (Weav3r)
//   Settings        targets, alerts, watched items, appearance and the other synced settings
//   Scouting        activity history and war records of every faction around your rank, so
//                   a new opponent already has weeks of history (see features/scout.js)
//
// Your faction's members can use it too: they sign in with their own Torn API key, which is
// checked with Torn and then forgotten (members.js). They can read the shared data and keep
// their own settings; only your access token can upload data or change what's collected.
//
// Plain Node 20+, no packages. Commands:
//   node server/server.js init      create config.json (asks for your Torn key, makes an access token)
//   node server/server.js           run
//   node server/server.js token     show the access token to paste into the app
//   node server/server.js set-key   replace the Torn API key
// Options: --config <file> (default: config.json next to the server folder, or $TD_CONFIG)
//
// The access token is required on every request. Put the server behind HTTPS (a reverse
// proxy or tunnel) before exposing it beyond your own network; see README.md.

const fs = require('fs');
const path = require('path');
const http = require('http');
const zlib = require('zlib');
const crypto = require('crypto');
const readline = require('readline');
const { promisify } = require('util');

const LIB = path.join(__dirname, '..', 'src', 'main');
const { Store } = require(path.join(LIB, 'store'));
const { TornApi } = require(path.join(LIB, 'api'));
const { PriceHistory } = require(path.join(LIB, 'history'));
const { WarFeature } = require(path.join(LIB, 'features', 'war'));
const { ResearchFeature } = require(path.join(LIB, 'features', 'research'));
const { TravelFeature, COUNTRIES } = require(path.join(LIB, 'features', 'travel'));
const { MarketFeature } = require(path.join(LIB, 'features', 'market'));
const { BazaarFeature } = require(path.join(LIB, 'features', 'bazaar'));
const { ScoutFeature } = require(path.join(LIB, 'features', 'scout'));
const { ActivityStore } = require(path.join(LIB, 'activity'));
const { WarArchive } = require(path.join(LIB, 'warchive'));
const { UNIT_SET, DATASETS, PULL_ONLY, MERGE, mergePlan, prunePlan, joinUnit } = require(path.join(LIB, 'syncmerge'));
const { CloudBackup } = require('./cloudbackup');
const { Members, tornWithKey } = require('./members');
const { Claims } = require('./claims');
const { HitQueue } = require('./hitqueue');
const { EnergyShare } = require('./energy');
const { WarReportFeature } = require(path.join(LIB, 'features', 'warreport'));
const warpage = require('./warpage');
const { buildComparison } = require('./compare');
const { intelHtml } = require('./intelrun');
const { buildDossiers } = require('./dossier');
const { AvatarsFeature } = require(path.join(LIB, 'features', 'avatars'));
const { MuggerDb, rankTraders, scores, traderInfo, linked } = require(path.join(LIB, 'features', 'muggerdb'));
const { SNAP_STATS } = require(path.join(LIB, 'features', 'research'));
const { Push } = require('./push');
const { Odds } = require('./odds');

const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);
let VERSION = '0.0.0';
try { VERSION = require(path.join(__dirname, '..', 'package.json')).version; } catch (e) { /* bundled without it */ }

const API_VERSION = 1;
const MAX_BODY = 64 * 1024 * 1024;
const MAX_UNZIPPED = 256 * 1024 * 1024;
const KEY_PATTERN = /^[A-Za-z0-9]{16}$/;

const log = (...a) => console.log(new Date().toISOString(), ...a);

// ---------------------------------------------------------------- web files
// Everything outside /api/v1/ is a file from web/ (guides, the Torn PDA script, the web app) or
// the logo from src/assets. Read-only, no directory listings, nothing outside those folders.
const WEB_DIR = path.join(__dirname, '..', 'web');
const APP_DIR = path.join(WEB_DIR, 'app'); // the web app's own files (mentat-core.js, host.js, …)
// Userscript routes that Torn's pages may call directly (see corsOrigins): the war board's and Mugger's.
const CORS_ROUTES = /^(login|me|logout|war\/(board|queue|claims|energy)|mugger\/traders)$/;
// The Mentat userscripts in web/pda (mentat-war, mentat-mugger, …): their update check files and versions.
const scriptFile = name => path.join(WEB_DIR, 'pda', `${name}.user.js`);
// A userscript's .meta.js: just its header (managers like Userscripts on iPad/iPhone read updates from
// it), made from the script so it's never out of date.
function serveScriptMeta(req, res, name, publicUrl) {
  let text;
  try { text = fs.readFileSync(scriptFile(name), 'utf8'); } catch (e) { res.writeHead(404); return res.end(); }
  const m = /\/\/ ==UserScript==[\s\S]*?\/\/ ==\/UserScript==/.exec(text);
  let body = m ? `${m[0]}\n` : '';
  if (publicUrl) body = body.split('https://mentat.example.com').join(publicUrl).split('mentat.example.com').join(new URL(publicUrl).host);
  const buf = Buffer.from(body);
  res.writeHead(m ? 200 : 404, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-cache', 'Content-Length': buf.length, 'X-Content-Type-Options': 'nosniff' });
  res.end(req.method === 'HEAD' ? undefined : buf);
}
// A userscript's @version, so it can say when there's an update (re-read when the file changes).
const scriptVersions = new Map(); // name -> { mtime, version }
function scriptVersion(name) {
  try {
    const st = fs.statSync(scriptFile(name));
    const had = scriptVersions.get(name);
    if (!had || had.mtime !== st.mtimeMs) {
      const m = /^\/\/ @version\s+([\d.]+)/m.exec(fs.readFileSync(scriptFile(name), 'utf8'));
      scriptVersions.set(name, { mtime: st.mtimeMs, version: m ? m[1] : '' });
    }
    return scriptVersions.get(name).version;
  } catch (e) { return ''; }
}
const UI_DIR = path.join(__dirname, '..', 'src', 'ui'); // the tools page, shared with the Windows app
// The web app talks to this server, Torn's API and the same services as the Windows app.
const APP_CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' https: data: blob:; connect-src 'self' https://api.torn.com https://ffscouter.com https://weav3r.dev https://yata.yt; frame-src 'self'; worker-src 'self'; manifest-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";
// The tools page as the web app: its own security policy, the web start-up scripts before the
// page's own, and the phone app details (manifest, icons, theme colour).
function appIndexHtml() {
  let t = fs.readFileSync(path.join(UI_DIR, 'index.html'), 'utf8');
  t = t.replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/, `<meta http-equiv="Content-Security-Policy" content="${APP_CSP.replace(/ frame-ancestors [^;]+;/, '')}">`); // frame-ancestors only works as a header
  t = t.replace('<head>', `<head>
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <meta name="theme-color" content="#110d09">
  <meta name="apple-mobile-web-app-capable" content="yes">
  <meta name="mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-title" content="Mentat">
  <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
  <link rel="manifest" href="manifest.webmanifest">
  <link rel="icon" href="/assets/mentat-mark.png">
  <link rel="apple-touch-icon" href="/assets/mentat-icon-180.png">`);
  t = t.replace('<script src="util.js"></script>', '<script src="mentat-core.js"></script>\n  <script src="host.js"></script>\n  <script src="util.js"></script>');
  t = t.replace('</head>', '  <link rel="stylesheet" href="web.css">\n</head>');
  // Each script and stylesheet address carries a fingerprint of the file, so a new version is a new
  // address: browsers and Cloudflare (which keeps .js/.css for 4 hours) can't serve an old copy.
  t = t.replace(/(src|href)="([\w.-]+\.(?:js|css))"/g, (m, attr, name) => `${attr}="${name}?v=${fileVersion(name)}"`);
  return t;
}
const versions = new Map(); // file -> { mtime, v }
function fileVersion(name) {
  const file = fs.existsSync(path.join(APP_DIR, name)) ? path.join(APP_DIR, name) : path.join(UI_DIR, name);
  let st;
  try { st = fs.statSync(file); } catch (e) { return '0'; }
  const c = versions.get(file);
  if (c && c.mtime === st.mtimeMs) return c.v;
  const v = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('base64url').slice(0, 10);
  versions.set(file, { mtime: st.mtimeMs, v });
  return v;
}
const ASSET_DIR = path.join(__dirname, '..', 'src', 'assets');
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json', '.png': 'image/png',
  '.ico': 'image/x-icon', '.svg': 'image/svg+xml', '.txt': 'text/plain; charset=utf-8',
};
const PAGE_CSP = "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self' https://api.torn.com; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";
const webCache = new Map(); // file -> { mtime, size, body, gz, etag }

// /download: the newest installer (named in latest.yml). /downloads/<file>: the installer, its
// blockmap and latest.yml, streamed from disk with byte ranges (updates fetch only what changed).
function serveDownload(req, res, pathname, dir) {
  const plain = (code, text, extra = {}) => { res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8', ...extra }); res.end(req.method === 'HEAD' ? undefined : text); };
  if (req.method !== 'GET' && req.method !== 'HEAD') return plain(405, 'Method not allowed', { Allow: 'GET, HEAD' });
  if (!dir) return plain(404, 'No downloads here.');
  if (pathname === '/download' || pathname === '/download/') {
    let latest = '';
    try { latest = (/^path:\s*(.+)$/m.exec(fs.readFileSync(path.join(dir, 'latest.yml'), 'utf8')) || [])[1] || ''; } catch (e) { /* none yet */ }
    latest = latest.trim().replace(/^['"]|['"]$/g, '');
    if (!/^[\w.-]+\.exe$/.test(latest)) return plain(404, 'No download yet.');
    return plain(302, 'Found', { Location: `/downloads/${encodeURIComponent(latest)}`, 'Cache-Control': 'no-cache' });
  }
  let name;
  try { name = decodeURIComponent(pathname.slice('/downloads/'.length)); } catch (e) { return plain(400, 'Bad address'); }
  if (!/^[\w.-]+\.(exe|yml|blockmap)$/.test(name) || name.startsWith('.')) return plain(404, 'Not found');
  const file = path.join(dir, name);
  let st;
  try { st = fs.statSync(file); } catch (e) { return plain(404, 'Not found'); }
  if (!st.isFile()) return plain(404, 'Not found');
  const yml = name.endsWith('.yml');
  const headers = {
    'Content-Type': yml ? 'text/yaml; charset=utf-8' : 'application/octet-stream',
    'Accept-Ranges': 'bytes', 'X-Content-Type-Options': 'nosniff', ETag: `"${st.size.toString(36)}-${Math.floor(st.mtimeMs).toString(36)}"`,
    // latest.yml says which version is newest, so it's checked every time; installers never change under one name.
    'Cache-Control': yml ? 'no-cache' : 'public, max-age=86400',
    ...(name.endsWith('.exe') ? { 'Content-Disposition': `attachment; filename="${name}"` } : {}),
  };
  const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range || '').trim());
  if (range && (range[1] || range[2])) {
    let start = range[1] === '' ? Math.max(0, st.size - Number(range[2])) : Number(range[1]);
    let end = range[1] === '' || range[2] === '' ? st.size - 1 : Math.min(Number(range[2]), st.size - 1);
    if (start > end || start >= st.size) return plain(416, 'Range not satisfiable', { 'Content-Range': `bytes */${st.size}` });
    res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${st.size}`, 'Content-Length': end - start + 1 });
    if (req.method === 'HEAD') return res.end();
    return fs.createReadStream(file, { start, end }).on('error', () => res.destroy()).pipe(res);
  }
  res.writeHead(200, { ...headers, 'Content-Length': st.size });
  if (req.method === 'HEAD') return res.end();
  return fs.createReadStream(file).on('error', () => res.destroy()).pipe(res);
}

async function serveFile(req, res, pathname, publicUrl = '') {
  const plain = (code, text, extra = {}) => { res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8', ...extra }); res.end(req.method === 'HEAD' ? undefined : text); };
  if (req.method !== 'GET' && req.method !== 'HEAD') return plain(405, 'Method not allowed', { Allow: 'GET, HEAD' });
  let p;
  try { p = decodeURIComponent(pathname); } catch (e) { return plain(400, 'Bad address'); }
  if (/[\x00\\]/.test(p)) return plain(400, 'Bad address'); // no NUL bytes or backslashes
  // The web app: / and /app go to /app/; its page is the tools page with the web start-up added.
  if (p === '/' || p === '/app') return plain(302, 'Found', { Location: '/app/' });
  if (p === '/app/' || p === '/app/index.html') {
    const body = Buffer.from(appIndexHtml());
    const zipped = /\bgzip\b/.test(req.headers['accept-encoding'] || '');
    const out = zipped ? zlib.gzipSync(body) : body;
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache', 'Content-Security-Policy': APP_CSP, 'X-Frame-Options': 'DENY', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Content-Length': out.length, ...(zipped ? { 'Content-Encoding': 'gzip', Vary: 'Accept-Encoding' } : {}) });
    return res.end(req.method === 'HEAD' ? undefined : out);
  }
  let base = WEB_DIR;
  let rel = p;
  if (p.startsWith('/app/')) {
    // web/app first (mentat-core.js, host.js, web.css, the service worker…), else the shared tools page.
    const name = p.slice('/app'.length);
    if (!/^\/[\w.-]+$/.test(name)) return plain(404, 'Not found');
    base = fs.existsSync(path.join(APP_DIR, name)) ? APP_DIR : UI_DIR;
    rel = name;
    if (base === UI_DIR && !/\.(js|css)$/.test(name)) return plain(404, 'Not found');
  }
  if (p.startsWith('/assets/')) {
    base = ASSET_DIR;
    rel = p.slice('/assets'.length);
    if (!/^\/mentat[\w.-]*\.(png|ico)$/.test(rel)) return plain(404, 'Not found');
  }
  if (rel.endsWith('/')) rel += 'index.html';
  const file = path.resolve(base, `.${rel}`);
  if (file !== base && !file.startsWith(base + path.sep)) return plain(404, 'Not found');
  let st;
  try { st = fs.statSync(file); } catch (e) { return plain(404, 'Not found'); }
  if (st.isDirectory()) {
    if (fs.existsSync(path.join(file, 'index.html'))) return plain(301, 'Moved', { Location: `${pathname}/` });
    return plain(404, 'Not found');
  }
  const ext = path.extname(file).toLowerCase();
  const type = TYPES[ext];
  if (!type) return plain(404, 'Not found');
  let c = webCache.get(file);
  if (!c || c.mtime !== st.mtimeMs || c.size !== st.size) {
    let body = fs.readFileSync(file);
    // The Torn PDA script and its guide name this server: mentat.example.com becomes publicUrl.
    if (publicUrl && base === WEB_DIR && rel.startsWith('/pda/') && /\.(js|html)$/.test(ext)) {
      body = Buffer.from(body.toString('utf8').split('https://mentat.example.com').join(publicUrl).split('mentat.example.com').join(new URL(publicUrl).host));
    }
    c = { mtime: st.mtimeMs, size: st.size, body, gz: /^(text|application\/(json|manifest))|svg/.test(type) ? zlib.gzipSync(body) : null, etag: `"${st.size.toString(36)}-${Math.floor(st.mtimeMs).toString(36)}"` };
    webCache.set(file, c);
  }
  const headers = {
    'Content-Type': type, ETag: c.etag, 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
    // Pages, scripts and the Torn PDA script are checked each time (they change); images last an hour.
    'Cache-Control': /\.(png|ico)$/.test(ext) ? 'public, max-age=3600' : 'no-cache',
    ...(ext === '.html' ? { 'Content-Security-Policy': PAGE_CSP, 'X-Frame-Options': 'DENY' } : {}),
    // The service worker may look after the whole web app.
    ...(rel === '/sw.js' ? { 'Service-Worker-Allowed': '/app/' } : {}),
  };
  if (req.headers['if-none-match'] === c.etag) { res.writeHead(304, headers); return res.end(); }
  const zipped = c.gz && /\bgzip\b/.test(req.headers['accept-encoding'] || '');
  const body = zipped ? c.gz : c.body;
  res.writeHead(200, { ...headers, 'Content-Length': body.length, ...(zipped ? { 'Content-Encoding': 'gzip', Vary: 'Accept-Encoding' } : {}) });
  res.end(req.method === 'HEAD' ? undefined : body);
}

// ---------------------------------------------------------------- config
function argValue(name) {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : '';
}

function configPath() {
  return path.resolve(argValue('--config') || process.env.TD_CONFIG || path.join(__dirname, '..', 'config.json'));
}

function readSecret(file) {
  try { return fs.readFileSync(file, 'utf8').trim(); } catch (e) { return ''; }
}

function loadConfig(file) {
  let c = {};
  try { c = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) {
    if (e.code !== 'ENOENT') throw new Error(`Can't read ${file}: ${e.message}`);
  }
  const dir = path.dirname(file);
  const cred = process.env.CREDENTIALS_DIRECTORY; // systemd LoadCredential=
  // Off-site copies (S3-compatible storage). Endpoint and bucket can live in a separate file
  // (cloudBackup.configFile); the access keys in credentials, files or environment variables.
  const cc = c.cloudBackup || {};
  let cf = {};
  if (cc.configFile) { try { cf = JSON.parse(fs.readFileSync(path.resolve(dir, cc.configFile), 'utf8')); } catch (e) { /* not set up yet */ } }
  const secretOf = (env, name, fileKey, valKey) => process.env[env] || (cred && readSecret(path.join(cred, name))) || (cc[fileKey] && readSecret(path.resolve(dir, cc[fileKey]))) || cc[valKey] || '';
  const clampN = (v, lo, hi, d) => Math.min(hi, Math.max(lo, Number(v) || d));
  const cfg = {
    host: process.env.TD_HOST || c.host || '127.0.0.1',
    port: Number(process.env.TD_PORT || c.port || 8830),
    dataDir: path.resolve(dir, process.env.TD_DATA_DIR || c.dataDir || 'data'),
    token: process.env.TD_TOKEN || (cred && readSecret(path.join(cred, 'token'))) || (c.tokenFile && readSecret(path.resolve(dir, c.tokenFile))) || c.token || '',
    tornKey: process.env.TD_TORN_KEY || (cred && readSecret(path.join(cred, 'torn_key'))) || (c.tornKeyFile && readSecret(path.resolve(dir, c.tornKeyFile))) || c.tornKey || '',
    maxPerMinute: Math.min(80, Math.max(5, Number(c.maxPerMinute) || 30)),
    scoutPerMinute: Math.min(60, Math.max(2, Number(c.scoutPerMinute) || 20)),
    activityKeepDays: Math.min(730, Math.max(30, Number(c.activityKeepDays) || 180)),
    collect: { research: true, war: true, travel: true, prices: true, bazaar: true, scout: true, mugger: true, ...(c.collect || {}) },
    // Who may sign in: factionId (default: the server key's faction), adminIds (default: the key's player).
    access: { ...(c.access || {}) },
    // The app's installer and update files (outside the data folder, so backups stay small).
    downloadsDir: c.downloadsDir ? path.resolve(dir, c.downloadsDir) : '',
    // Phone alerts: the secret that encrypts members' stored keys (and makes the push key pair).
    // A root-only credential, outside the data folder, so it's never in a backup.
    pushSecret: process.env.TD_PUSH_SECRET || (cred && readSecret(path.join(cred, 'push_secret'))) || (c.pushSecretFile && readSecret(path.resolve(dir, c.pushSecretFile))) || '',
    // Live bookmaker odds for the Bookie helper (The Odds API key; empty until sudo torn-desktop-set-odds).
    oddsKey: process.env.TD_ODDS_KEY || (cred && readSecret(path.join(cred, 'odds_key'))) || (c.oddsKeyFile && readSecret(path.resolve(dir, c.oddsKeyFile))) || '',
    publicUrl: String(c.publicUrl || '').replace(/\/+$/, ''),
    // Pages allowed to call the war board's routes straight from the browser (CORS), for userscript
    // apps without their own request function (some iPad/iPhone ones). Only Torn by default.
    corsOrigins: Array.isArray(c.corsOrigins) ? c.corsOrigins.map(String) : ['https://www.torn.com', 'https://torn.com'],
    cloud: {
      enabled: !!cc.enabled || !!process.env.TD_S3_ENDPOINT,
      endpoint: String(process.env.TD_S3_ENDPOINT || cf.endpoint || cc.endpoint || '').replace(/\/+$/, ''),
      bucket: process.env.TD_S3_BUCKET || cf.bucket || cc.bucket || '',
      region: cf.region || cc.region || 'auto',
      prefix: String(cf.prefix || cc.prefix || 'torn-desktop').replace(/^\/+|\/+$/g, ''),
      keyId: secretOf('TD_S3_KEY_ID', 's3_key_id', 'keyIdFile', 'keyId'),
      secret: secretOf('TD_S3_SECRET', 's3_secret', 'secretFile', 'secret'),
      everyMinutes: clampN(cc.everyMinutes, 15, 1440, 60), hourlyHours: clampN(cc.hourlyHours, 1, 24 * 14, 48), dailyDays: clampN(cc.dailyDays, 1, 365, 30),
    },
  };
  return { cfg, raw: c };
}

function writeConfig(file, raw) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(raw, null, 2)}\n`, { mode: 0o600 });
  try { fs.chmodSync(file, 0o600); } catch (e) { /* Windows */ }
}

function ask(question, hidden = false) {
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (hidden) rl._writeToOutput = s => { if (s.includes(question)) rl.output.write(question); };
    rl.question(question, a => {
      rl.close();
      if (hidden) process.stdout.write('\n');
      resolve(String(a || '').trim());
    });
  });
}

async function checkKey(key) {
  const res = await fetch(`https://api.torn.com/user/?selections=basic&key=${encodeURIComponent(key)}&comment=Mentat`, { signal: AbortSignal.timeout(15000) });
  const d = await res.json();
  if (d.error) throw new Error(`Torn API: ${d.error.error}`);
  return d;
}

async function askKey() {
  for (;;) {
    const key = await ask('Torn API key (Limited access; typing is hidden): ', true);
    if (!KEY_PATTERN.test(key)) { console.log('A Torn API key is 16 letters and numbers.'); continue; }
    try {
      const me = await checkKey(key);
      console.log(`Key works: ${me.name} [${me.player_id}].`);
      return key;
    } catch (e) { console.log(e.message); }
  }
}

async function cmdInit(file) {
  const { raw } = loadConfig(file);
  if (raw.token || raw.tornKey) {
    console.log(`${file} already exists. Use "set-key" to change the key or "token" to see the access token.`);
    return;
  }
  const key = await askKey();
  const token = crypto.randomBytes(32).toString('base64url');
  writeConfig(file, { host: '127.0.0.1', port: 8830, dataDir: 'data', maxPerMinute: 30, tornKey: key, token, scoutPerMinute: 20, collect: { research: true, war: true, travel: true, prices: true, bazaar: true, scout: true } });
  console.log(`\nSaved ${file} (readable only by you).`);
  console.log(`\nAccess token for Mentat (Settings > Data source), keep it private:\n\n  ${token}\n`);
  console.log('Start the server with: node server/server.js');
}

async function cmdSetKey(file) {
  const { raw } = loadConfig(file);
  raw.tornKey = await askKey();
  writeConfig(file, raw);
  console.log('Key saved. Restart the server to use it.');
}

function cmdToken(file) {
  const { cfg } = loadConfig(file);
  if (!cfg.token) { console.log('No access token yet. Run "init" first.'); return; }
  console.log(cfg.token);
}

// ---------------------------------------------------------------- server
// Settings the collectors read. Synced values come from the app; a few are held to gentler
// limits here, since the server shares your Torn API allowance with your PCs.
class ServerSettings extends Store {
  constructor(file, cfg) {
    super(file, {
      travel: { yata: true, learned: {} },
      market: { bazaar: true, watch: {}, watchInterval: 600, priceSource: 'both' },
      war: { watchId: 0, interval: 60, pinned: [] },
      research: { watchId: 0 },
      scout: { spread: 1 },
      sync: { rev: 0, units: {} },
    });
    this.cfg = cfg;
  }

  get(p) {
    const v = super.get(p);
    switch (p) {
      case 'api.maxPerMinute': return this.cfg.maxPerMinute;
      case 'api.keyEnc': return '';
      case 'ui.panel': return '';
      case 'war.interval': return Math.max(60, Number(v) || 60);
      // No live mode on the server: the war board's Live uses each member's own key (the user's
      // rule, 2026-11-22), so the server key keeps the normal once-a-minute enemy refresh.
      case 'war.live': return 0;
      case 'market.watchInterval': return Math.max(600, Number(v) || 600);
      case 'travel.yata': return this.cfg.collect.travel && v !== false;
      case 'market.bazaar': return this.cfg.collect.bazaar && v !== false;
      case 'scout.enabled': return this.cfg.collect.scout !== false;
      case 'scout.perMinute': return this.cfg.scoutPerMinute;
      default: return v;
    }
  }
}

function memberSettingsStore(dataDir, pid) {
  return new Store(path.join(dataDir, 'members', `${Number(pid)}.json`), { sync: { rev: 0, units: {} } }, { debounceMs: 2000 });
}

// The visitor's address (Cloudflare and Caddy put it in headers; the server only listens locally).
const ipOf = req => String(req.headers['cf-connecting-ip'] || String(req.headers['x-forwarded-for'] || '').split(',')[0] || req.socket.remoteAddress || '').trim();

function tokenMatches(given, token) {
  const a = crypto.createHash('sha256').update(String(given)).digest();
  const b = crypto.createHash('sha256').update(String(token)).digest();
  return crypto.timingSafeEqual(a, b);
}

async function readBody(req) {
  const chunks = [];
  let n = 0;
  for await (const c of req) {
    n += c.length;
    if (n > MAX_BODY) throw Object.assign(new Error('Too large'), { status: 413 });
    chunks.push(c);
  }
  let buf = Buffer.concat(chunks);
  if (/gzip/i.test(req.headers['content-encoding'] || '')) buf = await gunzip(buf, { maxOutputLength: MAX_UNZIPPED });
  try { return JSON.parse(buf.toString('utf8') || '{}'); } catch (e) { throw Object.assign(new Error('Bad JSON'), { status: 400 }); }
}

async function run(file) {
  const { cfg } = loadConfig(file);
  if (!cfg.token || cfg.token.length < 24) throw new Error(`No access token (at least 24 characters) in ${file}. Run "node server/server.js init".`);
  if (!KEY_PATTERN.test(cfg.tornKey)) throw new Error(`No Torn API key in ${file}. Run "node server/server.js set-key".`);
  fs.mkdirSync(cfg.dataDir, { recursive: true });

  const idFile = path.join(cfg.dataDir, 'server-id');
  let serverId = readSecret(idFile);
  if (!serverId) { serverId = crypto.randomBytes(9).toString('base64url'); fs.writeFileSync(idFile, serverId); }
  const boot = crypto.randomBytes(4).toString('hex'); // revisions restart with the process
  const startedAt = Date.now();

  const settings = new ServerSettings(path.join(cfg.dataDir, 'settings.json'), cfg);
  let keyOk = true;
  const api = new TornApi(settings, { getKey: () => (keyOk ? cfg.tornKey : '') });
  api.on('key', () => { keyOk = false; log('Torn API key rejected:', api.banner, '- fix it with "set-key" and restart.'); });
  let lastBanner = '';
  api.on('status', () => { if (api.banner && api.banner !== lastBanner) log('Torn API:', api.banner); lastBanner = api.banner; });

  const history = new PriceHistory(cfg.dataDir);
  const cache = new Store(path.join(cfg.dataDir, 'cache.json'), { items: null }, { debounceMs: 5000 });
  const market = new MarketFeature({ api, store: settings, cache, notify: () => {}, history });
  const bazaar = new BazaarFeature({ store: settings, history });
  market.bazaar = bazaar;
  const travel = new TravelFeature({ api, store: settings, dataDir: cfg.dataDir, capacity: false });
  // Mugger's market database: bazaar sellers of abroad items from Weav3r every 30 min, 90 days, plus
  // Torn's bazaar directories with the server key every 12 h (about 73 calls, lowest priority).
  // Weav3r gets the server's key too (registered there by the user, who OK'd it 2026-11-25): 25 reads a
  // minute instead of 10, and every page.
  const muggerDb = new MuggerDb({ dataDir: cfg.dataDir, travel, api, key: () => api.getKey(), log });
  const war = new WarFeature({ api, store: settings, dataDir: cfg.dataDir });
  const activity = new ActivityStore(cfg.dataDir, { keepDays: cfg.activityKeepDays });
  const archive = new WarArchive(cfg.dataDir);
  const research = new ResearchFeature({ api, store: settings, dataDir: cfg.dataDir, war, activity, archive });
  const scout = new ScoutFeature({ api, store: settings, dataDir: cfg.dataDir, war, activity, archive, research, local: false });
  war.statsWanted = () => false;

  const members = new Members({ dataDir: cfg.dataDir, cfg, serverApi: api, log });
  fs.mkdirSync(path.join(cfg.dataDir, 'members'), { recursive: true });
  const memberStores = new Map();
  const push = new Push({ dataDir: cfg.dataDir, secret: cfg.pushSecret, subject: cfg.publicUrl, log, members });
  const odds = new Odds({ key: cfg.oddsKey, dataDir: cfg.dataDir, log });
  // War claims (War tab → Claim); the server's own enemy checks clear a claim when the hit lands.
  const claims = new Claims({ api, log });
  war.on('members', (fid, list) => claims.observe(list));
  // Hit queue + war board (web/pda/mentat-war.user.js). While anyone has the board open, the
  // enemy's members refresh every 5 s during a war (war.live), as if the War tab were on show.
  const nameOf = pid => {
    const m = war.state.ours && war.state.ours.members.find(x => x.id === Number(pid));
    return (m && m.name) || members.me(pid).name || '';
  };
  const queue = new HitQueue({ dataDir: cfg.dataDir, api, log, nameOf });
  queue.onStatus = list => claims.observe(list); // queued targets' statuses clear dibs too
  // Members' shared energy (opt-in on the war board; see energy.js).
  const energy = new EnergyShare({ dataDir: cfg.dataDir });
  war.viewing = panel => panel === 'war' && queue.watching().length > 0;
  // A queued target landing in hospital takes that entry off the queue (hitqueue.js observeTarget).
  war.on('members', (fid, list) => { try { queue.observeMembers(list); } catch (e) { log('Hit queue error:', e.stack || e.message); } });
  // Queuing applies dibs (the user's rule, 2026-11-26; claims.js followQueue): for targets in the
  // enemy faction the war board shows (the same rule as its Enemy tab).
  const isQueueEnemy = id => {
    const t = war.enemyTarget();
    const e = war.state.enemy;
    if (!t || !e || e.id !== t.id || !e.members || (t.source === 'ranked' && war.phase() === 'ended')) return false;
    return e.members.some(m => m.id === Number(id));
  };
  const queueDibs = (now = Date.now()) => (queue.willMode() ? claims.releaseQueue(now) : claims.followQueue(queue.entries, isQueueEnemy, now));

  // Shared war reports (the user's request, 2026-11-24): each built once with the server's key and
  // served as a ready-made page at a link the team opens without signing in or waiting on Torn's
  // API (warpage.js). Links come from war/report-link, for people signed in here.
  const warreport = new WarReportFeature({ api, war, dataDir: cfg.dataDir });
  const reportSecret = warpage.linkSecret(cfg.dataDir);
  const reportPath = id => `/war/${id}-${warpage.sign(reportSecret, id)}`;
  const reportBase = req => cfg.publicUrl || `https://${String(req.headers.host || 'localhost')}`;
  const latestReportId = () => Math.max(0, ...Object.keys(warreport.store.get('reports') || {}).map(Number));
  const reportTries = new Map(); // war id -> { at, error, n }
  const reportBuilding = id => !!(warreport.pending && warreport.pending.has(id));
  function startReport(id, { auto = false } = {}) {
    if (!id || warreport.get(id) || reportBuilding(id)) return;
    const t = reportTries.get(id);
    if (t && (Date.now() - t.at < 10 * 60e3 || (auto && t.n >= 6))) return;
    const n = (t ? t.n : 0) + 1;
    reportTries.set(id, { at: Date.now(), error: '', n });
    warreport.build(id)
      .then(() => { reportTries.delete(id); attachComparison(id); log(`War report ${id} built.`); })
      .catch(e => { reportTries.set(id, { at: Date.now(), error: e.message, n }); log(`War report ${id} failed:`, e.message); });
  }
  // When a ranked war ends its report is built on its own, so the link opens at once.
  // Also: while a ranked war is announced, a fresh pre-war comparison every 10 minutes; the last one
  // before the start stays as the war's pre-war comparison.
  let reportCheck = 0;
  function autoReport(now) {
    if (now - reportCheck < 60e3) return;
    reportCheck = now;
    const r = war.ranked();
    if (r && r.end && r.end <= now - 120e3 && war.state.own) startReport(r.id, { auto: true });
    if (r && war.phase(now) === 'upcoming') snapshotPreWar(r, now);
  }
  // The Opposition Research Report (the user's request, 2026-11-24): us vs them, the app's own
  // intelligence report for both factions and a dossier per member, from the server's Oppo Research
  // records plus what a Mentat device with FFScouter shared (route research/ffscouter; the server
  // has no FFScouter key). Taken every 10 minutes while a ranked war is announced; the last one
  // before the start is the war's report. Each war's is a file in <data>/prewar/.
  const ffsShared = new Store(path.join(cfg.dataDir, 'ffscouter-shared.json'), { factions: {} }, { debounceMs: 5000 });
  const PRE_DIR = path.join(cfg.dataDir, 'prewar');
  fs.mkdirSync(PRE_DIR, { recursive: true });
  const preCache = new Map(); // war id -> object or null
  function readPre(id) {
    if (preCache.has(id)) return preCache.get(id);
    let v = null;
    try { v = JSON.parse(fs.readFileSync(path.join(PRE_DIR, `${Number(id)}.json`), 'utf8')); } catch (e) { /* none */ }
    preCache.set(id, v);
    return v;
  }
  function writePre(id, v) {
    const file = path.join(PRE_DIR, `${Number(id)}.json`);
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(v));
    fs.renameSync(`${file}.tmp`, file);
    preCache.set(id, v);
    // Keep the 20 newest wars
    try {
      const ids = fs.readdirSync(PRE_DIR).map(n => (/^(\d+)\.json$/.exec(n) || [])[1]).filter(Boolean).map(Number).sort((a, b) => b - a);
      for (const old of ids.slice(20)) { fs.rmSync(path.join(PRE_DIR, `${old}.json`), { force: true }); preCache.delete(old); }
    } catch (e) { /* next time */ }
  }
  // Profile pictures for the dossiers: the app's own picture queue, run here with the server's key
  // (one /user/{id}?selections=profile every 8 s at the lowest priority; kept 14 days).
  const avatars = new AvatarsFeature({ api, store: settings, dataDir: cfg.dataDir });
  const photosOf = () => avatars.snapshot().map;

  const enemyIdOf = r => { const own = war.state.own && war.state.own.id; const e = ((r && r.factions) || []).find(f => f.id !== own); return e ? e.id : 0; };
  const comparisonFor = (themId, { asOf = 0 } = {}) => {
    const own = war.state.own && war.state.own.id;
    const them = themId && research.rec(themId), us = own && research.rec(own);
    if (!them || !us || !Object.keys(them.members || {}).length) return null;
    return buildComparison({ them, us, shared: ffsShared.get('factions') || {}, asOf });
  };
  // The whole report for the enemy now (or rebuilt for asOf: wars and chains up to then).
  function oppoFor(themId, { asOf = 0 } = {}) {
    const own = war.state.own && war.state.own.id;
    const them = themId && research.rec(themId), us = own && research.rec(own);
    if (!them || !us || !Object.keys(them.members || {}).length) return null;
    const shared = ffsShared.get('factions') || {};
    const comparison = buildComparison({ them, us, shared, asOf });
    // A rebuilt report must not count the war itself (or anything after it) as history.
    const cut = rec => (asOf && rec.record ? { ...rec, record: { ...rec.record, wars: (rec.record.wars || []).filter(w => w.end && w.end <= asOf) } } : rec);
    const intelOf = (rec, other, self) => {
      try {
        const s = shared[rec.id] || {};
        const r = intelHtml({ rec: cut(rec), us: other ? cut(other) : null, stats: s.stats || {}, ffs: s.intel || null, snapStats: SNAP_STATS, self });
        return { r, dossiers: buildDossiers({ rec: cut(rec), M: r.model, ffs: s.intel || null, asOf: asOf || Date.now() }) };
      } catch (e) { log('Opposition research report:', e.stack || e.message); return null; }
    };
    const T = intelOf(them, us, false), U = intelOf(us, null, true);
    avatars.want([...Object.keys(them.members), ...Object.keys(us.members)]);
    return {
      at: Date.now(), asOf: asOf || 0, rebuilt: !!asOf, enemyId: themId, comparison,
      intel: { them: T ? { html: T.r.html, wars: T.r.wars, level: T.r.level } : null, us: U ? { html: U.r.html, wars: U.r.wars, level: U.r.level } : null },
      dossiers: T && U ? { them: T.dossiers, us: U.dossiers } : null,
    };
  }
  function snapshotPreWar(r, now) {
    const have = readPre(r.id);
    if (have && !have.rebuilt && now - have.at < 10 * 60e3) return;
    const o = oppoFor(enemyIdOf(r));
    if (!o) return;
    writePre(r.id, o);
    pagesFor.delete(r.id);
  }
  // A war's Opposition Research Report: the last snapshot before it began, else rebuilt for its
  // start from the research collected by then (only when the server missed the time before it).
  function preWarFor(id, enemyId, start) {
    const snap = readPre(id);
    if (snap && (!start || snap.rebuilt || snap.at <= start)) return snap;
    if (!start) return null;
    const o = oppoFor(enemyId, { asOf: start });
    if (o) writePre(id, o);
    return o;
  }
  // A finished report keeps both comparisons: before the war (in its prewar file) and now.
  function attachComparison(id) {
    const all = warreport.store.get('reports') || {};
    const m = all[id];
    if (!m) return;
    const enemyId = m.them && m.them.id;
    preWarFor(id, enemyId, m.war.start);
    if (!m.comparison) { const c = comparisonFor(enemyId); if (c) { m.comparison = c; warreport.store.set('reports', all); } }
  }
  const pagesFor = new Map(); // war id -> { key, at, html, gz, etag } for the war's pages

  // /war/<id>-<sig>[/members]: the war report, or before/during the war the Opposition Research
  // Report; /members is the member dossiers of the Opposition Research Report.
  function serveReport(req, res, which, sig, sub) {
    const out = (code, html, cache) => {
      const zipped = /\bgzip\b/.test(req.headers['accept-encoding'] || '');
      const raw = Buffer.from(html);
      const body = zipped ? (cache && cache.gz) || zlib.gzipSync(raw) : raw;
      res.writeHead(code, {
        'Content-Type': 'text/html; charset=utf-8', 'Content-Length': body.length,
        // Pictures come from Torn's image servers (the dossiers' photos)
        'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; img-src 'self' https://*.torn.com; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
        'X-Frame-Options': 'DENY', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Robots-Tag': 'noindex, nofollow',
        'Cache-Control': cache ? 'no-cache' : 'no-store', ...(cache ? { ETag: cache.etag } : {}),
        ...(zipped ? { 'Content-Encoding': 'gzip', Vary: 'Accept-Encoding' } : {}),
      });
      res.end(req.method === 'HEAD' ? undefined : body);
    };
    const cached = (key, make) => {
      let c = pagesFor.get(`${key}`);
      if (!c || c.key !== key.k) {
        const html = make();
        if (html == null) return null;
        c = { key: key.k, html, gz: zlib.gzipSync(Buffer.from(html)), etag: `"wr-${crypto.createHash('sha256').update(html).digest('base64url').slice(0, 16)}"` };
        pagesFor.set(`${key}`, c);
      }
      if (req.headers['if-none-match'] === c.etag) { res.writeHead(304, { ETag: c.etag, 'Cache-Control': 'no-cache' }); res.end(); return true; }
      out(200, c.html, c);
      return true;
    };
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405, { Allow: 'GET, HEAD' }); return res.end(); }
    if (!warpage.sigOk(reportSecret, which, sig)) return out(404, warpage.waitingPage({ error: 'This link is not right. Ask for a new one.' }));
    const base = `/war/${which}-${sig}`;
    // "latest": the ranked war announced or running now, else the newest report.
    const r = war.ranked();
    const current = r && war.phase() !== 'ended' ? r : null;
    const id = which === 'latest' ? (r && war.phase() ? r.id : latestReportId()) : Number(which);
    if (!id) return out(200, warpage.waitingPage({ error: 'There is no war report yet. Mentat makes one when a ranked war ends.' }));
    const m = warreport.get(id);
    const isCurrent = !m && current && current.id === id;
    const started = isCurrent ? current.start <= Date.now() : true;
    const tenMin = Math.floor(Date.now() / 600e3);

    // The Opposition Research Report for this war (live before it starts, frozen after)
    const pre = () => {
      if (isCurrent && !started) { snapshotPreWar(current, Date.now()); return readPre(id); }
      return preWarFor(id, isCurrent ? enemyIdOf(current) : m && m.them && m.them.id, isCurrent ? current.start : m && m.war.start);
    };
    const photoKey = () => Object.keys(photosOf()).length;

    if (sub === 'members') {
      const p = pre();
      if (!p || !p.dossiers) return out(200, warpage.waitingPage({ warId: id, error: 'The member dossiers are not ready yet. Mentat is still researching the enemy; try again in a few minutes.' }));
      return cached({ toString: () => `${id}/members`, k: `${p.at}|${photoKey()}` }, () => warpage.membersPage({ pre: p, war: isCurrent ? current : { id, start: m ? m.war.start : 0 }, photos: photosOf(), back: base, finished: !!m }));
    }
    if (isCurrent) {
      // Before the war: the report as it is now (what gets frozen). During it: the frozen one and the
      // comparison now, made again every 10 minutes.
      return cached({ toString: () => `${id}`, k: `${tenMin}|${started}|${(readPre(id) || {}).at || 0}` }, () => {
        const p = pre();
        const now = started ? comparisonFor(enemyIdOf(current)) : null;
        if (!p && !now) return null;
        return warpage.oppoPage({ pre: p, now, war: current, base });
      }) || out(200, warpage.waitingPage({ warId: id, error: 'Mentat is still researching the enemy. Try again in a few minutes.' }));
    }
    if (!m) {
      startReport(id);
      const t = reportTries.get(id);
      const error = !reportBuilding(id) && t && t.error ? `Mentat couldn't build this report: ${t.error}` : '';
      return out(200, warpage.waitingPage({ warId: id, error, progress: warreport.state.building === id ? warreport.state.progress : '' }));
    }
    if (!m.comparison || !readPre(id)) attachComparison(id); // a report made before its research was in
    const mm = warreport.get(id);
    const p = readPre(id);
    return cached({ toString: () => `${id}`, k: `${mm.builtAt}|${mm.comparison ? mm.comparison.at : 0}|${p ? p.at : 0}` }, () => warpage.reportPage(mm, { pre: p, base }));
  }
  // Chain leads set the hit speed: the owner, admins, and the positions ticked on the board.
  const positionOf = pid => {
    const m = war.state.ours && war.state.ours.members.find(x => x.id === Number(pid));
    return (m && m.position) || ((members.data.members || {})[pid] || {}).position || '';
  };
  // Admin > Chain Lead > Chain Sublead (the user's rule, 2026-11-22). Admins (owner, server admins)
  // pick the chain lead positions; chain leads (and admins) add and remove chain subleads by name;
  // all three have the queue powers (hit speed, adding and removing people in the queue).
  const isAdminWho = who => !!(who.owner || who.admin || isOwnerPid(who.pid));
  const roleOf = who => (isAdminWho(who) ? 'admin' : queue.isLeadPosition(positionOf(who.pid)) ? 'lead' : queue.isSublead(who.pid) ? 'sublead' : '');
  const isLead = who => !!roleOf(who);
  const canManageSubleads = who => ['admin', 'lead'].includes(roleOf(who));
  // The faction's members, for chain leads adding people to the queue: the server's own member
  // list (/v2/faction/members), plus anyone in the faction who has signed in to Mentat.
  const factionRoster = () => {
    const out = new Map();
    for (const m of (war.state.ours && war.state.ours.members) || []) out.set(m.id, { id: m.id, name: m.name, last: m.last || '', state: m.state || '' });
    const fid = members.factionId();
    for (const [id, m] of Object.entries(members.data.members || {})) {
      if (fid && m.factionId === fid && m.name && !out.has(Number(id))) out.set(Number(id), { id: Number(id), name: m.name, last: '', state: '' });
    }
    return [...out.values()].sort((a, b) => a.name.localeCompare(b.name));
  };
  log(odds.configured() ? 'Live odds: on.' : 'Live odds: off (no odds_key).');
  members.onRevoke = (pid, why) => push.unsubscribe(pid, null, why);
  if (!push.enabled) log('Phone alerts are off: no push secret (credential push_secret).');

  // ---- Torn API calls per player ----
  // "Each user can make up to 100 individual requests per minute across all of their keys"
  // (torn.com/api.html). Every Mentat device reports its own calls of the last minute with its
  // status check; the server adds the calls it makes with that player's key (the server key is
  // the owner's; phone alerts use each member's own key) and answers with the total made
  // elsewhere, so each device, and this server's own queue, leaves room for the rest.
  const usage = { devices: new Map(), push: new Map() }; // pid -> Map(device -> { n, at }) / [times]
  const USAGE_FRESH = 150e3;
  function noteDevice(pid, device, used) {
    const n = Math.round(Number(used));
    if (!device || !/^[\w-]{1,64}$/.test(device) || !Number.isFinite(n) || n < 0 || n > 1000) return;
    const now = Date.now();
    let m = usage.devices.get(pid);
    if (!m) usage.devices.set(pid, (m = new Map()));
    for (const [d, r] of m) if (now - r.at > USAGE_FRESH) m.delete(d);
    if (m.size >= 20 && !m.has(device)) return;
    m.set(device, { n, at: now });
  }
  function tornCounted(key, p, pid) {
    if (pid) {
      const now = Date.now();
      usage.push.set(pid, (usage.push.get(pid) || []).filter(t => now - t < 60e3).concat(now));
    }
    return tornWithKey(key, p);
  }
  const pushCalls = pid => (usage.push.get(pid) || []).filter(t => Date.now() - t < 60e3).length;
  // Other devices' reports, leaving out the asking device.
  function deviceCalls(pid, except) {
    const now = Date.now();
    let n = 0, count = 0;
    for (const [d, r] of usage.devices.get(pid) || []) if (d !== except && now - r.at < USAGE_FRESH) { n += r.n; count++; }
    return { n, count };
  }
  function usageFor(pid, device) {
    const d = deviceCalls(pid, device);
    return { server: isOwnerPid(pid) ? api.status().usedLastMinute : 0, push: pushCalls(pid), devices: d.n, deviceCount: d.count, limit: 100 };
  }
  // What this server's own queue must leave room for: the owner's devices and phone alerts.
  const othersOf = pid => deviceCalls(pid, null).n + pushCalls(pid);
  const memberSettings = pid => {
    if (!memberStores.has(pid)) memberStores.set(pid, memberSettingsStore(cfg.dataDir, pid));
    return memberStores.get(pid);
  };

  // Whose settings a request reads and writes. The owner's PCs (access token) and the owner signing
  // in with their own Torn key (web app, phone) are one person, so they share one copy: the owner's.
  const isOwnerPid = pid => !!(account && pid && Number(pid) === Number(account.id));
  const settingsFor = who => {
    if (who && (who.owner || isOwnerPid(who.pid))) { joinOwnerMember(); return settings; }
    return memberSettings(who.pid);
  };
  // Once: settings the owner saved while signed in as a member (before the two were joined) are
  // merged into the owner's copy. The plan and lists are merged item by item; for other settings the
  // newer change wins. Every setting then gets a new revision, so devices on either copy pull it all.
  let ownerJoined = false;
  function joinOwnerMember() {
    if (ownerJoined || !account) return;
    ownerJoined = true;
    const pid = Number(account.id);
    const file = path.join(cfg.dataDir, 'members', `${pid}.json`);
    if (!fs.existsSync(file)) return;
    const m = memberSettings(pid);
    const md = (m.data && m.data.sync) || { rev: 0, units: {} };
    const od = settings.data.sync;
    const rev = Math.max(od.rev, md.rev) + 1;
    let n = 0;
    for (const [u, meta] of Object.entries(md.units || {})) {
      if (!UNIT_SET.has(u)) continue;
      const theirs = m.get(u);
      const mine = od.units[u];
      let v;
      if (!mine) v = theirs;
      else if (u === 'planner.items') v = mergePlan(settings.get(u), theirs);
      else if (['targets.list', 'market.watch', 'travel.learned', 'travel.override', 'gamble.log', 'war.pinned', 'alerts.rules'].includes(u)) v = (meta.at || 0) >= (mine.at || 0) ? joinUnit(u, settings.get(u), theirs) : joinUnit(u, theirs, settings.get(u));
      else v = (meta.at || 0) > (mine.at || 0) ? theirs : settings.get(u);
      settings.set(u, v);
      od.units[u] = { rev, at: Math.max(meta.at || 0, (mine && mine.at) || 0) };
      n++;
    }
    for (const u of Object.keys(od.units)) od.units[u] = { ...od.units[u], rev };
    od.rev = rev;
    settings.set('sync', od);
    try { settings.flush(); } catch (e) { /* saved on the next write */ }
    try { m.flush(); } catch (e) { /* ignore */ }
    memberStores.delete(pid);
    try { fs.renameSync(file, path.join(cfg.dataDir, 'members', `${pid}.joined-into-owner-${Date.now()}.json`)); } catch (e) { log("Could not set aside the owner's member settings:", e.message); }
    log(`Joined ${n} settings the owner saved while signed in as a member into the owner's settings.`);
  }

  let account = null;
  const whoAmI = () => api.request('/user/?selections=profile', { priority: 0 })
    .then(d => {
      const fac = d.faction || {};
      account = { id: d.player_id, name: d.name, factionId: Number(fac.faction_id) || 0, factionName: fac.faction_name || '' };
      members.setOwner(account);
      log(`Collecting as ${d.name} [${d.player_id}]${account.factionId ? `, faction ${account.factionName} [${account.factionId}]` : ''}. Sign-ins: ${members.factionId() ? `members of faction ${members.factionId()}` : 'nobody yet (no faction)'} and the allow-list.`);
    })
    .catch(e => { log('Could not check the Torn key:', e.message); setTimeout(whoAmI, 5 * 60e3).unref(); });
  whoAmI();

  // Off-site copies: flush everything to disk first so the copy is current.
  const flushAll = () => {
    for (const st of [history.store, history.baz, travel.history, war.db, research.db, scout.db, muggerDb.db]) { try { if (st.timer) st.flush(); } catch (e) { /* next time */ } }
    try { activity.flush(); archive.flush(); } catch (e) { /* next time */ }
    queue.flush();
    energy.flush();
    try { warreport.flush(); ffsShared.flush(); avatars.db.flush(); } catch (e) { /* next time */ }
  };
  const cloud = new CloudBackup(cfg.cloud, cfg.dataDir, log, flushAll);
  if (cfg.cloud.enabled && !cloud.configured()) log('Cloud backup is on in config.json but not set up yet (endpoint, bucket and access keys).');
  cloud.check();

  const C = cfg.collect;
  const loops = [
    [C.war || C.research, war], [C.research, research], [C.travel, travel],
    [C.prices, market], [C.bazaar, bazaar], [C.scout, scout], [C.mugger && C.travel, muggerDb],
  ].filter(([on]) => on).map(([, f]) => f);
  const ticker = setInterval(() => {
    const now = Date.now();
    for (const f of loops) { try { f.tick(now); } catch (e) { log('Collector error:', e.stack || e.message); } }
    try { queue.tick(now); } catch (e) { log('Hit queue error:', e.stack || e.message); }
    try { queueDibs(now); } catch (e) { log('Queue dibs error:', e.stack || e.message); }
    try { claims.tick(now); } catch (e) { log('Dibs error:', e.stack || e.message); }
    try { avatars.tick(now); } catch (e) { log('Pictures error:', e.message); }
    if (C.war) { try { autoReport(now); } catch (e) { log('War report error:', e.stack || e.message); } }
    try { cloud.tick(now); } catch (e) { log('Cloud backup error:', e.message); }
    members.tick(now).catch(e => log('Members check error:', e.message));
    if (account) api.setOthers(othersOf(account.id, null));
    push.tick(now, tornCounted).catch(e => log('Phone alerts error:', e.message));
  }, 1000);

  const SETS = {
    research: { store: research.db },
    war: { store: war.db },
    travel: { store: travel.history, after: () => travel.rebuild(Date.now()) },
    prices: { store: history.store },
    bazaar: { store: history.baz },
    scout: { store: scout.sync },
    mugger: { store: muggerDb.db },
  };
  const revOf = name => `${boot}.${SETS[name].store.rev}`;
  const cache2 = {}; // name -> { rev, json, gz }

  function status(who, device = '') {
    const r = war.ranked();
    const full = who && (who.owner || who.admin);
    return {
      app: 'torn-desktop-server', version: VERSION, apiVersion: API_VERSION, serverId, startedAt, now: Date.now(),
      account, keyOk,
      api: { banner: keyOk ? api.banner : "The server's Torn API key was rejected. Run \"node server/server.js set-key\" on the server, then restart it.", usedLastMinute: api.status().usedLastMinute, maxPerMinute: cfg.maxPerMinute },
      collect: C,
      revs: Object.fromEntries(DATASETS.map(n => [n, revOf(n)])),
      settingsRev: who ? settingsFor(who).data.sync.rev : 0,
      war: { own: war.state.own, phase: war.phase(), fetchedAt: (war.state.wars && war.state.wars.fetchedAt) || 0, ranked: r ? { id: r.id, start: r.start, end: r.end, factions: r.factions.map(f => ({ id: f.id, name: f.name, score: f.score })) } : null },
      research: { tracked: research.tracked().map(t => ({ id: t.id, name: t.name || (research.rec(t.id) || {}).name || '', why: t.why })), personalQueue: research.snapshot().personalQueue },
      travel: { fetchedAt: travel.state.fetchedAt, yataTimestamp: travel.state.yataTimestamp || 0, error: travel.state.error },
      bazaar: { fetchedAt: bazaar.summary.fetchedAt, error: bazaar.error },
      prices: { catalogAt: (cache.get('items') || {}).fetchedAt || 0 },
      cloudBackup: full ? cloud.status() : null,
      me: who ? who.me : null,
      usage: who && who.pid ? usageFor(who.pid, device) : null,
      scout: (() => { const v = scout.view(); return { pool: v.pool.length, interval: v.interval, samplesLastHour: v.samplesLastHour, own: v.own, error: v.error || v.ladderError, activity: v.activity, archive: v.archive }; })(),
    };
  }

  const fails = new Map(); // ip -> failed sign-in times
  function send(req, res, code, obj, extra = {}) {
    const body = Buffer.from(JSON.stringify(obj));
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': body.length, ...extra });
    res.end(req.method === 'HEAD' ? undefined : body);
  }

  async function sendData(req, res, name) {
    const rev = revOf(name);
    let c = cache2[name];
    if (!c || c.rev !== rev) {
      const json = Buffer.from(JSON.stringify(SETS[name].store.data));
      c = cache2[name] = { rev, json, gz: await gzip(json) };
    }
    const etag = `"${rev}"`;
    if (req.headers['if-none-match'] === etag) { res.writeHead(304, { ETag: etag }); return res.end(); }
    const zipped = /\bgzip\b/.test(req.headers['accept-encoding'] || '');
    const body = zipped ? c.gz : c.json;
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': body.length, ETag: etag, 'X-Rev': rev, ...(zipped ? { 'Content-Encoding': 'gzip' } : {}) });
    res.end(body);
  }

  async function handle(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    const url = new URL(req.url, 'http://localhost');
    // Works with or without a path prefix from a reverse proxy (/torn-desktop/api/v1/...).
    const at = url.pathname.indexOf('/api/v1/');
    // The war board's routes may be called from Torn's pages directly (CORS, cfg.corsOrigins).
    const origin = String(req.headers.origin || '');
    if (at >= 0 && origin && cfg.corsOrigins.includes(origin) && CORS_ROUTES.test(url.pathname.slice(at + 8))) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      if (req.method === 'OPTIONS') {
        res.writeHead(204, { 'Access-Control-Allow-Methods': 'GET, POST', 'Access-Control-Allow-Headers': 'Authorization, Content-Type, Accept', 'Access-Control-Max-Age': '600' });
        return res.end();
      }
    }
    if (at < 0) {
      res.removeHeader('Cache-Control');
      // The userscripts' update check files (/pda/mentat-war.meta.js, /pda/mentat-mugger.meta.js).
      const meta = /^\/pda\/(mentat-[a-z]+)\.meta\.js$/.exec(url.pathname);
      if (meta) return serveScriptMeta(req, res, meta[1], cfg.publicUrl);
      // Shared war reports: /war/<warId>-<sig> and /war/latest-<sig>.
      const wr = /^\/war\/(\d{1,12}|latest)-([\w-]{12})(?:\/(members))?\/?$/.exec(url.pathname);
      if (wr) return serveReport(req, res, wr[1], wr[2], wr[3] || '');
      if (url.pathname === '/download' || url.pathname === '/download/' || url.pathname.startsWith('/downloads/')) return serveDownload(req, res, url.pathname, cfg.downloadsDir);
      return serveFile(req, res, url.pathname, cfg.publicUrl);
    }
    const route = url.pathname.slice(at + 8);
    if (route === 'health') return send(req, res, 200, { ok: true, app: 'torn-desktop-server', login: true, faction: { id: members.factionId(), name: members.factionName() } });

    // Sign in with your own Torn API key (members of the faction and the allow-list).
    if (route === 'login' && req.method === 'POST') {
      const body = await readBody(req);
      try {
        const r = await members.login(body.key, { ip: ipOf(req), device: body.device });
        return send(req, res, 200, r);
      } catch (e) {
        if (!e.code) log('Sign-in error:', e.message);
        return send(req, res, e.status || 500, { error: e.code ? e.message : 'Sign-in failed. Try again.', code: e.code || 'error' });
      }
    }

    // Your access token (your own PCs) or a member's session.
    const auth = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || '');
    const given = auth ? auth[1].trim() : '';
    let who = null;
    if (given && tokenMatches(given, cfg.token)) who = { owner: true, admin: true, pid: account ? account.id : 0 };
    else if (given) {
      const s = members.check(given);
      if (s) who = { pid: s.pid, admin: members.isAdmin(s.pid) };
    }
    if (!who) {
      const now = Date.now();
      const ip = ipOf(req);
      const mine = (fails.get(ip) || []).filter(x => now - x < 10 * 60e3);
      mine.push(now);
      fails.set(ip, mine);
      if (fails.size > 5000) fails.clear();
      if (mine.length > 30) return send(req, res, 429, { error: 'Too many failed attempts; try again later' });
      return send(req, res, 401, { error: given ? 'Signed out: sign in again with your API key.' : 'Sign in first.', code: 'signed_out' });
    }
    who.me = who.pid ? { ...members.me(who.pid), role: who.owner ? 'owner' : members.role(who.pid) } : { role: 'owner' };

    if (route === 'me' && req.method === 'GET') return send(req, res, 200, who.me);
    if (route === 'logout' && req.method === 'POST') {
      if (!who.owner) members.logout(given);
      return send(req, res, 200, { ok: true });
    }
    if (route === 'status' && req.method === 'GET') {
      const device = String(req.headers['x-mentat-device'] || '').slice(0, 64);
      if (who.pid) noteDevice(who.pid, device, req.headers['x-mentat-used']);
      return send(req, res, 200, status(who, device));
    }

    // Phone alerts while Mentat is closed (opt-in): for members' own devices.
    if (route.startsWith('push/')) {
      const pid = who.pid;
      if (!pid) return send(req, res, 400, { error: 'Sign in with your API key to use phone alerts.' });
      try {
        if (route === 'push/config' && req.method === 'GET') return send(req, res, 200, push.config(pid));
        if (req.method === 'POST') {
          const body = await readBody(req);
          if (route === 'push/subscribe') return send(req, res, 200, await push.subscribe(pid, body, tornCounted));
          if (route === 'push/prefs') return send(req, res, 200, push.setPrefs(pid, body.prefs));
          if (route === 'push/unsubscribe') return send(req, res, 200, push.unsubscribe(pid, typeof body.endpoint === 'string' ? body.endpoint : null));
          if (route === 'push/test') return send(req, res, 200, { sent: await push.test(pid) });
        }
      } catch (e) {
        return send(req, res, e.status || (e.tornCode !== undefined ? 400 : 500), { error: e.status || e.tornCode !== undefined ? e.message : 'Phone alerts failed. Try again.' });
      }
      return send(req, res, 404, { error: 'Not found' });
    }

    // War claims: who's going for which enemy, shared with everyone signed in here.
    if (route === 'war/claims') {
      if (!who.pid) return send(req, res, 400, { error: 'Sign in with your API key to share claims.' });
      try {
        if (req.method === 'GET') return send(req, res, 200, claims.list());
        if (req.method === 'POST') {
          const body = await readBody(req);
          const name = (who.me && who.me.name) || (isOwnerPid(who.pid) && account ? account.name : '') || `#${who.pid}`;
          return send(req, res, 200, claims.set(who.pid, name, body.target, !!body.claim));
        }
      } catch (e) {
        return send(req, res, e.status || 500, { error: e.status ? e.message : 'Claims failed. Try again.' });
      }
      return send(req, res, 405, { error: 'Method not allowed' });
    }

    // The war board (web/pda/mentat-war.user.js): the enemy's members, claims (dibs) and the hit
    // queue in one read. ?members=<fetchedAt the board has> leaves the members out when they
    // haven't changed; ?lite=1 (board closed, just the button's countdown) leaves them out too.
    // Mugger userscript (web/pda/mentat-mugger.user.js): the best traders for a country from the market
    // database (no Torn API here: the script looks players up with each member's OWN key, the user's
    // rule 2026-11-24). ?country=Japan&min=100000&n=60; a pasted People list adds &ids=1,2 (their rows as
    // `extra` when not among the best) and &names=a,b (trader names -> ids, as `named`).
    if (route === 'mugger/traders' && req.method === 'GET') {
      if (!who.pid) return send(req, res, 400, { error: 'Sign in with your API key to use Mugger.' });
      const c = COUNTRIES.find(x => x.name === url.searchParams.get('country'));
      if (!c) return send(req, res, 400, { error: 'Unknown country' });
      const min = [50000, 100000, 250000, 500000, 1000000].includes(Number(url.searchParams.get('min'))) ? Number(url.searchParams.get('min')) : 100000;
      const n = Math.min(150, Math.max(10, Number(url.searchParams.get('n')) || 60));
      const items = muggerDb.items();
      const used = {};
      const rowOf = ({ id, info, linked }) => {
        const sc = scores(info, null, null, c.name);
        for (const i of [...info.items, ...info.small, ...info.spec, ...info.hist]) used[i.id] = [i.name, i.cost, i.countries];
        const ev = info.raw.ev.slice(-40); // every change (the script marks restocks of TRADE_QTY or fewer as small)
        for (const e of ev) if (!used[e[1]] && items.get(e[1])) { const m = items.get(e[1]); used[e[1]] = [m.name, m.cost, m.countries]; }
        return {
          id, name: info.name, first: info.first,
          items: [...info.items, ...info.small].map(i => [i.id, i.q, i.price, i.upd]),
          r30: info.r30, rc30: info.rc30, small30: info.small30,
          dir: { bazaar: info.bazaar, spec: info.spec.map(x => [x.id, x.customers]), busiest: info.busiest, income: info.income, bulk: info.bulk }, s30: info.s30, sv30: info.sv30, active: info.active,
          rc30Here: info.rc30Here, linked,
          hist: info.hist.slice(0, 12).map(x => [x.id, x.q]), // what they have traded (90 days), for trip money
          ev, partsHere: sc.here.parts, partsAll: sc.all.parts,
        };
      };
      const traders = rankTraders(muggerDb, c.name, min, n).map(rowOf);
      const named = {};
      const idx = muggerDb.nameIndex();
      for (const nm of String(url.searchParams.get('names') || '').split(',').map(x => x.trim()).filter(Boolean).slice(0, 200)) { const id = idx.get(nm.toLowerCase()); if (id) named[nm] = id; }
      const inList = new Set(traders.map(t => t.id));
      const want = [...new Set([...String(url.searchParams.get('ids') || '').split(',').map(Number).filter(x => Number.isInteger(x) && x > 0).slice(0, 300), ...Object.values(named)])].filter(id => !inList.has(id));
      const extra = want.map(id => { const info = traderInfo(muggerDb.seller(id), items, c.name, min); return info ? rowOf({ id, info, linked: linked(info, null, c.name) }) : null; }).filter(Boolean);
      return send(req, res, 200, { script: { version: scriptVersion('mentat-mugger') }, country: c.name, min, db: muggerDb.stats(), items: used, traders, extra, named });
    }

    if (route === 'war/board' && req.method === 'GET') {
      if (!who.pid) return send(req, res, 400, { error: 'Sign in with your API key to use the war board.' });
      const name = (who.me && who.me.name) || (isOwnerPid(who.pid) && account ? account.name : '') || `#${who.pid}`;
      const lite = url.searchParams.get('lite') === '1';
      if (!lite) queue.seen(who.pid, name);
      // The enemy only while there is one (the user's rule, 2026-11-22): an active war, a ranked
      // war still to come, or a faction watched from Mentat's War tab. Once the war ends the
      // board clears at once (the War tab keeps the old enemy for 6 h; the server's last copy of
      // the members also stays in memory after that, so it must not be sent).
      const target = war.enemyTarget();
      const over = target && target.source === 'ranked' && war.phase() === 'ended';
      const e = target && !over && war.state.enemy && war.state.enemy.id === target.id ? war.state.enemy : null;
      const have = Number(url.searchParams.get('members')) || 0;
      const r = war.ranked();
      const enemy = e ? { id: e.id, name: e.name, source: e.source, fetchedAt: e.fetchedAt, error: e.error || '', counts: e.counts } : null;
      if (enemy && !lite && have !== e.fetchedAt) {
        enemy.members = e.members.map(m => ({
          id: m.id, name: m.name, level: m.level, state: m.state, description: m.description, until: m.until,
          last: m.last, lastAt: m.lastAt, revivable: m.revivable, onWall: m.onWall,
          trip: m.trip ? { country: m.trip.country, back: m.trip.back, landLo: m.trip.landLo, landHi: m.trip.landHi, expected: m.trip.expected } : null,
          abroadSince: m.abroadSince || 0,
        }));
      }
      // Our own members (the board's Faction tab, the user's request 2026-11-22), sent when the
      // board asks (?ours=<fetchedAt it has>) and they changed since.
      let ours = null;
      const o = war.state.ours;
      if (!lite && url.searchParams.has('ours') && o) {
        ours = { fetchedAt: o.fetchedAt || 0, denied: !!o.denied, counts: o.counts || null };
        if (Number(url.searchParams.get('ours')) !== ours.fetchedAt) {
          ours.members = (o.members || []).map(m => ({
            id: m.id, name: m.name, level: m.level, position: m.position, state: m.state, description: m.description, until: m.until,
            last: m.last, lastAt: m.lastAt, revivable: m.revivable, reviveSetting: m.reviveSetting || '', earlyDischarge: !!m.earlyDischarge,
            trip: m.trip ? { country: m.trip.country, back: m.trip.back, landLo: m.trip.landLo, landHi: m.trip.landHi, expected: m.trip.expected } : null,
            abroadSince: m.abroadSince || 0,
          }));
        }
      }
      return send(req, res, 200, {
        now: Date.now(),
        ours,
        // Shared energy, for the Faction tab (members who opted in).
        energy: ours ? energy.view() : null,
        me: { id: who.pid, name, lead: isLead(who), role: roleOf(who), admin: isAdminWho(who), position: positionOf(who.pid) },
        live: { inWar: war.inWar() },
        script: { version: scriptVersion('mentat-war') },
        positions: (who.owner || who.admin || isOwnerPid(who.pid)) && war.state.ours ? [...new Set(war.state.ours.members.map(m => m.position).filter(Boolean))] : null,
        roster: !lite && isLead(who) ? factionRoster() : null,
        own: war.state.own ? { id: war.state.own.id, name: war.state.own.name } : null,
        war: { phase: war.phase(), ranked: r ? { id: r.id, start: r.start, end: r.end, target: r.target || 0, factions: r.factions.map(f => ({ id: f.id, name: f.name, score: f.score, chain: f.chain || 0 })) } : null },
        enemy,
        claims: lite ? null : claims.list(),
        queue: queue.view(),
        notices: queue.noticesFor(who.pid), // for this person only: e.g. taken off the queue
      });
    }
    // Shared war report links (anyone signed in): ?war=<id> gives that war's link and starts
    // building it if it isn't yet; the "latest" link always shows the newest report.
    if (route === 'war/report-link' && req.method === 'GET') {
      const id = Number(url.searchParams.get('war')) || 0;
      if (id && (!Number.isInteger(id) || id > 1e12)) return send(req, res, 400, { error: 'Which war?' });
      // The war announced or running now has no report yet: its link shows the Comparison until it ends.
      const rw = war.ranked();
      const current = !!(id && rw && rw.id === id && war.phase() !== 'ended');
      if (id && !current) startReport(id);
      const base = reportBase(req);
      const t = id && !current ? reportTries.get(id) : null;
      return send(req, res, 200, {
        current,
        url: id ? `${base}${reportPath(id)}` : null,
        latest: `${base}/war/latest-${warpage.sign(reportSecret, 'latest')}`,
        built: id ? !!warreport.get(id) : null, building: id ? reportBuilding(id) : false,
        error: t && !reportBuilding(id) ? t.error : '',
        reports: Object.keys(warreport.store.get('reports') || {}).map(Number).sort((a, b) => b - a),
      });
    }
    // FFScouter summaries from a Mentat device (owner or admins), for the Comparison tab: activity
    // by hour of the week, estimated battle stats and usual hours of researched factions' members.
    if (route === 'research/ffscouter' && req.method === 'POST') {
      if (!(who.owner || who.admin || isOwnerPid(who.pid))) return send(req, res, 403, { error: 'Only the server owner and admins share FFScouter data.' });
      const body = await readBody(req);
      const list = Array.isArray(body.factions) ? body.factions.slice(0, 10) : [];
      const all = ffsShared.get('factions') || {};
      const finite = (v, lo, hi) => { const n = Number(v); return Number.isFinite(n) && n >= lo && n <= hi ? n : null; };
      let n = 0;
      for (const f of list) {
        const id = finite(f && f.id, 1, 1e9);
        if (!id || !Number.isInteger(id)) continue;
        const week = Array.isArray(f.week) && f.week.length === 168 ? f.week.map(w => (Array.isArray(w) ? [finite(w[0], 0, 1e7) || 0, finite(w[1], 0, 1e5) || 0] : [0, 0])) : null;
        const stats = {}, uh = {};
        for (const [k, v] of Object.entries(f.stats && typeof f.stats === 'object' ? f.stats : {}).slice(0, 250)) { const b = finite(v, 1, 1e15); if (/^\d{1,10}$/.test(k) && b) stats[k] = b; }
        for (const [k, v] of Object.entries(f.uh && typeof f.uh === 'object' ? f.uh : {}).slice(0, 250)) {
          if (/^\d{1,10}$/.test(k) && Array.isArray(v) && v.length === 3) { const a = finite(v[0], 0, 23), b = finite(v[1], 0, 23), s = finite(v[2], 0, 1); if (a != null && b != null && s != null) uh[k] = [a, b, s]; }
        }
        const prev = all[id] || {};
        // The device's whole FFScouter intel for the faction (src/main/features/ffscouter.js
        // loadIntel), for the intelligence report and the dossiers: numbers only, known shapes.
        const nums = (a, len, hi) => (Array.isArray(a) && a.length === len ? a.map(v => finite(v, 0, hi) || 0) : null);
        const pairs = (a, len) => (Array.isArray(a) && a.length === len ? a.map(p => (Array.isArray(p) ? [finite(p[0], 0, 1e7) || 0, finite(p[1], 0, 1e6) || 0] : [0, 0])) : null);
        let intel = null;
        const fi = f.intel && typeof f.intel === 'object' ? f.intel : null;
        if (fi) {
          const members = {}, growth = {};
          for (const [k, m] of Object.entries(fi.members && typeof fi.members === 'object' ? fi.members : {}).slice(0, 250)) {
            if (!/^\d{1,10}$/.test(k) || !m) continue;
            const act = nums(m.act, 96, 1e6), obs = nums(m.obs, 96, 1e6);
            if (act && obs) members[k] = { act, obs, days: finite(m.days, 0, 400) || 0, activeDays: finite(m.activeDays, 0, 400) || 0 };
          }
          const point = p => (p && finite(p.t, 0, 1e14) && finite(p.bs, 1, 1e15) ? { t: Number(p.t), bs: Number(p.bs) } : null);
          for (const [k, g] of Object.entries(fi.growth && typeof fi.growth === 'object' ? fi.growth : {}).slice(0, 250)) {
            if (/^\d{1,10}$/.test(k) && g) growth[k] = { first: point(g.first), mid: point(g.mid), last: point(g.last) };
          }
          const fac = fi.faction && typeof fi.faction === 'object' ? fi.faction : null;
          intel = {
            at: finite(fi.at, 0, 1e14) || Date.now(), days: finite(fi.days, 0, 400) || 0, start: finite(fi.start, 0, 1e14) || 0, end: finite(fi.end, 0, 1e14) || 0,
            faction: fac ? { slots: pairs(fac.slots, 96) || [], week: pairs(fac.week, 168) || [], memberCount: finite(fac.memberCount, 0, 1000) || 0 } : null,
            members, growth,
          };
        }
        all[id] = {
          id, days: finite(f.days, 0, 400) || (week ? prev.days || 0 : 0), week: week || prev.week || null,
          intel: intel || prev.intel || null,
          stats: Object.keys(stats).length ? stats : prev.stats || {}, uh: Object.keys(uh).length ? uh : prev.uh || {},
          at: Math.min(Date.now(), finite(f.at, 0, 1e14) || Date.now()), receivedAt: Date.now(),
        };
        n++;
      }
      for (const k of Object.keys(all).sort((a, b) => all[b].receivedAt - all[a].receivedAt).slice(12)) delete all[k];
      ffsShared.set('factions', all);
      pagesFor.clear();
      return send(req, res, 200, { ok: true, factions: n });
    }
    // Energy sharing (opt-in): a member's own reading, or { off: true } to stop and delete it.
    if (route === 'war/energy' && req.method === 'POST') {
      if (!who.pid) return send(req, res, 400, { error: 'Sign in with your API key to share energy.' });
      const name = (who.me && who.me.name) || (isOwnerPid(who.pid) && account ? account.name : '') || `#${who.pid}`;
      try {
        const body = await readBody(req);
        if (body.off) { energy.remove(who.pid); return send(req, res, 200, { ok: true, sharing: false }); }
        const m = energy.report(who.pid, name, body);
        return send(req, res, 200, { ok: true, sharing: true, at: m.at });
      } catch (e) {
        return send(req, res, e.status || 500, { error: e.status ? e.message : 'Sharing failed. Try again.' });
      }
    }
    if (route === 'war/queue' && req.method === 'POST') {
      if (!who.pid) return send(req, res, 400, { error: 'Sign in with your API key to use the hit queue.' });
      const name = (who.me && who.me.name) || (isOwnerPid(who.pid) && account ? account.name : '') || `#${who.pid}`;
      try {
        const body = await readBody(req);
        const act = String(body.act || '');
        if (act === 'join' && body.for && Number(body.for) !== who.pid) {
          // A chain lead putting a faction member in the queue (the user's request, 2026-11-22).
          if (!isLead(who)) return send(req, res, 403, { error: 'Only chain leads can add other people to the queue.' });
          const m = factionRoster().find(x => x.id === Number(body.for));
          if (!m) return send(req, res, 400, { error: 'That player isn\'t in the faction.' });
          queue.join(m.id, m.name, { target: body.target, note: body.note, addedBy: name });
        } else if (act === 'join') queue.join(who.pid, name, { target: body.target, note: body.note });
        else if (act === 'leave') queue.remove(who.pid, body.entry, { admin: who.admin || isLead(who) });
        else if (act === 'done') queue.remove(who.pid, body.entry, { how: 'done' });
        else if (act === 'skip') queue.skip(who.pid, name, body.entry);
        else if (act === 'later') queue.later(who.pid, body.entry);
        else if (act === 'ack') queue.ack(who.pid, body.notice); // a notice dismissed (on any of their devices)
        else if (act === 'target') queue.setTarget(who.pid, body.entry, body.target, { lead: isLead(who) });
        else if (act === 'mode') {
          // Queue or Hit at will (the user's request, 2026-11-26): chain subleads and up.
          if (!isLead(who)) return send(req, res, 403, { error: 'Only chain leads and subleads can switch between Queue and Hit at will.' });
          queue.setMode(who.pid, name, String(body.mode || ''));
        } else if (act === 'hitAt') {
          if (!isLead(who)) return send(req, res, 403, { error: 'Only chain leads can set the hit speed.' });
          queue.setHitAt(who.pid, name, body.sec);
        } else if (act === 'leads') {
          if (!(who.owner || who.admin || isOwnerPid(who.pid))) return send(req, res, 403, { error: 'Only the server owner and admins choose the chain leads.' });
          queue.setLeadPositions(body.positions);
        } else if (act === 'addSublead') {
          if (!canManageSubleads(who)) return send(req, res, 403, { error: 'Only admins and chain leads can add chain subleads.' });
          const m = factionRoster().find(x => x.id === Number(body.player));
          if (!m) return send(req, res, 400, { error: 'That player isn\'t in the faction.' });
          queue.addSublead(m.id, m.name, name);
        } else if (act === 'removeSublead') {
          if (!canManageSubleads(who)) return send(req, res, 403, { error: 'Only admins and chain leads can remove chain subleads.' });
          queue.removeSublead(body.player);
        }
        else return send(req, res, 400, { error: 'Unknown action' });
        try { queueDibs(); } catch (e) { log('Queue dibs error:', e.stack || e.message); }
        queue.seen(who.pid, name);
        return send(req, res, 200, { now: Date.now(), queue: queue.view() });
      } catch (e) {
        return send(req, res, e.status || 500, { error: e.status ? e.message : 'The hit queue failed. Try again.' });
      }
    }

    // Bookmaker odds for the Bookie helper (any signed-in member).
    if (route.startsWith('odds/') && req.method === 'GET') {
      try {
        if (route === 'odds/status') return send(req, res, 200, odds.status());
        if (route === 'odds/sports') return send(req, res, 200, await odds.sports());
        if (route === 'odds/events') return send(req, res, 200, await odds.events(url.searchParams.get('sport')));
        if (route === 'odds/top') return send(req, res, 200, await odds.top());
      } catch (e) {
        if (!e.status) log('Odds error:', e.message);
        return send(req, res, e.status || 502, { error: e.status ? e.message : 'Couldn\'t get odds right now.', code: e.code || 'odds_error' });
      }
      return send(req, res, 404, { error: 'Not found' });
    }

    // Admins: who's using Mentat, the allow-list, signing someone out.
    if (route.startsWith('admin/')) {
      if (!who.admin) return send(req, res, 403, { error: 'Admins only.' });
      if (route === 'admin/members' && req.method === 'GET') return send(req, res, 200, members.list());
      if (req.method === 'POST') {
        const body = await readBody(req);
        try {
          if (route === 'admin/allow') return send(req, res, 200, await members.allow(body.id, body.note, who.pid));
          if (route === 'admin/disallow') return send(req, res, 200, members.disallow(body.id));
          if (route === 'admin/signout') return send(req, res, 200, members.signOutEverywhere(body.id));
        } catch (e) {
          return send(req, res, e.status || 500, { error: e.status ? e.message : 'Failed.' });
        }
      }
      return send(req, res, 404, { error: 'Not found' });
    }

    const m = /^data\/([a-z]+)$/.exec(route);
    if (m && SETS[m[1]]) {
      if (req.method === 'GET') return sendData(req, res, m[1]);
      if (req.method === 'POST' && !PULL_ONLY.has(m[1])) {
        if (!who.owner) return send(req, res, 403, { error: "Members can't upload data to the shared store." });
        const body = await readBody(req);
        const set = SETS[m[1]];
        set.store.data = MERGE[m[1]](set.store.data, body);
        set.store.save();
        if (set.after) set.after();
        log(`Merged uploaded ${m[1]} data.`);
        return send(req, res, 200, { ok: true, rev: revOf(m[1]) });
      }
    }

    if (route === 'settings') {
      const st = settingsFor(who);
      const doc = st.data.sync;
      if (req.method === 'GET') {
        const since = Number(url.searchParams.get('since')) || 0;
        const units = {};
        for (const [u, meta] of Object.entries(doc.units)) if (meta.rev > since) units[u] = { v: st.get(u) ?? null, rev: meta.rev };
        return send(req, res, 200, { rev: doc.rev, units });
      }
      if (req.method === 'PUT') {
        const body = await readBody(req);
        const given = body && typeof body.units === 'object' && body.units ? body.units : {};
        const revs = {};
        for (const [u, v] of Object.entries(given)) {
          if (!UNIT_SET.has(u)) continue;
          if (JSON.stringify(v ?? null).length > 4 * 1024 * 1024) continue;
          // The plan is merged item by item, so two devices editing it at once both keep their changes.
          st.set(u, u === 'planner.items' ? prunePlan(mergePlan(st.get(u), v)) : v);
          doc.rev++;
          doc.units[u] = { rev: doc.rev, at: Date.now() };
          revs[u] = doc.rev;
        }
        st.set('sync', doc);
        return send(req, res, 200, { rev: doc.rev, revs });
      }
    }
    return send(req, res, 404, { error: 'Not found' });
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch(e => {
      if (!e.status) log('Request error:', e.stack || e.message);
      if (!res.headersSent) send(req, res, e.status || 500, { error: e.status ? e.message : 'Server error' });
      else res.destroy();
    });
  });
  server.requestTimeout = 120e3;
  server.listen(cfg.port, cfg.host, () => log(`Mentat sync server ${VERSION} on http://${cfg.host}:${cfg.port} (data in ${cfg.dataDir}).`));

  function stop() {
    log('Stopping: saving data.');
    clearInterval(ticker);
    for (const s of [settings, cache, history.store, history.baz, travel.history, war.db, research.db, scout.db, activity, archive, members, warreport, ffsShared, avatars.db, ...memberStores.values()]) { try { s.flush(); } catch (e) { log('Save failed:', e.message); } }
    server.close();
    process.exit(0);
  }
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  // Save every 10 minutes too, so a power cut loses little.
  setInterval(flushAll, 10 * 60e3).unref();
}

// ---------------------------------------------------------------- main
(async () => {
  const file = configPath();
  const cmd = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : 'run';
  try {
    if (cmd === 'init') await cmdInit(file);
    else if (cmd === 'set-key') await cmdSetKey(file);
    else if (cmd === 'token') cmdToken(file);
    else if (cmd === 'run') await run(file);
    else console.log('Commands: init | run | token | set-key   (option: --config <file>)');
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
})();
