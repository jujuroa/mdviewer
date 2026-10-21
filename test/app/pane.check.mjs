// The document pane (F0-c): the test add-on's pane in a document tab's
// editor place — showing it, switching between view, source and pane,
// layout, isolation and process.
import { launch, checker, connect, sleep, openWindowWith, inActiveDoc, enterEditMode, waitFor, targets } from './harness.mjs';

const { check, done } = checker();
const app = await launch({ files: { 'proj/a.md': '# A\n\nline one\nline two\n' } });
try {
  const w = await openWindowWith(app, 'a.md');
  const d = inActiveDoc(w);

  // Keys go to the page with the keyboard; an unhandled one reaches the
  // app menu's accelerators, as a real key press does.
  const key = async (target, k, code, modifiers) => {
    for (const type of ['rawKeyDown', 'keyUp']) {
      await target.send('Input.dispatchKeyEvent', { type, key: k, code: `Key${k.toUpperCase()}`, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code, modifiers });
    }
  };
  const CTRL = 2;
  const ALT = 1;
  const SHIFT = 8;
  const mode = () =>
    d(`const pane = doc.getElementById('pane-frame'); return {
      place: !doc.getElementById('editor-pane').classList.contains('hidden'),
      pane: !!pane && !pane.classList.contains('hidden'),
      editActive: doc.getElementById('btn-toggle-edit').classList.contains('active'),
      status: doc.getElementById('edit-status').textContent }`);

  // ---- view -> pane with Ctrl+Alt+E (focus in the document tab)
  await d(`f.focus(); doc.getElementById('preview-frame').focus(); return 1`);
  await key(w, 'e', 69, CTRL | ALT);
  await sleep(2000);
  let m = await mode();
  check('Ctrl+Alt+E in view mode opens the pane in the editor place', m.place && m.pane && !m.editActive, JSON.stringify(m));
  check('  status line names the pane', /시험 칸/.test(m.status), m.status);
  const p = await connect(app.port, (t) => t.url.startsWith('mdviewer-addon://test/pane.html'), { type: 'iframe', quiet: true });
  await waitFor(() => p.evaluate(`return !!window.paneInfo`));
  const info = await p.evaluate(`return { info: window.paneInfo, app: typeof window.mdviewer, addon: typeof window.mdviewerAddon, origin: location.origin }`);
  const tabId = await w.evaluate(`return +document.querySelector('.doc-tab.active').dataset.tabId`);
  check('pane is the test add-on page, bound to this tab', info.info.kind === 'pane' && info.info.tab === tabId && info.origin === 'mdviewer-addon://test', JSON.stringify(info));
  check('isolation: mdviewerAddon only', info.app === 'undefined' && info.addon === 'object');
  check('the pane has the keyboard', (await d(`return doc.activeElement && doc.activeElement.id`)) === 'pane-frame');
  const parentDom = await p.evaluate(`try { return String(window.parent.document.title); } catch (e) { return 'blocked ' + e.name; }`);
  check('isolation: cannot reach the document tab page', parentDom.startsWith('blocked'), parentDom);
  await p.evaluate(`location.href = 'file:///C:/Windows/win.ini'; return 1`).catch(() => {});
  await sleep(1000);
  check('isolation: the pane cannot navigate away', (await targets(app.port)).some((t) => t.type === 'iframe' && t.url.startsWith('mdviewer-addon://test/pane.html')));

  // ---- process and responsiveness
  check('process: the pane is an out-of-process frame', (await targets(app.port)).some((t) => t.type === 'iframe' && t.url.startsWith('mdviewer-addon://test/pane.html')));
  p.fire('window.probe.block(5000)');
  await sleep(300);
  let t0 = Date.now();
  await d(`return doc.getElementById('preview-frame').contentDocument.body.textContent.length`);
  check('a busy pane leaves the document tab responsive', Date.now() - t0 < 1000, `${Date.now() - t0} ms`);
  t0 = Date.now();
  await w.evaluate(`return document.querySelectorAll('.doc-tab').length`);
  check('  and the tab strip', Date.now() - t0 < 1000, `${Date.now() - t0} ms`);
  await sleep(5000);

  // ---- pane -> source with Ctrl+Alt+E pressed in the pane itself
  await p.evaluate(`document.getElementById('text').focus(); return 1`);
  await key(p, 'e', 69, CTRL | ALT);
  await sleep(1500);
  m = await mode();
  check('Ctrl+Alt+E in the pane switches to the source (app shortcut from the pane)', m.place && !m.pane && m.editActive, JSON.stringify(m));
  check('  the source editor has the keyboard', (await d(`return doc.activeElement === ta`)) === true);

  // Type, remember caret, go to the pane and back: text, caret, undo kept.
  await d(`ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); doc.execCommand('insertText', false, 'typed\\n'); ta.setSelectionRange(4, 6); return 1`);
  const sourceWidth = await d(`return doc.getElementById('editor-pane').getBoundingClientRect().width`);
  await key(w, 'e', 69, CTRL | ALT);
  await sleep(800);
  m = await mode();
  check('source -> pane', m.pane && !m.editActive, JSON.stringify(m));
  check('  the save button stays while there are unsaved edits', (await d(`return !doc.getElementById('btn-save-source').classList.contains('hidden')`)) === true);
  // Give the pane a width of its own.
  await d(`doc.getElementById('editor-pane').style.width = '300px'; return 1`);
  await key(w, 'e', 69, CTRL | ALT);
  await sleep(800);
  const back = await d(`return { text: ta.value, start: ta.selectionStart, end: ta.selectionEnd, width: doc.getElementById('editor-pane').getBoundingClientRect().width }`);
  check('pane -> source: text and caret kept', back.text.endsWith('typed\n') && back.start === 4 && back.end === 6, JSON.stringify(back));
  check('  the source keeps its own width', Math.abs(back.width - sourceWidth) < 2, `${back.width} vs ${sourceWidth}`);
  const undo = await d(`ta.focus(); doc.execCommand('undo'); const v = ta.value; doc.execCommand('redo'); return !v.includes('typed')`);
  check('  Ctrl+Z history kept through the pane', undo === true);
  await key(w, 'e', 69, CTRL | ALT);
  await sleep(800);
  const paneWidth = await d(`return doc.getElementById('editor-pane').getBoundingClientRect().width`);
  check('  and the pane its own', Math.abs(paneWidth - 300) < 2, String(paneWidth));

  // ---- the Edit button in pane mode goes to the source
  await d(`doc.getElementById('btn-toggle-edit').click(); return 1`);
  await sleep(800);
  m = await mode();
  check('Edit button in pane mode: to the source', !m.pane && m.editActive, JSON.stringify(m));

  // ---- stacked layout
  await w.evaluate(`await window.mdviewer.setEditorLayout('vertical'); return 1`);
  await sleep(800);
  await key(w, 'e', 69, CTRL | ALT);
  await sleep(800);
  const stacked = await d(`const r = doc.getElementById('pane-frame').getBoundingClientRect(); const v = doc.getElementById('preview-frame').getBoundingClientRect(); return { pane: [r.width, r.height, r.bottom], viewerTop: v.top }`);
  check('stacked layout: the pane above the viewer', stacked.pane[0] > 100 && stacked.pane[1] > 50 && stacked.viewerTop >= stacked.pane[2] - 1, JSON.stringify(stacked));
  await w.evaluate(`await window.mdviewer.setEditorLayout('horizontal'); return 1`);
  await sleep(500);

  // ---- Ctrl+Shift+E in pane mode: view mode, the edits saved (auto save)
  await key(p, 'e', 69, CTRL | SHIFT);
  await sleep(1500);
  m = await mode();
  check('Ctrl+Shift+E in pane mode: view mode', !m.place && !m.pane && !m.editActive, JSON.stringify(m));
  const { readFileSync } = await import('node:fs');
  const path = await import('node:path');
  check('  unsaved source edits saved on the way (auto save)', readFileSync(path.join(app.tmp, 'proj', 'a.md'), 'utf8').includes('typed'));

  // ---- the pane stays alive while hidden: open again, same frame
  await key(w, 'e', 69, CTRL | ALT);
  await sleep(800);
  const again = await p.evaluate(`return !!window.paneInfo`).catch(() => false);
  check('the hidden pane stayed alive (same page on reopening)', again === true);
  check('no IPC refused from app pages', !/\[ipc\] refused .* from file:/.test(app.logText()));
} finally {
  await app.stop();
  done();
}
