// Run from source as "Mentat", not "Electron": makes node_modules/electron/dist/Mentat.exe, a copy of
// electron.exe with Mentat's name and icon stamped in (rcedit, which electron-winstaller ships), so
// Task Manager, the taskbar and Windows' notification settings show Mentat. Remade when Electron
// or the icon changes. If anything fails, the plain electron.exe is used instead.
// Run directly, it prints the path of the program to start.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'node_modules', 'electron', 'dist');
const ELECTRON = path.join(DIST, 'electron.exe');
const EXE = path.join(DIST, 'Mentat.exe');
const STAMP = path.join(DIST, 'Mentat.exe.stamp');
const ICON = path.join(ROOT, 'src', 'assets', 'mentat.ico');
const RCEDIT = path.join(ROOT, 'node_modules', 'electron-winstaller', 'vendor', 'rcedit.exe');

function devExe() {
  if (process.platform !== 'win32' || !fs.existsSync(ELECTRON)) return ELECTRON;
  try {
    const version = require(path.join(ROOT, 'node_modules', 'electron', 'package.json')).version;
    const want = `${version}|${fs.statSync(ELECTRON).size}|${fs.statSync(ICON).mtimeMs}`;
    const have = fs.existsSync(STAMP) ? fs.readFileSync(STAMP, 'utf8') : '';
    if (fs.existsSync(EXE) && have === want) return EXE;
    if (!fs.existsSync(RCEDIT)) return ELECTRON;
    const tmp = path.join(DIST, `Mentat.${process.pid}.tmp.exe`);
    fs.copyFileSync(ELECTRON, tmp);
    try {
      execFileSync(RCEDIT, [tmp,
        '--set-version-string', 'FileDescription', 'Mentat',
        '--set-version-string', 'ProductName', 'Mentat',
        '--set-version-string', 'InternalName', 'Mentat',
        '--set-version-string', 'OriginalFilename', 'Mentat.exe',
        '--set-version-string', 'CompanyName', 'Mentat',
        '--set-icon', ICON,
      ], { stdio: 'ignore', windowsHide: true });
      fs.renameSync(tmp, EXE); // fails while an older Mentat.exe is running: keep using that one
      fs.writeFileSync(STAMP, want);
    } finally {
      fs.rmSync(tmp, { force: true });
    }
    return EXE;
  } catch (e) {
    return fs.existsSync(EXE) ? EXE : ELECTRON;
  }
}

module.exports = { devExe };
if (require.main === module) process.stdout.write(devExe());
