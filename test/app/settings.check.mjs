// Add-on settings, secrets and context (F3, protocol 12.5–12.6, 13.7–13.9).
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { launch, checker, connect, sleep, openWindowWith, openAddonTab, waitFor } from './harness.mjs';

const { check, done } = checker();
const app = await launch({ files: { 'proj/a.md': '# A\n' }, addonDev: ['test/addons/bg'] });
try {
  const w = await openWindowWith(app, 'a.md');
  const view = await openAddonTab(app, w, 'Background: View');
  const v = await connect(app.port, (t) => t.url === `mdviewer-addon://bg/view.html?tab=${view.id}`, { type: 'iframe', quiet: true });
  const api = (code) => v.evaluate(`const m = window.mdviewerAddon; try { return await (async () => { ${code} })(); } catch (e) { return 'ERR ' + e.name; }`);

  check('add-on reads its settings (defaults)', JSON.stringify(await api(`return await m.settings.get()`)) === JSON.stringify({ greeting: 'hi', count: 1, mode: 'a', on: true }));
  // settings.changed (experimental): the tab keeps what it hears.
  await api(`window.heard = []; m.events.on('settings.changed', (d) => window.heard.push(d)); return 1`);
  const heard = () => v.evaluate(`return JSON.stringify(window.heard)`);
  const refused = await v.evaluate(`try { window.mdviewerAddon.events.on('files.changed', () => {}); return 'ok'; } catch (e) { return JSON.stringify({ name: e.name, code: e.code, message: e.message, isError: e instanceof Error }); }`);
  check('an event that is not open is refused', refused.includes('NotSupported'), refused);

  // The Extensions screen's Settings.
  await app.clickMenu('확장', '확장 관리...');
  await waitFor(() => w.evaluate(`return !document.getElementById('addons-overlay').classList.contains('hidden')`));
  await w.evaluate(`document.querySelector('.addon-item[data-addon-id="bg"] .addon-settings-button').click(); return 1`);
  await waitFor(() => w.evaluate(`return !document.getElementById('addon-settings-overlay').classList.contains('hidden')`));
  const form = await w.evaluate(`return {
    title: document.getElementById('addon-settings-title').textContent,
    fields: [...document.querySelectorAll('#addon-settings-body .addon-setting[data-key]')].map((b) => { const i = b.querySelector('input, select'); return [b.dataset.key, i.type === 'checkbox' ? i.checked : i.value]; }),
    secret: document.querySelector('[data-secret="token"] .state').textContent }`);
  check('Settings shows the declared settings with their values', form.title === 'Background 설정' && JSON.stringify(form.fields) === JSON.stringify([['greeting', 'hi'], ['count', '1'], ['mode', 'a'], ['on', true]]), JSON.stringify(form));
  check('  and its secret as not set', form.secret === '없음', form.secret);

  const setField = (key, value) => w.evaluate(`const i = document.querySelector('.addon-setting[data-key="${key}"] input, .addon-setting[data-key="${key}"] select'); if (i.type === 'checkbox') i.checked = ${JSON.stringify(value)}; else i.value = ${JSON.stringify(value)}; i.dispatchEvent(new Event('change')); return 1`);
  await setField('greeting', 'hello');
  await sleep(300);
  check('settings.changed reaches the add-on as the screen changes it', (await heard()) === JSON.stringify([{ key: 'greeting', value: 'hello' }]), await heard());
  await setField('mode', 'b');
  await setField('on', false);
  await sleep(500);
  check('changes reach the add-on', JSON.stringify(await api(`return await m.settings.get()`)) === JSON.stringify({ greeting: 'hello', count: 1, mode: 'b', on: false }));
  await setField('count', '');
  await sleep(400);
  const err = await w.evaluate(`return document.querySelector('.addon-setting[data-key="count"] .error').textContent`);
  check('a value that does not fit is refused there', err.includes('올바르지 않습니다') && (await api(`return await m.settings.get({ key: 'count' })`)) === 1, err);
  check('kept in addon-settings.json', JSON.parse(readFileSync(path.join(app.tmp, 'userData', 'addon-settings.json'), 'utf8'))['bg.greeting'] === 'hello');
  check('the add-on can change a declared setting, not others', (await api(`await m.settings.update({ key: 'count', value: 7 }); return await m.settings.get({ key: 'count' })`)) === 7 && (await api(`return await m.settings.update({ key: 'nope', value: 1 })`)) === 'ERR NotFound');
  await sleep(300);
  check('  its own change is announced too, the refused one is not', JSON.parse(await heard()).slice(-1)[0].key === 'count' && JSON.parse(await heard()).filter((d) => d.key === 'count').length === 1, await heard());

  // Secrets.
  await w.evaluate(`const b = document.querySelector('[data-secret="token"]'); b.querySelector('input').value = 'tok-123'; b.querySelectorAll('button')[0].click(); return 1`);
  await sleep(500);
  check('saving a secret: shown as saved, value not shown', (await w.evaluate(`const b = document.querySelector('[data-secret="token"]'); return b.querySelector('.state').textContent + '|' + b.querySelector('input').value`)) === '저장됨|');
  check('  the add-on reads it', (await api(`return await m.secrets.get({ key: 'token' })`)) === 'tok-123');
  check('  not in the file as plain text', !readFileSync(path.join(app.tmp, 'userData', 'addon-secrets.json'), 'utf8').includes('tok-123'));
  await w.evaluate(`document.querySelector('[data-secret="token"]').querySelectorAll('button')[1].click(); return 1`);
  await sleep(400);
  check('clearing it', (await api(`return await m.secrets.get({ key: 'token' })`)) === null);
  await api(`await m.secrets.set({ key: 'token', value: 'from-addon' }); return 1`);
  check('the add-on can keep its own secret', (await api(`return await m.secrets.get({ key: 'token' })`)) === 'from-addon');
  await w.evaluate(`document.getElementById('btn-close-addon-settings').click(); return 1`);

  // settings/open (experimental): the add-on shows its own settings.
  check('settings/open from the add-on', (await api(`return await m.settings.open()`)) === null);
  await waitFor(() => w.evaluate(`return !document.getElementById('addon-settings-overlay').classList.contains('hidden')`));
  check('  shows its settings screen', (await w.evaluate(`return document.getElementById('addon-settings-title').textContent`)) === 'Background 설정');
  await w.evaluate(`document.getElementById('btn-close-addon-settings').click(); return 1`);

  // context/set feeds when: an item shown only while bg.ready.
  const labels = () => app.main(`return electron.Menu.getApplicationMenu().items.find((i) => i.label === '확장').submenu.items.filter((i) => i.visible).map((i) => i.label)`);
  check('before context/set the item is hidden (when bg.ready)', !(await labels()).includes('Background: Show in View'));
  await api(`await m.context.set({ key: 'ready', value: true }); return 1`);
  await sleep(500);
  check('after it, the item shows', (await labels()).includes('Background: Show in View'), (await labels()).join('|'));
  await api(`await m.context.set({ key: 'ready', value: null }); return 1`);
  await sleep(500);
  check('  and hides again', !(await labels()).includes('Background: Show in View'));
} finally {
  await app.stop();
  done();
}
