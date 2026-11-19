// Builds dist/torn-desktop-server/: the sync server plus the app modules it reuses.
// Copy that folder to the server (it needs only Node.js 20+).
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'dist', 'torn-desktop-server');
const FILES = [
  'server/server.js', 'server/cloudbackup.js', 'server/members.js', 'server/push.js', 'server/odds.js', 'server/README.md', 'server/torn-desktop-server.service',
  'src/main/store.js', 'src/main/api.js', 'src/main/history.js', 'src/main/restock.js', 'src/main/syncmerge.js',
  'src/main/features/war.js', 'src/main/features/research.js', 'src/main/features/travel.js',
  'src/main/features/market.js', 'src/main/features/bazaar.js', 'src/main/features/scout.js',
  'src/main/activity.js', 'src/main/warchive.js',
];

// The web folder (guides, the Torn PDA script, the web app) and the logo the pages use.
const walk = d => fs.readdirSync(path.join(ROOT, d), { withFileTypes: true }).flatMap(e => (e.isDirectory() ? walk(`${d}/${e.name}`) : [`${d}/${e.name}`]));
// The web app: build its core bundle first, then ship web/ and the shared tools page (src/ui).
require('./pack-web').build();
if (fs.existsSync(path.join(ROOT, 'web'))) FILES.push(...walk('web'));
FILES.push(...walk('src/ui'));
FILES.push(...walk('src/assets'));

fs.rmSync(OUT, { recursive: true, force: true });
for (const f of FILES) {
  const to = path.join(OUT, f);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  // LF line endings for text: these run on Linux. Images are copied as they are.
  if (/\.(png|ico)$/.test(f)) fs.copyFileSync(path.join(ROOT, f), to);
  else fs.writeFileSync(to, fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/\r\n/g, '\n'));
}
const pkg = require(path.join(ROOT, 'package.json'));
fs.writeFileSync(path.join(OUT, 'package.json'), `${JSON.stringify({ name: 'torn-desktop-server', version: pkg.version, private: true, description: 'Mentat sync server', main: 'server/server.js', engines: { node: '>=20' } }, null, 2)}\n`);
console.log(`Built ${OUT} (${FILES.length + 1} files).`);
