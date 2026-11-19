// Builds web/app/mentat-core.js: Mentat's core (src/main/core.js and what it needs) for web browsers,
// as one script with the browser stand-ins from web/app/shims.js. The web app (and phone app) then
// runs the same code as the Windows app. Run by pack-server.js; or alone: node scripts/pack-web.js
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const MAIN = path.join(ROOT, 'src', 'main');
const MODULES = [
  'core.js', 'schema.js', 'store.js', 'api.js', 'history.js', 'restock.js', 'syncmerge.js', 'sync.js', 'pages.js',
  ...fs.readdirSync(path.join(MAIN, 'features')).filter(f => f.endsWith('.js')).map(f => `features/${f}`),
];
const BUILTINS = ['fs', 'path', 'events', 'electron', 'zlib', 'util'];

function build() {
  const version = require(path.join(ROOT, 'package.json')).version;
  const defs = MODULES.map(m => {
    const src = fs.readFileSync(path.join(MAIN, m), 'utf8').replace(/\r\n/g, '\n');
    // Every require must be a stand-in or another bundled module.
    for (const [, name] of src.matchAll(/require\('([^']+)'\)/g)) {
      if (BUILTINS.includes(name)) continue;
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(m), `${name}.js`));
      if (!MODULES.includes(target)) throw new Error(`${m} needs ${name}, which isn't bundled`);
    }
    return `  ${JSON.stringify(m)}: function (module, exports, require) {\n${src}\n  },`;
  }).join('\n');
  const shims = fs.readFileSync(path.join(ROOT, 'web', 'app', 'shims.js'), 'utf8').replace(/\r\n/g, '\n');
  const out = `// Mentat ${version}: the core for web browsers. Built by scripts/pack-web.js from src/main; don't edit.
(function () {
'use strict';
${shims}
const Buffer = SHIMS.Buffer;
const BUILTIN = { fs: SHIMS.fs, path: SHIMS.path, events: SHIMS.events, electron: SHIMS.electron, zlib: SHIMS.zlib, util: SHIMS.util };
const DEFS = {
${defs}
};
const CACHE = {};
function load(id) {
  if (CACHE[id]) return CACHE[id].exports;
  const module = { exports: {} };
  CACHE[id] = module;
  const dir = id.includes('/') ? id.slice(0, id.lastIndexOf('/')) : '';
  const req = name => {
    if (BUILTIN[name]) return BUILTIN[name];
    const parts = (dir ? dir.split('/') : []).concat(name.split('/'));
    const out = [];
    for (const p of parts) { if (p === '.' || !p) continue; if (p === '..') out.pop(); else out.push(p); }
    return load(out.join('/') + '.js');
  };
  DEFS[id].call(module.exports, module, module.exports, req);
  return module.exports;
}
window.Mentat = { version: ${JSON.stringify(version)}, load: SHIMS.load, persistNow: SHIMS.persistNow, require: load, Buffer };
})();
`;
  fs.writeFileSync(path.join(ROOT, 'web', 'app', 'mentat-core.js'), out);
  return { version, modules: MODULES.length, bytes: out.length };
}

module.exports = { build };
if (require.main === module) {
  const r = build();
  console.log(`Built web/app/mentat-core.js: Mentat ${r.version}, ${r.modules} modules, ${(r.bytes / 1024).toFixed(0)} KB.`);
}
