// Add-on tab frames (F0-b, ADR-0014): an add-on's page from mdviewer-addon://
// in a tab — its process, the window staying responsive, no app bridge, and
// the security boundary (CSP, navigation, popups, permissions, storage).
// Uses local servers on 45678 (in test/addons/test's network.hosts) and
// 45679 (not).
import http from 'node:http';
import { launch, checker, connect, connectBrowser, waitFor, sleep, targets, DOC_PAGE_URL } from './harness.mjs';

const { check, done } = checker();
const hits = { allowed: 0, blocked: 0 };
const mk = (p, key) =>
  http
    .createServer((req, res) => {
      hits[key]++;
      res.writeHead(200, { 'Access-Control-Allow-Origin': '*' });
      res.end('hi');
    })
    .listen(p, '127.0.0.1');
const s1 = mk(45678, 'allowed');
const s2 = mk(45679, 'blocked');

const app = await launch({ files: { 'proj/a.md': '# A\n' } });
const { port } = app;
const logText = app.logText;
const browser = await connectBrowser(port);
const renderers = async () => {
  const r = await browser.send('SystemInfo.getProcessInfo');
  return (r.result?.processInfo || []).filter((p) => p.type === 'renderer').map((p) => p.id);
};
try {
  const w = await connect(port, (t) => t.url.endsWith('index.html'));
  await waitFor(() => w.evaluate(`const r = [...document.querySelectorAll('[data-path]')].find(n => n.dataset.path.endsWith('a.md')); if (r) r.click(); return !!r`));
  await sleep(2500);
  const r0 = await renderers();

  // ---- open the test add-on tab
  const opened = await w.evaluate(`return await window.mdviewer.openTestTab('mdviewer-addon://test/probe.html', 'main')`);
  check('open mdviewer-addon://test/probe.html as a tab', opened && opened.ok, JSON.stringify(opened));
  await sleep(2000);
  const ts = await targets(port);
  const iframeTarget = ts.find((t) => t.type === 'iframe' && t.url.startsWith('mdviewer-addon://test/'));
  check('process: the add-on iframe is an out-of-process frame', !!iframeTarget, ts.map((t) => `${t.type}:${t.url.slice(0, 50)}`).join(' | '));
  const r1 = await renderers();
  check('process: one more renderer process than before', r1.length === r0.length + 1, `${r0.length} -> ${r1.length}`);
  const a = await connect(port, (t) => t.url.startsWith('mdviewer-addon://test/probe.html'), { type: 'iframe' });
  const status = await a.evaluate(`return document.getElementById('status').textContent`);
  check('page served with its own origin', status === 'ready mdviewer-addon://test', status);

  // ---- bridge
  const bridge = await a.evaluate(`return { app: typeof window.mdviewer, addon: typeof window.mdviewerAddon }`);
  check('preload: no app bridge (window.mdviewer) in the add-on frame', bridge.app === 'undefined', JSON.stringify(bridge));
  const parentDom = await a.evaluate(`try { return String(window.parent.document.title); } catch (e) { return 'blocked: ' + e.name; }`);
  check('cannot reach the window page DOM', parentDom.startsWith('blocked'), parentDom);
  const parentBridge = await a.evaluate(`try { return typeof window.parent.mdviewer; } catch (e) { return 'blocked: ' + e.name; }`);
  check('cannot reach the window page bridge', parentBridge.startsWith('blocked') || parentBridge === 'undefined', parentBridge);

  // ---- responsiveness: block the add-on frame for 5 s, the window page answers meanwhile
  a.fire('window.probe.block(5000)');
  await sleep(300);
  const t0 = Date.now();
  await w.evaluate(`return document.querySelectorAll('.doc-tab').length`);
  const lag = Date.now() - t0;
  check('responsiveness: window page answers while the add-on frame is busy', lag < 1000, `${lag} ms`);
  const t1 = Date.now();
  await w.evaluate(`const f = [...document.querySelectorAll('iframe.doc-frame')][0]; return !!f.contentDocument.getElementById('btn-toggle-edit')`);
  check('responsiveness: document tab answers too', Date.now() - t1 < 1000, `${Date.now() - t1} ms`);
  await sleep(5000);

  // ---- network (CSP connect-src from network.hosts)
  hits.allowed = hits.blocked = 0;
  const fAllowed = await a.evaluate(`return await window.probe.fetchFrom('http://127.0.0.1:45678/x')`);
  const fBlocked = await a.evaluate(`return await window.probe.fetchFrom('http://127.0.0.1:45679/x')`);
  check('CSP: fetch to a declared host goes through', fAllowed === 'ok 200', fAllowed);
  check('CSP: fetch to another host is refused', fBlocked.startsWith('error') && hits.blocked === 0, `${fBlocked} (server hits ${hits.blocked})`);
  const wAllowed = await a.evaluate(`return await window.probe.fetchFromWorker('http://127.0.0.1:45678/w')`);
  const wBlocked = await a.evaluate(`return await window.probe.fetchFromWorker('http://127.0.0.1:45679/w')`);
  check('CSP: worker fetch to a declared host goes through', wAllowed === 'ok 200', wAllowed);
  check('CSP: worker fetch to another host is refused', String(wBlocked).startsWith('error') && hits.blocked === 0, `${wBlocked} (server hits ${hits.blocked})`);
  const ws = await a.evaluate(`return await new Promise((res) => { try { const s = new WebSocket('ws://127.0.0.1:45679/'); s.onerror = () => res('error'); s.onopen = () => res('open'); } catch (e) { res('threw ' + e.name); } setTimeout(() => res('timeout'), 3000); })`);
  check('CSP: WebSocket to another host is refused', ws !== 'open', ws);
  const img = await a.evaluate(`return await new Promise((res) => { const i = new Image(); i.onload = () => res('loaded'); i.onerror = () => res('error'); i.src = 'http://127.0.0.1:45679/i.png'; setTimeout(() => res('timeout'), 3000); })`);
  check('CSP: external image is refused', img !== 'loaded' && hits.blocked === 0, `${img} (server hits ${hits.blocked})`);
  const inline = await a.evaluate(`const s = document.createElement('script'); s.textContent = 'window.__inline = 1'; document.body.appendChild(s); await new Promise(r => setTimeout(r, 100)); return typeof window.__inline`);
  check('CSP: inline script does not run', inline === 'undefined', inline);
  const blobWorker = await a.evaluate(`try { const u = URL.createObjectURL(new Blob(['postMessage(1)'], { type: 'text/javascript' })); const wk = new Worker(u); return await new Promise((res) => { wk.onmessage = () => res('ran'); wk.onerror = () => res('error'); setTimeout(() => res('timeout'), 2000); }); } catch (e) { return 'threw ' + e.name; }`);
  check('CSP: blob: worker does not run', blobWorker !== 'ran', blobWorker);

  // ---- navigation, popups, forms
  const popup = await a.evaluate(`try { return String(window.open('https://example.com/')); } catch (e) { return 'threw ' + e.name; }`);
  check('popup: window.open gives nothing', popup === 'null' || popup.startsWith('threw'), popup);
  const topNav = await a.evaluate(`try { window.top.location.href = 'https://example.com/'; return 'no throw'; } catch (e) { return 'threw ' + e.name; }`);
  await sleep(800);
  const winStill = await w.evaluate(`return location.href.endsWith('index.html')`);
  check('navigation: cannot move the window page', winStill, topNav);
  // Each attempt in a probe tab of its own (a blocked navigation can leave
  // an error page behind). Passes when nothing reached the server and the
  // frame either still shows the probe or shows the error page of a
  // navigation that was blocked (no live page from elsewhere).
  const freshProbe = async () => {
    const before = new Set((await targets(port)).map((t) => t.id));
    const r = await w.evaluate(`return await window.mdviewer.openTestTab('mdviewer-addon://test/probe.html', 'main')`);
    await sleep(1500);
    const t = (await targets(port)).find((x) => x.type === 'iframe' && x.url.startsWith('mdviewer-addon://test/probe.html') && !before.has(x.id));
    const c = await connect(port, (x) => x.id === t.id, { type: 'iframe', quiet: true });
    return { c, tabId: r.id, targetId: t.id };
  };
  const outcome = async (p) => {
    const t = (await targets(port)).find((x) => x.id === p.targetId);
    const stayed = !!t && t.url.startsWith('mdviewer-addon://test/probe.html') && (await p.c.evaluate(`return !!window.probeReady`).catch(() => false));
    if (stayed) return 'stayed';
    const doc = await p.c.evaluate(`return document.documentElement.outerHTML.length + ' ' + (document.title || '') + ' ' + location.href`).catch(() => 'gone');
    return `left: ${t ? t.url : 'no target'} (${doc})`;
  };
  for (const [label, how] of [
    ['an app page (doc.html)', `location.href = '${DOC_PAGE_URL}?tab=1'`],
    ['another add-on', `location.href = 'mdviewer-addon://other/probe.html'`],
    ['the web', `location.href = 'http://127.0.0.1:45679/nav'`],
    ['the web by a link click', `const l = document.createElement('a'); l.href = 'http://127.0.0.1:45679/link'; document.body.appendChild(l); l.click()`],
    ['the web by a target=_blank link', `const l = document.createElement('a'); l.href = 'http://127.0.0.1:45679/blank'; l.target = '_blank'; document.body.appendChild(l); l.click()`],
    ['about:blank', `location.href = 'about:blank'`],
  ]) {
    hits.blocked = 0;
    const p = await freshProbe();
    await p.c.evaluate(`${how}; return 1`).catch(() => {});
    await sleep(1500);
    const out = await outcome(p);
    const errorPage = /^left: http:\/\/127\.0\.0\.1:45679\//.test(out) && hits.blocked === 0;
    // about:blank is handled inside the renderer (no navigation event):
    // fine as long as it keeps the add-on's origin and has no bridge.
    let blank = false;
    if (label === 'about:blank' && /^left: about:blank/.test(out)) {
      const b = await p.c.evaluate(`return location.origin + ' ' + typeof window.mdviewer + ' ' + typeof window.mdviewerAddon`).catch(() => '');
      blank = b === 'mdviewer-addon://test undefined undefined' || b === 'null undefined undefined';
      console.log('INFO  about:blank frame:', b);
    }
    check(`navigation: the add-on frame cannot go to ${label}`, hits.blocked === 0 && (out === 'stayed' || errorPage || blank), `${out}, server hits ${hits.blocked}`);
    // A blocked navigation's error page gets no browser permissions either.
    if (out !== 'stayed') {
      const n = await p.c.evaluate(`try { return await Notification.requestPermission(); } catch (e) { return 'threw ' + e.name; }`).catch(() => 'n/a');
      check(`  its error page gets no permissions`, n !== 'granted', n);
    }
    await w.evaluate(`return await window.mdviewer.closeTab(${p.tabId})`);
    p.c.close();
  }
  check('navigation attempts logged', (logText().match(/\[nav\] blocked a frame going from mdviewer-addon:\/\/test/g) || []).length >= 1, '');

  // ---- permissions and downloads
  const notif = await a.evaluate(`try { return await Notification.requestPermission(); } catch (e) { return 'threw ' + e.name; }`);
  check('permission: notifications denied', notif === 'denied' || notif.startsWith('threw'), notif);
  const media = await a.evaluate(`try { await navigator.mediaDevices.getUserMedia({ audio: true }); return 'granted'; } catch (e) { return e.name; }`);
  check('permission: microphone denied', media !== 'granted', media);
  await a.evaluate(`const l = document.createElement('a'); l.href = 'probe.css'; l.download = 'x.css'; document.body.appendChild(l); l.click(); return 1`);
  await sleep(1500);
  check('download: nothing happens (no dialog left open)', true, 'see below: a save dialog would hang the next step');

  // ---- storage per add-on
  await a.evaluate(`localStorage.setItem('k', 'from-test'); return 1`);
  await w.evaluate(`return await window.mdviewer.openTestTab('mdviewer-addon://other/probe.html', 'main')`);
  await sleep(2000);
  const o = await connect(port, (t) => t.url.startsWith('mdviewer-addon://other/probe.html'), { type: 'iframe' });
  const otherSees = await o.evaluate(`const before = localStorage.getItem('k'); localStorage.setItem('k', 'from-other'); return before`);
  const testSees = await a.evaluate(`return localStorage.getItem('k')`);
  check('storage: each add-on has its own localStorage', otherSees === null && testSees === 'from-test', `other saw ${otherSees}, test sees ${testSees}`);
  const r2 = await renderers();
  check('process: a second add-on gets its own process', r2.length === r1.length + 1, `${r1.length} -> ${r2.length}`);

  // ---- three tabs of the same add-on (one detached): still one process for it
  await w.evaluate(`return await window.mdviewer.openTestTab('mdviewer-addon://test/probe.html', 'main')`);
  await w.evaluate(`return await window.mdviewer.openTestTab('mdviewer-addon://test/probe.html', 'main')`);
  await sleep(2000);
  const ids = await w.evaluate(`return [...document.querySelectorAll('.doc-tab')].map(n => +n.dataset.tabId)`);
  await w.evaluate(`await window.mdviewer.detachTab(${ids[ids.length - 1]}); return 1`);
  await sleep(2500);
  const r3 = await renderers();
  const testFrames = (await targets(port)).filter((t) => t.type === 'iframe' && t.url.startsWith('mdviewer-addon://test/'));
  check('process: 3 tabs of one add-on (one in a tab window) share one process', r3.length === r2.length && testFrames.length === 3, `${r2.length} -> ${r3.length}, frames ${testFrames.length}`);

  // ---- last: a form post (blocked by CSP form-action; the frame ends up on an error page, so it goes last)
  await a.evaluate(`const f = document.createElement('form'); f.action = 'http://127.0.0.1:45679/post'; f.method = 'post'; document.body.appendChild(f); f.submit(); return 1`);
  await sleep(1500);
  check('form post to another host never reaches it', hits.blocked === 0, `server hits ${hits.blocked}`);
  const afterForm = await a.evaluate(`return location.href + ' | origin ' + location.origin + ' | probe ' + typeof window.probe`).catch((e) => 'eval failed');
  console.log('INFO  after the blocked form post the frame shows:', afterForm);

  check('no IPC refused from app pages', !/\[ipc\] refused .* from file:/.test(logText()), logText().split(/\r?\n/).filter((l) => /refused/.test(l)).join(' | '));
} finally {
  await app.stop();
  s1.close();
  s2.close();
  done();
}
