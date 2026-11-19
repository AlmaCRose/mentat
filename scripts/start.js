// Starts the app in development. Clears ELECTRON_RUN_AS_NODE, which some editors
// (e.g. VS Code extensions) set and which would make Electron run as plain Node.
// Runs as Mentat.exe (Electron with Mentat's name and icon; see brand-dev.js).
const { spawn } = require('child_process');
const path = require('path');
const { devExe } = require('./brand-dev');

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(devExe(), [path.join(__dirname, '..')], { stdio: 'inherit', env });
child.on('exit', code => process.exit(code ?? 0));
