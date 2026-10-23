// Background frames (F2, protocol 7.1·7.3·7.4): the bg test add-on's hidden
// page — started by activation events, stopped when idle, restarted after
// a crash, given up on after too many, stopped when turned off, gone with
// the last program window.
import { launch, checker, connect, sleep, openWindowWith, openAddonTab, targets, waitFor } from './harness.mjs';

const { check, done } = checker();
const app = await launch({
  files: { 'proj/a.md': '# A\n', 'proj/.bg-trigger': '' },
  addonDev: ['test/addons/bg', 'test/addons/test'],
});
const bgTarget = async () => (await targets(app.port)).find((t) => t.type === 'page' && t.url.startsWith('mdviewer-addon://bg/background.html')) || null;
const bgState = (w) => w.evaluate(`return (await window.mdviewer.listAddons()).find((a) => a.id === 'bg').background`);
try {
  const w = await openWindowWith(app, 'a.md');

  // onProjectContains:.bg-trigger
  await waitFor(bgTarget, { timeout: 8000 });
  check('a project holding .bg-trigger starts the background frame (hidden window)', !!(await bgTarget()));
  check('  logged with why', /\[addons\] bg background starting \(onProjectContains\)/.test(app.logText()));
  let bg = await connect(app.port, (t) => t.url.startsWith('mdviewer-addon://bg/background.html'), { quiet: true });
  await waitFor(() => bg.evaluate(`return !!window.info`));
  const info = await bg.evaluate(`return { info: window.info, app: typeof window.mdviewer }`);
  check('  its bridge: kind background, no tab, no app bridge', info.info.kind === 'background' && info.info.tab === null && info.app === 'undefined', JSON.stringify(info));
  check('  shown running on the Extensions screen', (await waitFor(async () => ((await bgState(w)) === 'running' ? 'running' : null), { timeout: 3000 }).catch(() => null)) === 'running');
  const visible = await app.main(`return electron.BrowserWindow.getAllWindows().filter((x) => x.isVisible()).length`);
  check('  its window stays hidden', visible === 1, String(visible));

  // Idle (idleTimeoutSec 3): stops.
  const gone = await waitFor(async () => !(await bgTarget()), { timeout: 8000 }).catch(() => false);
  check('idle 3 s with nothing open: stopped', gone && /bg background stopping \(idle\)/.test(app.logText()));
  check('  state cleared', (await bgState(w)) === null);

  // onTab:bg.view starts it; an open tab keeps it.
  const tab = await openAddonTab(app, w, 'Background: View');
  await waitFor(bgTarget, { timeout: 8000 });
  check('opening its tab starts it (onTab)', /bg background starting \(onTab:bg\.view\)/.test(app.logText()));
  await sleep(5000);
  check('  not idle while its tab is open', !!(await bgTarget()) && (await bgState(w)) === 'running');
  {
    const v = await connect(app.port, (t) => t.url.startsWith('mdviewer-addon://bg/view.html'), { type: 'iframe', quiet: true });
    const b = await connect(app.port, (t) => t.url.startsWith('mdviewer-addon://bg/background.html'), { quiet: true });
    await v.evaluate(`localStorage.setItem('shared', 'from tab'); return 1`);
    check('tab and background frame share web storage (protocol 4.4)', (await b.evaluate(`return localStorage.getItem('shared')`)) === 'from tab');
  }

  // A crash: restarted.
  bg = await connect(app.port, (t) => t.url.startsWith('mdviewer-addon://bg/background.html'), { quiet: true });
  const first = bg.target.id;
  bg.send('Page.crash').catch(() => {});
  const restarted = await waitFor(async () => {
    const t = await bgTarget();
    return t && t.id !== first ? t : null;
  }, { timeout: 8000 }).catch(() => null);
  check('a crashed background frame is restarted', !!restarted && /bg background stopped: crashed/.test(app.logText()));
  await waitFor(async () => ((await bgState(w)) === 'running' ? true : null), { timeout: 5000 }).catch(() => null);

  // Turned off: stopped (and its tab closed).
  await w.evaluate(`return await window.mdviewer.setAddonEnabled('bg', false)`);
  const off = await waitFor(async () => !(await bgTarget()), { timeout: 6000 }).catch(() => false);
  check('turning the add-on off stops it', off && /bg background stopping \(turned off\)/.test(app.logText()));
  await w.evaluate(`return await window.mdviewer.setAddonEnabled('bg', true)`);
  await sleep(1500);

  // ready() never comes: stopped after 10 s, restarted; past 3 restarts in
  // 5 minutes it stays off. (Its tab tells it to skip ready: shared storage.)
  await openAddonTab(app, w, 'Background: View');
  const view = await connect(app.port, (t) => t.url.startsWith('mdviewer-addon://bg/view.html'), { type: 'iframe', quiet: true });
  await view.evaluate(`localStorage.setItem('skipReady', '1'); return 1`);
  await waitFor(bgTarget, { timeout: 8000 });
  bg = await connect(app.port, (t) => t.url.startsWith('mdviewer-addon://bg/background.html'), { quiet: true });
  bg.send('Page.crash').catch(() => {});
  const failed = await waitFor(async () => ((await bgState(w)) === 'failed' ? true : null), { timeout: 60000, step: 1000 }).catch(() => null);
  check('no ready() within 10 s: stopped and restarted', /bg background stopped: did not call ready\(\) within 10 s/.test(app.logText()));
  check('  after 3 restarts in 5 minutes: off for this session', failed === true && /restarted 3 times in 5 minutes/.test(app.logText()));
  check('  and no window left', !(await bgTarget()));

} finally {
  if (process.env.DBG) console.log(app.logText().split(/\r?\n/).filter((l) => /\[addons\] bg|refused/.test(l)).join('\n'));
  await app.stop();
}

// The last program window closes while a background frame runs: the app
// quits (its hidden window must not keep it alive). A fresh instance with
// only the window page connected: the app ending under other DevTools
// connections can stall Node.
{
  const quitter = await launch({ files: { 'proj/a.md': '# A\n', 'proj/.bg-trigger': '' }, addonDev: ['test/addons/bg'] });
  try {
    const w = await openWindowWith(quitter, 'a.md');
    const up = await waitFor(async () => (await targets(quitter.port)).find((t) => t.url.startsWith('mdviewer-addon://bg/background.html')), { timeout: 8000 }).catch(() => null);
    const exited = new Promise((resolve) => quitter.child.once('exit', () => resolve(true)));
    await quitter.closeSessions(w);
    w.send('Page.close').catch(() => {});
    const quit = await Promise.race([exited, sleep(10000).then(() => false)]);
    check('closing the last window quits the app even with a background frame running', !!up && quit === true);
  } finally {
    await quitter.stop();
  }
}
done();
