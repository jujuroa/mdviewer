// edit/apply and the comparison screen (F4, protocol 13.4). Delete is left
// out here: it sends files to the real Recycle Bin (the unit tests check
// its planning).
import path from 'node:path';
import { createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { launch, checker, connect, sleep, openWindowWith, openAddonTab, waitFor, inActiveDoc, enterEditMode } from './harness.mjs';

const { check, done } = checker();
const A = '# A\n\nline one\nline two\n';
const sha1 = (t) => createHash('sha1').update(t, 'utf8').digest('hex');
const app = await launch({
  files: { 'proj/a.md': A, 'proj/b.md': 'b one\n', 'proj/c.md': 'c\n' },
  addonDev: ['test/addons/docs'],
});
const proj = path.join(app.tmp, 'proj');
const aPath = path.join(proj, 'a.md');
const range = (l1, c1, l2, c2) => ({ start: { line: l1, character: c1 }, end: { line: l2, character: c2 } });
try {
  const w = await openWindowWith(app, 'a.md');
  const docTab = await w.evaluate(`return +document.querySelector('.doc-tab.active').dataset.tabId`);
  const d = inActiveDoc(w);
  await enterEditMode(d);
  await d(`ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); doc.execCommand('insertText', false, 'mine\\n'); return 1`);
  const mine = A + 'mine\n';

  const panel = await openAddonTab(app, w, 'Docs: Panel');
  const p = await connect(app.port, (t) => t.url === `mdviewer-addon://docs/panel.html?tab=${panel.id}`, { type: 'iframe', quiet: true });
  await waitFor(() => p.evaluate(`return !!window.panelReady`));
  // Starts edit/apply in the panel; the result lands in window.lastEdit.
  const startEdit = (params) => p.evaluate(`window.lastEdit = undefined; window.mdviewerAddon.edit.apply(${JSON.stringify(params)}).then((r) => (window.lastEdit = r), (e) => (window.lastEdit = 'ERR ' + e.name)); return 1`);
  const lastEdit = () => waitFor(() => p.evaluate(`return window.lastEdit === undefined ? null : window.lastEdit`), { timeout: 8000 }).catch(() => 'no answer');
  const modal = (win = w) => win.evaluate(`const o = document.getElementById('addon-edit-overlay'); return o && !o.classList.contains('hidden') ? { title: document.getElementById('addon-edit-title').textContent, body: document.getElementById('addon-edit-body').innerText, marks: [...o.querySelectorAll('mark')].map((m) => m.textContent) } : null`);

  // A change to the document being edited (unsaved text included).
  const version = (await p.evaluate(`return (await window.mdviewerAddon.documents.read({ path: ${JSON.stringify(aPath)} })).version`));
  check('the add-on reads the unsaved text\'s version', version === sha1(mine));
  await startEdit({ label: 'rewrite', operations: [{ kind: 'change', path: aPath, baseVersion: version, changes: [{ range: range(2, 5, 2, 8), newText: 'ONE' }] }] });
  const shown = await waitFor(modal, { timeout: 5000 }).catch(() => null);
  check('the comparison screen opens with the add-on and label', shown && shown.title === 'Docs: rewrite', JSON.stringify(shown && shown.title));
  check('  showing the change, changed words marked', shown && shown.body.includes('line one') && shown.body.includes('line ONE') && JSON.stringify(shown.marks) === '["one","ONE"]', JSON.stringify(shown));
  await w.evaluate(`document.getElementById('btn-edit-apply').click(); return 1`);
  check('applied: { applied: true }', JSON.stringify(await lastEdit()) === '{"applied":true}');
  await w.evaluate(`await window.mdviewer.activateTab(${docTab}); return 1`);
  await sleep(400);
  check('  the editor has it, still unsaved', (await d(`return ta.value`)) === A.replace('line one', 'line ONE') + 'mine\n' && (await w.evaluate(`return document.querySelector('.doc-tab.active').classList.contains('dirty')`)));
  const undone = await d(`ta.focus(); doc.execCommand('undo'); return ta.value`);
  check('  Ctrl+Z takes it back', undone === mine, JSON.stringify(undone));

  // Cancel.
  const v2 = (await p.evaluate(`return (await window.mdviewerAddon.documents.read({ path: ${JSON.stringify(aPath)} })).version`));
  await startEdit({ operations: [{ kind: 'change', path: aPath, baseVersion: v2, changes: [{ range: range(0, 0, 0, 0), newText: 'X' }] }] });
  await waitFor(modal, { timeout: 5000 });
  await w.evaluate(`document.getElementById('btn-edit-cancel').click(); return 1`);
  check('cancel: { applied: false, reason: "rejected" }, nothing changed', JSON.stringify(await lastEdit()) === '{"applied":false,"reason":"rejected"}' && (await d(`return ta.value`)) === mine);

  // A stale version: Conflict before anything is shown.
  await d(`ta.focus(); doc.execCommand('insertText', false, 'more'); return 1`);
  await startEdit({ operations: [{ kind: 'change', path: aPath, baseVersion: v2, changes: [{ range: range(0, 0, 0, 0), newText: 'X' }] }] });
  check('a version that is no longer current: Conflict, no screen', (await lastEdit()) === 'ERR Conflict' && !(await modal()));

  // A file not open: written to disk. New file and rename in one request.
  const bPath = path.join(proj, 'b.md');
  const vb = (await p.evaluate(`return (await window.mdviewerAddon.documents.read({ path: ${JSON.stringify(bPath)} })).version`));
  await startEdit({ label: 'several', operations: [
    { kind: 'change', path: bPath, baseVersion: vb, changes: [{ range: range(0, 2, 0, 5), newText: 'two' }] },
    { kind: 'create', path: path.join(proj, 'new.md'), text: '# New\n' },
    { kind: 'rename', from: path.join(proj, 'c.md'), to: path.join(proj, 'd.md') },
  ] });
  const several = await waitFor(modal, { timeout: 5000 }).catch(() => null);
  check('several operations on one screen', several && ['수정', '새 파일', '이름 바꾸기'].every((k) => several.body.includes(k)), several && several.body.slice(0, 300));
  await w.evaluate(`document.getElementById('btn-edit-apply').click(); return 1`);
  check('  all applied', JSON.stringify(await lastEdit()) === '{"applied":true}' && readFileSync(bPath, 'utf8') === 'b two\n' && readFileSync(path.join(proj, 'new.md'), 'utf8') === '# New\n' && existsSync(path.join(proj, 'd.md')) && !existsSync(path.join(proj, 'c.md')));

  // With "always confirm" off, confirm: "auto" applies without asking; a rename still asks.
  await app.clickMenu('확장', '확장의 문서 변경 항상 확인');
  await sleep(300);
  const vb2 = (await p.evaluate(`return (await window.mdviewerAddon.documents.read({ path: ${JSON.stringify(bPath)} })).version`));
  await startEdit({ confirm: 'auto', operations: [{ kind: 'change', path: bPath, baseVersion: vb2, changes: [{ range: range(0, 0, 0, 1), newText: 'B' }] }] });
  check('"auto" with the setting off: applied without the screen', JSON.stringify(await lastEdit()) === '{"applied":true}' && readFileSync(bPath, 'utf8') === 'B two\n');
  await startEdit({ confirm: 'auto', operations: [{ kind: 'rename', from: path.join(proj, 'd.md'), to: path.join(proj, 'e.md') }] });
  check('  a rename still asks', !!(await waitFor(modal, { timeout: 5000 }).catch(() => null)));
  await w.evaluate(`document.getElementById('btn-edit-cancel').click(); return 1`);
  await lastEdit();
  await app.clickMenu('확장', '확장의 문서 변경 항상 확인');

  // From a tab window: the screen opens there.
  await w.evaluate(`window.__tw = []; const o = window.open; window.open = function (...a) { const r = o.apply(this, a); if (r) window.__tw.push(r); return r; }; return 1`);
  await w.evaluate(`await window.mdviewer.detachTab(${panel.id}); return 1`);
  await sleep(2500);
  const p2 = await connect(app.port, (t) => t.url === `mdviewer-addon://docs/panel.html?tab=${panel.id}` && t.id !== p.target.id, { type: 'iframe', quiet: true });
  await waitFor(() => p2.evaluate(`return !!window.panelReady`));
  const vb3 = (await p2.evaluate(`return (await window.mdviewerAddon.documents.read({ path: ${JSON.stringify(bPath)} })).version`));
  await p2.evaluate(`window.mdviewerAddon.edit.apply({ operations: [{ kind: 'change', path: ${JSON.stringify(bPath)}, baseVersion: '${vb3}', changes: [{ range: ${JSON.stringify(range(0, 0, 0, 0))}, newText: '>' }] }] }).then((r) => (window.lastEdit = r)); return 1`);
  const inTw = await waitFor(() => w.evaluate(`const tw = window.__tw[0]; const o = tw && tw.document.getElementById('addon-edit-overlay'); return o && !o.classList.contains('hidden') ? 'tab window' : null`), { timeout: 5000 }).catch(() => null);
  check('called from a tab in a tab window: the screen is in that window', inTw === 'tab window');
  await w.evaluate(`window.__tw[0].document.getElementById('btn-edit-apply').click(); return 1`);
  await sleep(800);
  check('  applied from there, and the screen went back', readFileSync(bPath, 'utf8') === '>B two\n' && (await w.evaluate(`return document.getElementById('addon-edit-overlay').ownerDocument === document`)));
} finally {
  await app.stop();
  done();
}
