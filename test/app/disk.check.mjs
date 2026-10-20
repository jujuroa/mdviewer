// Changes on disk while a document is being edited (W4 Q7·Q8). The
// conflict dialog's three choices are a native dialog this can't press:
// checked by hand.
import path from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';
import { launch, checker, sleep, openWindowWith, inActiveDoc, enterEditMode, waitFor } from './harness.mjs';

const { check, done } = checker();
const app = await launch({ files: { 'proj/a.md': '# A\n\nline one\n' } });
const file = path.join(app.tmp, 'proj', 'a.md');
try {
  const w = await openWindowWith(app, 'a.md');
  const d = inActiveDoc(w);
  await enterEditMode(d);
  await waitFor(() => d(`return ta.value.includes('line one')`));

  // Q8: nothing unsaved -> the editor takes the new text, caret kept.
  await d(`ta.focus(); ta.setSelectionRange(5, 5); return 1`);
  writeFileSync(file, '# A\n\nline one\nexternal two\n');
  const reloaded = await waitFor(() => d(`return ta.value.includes('external two') ? { caret: ta.selectionStart } : null`)).catch(() => null);
  check('Q8: edit mode with nothing unsaved reloads a change on disk', !!reloaded);
  check('Q8: caret kept', reloaded && reloaded.caret === 5, JSON.stringify(reloaded));
  const viewer = await d(`return doc.getElementById('preview-frame').contentDocument.body.textContent`);
  check('Q8: the viewer shows it too', viewer.includes('external two'));

  // Own save: not taken for a change on disk, undo history kept.
  await d(`ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); doc.execCommand('insertText', false, 'mine three\\n'); return 1`);
  await d(`doc.getElementById('btn-save-source').click(); return 1`);
  await sleep(1500);
  const status = await d(`return st.textContent`);
  check('own save writes the file', readFileSync(file, 'utf8').includes('mine three') && /저장됨/.test(status), status);
  const undo = await d(`ta.focus(); doc.execCommand('undo'); const v = ta.value; doc.execCommand('redo'); return v.includes('mine three')`);
  check('own save keeps the undo history', undo === false);

  // Q7: unsaved edits + change on disk -> notice; auto save on blur writes nothing.
  await d(`ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); doc.execCommand('insertText', false, 'unsaved four\\n'); return 1`);
  await sleep(300);
  writeFileSync(file, '# A\n\nexternal rewrite\n');
  const notice = await waitFor(() => d(`return /바뀌었습니다/.test(st.textContent) ? st.textContent : null`)).catch(() => null);
  check('Q7: unsaved edits + change on disk: status line says so, edits kept', !!notice && (await d(`return ta.value.includes('unsaved four')`)), notice);
  await d(`ta.blur(); return 1`);
  await sleep(1500);
  check('Q7: auto save does not write over the change on disk', readFileSync(file, 'utf8') === '# A\n\nexternal rewrite\n');
  check('Q7: says it did not save', /저장하지 않음/.test(await d(`return st.textContent`)));

  // The text's base version travels with a tab moving to a tab window.
  await d(`ta.focus(); doc.execCommand('insertText', false, 'more\\n'); return 1`);
  writeFileSync(file, '# A\n\nexternal before move\n');
  await sleep(1000);
  await w.evaluate(`window.__tw = []; const o = window.open; window.open = function (...a) { const r = o.apply(this, a); if (r) window.__tw.push(r); return r; }; return 1`);
  const id = await w.evaluate(`return +document.querySelector('.doc-tab').dataset.tabId`);
  await w.evaluate(`await window.mdviewer.detachTab(${id}); return 1`);
  await sleep(3000);
  const inTw = (code) =>
    w.evaluate(`const f = window.__tw[0].document.querySelector('iframe.doc-frame'); const doc = f.contentDocument; const ta = doc.getElementById('md-source-editor'); const st = doc.getElementById('edit-status'); ${code}`);
  check('moved: unsaved text travels to the tab window', (await inTw(`return ta.value`)).includes('more'));
  await inTw(`ta.focus(); doc.execCommand('insertText', false, 'x'); ta.blur(); return 1`);
  await sleep(1500);
  check('moved: auto save still refuses to write over the change on disk', readFileSync(file, 'utf8') === '# A\n\nexternal before move\n');
} finally {
  await app.stop();
  done();
}
