const test = require('node:test');
const assert = require('node:assert/strict');
const { neighbourIndex, reorderIndex, insertIndex } = require('../lib/tab-strip.js');

// Applies a same-strip move the way main.js moveTab does.
function reorder(tabs, from, to) {
  const at = reorderIndex(tabs.length, from, to);
  const next = [...tabs];
  const [tab] = next.splice(from, 1);
  next.splice(at, 0, tab);
  return next;
}

test('neighbourIndex: the tab that took the place, else the one before', () => {
  assert.equal(neighbourIndex(2, 0), 0); // [a,b,c] closing a -> b
  assert.equal(neighbourIndex(2, 1), 1); // closing b -> c
  assert.equal(neighbourIndex(2, 2), 1); // closing c (last) -> b
  assert.equal(neighbourIndex(0, 0), -1); // nothing left
});

test('reorderIndex: dropped before the tab at `to`', () => {
  assert.deepEqual(reorder(['a', 'b', 'c', 'd'], 0, 2), ['b', 'a', 'c', 'd']);
  assert.deepEqual(reorder(['a', 'b', 'c', 'd'], 3, 1), ['a', 'd', 'b', 'c']);
  assert.deepEqual(reorder(['a', 'b', 'c', 'd'], 1, 4), ['a', 'c', 'd', 'b']); // after the last
  assert.deepEqual(reorder(['a', 'b', 'c', 'd'], 1, 1), ['a', 'b', 'c', 'd']); // on itself
  assert.deepEqual(reorder(['a', 'b', 'c', 'd'], 1, 2), ['a', 'b', 'c', 'd']); // just after itself
  assert.deepEqual(reorder(['a', 'b'], 0, 99), ['b', 'a']);
  assert.deepEqual(reorder(['a', 'b'], 1, -5), ['b', 'a']);
});

test('insertIndex: before the tab at `index`, or at the end', () => {
  assert.equal(insertIndex(3, 0), 0);
  assert.equal(insertIndex(3, 3), 3);
  assert.equal(insertIndex(3, 10), 3);
  assert.equal(insertIndex(3, -1), 0);
  assert.equal(insertIndex(3, undefined), 3);
  assert.equal(insertIndex(3, null), 3);
  assert.equal(insertIndex(0, undefined), 0);
});
