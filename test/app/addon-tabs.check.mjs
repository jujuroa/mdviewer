// Add-on tabs (F2): the tabs add-ons contribute — opened from Extensions,
// single or multiple instances, their strip entry, the strip's "+", closed
// when the add-on stops, brought back after a relaunch.
import { launch, checker, connect, sleep, openWindowWith, openAddonTab, targets } from './harness.mjs';

const { check, done } = checker();
const strip = (w) =>
  w.evaluate(`return [...document.querySelectorAll('.doc-tab')].map(n => ({ id: +n.dataset.tabId, text: n.querySelector('.doc-tab-label').textContent, title: n.title, icon: n.querySelector('.doc-tab-icon').textContent.trim(), active: n.classList.contains('active') }))`);

// Without add-ons the strip has no "+" (as in 1.x).
{
  const app = await launch({ files: { 'proj/a.md': '# A\n' }, addonDev: [] });
  try {
    const w = await openWindowWith(app, 'a.md');
    check('no add-ons: no "+" in the tab strip', (await w.evaluate(`return !!document.querySelector('.doc-tab-new')`)) === false);
    const labels = await app.main(`return electron.Menu.getApplicationMenu().items.find((i) => i.label === '확장').submenu.items.map((i) => i.label)`);
    check('no add-ons: Extensions has only its own items', labels.join('|') === '확장 관리...|add-on 다시 찾기', labels.join('|'));
  } finally {
    await app.stop();
  }
}

const app = await launch({ files: { 'proj/a.md': '# A\n' } });
try {
  const w = await openWindowWith(app, 'a.md');
  const labels = await app.main(`return electron.Menu.getApplicationMenu().items.find((i) => i.label === '확장').submenu.items.map((i) => i.label)`);
  check('Extensions lists the add-ons\' tabs', ['Test: Probe', 'Other: Probe'].every((l) => labels.includes(l)), labels.join('|'));
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
  const labelsOff = await app.main(`return electron.Menu.getApplicationMenu().items.find((i) => i.label === '확장').submenu.items.map((i) => i.label)`);
  check('  and its tabs leave the menu', !labelsOff.includes('Test: Probe') && labelsOff.includes('Other: Probe'), labelsOff.join('|'));
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
  check('no IPC refused from app pages', !/\[ipc\] refused .* from file:/.test(app.logText()));
} finally {
  await app.stop();
  done();
}
