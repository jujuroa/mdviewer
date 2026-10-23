// Consent before an add-on first runs (F2, protocol 10.3).
import path from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';
import { launch, checker, sleep, openWindowWith, waitFor, targets } from './harness.mjs';

const { check, done } = checker();
const manifest = (id, over = {}) =>
  JSON.stringify({ manifestVersion: 1, id, name: id === 'needy' ? 'Needy' : 'Starter', version: '1.0.0', publisher: 'tester', engines: { mdviewer: '>=2.0.0 <3.0.0', api: 1 }, ...over });
const needy = (hosts) =>
  manifest('needy', {
    permissions: ['documents.read'],
    network: { hosts },
    executables: [{ id: 'tool', path: 'bin/tool.exe' }],
    contributes: { tabs: [{ id: 'needy.main', title: 'Main', entry: 'main.html' }] },
  });
const app = await launch({
  files: {
    'proj/a.md': '# A\n',
    'addons/needy/manifest.json': needy(['api.example.com']),
    'addons/needy/main.html': '<!doctype html><p>needy</p>',
    'addons/starter/manifest.json': manifest('starter', { background: { entry: 'bg.html', idleTimeoutSec: 0 }, activation: ['onStartup'] }),
    'addons/starter/bg.html': '<!doctype html><script src="bg.js"></script>',
    'addons/starter/bg.js': 'window.mdviewerAddon && window.mdviewerAddon.ready();',
  },
  addonDev: ['test/addons/test'],
});
const stateFile = path.join(app.tmp, 'userData', 'addons-state.json');
const consents = () => {
  try {
    return JSON.parse(readFileSync(stateFile, 'utf8')).consents || {};
  } catch {
    return {};
  }
};
try {
  const w = await openWindowWith(app, 'a.md');
  const modal = () =>
    w.evaluate(`const o = document.getElementById('addon-consent-overlay'); return o.classList.contains('hidden') ? null : { id: o.dataset.addonId, text: document.getElementById('addon-consent-body').textContent }`);
  const tabs = () => w.evaluate(`return [...document.querySelectorAll('.doc-tab')].map((n) => n.title)`);

  // onStartup: asked first, runs once allowed.
  const first = await waitFor(modal, { timeout: 8000 }).catch(() => null);
  check('an add-on starting at startup asks first', first && first.id === 'starter', JSON.stringify(first));
  check('  not started before the answer', !(await targets(app.port)).some((t) => t.url.startsWith('mdviewer-addon://starter/')));
  await w.evaluate(`document.getElementById('btn-consent-allow').click(); return 1`);
  const started = await waitFor(async () => (await targets(app.port)).some((t) => t.url.startsWith('mdviewer-addon://starter/bg.html')), { timeout: 8000 }).catch(() => false);
  check('  allowed: its background frame starts', started);
  check('  the consent is kept', consents().starter && consents().starter.version === '1.0.0');

  // A tab: denied, nothing opens.
  app.clickMenu('확장', 'Needy: Main');
  const asked = await waitFor(modal, { timeout: 5000 }).catch(() => null);
  check('opening an add-on tab the first time asks', asked && asked.id === 'needy');
  check('  shows publisher, permissions, hosts, programs and the warning',
    asked && ['tester', '열린 프로젝트의 문서 읽기', 'api.example.com', 'bin/tool.exe', '제한 없이 접근'].every((s) => asked.text.includes(s)), asked && asked.text);
  if (process.env.SHOT) writeFileSync(process.env.SHOT, Buffer.from((await w.send('Page.captureScreenshot', { format: 'png' })).result.data, 'base64'));
  await w.evaluate(`document.getElementById('btn-consent-deny').click(); return 1`);
  await sleep(800);
  check('denied: no tab, nothing kept', !(await tabs()).some((t) => t.startsWith('Needy')) && !consents().needy);

  // Allowed: the tab opens; the next time no question.
  app.clickMenu('확장', 'Needy: Main');
  await waitFor(modal, { timeout: 5000 });
  await w.evaluate(`document.getElementById('btn-consent-allow').click(); return 1`);
  await sleep(1500);
  check('allowed: the tab opens', (await tabs()).includes('Needy: Main'));
  check('  kept with what was agreed', JSON.stringify(consents().needy && consents().needy.hosts) === '["api.example.com"]');
  await w.evaluate(`const n = [...document.querySelectorAll('.doc-tab')].find((x) => x.title === 'Needy: Main'); await window.mdviewer.closeTab(+n.dataset.tabId); return 1`);
  app.clickMenu('확장', 'Needy: Main');
  await sleep(1500);
  check('opening it again: no question', !(await modal()) && (await tabs()).includes('Needy: Main'));

  // An update connecting to one more host asks again.
  await w.evaluate(`const n = [...document.querySelectorAll('.doc-tab')].find((x) => x.title === 'Needy: Main'); await window.mdviewer.closeTab(+n.dataset.tabId); return 1`);
  writeFileSync(path.join(app.tmp, 'addons', 'needy', 'manifest.json'), needy(['api.example.com', 'more.example.com']));
  await app.clickMenu('확장', 'add-on 다시 찾기');
  await sleep(500);
  app.clickMenu('확장', 'Needy: Main');
  const again = await waitFor(modal, { timeout: 5000 }).catch(() => null);
  check('an update asking for more asks again', again && again.text.includes('more.example.com'));
  await w.evaluate(`document.getElementById('btn-consent-allow').click(); return 1`);
  await sleep(1000);

  // A --addon-dev add-on is the developer's own: not asked.
  app.clickMenu('확장', 'Test: Probe');
  await sleep(1500);
  check('a --addon-dev add-on opens without asking', !(await modal()) && (await tabs()).includes('Test: Probe'));
} finally {
  await app.stop();
  done();
}
