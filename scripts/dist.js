// Builds the Windows app (npm run dist) or an unpacked copy (npm run pack, --dir).
// Your Mentat server's address comes from mentat.local.json (not in git; copy
// mentat.local.example.json). When it is set, the build signs in to that server by default and
// looks for updates at <server>/downloads/. Without it the build has no default server (people
// enter one on the sign-in screen) and no automatic updates.
'use strict';
const fs = require('fs');
const path = require('path');
const { build } = require('electron-builder');

const ROOT = path.join(__dirname, '..');
const pkg = require(path.join(ROOT, 'package.json'));

let server = '';
try { server = String(JSON.parse(fs.readFileSync(path.join(ROOT, 'mentat.local.json'), 'utf8')).server || '').trim().replace(/\/+$/, ''); } catch (e) { /* none */ }

const config = { ...pkg.build, extraMetadata: { mentat: { ...(pkg.mentat || {}), server } } };
if (server) config.publish = [{ provider: 'generic', url: `${server}/downloads/`, useMultipleRangeRequest: false }];

const dir = process.argv.includes('--dir');
console.log(server ? `Mentat server: ${server}` : 'No mentat.local.json: building without a default server or updates.');
build({ projectDir: ROOT, config, ...(dir ? { dir: true } : { win: ['nsis', 'portable'] }) })
  .then(files => { for (const f of files) console.log(f); })
  .catch(e => { console.error(e); process.exit(1); });
