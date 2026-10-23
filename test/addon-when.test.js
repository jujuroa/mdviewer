const test = require('node:test');
const assert = require('node:assert/strict');
const { parseWhen, evaluateWhen } = require('../addons/when.js');

const ctx = { editMode: true, activeProject: true, activeDocument: false, activeTabKind: 'document', resourceExt: 'md', 'git.dirty': 1, empty: '' };
const look = (k) => ctx[k];

test('when: keys, negation, comparisons', () => {
  assert.equal(evaluateWhen('editMode', look), true);
  assert.equal(evaluateWhen('activeDocument', look), false);
  assert.equal(evaluateWhen('missing', look), false);
  assert.equal(evaluateWhen('empty', look), false);
  assert.equal(evaluateWhen('!activeDocument', look), true);
  assert.equal(evaluateWhen('!!editMode', look), true);
  assert.equal(evaluateWhen("resourceExt == 'md'", look), true);
  assert.equal(evaluateWhen('resourceExt == "md"', look), true);
  assert.equal(evaluateWhen('resourceExt == md', look), true);
  assert.equal(evaluateWhen("resourceExt != 'md'", look), false);
  assert.equal(evaluateWhen("missing == ''", look), true);
  assert.equal(evaluateWhen('git.dirty', look), true);
});

test('when: && binds tighter than ||, parentheses', () => {
  assert.equal(evaluateWhen('activeDocument && editMode || activeProject', look), true);
  assert.equal(evaluateWhen('activeDocument && (editMode || activeProject)', look), false);
  assert.equal(evaluateWhen("!(activeTabKind == 'addon') && resourceExt == 'md'", look), true);
});

test('when: none holds, malformed does not', () => {
  assert.equal(evaluateWhen(undefined, look), true);
  assert.equal(evaluateWhen('', look), true);
  for (const bad of ['editMode &&', '(editMode', 'editMode)', '== x', "a == 'x", 'a b', 'a ? b', '!']) {
    assert.equal(evaluateWhen(bad, look), false, bad);
    assert.throws(() => parseWhen(bad), SyntaxError, bad);
  }
});

test('when: keys are looked up only as needed', () => {
  const asked = [];
  evaluateWhen('activeProject || projectHas.git', (k) => (asked.push(k), ctx[k]));
  assert.deepEqual(asked, ['activeProject']);
  assert.deepEqual(parseWhen("a && !b || c == 'x y'"), { or: [{ and: [{ key: 'a' }, { not: { key: 'b' } }] }, { key: 'c', op: '==', value: 'x y' }] });
});
