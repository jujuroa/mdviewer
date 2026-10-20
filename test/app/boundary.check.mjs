// The app's IPC and its pages (F0-a): frames that aren't the app's own pages
// get no IPC, and no frame becomes one by navigating.
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { launch, checker, sleep, openWindowWith, inActiveDoc, DOC_PAGE_URL } from './harness.mjs';

const { check, done } = checker();
const app = await launch({ files: { 'proj/a.md': '# A\n', 'evil/evil.html': '<!doctype html><title>evil</title><p>evil</p>' } });
const evilUrl = pathToFileURL(path.join(app.tmp, 'evil', 'evil.html')).href;
try {
  const w = await openWindowWith(app, 'a.md');
  const tabId = await w.evaluate(`return +document.querySelector('.doc-tab').dataset.tabId`);

  // A frame of the window page showing something else cannot become a tab page.
  await w.evaluate(`const f = document.createElement('iframe'); f.id = 'evil'; f.src = ${JSON.stringify(evilUrl)}; document.body.appendChild(f); return 1`);
  await sleep(1000);
  await w.evaluate(`document.getElementById('evil').src = '${DOC_PAGE_URL}?tab=${tabId}'; return 1`);
  await sleep(1500);
  const evilNow = await w.evaluate(`return document.getElementById('evil').contentWindow.location.href`);
  check('a frame showing a file cannot load doc.html?tab=N', !evilNow.includes('doc.html'), evilNow);
  check('  and gets no app bridge', (await w.evaluate(`return typeof document.getElementById('evil').contentWindow.mdviewer`)) === 'undefined');
  check('  logged', /\[nav\] blocked .*evil\.html.*doc\.html/.test(app.logText()));

  // A frame at the address of a tab that doesn't exist: its IPC is refused.
  await w.evaluate(`const f = document.createElement('iframe'); f.id = 'ghost'; f.src = '${DOC_PAGE_URL}?tab=999'; document.body.appendChild(f); return 1`);
  await sleep(2500);
  const ghost = await w.evaluate(
    `const win = document.getElementById('ghost').contentWindow; if (!win.mdviewer) return 'no bridge'; try { await win.mdviewer.readFile(${JSON.stringify(path.join(app.tmp, 'proj', 'a.md'))}); return 'read'; } catch (e) { return 'refused'; }`
  );
  check('IPC from a frame claiming a tab that does not exist is refused', ghost === 'refused' || ghost === 'no bridge', ghost);
  check('  logged', /\[ipc\] refused .*doc\.html\?tab=999/.test(app.logText()));
  await w.evaluate(`document.getElementById('ghost').remove(); document.getElementById('evil').remove(); return 1`);

  // The viewer frame inside a tab cannot load an app page. (It was filled
  // with document.open(), so its location reports the tab page's address:
  // look at what it holds instead.)
  const d = inActiveDoc(w);
  await d(`doc.getElementById('preview-frame').src = '${DOC_PAGE_URL}?tab=${tabId}'; return 1`);
  await sleep(1500);
  const inner = await d(`const v = doc.getElementById('preview-frame').contentDocument; return { toolbar: !!v.getElementById('btn-toggle-edit'), body: v.body.className }`);
  check('the viewer frame cannot load doc.html', !inner.toolbar && /markdown-body/.test(inner.body), JSON.stringify(inner));

  // A tab page cannot navigate itself away.
  await d(`f.contentWindow.location.href = ${JSON.stringify(evilUrl)}; return 1`);
  await sleep(2000);
  const stay = await w.evaluate(`return document.querySelector('iframe.doc-frame.active').contentWindow.location.href`);
  check('a tab page cannot navigate away', stay.startsWith(`${DOC_PAGE_URL}?tab=`), stay);
  check('  and still works', (await d(`return typeof f.contentWindow.mdviewer`)) === 'object');

  check('the real pages were never refused', !/\[ipc\] refused .*(index\.html|doc\.html\?tab=(?!999)\d+)/.test(app.logText()));
} finally {
  await app.stop();
  done();
}
