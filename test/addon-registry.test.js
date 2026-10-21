const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { checkManifest, compatibilityProblems, activationEvents, localize, HOST } = require('../addons/manifest.js');
const { discover } = require('../addons/registry.js');

const good = (over = {}) => ({
  manifestVersion: 1,
  id: 'sample',
  name: '%name%',
  version: '1.0.0',
  engines: { mdviewer: '>=2.0.0 <3.0.0', api: 1 },
  contributes: {
    tabs: [{ id: 'sample.main', title: 'Main', entry: 'tabs/main.html' }],
    commands: [{ id: 'sample.open', title: 'Open', handler: 'tab:sample.main' }],
    menus: { 'menubar/addons': [{ command: 'sample.open' }] },
  },
  ...over,
});
const codes = (r) => r.errors.map((e) => `${e.path}:${e.code}`);

test('checkManifest: a good manifest has no errors', () => {
  const r = checkManifest(good(), 'sample');
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.warnings, []);
});

test('checkManifest: required fields, formats, folder name', () => {
  assert.deepEqual(codes(checkManifest({}, 'x')).sort(), [
    ':nothingToRun', 'engines:required', 'id:required', 'manifestVersion:required', 'name:required', 'version:required',
  ].sort());
  assert.ok(codes(checkManifest(good({ id: 'Bad_Id' }), 'Bad_Id')).includes('id:badId'));
  assert.ok(codes(checkManifest(good(), 'other-folder')).includes('id:folderMismatch'));
  assert.ok(codes(checkManifest(good({ version: '1.0' }), 'sample')).includes('version:badVersion'));
  assert.ok(codes(checkManifest(good({ engines: { mdviewer: 'not a range!', api: 1 } }), 'sample')).includes('engines.mdviewer:badRange'));
  assert.deepEqual(codes(checkManifest('nope')), [':notObject']);
});

test('checkManifest: contributes refer to what exists, ids carry the prefix', () => {
  const m = good();
  m.contributes.commands.push({ id: 'other.cmd', title: 'x', handler: 'tab:sample.nope' });
  m.contributes.menus['menubar/addons'].push({ command: 'sample.missing' });
  m.contributes.keybindings = [{ command: 'sample.open' }];
  const c = codes(checkManifest(m, 'sample'));
  assert.ok(c.includes('contributes.commands[1].id:notPrefixed'));
  assert.ok(c.includes('contributes.commands[1].handler:unknownTab'));
  assert.ok(c.includes('contributes.menus.menubar/addons[1].command:unknownCommand'));
  assert.ok(c.includes('contributes.keybindings[0].key:required'));
  const bg = good({ contributes: { commands: [{ id: 'sample.run', title: 'Run', handler: 'background' }] } });
  assert.ok(codes(checkManifest(bg, 'sample')).includes('contributes.commands[0].handler:noBackground'));
});

test('checkManifest: entries stay inside the folder; hosts and permissions are known', () => {
  const m = good({ background: { entry: '../evil.html' }, permissions: ['documents.read', 'root'], network: { hosts: ['ok.example.com', 'x.com/path'] } });
  m.contributes.tabs[0].entry = 'C:\\Windows\\x.html';
  const c = codes(checkManifest(m, 'sample'));
  assert.ok(c.includes('background.entry:badEntry'));
  assert.ok(c.includes('contributes.tabs[0].entry:badEntry'));
  assert.ok(c.includes('permissions[1]:unknownPermission'));
  assert.ok(c.includes('network.hosts[1]:badHost'));
});

test('checkManifest: unknown fields and menus are warnings only', () => {
  const m = good({ shiny: true });
  m.contributes.menus['nowhere/menu'] = [];
  const r = checkManifest(m, 'sample');
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.warnings.map((w) => `${w.path}:${w.code}`).sort(), ['contributes.menus.nowhere/menu:unknownMenu', 'shiny:unknownField']);
});

test('compatibilityProblems: app version, API, capabilities, experimental API', () => {
  assert.deepEqual(compatibilityProblems(good()), []);
  const codesOf = (m, o) => compatibilityProblems(m, o).map((p) => p.code);
  assert.deepEqual(codesOf(good({ engines: { mdviewer: '>=2.1.0', api: 1 } })), ['appVersion']);
  assert.deepEqual(codesOf(good({ engines: { mdviewer: '^2.0.0', api: 2 } })), ['apiVersion']);
  assert.deepEqual(codesOf(good({ engines: { mdviewer: '^2.0.0', api: 1, capabilities: { process: 1 } } })), ['capability']);
  assert.deepEqual(codesOf(good({ manifestVersion: 2 })), ['unknownManifestVersion']);
  assert.deepEqual(codesOf(good({ experimentalApi: ['tree.view'] })), ['experimentalNotAllowed']);
  assert.deepEqual(codesOf(good({ experimentalApi: ['tree.view'] }), { experimentalAllowed: true }), []);
  assert.equal(HOST.version, '2.0.0');
});

test('activationEvents and localize', () => {
  assert.deepEqual(activationEvents(good({ activation: ['onProject', 'onTab:sample.main'] })), [
    'onCommand:sample.open', 'onTab:sample.main', 'onProject',
  ]);
  const strings = [{ name: '샘플' }, { name: 'Sample', desc: 'English only' }];
  assert.deepEqual(localize({ name: '%name%', d: '%desc%', k: '%missing%', n: 1, list: ['%name%', 'plain'] }, strings), {
    name: '샘플', d: 'English only', k: 'missing', n: 1, list: ['샘플', 'plain'],
  });
});

test('discover: places in order, problems, shadowing, locales', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mdv-reg-'));
  const write = (rel, value) => {
    const file = path.join(root, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
  };
  try {
    write('dev/sample/manifest.json', good());
    write('dev/sample/locales/ko.json', { name: '샘플' });
    write('installed/sample/manifest.json', good());
    write('installed/broken/manifest.json', '{ not json');
    write('installed/empty/readme.txt', 'no manifest');
    write('installed/mismatch/manifest.json', good());
    write('installed/future/manifest.json', good({ id: 'future', engines: { mdviewer: '>=3.0.0', api: 1 }, contributes: { tabs: [{ id: 'future.t', title: 't', entry: 't.html' }] } }));
    write('installed/.staging/x/manifest.json', good());
    write('extra/exp/manifest.json', good({ id: 'exp', experimentalApi: ['tree.view'], contributes: { tabs: [{ id: 'exp.t', title: 't', entry: 't.html' }] } }));

    const found = discover({
      language: 'ko',
      devDirs: [path.join(root, 'dev', 'sample')],
      extraDirs: [path.join(root, 'extra'), path.join(root, 'nowhere')],
      installDir: path.join(root, 'installed'),
    });
    const by = (id, source) => found.find((e) => e.id === id && e.source === source);
    assert.deepEqual(found.map((e) => `${e.source}:${e.id}:${e.status}`), [
      'dev:sample:ok',
      'extra:exp:incompatible',
      'installed:broken:invalid',
      'installed:empty:invalid',
      'installed:future:incompatible',
      'installed:mismatch:invalid',
      'installed:sample:shadowed',
    ]);
    assert.equal(by('sample', 'dev').manifest.name, '샘플');
    assert.deepEqual(by('sample', 'dev').activation, ['onCommand:sample.open', 'onTab:sample.main']);
    assert.equal(by('broken', 'installed').problems[0].code, 'badJson');
    assert.equal(by('empty', 'installed').problems[0].code, 'noManifest');
    assert.equal(by('mismatch', 'installed').problems[0].code, 'folderMismatch');
    assert.equal(by('sample', 'installed').problems[0].code, 'shadowed');
    assert.equal(by('exp', 'extra').problems[0].code, 'experimentalNotAllowed');
    // Allowed by policy, the experimental one loads.
    const allowed = discover({ extraDirs: [path.join(root, 'extra')], experimentalIds: ['exp'] });
    assert.equal(allowed[0].status, 'ok');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
