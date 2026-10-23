// Add-on commands and the command palette (F3, protocol 7.6, 12.1).
import { launch, checker, connect, sleep, openWindowWith, targets, waitFor } from './harness.mjs';

const { check, done } = checker();
const app = await launch({ files: { 'proj/a.md': '# A\n' }, addonDev: ['test/addons/bg'] });
const key = async (target, k, code, modifiers) => {
  for (const type of ['rawKeyDown', 'keyUp']) {
    await target.send('Input.dispatchKeyEvent', { type, key: k, code: `Key${k.toUpperCase()}`, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code, modifiers });
  }
};
const press = (w, k) => w.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: k, code: k, windowsVirtualKeyCode: { Enter: 13, Escape: 27, ArrowDown: 40 }[k] });
try {
  const w = await openWindowWith(app, 'a.md');
  const shown = () => w.evaluate(`return document.getElementById('command-palette').classList.contains('hidden') ? null : [...document.querySelectorAll('#palette-list li')].map((li) => (li.classList.contains('selected') ? '>' : '') + li.textContent)`);

  // Ctrl+Shift+P from the window opens it.
  await w.evaluate(`document.querySelector('.doc-tab').focus(); return 1`);
  await key(w, 'p', 80, 2 | 8);
  const list = await waitFor(shown, { timeout: 5000 }).catch(() => null);
  check('Ctrl+Shift+P opens the command palette', !!list, JSON.stringify(list));
  check('  lists add-on commands and opening its tabs', list && ['Background: Count', 'Background: Show in View', '열기: Background: View'].every((l) => list.some((x) => x.endsWith(l))), JSON.stringify(list));
  check('  input has the keyboard', (await w.evaluate(`return document.activeElement.id`)) === 'palette-input');
  await w.evaluate(`const i = document.getElementById('palette-input'); i.value = 'cou'; i.dispatchEvent(new Event('input')); return 1`);
  check('typing filters', JSON.stringify(await shown()) === JSON.stringify(['>Background: Count']), JSON.stringify(await shown()));
  await press(w, 'Escape');
  await sleep(300);
  check('Escape closes it', (await shown()) === null);

  // A background command: starts the background frame (onCommand) and runs there.
  await app.clickMenu('확장', '명령 팔레트...');
  await waitFor(shown);
  await w.evaluate(`const i = document.getElementById('palette-input'); i.value = 'count'; i.dispatchEvent(new Event('input')); return 1`);
  await press(w, 'Enter');
  const bgT = await waitFor(async () => (await targets(app.port)).find((t) => t.url.startsWith('mdviewer-addon://bg/background.html')), { timeout: 8000 }).catch(() => null);
  check('a background command starts the background frame', !!bgT && /bg background starting \(onCommand:bg\.count\)/.test(app.logText()));
  const bg = await connect(app.port, (t) => t.url.startsWith('mdviewer-addon://bg/background.html'), { quiet: true });
  const ran = await waitFor(() => bg.evaluate(`return window.counted`), { timeout: 8000 }).catch(() => 0);
  check('  and runs its handler there', ran === 1, String(ran));

  // Again: the running frame takes it.
  await app.clickMenu('확장', '명령 팔레트...');
  await waitFor(shown);
  await w.evaluate(`const i = document.getElementById('palette-input'); i.value = 'count'; i.dispatchEvent(new Event('input')); return 1`);
  await press(w, 'Enter');
  check('  a second run goes to the same frame', (await waitFor(async () => ((await bg.evaluate(`return window.counted`)) === 2 ? 2 : null), { timeout: 5000 }).catch(() => 0)) === 2);

  // A tab command: opens the tab and runs in it, with ctx.source.
  await app.clickMenu('확장', '명령 팔레트...');
  await waitFor(shown);
  await w.evaluate(`const i = document.getElementById('palette-input'); i.value = 'show'; i.dispatchEvent(new Event('input')); return 1`);
  await press(w, 'Enter');
  const view = await connect(app.port, (t) => t.url.startsWith('mdviewer-addon://bg/view.html'), { type: 'iframe', quiet: true }).catch(() => null);
  const got = view && (await waitFor(() => view.evaluate(`return window.shown && window.shown.length ? window.shown : null`), { timeout: 8000 }).catch(() => null));
  check('a tab command opens its tab and runs there', !!got && got.length === 1, JSON.stringify(got));
  check('  ctx says where it came from', got && got[0].source === 'palette', JSON.stringify(got && got[0]));
  const logged = await w.evaluate(`return (await window.mdviewer.addonLogEntries('bg')).map((e) => e.message)`);
  check('  in the extensions log', logged.some((m) => m === 'command bg.count (palette)') && logged.some((m) => m === 'command bg.show (palette)'), logged.join(' | '));
} finally {
  await app.stop();
  done();
}
