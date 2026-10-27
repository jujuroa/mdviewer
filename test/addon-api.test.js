const test = require('node:test');
const assert = require('node:assert/strict');
const { ApiRouter, ApiError } = require('../addons/api-router.js');
const { registerAppApi } = require('../addons/api/app.js');

const caller = (permissions = [], experimentalApi = []) => ({ addonId: 'a', entry: { manifest: { permissions } }, experimentalApi });

test('ApiRouter: results, unknown methods, bad parameters', async () => {
  const r = new ApiRouter();
  r.register('x/echo', { handler: (c, p) => p });
  r.register('x/nothing', { handler: () => undefined });
  assert.deepEqual(await r.call(caller(), 'x/echo', { a: 1 }), { ok: true, result: { a: 1 } });
  assert.deepEqual(await r.call(caller(), 'x/echo'), { ok: true, result: {} });
  assert.deepEqual(await r.call(caller(), 'x/nothing', {}), { ok: true, result: null });
  assert.deepEqual((await r.call(caller(), 'x/missing', {})).error.name, 'NotSupported');
  assert.equal((await r.call(caller(), 'x/missing', {})).error.code, -32006);
  assert.equal((await r.call(caller(), 'x/echo', [1])).error.name, 'InvalidParams');
  assert.equal((await r.call(caller(), 'x/echo', 'str')).error.name, 'InvalidParams');
  assert.equal((await r.call(caller(), 42, {})).error.name, 'NotSupported');
});

test('ApiRouter: permissions and experimental APIs', async () => {
  const r = new ApiRouter();
  r.register('documents/read', { permission: 'documents.read', handler: () => 'text' });
  r.register('tree/view', { experimental: 'tree.view', handler: () => 'tree' });
  const denied = await r.call(caller(), 'documents/read', {});
  assert.equal(denied.error.name, 'PermissionDenied');
  assert.equal(denied.error.code, -32001);
  assert.deepEqual(await r.call(caller(['documents.read']), 'documents/read', {}), { ok: true, result: 'text' });
  assert.equal((await r.call(caller(), 'tree/view', {})).error.name, 'NotSupported');
  assert.deepEqual(await r.call(caller([], ['tree.view']), 'tree/view', {}), { ok: true, result: 'tree' });
  assert.deepEqual(r.methodsFor(caller()), ['documents/read']);
  assert.deepEqual(r.methodsFor(caller([], ['tree.view'])), ['documents/read', 'tree/view']);
});

test('ApiRouter: protocol errors keep code and data; anything else is an internal error', async () => {
  const r = new ApiRouter();
  r.register('x/conflict', { handler: () => { throw new ApiError('Conflict', 'changed', { currentVersion: 'abc' }); } });
  r.register('x/boom', { handler: () => { throw new Error('secret internals'); } });
  assert.deepEqual((await r.call(caller(), 'x/conflict', {})).error, { code: -32003, name: 'Conflict', message: 'changed', data: { currentVersion: 'abc' } });
  const boom = (await r.call(caller(), 'x/boom', {})).error;
  assert.equal(boom.name, 'InternalError');
  assert.doesNotMatch(boom.message, /secret/);
});

test('app area: openExternal only https/mailto, asks first; copyToClipboard', async () => {
  const opened = [];
  const copied = [];
  let agree = true;
  const r = new ApiRouter();
  registerAppApi(r, {
    openExternal: (url) => opened.push(url),
    writeClipboard: (text) => copied.push(text),
    confirmOpen: async () => agree,
  });
  assert.deepEqual(await r.call(caller(), 'app/openExternal', { url: 'https://example.com/a' }), { ok: true, result: null });
  assert.equal((await r.call(caller(), 'app/openExternal', { url: 'file:///C:/Windows' })).error.name, 'PermissionDenied');
  assert.equal((await r.call(caller(), 'app/openExternal', { url: 'not a url' })).error.name, 'InvalidParams');
  agree = false;
  assert.equal((await r.call(caller(), 'app/openExternal', { url: 'mailto:a@b.c' })).error.name, 'UserCanceled');
  assert.deepEqual(opened, ['https://example.com/a']);
  assert.deepEqual(await r.call(caller(), 'app/copyToClipboard', { text: '한글' }), { ok: true, result: null });
  assert.equal((await r.call(caller(), 'app/copyToClipboard', { text: 5 })).error.name, 'InvalidParams');
  assert.equal((await r.call(caller(), 'app/copyToClipboard', { text: 'x'.repeat(1024 * 1024 + 1) })).error.name, 'TooLarge');
  assert.deepEqual(copied, ['한글']);
});

test('settings, secrets and context areas', async () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const { AddonSettings, AddonSecrets } = require('../addons/settings.js');
  const { registerSettingsApi } = require('../addons/api/settings.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mdv-set-'));
  try {
    const entry = { id: 'a', manifest: { contributes: { settings: [
      { key: 'greeting', type: 'string', default: 'hi' },
      { key: 'count', type: 'number', default: 1 },
      { key: 'on', type: 'boolean' },
      { key: 'mode', type: 'enum', enum: ['x', 'y'], default: 'x' },
    ] } } };
    let available = true;
    const crypto = { available: () => available, encrypt: (t) => Buffer.from(`enc:${t}`), decrypt: (b) => b.toString().slice(4) };
    const settings = new AddonSettings(path.join(dir, 'addon-settings.json'));
    const secrets = new AddonSecrets(path.join(dir, 'addon-secrets.json'), crypto);
    const context = [];
    const changed = [];
    const opened = [];
    const r = new ApiRouter();
    registerSettingsApi(r, {
      settings,
      secrets,
      setContext: (...a) => context.push(a),
      changed: (e, key) => changed.push(`${e.id}.${key}`),
      openForm: (c) => opened.push(c.addonId),
    });
    const me = { addonId: 'a', entry };
    assert.deepEqual((await r.call(me, 'settings/get', {})).result, { greeting: 'hi', count: 1, on: null, mode: 'x' });
    assert.equal((await r.call(me, 'settings/update', { key: 'count', value: 5 })).ok, true);
    assert.equal((await r.call(me, 'settings/get', { key: 'count' })).result, 5);
    assert.equal((await r.call(me, 'settings/update', { key: 'count', value: 5 })).ok, true);
    assert.deepEqual(changed, ['a.count'], 'only a new value is announced');
    assert.equal((await r.call(me, 'settings/update', { key: 'count', value: 'five' })).error.name, 'InvalidParams');
    assert.equal((await r.call(me, 'settings/update', { key: 'mode', value: 'z' })).error.name, 'InvalidParams');
    assert.equal((await r.call(me, 'settings/update', { key: 'nope', value: 1 })).error.name, 'NotFound');
    assert.equal((await r.call(me, 'settings/get', { key: 'nope' })).error.name, 'NotFound');
    assert.equal(new AddonSettings(path.join(dir, 'addon-settings.json')).get(entry, 'count'), 5);
    assert.deepEqual(changed, ['a.count'], 'refused values are not announced');

    // settings/open: experimental, and only with something to show.
    assert.equal((await r.call(me, 'settings/open', {})).error.name, 'NotSupported');
    assert.deepEqual(await r.call({ ...me, experimentalApi: ['settings.open'] }, 'settings/open', {}), { ok: true, result: null });
    assert.deepEqual(opened, ['a']);
    const bare = { addonId: 'c', entry: { id: 'c', manifest: {} }, experimentalApi: ['settings.open'] };
    assert.equal((await r.call(bare, 'settings/open', {})).error.name, 'NotFound');

    assert.equal((await r.call(me, 'secrets/get', { key: 'token' })).result, null);
    assert.equal((await r.call(me, 'secrets/set', { key: 'token', value: 's3cret' })).ok, true);
    assert.equal((await r.call(me, 'secrets/get', { key: 'token' })).result, 's3cret');
    assert.doesNotMatch(fs.readFileSync(path.join(dir, 'addon-secrets.json'), 'utf8'), /s3cret/);
    assert.equal((await r.call({ addonId: 'b', entry }, 'secrets/get', { key: 'token' })).result, null);
    assert.equal((await r.call(me, 'secrets/delete', { key: 'token' })).ok, true);
    assert.equal((await r.call(me, 'secrets/get', { key: 'token' })).result, null);
    available = false;
    assert.equal((await r.call(me, 'secrets/set', { key: 'token', value: 'x' })).error.name, 'NotSupported');
    assert.equal((await r.call(me, 'secrets/set', { key: '../x', value: 'x' })).error.name, 'InvalidParams');

    assert.equal((await r.call(me, 'context/set', { key: 'dirty', value: true })).ok, true);
    assert.deepEqual(context, [['a', 'dirty', true]]);
    assert.equal((await r.call(me, 'context/set', { key: 'x', value: { a: 1 } })).error.name, 'InvalidParams');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('ui area: answers checked against what was offered; progress tokens are the caller\'s', async () => {
  const { registerUiApi } = require('../addons/api/ui.js');
  const asked = [];
  let answer = null;
  const shown = [];
  const r = new ApiRouter();
  const ui = registerUiApi(r, { ask: async (c, req) => (asked.push(req), answer), progress: (c, m) => shown.push(m) });
  const me = { addonId: 'a', entry: { manifest: {} } };
  answer = { value: 'Retry' };
  assert.equal((await r.call(me, 'ui/notify', { message: 'hi', actions: ['Retry'] })).result, 'Retry');
  answer = { value: 'Other' };
  assert.equal((await r.call(me, 'ui/notify', { message: 'hi', actions: ['Retry'] })).result, null);
  assert.equal((await r.call(me, 'ui/notify', { level: 'loud', message: 'x' })).error.name, 'InvalidParams');
  answer = { value: 'b' };
  assert.equal((await r.call(me, 'ui/quickPick', { items: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] })).result, 'b');
  answer = { value: ['b', 'zzz'] };
  assert.deepEqual((await r.call(me, 'ui/quickPick', { multi: true, items: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] })).result, ['b']);
  answer = { cancelled: true };
  assert.equal((await r.call(me, 'ui/quickPick', { items: [{ id: 'a', label: 'A' }] })).error.name, 'UserCanceled');
  assert.equal((await r.call(me, 'ui/input', {})).error.name, 'UserCanceled');
  answer = { value: 'typed' };
  assert.equal((await r.call(me, 'ui/input', { password: true })).result, 'typed');
  assert.equal(asked[asked.length - 1].password, true);
  answer = { value: true };
  assert.equal((await r.call(me, 'ui/confirm', { message: 'sure?' })).result, true);
  answer = null;
  assert.equal((await r.call(me, 'ui/confirm', { message: 'sure?' })).result, false);
  const { token } = (await r.call(me, 'ui/progress/start', { title: 'Work', cancellable: true })).result;
  assert.deepEqual((await r.call(me, 'ui/progress/report', { token, percent: 50 })).result, { cancelled: false });
  ui.cancelProgress(token);
  assert.deepEqual((await r.call(me, 'ui/progress/report', { token })).result, { cancelled: true });
  assert.equal((await r.call({ addonId: 'b', entry: { manifest: {} } }, 'ui/progress/end', { token })).error.name, 'NotFound');
  assert.equal((await r.call(me, 'ui/progress/end', { token })).ok, true);
  assert.deepEqual(shown.map((m) => m.op), ['start', 'report', 'report', 'end']);
});

test('tabs area: own tabs only, a tab page\'s own fields, 64 KiB state', async () => {
  const { registerTabsApi } = require('../addons/api/tabs.js');
  const r = new ApiRouter();
  const open = [];
  const closed = [];
  const changed = [];
  registerTabsApi(r, {
    contributes: (addonId, tabId) => addonId === 'a' && tabId === 'a.view',
    open: (caller, tabId, opts) => {
      const tab = { id: open.length + 10, addon: { id: caller.addonId, tabId, args: opts.args, state: null } };
      open.push(tab);
      return tab;
    },
    instances: (addonId, tabId, instanceId) => open.filter((t) => t.addon.id === addonId && t.addon.tabId === tabId && (instanceId === undefined || t.id === instanceId)),
    close: async (tab) => closed.push(tab.id),
    reveal: () => {},
    changed: (tab) => changed.push(tab.id),
  });
  const bg = { addonId: 'a', kind: 'background', entry: { manifest: {} } };
  assert.deepEqual((await r.call(bg, 'tabs/open', { tabId: 'a.view', args: { q: 1 } })).result, { instanceId: 10 });
  assert.deepEqual(open[0].addon.args, { q: 1 });
  assert.equal((await r.call(bg, 'tabs/open', { tabId: 'b.view' })).error.name, 'NotFound');
  assert.equal((await r.call(bg, 'tabs/open', { tabId: 'a.view', args: 'x'.repeat(70000) })).error.name, 'TooLarge');
  assert.equal((await r.call(bg, 'tabs/update', { title: 'x' })).error.name, 'NotSupported');
  const me = { addonId: 'a', kind: 'tab', tab: open[0], entry: { manifest: {} } };
  assert.equal((await r.call(me, 'tabs/update', { title: 'Found 3', dirty: true, icon: 'img/i.png' })).ok, true);
  assert.equal(open[0].addon.title, 'Found 3');
  assert.equal(open[0].addon.dirty, true);
  assert.deepEqual(changed, [10]);
  for (const icon of ['../x.png', '/x.png', 'C:/x.png', 'a\\b.png', 'a/./b.png']) {
    assert.equal((await r.call(me, 'tabs/update', { icon })).error.name, 'InvalidParams', icon);
  }
  assert.equal((await r.call(me, 'tabs/getState')).result, null);
  await r.call(me, 'tabs/setState', { state: { n: 2 } });
  assert.deepEqual((await r.call(me, 'tabs/getState')).result, { n: 2 });
  assert.equal((await r.call(me, 'tabs/setState', { state: 'y'.repeat(70000) })).error.name, 'TooLarge');
  assert.deepEqual((await r.call(me, 'tabs/getRestoreState')).result, { reason: 'new', state: null });
  assert.deepEqual((await r.call(me, 'tabs/getArgs')).result, { q: 1 });
  assert.equal((await r.call(bg, 'tabs/close', { tabId: 'a.view', instanceId: 99 })).error.name, 'NotFound');
  await r.call(bg, 'tabs/open', { tabId: 'a.view' });
  await r.call(bg, 'tabs/close', { tabId: 'a.view' });
  assert.deepEqual(closed, [10, 11]);
});
