// Drives a throwaway instance of the app through the DevTools protocol, for
// the checks in this folder (npm run test:app). Each instance gets its own
// user data folder, a free debugging port and a temp folder of files, so it
// never touches an instance already running or the user's settings; only
// the processes it started are stopped.
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, openSync, closeSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

export const ROOT = path.resolve(import.meta.dirname, '..', '..');
export const DOC_PAGE_URL = pathToFileURL(path.join(ROOT, 'src', 'doc.html')).href;
const require = createRequire(path.join(ROOT, 'package.json'));

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

// files: { 'relative/path': 'content' } written under the temp folder;
// open: what to open on the command line (relative to it); settings: the
// instance's settings.json (Korean UI by default, which the checks' status
// line texts assume); addonDev: add-on folders (from the repository root,
// or under the temp folder as '{tmp}/...') loaded with --addon-dev; env:
// more environment variables, with {tmp} in a value standing for the temp
// folder.
export async function launch({ files = {}, open = 'proj', settings = { language: 'ko' }, addonDev = ['test/addons/test', 'test/addons/other'], env: moreEnv = {} } = {}) {
  const tmp = mkdtempSync(path.join(tmpdir(), 'mdvtest-'));
  mkdirSync(path.join(tmp, 'userData'), { recursive: true });
  writeFileSync(path.join(tmp, 'userData', 'settings.json'), JSON.stringify(settings));
  for (const [rel, text] of Object.entries(files)) {
    const p = path.join(tmp, rel);
    mkdirSync(path.dirname(p), { recursive: true });
    writeFileSync(p, text);
  }
  const port = await freePort();
  const inspectPort = await freePort();
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  // The test add-ons, and an install folder of its own.
  env.MDVIEWER_ADDONS_DIR = path.join(tmp, 'addons');
  env.MDVIEWER_LOGS_DIR = path.join(tmp, 'logs');
  env.MDVIEWER_ADDON_DATA_DIR = path.join(tmp, 'addon-data');
  for (const [k, v] of Object.entries(moreEnv)) env[k] = String(v).replace('{tmp}', tmp);
  const args = [
    '.',
    `--inspect=${inspectPort}`,
    `--user-data-dir=${path.join(tmp, 'userData')}`,
    `--remote-debugging-port=${port}`,
    ...addonDev.map((dir) => `--addon-dev=${path.resolve(ROOT, dir.replace('{tmp}', tmp))}`),
  ];
  if (open) args.push(path.join(tmp, open));
  // The app's output goes to a file, not a pipe: helper processes inherit
  // the handles and can outlive the main one, and Node then hangs closing
  // a pipe they still hold.
  const logFile = path.join(tmp, 'app.log');
  const logFd = openSync(logFile, 'a');
  const child = spawn(require('electron'), args, { cwd: ROOT, env, stdio: ['ignore', logFd, logFd] });
  closeSync(logFd);
  const logText = () => {
    try {
      return readFileSync(logFile, 'utf-8');
    } catch {
      return '';
    }
  };
  for (let i = 0; i < 100; i++) {
    try {
      await fetch(`http://127.0.0.1:${port}/json/version`);
      break;
    } catch {
      await sleep(200);
    }
  }
  const app = { tmp, child, port, logText };
  // Code run in the main process (the body of an async function, with
  // electron at hand), for what no page can reach — the app menu, say.
  // The inspector connection must be closed before the app ends: Node's
  // WebSocket stalls the event loop when that peer dies under it. So a
  // check that makes the app quit does it from a page (Page.close), after
  // app.closeSessions() (all the others).
  let mainSession = null;
  app.closeSessions = async (keep = null) => {
    await app.closeMain();
    const sessions = sessionsByPort.get(port);
    if (!sessions) return;
    await Promise.all([...sessions].filter((s) => s !== keep).map((s) => s.close()));
    for (const s of [...sessions]) if (s !== keep) sessions.delete(s);
  };
  app.closeMain = async () => {
    const session = mainSession;
    mainSession = null;
    if (session) await session.close();
  };
  app.stop = async () => {
    await app.closeMain();
    await closeSessionsOf(port);
    return stop(app);
  };
  app.main = async (expr) => {
    if (!mainSession) {
      const list = await (await fetch(`http://127.0.0.1:${inspectPort}/json/list`)).json();
      mainSession = await connectWs(list[0].webSocketDebuggerUrl, { quiet: true, runtime: false });
    }
    const m = await mainSession.send('Runtime.evaluate', {
      expression: `(async () => { const electron = process.mainModule.require('electron'); ${expr} })()`,
      awaitPromise: true,
      returnByValue: true,
    });
    if (m.result?.exceptionDetails) throw new Error(m.result.exceptionDetails.exception?.description || JSON.stringify(m.result.exceptionDetails));
    return m.result?.result?.value;
  };
  // Clicks an app menu item by its labels, e.g. clickMenu('확장', '확장 관리...').
  app.clickMenu = (...labels) =>
    app.main(`
      let items = electron.Menu.getApplicationMenu().items;
      let item = null;
      for (const label of ${JSON.stringify(labels)}) {
        item = items.find((i) => i.label === label);
        if (!item) throw new Error('no menu item ' + label);
        items = item.submenu ? item.submenu.items : [];
      }
      const win = electron.BrowserWindow.getAllWindows().find((w) => w.isVisible());
      item.click(undefined, win, {});
      return true;`);
  // The Extensions menu's visible items; an add-on's submenu as
  // "<add-on>: <item>" for each of its items ("<add-on>: 창 열기" for its
  // main view).
  app.extensionLabels = () =>
    app.main(`
      const out = [];
      for (const i of electron.Menu.getApplicationMenu().items.find((m) => m.label === '확장').submenu.items) {
        if (!i.visible) continue;
        if (i.submenu && i.submenu.items.length && String(i.submenu.items[0].id).startsWith('addon-open:')) for (const s of i.submenu.items) { if (s.visible && s.type !== 'separator') out.push(i.label + ': ' + s.label); }
        else out.push(i.label);
      }
      return out;`);
  // "<add-on>: <tab title>": the add-on's submenu item of that title, else
  // its "창 열기" (the main view).
  app.clickAddonMenu = (label) => {
    const [name, ...rest] = label.split(': ');
    return app.main(`
      const sub = electron.Menu.getApplicationMenu().items.find((m) => m.label === '확장').submenu.items.find((i) => i.label === ${JSON.stringify(name)} && i.submenu);
      if (!sub) throw new Error('no add-on submenu ' + ${JSON.stringify(name)});
      const want = ${JSON.stringify(rest.join(': '))};
      const item = sub.submenu.items.find((i) => i.label === want) || sub.submenu.items.find((i) => i.label === '창 열기');
      if (!item) throw new Error('no menu item ' + want);
      item.click(undefined, electron.BrowserWindow.getAllWindows().find((w) => w.isVisible()), {});
      return true;`);
  };
  return app;
}

async function stop({ child, tmp }) {
  // Already gone (a check that quit the app): nothing to stop, and taskkill
  // on an exited process can hang.
  const run = (cmd, args) =>
    new Promise((resolve) => {
      const p = spawn(cmd, args, { stdio: 'ignore' });
      p.on('exit', resolve);
      p.on('error', resolve);
      setTimeout(resolve, 10000);
    });
  if (child.exitCode === null && child.signalCode === null) {
    const exited = new Promise((resolve) => child.once('exit', resolve));
    try {
      child.kill();
    } catch (err) {
      /* already gone */
    }
    await Promise.race([exited, sleep(5000)]);
  }
  // Helpers of this instance that outlived its main process (they carry
  // its temp folder in their command line, so only ours match).
  const marker = tmp.replace(/'/g, "''");
  await run('powershell', [
    '-NoProfile',
    '-Command',
    `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine.Contains('${marker}') } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`,
  ]);
  // rmSync can hang on a locked folder on Windows; the async one retries.
  await Promise.race([rm(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }).catch(() => {}), sleep(15000)]);
}

export async function targets(port) {
  return (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
}

// type: 'page', 'iframe' (an out-of-process frame) or 'any'.
export async function connect(port, match, { type = 'page', quiet = false } = {}) {
  let t;
  for (let i = 0; i < 50; i++) {
    t = (await targets(port)).find((x) => (type === 'any' || x.type === type) && match(x));
    if (t) break;
    await sleep(200);
  }
  if (!t) throw new Error('target not found');
  return track(port, await connectWs(t.webSocketDebuggerUrl, { quiet, target: t }));
}

// The browser-wide endpoint (SystemInfo and the like).
export async function connectBrowser(port) {
  const v = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
  return track(port, await connectWs(v.webSocketDebuggerUrl, { quiet: true, runtime: false }));
}

// Every DevTools connection to an instance, by its port: they are closed
// before the instance is stopped. Node's WebSocket can stall the event
// loop when the other end is killed under it.
const sessionsByPort = new Map();

function track(port, session) {
  if (!sessionsByPort.has(port)) sessionsByPort.set(port, new Set());
  sessionsByPort.get(port).add(session);
  return session;
}

async function closeSessionsOf(port) {
  const sessions = sessionsByPort.get(port);
  sessionsByPort.delete(port);
  if (sessions) await Promise.all([...sessions].map((s) => s.close()));
}

async function connectWs(url, { quiet = false, target = null, runtime = true } = {}) {
  const ws = new WebSocket(url);
  await new Promise((r) => ws.addEventListener('open', r, { once: true }));
  let id = 0;
  const pending = new Map();
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m);
      pending.delete(m.id);
    }
    if (quiet) return;
    if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params.exceptionDetails;
      console.log('  page exception:', d.exception?.description?.split('\n')[0] || d.text);
    }
  });
  // A target that goes away (a closed frame, the app quitting) answers
  // nothing more: what still waits gets an error result.
  let closed = false;
  ws.addEventListener('close', () => {
    closed = true;
    for (const r of pending.values()) r({ error: { message: 'target closed' } });
    pending.clear();
  });
  const send = (method, params = {}) =>
    new Promise((r) => {
      if (closed) return r({ error: { message: 'target closed' } });
      const i = ++id;
      pending.set(i, r);
      ws.send(JSON.stringify({ id: i, method, params }));
    });
  // Runs `expr` as the body of an async function and returns its value.
  const evaluate = async (expr) => {
    const m = await send('Runtime.evaluate', { expression: `(async () => { ${expr} })()`, awaitPromise: true, returnByValue: true });
    if (m.result?.exceptionDetails) throw new Error(m.result.exceptionDetails.exception?.description || JSON.stringify(m.result.exceptionDetails));
    return m.result?.result?.value;
  };
  // Without waiting: for code that blocks the page.
  const fire = (expr) => ws.send(JSON.stringify({ id: ++id, method: 'Runtime.evaluate', params: { expression: expr } }));
  if (runtime) await send('Runtime.enable');
  // Resolves once the connection is closed (or after 3 s).
  const close = () =>
    new Promise((resolve) => {
      if (closed) return resolve();
      ws.addEventListener('close', () => resolve(), { once: true });
      setTimeout(resolve, 3000);
      ws.close();
    });
  return { send, evaluate, fire, close, target };
}

export async function waitFor(fn, { timeout = 10000, step = 200 } = {}) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    last = await fn().catch(() => false);
    if (last) return last;
    await sleep(step);
  }
  throw new Error('waitFor timed out');
}

// PASS/FAIL lines and the exit code.
export function checker() {
  let failed = 0;
  const check = (name, ok, info = '') => {
    if (!ok) failed++;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? `  — ${info}` : ''}`);
  };
  // Ends the check: a socket to an instance that quit on its own can keep
  // Node waiting otherwise.
  const done = () => {
    console.log(failed ? `${failed} FAILED` : 'ALL PASS');
    process.exitCode = failed ? 1 : 0;
    setTimeout(() => process.exit(), 200);
  };
  return { check, done };
}

// The window page, with the given explorer entry clicked (its tab open).
// A tab's iframe is touched only after it has loaded: reaching into a frame
// while it loads keeps its preload from running.
export async function openWindowWith(app, fileName) {
  const w = await connect(app.port, (t) => t.url.endsWith('index.html'));
  await waitFor(() =>
    w.evaluate(`const r = [...document.querySelectorAll('[data-path]')].find(n => n.dataset.path.endsWith(${JSON.stringify(fileName)})); if (r) r.click(); return !!r`)
  );
  await sleep(2500);
  return w;
}

// Code run in the active document tab's iframe, with doc / ta / st at hand.
export function inActiveDoc(w) {
  return (code) =>
    w.evaluate(
      `const f = [...document.querySelectorAll('iframe.doc-frame')].find(f => f.classList.contains('active')); const doc = f.contentDocument; const ta = doc.getElementById('md-source-editor'); const st = doc.getElementById('edit-status'); ${code}`
    );
}

export async function enterEditMode(d) {
  await waitFor(
    async () => {
      await d(`const b = doc.getElementById('btn-toggle-edit'); if (!b.classList.contains('active')) b.click(); return 1`);
      await sleep(700);
      return d(`return doc.getElementById('btn-toggle-edit').classList.contains('active')`);
    },
    { timeout: 15000 }
  );
}

// Opens an add-on's tab from Extensions in the menu bar ("Add-on: Tab") and
// resolves to { ok, id } — the tab that became active.
export async function openAddonTab(app, w, label) {
  await app.clickAddonMenu(label);
  await sleep(1500);
  const id = await w.evaluate(`const n = document.querySelector('#doc-host ~ * .doc-tab.active, .doc-tab.active'); return n ? +n.dataset.tabId : null`);
  return { ok: id != null, id };
}
