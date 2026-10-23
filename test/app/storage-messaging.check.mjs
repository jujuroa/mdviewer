// storage/* and messaging/* (F4, protocol 13.13·13.14), with the bg test
// add-on: its view tab and its background frame.
import path from 'node:path';
import { readFileSync, existsSync } from 'node:fs';
import { launch, checker, connect, sleep, openWindowWith, openAddonTab, targets, waitFor } from './harness.mjs';

const { check, done } = checker();
const app = await launch({ files: { 'proj/a.md': '# A\n' }, addonDev: ['test/addons/bg'] });
const proj = path.join(app.tmp, 'proj');
const data = path.join(app.tmp, 'addon-data', 'bg');
const api = (page, expr) => page.evaluate(`try { const v = await window.mdviewerAddon.${expr}; return v === undefined ? 'undefined' : v instanceof Uint8Array ? { bytes: [...v] } : v; } catch (e) { return 'ERR ' + e.name; }`);
try {
  const w = await openWindowWith(app, 'a.md');
  const tab = await openAddonTab(app, w, 'Background: View');
  const view = await connect(app.port, (t) => t.url === `mdviewer-addon://bg/view.html?tab=${tab.id}`, { type: 'iframe', quiet: true });
  await waitFor(() => view.evaluate(`return !!window.viewReady`));
  await waitFor(async () => (await targets(app.port)).some((t) => t.type === 'page' && t.url.startsWith('mdviewer-addon://bg/background.html')), { timeout: 8000 });
  const bg = await connect(app.port, (t) => t.url.startsWith('mdviewer-addon://bg/background.html'), { quiet: true });
  await waitFor(() => bg.evaluate(`return Array.isArray(window.received)`));

  // storage
  check('the areas are listed', await view.evaluate(`return typeof window.mdviewerAddon.storage.writeFile === 'function' && typeof window.mdviewerAddon.messaging.onMessage === 'function'`));
  await api(view, `storage.writeFile({ scope: 'global', path: 'index/words.json', data: '["a","b"]' })`);
  check('writeFile: in addon-data/<id>/global', readFileSync(path.join(data, 'global', 'index', 'words.json'), 'utf8') === '["a","b"]');
  check('readFile: text back', (await api(view, `storage.readFile({ scope: 'global', path: 'index/words.json' })`)) === '["a","b"]');
  check('  the background frame sees the same files', (await api(bg, `storage.readFile({ scope: 'global', path: 'index/words.json' })`)) === '["a","b"]');
  await api(view, `storage.writeFile({ scope: 'global', path: 'raw.bin', data: new Uint8Array([1, 2, 250]) })`);
  check('binary in and out', JSON.stringify(await api(view, `storage.readFile({ scope: 'global', path: 'raw.bin', encoding: 'binary' })`)) === '{"bytes":[1,2,250]}');
  const list = await api(view, `storage.list({ scope: 'global' })`);
  check('list', Array.isArray(list) && list.map((e) => `${e.kind}:${e.name}`).sort().join(',') === 'dir:index,file:raw.bin', JSON.stringify(list));
  check('a path leading out: InvalidParams', (await api(view, `storage.readFile({ scope: 'global', path: '../other/x' })`)) === 'ERR InvalidParams');
  await api(view, `storage.writeFile({ scope: 'project', root: ${JSON.stringify(proj)}, path: 'cache.txt', data: 'p' })`);
  const paths = await api(view, `storage.paths({ root: ${JSON.stringify(proj)} })`);
  check('project scope: its own folder (storage.paths)', paths && paths.global === path.join(data, 'global') && existsSync(path.join(paths.project, 'cache.txt')) && path.dirname(paths.project) === path.join(data, 'projects'), JSON.stringify(paths));
  check('  a folder that is not an open project: OutsideProject', (await api(view, `storage.list({ scope: 'project', root: ${JSON.stringify(path.join(app.tmp, 'nope'))} })`)) === 'ERR OutsideProject');
  await api(view, `storage.delete({ scope: 'global', path: 'index' })`);
  check('delete', !existsSync(path.join(data, 'global', 'index')));

  // messaging
  check('request to the background: its handler\'s answer', (await api(view, `messaging.request({ to: 'background', message: { op: 'add', a: 2, b: 3 } })`)) === 5);
  const got = await bg.evaluate(`return window.received[window.received.length - 1]`);
  check('  it knows who asked', got.from.kind === 'tab' && got.from.tabId === 'bg.view' && got.from.instanceId === tab.id, JSON.stringify(got));
  check('  a handler that throws: InternalError', (await api(view, `messaging.request({ to: 'background', message: { op: 'fail' } })`)) === 'ERR InternalError');
  await api(view, `messaging.post({ to: 'background', message: { note: 'hi' } })`);
  await sleep(300);
  check('post to the background', (await bg.evaluate(`return window.received.some((r) => r.message && r.message.note === 'hi')`)) === true);
  await api(bg, `messaging.post({ to: 'tabs', message: { from: 'bg' } })`);
  await sleep(300);
  const inView = await view.evaluate(`return window.received`);
  check('post from the background to the tabs', inView.some((r) => r.message.from === 'bg' && r.from.kind === 'background'), JSON.stringify(inView));
  await api(view, `messaging.post({ to: 'all', message: { all: 1 } })`);
  await sleep(300);
  check('  "all" leaves the sender out', (await view.evaluate(`return window.received.some((r) => r.message.all)`)) === false && (await bg.evaluate(`return window.received.some((r) => r.message && r.message.all)`)) === true);
  check('request to anywhere else: InvalidParams', (await api(view, `messaging.request({ to: 'tabs', message: 1 })`)) === 'ERR InvalidParams');
} finally {
  await app.stop();
  done();
}
