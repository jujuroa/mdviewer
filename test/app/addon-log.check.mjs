// The extensions log (F2, protocol 16): add-on frames' console, failed
// calls and lifecycle, on the log screen and in a file per add-on.
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { launch, checker, connect, sleep, openWindowWith, openAddonTab, waitFor } from './harness.mjs';

const { check, done } = checker();
const app = await launch({ files: { 'proj/a.md': '# A\n' } });
const rows = (w) => w.evaluate(`return [...document.querySelectorAll('#addons-log-list .addon-log-row')].map((r) => r.className.replace('addon-log-row', '').trim() + ' ' + r.textContent)`);
try {
  const w = await openWindowWith(app, 'a.md');
  const tab = await openAddonTab(app, w, 'Test: Probe');
  const probe = await connect(app.port, (t) => t.url === `mdviewer-addon://test/probe.html?tab=${tab.id}`, { type: 'iframe', quiet: true });
  await probe.evaluate(`console.log('hello from the probe'); console.warn('careful now'); console.error('it broke'); return 1`);
  await probe.evaluate(`try { await window.mdviewerAddon.call('nothing/here'); } catch (e) {} return 1`);
  await sleep(800);

  await app.clickMenu('확장', '확장 로그');
  await waitFor(() => w.evaluate(`return !document.getElementById('addons-log-overlay').classList.contains('hidden')`));
  let r = await rows(w);
  check('Extensions > Extensions Log opens, all add-ons', r.length > 0, `${r.length} rows`);
  check('a frame\'s console.log is there, with its add-on', r.some((x) => x.startsWith('log') && x.includes('test hello from the probe')), r.filter((x) => x.includes('hello')).join(' | '));
  check('  warn and error keep their level', r.some((x) => x.startsWith('warn') && x.includes('careful now')) && r.some((x) => x.startsWith('error') && x.includes('it broke')));
  check('a failed call is logged', r.some((x) => x.includes('nothing/here: NotSupported')));

  // Live: what happens while it is open shows up.
  await probe.evaluate(`console.log('while you watch'); return 1`);
  await sleep(800);
  check('new entries appear while the screen is open', (await rows(w)).some((x) => x.includes('while you watch')));

  // From the Extensions screen: one add-on's log.
  await w.evaluate(`document.getElementById('btn-close-addons-log').click(); return 1`);
  await app.clickMenu('확장', '확장 관리...');
  await waitFor(() => w.evaluate(`return !document.getElementById('addons-overlay').classList.contains('hidden')`));
  await w.evaluate(`document.querySelector('.addon-item[data-addon-id="other"] .addon-log-button').click(); return 1`);
  await sleep(800);
  const filter = await w.evaluate(`return document.getElementById('addons-log-filter').value`);
  r = await rows(w);
  check('the Log button opens that add-on\'s log only', filter === 'other' && !r.some((x) => x.includes('hello from the probe')), `${filter}: ${r.length} rows`);

  // In the file.
  const file = readFileSync(path.join(app.tmp, 'logs', 'test.log'), 'utf8');
  check('kept in logs/<id>.log', /LOG hello from the probe/.test(file) && /ERROR it broke/.test(file) && /WARN nothing\/here: NotSupported/.test(file), file.split('\n').slice(0, 6).join(' | '));
} finally {
  await app.stop();
  done();
}
