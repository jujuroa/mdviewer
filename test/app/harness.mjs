// Drives a throwaway instance of the app through the DevTools protocol, for
// the checks in this folder (npm run test:app). Each instance gets its own
// user data folder, a free debugging port and a temp folder of files, so it
// never touches an instance already running or the user's settings; only
// the processes it started are stopped.
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
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
// line texts assume).
export async function launch({ files = {}, open = 'proj', settings = { language: 'ko' } } = {}) {
  const tmp = mkdtempSync(path.join(tmpdir(), 'mdvtest-'));
  mkdirSync(path.join(tmp, 'userData'), { recursive: true });
  writeFileSync(path.join(tmp, 'userData', 'settings.json'), JSON.stringify(settings));
  for (const [rel, text] of Object.entries(files)) {
    const p = path.join(tmp, rel);
    mkdirSync(path.dirname(p), { recursive: true });
    writeFileSync(p, text);
  }
  const port = await freePort();
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const args = ['.', `--user-data-dir=${path.join(tmp, 'userData')}`, `--remote-debugging-port=${port}`];
  if (open) args.push(path.join(tmp, open));
  const child = spawn(require('electron'), args, { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const log = [];
  child.stdout.on('data', (d) => log.push(String(d)));
  child.stderr.on('data', (d) => log.push(String(d)));
  for (let i = 0; i < 100; i++) {
    try {
      await fetch(`http://127.0.0.1:${port}/json/version`);
      break;
    } catch {
      await sleep(200);
    }
  }
  const app = { tmp, child, port, log, logText: () => log.join('') };
  app.stop = () => stop(app);
  return app;
}

async function stop({ child, tmp }) {
  await new Promise((resolve) => {
    const k = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    k.on('exit', resolve);
    k.on('error', resolve);
  });
  for (let i = 0; i < 10; i++) {
    try {
      rmSync(tmp, { recursive: true, force: true });
      return;
    } catch {
      await sleep(300);
    }
  }
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
  return connectWs(t.webSocketDebuggerUrl, { quiet, target: t });
}

// The browser-wide endpoint (SystemInfo and the like).
export async function connectBrowser(port) {
  const v = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
  return connectWs(v.webSocketDebuggerUrl, { quiet: true, runtime: false });
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
  const send = (method, params = {}) =>
    new Promise((r) => {
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
  return { send, evaluate, fire, close: () => ws.close(), target };
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
  const done = () => {
    console.log(failed ? `${failed} FAILED` : 'ALL PASS');
    process.exitCode = failed ? 1 : 0;
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
