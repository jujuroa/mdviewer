// ui/* (F4, protocol 13.5): notifications and progress at the bottom right
// of the caller's window, questions in a dialog there, one at a time.
import { launch, checker, connect, sleep, openWindowWith, openAddonTab, waitFor } from './harness.mjs';

const { check, done } = checker();
const app = await launch({ files: { 'proj/a.md': '# A\n' }, addonDev: ['test/addons/docs'] });
try {
  const w = await openWindowWith(app, 'a.md');
  const panel = await openAddonTab(app, w, 'Docs: Panel');
  const p = await connect(app.port, (t) => t.url === `mdviewer-addon://docs/panel.html?tab=${panel.id}`, { type: 'iframe', quiet: true });
  await waitFor(() => p.evaluate(`return !!window.panelReady`));
  // Starts a ui call in the panel; its result (or 'ERR name') lands in window.r[key].
  const start = (key, expr, page = p) => page.evaluate(`window.r = window.r || {}; delete window.r.${key}; Promise.resolve(window.mdviewerAddon.${expr}).then((v) => (window.r.${key} = v === undefined ? 'undefined' : v), (e) => (window.r.${key} = 'ERR ' + e.name)); return 1`);
  const result = (key, page = p) => waitFor(() => page.evaluate(`return window.r && '${key}' in window.r ? JSON.stringify(window.r.${key}) : null`), { timeout: 5000 }).catch(() => 'no answer');
  const dialog = (win = w) => win.evaluate(`const o = document.getElementById('addon-ui-overlay'); return o ? { kind: o.dataset.kind, title: o.querySelector('.modal-header').textContent, text: o.querySelector('.addon-ui-body').innerText } : null`);
  const toasts = (win = w) => win.evaluate(`return [...document.querySelectorAll('#addon-toasts .addon-toast')].map((n) => n.innerText)`);

  check('the ui area is listed for the add-on', await p.evaluate(`return typeof window.mdviewerAddon.ui.progress.start === 'function'`));

  // notify
  await start('n1', `ui.notify({ message: 'Saved it' })`);
  check('notify without actions: answered null at once', (await result('n1')) === 'null');
  check('  shown at the bottom right with the add-on name', (await toasts()).some((t) => t.includes('Docs') && t.includes('Saved it')));
  check('  no dialog for it', !(await dialog()));
  await start('n2', `ui.notify({ level: 'warning', message: 'Retry?', actions: ['Retry', 'Skip'] })`);
  await waitFor(() => w.evaluate(`return [...document.querySelectorAll('#addon-toasts .addon-toast.warning button')].some((b) => b.textContent === 'Skip')`));
  await sleep(300);
  check('  with actions: waits for one', (await p.evaluate(`return 'n2' in window.r`)) === false);
  await w.evaluate(`[...document.querySelectorAll('#addon-toasts .addon-toast.warning button')].find((b) => b.textContent === 'Skip').click(); return 1`);
  check('  the action clicked is the answer', (await result('n2')) === '"Skip"');

  // confirm
  await start('c1', `ui.confirm({ message: 'Delete the cache?', detail: 'It is rebuilt later.', okLabel: 'Delete' })`);
  const c = await waitFor(dialog, { timeout: 5000 }).catch(() => null);
  check('confirm: a dialog with message and detail', c && c.kind === 'confirm' && c.title === 'Docs' && c.text.includes('Delete the cache?') && c.text.includes('rebuilt'), JSON.stringify(c));
  check('  the OK button carries okLabel', (await w.evaluate(`return document.getElementById('btn-ui-ok').textContent`)) === 'Delete');
  await w.evaluate(`document.getElementById('btn-ui-ok').click(); return 1`);
  check('  OK: true', (await result('c1')) === 'true' && !(await dialog()));
  await start('c2', `ui.confirm({ message: 'Again?' })`);
  await waitFor(dialog);
  await w.evaluate(`document.getElementById('addon-ui-overlay').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); return 1`);
  check('  Escape: false', (await result('c2')) === 'false');

  // Two at once: one after the other.
  await start('q1', `ui.confirm({ message: 'First' })`);
  await start('q2', `ui.confirm({ message: 'Second' })`);
  await waitFor(dialog);
  check('two questions: the first is shown, alone', (await dialog()).text.includes('First') && (await w.evaluate(`return document.querySelectorAll('#addon-ui-overlay').length`)) === 1);
  await w.evaluate(`document.getElementById('btn-ui-cancel').click(); return 1`);
  const second = await waitFor(async () => { const d = await dialog(); return d && d.text.includes('Second') ? d : null; }, { timeout: 3000 }).catch(() => null);
  check('  then the second', !!second && (await result('q1')) === 'false');
  await w.evaluate(`document.getElementById('btn-ui-ok').click(); return 1`);
  check('  answered in turn', (await result('q2')) === 'true');

  // input
  await start('i1', `ui.input({ title: 'Token', prompt: 'Paste the token', value: 'old', password: true })`);
  await waitFor(dialog);
  const input = await w.evaluate(`const i = document.querySelector('#addon-ui-overlay input'); return { type: i.type, value: i.value, focused: document.activeElement === i }`);
  check('input: password field with the value, focused', input.type === 'password' && input.value === 'old' && input.focused, JSON.stringify(input));
  check('  titled "name: title"', (await dialog()).title === 'Docs: Token');
  await w.evaluate(`const i = document.querySelector('#addon-ui-overlay input'); i.value = 's3cret'; i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); return 1`);
  check('  Enter: what was typed', (await result('i1')) === '"s3cret"');
  await start('i2', `ui.input({})`);
  await waitFor(dialog);
  await w.evaluate(`document.getElementById('btn-ui-cancel').click(); return 1`);
  check('  cancel: UserCanceled', (await result('i2')) === '"ERR UserCanceled"');

  // quickPick
  const items = JSON.stringify([{ id: 'a', label: 'Apple' }, { id: 'b', label: 'Banana', detail: 'yellow' }, { id: 'c', label: 'Cherry' }]);
  await start('p1', `ui.quickPick({ title: 'Fruit', items: ${items} })`);
  await waitFor(dialog);
  const labels = () => w.evaluate(`return [...document.querySelectorAll('#addon-ui-overlay .palette-list li')].map((li) => li.dataset.id || li.textContent)`);
  check('quickPick: every item listed', JSON.stringify(await labels()) === '["a","b","c"]');
  await w.evaluate(`const i = document.querySelector('#addon-ui-overlay input'); i.value = 'yel'; i.dispatchEvent(new Event('input')); return 1`);
  check('  typing filters (detail too)', JSON.stringify(await labels()) === '["b"]');
  await w.evaluate(`const i = document.querySelector('#addon-ui-overlay input'); i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); return 1`);
  check('  Enter picks it', (await result('p1')) === '"b"');
  await start('p2', `ui.quickPick({ items: ${items}, multi: true })`);
  await waitFor(dialog);
  await w.evaluate(`for (const id of ['a', 'c']) document.querySelector('#addon-ui-overlay li[data-id="' + id + '"]').click(); return 1`);
  await w.evaluate(`document.getElementById('btn-ui-ok').click(); return 1`);
  check('  multi: the ones checked', (await result('p2')) === '["a","c"]');
  await start('p3', `ui.quickPick({ items: ${items} })`);
  await waitFor(dialog);
  await w.evaluate(`document.getElementById('addon-ui-overlay').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); return 1`);
  check('  Escape: UserCanceled', (await result('p3')) === '"ERR UserCanceled"');

  // progress
  const prog = () => w.evaluate(`const n = document.querySelector('#addon-toasts .addon-progress'); return n ? { text: n.innerText, width: n.querySelector('.progress-bar').style.width, cancel: !!n.querySelector('button') } : null`);
  await start('g1', `ui.progress.start({ title: 'Indexing', cancellable: true })`);
  const token = JSON.parse(await result('g1')).token;
  check('progress: shown at the bottom right', ((await prog()) || {}).text.includes('Indexing'));
  await start('g2', `ui.progress.report({ token: '${token}', message: 'half way', percent: 50 })`);
  check('  report: not cancelled', (await result('g2')) === '{"cancelled":false}');
  const half = await prog();
  check('  shows the message and the share done', half.text.includes('half way') && half.width === '50%', JSON.stringify(half));
  await w.evaluate(`document.querySelector('#addon-toasts .addon-progress button').click(); return 1`);
  await sleep(300);
  await start('g3', `ui.progress.report({ token: '${token}', percent: 60 })`);
  check('  after Cancel, report says so', (await result('g3')) === '{"cancelled":true}');
  await start('g4', `ui.progress.end({ token: '${token}' })`);
  await result('g4');
  check('  end: gone', !(await prog()));
  await start('g5', `ui.progress.start({ title: 'Big', location: 'dialog' })`);
  const t5 = JSON.parse(await result('g5')).token;
  check('  location "dialog": in the middle, over the window', await w.evaluate(`return !!document.querySelector('.addon-progress-overlay .addon-progress')`));
  await start('g6', `ui.progress.end({ token: '${t5}' })`);
  await result('g6');
  check('  ended', await w.evaluate(`return !document.querySelector('.addon-progress-overlay')`));

  // A progress whose page goes away is ended for it.
  await start('g7', `ui.progress.start({ title: 'Orphan' })`);
  await result('g7');
  await w.evaluate(`return await window.mdviewer.closeTab(${panel.id})`);
  const gone = await waitFor(async () => !(await prog()), { timeout: 5000 }).catch(() => false);
  check('the add-on\'s tab closed: its progress goes', gone);

  // From a tab window: shown there.
  const panel2 = await openAddonTab(app, w, 'Docs: Panel');
  await w.evaluate(`window.__tw = []; const o = window.open; window.open = function (...a) { const r = o.apply(this, a); if (r) window.__tw.push(r); return r; }; return 1`);
  await w.evaluate(`await window.mdviewer.detachTab(${panel2.id}); return 1`);
  await sleep(2500);
  const p2 = await connect(app.port, (t) => t.url === `mdviewer-addon://docs/panel.html?tab=${panel2.id}`, { type: 'iframe', quiet: true });
  await waitFor(() => p2.evaluate(`return !!window.panelReady`));
  await start('t1', `ui.notify({ message: 'Over here' })`, p2);
  await result('t1', p2);
  check('from a tab window: the notification is in that window', await w.evaluate(`const d = window.__tw[0].document; return [...d.querySelectorAll('#addon-toasts .addon-toast')].some((n) => n.innerText.includes('Over here'))`));
  await start('t2', `ui.confirm({ message: 'There?' })`, p2);
  const there = await waitFor(() => w.evaluate(`return !!window.__tw[0].document.getElementById('addon-ui-overlay')`), { timeout: 5000 }).catch(() => false);
  check('  so is the dialog', there && !(await dialog()));
  await w.evaluate(`window.__tw[0].document.getElementById('btn-ui-ok').click(); return 1`);
  check('  answered from there', (await result('t2', p2)) === 'true');
} finally {
  await app.stop();
  done();
}
