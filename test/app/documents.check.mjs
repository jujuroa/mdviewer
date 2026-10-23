// Reading documents (F4, protocol 13.1–13.3) and the experimental
// documents.sync (documents/save, documents/reload).
import path from 'node:path';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { launch, checker, connect, sleep, openWindowWith, openAddonTab, waitFor, inActiveDoc, enterEditMode } from './harness.mjs';

const { check, done } = checker();
const A = '# A\n\nline one\nline two\n';
const sha1 = (t) => createHash('sha1').update(t, 'utf8').digest('hex');
const app = await launch({
  files: { 'proj/a.md': A, 'proj/sub/b.md': '# B\n', 'proj/notes.txt': 'n', 'outside/x.md': '# X\n' },
  addonDev: ['test/addons/docs', 'test/addons/test'],
});
const proj = path.join(app.tmp, 'proj');
const aPath = path.join(proj, 'a.md');
try {
  const w = await openWindowWith(app, 'a.md');
  const docTab = await w.evaluate(`return +document.querySelector('.doc-tab.active').dataset.tabId`);
  const panel = await openAddonTab(app, w, 'Docs: Panel');
  const p = await connect(app.port, (t) => t.url === `mdviewer-addon://docs/panel.html?tab=${panel.id}`, { type: 'iframe', quiet: true });
  await waitFor(() => p.evaluate(`return !!window.panelReady`));
  const api = (code) => p.evaluate(`const m = window.mdviewerAddon; try { return await (async () => { ${code} })(); } catch (e) { return 'ERR ' + e.name; }`);

  const projects = await api(`return await m.workspace.projects()`);
  check('workspace/projects', JSON.stringify(projects) === JSON.stringify([{ root: proj, name: 'proj', active: true }]), JSON.stringify(projects));
  const files = await api(`return (await m.workspace.listFiles({ root: ${JSON.stringify(proj)} })).map((f) => f.path)`);
  check('workspace/listFiles: every file', [aPath, path.join(proj, 'sub', 'b.md'), path.join(proj, 'notes.txt')].every((f) => files.includes(f)), JSON.stringify(files));
  const md = await api(`return (await m.workspace.listFiles({ root: ${JSON.stringify(proj)}, extensions: ['md'] })).length`);
  check('  by extension', md === 2, String(md));

  const r1 = await api(`return await m.documents.read({ path: ${JSON.stringify(aPath)} })`);
  check('documents/read (not being edited: the file)', r1.text === A && r1.version === sha1(A) && r1.dirty === false, JSON.stringify(r1));
  check('a path outside the projects: OutsideProject', (await api(`return await m.documents.read({ path: ${JSON.stringify(path.join(app.tmp, 'outside', 'x.md'))} })`)) === 'ERR OutsideProject');
  check('a relative path: InvalidParams', (await api(`return await m.documents.read({ path: 'a.md' })`)) === 'ERR InvalidParams');
  check('documents/active: null while an add-on tab is on screen', (await api(`return await m.documents.active()`)) === null);

  // Being edited: the unsaved text.
  await w.evaluate(`await window.mdviewer.activateTab(${docTab}); return 1`);
  await sleep(500);
  const d = inActiveDoc(w);
  await enterEditMode(d);
  await d(`ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); doc.execCommand('insertText', false, 'line three\\n'); return 1`);
  const edited = A + 'line three\n';
  const r2 = await api(`return await m.documents.read({ path: ${JSON.stringify(aPath)} })`);
  check('documents/read while edited: the unsaved text, dirty', r2.text === edited && r2.version === sha1(edited) && r2.dirty === true);
  const act = await api(`return await m.documents.active()`);
  check('documents/active', act && act.path === aPath && act.editMode === true && act.version === sha1(edited), JSON.stringify(act));

  // The editor's selection: "line one\nline" (offsets 5..18).
  await d(`ta.setSelectionRange(5, 18); return 1`);
  const sel = await api(`return await m.editor.selection()`);
  check('editor/selection from the editor: range, text, source', sel && sel.source === 'editor' && sel.text === 'line one\nline' && JSON.stringify(sel.range) === JSON.stringify({ start: { line: 2, character: 0 }, end: { line: 3, character: 4 } }), JSON.stringify(sel));

  // documents.sync: save the edit; then a change on disk makes the next save a conflict.
  const saved = await api(`return await m.documents.save({ paths: [${JSON.stringify(aPath)}] })`);
  check('documents/save: saved', saved[0].status === 'saved' && readFileSync(aPath, 'utf8') === edited && saved[0].version === sha1(edited), JSON.stringify(saved));
  check('  nothing more to save: clean', (await api(`return (await m.documents.save({}))`)).length === 0);
  await d(`ta.focus(); doc.execCommand('insertText', false, 'more\\n'); return 1`);
  writeFileSync(aPath, 'changed elsewhere\n');
  await sleep(800);
  const conflict = await api(`return await m.documents.save({ paths: [${JSON.stringify(aPath)}] })`);
  check('  a change on disk meanwhile: conflict, the file kept', conflict[0].status === 'conflict' && readFileSync(aPath, 'utf8') === 'changed elsewhere\n', JSON.stringify(conflict));
  const skipped = await api(`return await m.documents.reload({ paths: [${JSON.stringify(aPath)}] })`);
  check('documents/reload with unsaved edits: skipped', skipped[0].status === 'skipped', JSON.stringify(skipped));
  // Put the disk back to what the edit was based on: the save goes
  // through, and edit mode can be left with nothing to ask about.
  writeFileSync(aPath, edited);
  await sleep(800);
  const resolved = await api(`return await m.documents.save({ paths: [${JSON.stringify(aPath)}] })`);
  check('  with the disk back as it was, the save goes through', resolved[0].status === 'saved', JSON.stringify(resolved));
  await d(`doc.getElementById('btn-toggle-edit').click(); return 1`);
  await sleep(800);

  // The viewer's selection (view mode).
  writeFileSync(aPath, A);
  await sleep(1500);
  await d(`const v = doc.getElementById('preview-frame').contentDocument; const pEl = [...v.querySelectorAll('p')].find((x) => x.textContent.includes('line one')); const r = v.createRange(); r.selectNodeContents(pEl); const s = v.getSelection(); s.removeAllRanges(); s.addRange(r); return 1`);
  const vsel = await api(`return await m.editor.selection()`);
  check('editor/selection from the viewer: mapped to the source', vsel && vsel.source === 'viewer' && vsel.text.startsWith('line one') && vsel.range.start.line === 2, JSON.stringify(vsel));

  // reload in view mode
  writeFileSync(aPath, A + 'tail\n');
  const reloaded = await api(`return await m.documents.reload({ paths: [${JSON.stringify(aPath)}] })`);
  check('documents/reload: reloaded with its version', reloaded[0].status === 'reloaded' && reloaded[0].version === sha1(A + 'tail\n'), JSON.stringify(reloaded));
  check('  a document not open: notOpen', (await api(`return (await m.documents.reload({ paths: [${JSON.stringify(path.join(proj, 'sub', 'b.md'))}] }))[0].status`)) === 'notOpen');

  // workspace/openDocument
  await api(`return await m.workspace.openDocument({ path: ${JSON.stringify(path.join(proj, 'sub', 'b.md'))}, line: 0 })`);
  await sleep(1200);
  check('workspace/openDocument opens it in a tab', (await w.evaluate(`return [...document.querySelectorAll('.doc-tab')].map((n) => n.title)`)).some((x) => x.endsWith(path.join('sub', 'b.md'))));

  // An add-on without the permission.
  const probe = await openAddonTab(app, w, 'Test: Probe');
  const t = await connect(app.port, (x) => x.url === `mdviewer-addon://test/probe.html?tab=${probe.id}`, { type: 'iframe', quiet: true });
  const denied = await t.evaluate(`try { await window.mdviewerAddon.call('documents/read', { path: ${JSON.stringify(aPath)} }); return 'read'; } catch (e) { return e.name; }`);
  check('without documents.read: PermissionDenied', denied === 'PermissionDenied', denied);
  const noSync = await t.evaluate(`return typeof (window.mdviewerAddon.documents || {}).save`);
  check('documents.sync only for an add-on that names it', noSync === 'undefined');
} finally {
  await app.stop();
  done();
}
