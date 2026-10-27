const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { checkManifest, compatibilityProblems, experimentalWarnings, activationEvents, localize, HOST } = require('../addons/manifest.js');
const { discover, Registry } = require('../addons/registry.js');
const { DEFAULT_POLICY, mergePolicy, policyProblems, isLoopback } = require('../addons/policy.js');
const { AddonStore } = require('../addons/store.js');

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
    'contributes.tabs:noMainView', 'engines:required', 'id:required', 'manifestVersion:required', 'name:required', 'version:required',
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
  m.contributes.keybindings = [{ command: 'sample.open' }, { command: 'sample.open', key: 'Ctrl+K', when: 'editMode &&' }];
  m.contributes.menus['menubar/addons'][0].when = "resourceExt == 'md'";
  const c = codes(checkManifest(m, 'sample'));
  assert.ok(c.includes('contributes.commands[1].id:notPrefixed'));
  assert.ok(c.includes('contributes.commands[1].handler:unknownTab'));
  assert.ok(c.includes('contributes.menus.menubar/addons[1].command:unknownCommand'));
  assert.ok(c.includes('contributes.keybindings[0].key:required'));
  assert.ok(c.includes('contributes.keybindings[1].when:badWhen'));
  assert.ok(!c.some((x) => x.startsWith('contributes.menus.menubar/addons[0].when')));
  const bg = good({ contributes: { commands: [{ id: 'sample.run', title: 'Run', handler: 'background' }] } });
  assert.ok(codes(checkManifest(bg, 'sample')).includes('contributes.commands[0].handler:noBackground'));
  // No handler means the background frame (protocol 7.6).
  const noHandler = good({ contributes: { tabs: [{ id: 'sample.t', title: 't', entry: 't.html' }], commands: [{ id: 'sample.run', title: 'Run' }] } });
  assert.ok(codes(checkManifest(noHandler, 'sample')).includes('contributes.commands[0].handler:noBackground'));
  assert.deepEqual(codes(checkManifest({ ...noHandler, background: { entry: 'bg.html' } }, 'sample')), []);
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
    name: '샘플', d: 'English only', k: '%missing%', n: 1, list: ['샘플', 'plain'],
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
    const allowed = discover({ extraDirs: [path.join(root, 'extra')], policy: { ...DEFAULT_POLICY, allowExperimentalApi: ['exp'] } });
    assert.equal(allowed[0].status, 'ok');
    // Policy blocks; the user's choice is kept beside the status.
    write('net/netty/manifest.json', good({ id: 'netty', network: { hosts: ['api.example.com', '127.0.0.1'] }, contributes: { tabs: [{ id: 'netty.t', title: 't', entry: 't.html' }] } }));
    const blocked = discover({ extraDirs: [path.join(root, 'net')], policy: { ...DEFAULT_POLICY, blockNetwork: true } });
    assert.equal(blocked[0].status, 'blocked');
    assert.deepEqual(blocked[0].problems, [{ path: 'network.hosts', code: 'policyNetwork', detail: 'api.example.com' }]);
    const off = discover({ extraDirs: [path.join(root, 'net')], isEnabled: (id) => id !== 'netty' });
    assert.equal(off[0].status, 'ok');
    assert.equal(off[0].enabled, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('mergePolicy: settings, overruled by policy.json', () => {
  assert.deepEqual(mergePolicy(), DEFAULT_POLICY);
  const p = mergePolicy(
    { 'addons.blockNetwork': true, 'addons.allowExperimentalApi': ['a'], 'addons.enabled': 'yes' },
    { 'addons.blockNetwork': false, 'addons.allowedHosts': ['*.corp.example'] }
  );
  assert.equal(p.blockNetwork, false);
  assert.equal(p.enabled, true);
  assert.deepEqual(p.allowExperimentalApi, ['a']);
  assert.deepEqual(p.allowedHosts, ['*.corp.example']);
});

test('policyProblems: off, network, executables, allowed hosts', () => {
  const m = { network: { hosts: ['api.corp.example', 'http://127.0.0.1:9000', 'evil.example'] }, executables: [{ id: 'x', path: 'x.exe' }] };
  assert.deepEqual(policyProblems(m, { ...DEFAULT_POLICY, enabled: false }).map((p) => p.code), ['policyAddonsOff']);
  assert.deepEqual(policyProblems(m, DEFAULT_POLICY), []);
  assert.deepEqual(policyProblems(m, { ...DEFAULT_POLICY, blockExecutables: true }).map((p) => p.code), ['policyExecutables']);
  const hosts = policyProblems(m, { ...DEFAULT_POLICY, allowedHosts: ['*.corp.example'] });
  assert.deepEqual(hosts, [{ path: 'network.hosts', code: 'policyHosts', detail: 'evil.example' }]);
  assert.equal(isLoopback('localhost'), true);
  assert.equal(isLoopback('http://127.0.0.1:1'), true);
  assert.equal(isLoopback('127.example.com'), false);
});

test('AddonStore: on unless turned off, kept in its file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mdv-store-'));
  try {
    const file = path.join(dir, 'sub', 'addons-state.json');
    const store = new AddonStore(file);
    assert.equal(store.isEnabled('a'), true);
    store.setEnabled('a', false);
    assert.equal(new AddonStore(file).isEnabled('a'), false);
    store.setEnabled('a', true);
    assert.equal(new AddonStore(file).isEnabled('a'), true);
    fs.writeFileSync(file, 'garbage');
    assert.equal(new AddonStore(file).isEnabled('a'), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Registry: running() needs found fine and on', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mdv-run-'));
  try {
    fs.mkdirSync(path.join(dir, 'sample'));
    fs.writeFileSync(path.join(dir, 'sample', 'manifest.json'), JSON.stringify(good()));
    let on = true;
    const reg = new Registry({ installDir: dir, isEnabled: () => on });
    reg.rescan();
    assert.equal(reg.running('sample').id, 'sample');
    on = false;
    reg.rescan();
    assert.equal(reg.running('sample'), null);
    assert.equal(reg.get('sample').enabled, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('consent: asked first, and again only when an update asks for more', () => {
  const { consentScope, needsConsent } = require('../addons/consent.js');
  const m = { version: '1.0.0', permissions: ['documents.read'], network: { hosts: ['api.example.com'] }, executables: [{ id: 'git', path: 'bin/git.exe' }] };
  assert.equal(needsConsent(m, null), true);
  const record = consentScope(m);
  assert.deepEqual(record, { version: '1.0.0', permissions: ['documents.read'], hosts: ['api.example.com'], executables: ['git=bin/git.exe'] });
  assert.equal(needsConsent(m, record), false);
  assert.equal(needsConsent({ ...m, version: '1.1.0' }, record), false);
  assert.equal(needsConsent({ ...m, permissions: [] }, record), false);
  assert.equal(needsConsent({ ...m, permissions: ['documents.read', 'documents.write'] }, record), true);
  assert.equal(needsConsent({ ...m, network: { hosts: ['api.example.com', 'other.example.com'] } }, record), true);
  assert.equal(needsConsent({ ...m, executables: [{ id: 'git', path: 'bin/other.exe' }] }, record), true);
});

test('AddonStore: consent records', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mdv-consent-'));
  try {
    const file = path.join(dir, 'addons-state.json');
    const store = new AddonStore(file);
    assert.equal(store.consentOf('a'), null);
    store.recordConsent('a', { version: '1.0.0', permissions: [], hosts: [], executables: [] });
    const again = new AddonStore(file);
    assert.equal(again.consentOf('a').version, '1.0.0');
    assert.ok(again.consentOf('a').consentedAt);
    again.setEnabled('b', false);
    assert.equal(new AddonStore(file).consentOf('a').version, '1.0.0');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('AddonLog: memory, files turned over at the limit, all-add-ons view', () => {
  const { AddonLog } = require('../addons/log.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mdv-log-'));
  try {
    const log = new AddonLog(dir, { maxBytes: 200, memory: 3 });
    const seen = [];
    log.onAdd((e) => seen.push(e.message));
    for (let i = 0; i < 12; i++) log.add('a', 'info', `message number ${i} with some padding`);
    log.add('b', 'error', 'line one\nline two');
    assert.deepEqual(log.entries('a').map((e) => e.message.split(' ')[2]), ['9', '10', '11']);
    assert.equal(seen.length, 13);
    const files = fs.readdirSync(dir).sort();
    assert.deepEqual(files, ['a.log', 'a.log.1', 'a.log.2', 'b.log']);
    assert.ok(fs.statSync(path.join(dir, 'a.log')).size <= 200);
    assert.match(fs.readFileSync(path.join(dir, 'b.log'), 'utf8'), /ERROR line one\n  line two\n/);
    assert.deepEqual(log.entries().map((e) => e.id).slice(-1), ['b']);
    log.add('../evil', 'info', 'x');
    assert.ok(!fs.readdirSync(path.dirname(dir)).includes('evil.log'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('experimentalWarnings: names this app does not have', () => {
  assert.deepEqual(experimentalWarnings({ experimentalApi: ['documents.sync', 'tree.viewz'] }), [{ path: 'experimentalApi[1]', code: 'unknownExperimental', detail: 'tree.viewz' }]);
  assert.deepEqual(experimentalWarnings({}), []);
});

test('registered add-on folders: kept by the store, looked at after --addon-dev, experimental APIs open', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mdv-regd-'));
  const write = (rel, value) => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), JSON.stringify(value));
  };
  try {
    const store = new AddonStore(path.join(root, 'state.json'));
    const mine = path.join(root, 'work', 'sample');
    assert.equal(store.addRegistered(mine), true);
    assert.equal(store.addRegistered(process.platform === 'win32' ? mine.toUpperCase() : mine), false, 'same folder again');
    assert.deepEqual(new AddonStore(path.join(root, 'state.json')).registered(), [mine]);

    write('work/sample/manifest.json', good({ experimentalApi: ['settings.open'] }));
    write('installed/sample/manifest.json', good());
    write('work/other/manifest.json', good({ id: 'other', experimentalApi: ['settings.open'], contributes: { tabs: [{ id: 'other.main', title: 'Main', entry: 'main.html' }] } }));
    const found = discover({ registeredDirs: store.registered(), installDir: path.join(root, 'installed'), extraDirs: [], devDirs: [] });
    const sample = found.filter((e) => e.id === 'sample');
    assert.deepEqual(sample.map((e) => `${e.source}:${e.status}`), ['registered:ok', 'installed:shadowed']);

    // Only the registered one may use experimental APIs without policy.
    store.addRegistered(path.join(root, 'work', 'other'));
    const again = discover({ registeredDirs: store.registered(), installDir: null });
    assert.equal(again.find((e) => e.id === 'other').status, 'ok');
    write('installed2/other/manifest.json', good({ id: 'other', experimentalApi: ['settings.open'], contributes: { tabs: [{ id: 'other.main', title: 'Main', entry: 'main.html' }] } }));
    assert.equal(discover({ installDir: path.join(root, 'installed2') })[0].status, 'incompatible');

    // A registered folder that went away shows as broken until unregistered.
    store.addRegistered(path.join(root, 'gone'));
    assert.equal(discover({ registeredDirs: store.registered() }).find((e) => e.id === 'gone').problems[0].code, 'noManifest');
    assert.equal(store.removeRegistered(path.join(root, 'gone')), true);
    assert.equal(store.removeRegistered(path.join(root, 'gone')), false);
    assert.equal(store.registered().length, 2);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('main view: every add-on has one, "main": true picks it, else the first tab', () => {
  const { mainTabOf } = require('../addons/manifest.js');
  const bgOnly = good({ background: { entry: 'bg.html' }, contributes: {} });
  assert.ok(codes(checkManifest(bgOnly, 'sample')).includes('contributes.tabs:noMainView'));
  const two = good({ contributes: { tabs: [{ id: 'sample.a', title: 'A', entry: 'a.html' }, { id: 'sample.b', title: 'B', entry: 'b.html', main: true }] } });
  assert.deepEqual(checkManifest(two, 'sample').errors, []);
  assert.equal(mainTabOf(two).id, 'sample.b');
  assert.equal(mainTabOf(good()).id, 'sample.main');
  const both = good({ contributes: { tabs: [{ id: 'sample.a', title: 'A', entry: 'a.html', main: true }, { id: 'sample.b', title: 'B', entry: 'b.html', main: true }] } });
  assert.ok(codes(checkManifest(both, 'sample')).includes('contributes.tabs:manyMainViews'));
  assert.ok(codes(checkManifest(good({ contributes: { tabs: [{ id: 'sample.a', title: 'A', entry: 'a.html', main: 'yes' }] } }), 'sample')).includes('contributes.tabs[0].main:badValue'));
  assert.equal(mainTabOf({}), null);
});
