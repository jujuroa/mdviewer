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
