'use strict';
// Off-site backups of the server's data folder to S3-compatible storage (Cloudflare R2,
// Backblaze B2, AWS S3, Wasabi, MinIO…). Plain Node, no packages.
//
// Every hour (by default) it packs the whole data folder into a .tar.gz, checks the archive
// unpacks, uploads it as <prefix>/torn-desktop-YYYYMMDD-HHMMSS.tar.gz, then prunes: every copy
// from the last `hourlyHours` (48) is kept, and before that the newest copy of each day for
// `dailyDays` (30). Only objects with that name pattern are ever deleted.
//
// The data folder holds collected game data and the synced app settings; the Torn key and
// the access token are NOT in it (they live in config or credential files).
//
// Status goes to <dataDir>/cloud-backup.json (also shown by GET /api/v1/status).

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { promisify } = require('util');

const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);
const NAME = /torn-desktop-(\d{8})-(\d{6})\.tar\.gz$/;

// ---- Minimal tar (ustar) writer ----
function tarHeader(name, size, mtime) {
  const h = Buffer.alloc(512, 0);
  let prefix = '';
  if (Buffer.byteLength(name) > 100) { const i = name.lastIndexOf('/', 154); prefix = name.slice(0, i); name = name.slice(i + 1); }
  h.write(name, 0, 100, 'utf8');
  h.write('0000644\0', 100);
  h.write('0000000\0', 108);
  h.write('0000000\0', 116);
  h.write(`${size.toString(8).padStart(11, '0')}\0`, 124);
  h.write(`${Math.floor(mtime / 1000).toString(8).padStart(11, '0')}\0`, 136);
  h.write('        ', 148);
  h.write('0', 156);
  h.write('ustar\0', 257);
  h.write('00', 263);
  h.write(prefix, 345, 155, 'utf8');
  let sum = 0;
  for (const b of h) sum += b;
  h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
  return h;
}

async function walk(dir, base = dir, out = []) {
  for (const e of await fs.promises.readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) await walk(p, base, out);
    else if (e.isFile() && !/\.tmp$/.test(e.name)) out.push(p);
  }
  return out;
}

// Files are written whole (temp file + rename), so each one read here is complete.
async function packFolder(dir) {
  const parts = [];
  let files = 0;
  for (const p of (await walk(dir)).sort()) {
    let data, st;
    try { [data, st] = await Promise.all([fs.promises.readFile(p), fs.promises.stat(p)]); } catch (e) { continue; } // removed meanwhile
    parts.push(tarHeader(path.relative(dir, p).split(path.sep).join('/'), data.length, st.mtimeMs), data);
    if (data.length % 512) parts.push(Buffer.alloc(512 - (data.length % 512)));
    files++;
  }
  parts.push(Buffer.alloc(1024));
  const tar = Buffer.concat(parts);
  return { gz: await gzip(tar, { level: 6 }), files, raw: tar.length };
}

// ---- S3 (AWS Signature Version 4) ----
const enc = s => encodeURIComponent(s).replace(/[!'()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
const sha256 = d => crypto.createHash('sha256').update(d).digest('hex');
const hmac = (k, d) => crypto.createHmac('sha256', k).update(d).digest();

async function s3(c, method, key, { query = {}, body = null, type = '' } = {}) {
  const u = new URL(c.endpoint);
  const objPath = `/${enc(c.bucket)}${key ? `/${key.split('/').map(enc).join('/')}` : ''}`;
  const qs = Object.keys(query).sort().map(k => `${enc(k)}=${enc(String(query[k]))}`).join('&');
  const now = new Date();
  const amzDate = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const day = amzDate.slice(0, 8);
  const payload = sha256(body || '');
  const headers = { host: u.host, 'x-amz-content-sha256': payload, 'x-amz-date': amzDate };
  if (type) headers['content-type'] = type;
  const names = Object.keys(headers).sort();
  const canonical = [method, objPath, qs, names.map(n => `${n}:${headers[n]}\n`).join(''), names.join(';'), payload].join('\n');
  const scope = `${day}/${c.region}/s3/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonical)].join('\n');
  const kSign = hmac(hmac(hmac(hmac(`AWS4${c.secret}`, day), c.region), 's3'), 'aws4_request');
  headers.authorization = `AWS4-HMAC-SHA256 Credential=${c.keyId}/${scope}, SignedHeaders=${names.join(';')}, Signature=${hmac(kSign, toSign).toString('hex')}`;
  delete headers.host;
  const res = await fetch(`${u.origin}${objPath}${qs ? `?${qs}` : ''}`, { method, headers, body: body || undefined, signal: AbortSignal.timeout(300e3) });
  const text = await res.text();
  if (!res.ok) {
    const code = (/<Code>([^<]+)<\/Code>/.exec(text) || [])[1] || '';
    throw new Error(`Storage answered HTTP ${res.status}${code ? ` (${code})` : ''}`);
  }
  return text;
}

async function listKeys(c) {
  const keys = [];
  let token = '';
  for (let i = 0; i < 50; i++) {
    const q = { 'list-type': 2, prefix: `${c.prefix}/` };
    if (token) q['continuation-token'] = token;
    const xml = await s3(c, 'GET', '', { query: q });
    for (const m of xml.matchAll(/<Key>([^<]+)<\/Key>/g)) keys.push(m[1].replace(/&amp;/g, '&'));
    if (!/<IsTruncated>true<\/IsTruncated>/.test(xml)) break;
    token = ((/<NextContinuationToken>([^<]+)<\/NextContinuationToken>/.exec(xml)) || [])[1] || '';
    if (!token) break;
  }
  return keys;
}

// Which copies to delete: keep everything from the last `hourlyHours`, then the newest copy
// of each UTC day for `dailyDays`.
function toDelete(keys, now, hourlyHours, dailyDays) {
  const copies = keys.map(k => { const m = NAME.exec(k); if (!m) return null; const t = Date.parse(`${m[1].slice(0, 4)}-${m[1].slice(4, 6)}-${m[1].slice(6, 8)}T${m[2].slice(0, 2)}:${m[2].slice(2, 4)}:${m[2].slice(4, 6)}Z`); return Number.isFinite(t) ? { k, t, day: m[1] } : null; }).filter(Boolean);
  const newestOfDay = {};
  for (const c of copies) if (!newestOfDay[c.day] || c.t > newestOfDay[c.day].t) newestOfDay[c.day] = c;
  return copies.filter(c => {
    if (now - c.t <= hourlyHours * 3600e3) return false;
    if (now - c.t <= dailyDays * 86400e3 && newestOfDay[c.day] === c) return false;
    return true;
  }).map(c => c.k);
}

class CloudBackup {
  constructor(cfg, dataDir, log, beforeBackup = () => {}) {
    this.c = cfg;
    this.dataDir = dataDir;
    this.log = log;
    this.beforeBackup = beforeBackup;
    this.statusFile = path.join(dataDir, 'cloud-backup.json');
    this.running = false;
    this.nextAt = Date.now() + 3 * 60e3; // first copy a few minutes after start
    try { this.st = JSON.parse(fs.readFileSync(this.statusFile, 'utf8')); } catch (e) { this.st = {}; }
    if (this.st.lastSuccess) this.nextAt = Math.max(this.nextAt, this.st.lastSuccess * 1000 + this.c.everyMinutes * 60e3);
  }

  configured() { return !!(this.c.enabled && this.c.endpoint && this.c.bucket && this.c.keyId && this.c.secret); }

  saveStatus() {
    try { fs.writeFileSync(`${this.statusFile}.tmp`, JSON.stringify(this.st)); fs.renameSync(`${this.statusFile}.tmp`, this.statusFile); } catch (e) { /* next time */ }
  }

  // A quick check at start-up, so a wrong key or bucket shows in the log straight away.
  async check() {
    if (!this.configured()) return;
    try {
      const keys = await listKeys(this.c);
      this.log(`Cloud backup: connected to bucket "${this.c.bucket}" (${keys.filter(k => NAME.test(k)).length} copies there).`);
    } catch (e) {
      this.st.lastError = `Can't reach the bucket: ${e.message}`;
      this.st.lastErrorAt = Math.floor(Date.now() / 1000);
      this.saveStatus();
      this.log('Cloud backup:', this.st.lastError);
    }
  }

  tick(now) {
    if (!this.configured() || this.running || now < this.nextAt) return;
    this.running = true;
    this.run(now).finally(() => { this.running = false; });
  }

  async run(now) {
    try {
      this.beforeBackup();
      const { gz, files, raw } = await packFolder(this.dataDir);
      const back = await gunzip(gz, { maxOutputLength: raw + 1024 });
      if (back.length !== raw) throw new Error('the archive did not unpack to the same size');
      const stamp = new Date(now).toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
      const key = `${this.c.prefix}/torn-desktop-${stamp}.tar.gz`;
      await s3(this.c, 'PUT', key, { body: gz, type: 'application/gzip' });
      let removed = 0, copies = null;
      try {
        const keys = await listKeys(this.c);
        const del = toDelete(keys, now, this.c.hourlyHours, this.c.dailyDays);
        for (const k of del) { await s3(this.c, 'DELETE', k); removed++; }
        copies = keys.filter(k => NAME.test(k)).length - removed;
      } catch (e) { this.log('Cloud backup: uploaded, but pruning old copies failed:', e.message); }
      this.st = { lastSuccess: Math.floor(Date.now() / 1000), lastSize: gz.length, lastKey: key, files, copies, lastError: '', lastErrorAt: 0 };
      this.saveStatus();
      this.log(`Cloud backup: uploaded ${key} (${(gz.length / 1048576).toFixed(1)} MB, ${files} files)${removed ? `, removed ${removed} old` : ''}.`);
      this.nextAt = now + this.c.everyMinutes * 60e3;
    } catch (e) {
      this.st.lastError = e.message;
      this.st.lastErrorAt = Math.floor(Date.now() / 1000);
      this.saveStatus();
      this.log('Cloud backup failed:', e.message, '- trying again in 15 minutes.');
      this.nextAt = now + 15 * 60e3;
    }
  }

  status() {
    if (!this.c.enabled) return { enabled: false };
    return { enabled: true, configured: this.configured(), bucket: this.c.bucket || '', ...this.st, nextAt: this.configured() ? this.nextAt : 0 };
  }
}

module.exports = { CloudBackup, packFolder, toDelete, s3 };
