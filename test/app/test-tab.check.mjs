// The 'test' tab kind (run from source only): any page as a tab.
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { launch, checker, sleep, openWindowWith } from './harness.mjs';

const { check, done } = checker();
const app = await launch({
  files: {
    'proj/a.md': '# A\n',
    'pages/hello test.html': '<!doctype html><title>t</title><p id="p">hello from test</p><script>window.counter = 0; setInterval(() => window.counter++, 50);</script>',
  },
});
const url = pathToFileURL(path.join(app.tmp, 'pages', 'hello test.html')).href;
try {
  const w = await openWindowWith(app, 'a.md');
  const res = await w.evaluate(`return await window.mdviewer.openTestTab(${JSON.stringify(url)}, 'main')`);
  check('open a test tab', res && res.ok, JSON.stringify(res));
  await sleep(1500);
  const strip = await w.evaluate(`return [...document.querySelectorAll('.doc-tab')].map(n => ({ text: n.querySelector('.doc-tab-label').textContent, active: n.classList.contains('active') }))`);
  check('in the strip by file name, active', strip.length === 2 && strip[1].text === 'hello test.html' && strip[1].active, JSON.stringify(strip));
  const frame = await w.evaluate(
    `const f = document.querySelector('iframe.doc-frame.active'); return { src: f.src, sandbox: f.getAttribute('sandbox'), text: f.contentDocument.getElementById('p')?.textContent, bridge: typeof f.contentWindow.mdviewer, counter: f.contentWindow.counter }`
  );
  check('iframe at the page, add-on sandbox', frame.src === url && frame.sandbox === 'allow-scripts allow-same-origin allow-forms', JSON.stringify(frame));
  check('its scripts run, no app bridge', frame.text === 'hello from test' && frame.bridge === 'undefined' && frame.counter > 0);

  const ids = await w.evaluate(`return [...document.querySelectorAll('.doc-tab')].map(n => +n.dataset.tabId)`);
  await w.evaluate(`window.__tw = []; const o = window.open; window.open = function (...a) { const r = o.apply(this, a); if (r) window.__tw.push(r); return r; }; return 1`);
  await w.evaluate(`await window.mdviewer.detachTab(${ids[1]}); return 1`);
  await sleep(2500);
  const aux = await w.evaluate(`const f = window.__tw[0] && window.__tw[0].document.querySelector('iframe.doc-frame'); return f ? f.contentDocument.getElementById('p')?.textContent : null`);
  check('moved to a tab window, shows its page', aux === 'hello from test', String(aux));
  await w.evaluate(`await window.mdviewer.moveTabHere(${ids[1]}, 1, 'main'); return 1`);
  await sleep(2500);
  check('moved back', (await w.evaluate(`return document.querySelectorAll('.doc-tab').length`)) === 2);
  const closed = await w.evaluate(`return await window.mdviewer.closeTab(${ids[1]})`);
  check('closes', closed && closed.closed);
  check('nothing refused or blocked', !/\[ipc\] refused|\[nav\] blocked/.test(app.logText()));
} finally {
  await app.stop();
  done();
}
