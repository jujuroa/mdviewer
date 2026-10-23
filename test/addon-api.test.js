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
    const r = new ApiRouter();
    registerSettingsApi(r, { settings, secrets, setContext: (...a) => context.push(a) });
    const me = { addonId: 'a', entry };
    assert.deepEqual((await r.call(me, 'settings/get', {})).result, { greeting: 'hi', count: 1, on: null, mode: 'x' });
    assert.equal((await r.call(me, 'settings/update', { key: 'count', value: 5 })).ok, true);
    assert.equal((await r.call(me, 'settings/get', { key: 'count' })).result, 5);
    assert.equal((await r.call(me, 'settings/update', { key: 'count', value: 'five' })).error.name, 'InvalidParams');
    assert.equal((await r.call(me, 'settings/update', { key: 'mode', value: 'z' })).error.name, 'InvalidParams');
    assert.equal((await r.call(me, 'settings/update', { key: 'nope', value: 1 })).error.name, 'NotFound');
    assert.equal((await r.call(me, 'settings/get', { key: 'nope' })).error.name, 'NotFound');
    assert.equal(new AddonSettings(path.join(dir, 'addon-settings.json')).get(entry, 'count'), 5);

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
