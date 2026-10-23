const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ApiRouter } = require('../addons/api-router.js');
const { registerStorageApi, projectKey, relativeParts } = require('../addons/api/storage.js');
const { registerMessagingApi } = require('../addons/api/messaging.js');

test('relativeParts: inside the folder only', () => {
  assert.deepEqual(relativeParts('a/b.json'), ['a', 'b.json']);
  assert.deepEqual(relativeParts('a\\b.json'), ['a', 'b.json']);
  assert.deepEqual(relativeParts('dir/'), ['dir']);
  assert.deepEqual(relativeParts(undefined, { optional: true }), []);
  for (const bad of ['../x', 'a/../../x', '/x', '\\x', 'C:/x', './x', 'x.', 'nul', 'COM1.txt', 'a?b', undefined]) {
    assert.throws(() => relativeParts(bad), { name: 'InvalidParams' }, String(bad));
  }
});

test('storage area: global and project scopes, written whole, listed, deleted', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'mdv-storage-'));
  const root = path.join(base, 'proj');
  try {
    const r = new ApiRouter();
    registerStorageApi(r, { baseDir: () => path.join(base, 'data'), projectRoots: () => [root] });
    const me = { addonId: 'a', kind: 'tab', entry: { manifest: {} } };
    const other = { addonId: 'b', kind: 'tab', entry: { manifest: {} } };
    const call = async (who, method, params) => {
      const answer = await r.call(who, method, params);
      return answer.ok ? answer.result : `ERR ${answer.error.name}`;
    };
    assert.deepEqual(await call(me, 'storage/list', { scope: 'global' }), []);
    assert.equal(await call(me, 'storage/writeFile', { scope: 'global', path: 'idx/data.json', data: '{"n":1}' }), null);
    assert.equal(fs.readFileSync(path.join(base, 'data', 'a', 'global', 'idx', 'data.json'), 'utf8'), '{"n":1}');
    assert.equal(await call(me, 'storage/readFile', { scope: 'global', path: 'idx/data.json' }), '{"n":1}');
    assert.equal(await call(other, 'storage/readFile', { scope: 'global', path: 'idx/data.json' }), 'ERR NotFound');
    await call(me, 'storage/writeFile', { scope: 'global', path: 'b.bin', data: new Uint8Array([0, 255, 7]) });
    assert.deepEqual([...(await call(me, 'storage/readFile', { scope: 'global', path: 'b.bin', encoding: 'binary' }))], [0, 255, 7]);
    const list = await call(me, 'storage/list', { scope: 'global' });
    assert.deepEqual(list.map((e) => `${e.kind}:${e.name}`).sort(), ['dir:idx', 'file:b.bin']);
    assert.equal(fs.readdirSync(path.join(base, 'data', 'a', 'global')).some((n) => n.endsWith('.tmp')), false);
    assert.equal(await call(me, 'storage/readFile', { scope: 'global', path: '../b/x' }), 'ERR InvalidParams');
    assert.equal(await call(me, 'storage/writeFile', { scope: 'global', path: 'idx', data: 'x' }), 'ERR Conflict');
    assert.equal(await call(me, 'storage/writeFile', { scope: 'global', path: 'n', data: 5 }), 'ERR InvalidParams');

    assert.equal(await call(me, 'storage/writeFile', { scope: 'project', path: 'x', data: '' }), 'ERR InvalidParams');
    assert.equal(await call(me, 'storage/writeFile', { scope: 'project', root: path.join(base, 'elsewhere'), path: 'x', data: '' }), 'ERR OutsideProject');
    await call(me, 'storage/writeFile', { scope: 'project', root, path: 'cache.txt', data: 'p' });
    assert.ok(fs.existsSync(path.join(base, 'data', 'a', 'projects', projectKey(root), 'cache.txt')));
    if (process.platform === 'win32') assert.equal(projectKey(root.toUpperCase()), projectKey(root));
    const paths = await call(me, 'storage/paths', { root });
    assert.equal(paths.global, path.join(base, 'data', 'a', 'global'));
    assert.equal(paths.project, path.join(base, 'data', 'a', 'projects', projectKey(root)));

    assert.equal(await call(me, 'storage/delete', { scope: 'global', path: 'idx' }), null);
    assert.equal(await call(me, 'storage/delete', { scope: 'global', path: 'idx' }), null);
    assert.deepEqual((await call(me, 'storage/list', { scope: 'global' })).map((e) => e.name), ['b.bin']);
    await call(me, 'storage/delete', { scope: 'global' });
    assert.deepEqual(await call(me, 'storage/list', { scope: 'global' }), []);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('messaging area: to the add-on\'s other frames; request goes to the background', async () => {
  const r = new ApiRouter();
  const sent = [];
  let bgUp = true;
  registerMessagingApi(r, {
    frames: (caller, to) => (to === 'background' ? ['bg'] : to === 'tabs' ? ['t2'] : ['bg', 't2']),
    background: async () => (bgUp ? { frame: 'bg' } : null),
    send: (frame, message, from) => sent.push({ frame, message, from }),
    request: async (target, message, from) => (message.fail ? { ok: false, error: { name: 'InternalError', message: 'no' } } : { ok: true, result: { got: message, from } }),
  });
  const tab = { addonId: 'a', kind: 'tab', tab: { id: 7, addon: { tabId: 'a.view' } }, entry: { manifest: {} } };
  assert.equal((await r.call(tab, 'messaging/post', { to: 'all', message: { hi: 1 } })).ok, true);
  assert.deepEqual(sent.map((s) => s.frame), ['bg', 't2']);
  assert.deepEqual(sent[0].from, { kind: 'tab', tabId: 'a.view', instanceId: 7 });
  assert.equal((await r.call(tab, 'messaging/post', { to: 'nowhere', message: 1 })).error.name, 'InvalidParams');
  assert.equal((await r.call(tab, 'messaging/post', { to: 'tabs', message: 'x'.repeat(1024 * 1024 + 1) })).error.name, 'TooLarge');
  const answer = await r.call(tab, 'messaging/request', { to: 'background', message: { q: 2 } });
  assert.deepEqual(answer.result, { got: { q: 2 }, from: { kind: 'tab', tabId: 'a.view', instanceId: 7 } });
  assert.equal((await r.call(tab, 'messaging/request', { to: 'background', message: { fail: true } })).error.name, 'InternalError');
  assert.equal((await r.call({ addonId: 'a', kind: 'background', entry: { manifest: {} } }, 'messaging/request', { to: 'background', message: 1 })).error.name, 'InvalidParams');
  bgUp = false;
  assert.equal((await r.call(tab, 'messaging/request', { to: 'background', message: 1 })).error.name, 'NotFound');
});
