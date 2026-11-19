// Syntax-checks every .js file under src/ and server/.
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const files = [];
function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith('.js')) files.push(p);
  }
}
walk(path.join(__dirname, '..', 'src'));
if (fs.existsSync(path.join(__dirname, '..', 'server'))) walk(path.join(__dirname, '..', 'server'));
if (fs.existsSync(path.join(__dirname, '..', 'web'))) walk(path.join(__dirname, '..', 'web'));

let failed = 0;
for (const f of files) {
  try {
    execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' });
  } catch (e) {
    failed++;
    console.error(String(e.stderr || e.message));
  }
}
console.log(`${files.length - failed}/${files.length} files OK`);

// A page's plain scripts share one top level: a name declared twice (const/let/class/function)
// stops the second script from loading at all, which a per-file check can't see.
const UI = path.join(__dirname, '..', 'src', 'ui');
for (const page of fs.readdirSync(UI).filter(n => n.endsWith('.html'))) {
  const html = fs.readFileSync(path.join(UI, page), 'utf8');
  const scripts = [...html.matchAll(/<script src="([^"]+\.js)"><\/script>/g)].map(m => m[1]);
  const seen = new Map();
  for (const s of scripts) {
    const p = path.join(UI, s);
    if (!fs.existsSync(p)) { failed++; console.error(`${page}: missing script ${s}`); continue; }
    for (const m of fs.readFileSync(p, 'utf8').matchAll(/^(?:const|let|class|function\*?|async function)\s+([A-Za-z_$][\w$]*)/gm)) {
      if (seen.has(m[1]) && seen.get(m[1]) !== s) { failed++; console.error(`${page}: "${m[1]}" is declared in both ${seen.get(m[1])} and ${s}`); }
      else seen.set(m[1], s);
    }
  }
}
if (failed) console.error('Checks failed.');
process.exit(failed ? 1 : 0);
