const test = require('node:test');
const assert = require('node:assert/strict');
const { samePath, isPathInside, openArgFromArgv } = require('../lib/paths.js');

test('samePath: case and form do not matter, empty never matches', () => {
  assert.equal(samePath('C:\\Docs\\A.md', 'c:/docs/a.md'), true);
  assert.equal(samePath('C:\\docs\\x\\..\\a.md', 'C:\\docs\\a.md'), true);
  assert.equal(samePath('C:\\docs\\a.md', 'C:\\docs\\b.md'), false);
  assert.equal(samePath(null, null), false);
  assert.equal(samePath('', 'C:\\a.md'), false);
});

test('isPathInside: the root itself and what is under it', () => {
  assert.equal(isPathInside('C:\\proj', 'C:\\proj'), true);
  assert.equal(isPathInside('C:\\proj\\a\\b.md', 'C:\\proj'), true);
  assert.equal(isPathInside('C:\\project2\\a.md', 'C:\\proj'), false);
  assert.equal(isPathInside('C:\\a.md', 'C:\\proj'), false);
  assert.equal(isPathInside('D:\\proj\\a.md', 'C:\\proj'), false);
});

test('openArgFromArgv: skips the app path when unpackaged and switches anywhere', () => {
  assert.equal(openArgFromArgv(['mdviewer.exe', 'a.md'], true), 'a.md');
  assert.equal(openArgFromArgv(['mdviewer.exe', '--flag', 'a.md'], true), 'a.md');
  assert.equal(openArgFromArgv(['electron.exe', '.', 'proj'], false), 'proj');
  // A second instance's argv: switches moved ahead of the app path.
  assert.equal(openArgFromArgv(['electron.exe', '--user-data-dir=x', '.', 'proj'], false), 'proj');
  assert.equal(openArgFromArgv(['electron.exe', '.'], false), null);
  assert.equal(openArgFromArgv(['mdviewer.exe'], true), null);
});
