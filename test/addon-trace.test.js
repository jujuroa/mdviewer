const test = require('node:test');
const assert = require('node:assert/strict');
const { traceLevel, formatTrace } = require('../addons/trace.js');

test('traceLevel: off unless calls or verbose', () => {
  assert.equal(traceLevel('calls'), 'calls');
  assert.equal(traceLevel('verbose'), 'verbose');
  assert.equal(traceLevel(undefined), 'off');
  assert.equal(traceLevel('loud'), 'off');
});

test('formatTrace: calls, verbose, and what never shows', () => {
  const ok = { ok: true, result: { text: 'secret plan', version: 'v1' } };
  assert.equal(formatTrace('calls', 'documents/read', { path: 'a.md' }, ok, 12.4), 'call documents/read 12 ms ok');
  const verbose = formatTrace('verbose', 'documents/read', { path: 'a.md' }, ok, 3);
  assert.match(verbose, /params=\{"path":"a.md"\} result=\{"text":"<11 chars>","version":"v1"\}/);
  assert.doesNotMatch(verbose, /secret plan/);
  const edit = formatTrace('verbose', 'edit/apply', { operations: [{ changes: [{ newText: 'hello' }] }] }, { ok: true, result: null }, 1);
  assert.match(edit, /"newText":"<5 chars>"/);
  const secret = formatTrace('verbose', 'secrets/set', { key: 'token', value: 'abc123' }, { ok: true, result: null }, 1);
  assert.doesNotMatch(secret, /abc123/);
  assert.match(secret, /"key":"token","value":"<hidden>"/);
  const got = formatTrace('verbose', 'secrets/get', { key: 'token' }, { ok: true, result: 'abc123' }, 1);
  assert.doesNotMatch(got, /abc123/);
  const failed = formatTrace('verbose', 'tabs/open', { tabId: 'x' }, { ok: false, error: { name: 'NotFound', message: 'no tab' } }, 2);
  assert.match(failed, /error NotFound params=\{"tabId":"x"\} message="no tab"/);
  assert.match(formatTrace('verbose', 'storage/writeFile', { data: 'x'.repeat(5000) }, { ok: true, result: null }, 1), /… \(\d+ chars\)/);
});
