// tabs/* (F4, protocol 13.6): an add-on opens, closes and brings forward its
// own tabs; a tab page sets its title, icon and unsaved mark and keeps a
// state that comes back after a relaunch.
import { launch, checker, connect, sleep, openWindowWith, openAddonTab, waitFor } from './harness.mjs';

const { check, done } = checker();
const app = await launch({ files: { 'proj/a.md': '# A\n' } });
const strip = (w) =>
  w.evaluate(`return [...document.querySelectorAll('.doc-tab')].map(n => ({ id: +n.dataset.tabId, text: n.querySelector('.doc-tab-label').textContent, active: n.classList.contains('active'), dirty: n.classList.contains('dirty'), img: (n.querySelector('.doc-tab-icon img') || {}).src || null }))`);
const probe = (id) => connect(app.port, (t) => t.url === `mdviewer-addon://test/probe.html?tab=${id}`, { type: 'iframe', quiet: true });
// Runs an API call in a page; 'ERR name' when it fails.
const api = (page, expr) => page.evaluate(`try { const v = await window.mdviewerAddon.${expr}; return v === undefined ? 'undefined' : v; } catch (e) { return 'ERR ' + e.name; }`);
try {
  const w = await openWindowWith(app, 'a.md');
  const docTab = await w.evaluate(`return +document.querySelector('.doc-tab.active').dataset.tabId`);
  const first = await openAddonTab(app, w, 'Test: Probe');
  const p1 = await probe(first.id);
  await waitFor(() => p1.evaluate(`return !!window.probeReady`));

  // open
  const opened = await api(p1, `tabs.open({ tabId: 'test.probe', args: { q: 'term' } })`);
  check('open: a new instance (multiple), its id back', opened && Number.isInteger(opened.instanceId) && opened.instanceId !== first.id, JSON.stringify(opened));
  await sleep(800);
  let s = await strip(w);
  check('  shown, in front', s.find((t) => t.id === opened.instanceId)?.active === true, JSON.stringify(s));
  const p2 = await probe(opened.instanceId);
  await waitFor(() => p2.evaluate(`return !!window.probeReady`));
  check('  its page gets the args', JSON.stringify(await api(p2, `tabs.getArgs()`)) === '{"q":"term"}');
  check('  and reason "new"', (await api(p2, `tabs.getRestoreState()`)).reason === 'new');
  const quiet = await api(p1, `tabs.open({ tabId: 'test.probe', reveal: false })`);
  await sleep(800);
  s = await strip(w);
  check('open with reveal: false stays behind', s.find((t) => t.id === quiet.instanceId)?.active === false && s.find((t) => t.id === opened.instanceId)?.active === true, JSON.stringify(s));
  check('another add-on\'s tab: NotFound', (await api(p1, `tabs.open({ tabId: 'other.probe' })`)) === 'ERR NotFound');

  // update
  await api(p2, `tabs.update({ title: 'Found 3', dirty: true, icon: 'probe.css' })`);
  await sleep(300);
  s = await strip(w);
  const me = s.find((t) => t.id === opened.instanceId);
  check('update: title and unsaved mark in the strip', me.text === 'Found 3' && me.dirty, JSON.stringify(me));
  check('  icon from the add-on folder', me.img === 'mdviewer-addon://test/probe.css', me.img);
  check('  a path out of the folder: InvalidParams', (await api(p2, `tabs.update({ icon: '../x.png' })`)) === 'ERR InvalidParams');

  // Closing a tab marked unsaved asks.
  const closing = w.evaluate(`return await window.mdviewer.closeTab(${opened.instanceId})`);
  const asked = await waitFor(() => w.evaluate(`const o = document.getElementById('addon-ui-overlay'); return o ? o.innerText : null`), { timeout: 6000 }).catch(() => null);
  check('closing it while unsaved: the user is asked', !!asked && asked.includes('Found 3'), asked);
  await w.evaluate(`document.getElementById('btn-ui-cancel').click(); return 1`);
  check("  kept on Cancel", (await closing).closed === false && (await strip(w)).some((t) => t.id === opened.instanceId));

  // state, kept for a relaunch
  check('getState before any: null', (await api(p2, `tabs.getState()`)) === null);
  await api(p2, `tabs.setState({ state: { n: 5 } })`);
  check('setState / getState', JSON.stringify(await api(p2, `tabs.getState()`)) === '{"n":5}');
  check('  over 64 KiB: TooLarge', (await api(p2, `tabs.setState({ state: 'x'.repeat(70000) })`)) === 'ERR TooLarge');
  check('  each tab has its own', (await api(p1, `tabs.getState()`)) === null);

  // reveal
  await w.evaluate(`await window.mdviewer.activateTab(${docTab}); return 1`);
  await api(p1, `tabs.reveal({ tabId: 'test.probe', instanceId: ${quiet.instanceId} })`);
  await sleep(300);
  check('reveal: that tab in front', (await strip(w)).find((t) => t.id === quiet.instanceId)?.active === true);

  // close
  await api(p1, `tabs.close({ tabId: 'test.probe', instanceId: ${quiet.instanceId} })`);
  await sleep(500);
  check('close: that instance goes', !(await strip(w)).some((t) => t.id === quiet.instanceId));
  check('  one not open: NotFound', (await api(p1, `tabs.close({ tabId: 'test.probe', instanceId: ${quiet.instanceId} })`)) === 'ERR NotFound');
  const closeAsked = api(p1, `tabs.close({ tabId: 'test.probe', instanceId: ${opened.instanceId} })`);
  await waitFor(() => w.evaluate(`return !!document.getElementById('addon-ui-overlay')`), { timeout: 6000 });
  await w.evaluate(`document.getElementById('btn-ui-ok').click(); return 1`);
  await closeAsked;
  await sleep(500);
  check('  an unsaved one asks too, and goes on OK', !(await strip(w)).some((t) => t.id === opened.instanceId));

  // Moved to a tab window: what it set stays.
  await api(p1, `tabs.update({ title: 'Moved me' })`);
  await w.evaluate(`window.__tw = []; const o = window.open; window.open = function (...a) { const r = o.apply(this, a); if (r) window.__tw.push(r); return r; }; return 1`);
  await w.evaluate(`await window.mdviewer.detachTab(${first.id}); return 1`);
  await sleep(2500);
  const p1b = await connect(app.port, (t) => t.url === `mdviewer-addon://test/probe.html?tab=${first.id}` && t.id !== p1.target.id, { type: 'iframe', quiet: true });
  await waitFor(() => p1b.evaluate(`return !!window.probeReady`));
  check('moved: reason "moved"', (await api(p1b, `tabs.getRestoreState()`)).reason === 'moved');
  const title = await w.evaluate(`const d = window.__tw[0].document; return d.querySelector('.doc-tab-label').textContent`).catch(() => null);
  check('  the title it set stays', title === 'Moved me', title);

  // After a relaunch: args and state come back.
  await w.evaluate(`await window.mdviewer.restoreTabs([{ addon: 'test', tab: 'test.probe', args: { q: 1 }, state: { n: 7 } }], 0); return 1`);
  await sleep(2000);
  const restored = (await strip(w)).find((t) => t.text === 'Probe' && t.active);
  const p3 = restored && (await probe(restored.id));
  if (p3) await waitFor(() => p3.evaluate(`return !!window.probeReady`));
  const rs = p3 && (await api(p3, `tabs.getRestoreState()`));
  check('relaunch: reason "restored" with the state it kept', rs && rs.reason === 'restored' && JSON.stringify(rs.state) === '{"n":7}', JSON.stringify(rs));
  check('  getState and getArgs as before', p3 && JSON.stringify(await api(p3, `tabs.getState()`)) === '{"n":7}' && JSON.stringify(await api(p3, `tabs.getArgs()`)) === '{"q":1}');
} finally {
  await app.stop();
  done();
}
