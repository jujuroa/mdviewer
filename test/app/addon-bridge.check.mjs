// The add-on bridge (F0-b): mdviewerAddon in add-on frames only, callers
// told by main, impersonation refused, the snapshot handed over when a tab
// moves or its window reloads, the window page's modals over the frame.
import { launch, checker, connect, waitFor, sleep, targets } from './harness.mjs';

const { check, done } = checker();
const app = await launch({ files: { 'proj/a.md': '# A\n' } });
const { port } = app;
const logText = app.logText;
const frameOf = (prefix, exclude = new Set()) => connect(port, (t) => t.url.startsWith(prefix) && !exclude.has(t.id), { type: 'iframe', quiet: true });
try {
  const w = await connect(port, (t) => t.url.endsWith('index.html'));
  await waitFor(() => w.evaluate(`const r = [...document.querySelectorAll('[data-path]')].find(n => n.dataset.path.endsWith('a.md')); if (r) r.click(); return !!r`));
  await sleep(2500);
  const opened = await w.evaluate(`return await window.mdviewer.openTestTab('mdviewer-addon://test/probe.html', 'main')`);
  await sleep(2000);
  let a = await frameOf('mdviewer-addon://test/probe.html');
  check('page address carries the tab id hint', a.target.url === `mdviewer-addon://test/probe.html?tab=${opened.id}`, a.target.url);

  // ---- preload branch
  const b = await a.evaluate(`return { addon: typeof window.mdviewerAddon, app: typeof window.mdviewer, version: window.mdviewerAddon && window.mdviewerAddon.app.version }`);
  check('add-on frame: mdviewerAddon only', b.addon === 'object' && b.app === 'undefined' && !!b.version, JSON.stringify(b));
  const docSide = await w.evaluate(`const f = document.querySelector('iframe.doc-frame'); const v = f.contentDocument.getElementById('preview-frame').contentWindow; return { win: typeof window.mdviewerAddon, doc: typeof f.contentWindow.mdviewerAddon, docApp: typeof f.contentWindow.mdviewer, viewer: typeof v.mdviewer + '/' + typeof v.mdviewerAddon }`);
  check('window page and document tab: no mdviewerAddon; viewer frame: neither bridge', docSide.win === 'undefined' && docSide.doc === 'undefined' && docSide.docApp === 'object' && docSide.viewer === 'undefined/undefined', JSON.stringify(docSide));
  const frozen = await a.evaluate(`try { window.mdviewerAddon.call = () => 'hijacked'; } catch (e) {} return typeof window.mdviewerAddon.call('app/info').then`);
  check('bridge cannot be overwritten by the page', frozen === 'function', frozen);

  // ---- calls
  const info = await a.evaluate(`return await window.mdviewerAddon.call('app/info')`);
  check('addon:call app/info: caller decided by main', info && info.addon === 'test' && info.tab === opened.id, JSON.stringify(info));
  const unknown = await a.evaluate(`try { await window.mdviewerAddon.call('documents/delete-everything'); return 'ok'; } catch (e) { return e.message; }`);
  check('unknown method refused', /MethodNotFound/.test(unknown), unknown);
  const restoreNew = await a.evaluate(`return window.mdviewerAddon.tabs.getRestoreState()`);
  check('new tab: getRestoreState reason new', restoreNew && restoreNew.reason === 'new' && restoreNew.state === null, JSON.stringify(restoreNew));

  // ---- impersonation: the 'other' add-on reloads itself with the test tab's id as its hint
  const o1 = await w.evaluate(`return await window.mdviewer.openTestTab('mdviewer-addon://other/probe.html', 'main')`);
  await sleep(1500);
  let o = await frameOf('mdviewer-addon://other/probe.html');
  await o.evaluate(`location.href = 'mdviewer-addon://other/probe.html?tab=${opened.id}'; return 1`).catch(() => {});
  await sleep(1500);
  o = await frameOf(`mdviewer-addon://other/probe.html?tab=${opened.id}`);
  const spoof = await o.evaluate(`return typeof window.mdviewerAddon`);
  check('another add-on claiming the test tab gets no bridge', spoof === 'undefined', spoof);
  check('  refusal logged', /\[ipc\] refused addon:hello from mdviewer-addon:\/\/other/.test(logText()));
  const stillTest = await a.evaluate(`return (await window.mdviewerAddon.call('app/info')).addon`);
  check('  the test tab keeps its own frame', stillTest === 'test', stillTest);
  await w.evaluate(`return await window.mdviewer.closeTab(${o1.id})`);

  // ---- snapshot round trip: move to a tab window
  await a.evaluate(`window.mdviewerAddon.lifecycle.onSnapshot(() => ({ counter: 42, text: '한글 ok', list: [1, 2, 3] })); return 1`);
  const seen = new Set((await targets(port)).map((t) => t.id));
  await w.evaluate(`await window.mdviewer.detachTab(${opened.id}); return 1`);
  await sleep(2500);
  a = await frameOf('mdviewer-addon://test/probe.html', seen);
  const moved = await a.evaluate(`return window.mdviewerAddon.tabs.getRestoreState()`);
  check('moved to a tab window: state handed over', moved && moved.reason === 'moved' && moved.state && moved.state.counter === 42 && moved.state.text === '한글 ok', JSON.stringify(moved));
  const info2 = await a.evaluate(`return await window.mdviewerAddon.call('app/info')`);
  check('  calls work from the tab window', info2 && info2.tab === opened.id, JSON.stringify(info2));

  // ---- back to the main window with an async handler
  await a.evaluate(`window.mdviewerAddon.lifecycle.onSnapshot(async () => { await new Promise(r => setTimeout(r, 300)); return { back: true }; }); return 1`);
  let seen2 = new Set((await targets(port)).map((t) => t.id));
  await w.evaluate(`await window.mdviewer.moveTabHere(${opened.id}, 1, 'main'); return 1`);
  await sleep(2500);
  a = await frameOf('mdviewer-addon://test/probe.html', seen2);
  const back = await a.evaluate(`return window.mdviewerAddon.tabs.getRestoreState()`);
  check('moved back: async handler state handed over', back && back.reason === 'moved' && back.state && back.state.back === true, JSON.stringify(back));

  // ---- too slow (> 2 s) and too big (> 1 MiB) hand over nothing
  await a.evaluate(`window.mdviewerAddon.lifecycle.onSnapshot(() => new Promise(r => setTimeout(() => r({ late: true }), 3000))); return 1`);
  seen2 = new Set((await targets(port)).map((t) => t.id));
  await w.evaluate(`await window.mdviewer.detachTab(${opened.id}); return 1`);
  await sleep(4000);
  a = await frameOf('mdviewer-addon://test/probe.html', seen2);
  const slow = await a.evaluate(`return window.mdviewerAddon.tabs.getRestoreState()`);
  check('slow handler (3 s): nothing handed over', slow && slow.reason === 'moved' && slow.state === null, JSON.stringify(slow));
  await a.evaluate(`window.mdviewerAddon.lifecycle.onSnapshot(() => ({ big: 'x'.repeat(1100000) })); return 1`);
  seen2 = new Set((await targets(port)).map((t) => t.id));
  await w.evaluate(`await window.mdviewer.moveTabHere(${opened.id}, 1, 'main'); return 1`);
  await sleep(2500);
  a = await frameOf('mdviewer-addon://test/probe.html', seen2);
  const big = await a.evaluate(`return window.mdviewerAddon.tabs.getRestoreState()`);
  check('big state (> 1 MiB): nothing handed over', big && big.state === null, JSON.stringify(big).slice(0, 80));
  const fn = await a.evaluate(`window.mdviewerAddon.lifecycle.onSnapshot(() => ({ f: () => 1 })); return 1`);

  // ---- window page reload (language change): state comes back with reason 'reloaded'
  await a.evaluate(`window.mdviewerAddon.lifecycle.onSnapshot(() => ({ lang: 'switch' })); return 1`);
  seen2 = new Set((await targets(port)).map((t) => t.id));
  await w.evaluate(`window.mdviewer.setLanguage('en'); return 1`).catch(() => {});
  await sleep(4000);
  const w2 = await connect(port, (t) => t.url.endsWith('index.html'), { quiet: true });
  a = await frameOf('mdviewer-addon://test/probe.html', seen2);
  const reloaded = await a.evaluate(`return window.mdviewerAddon.tabs.getRestoreState()`);
  check('language change (window page reload): state back, reason reloaded', reloaded && reloaded.reason === 'reloaded' && reloaded.state && reloaded.state.lang === 'switch', JSON.stringify(reloaded));
  const lang = await a.evaluate(`return window.mdviewerAddon.app.language`);
  check('  app.language follows', lang === 'en', lang);

  // ---- modal of the window page over the add-on tab
  await w2.evaluate(`const tab = [...document.querySelectorAll('.doc-tab')].find(n => /probe/.test(n.textContent)); tab && tab.click(); return 1`);
  await sleep(800);
  const modal = await w2.evaluate(`const f = document.querySelector('iframe.doc-frame.active'); const r = f.getBoundingClientRect(); document.getElementById('ext-settings-overlay').classList.remove('hidden'); const el = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); const inOverlay = !!el.closest('#ext-settings-overlay'); document.getElementById('ext-settings-overlay').classList.add('hidden'); return { src: f.src.slice(0, 40), inOverlay, el: el.tagName + '.' + el.className }`);
  check('window page modal is drawn over the add-on tab', modal.src.startsWith('mdviewer-addon://') && modal.inOverlay, JSON.stringify(modal));

  // ---- close: the add-on frame answers tab:ask close
  const closed = await w2.evaluate(`const id = +[...document.querySelectorAll('.doc-tab')].find(n => /probe/.test(n.textContent)).dataset.tabId; return await window.mdviewer.closeTab(id)`);
  check('closing the add-on tab', closed && closed.closed, JSON.stringify(closed));
  check('no IPC refused from app pages', !/\[ipc\] refused .* from file:/.test(logText()), logText().split(/\r?\n/).filter((l) => /refused/.test(l)).join(' | '));
  await w2.evaluate(`window.mdviewer.setLanguage('ko'); return 1`).catch(() => {});
} finally {
  await app.stop();
  done();
}
