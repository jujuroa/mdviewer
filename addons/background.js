// Background frames (protocol 7.1, 7.4): an add-on's page with no screen,
// in a hidden window of its own (which survives program windows closing
// and reloading), started by an activation event and stopped when idle.
//
//   starting --ready()--> running --idle / turned off--> stopping --> (gone)
//   starting --no ready() in 10 s / crash--> error --> restart, at most 3
//   times in 5 minutes; past that the add-on's background stays off for
//   this session ('failed').
//
// main.js gives what this needs (see createBackgroundFrames) and keeps the
// add-on registry; this module keeps the frames.
const READY_TIMEOUT_MS = 10000;
const RESTART_WINDOW_MS = 5 * 60 * 1000;
const RESTART_LIMIT = 3;
const RESTART_DELAY_MS = 1000;
const IDLE_CHECK_MS = 1000;
const DEFAULT_IDLE_TIMEOUT_SEC = 600;

// deps:
//   BrowserWindow, preload (path), scheme ('mdviewer-addon')
//   ask(frame, kind, timeoutMs) -> answer   (tab:ask to the frame)
//   busy(id) -> whether the add-on has tabs or panes open
//   running(id) -> the registry entry while the add-on runs, else null
//   log(message), onChange() (the management screen's view changed)
//   guard(win) (navigation and window-open limits for its window)
function createBackgroundFrames(deps) {
  const frames = new Map(); // add-on id -> record
  const failed = new Set(); // add-on ids past the restart limit
  let idleTimer = null;

  function record(id) {
    return frames.get(id) || null;
  }

  function start(entry, why) {
    const background = entry.manifest && entry.manifest.background;
    if (!background || failed.has(entry.id)) return null;
    const existing = record(entry.id);
    // Already up (or coming up): nothing to do. After an error or while
    // stopping, a new window takes over.
    if (existing && (existing.state === 'starting' || existing.state === 'running')) return existing;
    const rec = existing || { id: entry.id, restarts: [] };
    rec.idleTimeoutSec = Number.isInteger(background.idleTimeoutSec) ? background.idleTimeoutSec : DEFAULT_IDLE_TIMEOUT_SEC;
    rec.state = 'starting';
    rec.ready = false;
    rec.lastActivity = Date.now();
    rec.calls = 0;
    const win = new deps.BrowserWindow({
      show: false,
      width: 800,
      height: 600,
      webPreferences: {
        preload: deps.preload,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false,
      },
    });
    rec.win = win;
    deps.guard(win);
    win.webContents.on('render-process-gone', () => fail(rec, win, 'crashed'));
    win.on('closed', () => {
      if (rec.win === win) rec.win = null;
    });
    rec.readyTimer = setTimeout(() => {
      if (rec.win === win && !rec.ready) fail(rec, win, `did not call ready() within ${READY_TIMEOUT_MS / 1000} s`);
    }, READY_TIMEOUT_MS);
    frames.set(entry.id, rec);
    deps.log(`[addons] ${entry.id} background starting (${why})`);
    win.loadURL(`${deps.scheme}://${entry.id}/${background.entry}`).catch(() => {});
    watchIdle();
    deps.onChange();
    return rec;
  }

  function fail(rec, win, reason) {
    if (rec.win !== win) return;
    clearTimeout(rec.readyTimer);
    rec.win = null;
    if (!win.isDestroyed()) win.destroy();
    const now = Date.now();
    rec.restarts = rec.restarts.filter((t) => now - t < RESTART_WINDOW_MS);
    deps.log(`[addons] ${rec.id} background stopped: ${reason}`);
    if (rec.restarts.length >= RESTART_LIMIT) {
      rec.state = 'failed';
      failed.add(rec.id);
      deps.log(`[addons] ${rec.id} background restarted ${RESTART_LIMIT} times in 5 minutes; off until the app restarts`);
      deps.onChange();
      return;
    }
    rec.restarts.push(now);
    rec.state = 'error';
    deps.onChange();
    setTimeout(() => {
      if (rec.state !== 'error') return;
      const entry = deps.running(rec.id);
      if (entry) start(entry, 'restart');
      else forget(rec);
    }, RESTART_DELAY_MS);
  }

  function forget(rec) {
    frames.delete(rec.id);
    deps.onChange();
  }

  // Its onWillClose handler gets its 3 s, then the window goes.
  async function stop(id, why) {
    const rec = record(id);
    if (!rec || rec.state === 'stopping') return;
    clearTimeout(rec.readyTimer);
    if (!rec.win) {
      forget(rec);
      return;
    }
    rec.state = 'stopping';
    deps.onChange();
    const win = rec.win;
    deps.log(`[addons] ${id} background stopping (${why})`);
    if (rec.ready && !win.isDestroyed()) await deps.ask(win.webContents.mainFrame, 'close', 3500);
    if (!win.isDestroyed()) win.destroy();
    if (rec.state === 'stopping') forget(rec);
  }

  function stopAll() {
    for (const rec of frames.values()) {
      clearTimeout(rec.readyTimer);
      if (rec.win && !rec.win.isDestroyed()) rec.win.destroy();
    }
    frames.clear();
    clearInterval(idleTimer);
    idleTimer = null;
  }

  // Idle: nothing of the add-on open or in flight for idleTimeoutSec
  // (0: never stops on its own).
  function watchIdle() {
    if (idleTimer) return;
    idleTimer = setInterval(() => {
      if (!frames.size) {
        clearInterval(idleTimer);
        idleTimer = null;
        return;
      }
      const now = Date.now();
      for (const rec of frames.values()) {
        if (rec.state !== 'running' || !rec.idleTimeoutSec) continue;
        if (rec.calls > 0 || deps.busy(rec.id)) {
          rec.lastActivity = now;
          continue;
        }
        if (now - rec.lastActivity >= rec.idleTimeoutSec * 1000) stop(rec.id, 'idle');
      }
    }, IDLE_CHECK_MS);
  }

  // The background frame `contents` is, if it is one.
  function byContents(contents) {
    for (const rec of frames.values()) {
      if (rec.win && !rec.win.isDestroyed() && rec.win.webContents === contents) return rec;
    }
    return null;
  }

  function markReady(rec) {
    rec.ready = true;
    clearTimeout(rec.readyTimer);
    if (rec.state === 'starting') {
      rec.state = 'running';
      rec.lastActivity = Date.now();
      deps.log(`[addons] ${rec.id} background running`);
      deps.onChange();
    }
  }

  // An API call from the frame: it is not idle while calls run.
  function callStarted(rec) {
    rec.calls++;
    rec.lastActivity = Date.now();
  }

  function callEnded(rec) {
    rec.calls = Math.max(0, rec.calls - 1);
    rec.lastActivity = Date.now();
  }

  // 'starting' | 'running' | 'stopping' | 'error' | 'failed' | null
  function stateOf(id) {
    if (failed.has(id)) return 'failed';
    const rec = record(id);
    return rec ? rec.state : null;
  }

  return { start, stop, stopAll, byContents, markReady, callStarted, callEnded, stateOf, ids: () => [...frames.keys()] };
}

module.exports = { createBackgroundFrames };
