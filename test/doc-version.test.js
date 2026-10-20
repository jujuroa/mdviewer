const test = require('node:test');
const assert = require('node:assert/strict');
const { contentVersion, writeIfUnchanged } = require('../lib/doc-version.js');

// An in-memory stand-in for the fs calls writeIfUnchanged makes.
function fakeFs(files) {
  return {
    files,
    readFileSync(p) {
      if (!(p in files)) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      return files[p];
    },
    writeFileSync(p, content) {
      files[p] = content;
    },
  };
}

test('contentVersion: SHA-1 of the UTF-8 text in hex', () => {
  assert.equal(contentVersion(''), 'da39a3ee5e6b4b0d3255bfef95601890afd80709');
  assert.equal(contentVersion('abc'), 'a9993e364706816aba3e25717850c26c9cd0d89d');
  assert.notEqual(contentVersion('한글'), contentVersion('한굴'));
});

test('writeIfUnchanged: writes when the disk still has the version read', () => {
  const fs = fakeFs({ a: 'old' });
  const result = writeIfUnchanged(fs, 'a', 'new', contentVersion('old'));
  assert.deepEqual(result, { ok: true, version: contentVersion('new') });
  assert.equal(fs.files.a, 'new');
});

test('writeIfUnchanged: refuses when the disk changed since', () => {
  const fs = fakeFs({ a: 'changed elsewhere' });
  const result = writeIfUnchanged(fs, 'a', 'mine', contentVersion('old'));
  assert.equal(result.ok, false);
  assert.equal(result.conflict, true);
  assert.equal(fs.files.a, 'changed elsewhere');
});

test('writeIfUnchanged: no version given, or a file that is gone, just writes', () => {
  const fs = fakeFs({ a: 'whatever' });
  assert.equal(writeIfUnchanged(fs, 'a', 'mine').ok, true);
  assert.equal(fs.files.a, 'mine');
  assert.equal(writeIfUnchanged(fs, 'b', 'new', contentVersion('old')).ok, true);
  assert.equal(fs.files.b, 'new');
});
