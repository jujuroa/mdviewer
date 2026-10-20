const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { contentTypeOf, addonFileFor, hostSource, contentSecurityPolicy } = require('../addons/pages.js');

const DIR = path.resolve('C:/addons/test');

test('addonFileFor: files under the folder only', () => {
  assert.equal(addonFileFor(DIR, '/tab.html'), path.join(DIR, 'tab.html'));
  assert.equal(addonFileFor(DIR, '/sub/a%20b.js'), path.join(DIR, 'sub', 'a b.js'));
  assert.equal(addonFileFor(DIR, '/../secret.txt'), null);
  assert.equal(addonFileFor(DIR, '/%2e%2e/secret.txt'), null);
  assert.equal(addonFileFor(DIR, '/..%5Csecret.txt'), null);
  assert.equal(addonFileFor(DIR, '/sub/../../x'), null);
  assert.equal(addonFileFor(DIR, '/'), null);
  assert.equal(addonFileFor(DIR, ''), null);
  assert.equal(addonFileFor(DIR, '/a%00.html'), null);
  assert.equal(addonFileFor(DIR, '/%E0%A4%A'), null);
  assert.equal(addonFileFor(DIR, '//C:/Windows/win.ini'), null);
});

test('contentTypeOf: by extension, unknown as octet-stream', () => {
  assert.equal(contentTypeOf('a.HTML'), 'text/html; charset=utf-8');
  assert.equal(contentTypeOf('a.js'), 'text/javascript; charset=utf-8');
  assert.equal(contentTypeOf('a.exe'), 'application/octet-stream');
});

test('hostSource: https by default, scheme and port kept, junk dropped', () => {
  assert.equal(hostSource('api.example.com'), 'https://api.example.com');
  assert.equal(hostSource('http://127.0.0.1:8080'), 'http://127.0.0.1:8080');
  assert.equal(hostSource('wss://x.example.com'), 'wss://x.example.com');
  assert.equal(hostSource('*.example.com'), 'https://*.example.com');
  assert.equal(hostSource("x.com; script-src 'unsafe-eval'"), null);
  assert.equal(hostSource('x.com/path'), null);
  assert.equal(hostSource(''), null);
  assert.equal(hostSource('*'), null);
});

test('contentSecurityPolicy: own folder, declared hosts, no frames or forms', () => {
  const csp = contentSecurityPolicy(['api.example.com', 'bad host']);
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /script-src 'self'(;|$)/);
  assert.match(csp, /connect-src 'self' https:\/\/api\.example\.com(;|$)/);
  assert.match(csp, /worker-src 'self'/);
  assert.match(csp, /frame-src 'none'/);
  assert.match(csp, /form-action 'none'/);
  assert.doesNotMatch(csp, /bad host/);
  assert.match(contentSecurityPolicy(), /connect-src 'self'(;|$)/);
});
