// Document tabs: opening, the strip, order, drafts, unsaved marks, moving
// to a tab window and back, closing.
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { launch, checker, sleep, openWindowWith, inActiveDoc, enterEditMode, targets } from './harness.mjs';

const { check, done } = checker();
const app = await launch({
  files: {
    'proj/a.md': '# A\n',
    'proj/b.puml': '@startuml\nA -> B\n@enduml\n',
    'proj/x/same.md': '# X\n',
    'proj/y/same.md': '# Y\n',
  },
});
try {
  const w = await openWindowWith(app, 'a.md');
  const strip = () =>
    w.evaluate(
      `return [...document.querySelectorAll('.doc-tab')].map(n => ({ id: +n.dataset.tabId, text: n.querySelector('.doc-tab-label').textContent, title: n.title, active: n.classList.contains('active'), dirty: n.classList.contains('dirty'), preview: n.classList.contains('preview'), icon: n.querySelector('.doc-tab-icon').innerHTML.length > 0 }))`
    );
  const click = (rel) =>
    w.evaluate(`const r = [...document.querySelectorAll('[data-path]')].find(n => n.dataset.path.replace(/\\\\/g, '/').endsWith(${JSON.stringify(rel)})); if (!r) return false; r.click(); return true`);

  await click('proj/b.puml');
  await sleep(600);
  await click('/x');
  await click('/y');
  await sleep(600);
  await click('x/same.md');
  await sleep(600);
  await click('y/same.md');
  await sleep(1500);
  const s1 = await strip();
  check('a click opens a tab each time (no preview tab)', s1.length === 4 && s1.every((t) => !t.preview), JSON.stringify(s1.map((t) => t.text)));
  check('titles are file names', s1[0].text === 'a.md' && s1[1].text === 'b.puml');
  check('same names get their folder', s1[2].text === 'same.mdx' && s1[3].text === 'same.mdy', `${s1[2].text} / ${s1[3].text}`);
  check('tooltip is the full path', s1[0].title.replace(/\\/g, '/').endsWith('proj/a.md'), s1[0].title);
  check('icons drawn, last opened active', s1.every((t) => t.icon) && s1[3].active);
  const frames = await w.evaluate(`return [...document.querySelectorAll('iframe.doc-frame')].map(f => f.src.replace(/^.*\\/src\\//, ''))`);
  check('one iframe per tab at doc.html?tab=N', frames.length === 4 && frames.every((f) => /^doc\.html\?tab=\d+$/.test(f)), JSON.stringify(frames));

  await click('proj/a.md');
  await sleep(800);
  const s2 = await strip();
  check('clicking an open document brings its tab forward', s2.length === 4 && s2[0].active);

  const [a, b, x, y] = s2.map((t) => t.id);
  await w.evaluate(`await window.mdviewer.moveTabHere(${a}, 2, 'main'); return 1`);
  await sleep(400);
  check('reorder: a before the third tab', (await strip()).map((t) => t.id).join() === [b, a, x, y].join());
  await w.evaluate(`await window.mdviewer.moveTabHere(${y}, 0, 'main'); return 1`);
  await sleep(400);
  check('reorder: last to the front', (await strip()).map((t) => t.id).join() === [y, b, a, x].join());

  // Draft and unsaved mark.
  await w.evaluate(`await window.mdviewer.newDraftTab('main'); return 1`);
  await sleep(1500);
  const draft = (await strip()).find((t) => t.active);
  check('draft tab', draft && !draft.text.endsWith('.md'), draft && draft.text);
  const d = inActiveDoc(w);
  await d(`ta.focus(); doc.execCommand('insertText', false, 'hello'); return 1`);
  await sleep(800);
  check('unsaved mark in the strip', (await strip()).find((t) => t.active).dirty);

  // Move a.md out to a tab window and back.
  await w.evaluate(`await window.mdviewer.detachTab(${a}); return 1`);
  await sleep(2500);
  check('detached: the main strip lost it', !(await strip()).some((t) => t.id === a));
  check('a tab window opened', (await targets(app.port)).filter((t) => t.type === 'page').length >= 2);
  await w.evaluate(`await window.mdviewer.moveTabHere(${a}, 0, 'main'); return 1`);
  await sleep(2500);
  check('moved back to the front', (await strip())[0].id === a);

  // Closing: the neighbour takes over; an edited tab saves first.
  await w.evaluate(`await window.mdviewer.activateTab(${b}); return 1`);
  await sleep(300);
  const before = await strip();
  const at = before.findIndex((t) => t.id === b);
  const expected = (before[at + 1] || before[at - 1]).id;
  await w.evaluate(`await window.mdviewer.closeTab(${b}); return 1`);
  await sleep(800);
  const s3 = await strip();
  check('closing the active tab activates the one that took its place', !s3.some((t) => t.id === b) && s3.find((t) => t.active)?.id === expected, JSON.stringify(s3.map((t) => t.text + (t.active ? '*' : ''))));
  await click('proj/a.md');
  await sleep(800);
  await enterEditMode(d);
  await d(`ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); doc.execCommand('insertText', false, 'closing edit\\n'); return 1`);
  await sleep(300);
  await w.evaluate(`await window.mdviewer.closeTab(${a}); return 1`);
  await sleep(1500);
  check('closing an edited tab saves it (auto save)', readFileSync(path.join(app.tmp, 'proj', 'a.md'), 'utf8').includes('closing edit'));
  check('and the tab is gone', !(await strip()).some((t) => t.id === a));
} finally {
  await app.stop();
  done();
}
