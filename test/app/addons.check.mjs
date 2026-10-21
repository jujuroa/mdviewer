// Finding add-ons and the Extensions screen (F1): the install folder holds
// one add-on of each kind of trouble; the screen lists them with why, turns
// them on and off, and looks again.
import path from 'node:path';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { launch, checker, sleep, openWindowWith, waitFor } from './harness.mjs';

const { check, done } = checker();
const manifest = (id, over = {}) =>
  JSON.stringify({
    manifestVersion: 1,
    id,
    name: `%name%`,
    version: '1.2.3',
    engines: { mdviewer: '>=2.0.0 <3.0.0', api: 1 },
    contributes: { tabs: [{ id: `${id}.main`, title: 'Main', entry: 'main.html' }] },
    ...over,
  });
const app = await launch({
  files: {
    'proj/a.md': '# A\n',
    'addons/good/manifest.json': manifest('good'),
    'addons/good/locales/ko.json': JSON.stringify({ name: '좋은 add-on' }),
    'addons/good/main.html': '<!doctype html><p>good</p>',
    'addons/broken/manifest.json': '{ not json',
    'addons/mismatch/manifest.json': manifest('something-else'),
    'addons/future/manifest.json': manifest('future', { engines: { mdviewer: '>=3.0.0', api: 1 } }),
    'addons/idle/manifest.json': manifest('idle', { contributes: {} }),
    'addons/netty/manifest.json': manifest('netty', { network: { hosts: ['api.example.com'] } }),
    'addons/test/manifest.json': manifest('test'),
    'policy.json': JSON.stringify({ 'addons.blockNetwork': true }),
  },
  env: { MDVIEWER_POLICY_FILE: '{tmp}/policy.json' },
});
try {
  const w = await openWindowWith(app, 'a.md');
  check('found add-ons logged at startup', /\[addons\] good \(installed\) ok/.test(app.logText()) && /\[addons\] test \(dev\) ok/.test(app.logText()));

  await app.clickMenu('확장', '확장 관리...');
  await waitFor(() => w.evaluate(`return !document.getElementById('addons-overlay').classList.contains('hidden')`));
  const rows = () =>
    w.evaluate(`return Object.fromEntries([...document.querySelectorAll('.addon-item')].map((n) => [
      n.dataset.addonId + '|' + n.dataset.source,
      { name: n.querySelector('.addon-name').textContent, status: n.querySelector('.addon-status').textContent, text: n.textContent, toggle: !!n.querySelector('input[type=checkbox]'), checked: !!n.querySelector('input[type=checkbox]')?.checked },
    ]))`);
  const r = await rows();
  const st = (key) => r[key] && r[key].status;
  check('Extensions > Manage opens the list', Object.keys(r).length === 9, Object.keys(r).join(', '));
  check('dev add-ons ready', st('test|dev') === '사용 가능' && st('other|dev') === '사용 가능');
  check('installed good one ready, name from its locales', st('good|installed') === '사용 가능' && r['good|installed'].name === '좋은 add-on', JSON.stringify(r['good|installed']));
  check('broken JSON', st('broken|installed') === 'manifest 오류' && r['broken|installed'].text.includes('JSON 형식이 아닙니다'));
  check('folder name mismatch, with the field', st('mismatch|installed') === 'manifest 오류' && /id: 폴더 이름과 다릅니다/.test(r['mismatch|installed'].text), r['mismatch|installed'].text);
  check('needs another app version', st('future|installed') === '호환되지 않음' && r['future|installed'].text.includes('다른 앱 버전이 필요합니다'));
  check('nothing to run', st('idle|installed') === 'manifest 오류' && r['idle|installed'].text.includes('백그라운드 프레임도 탭도 없습니다'));
  check('blocked by policy (network)', st('netty|installed') === '정책으로 차단' && r['netty|installed'].text.includes('api.example.com'));
  check('same id installed: hidden by the dev copy, no toggle', st('test|installed') === '가려짐' && !r['test|installed'].toggle);
  check('ready ones show when they start', r['good|installed'].text.includes('onTab:good.main'));

  // Pages are served only for add-ons that run.
  const fetchPage = (url) => app.main(`
    const { net } = electron;
    try { const res = await net.fetch(${JSON.stringify(url)}); return res.status; } catch (e) { return 'error ' + e.message; }`);
  check('a ready add-on serves its pages', (await fetchPage('mdviewer-addon://good/main.html')) === 200);
  check('a blocked one does not', (await fetchPage('mdviewer-addon://netty/main.html')) === 404);

  // Turn one off: kept in addons-state.json, its pages stop.
  await w.evaluate(`document.querySelector('.addon-item[data-addon-id="good"] input[type=checkbox]').click(); return 1`);
  await sleep(800);
  const off = (await rows())['good|installed'];
  check('turned off: shown off', off.status === '꺼짐' && !off.checked, JSON.stringify(off));
  const saved = JSON.parse(readFileSync(path.join(app.tmp, 'userData', 'addons-state.json'), 'utf8'));
  check('  kept in addons-state.json', saved.disabled.includes('good'), JSON.stringify(saved));
  check('  its pages are no longer served', (await fetchPage('mdviewer-addon://good/main.html')) === 404);
  await w.evaluate(`document.querySelector('.addon-item[data-addon-id="good"] input[type=checkbox]').click(); return 1`);
  await sleep(800);
  check('turned on again', (await rows())['good|installed'].status === '사용 가능' && (await fetchPage('mdviewer-addon://good/main.html')) === 200);

  // A new add-on appears on Look Again; a fixed one turns ready.
  mkdirSync(path.join(app.tmp, 'addons', 'fresh'), { recursive: true });
  writeFileSync(path.join(app.tmp, 'addons', 'fresh', 'manifest.json'), manifest('fresh'));
  writeFileSync(path.join(app.tmp, 'addons', 'broken', 'manifest.json'), manifest('broken'));
  await w.evaluate(`document.getElementById('btn-addons-rescan').click(); return 1`);
  await sleep(800);
  const r2 = await rows();
  check('Look Again finds a new add-on', r2['fresh|installed'] && r2['fresh|installed'].status === '사용 가능');
  check('  and a fixed manifest', r2['broken|installed'].status === '사용 가능');
  // Policy file lifted, then Extensions > Look for Add-ons Again.
  writeFileSync(path.join(app.tmp, 'policy.json'), '{}');
  await app.clickMenu('확장', 'add-on 다시 찾기');
  await sleep(800);
  check('the menu item looks again too (policy change applies)', (await rows())['netty|installed'].status === '사용 가능');

  if (process.env.SHOT) {
    const shot = await w.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(process.env.SHOT, Buffer.from(shot.result.data, 'base64'));
  }
  await w.evaluate(`document.getElementById('btn-close-addons').click(); return 1`);
  check('closes', await w.evaluate(`return document.getElementById('addons-overlay').classList.contains('hidden')`));
} finally {
  await app.stop();
  done();
}
