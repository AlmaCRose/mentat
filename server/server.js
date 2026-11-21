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
const { TravelFeature } = require(path.join(LIB, 'features', 'travel'));
const { MarketFeature } = require(path.join(LIB, 'features', 'market'));
const { BazaarFeature } = require(path.join(LIB, 'features', 'bazaar'));
const { ScoutFeature } = require(path.join(LIB, 'features', 'scout'));
const { ActivityStore } = require(path.join(LIB, 'activity'));
const { WarArchive } = require(path.join(LIB, 'warchive'));
const { UNIT_SET, DATASETS, PULL_ONLY, MERGE, mergePlan, prunePlan, joinUnit } = require(path.join(LIB, 'syncmerge'));
const { CloudBackup } = require('./cloudbackup');
const { Members, tornWithKey } = require('./members');
const { Claims } = require('./claims');
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
    collect: { research: true, war: true, travel: true, prices: true, bazaar: true, scout: true, ...(c.collect || {}) },
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
  const claims = new Claims();
  war.on('members', (fid, list) => claims.observe(list));
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
    for (const st of [history.store, history.baz, travel.history, war.db, research.db, scout.db]) { try { if (st.timer) st.flush(); } catch (e) { /* next time */ } }
    try { activity.flush(); archive.flush(); } catch (e) { /* next time */ }
  };
  const cloud = new CloudBackup(cfg.cloud, cfg.dataDir, log, flushAll);
  if (cfg.cloud.enabled && !cloud.configured()) log('Cloud backup is on in config.json but not set up yet (endpoint, bucket and access keys).');
  cloud.check();

  const C = cfg.collect;
  const loops = [
    [C.war || C.research, war], [C.research, research], [C.travel, travel],
    [C.prices, market], [C.bazaar, bazaar], [C.scout, scout],
  ].filter(([on]) => on).map(([, f]) => f);
  const ticker = setInterval(() => {
    const now = Date.now();
    for (const f of loops) { try { f.tick(now); } catch (e) { log('Collector error:', e.stack || e.message); } }
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
    if (at < 0) {
      res.removeHeader('Cache-Control');
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
    for (const s of [settings, cache, history.store, history.baz, travel.history, war.db, research.db, scout.db, activity, archive, members, ...memberStores.values()]) { try { s.flush(); } catch (e) { log('Save failed:', e.message); } }
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
