const test = require('node:test');
const assert = require('node:assert/strict');
const { positionAt, offsetAt, rangeOf, offsetsOf } = require('../lib/text-range.js');

test('positions: lines from 0, \\n and \\r\\n as one break', () => {
  const t = 'ab\r\ncd\nef';
  assert.deepEqual(positionAt(t, 0), { line: 0, character: 0 });
  assert.deepEqual(positionAt(t, 2), { line: 0, character: 2 });
  assert.deepEqual(positionAt(t, 3), { line: 0, character: 2 }); // inside the \r\n
  assert.deepEqual(positionAt(t, 4), { line: 1, character: 0 });
  assert.deepEqual(positionAt(t, 7), { line: 2, character: 0 });
  assert.deepEqual(positionAt(t, 99), { line: 2, character: 2 });
  assert.equal(offsetAt(t, { line: 1, character: 1 }), 5);
  assert.equal(offsetAt(t, { line: 0, character: 2 }), 2);
  assert.equal(offsetAt(t, { line: 0, character: 3 }), -1); // past the line
  assert.equal(offsetAt(t, { line: 3, character: 0 }), -1);
  assert.equal(offsetAt(t, { line: 2, character: 2 }), 9);
  assert.equal(offsetAt(t, { line: -1, character: 0 }), -1);
  assert.equal(offsetAt(t, { line: 0.5, character: 0 }), -1);
});

test('UTF-16 code units, trailing newline gives an empty last line', () => {
  const t = '한글😀x\n';
  assert.deepEqual(positionAt(t, 4), { line: 0, character: 4 }); // 😀 is two units
  assert.equal(offsetAt(t, { line: 1, character: 0 }), 6);
  assert.deepEqual(positionAt(t, 6), { line: 1, character: 0 });
});

test('ranges both ways', () => {
  const t = 'one\ntwo\nthree';
  const r = rangeOf(t, 4, 11);
  assert.deepEqual(r, { start: { line: 1, character: 0 }, end: { line: 2, character: 3 } });
  assert.deepEqual(offsetsOf(t, r), [4, 11]);
  assert.equal(offsetsOf(t, { start: { line: 2, character: 0 }, end: { line: 1, character: 0 } }), null);
  assert.equal(offsetsOf(t, { start: { line: 0, character: 0 }, end: { line: 9, character: 0 } }), null);
  assert.equal(offsetsOf(t, null), null);
});
