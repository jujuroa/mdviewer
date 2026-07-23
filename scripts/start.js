// Some terminals (VS Code's integrated terminal, other Electron-based tools) leak
// ELECTRON_RUN_AS_NODE=1 into the environment, which makes electron.exe run as a
// plain Node process instead of launching the app. Strip it before spawning.
delete process.env.ELECTRON_RUN_AS_NODE;

const { spawn } = require('child_process');
const electronPath = require('electron');

const child = spawn(electronPath, ['.'], {
  stdio: 'inherit',
  env: process.env,
});

child.on('close', (code) => process.exit(code ?? 0));
