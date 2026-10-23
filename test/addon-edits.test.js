const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { createHash } = require('crypto');
const { planEdit, needsConfirmation, applyChanges } = require('../addons/edits.js');
const { diffForView } = require('../addons/diffview.js');

const sha1 = (t) => createHash('sha1').update(t, 'utf8').digest('hex');
const ROOT = path.resolve('C:/proj');
const P = (n) => path.join(ROOT, n);
const files = { [P('a.md').toLowerCase()]: 'one\ntwo\nthree\n', [P('b.md').toLowerCase()]: 'b\n' };
const deps = {
  inProject: (p) => p.toLowerCase().startsWith(ROOT.toLowerCase()),
  current: async (p) => {
    const t = files[p.toLowerCase()];
    if (t === undefined) throw new Error('nope');
    return { text: t };
  },
  exists: (p) => (files[p.toLowerCase()] !== undefined ? 'file' : p.toLowerCase() === ROOT.toLowerCase() ? 'dir' : null),
  version: sha1,
};
const err = async (params) => {
  try {
    await planEdit(params, deps);
    return 'ok';
  } catch (e) {
    return e.name;
  }
};

test('applyChanges: ranges into the original text, not overlapping', () => {
  const t = 'one\ntwo\nthree\n';
  const r = (l1, c1, l2, c2) => ({ start: { line: l1, character: c1 }, end: { line: l2, character: c2 } });
  assert.equal(applyChanges(t, [{ range: r(1, 0, 1, 3), newText: 'TWO' }, { range: r(0, 0, 0, 0), newText: '> ' }], 'x'), '> one\nTWO\nthree\n');
  assert.throws(() => applyChanges(t, [{ range: r(0, 0, 1, 1), newText: '' }, { range: r(1, 0, 1, 2), newText: '' }], 'x'), /overlap/);
  assert.throws(() => applyChanges(t, [{ range: r(9, 0, 9, 0), newText: '' }], 'x'), /not in the document/);
  assert.throws(() => applyChanges(t, [], 'x'), /non-empty/);
});

test('planEdit: a change at the version read', async () => {
  const plan = await planEdit({ label: 'fix', operations: [{ kind: 'change', path: P('a.md'), baseVersion: sha1('one\ntwo\nthree\n'), changes: [{ range: { start: { line: 1, character: 0 }, end: { line: 1, character: 3 } }, newText: '2' }] }] }, deps);
  assert.equal(plan.label, 'fix');
  assert.equal(plan.operations[0].after, 'one\n2\nthree\n');
  assert.equal(plan.operations[0].before, 'one\ntwo\nthree\n');
});

test('planEdit: Conflict, OutsideProject, NotFound, InvalidParams — before anything happens', async () => {
  const stale = await planEdit({ operations: [{ kind: 'change', path: P('a.md'), baseVersion: 'old', changes: [] }] }, deps).catch((e) => e);
  assert.equal(stale.name, 'Conflict');
  assert.equal(stale.data.currentVersion, sha1('one\ntwo\nthree\n'));
  assert.equal(await err({ operations: [{ kind: 'create', path: 'C:/elsewhere/x.md', text: '' }] }), 'OutsideProject');
  assert.equal(await err({ operations: [{ kind: 'create', path: P('a.md'), text: '' }] }), 'Conflict');
  assert.equal(await err({ operations: [{ kind: 'create', path: P('sub/x.md'), text: '' }] }), 'NotFound');
  assert.equal(await err({ operations: [{ kind: 'rename', from: P('a.md'), to: P('b.md') }] }), 'Conflict');
  assert.equal(await err({ operations: [{ kind: 'rename', from: P('none.md'), to: P('c.md') }] }), 'NotFound');
  assert.equal(await err({ operations: [{ kind: 'delete', path: P('none.md') }] }), 'NotFound');
  assert.equal(await err({ operations: [] }), 'InvalidParams');
  assert.equal(await err({ operations: [{ kind: 'mutate' }] }), 'InvalidParams');
  assert.equal(await err({ operations: [{ kind: 'delete', path: P('a.md') }, { kind: 'delete', path: P('A.MD') }] }), 'InvalidParams');
  assert.equal(await err({ confirm: 'never', operations: [{ kind: 'delete', path: P('a.md') }] }), 'InvalidParams');
  assert.equal(await err({ operations: [{ kind: 'create', path: P('n.md'), text: '' }, { kind: 'rename', from: P('a.md'), to: P('c.md') }, { kind: 'delete', path: P('b.md') }] }), 'ok');
});

test('needsConfirmation: auto only when the app allows, never for rename or delete', () => {
  const change = { confirm: 'auto', operations: [{ kind: 'change' }] };
  assert.equal(needsConfirmation(change, true), true);
  assert.equal(needsConfirmation(change, false), false);
  assert.equal(needsConfirmation({ confirm: 'always', operations: [{ kind: 'change' }] }, false), true);
  assert.equal(needsConfirmation({ confirm: 'auto', operations: [{ kind: 'delete' }] }, false), true);
});

test('diffForView: hunks with context and paired word marks', () => {
  const before = 'a\nb\nc\nd\ne\nf\ng\nh\nold line here\ni\n';
  const after = 'a\nb\nc\nd\ne\nf\ng\nh\nnew line here\ni\nadded\n';
  const { hunks, truncated } = diffForView(before, after);
  assert.equal(truncated, false);
  assert.equal(hunks.length, 1);
  const types = hunks[0].lines.map((l) => l.type);
  assert.deepEqual(types, ['ctx', 'ctx', 'ctx', 'del', 'add', 'ctx', 'add']);
  const del = hunks[0].lines[3];
  assert.deepEqual(del.parts.filter((p) => p.changed).map((p) => p.text), ['old']);
  assert.deepEqual(hunks[0].lines[4].parts.filter((p) => p.changed).map((p) => p.text), ['new']);
  assert.equal(hunks[0].lines[6].parts, undefined);
  assert.deepEqual(diffForView('same\n', 'same\n').hunks, []);
});
