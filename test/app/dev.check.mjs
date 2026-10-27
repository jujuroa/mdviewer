// Add-on development (F5, protocol 16): reloading a --addon-dev add-on when
// its files change (and on command), DevTools for its pages, API tracing.
import path from 'node:path';
import { writeFileSync, readFileSync } from 'node:fs';
import { launch, checker, connect, sleep, openWindowWith, openAddonTab, targets, waitFor } from './harness.mjs';

const { check, done } = checker();
const manifest = (title) =>
  JSON.stringify({
    manifestVersion: 1,
    id: 'dev',
    name: 'Dev',
    version: '0.0.1',
    engines: { mdviewer: '>=2.0.0 <3.0.0', api: 1 },
    background: { entry: 'bg.html', idleTimeoutSec: 60 },
    contributes: { tabs: [{ id: 'dev.view', title, entry: 'view.html' }] },
  });
const viewJs = (version) => `window.version = ${version};
window.n = 0;
if (window.mdviewerAddon) {
  window.restore = window.mdviewerAddon.tabs.getRestoreState();
  window.mdviewerAddon.lifecycle.onSnapshot(() => ({ n: window.n }));
  window.mdviewerAddon.ready();
}
`;
const app = await launch({
  files: {
    'proj/a.md': '# A\n',
    'dev/manifest.json': manifest('View'),
    'dev/view.html': '<!DOCTYPE html><html><body>view<script src="view.js"></script></body></html>',
    'dev/view.js': viewJs(1),
    'dev/bg.html': '<!DOCTYPE html><html><body><script src="bg.js"></script></body></html>',
    'dev/bg.js': 'window.startedAt = Date.now(); if (window.mdviewerAddon) window.mdviewerAddon.ready();\n',
  },
  addonDev: ['{tmp}/dev'],
  settings: { language: 'ko', 'addons.trace': 'verbose' },
});
const dev = path.join(app.tmp, 'dev');
const viewTarget = (id) => (t) => t.url === `mdviewer-addon://dev/view.html?tab=${id}`;
const bgPage = async () => (await targets(app.port)).find((t) => t.type === 'page' && t.url.startsWith('mdviewer-addon://dev/bg.html')) || null;
try {
  const w = await openWindowWith(app, 'a.md');
  const menu = await app.extensionLabels();
  check('Extensions has the reload command and API trace', menu.includes('개발: add-on 다시 불러오기') && menu.includes('API 추적'), menu.join('|'));
  const palette = await w.evaluate(`return (await window.mdviewer.paletteItems()).map((i) => i.label)`).catch((e) => String(e));
  check('  so does the command palette', Array.isArray(palette) && palette.includes('개발: add-on 다시 불러오기'), JSON.stringify(palette));

  const tab = await openAddonTab(app, w, 'Dev: View');
  let v = await connect(app.port, viewTarget(tab.id), { type: 'iframe', quiet: true });
  await waitFor(() => v.evaluate(`return window.version === 1`));
  await waitFor(bgPage, { timeout: 8000 });
  let bg = await connect(app.port, (t) => t.url.startsWith('mdviewer-addon://dev/bg.html'), { quiet: true });
  const bgStarted = await waitFor(() => bg.evaluate(`return window.startedAt || null`));

  // A file changes: the add-on reloads.
  await v.evaluate(`window.n = 42; return 1`);
  const oldTarget = v.target.id;
  writeFileSync(path.join(dev, 'view.js'), viewJs(2));
  const fresh = await waitFor(async () => (await targets(app.port)).find((t) => viewTarget(tab.id)(t) && t.id !== oldTarget) || null, { timeout: 8000 }).catch(() => null);
  check('a changed file reloads its tab\'s page', !!fresh);
  v = await connect(app.port, (t) => viewTarget(tab.id)(t) && t.id !== oldTarget, { type: 'iframe', quiet: true });
  await waitFor(() => v.evaluate(`return typeof window.version === 'number'`));
  check('  with the new file', (await v.evaluate(`return window.version`)) === 2);
  const restore = await v.evaluate(`return window.restore`);
  check('  handing over its snapshot (reason "reloaded")', restore && restore.reason === 'reloaded' && restore.state && restore.state.n === 42, JSON.stringify(restore));
  const restarted = await waitFor(async () => {
    const t = await bgPage();
    if (!t) return null;
    const c = await connect(app.port, (x) => x.id === t.id, { quiet: true }).catch(() => null);
    const at = c && (await c.evaluate(`return window.startedAt || null`).catch(() => null));
    return at && at !== bgStarted ? at : null;
  }, { timeout: 10000 }).catch(() => null);
  check('  its background frame restarted', !!restarted);
  check('  logged', /reloading \(files changed\)/.test(app.logText()));

  // The manifest changes: read again.
  writeFileSync(path.join(dev, 'manifest.json'), manifest('Renamed'));
  const renamed = await waitFor(() => w.evaluate(`return [...document.querySelectorAll('.doc-tab-label')].some((n) => n.textContent === 'Renamed')`), { timeout: 8000 }).catch(() => false);
  check('a changed manifest is read again (tab title)', renamed);

  // The command reloads too.
  await sleep(1000);
  const before = (await targets(app.port)).find(viewTarget(tab.id)).id;
  await app.clickMenu('확장', '개발: add-on 다시 불러오기');
  const again = await waitFor(async () => (await targets(app.port)).find((t) => viewTarget(tab.id)(t) && t.id !== before) || null, { timeout: 8000 }).catch(() => null);
  check('the reload command reloads it', !!again);

  // DevTools for a tab page (tab context menu) and the background frame.
  await app.main(`global.__popups = []; electron.Menu.prototype.popup = function () { global.__popups.push(this); }; return 1`);
  await w.evaluate(`window.mdviewer.showTabContextMenu(${tab.id}); return 1`);
  await sleep(300);
  const items = await app.main(`const m = global.__popups[global.__popups.length - 1]; return m ? m.items.map((i) => i.label) : []`);
  check('tab context menu: Developer Tools for an add-on tab', items.includes('개발자 도구'), items.join('|'));
  await app.main(`const m = global.__popups[global.__popups.length - 1]; m.items.find((i) => i.label === '개발자 도구').click(); return 1`);
  const opened = await waitFor(() => app.main(`return electron.BrowserWindow.getAllWindows().some((x) => x.isVisible() && x.webContents.isDevToolsOpened())`), { timeout: 5000 }).catch(() => false);
  check('  opens the window\'s DevTools', opened);
  await app.main(`for (const x of electron.BrowserWindow.getAllWindows()) x.webContents.closeDevTools(); return 1`);
  const bgDev = await w.evaluate(`return await window.mdviewer.openBackgroundDevTools('dev')`);
  const bgOpened = await waitFor(() => app.main(`return electron.BrowserWindow.getAllWindows().some((x) => !x.isVisible() && x.webContents.isDevToolsOpened())`), { timeout: 5000 }).catch(() => false);
  check('the background frame\'s DevTools (Extensions screen button)', bgDev.ok && bgOpened);
  await app.main(`for (const x of electron.BrowserWindow.getAllWindows()) x.webContents.closeDevTools(); return 1`);

  // addons.trace: verbose — calls with their arguments, document text hidden.
  v = await connect(app.port, (t) => viewTarget(tab.id)(t) && t.id === again.id, { type: 'iframe', quiet: true });
  await waitFor(() => v.evaluate(`return typeof window.version === 'number'`));
  await v.evaluate(`await window.mdviewerAddon.storage.writeFile({ scope: 'global', path: 'x.txt', data: 'hello' }); return 1`);
  await sleep(500);
  const log = readFileSync(path.join(app.tmp, 'logs', 'dev.log'), 'utf8');
  check('trace: each call with time and arguments', /call storage\/writeFile \d+ ms ok params=\{"scope":"global","path":"x.txt","data":"hello"\}/.test(log), log.slice(-600));
} finally {
  await app.stop();
  done();
}
