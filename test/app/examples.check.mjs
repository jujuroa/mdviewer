// The example add-ons (F5, examples/addons): hello (a background command),
// hello-tab (a tab that keeps its state), ai-edit (selection in, change out
// through the comparison screen).
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { launch, checker, connect, sleep, openWindowWith, openAddonTab, waitFor } from './harness.mjs';

const { check, done } = checker();
const MESSY = '#Title\n* item   \n\n\n\nend\n';
const app = await launch({
  files: { 'proj/a.md': MESSY },
  addonDev: ['examples/addons/hello', 'examples/addons/hello-tab', 'examples/addons/ai-edit'],
});
const run = (w, id) => w.evaluate(`window.__run = window.mdviewer.runPaletteItem({ kind: 'command', id: '${id}' }); return 1`);
try {
  const w = await openWindowWith(app, 'a.md');
  const list = await w.evaluate(`return (await window.mdviewer.listAddons()).map((a) => a.id + ':' + a.status + ':' + a.warnings.length)`);
  check('all three load, no warnings', ['hello:ok:0', 'hello-tab:ok:0', 'ai-edit:ok:0'].every((x) => list.includes(x)), list.join(' '));
  const names = await app.main(`return electron.Menu.getApplicationMenu().items.find((i) => i.label === '확장').submenu.items.map((i) => i.label)`);
  check('  their names and commands in Korean (locales/ko.json)', names.includes('Hello: 인사하기') && names.includes('Hello Tab: Counter'), names.join('|'));

  // hello
  await run(w, 'hello.sayHello');
  const toast = await waitFor(() => w.evaluate(`const n = [...document.querySelectorAll('#addon-toasts .addon-toast')].find((x) => x.innerText.includes('Hello!')); return n ? n.innerText : null`), { timeout: 10000 }).catch(() => null);
  check('hello: the command greets', !!toast && toast.includes('Hello! (1번째)'), toast);
  check('  counting in its data folder', readFileSync(path.join(app.tmp, 'addon-data', 'hello', 'global', 'count.txt'), 'utf8') === '1');

  // hello-tab
  const tab = await openAddonTab(app, w, 'Hello Tab: Counter');
  const p = await connect(app.port, (t) => t.url === `mdviewer-addon://hello-tab/tab.html?tab=${tab.id}`, { type: 'iframe', quiet: true });
  await waitFor(() => p.evaluate(`return document.getElementById('why').textContent === 'new'`));
  await p.evaluate(`document.getElementById('add').click(); document.getElementById('add').click(); return 1`);
  await sleep(400);
  const entry = await w.evaluate(`const n = document.querySelector('.doc-tab[data-tab-id="${tab.id}"]'); return { text: n.querySelector('.doc-tab-label').textContent, dirty: n.classList.contains('dirty') }`);
  check('hello-tab: its count in the tab strip, marked unsaved', entry.text === 'Counter 2' && entry.dirty, JSON.stringify(entry));
  await w.evaluate(`await window.mdviewer.detachTab(${tab.id}); return 1`);
  await sleep(2500);
  const p2 = await connect(app.port, (t) => t.url === `mdviewer-addon://hello-tab/tab.html?tab=${tab.id}` && t.id !== p.target.id, { type: 'iframe', quiet: true });
  const moved = await waitFor(() => p2.evaluate(`const why = document.getElementById('why').textContent; return why ? { why, count: document.getElementById('count').textContent } : null`));
  check('  moved to a window: the count comes along', moved.why === 'moved' && moved.count === '2', JSON.stringify(moved));
  await p2.evaluate(`document.getElementById('reset').click(); return 1`);
  await sleep(300);
  await w.evaluate(`await window.mdviewer.closeTab(${tab.id}); return 1`);

  // ai-edit: the whole document (no selection), every rule.
  await w.evaluate(`await window.mdviewer.activateTab(+document.querySelector('.doc-tab').dataset.tabId); return 1`);
  await run(w, 'ai-edit.tidy');
  const pick = await waitFor(() => w.evaluate(`const o = document.getElementById('addon-ui-overlay'); return o && o.dataset.kind === 'quickPick' ? o.querySelectorAll('li[data-id]').length : null`), { timeout: 10000 }).catch(() => null);
  check('ai-edit: asks which rules', pick === 4, String(pick));
  await w.evaluate(`for (const li of document.querySelectorAll('#addon-ui-overlay li[data-id]')) li.click(); document.getElementById('btn-ui-ok').click(); return 1`);
  const shown = await waitFor(() => w.evaluate(`const o = document.getElementById('addon-edit-overlay'); return o && !o.classList.contains('hidden') ? document.getElementById('addon-edit-title').textContent : null`), { timeout: 10000 }).catch(() => null);
  check('  proposes the change on the comparison screen', shown === '마크다운 도우미: 마크다운 다듬기', shown);
  await w.evaluate(`document.getElementById('btn-edit-apply').click(); return 1`);
  await sleep(800);
  const after = readFileSync(path.join(app.tmp, 'proj', 'a.md'), 'utf8');
  check('  applied: the document tidied', after === '# Title\n- item\n\nend\n', JSON.stringify(after));
  const answer = await w.evaluate(`return await window.__run`);
  check('  the command\'s result', answer && answer.ok && answer.result && answer.result.applied === true, JSON.stringify(answer));
} finally {
  await app.stop();
  done();
}
