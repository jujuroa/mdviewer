const test = require('node:test');
const assert = require('node:assert/strict');
const { isAppPageUrl, docTabIdOf, subframeNavigationAllowed } = require('../lib/app-frames.js');

const DOC = 'file:///C:/app/src/doc.html';
const INDEX = 'file:///C:/app/src/index.html';
const PAGES = { docPageUrl: DOC, appPageUrls: [DOC, INDEX] };

test('isAppPageUrl: the page whatever its query or fragment', () => {
  assert.equal(isAppPageUrl(`${DOC}?tab=3`, [DOC, INDEX]), true);
  assert.equal(isAppPageUrl(`${INDEX}#x`, [DOC, INDEX]), true);
  assert.equal(isAppPageUrl('file:///C:/app/src/doc.html.evil', [DOC, INDEX]), false);
  assert.equal(isAppPageUrl('file:///C:/docs/readme.md', [DOC, INDEX]), false);
  assert.equal(isAppPageUrl('', [DOC, INDEX]), false);
  assert.equal(isAppPageUrl(undefined, [DOC, INDEX]), false);
});

test('page addresses match whatever the escaping or the case', () => {
  const page = 'file:///C:/Program%20Files/MD%20Viewer/resources/app.asar/src/doc.html';
  assert.equal(isAppPageUrl('file:///c:/Program Files/MD Viewer/resources/app.asar/src/doc.html?tab=1', [page]), true);
  const hangul = 'file:///C:/Users/%ED%99%8D%EA%B8%B8%EB%8F%99/app/src/doc.html';
  assert.equal(isAppPageUrl('file:///C:/Users/홍길동/app/src/doc.html', [hangul]), true);
  assert.equal(docTabIdOf('file:///C:/Users/홍길동/app/src/DOC.html?tab=4', hangul), 4);
  assert.equal(isAppPageUrl('file:///C:/Users/%E0%A4%A/src/doc.html', [hangul]), false); // bad escape
});

test('docTabIdOf: only `?tab=N`', () => {
  assert.equal(docTabIdOf(`${DOC}?tab=12`, DOC), 12);
  assert.equal(docTabIdOf(`${DOC}?tab=0`, DOC), 0);
  assert.equal(docTabIdOf(`${DOC}?tab=01`, DOC), 0);
  assert.equal(docTabIdOf(`${DOC}?tab=3&x=1`, DOC), 0);
  assert.equal(docTabIdOf(`${DOC}?tab=3#f`, DOC), 0);
  assert.equal(docTabIdOf(DOC, DOC), 0);
  assert.equal(docTabIdOf(`${INDEX}?tab=3`, DOC), 0);
  assert.equal(docTabIdOf(null, DOC), 0);
});

test('subframeNavigationAllowed: a new tab iframe may load its page', () => {
  assert.equal(subframeNavigationAllowed({ fromUrl: '', targetUrl: `${DOC}?tab=1`, tabLevel: true }, PAGES), true);
  assert.equal(subframeNavigationAllowed({ fromUrl: 'about:blank', targetUrl: `${DOC}?tab=1`, tabLevel: true }, PAGES), true);
});

test('subframeNavigationAllowed: an app page frame only reloads', () => {
  assert.equal(subframeNavigationAllowed({ fromUrl: `${DOC}?tab=1`, targetUrl: `${DOC}?tab=1`, tabLevel: true }, PAGES), true);
  assert.equal(subframeNavigationAllowed({ fromUrl: `${DOC}?tab=1`, targetUrl: `${DOC}?tab=2`, tabLevel: true }, PAGES), false);
  assert.equal(subframeNavigationAllowed({ fromUrl: `${DOC}?tab=1`, targetUrl: 'https://example.com/', tabLevel: true }, PAGES), false);
  assert.equal(subframeNavigationAllowed({ fromUrl: `${DOC}?tab=1`, targetUrl: 'file:///C:/x.html', tabLevel: true }, PAGES), false);
});

test('subframeNavigationAllowed: other frames never reach an app page', () => {
  // A frame that already shows something else (an add-on page, a file).
  assert.equal(subframeNavigationAllowed({ fromUrl: 'file:///C:/x.html', targetUrl: `${DOC}?tab=1`, tabLevel: true }, PAGES), false);
  assert.equal(subframeNavigationAllowed({ fromUrl: 'mdviewer-addon://a/tab.html', targetUrl: INDEX, tabLevel: true }, PAGES), false);
  // A frame deeper down (the viewer inside a document tab).
  assert.equal(subframeNavigationAllowed({ fromUrl: 'about:blank', targetUrl: `${DOC}?tab=1`, tabLevel: false }, PAGES), false);
  // Not a tab address.
  assert.equal(subframeNavigationAllowed({ fromUrl: '', targetUrl: INDEX, tabLevel: true }, PAGES), false);
  assert.equal(subframeNavigationAllowed({ fromUrl: '', targetUrl: `${DOC}?tab=x`, tabLevel: true }, PAGES), false);
});

test('subframeNavigationAllowed: an add-on page stays in its origin', () => {
  const P = { ...PAGES, addonScheme: 'mdviewer-addon' };
  const from = 'mdviewer-addon://test/tab.html';
  assert.equal(subframeNavigationAllowed({ fromUrl: from, targetUrl: 'mdviewer-addon://test/other.html', tabLevel: true }, P), true);
  assert.equal(subframeNavigationAllowed({ fromUrl: from, targetUrl: 'mdviewer-addon://TEST/x', tabLevel: true }, P), true);
  assert.equal(subframeNavigationAllowed({ fromUrl: from, targetUrl: 'mdviewer-addon://other/tab.html', tabLevel: true }, P), false);
  assert.equal(subframeNavigationAllowed({ fromUrl: from, targetUrl: 'https://example.com/', tabLevel: true }, P), false);
  assert.equal(subframeNavigationAllowed({ fromUrl: from, targetUrl: 'file:///C:/x.html', tabLevel: true }, P), false);
  assert.equal(subframeNavigationAllowed({ fromUrl: from, targetUrl: `${DOC}?tab=1`, tabLevel: true }, P), false);
  assert.equal(subframeNavigationAllowed({ fromUrl: from, targetUrl: 'about:blank', tabLevel: true }, P), false);
  // A new tab iframe may load an add-on page.
  assert.equal(subframeNavigationAllowed({ fromUrl: '', targetUrl: from, tabLevel: true }, P), true);
});

test('subframeNavigationAllowed: everything else is left alone', () => {
  assert.equal(subframeNavigationAllowed({ fromUrl: 'about:blank', targetUrl: 'file:///C:/x.html', tabLevel: false }, PAGES), true);
  assert.equal(subframeNavigationAllowed({ fromUrl: 'file:///C:/x.html', targetUrl: 'https://example.com/', tabLevel: true }, PAGES), true);
});
