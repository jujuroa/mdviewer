// Registering an add-on by its manifest.json (Extensions > Register
// Add-on...): the folder is kept in addons-state.json, looked at like an
// --addon-dev one (experimental APIs open, reloaded on change), and can be
// unregistered. The file dialog itself is not driven; the same IPC is
// given the file.
import path from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';
import { launch, checker, openWindowWith, waitFor, sleep } from './harness.mjs';

const manifest = {
  manifestVersion: 1,
  id: 'regd',
  name: 'Registered',
  version: '0.0.1',
  engines: { mdviewer: '>=2.0.0 <3.0.0', api: 1 },
  experimentalApi: ['settings.open'],
  background: { entry: 'background.html' },
  contributes: { commands: [{ id: 'regd.hello', title: 'Hello' }], menus: { 'menubar/addons': [{ command: 'regd.hello' }] } },
};
const { check, done } = checker();
const app = await launch({
  files: {
    'proj/a.md': '# A\n',
    'work/regd/manifest.json': JSON.stringify(manifest),
    'work/regd/background.html': '<!doctype html><script src="background.js"></script>',
    'work/regd/background.js': 'window.mdviewerAddon.ready();\n',
    'work/regd/notes.txt': 'not a manifest',
  },
  addonDev: [],
});
try {
  const w = await openWindowWith(app, 'a.md');
  const file = path.join(app.tmp, 'work', 'regd', 'manifest.json');
  const labels = () => app.main(`return electron.Menu.getApplicationMenu().items.find((i) => i.label === '확장').submenu.items.filter((i) => i.visible).map((i) => i.label)`);
  check('not there before', !(await labels()).includes('Registered: Hello'));

  await app.clickMenu('확장', '확장 관리...');
  await waitFor(() => w.evaluate(`return !document.getElementById('addons-overlay').classList.contains('hidden')`));
  check('the Extensions screen has the Register button', (await w.evaluate(`return document.getElementById('btn-addons-register').textContent`)) === 'add-on 등록...');

  const result = await w.evaluate(`return await window.mdviewer.registerAddon(${JSON.stringify(file)})`);
  const regd = result.list.find((a) => a.id === 'regd');
  check('registering its manifest.json: found, ok, source registered', result.id === 'regd' && regd && regd.status === 'ok' && regd.source === 'registered', JSON.stringify(regd && { status: regd.status, source: regd.source, problems: regd.problems }));
  const state = JSON.parse(readFileSync(path.join(app.tmp, 'userData', 'addons-state.json'), 'utf8'));
  check('  kept in addons-state.json', (state.registered || []).length === 1 && state.registered[0].toLowerCase() === path.dirname(file).toLowerCase(), JSON.stringify(state.registered));
  await sleep(500);
  check('  its command is in the menu', (await labels()).includes('Registered: Hello'), (await labels()).join('|'));
  check('  "reload add-ons" is offered', (await labels()).includes('개발: add-on 다시 불러오기'));

  const again = await w.evaluate(`return await window.mdviewer.registerAddon(${JSON.stringify(file)})`);
  check('the same folder again: alreadyRegistered', again.error === 'alreadyRegistered');
  const wrong = await w.evaluate(`return await window.mdviewer.registerAddon(${JSON.stringify(path.join(app.tmp, 'work', 'regd', 'notes.txt'))})`);
  check('a file that is not manifest.json: notManifest', wrong.error === 'notManifest');

  // Shown with an Unregister button; the screen draws the list it is given.
  await w.evaluate(`document.getElementById('btn-addons-rescan').click(); return 1`);
  await sleep(400);
  check('the item has Unregister', (await w.evaluate(`const b = document.querySelector('.addon-item[data-addon-id="regd"] .addon-unregister-button'); return b ? b.textContent : null`)) === '등록 해제');

  // Its files change: reloaded as an --addon-dev one would be.
  writeFileSync(path.join(app.tmp, 'work', 'regd', 'manifest.json'), JSON.stringify({ ...manifest, name: 'Registered 2' }));
  await waitFor(async () => (await labels()).includes('Registered 2: Hello'), { timeout: 5000 }).catch(() => {});
  check('a change in its folder reloads it', (await labels()).includes('Registered 2: Hello'), (await labels()).join('|'));

  // Survives a restart of the registry (look again).
  const relisted = await w.evaluate(`return await window.mdviewer.rescanAddons()`);
  check('still there after looking again', relisted.some((a) => a.id === 'regd' && a.source === 'registered'));

  await w.evaluate(`document.querySelector('.addon-item[data-addon-id="regd"] .addon-unregister-button').click(); return 1`);
  await sleep(600);
  check('Unregister: gone from the screen and the menu', !(await w.evaluate(`return !!document.querySelector('.addon-item[data-addon-id="regd"]')`)) && !(await labels()).some((l) => l.startsWith('Registered')));
  check('  and from addons-state.json', (JSON.parse(readFileSync(path.join(app.tmp, 'userData', 'addons-state.json'), 'utf8')).registered || []).length === 0);
} finally {
  await app.stop();
  done();
}
