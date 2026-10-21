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

  // ---- moving the tab in pane mode: comes back in pane mode, with the
  // unsaved source text, both sizes and the pane's own snapshot
  await d(`doc.getElementById('btn-toggle-edit').click(); return 1`);
  await sleep(800);
  await d(`ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); doc.execCommand('insertText', false, 'before move\\n'); ta.setSelectionRange(2, 3); return 1`);
  await key(w, 'e', 69, CTRL | ALT);
  await sleep(800);
  await d(`doc.getElementById('editor-pane').style.width = '280px'; return 1`);
  await p.evaluate(`window.mdviewerAddon.lifecycle.onSnapshot(() => ({ n: 7, note: '칸 상태' })); return 1`);
  await w.evaluate(`window.__tw = []; const o = window.open; window.open = function (...a) { const r = o.apply(this, a); if (r) window.__tw.push(r); return r; }; return 1`);
  let seen = new Set((await targets(app.port)).map((t) => t.id));
  await w.evaluate(`await window.mdviewer.detachTab(${tabId}); return 1`);
  await sleep(3500);
  const inTw = (code) =>
    w.evaluate(`const f = window.__tw[0].document.querySelector('iframe.doc-frame'); const doc = f.contentDocument; const ta = doc.getElementById('md-source-editor'); ${code}`);
  const tw = await inTw(
    `const pane = doc.getElementById('pane-frame'); return { pane: !!pane && !pane.classList.contains('hidden'), text: ta.value, sel: [ta.selectionStart, ta.selectionEnd], width: doc.getElementById('editor-pane').getBoundingClientRect().width }`
  );
  check('moved to a tab window: still in pane mode', tw.pane, JSON.stringify(tw));
  check('  unsaved source text and caret came along', tw.text.includes('before move') && tw.sel[0] === 2 && tw.sel[1] === 3, JSON.stringify(tw.sel));
  check('  the pane kept its width', Math.abs(tw.width - 280) < 2, String(tw.width));
  let p2 = await connect(app.port, (t) => t.url.startsWith('mdviewer-addon://test/pane.html') && !seen.has(t.id), { type: 'iframe', quiet: true });
  await waitFor(() => p2.evaluate(`return !!window.paneInfo`));
  const r1 = await p2.evaluate(`return { restore: window.mdviewerAddon.tabs.getRestoreState(), info: window.paneInfo }`);
  check('  the pane got its snapshot back (reason moved)', r1.restore.reason === 'moved' && r1.restore.state && r1.restore.state.n === 7 && r1.restore.state.note === '칸 상태', JSON.stringify(r1.restore));
  check('  and knows it is in the tab window now', r1.info.window !== 'main' && r1.info.tab === tabId, JSON.stringify(r1.info));

  // Back to the main window.
  await p2.evaluate(`window.mdviewerAddon.lifecycle.onSnapshot(() => ({ n: 8 })); return 1`);
  seen = new Set((await targets(app.port)).map((t) => t.id));
  await w.evaluate(`await window.mdviewer.moveTabHere(${tabId}, 0, 'main'); return 1`);
  await sleep(3500);
  m = await mode();
  check('moved back: pane mode', m.pane, JSON.stringify(m));
  let p3 = await connect(app.port, (t) => t.url.startsWith('mdviewer-addon://test/pane.html') && !seen.has(t.id), { type: 'iframe', quiet: true });
  await waitFor(() => p3.evaluate(`return !!window.paneInfo`));
  const r2 = await p3.evaluate(`return window.mdviewerAddon.tabs.getRestoreState()`);
  check('  pane snapshot again', r2.reason === 'moved' && r2.state && r2.state.n === 8, JSON.stringify(r2));

  // The window page reloads (language change): pane mode and pane state come back.
  await p3.evaluate(`window.mdviewerAddon.lifecycle.onSnapshot(() => ({ n: 9 })); return 1`);
  seen = new Set((await targets(app.port)).map((t) => t.id));
  await w.evaluate(`window.mdviewer.setLanguage('en'); return 1`).catch(() => {});
  await sleep(5000);
  const w2 = await connect(app.port, (t) => t.url.endsWith('index.html'), { quiet: true });
  const d2 = inActiveDoc(w2);
  const afterReload = await d2(`const pane = doc.getElementById('pane-frame'); return { pane: !!pane && !pane.classList.contains('hidden'), text: ta.value.includes('before move'), status: st.textContent }`);
  check('language change: pane mode and unsaved text come back', afterReload.pane && afterReload.text, JSON.stringify(afterReload));
  check('  status line in the new language', /Pane: Test Pane/.test(afterReload.status), afterReload.status);
  const p4 = await connect(app.port, (t) => t.url.startsWith('mdviewer-addon://test/pane.html') && !seen.has(t.id), { type: 'iframe', quiet: true });
  await waitFor(() => p4.evaluate(`return !!window.paneInfo`));
  const r3 = await p4.evaluate(`return window.mdviewerAddon.tabs.getRestoreState()`);
  check('  pane snapshot back (reason reloaded)', r3.reason === 'reloaded' && r3.state && r3.state.n === 9, JSON.stringify(r3));
  await w2.evaluate(`window.mdviewer.setLanguage('ko'); return 1`).catch(() => {});
  await sleep(3000);
  check('no IPC refused from app pages', !/\[ipc\] refused .* from file:/.test(app.logText()));
} finally {
  await app.stop();
  done();
}
