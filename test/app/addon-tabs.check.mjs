// Add-on tabs (F2): the tabs add-ons contribute — opened from Extensions,
// single or multiple instances, their strip entry, the strip's "+", closed
// when the add-on stops, brought back after a relaunch.
import { launch, checker, connect, sleep, openWindowWith, openAddonTab, targets, waitFor } from './harness.mjs';

const { check, done } = checker();
const strip = (w) =>
  w.evaluate(`return [...document.querySelectorAll('.doc-tab')].map(n => ({ id: +n.dataset.tabId, text: n.querySelector('.doc-tab-label').textContent, title: n.title, icon: n.querySelector('.doc-tab-icon').textContent.trim(), active: n.classList.contains('active') }))`);

// Without add-ons the strip has no "+" (as in 1.x).
{
  const app = await launch({ files: { 'proj/a.md': '# A\n' }, addonDev: [] });
  try {
    const w = await openWindowWith(app, 'a.md');
    check('no add-ons: no "+" in the tab strip', (await w.evaluate(`return !!document.querySelector('.doc-tab-new')`)) === false);
    const labels = await app.extensionLabels();
    // Add-ons' items read "Add-on: Title"; the app's own do not.
    check('no add-ons: Extensions has only its own items', labels.length > 0 && labels.every((l) => !l.includes(': ')), labels.join('|'));
  } finally {
    await app.stop();
  }
}

const app = await launch({ files: { 'proj/a.md': '# A\n' } });
try {
  const w = await openWindowWith(app, 'a.md');
  const labels = await app.extensionLabels();
  check('Extensions lists the add-ons\' tabs', ['Test: 창 열기', 'Other: 창 열기'].every((l) => labels.includes(l)), labels.join('|'));
  check('the tab strip has a "+"', (await w.evaluate(`return !!document.querySelector('.doc-tab-new')`)) === true);

  const a = await openAddonTab(app, w, 'Other: Probe');
  const b = await openAddonTab(app, w, 'Other: Probe');
  let s = await strip(w);
  check('single instance: opening again brings the same tab forward', a.id === b.id && s.filter((t) => t.text === 'Probe').length === 1, JSON.stringify(s));
  check('strip entry: the contribution\'s title, add-on name in the tooltip, add-on badge', s.find((t) => t.id === a.id).title === 'Other: Probe' && s.find((t) => t.id === a.id).icon === 'EXT', JSON.stringify(s.find((t) => t.id === a.id)));
  const p1 = await openAddonTab(app, w, 'Test: Probe');
  const p2 = await openAddonTab(app, w, 'Test: Probe');
  s = await strip(w);
  check('multiple instances: a new tab each time', p1.id !== p2.id && s.length === 4, JSON.stringify(s.map((t) => t.text)));
  const frames = (await targets(app.port)).filter((t) => t.type === 'iframe' && t.url.startsWith('mdviewer-addon://test/probe.html'));
  check('  each with its own page (tab id in the address)', frames.length === 2 && new Set(frames.map((f) => f.url)).size === 2, frames.map((f) => f.url).join(' '));

  // Turning the add-on off closes its tabs.
  await w.evaluate(`return await window.mdviewer.setAddonEnabled('test', false)`);
  await sleep(1000);
  s = await strip(w);
  check('turning an add-on off closes its tabs', s.length === 2 && !s.some((t) => t.id === p1.id || t.id === p2.id), JSON.stringify(s.map((t) => t.text)));
  const labelsOff = await app.extensionLabels();
  check('  and its tabs leave the menu', !labelsOff.includes('Test: 창 열기') && labelsOff.includes('Other: 창 열기'), labelsOff.join('|'));
  await w.evaluate(`return await window.mdviewer.setAddonEnabled('test', true)`);
  await sleep(500);

  // After a relaunch (the window page asks to restore its tabs).
  await w.evaluate(`await window.mdviewer.closeTab(${a.id}); return 1`);
  await sleep(500);
  await w.evaluate(`await window.mdviewer.restoreTabs([{ addon: 'other', tab: 'other.probe' }, { addon: 'gone', tab: 'gone.x' }], 0); return 1`);
  await sleep(2000);
  s = await strip(w);
  check('relaunch: the add-on tab comes back (one that no longer runs does not)', s.filter((t) => t.text === 'Probe').length === 1 && s.length === 2, JSON.stringify(s.map((t) => t.text)));
  const o = await connect(app.port, (t) => t.url.startsWith('mdviewer-addon://other/probe.html'), { type: 'iframe', quiet: true });
  const restore = await o.evaluate(`return window.mdviewerAddon.tabs.getRestoreState()`);
  check('  told it was restored', restore && restore.reason === 'restored', JSON.stringify(restore));

  // ready(): the test probe calls it, the other one doesn't (logged after 10 s).
  await sleep(10500);
  check('a page that calls ready() is not reported', !/test tab \d+ did not call ready/.test(app.logText()));
  check('one that does not is logged', /other tab \d+ did not call ready\(\) within 10 s/.test(app.logText()));

  // onWillClose runs before the tab goes (it reaches the test add-on's allowed host).
  const hits = [];
  const http = await import('node:http');
  const srv = http.createServer((req, res) => { hits.push(req.url); res.writeHead(200, { 'Access-Control-Allow-Origin': '*' }); res.end('ok'); }).listen(45678, '127.0.0.1');
  try {
    const t1 = await openAddonTab(app, w, 'Test: Probe');
    const f1 = await connect(app.port, (t) => t.url === `mdviewer-addon://test/probe.html?tab=${t1.id}`, { type: 'iframe', quiet: true });
    await f1.evaluate(`window.mdviewerAddon.lifecycle.onWillClose(async () => { await fetch('http://127.0.0.1:45678/closing'); }); return 1`);
    const t0 = Date.now();
    await w.evaluate(`return await window.mdviewer.closeTab(${t1.id})`);
    check('onWillClose runs before the tab closes', hits.includes('/closing'), JSON.stringify(hits));
    // A handler that never finishes holds closing for 3 s at most.
    const t2 = await openAddonTab(app, w, 'Test: Probe');
    const f2 = await connect(app.port, (t) => t.url === `mdviewer-addon://test/probe.html?tab=${t2.id}`, { type: 'iframe', quiet: true });
    await f2.evaluate(`window.mdviewerAddon.lifecycle.onWillClose(() => new Promise(() => {})); return 1`);
    const t3 = Date.now();
    const closed = await w.evaluate(`return await window.mdviewer.closeTab(${t2.id})`);
    const took = Date.now() - t3;
    check('  a handler that never ends cannot hold the tab (closes in ~3 s)', closed && closed.closed && took >= 2500 && took < 5000, `${took} ms`);
  } finally {
    srv.close();
  }

  // The page's process ends: the tab says so; Reload makes it anew.
  const t4 = await openAddonTab(app, w, 'Test: Probe');
  const f4 = await connect(app.port, (t) => t.url === `mdviewer-addon://test/probe.html?tab=${t4.id}`, { type: 'iframe', quiet: true });
  f4.send('Page.crash').catch(() => {});
  const trouble = await waitFor(() => w.evaluate(`const b = document.querySelector('.frame-trouble.active'); return b ? b.textContent : null`), { timeout: 8000 }).catch(() => null);
  check('add-on tab process ended: "this tab stopped"', !!trouble && trouble.includes('멈췄습니다'), String(trouble));
  const seen = new Set((await targets(app.port)).map((t) => t.id));
  await w.evaluate(`document.querySelector('.frame-trouble.active button').click(); return 1`);
  const f5 = await connect(app.port, (t) => t.url === `mdviewer-addon://test/probe.html?tab=${t4.id}` && !seen.has(t.id), { type: 'iframe', quiet: true });
  const reloaded = await waitFor(() => f5.evaluate(`return !!window.probeReady`), { timeout: 5000 }).catch(() => false);
  check('  Reload: the page again, the notice gone', reloaded && !(await w.evaluate(`return !!document.querySelector('.frame-trouble')`)));

  check('no IPC refused from app pages', !/\[ipc\] refused .* from file:/.test(app.logText()));
} finally {
  await app.stop();
  done();
}
