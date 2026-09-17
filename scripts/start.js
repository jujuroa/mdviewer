// Some terminals (VS Code's integrated terminal, other Electron-based tools) leak
// ELECTRON_RUN_AS_NODE=1 into the environment, which makes electron.exe run as a
// plain Node process instead of launching the app. Strip it before spawning.
delete process.env.ELECTRON_RUN_AS_NODE;

const { spawn } = require('child_process');
const electronPath = require('electron');

// Extra args after `npm start --` are forwarded to the app, so
// `npm start -- D:\docs` opens that folder the same way the packaged
// `mdviewer <path>` does. Relative paths resolve against the package
// root, since that is where npm runs scripts from.
const forwarded = process.argv.slice(2);

const child = spawn(electronPath, ['.', ...forwarded], {
  stdio: 'inherit',
  env: process.env,
});

child.on('close', (code) => process.exit(code ?? 0));
