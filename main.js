const {
  app, BrowserWindow, webContents, ipcMain, dialog, shell, Menu, clipboard, nativeImage, nativeTheme, net, protocol, screen,
} = require('electron');
const path = require('path');
const os = require('os');
const { pathToFileURL } = require('url');
const fs = require('fs');
const { spawn } = require('child_process');
const pty = require('node-pty');
const MarkdownIt = require('markdown-it');
const taskLists = require('markdown-it-task-lists');
const footnote = require('markdown-it-footnote');
const hljs = require('highlight.js');
const sanitizeHtml = require('sanitize-html');
const { CODE_LANGUAGE_BY_EXT, CODE_HIGHLIGHT_MAX_LENGTH, codeLanguageOf } = require('./src/code-languages.js');
const { DEFAULT_LANGUAGE, SUPPORTED_LANGUAGES, STRINGS, translate } = require('./assets/i18n.js');
const { samePath, isPathInside, openArgFromArgv, switchValues } = require('./lib/paths.js');
const { neighbourIndex, reorderIndex, insertIndex } = require('./lib/tab-strip.js');
const { contentVersion, writeIfUnchanged } = require('./lib/doc-version.js');
const { isAppPageUrl, docTabIdOf, originIn, subframeNavigationAllowed } = require('./lib/app-frames.js');
const { registerAddonScheme, serveAddonPages, limitPermissionsToAppPages, refuseAddonDownloads } = require('./addons/protocol.js');
const { SCHEME: ADDON_SCHEME } = require('./addons/pages.js');
const { Registry: AddonRegistry } = require('./addons/registry.js');
const { AddonStore } = require('./addons/store.js');
const { mergePolicy } = require('./addons/policy.js');
const { createBackgroundFrames } = require('./addons/background.js');
const { ApiRouter } = require('./addons/api-router.js');
const { registerAppApi } = require('./addons/api/app.js');
const { HOST: ADDON_HOST } = require('./addons/manifest.js');

// Tells preload.js where the app's own pages are, so the bridge goes to
// them alone and not to a project's .html file that happens to share a
// page's name (the viewer shows those in a frame of the tab page).
const APP_PAGES_ARG = `--mdv-app-pages=${pathToFileURL(path.join(__dirname, 'src')).href}`;

// An .html file the viewer shows is loaded as mdv-file://local/<path>
// (see showEmbeddedFile in doc.js) rather than file://: its frame is
// sandboxed to an opaque origin, which Chromium won't let load file://
// stylesheets, scripts or images, so the page's relative links resolve to
// this scheme instead. Being another origin than the app's pages, it gets
// no bridge (preload.js) and can't reach the tab page; and as an opaque
// origin it can't fetch() other files to read them, only embed them, as a
// browser allows a page.
// Registered together with the add-on scheme (registerAddonScheme below),
// since Electron takes one registerSchemesAsPrivileged call.
const EMBED_FILE_SCHEME = 'mdv-file';
const EMBED_FILE_SCHEME_ENTRY = { scheme: EMBED_FILE_SCHEME, privileges: { standard: true, secure: true, stream: true } };

function registerEmbedFileProtocol() {
  protocol.handle(EMBED_FILE_SCHEME, (request) => {
    let filePath = decodeURIComponent(new URL(request.url).pathname);
    // /D:/dir/page.html on Windows.
    if (/^\/[a-zA-Z]:\//.test(filePath)) filePath = filePath.slice(1);
    return net.fetch(pathToFileURL(filePath).href);
  });
}

// A preview build (`npm run dist:preview`) carries a prerelease version such
// as 1.3.0-preview.3 and installs over the released app, so once it is running
// nothing distinguishes it from the real thing. Put the version in the title
// bar rather than leaving it to the About dialog, so "which build is this?"
// is answerable at a glance. Released builds have no prerelease tag and are
// left with the plain title.
const PREVIEW_VERSION_SUFFIX = app.getVersion().includes('-') ? ` — ${app.getVersion()}` : '';

const CONFIG_DIR_NAME = '.mdviewer';
const CSS_FILE_NAME = 'custom.css';
const MAX_RECENT_PROJECTS = 8;
const PLANTUML_FENCE_LANGS = new Set(['plantuml', 'puml']);
const MERMAID_FENCE_LANGS = new Set(['mermaid']);

// PlantUML is rendered locally via a bundled plantuml.jar + minimal jlink'd JRE
// (see scripts/prepare-plantuml.js), rather than the public plantuml.com server:
// that server rejects large/complex diagrams once the encoded source pushes the
// request URL past its ~8KB limit (HTTP 400), which showed up as a broken image.
function plantumlRuntimePaths() {
  const base = app.isPackaged
    ? path.join(process.resourcesPath, 'thirdparty', 'plantuml')
    : path.join(__dirname, 'thirdparty', 'plantuml');
  return {
    jar: path.join(base, 'plantuml.jar'),
    java: path.join(base, 'jre', 'bin', process.platform === 'win32' ? 'java.exe' : 'java'),
  };
}

// Renders in flight, keyed by the renderer-supplied requestId — a single
// request (e.g. a markdown file with several puml fences) can own more than
// one child process, hence a Set per id. Lets the renderer cancel
// (render:cancel below) whatever's still running for a request once the
// user has navigated away from it, instead of leaving java to burn CPU on
// a diagram nobody will see.
const activeRenderAborts = new Map();

function registerAbort(requestId, controller) {
  if (!requestId) return;
  if (!activeRenderAborts.has(requestId)) activeRenderAborts.set(requestId, new Set());
  activeRenderAborts.get(requestId).add(controller);
}

function unregisterAbort(requestId, controller) {
  const set = activeRenderAborts.get(requestId);
  if (!set) return;
  set.delete(controller);
  if (set.size === 0) activeRenderAborts.delete(requestId);
}

function plantumlSourceBody(source) {
  const trimmed = source.trim();
  return /@start\w+/i.test(trimmed) ? trimmed : `@startuml\n${trimmed}\n@enduml`;
}

// Runs java as an async child process rather than spawnSync: large/complex
// diagrams can take java a few seconds (JVM startup + layout), and
// spawnSync blocks the ENTIRE main process's event loop for that whole
// time — freezing every window, menu, and IPC call in the app, not just the
// diagram being rendered. spawn() lets the main process keep servicing
// everything else while java runs in its own OS process.
//
// This is the fallback path now (see renderPlantUmlSvg): starting a JVM per
// diagram is what made rendering slow.
function renderPlantUmlSvgBySpawn(body, signal) {
  const { jar, java } = plantumlRuntimePaths();
  if (!fs.existsSync(jar) || !fs.existsSync(java)) {
    return Promise.reject(new Error(
      'PlantUML runtime not found. Run "npm run prepare:plantuml" (or npm start / npm run dist, which do this automatically).'
    ));
  }

  return new Promise((resolve, reject) => {
    const child = spawn(java, ['-Djava.awt.headless=true', '-jar', jar, '-tsvg', '-pipe', '-charset', 'UTF-8'], { signal });
    const stdoutChunks = [];
    const stderrChunks = [];
    child.stdout.on('data', (chunk) => stdoutChunks.push(chunk));
    child.stderr.on('data', (chunk) => stderrChunks.push(chunk));
    child.on('error', reject);
    child.on('close', (code) => {
      const svg = Buffer.concat(stdoutChunks).toString('utf-8').trim();
      if (code !== 0 || !svg.startsWith('<')) {
        const stderr = Buffer.concat(stderrChunks).toString('utf-8').trim();
        reject(new Error(stderr || 'PlantUML rendering failed'));
        return;
      }
      resolve(svg);
    });
    child.stdin.write(body, 'utf-8');
    child.stdin.end();
  });
}

// ---------------------------------------------------------------------
// PlantUML render server
//
// plantuml.jar can stay running as a small HTTP renderer, and reusing one
// JVM is worth a lot here: measured on this machine, starting java and
// opening the 29MB jar costs ~2.3s while drawing a typical diagram takes
// ~0.3s, so the old one-JVM-per-diagram path spent most of its time
// starting Java over and over — and a document with six diagrams started
// six JVMs at once (~6s). Through the server the same jar returns
// byte-identical SVG in ~15ms (~150ms for a very large diagram), and six
// diagrams together in ~18ms.
//
// It is bound to 127.0.0.1 explicitly. The default is every interface,
// which would put an unauthenticated renderer that can read local files
// (PlantUML's !include) on the network. The `:<address>` half of the
// option is undocumented in --help but the CLI does parse it.
//
// The server starts with the first diagram, not with the app, and is shut
// down once nothing has needed it for a while — it holds ~144MB.
// ---------------------------------------------------------------------

// Kept short on purpose: the server answers in about a second, so a longer
// wait only means a longer stall on the rare machine where it never
// answers at all (a firewall or security product blocking a local port,
// say) before the fallback takes over.
const PLANTUML_SERVER_START_TIMEOUT_MS = 6000;
const PLANTUML_SERVER_IDLE_MS = 5 * 60 * 1000;
// After a failure, stop paying the startup wait on every diagram: render
// through the fallback and try the server again later, backing off if it
// keeps failing. A machine where it never works (a security product
// blocking local ports) then stalls once in a while rather than on every
// document, and a one-off hiccup recovers within the minute.
const PLANTUML_SERVER_RETRY_BASE_MS = 60 * 1000;
const PLANTUML_SERVER_RETRY_MAX_MS = 30 * 60 * 1000;
let plantumlServer = null; // { child, port } while running
let plantumlServerStarting = null; // Promise<port> while coming up
let plantumlServerIdleTimer = null;
let plantumlServerFailedAt = 0;
let plantumlServerFailures = 0;

function plantumlHexUrl(port, body) {
  // The server takes the source in the URL; `~h` means "plain text, hex
  // encoded", which needs no compression library and survives any
  // character. Tested well past the sizes real documents reach (a 51KB
  // source, i.e. a 127KB URL, renders fine).
  return `http://127.0.0.1:${port}/plantuml/svg/~h${Buffer.from(body, 'utf-8').toString('hex')}`;
}

function findFreePort() {
  return new Promise((resolve, reject) => {
    const probe = require('node:net').createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

async function startPlantUmlServer() {
  const { jar, java } = plantumlRuntimePaths();
  if (!fs.existsSync(jar) || !fs.existsSync(java)) {
    throw new Error('PlantUML runtime not found');
  }
  const port = await findFreePort();
  const child = spawn(java, [
    '-Djava.awt.headless=true', '-jar', jar, `--http-server:${port}:127.0.0.1`,
  ]);
  child.stdout.on('data', () => {});
  child.stderr.on('data', () => {});
  child.on('exit', () => {
    if (plantumlServer && plantumlServer.child === child) plantumlServer = null;
  });

  // Ready when it actually renders something, rather than when the port
  // merely opens — that way the first real diagram never races the JVM.
  const probeBody = '@startuml\nstart\nstop\n@enduml';
  const deadline = Date.now() + PLANTUML_SERVER_START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error('PlantUML server exited while starting');
    try {
      const response = await fetch(plantumlHexUrl(port, probeBody));
      if (response.ok && (await response.text()).startsWith('<')) {
        plantumlServer = { child, port };
        return port;
      }
    } catch (err) {
      /* not listening yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  child.kill();
  throw new Error('PlantUML server did not start in time');
}

function plantumlServerRecentlyFailed() {
  if (plantumlServerFailedAt === 0) return false;
  const backoff = Math.min(
    PLANTUML_SERVER_RETRY_BASE_MS * 2 ** (plantumlServerFailures - 1),
    PLANTUML_SERVER_RETRY_MAX_MS
  );
  return Date.now() - plantumlServerFailedAt < backoff;
}

function ensurePlantUmlServer() {
  if (plantumlServer) return Promise.resolve(plantumlServer.port);
  if (!plantumlServerStarting) {
    plantumlServerStarting = startPlantUmlServer()
      .then((port) => {
        plantumlServerFailedAt = 0;
        plantumlServerFailures = 0;
        return port;
      })
      .catch((err) => {
        plantumlServerFailedAt = Date.now();
        plantumlServerFailures += 1;
        throw err;
      })
      .finally(() => {
        plantumlServerStarting = null;
      });
  }
  return plantumlServerStarting;
}

function stopPlantUmlServer() {
  clearTimeout(plantumlServerIdleTimer);
  plantumlServerIdleTimer = null;
  if (!plantumlServer) return;
  const { child } = plantumlServer;
  plantumlServer = null;
  child.kill();
}

function keepPlantUmlServerWarm() {
  clearTimeout(plantumlServerIdleTimer);
  plantumlServerIdleTimer = setTimeout(stopPlantUmlServer, PLANTUML_SERVER_IDLE_MS);
}

async function renderPlantUmlSvgViaServer(body, signal) {
  const port = await ensurePlantUmlServer();
  const response = await fetch(plantumlHexUrl(port, body), { signal });
  if (!response.ok) throw new Error(`PlantUML server returned HTTP ${response.status}`);
  const svg = (await response.text()).trim();
  if (!svg.startsWith('<')) throw new Error('PlantUML server returned no diagram');
  keepPlantUmlServerWarm();
  return svg;
}

// Rendered diagrams, keyed by the exact source that produced them. The
// preview re-renders the whole document on every (debounced) keystroke
// while editing, so without this every diagram in the file is redrawn for
// each edit — including edits nowhere near a diagram. Held in memory only:
// it is worth nothing across runs now that a warm render is ~15ms.
const PLANTUML_CACHE_MAX_ENTRIES = 64;
const PLANTUML_CACHE_MAX_BYTES = 32 * 1024 * 1024;
const plantumlSvgCache = new Map();
let plantumlCacheBytes = 0;

function cachedPlantUmlSvg(body) {
  const svg = plantumlSvgCache.get(body);
  if (svg === undefined) return undefined;
  // Re-insert so the least recently used entry is the one evicted next.
  plantumlSvgCache.delete(body);
  plantumlSvgCache.set(body, svg);
  return svg;
}

function cachePlantUmlSvg(body, svg) {
  if (svg.length > PLANTUML_CACHE_MAX_BYTES) return;
  plantumlSvgCache.set(body, svg);
  plantumlCacheBytes += svg.length;
  while (
    plantumlSvgCache.size > PLANTUML_CACHE_MAX_ENTRIES ||
    plantumlCacheBytes > PLANTUML_CACHE_MAX_BYTES
  ) {
    const oldest = plantumlSvgCache.keys().next().value;
    if (oldest === undefined) break;
    plantumlCacheBytes -= plantumlSvgCache.get(oldest).length;
    plantumlSvgCache.delete(oldest);
  }
}

async function renderPlantUmlSvg(source, signal) {
  const body = plantumlSourceBody(source);
  const cached = cachedPlantUmlSvg(body);
  if (cached !== undefined) return cached;

  let svg;
  try {
    if (plantumlServerRecentlyFailed()) throw new Error('PlantUML server unavailable');
    svg = await renderPlantUmlSvgViaServer(body, signal);
  } catch (err) {
    // A cancelled render is not a failure to work around.
    if ((signal && signal.aborted) || err.name === 'AbortError') throw err;
    // The server may be missing, wedged, or gone; the per-diagram JVM is
    // slow but always available, so no diagram fails just because of it.
    stopPlantUmlServer();
    svg = await renderPlantUmlSvgBySpawn(body, signal);
  }
  cachePlantUmlSvg(body, svg);
  return svg;
}

async function plantumlImageSrc(source, signal) {
  const svg = await renderPlantUmlSvg(source, signal);
  return `data:image/svg+xml;base64,${Buffer.from(svg, 'utf-8').toString('base64')}`;
}

// Wraps the rendered diagram with a zoom control bar and a separate scroll
// area, so the controls stay fixed in a corner while the (potentially huge)
// diagram scrolls underneath. Zoom/pan interactivity itself is wired up from
// the renderer (see initPreviewFrame in src/renderer.js) since the preview
// iframe is sandboxed without allow-scripts.
//
// Diagrams open fitted to the document width (data-fit): a diagram wider than
// the column is unreadable as a strip seen through a scrollbar, and being able
// to see the whole thing is what a reader wants first. Fitting only ever
// shrinks, so anything already narrower than the column opens untouched. The
// percentage in the control bar is a measurement the renderer fills in once
// the image has decoded, so the markup ships a placeholder.
function plantumlDiagramHtml(imgSrc) {
  return (
    '<div class="plantuml-diagram" data-zoom="100" data-fit="1">' +
      '<div class="plantuml-zoom-controls">' +
        '<button type="button" class="puml-zoom-out" title="Zoom out">−</button>' +
        '<span class="puml-zoom-level">100%</span>' +
        '<button type="button" class="puml-zoom-in" title="Zoom in">+</button>' +
        '<button type="button" class="puml-zoom-fit" title="Fit to width">↔</button>' +
        '<button type="button" class="puml-zoom-reset" title="Reset zoom">⟳</button>' +
      '</div>' +
      `<div class="plantuml-scroll"><img src="${imgSrc}" alt="PlantUML diagram"></div>` +
    '</div>'
  );
}

// Mermaid renders locally, in a hidden BrowserWindow, rather than through
// the public mermaid.ink server: diagrams no longer leave the machine (they
// are someone's notes, not public content), the app works offline, and
// nothing depends on a third-party service staying up or on the source
// fitting into a URL. mermaid itself is a browser library — it lays
// diagrams out by measuring rendered text — so it needs a DOM that neither
// the main process nor the script-free preview iframe can give it; see
// assets/mermaid-render.js for the page that hosts it.
//
// The window is created on the first diagram and then kept for reuse (its
// 5MB bundle is not worth parsing twice), and torn down with the main
// window so a window nobody can see never keeps the app alive.
const MERMAID_RENDER_TIMEOUT_MS = 20000;
let mermaidWindowPromise = null;

function mermaidBundlePath() {
  const base = app.isPackaged
    ? path.join(process.resourcesPath, 'thirdparty', 'mermaid')
    : path.join(__dirname, 'thirdparty', 'mermaid');
  return path.join(base, 'mermaid.min.js');
}

async function createMermaidWindow() {
  const bundle = mermaidBundlePath();
  if (!fs.existsSync(bundle)) {
    throw new Error(
      'Mermaid runtime not found. Run "npm run prepare:mermaid" (or npm start / npm run dist, which do this automatically).'
    );
  }
  const win = new BrowserWindow({
    show: false,
    width: 1400,
    height: 1000,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      // A window that is never shown is otherwise throttled, which would
      // stretch out every render for no reason.
      backgroundThrottling: false,
    },
  });
  win.on('closed', () => {
    mermaidWindowPromise = null;
  });
  await win.loadFile(path.join(__dirname, 'assets', 'mermaid-render.html'));
  // Injected rather than pulled in by a <script> tag: the bundle sits
  // outside the asar in thirdparty/, out of reach of the page's own
  // relative paths. The trailing `void 0` matters — executeJavaScript sends
  // the last expression's value back over IPC, and the bundle ends by
  // assigning the mermaid module object, which cannot be cloned: without it
  // the call never settles.
  await win.webContents.executeJavaScript(`${fs.readFileSync(bundle, 'utf-8')}
;void 0;`);
  return win;
}

function ensureMermaidWindow() {
  if (!mermaidWindowPromise) {
    mermaidWindowPromise = createMermaidWindow().catch((err) => {
      // Don't cache the failure: a later diagram should get a fresh attempt.
      mermaidWindowPromise = null;
      throw err;
    });
  }
  return mermaidWindowPromise;
}

function closeMermaidWindow() {
  const pending = mermaidWindowPromise;
  mermaidWindowPromise = null;
  if (!pending) return;
  pending
    .then((win) => {
      if (!win.isDestroyed()) win.destroy();
    })
    .catch(() => {
      /* the window never came up; nothing to close */
    });
}

async function renderMermaidSvg(source) {
  const win = await ensureMermaidWindow();
  let timer;
  try {
    return await Promise.race([
      win.webContents.executeJavaScript(`window.__renderMermaid(${JSON.stringify(source)})`),
      new Promise((resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error('Mermaid rendering timed out')),
          MERMAID_RENDER_TIMEOUT_MS
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function mermaidDiagramHtml(svg) {
  const src = `data:image/svg+xml;base64,${Buffer.from(svg, 'utf-8').toString('base64')}`;
  return `<div class="mermaid-diagram"><img src="${src}" alt="Mermaid diagram"></div>`;
}

// Every program window open now (File > New Window adds more). The hidden
// Mermaid render window is not one of them, so BrowserWindow.getAllWindows()
// is the wrong list wherever "the user's windows" are meant.
const appWindows = new Set();
// The app window the user worked in last: where a file handed over from
// outside (file association, command line) opens, and where an app menu
// command goes when no window has focus.
let lastFocusedWindow = null;

function targetWindow(win) {
  // A tab window stands for the program window it belongs to.
  if (win && !win.isDestroyed()) win = ownerOf(win);
  if (win && appWindows.has(win) && !win.isDestroyed()) return win;
  if (lastFocusedWindow && !lastFocusedWindow.isDestroyed()) return lastFocusedWindow;
  return appWindows.values().next().value || null;
}

function sendToWindow(win, channel, ...args) {
  const target = targetWindow(win);
  if (target) target.webContents.send(channel, ...args);
}

function sendToWindowWhenLoaded(win, channel, ...args) {
  const send = () => win.webContents.send(channel, ...args);
  if (win.webContents.isLoadingMainFrame()) {
    win.webContents.once('did-finish-load', send);
  } else {
    send();
  }
}

// The project folders each window's explorer has open, and the active one
// among them (webContents.id -> { roots, active }). A settings change that
// has to reload the window (see setLanguage) uses these to put the user back
// where they were instead of dropping them on the welcome screen; the
// per-project .mdviewer/state.json takes it from there and restores the open
// file, scroll offset and panel layout.
const windowProjects = new Map();

// withTabs: also the window's document tabs ({ path } in order, and
// which one is on screen), for a relaunch, after which they are gone too.
function openProjectsOf(win, { withTabs = false } = {}) {
  const entry = windowProjects.get(win.webContents.id);
  if (!entry || !entry.roots.length) return null;
  const payload = { roots: [...entry.roots], active: entry.active };
  const host = withTabs ? hostOf(win) : null;
  if (host) {
    // Tabs in tab windows come back in the program window.
    const kept = tabsOwnedBy(win).filter((tab) => TAB_KINDS[tab.kind].restoreEntry(tab));
    payload.tabs = kept.map((tab) => TAB_KINDS[tab.kind].restoreEntry(tab));
    payload.activeTab = kept.findIndex((tab) => tab.id === host.activeId);
  }
  return payload;
}
const fileWatchers = new Map(); // webContents.id -> fs.FSWatcher
// webContents.id -> Map(session key -> pty). The renderer runs a shell per
// open project and names each by its project root ('' for the home-folder
// shell it runs while no project is open).
const terminals = new Map();

// When launched by double-clicking a .md file (file association), via
// `mdviewer.exe file.md`, or via `mdviewer .` from a shell (PATH-installed),
// Windows/argv passes the path as a plain argument (see openArgFromArgv).
function extractOpenTargetFromArgv(argv, cwd) {
  const candidate = openArgFromArgv(argv, app.isPackaged);
  if (!candidate) return null;
  const resolved = path.resolve(cwd || process.cwd(), candidate);
  try {
    const stat = fs.statSync(resolved);
    if (stat.isDirectory()) return { type: 'folder', path: resolved };
    if (stat.isFile() && /\.(md|markdown)$/i.test(resolved)) return { type: 'file', path: resolved };
  } catch (err) {
    /* argument isn't a real path; ignore */
  }
  return null;
}

function openTargetInWindow(win, target) {
  if (!win) return;
  const channel = target.type === 'folder' ? 'folder:open-path' : 'file:open-path';
  sendToWindowWhenLoaded(win, channel, target.path);
}

let currentLanguage = DEFAULT_LANGUAGE;

function t(key, vars) {
  return translate(currentLanguage, key, vars);
}

function settingsFilePath() {
  return path.join(app.getPath('userData'), 'settings.json');
}

function loadSettings() {
  try {
    const raw = fs.readFileSync(settingsFilePath(), 'utf-8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (err) {
    return {};
  }
}

function saveSettings(settings) {
  const dir = path.dirname(settingsFilePath());
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(settingsFilePath(), JSON.stringify(settings, null, 2), 'utf-8');
}

const BUILTIN_KIND_EXTENSIONS = new Set([
  'md', 'markdown', 'puml', 'json', 'txt', 'log', ...Object.keys(CODE_LANGUAGE_BY_EXT),
]);

function normalizeExtensionList(list) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const result = [];
  for (const raw of list) {
    if (typeof raw !== 'string') continue;
    const ext = raw.trim().replace(/^\./, '').toLowerCase();
    if (!ext || !/^[a-z0-9]+$/.test(ext)) continue;
    if (BUILTIN_KIND_EXTENSIONS.has(ext)) continue;
    if (seen.has(ext)) continue;
    seen.add(ext);
    result.push(ext);
  }
  return result;
}

function getCustomTextExtensions() {
  return normalizeExtensionList(loadSettings().customTextExtensions);
}

function setCustomTextExtensions(list) {
  const normalized = normalizeExtensionList(list);
  saveSettings({ ...loadSettings(), customTextExtensions: normalized });
  return normalized;
}

// Hidden entries (View > Hidden Items...): files and folders whose name
// matches one of these are left out of the tree, project search and the
// terminal's link index. Matching ignores case; `*` and `?` are wildcards.
// The defaults apply until the user saves a list of their own, so removing
// them sticks.
const DEFAULT_HIDDEN_NAMES = ['.git', '.mdviewer'];

function normalizeHiddenNameList(list) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const result = [];
  for (const raw of list) {
    if (typeof raw !== 'string') continue;
    const name = raw.trim().replace(/[\\/]+$/, '');
    if (!name || /[\\/]/.test(name)) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(name);
  }
  return result;
}

function getHiddenNames() {
  const saved = loadSettings().hiddenNames;
  return Array.isArray(saved) ? normalizeHiddenNameList(saved) : [...DEFAULT_HIDDEN_NAMES];
}

let hiddenNameMatcherCache = null; // { key, test }

function hiddenNameMatcher() {
  const names = getHiddenNames();
  const key = names.join('\n');
  if (hiddenNameMatcherCache && hiddenNameMatcherCache.key === key) return hiddenNameMatcherCache.test;
  const exact = new Set();
  const patterns = [];
  for (const name of names) {
    if (/[*?]/.test(name)) {
      const source = name
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*/g, '.*')
        .replace(/\?/g, '.');
      patterns.push(new RegExp(`^${source}$`, 'i'));
    } else {
      exact.add(name.toLowerCase());
    }
  }
  const test = (entryName) =>
    exact.has(entryName.toLowerCase()) || patterns.some((re) => re.test(entryName));
  hiddenNameMatcherCache = { key, test };
  return test;
}

function setHiddenNames(list) {
  const normalized = normalizeHiddenNameList(list);
  saveSettings({ ...loadSettings(), hiddenNames: normalized });
  linkIndexCache.clear();
  return normalized;
}

// Auto save (File > Auto Save): on unless turned off. The renderer saves
// when the editor loses focus and wherever it would otherwise ask about
// unsaved changes; untitled drafts are left out (see src/renderer.js).
function getAutoSave() {
  return loadSettings().autoSave !== false;
}

function setAutoSave(enabled) {
  saveSettings({ ...loadSettings(), autoSave: !!enabled });
  for (const win of appWindows) win.webContents.send('settings:auto-save-changed', !!enabled);
  sendToAllTabs('settings:auto-save-changed', !!enabled);
}

// Viewer width limit (Settings > Limit Viewer Width by Default): on unless
// turned off. The toolbar's width toggle (↔) overrides it per project (see
// src/doc.js).
function getPreviewWidthLimit() {
  return loadSettings().previewWidthLimit !== false;
}

function setPreviewWidthLimit(enabled) {
  saveSettings({ ...loadSettings(), previewWidthLimit: !!enabled });
  sendToAllTabs('settings:preview-width-limit-changed', !!enabled);
}

// Where the source editor sits beside the viewer in edit mode (Settings >
// Editor Layout): 'horizontal' puts it on the left (the default),
// 'vertical' above the viewer. The edit-mode toolbar's layout button
// switches it too, for every tab at once.
const EDITOR_LAYOUTS = ['horizontal', 'vertical'];

function getEditorLayout() {
  const layout = loadSettings().editorLayout;
  return EDITOR_LAYOUTS.includes(layout) ? layout : 'horizontal';
}

function setEditorLayout(layout) {
  if (!EDITOR_LAYOUTS.includes(layout)) return;
  saveSettings({ ...loadSettings(), editorLayout: layout });
  buildAppMenu();
  sendToAllTabs('settings:editor-layout-changed', layout);
}

// Whether the editor and the viewer scroll together in edit mode: on unless
// turned off with the toggle on the splitter between them, for every tab
// at once.
function getScrollSync() {
  return loadSettings().scrollSync !== false;
}

function setScrollSync(enabled) {
  saveSettings({ ...loadSettings(), scrollSync: !!enabled });
  sendToAllTabs('settings:scroll-sync-changed', !!enabled);
}

function plainTextExtensionPattern() {
  const all = ['txt', 'log', ...Object.keys(CODE_LANGUAGE_BY_EXT), ...getCustomTextExtensions()];
  return new RegExp('\\.(' + all.join('|') + ')$', 'i');
}

async function reloadWindowRestoringProject(win, { ignoreCache = false } = {}) {
  // The tabs' pages go with the window page; each hands over what it holds
  // first and comes back as it was (see resetTabsAfterPageLoad).
  await snapshotTabsOf(win);
  if (win.isDestroyed()) return;
  // The fresh page comes up with all its chrome visible and no memory of
  // the fullscreen document view, so leave fullscreen here rather than
  // leaving the window stuck in it with nothing left to exit.
  if (win.isFullScreen()) {
    win.setFullScreen(false);
    win.setMenuBarVisibility(true);
  }
  // Registered before reload() so the listener is in place by the time
  // the fresh page finishes loading.
  const payload = openProjectsOf(win);
  if (payload) {
    win.webContents.once('did-finish-load', () => {
      win.webContents.send('projects:restore', payload);
    });
  }
  if (ignoreCache) win.webContents.reloadIgnoringCache();
  else win.reload();
}

// ---- Help > Reload Program (unpackaged runs only) ----
// The renderer, preload.js and everything the page loads are read from disk
// again by a window reload, so edits to those apply in this same window. The
// main process can't swap its own code, though: when one of its own source
// files (main.js and the app modules it required) changed since startup,
// the app relaunches instead and reopens the same projects. Packages in
// node_modules are left out — they change only with an npm install.
const PROCESS_STARTED_AT = Date.now();
const RESTORE_PROJECTS_ARG = '--restore-projects=';
let relaunchArgsOnQuit = null;

function mainProcessSourcesChanged() {
  const appDir = path.resolve(__dirname) + path.sep;
  const nodeModules = path.join(appDir, 'node_modules') + path.sep;
  return Object.keys(require.cache).some((file) => {
    if (!file.startsWith(appDir) || file.startsWith(nodeModules)) return false;
    try {
      return fs.statSync(file).mtimeMs > PROCESS_STARTED_AT;
    } catch (err) {
      return false;
    }
  });
}

function reloadProgram() {
  if (!appWindows.size || app.isPackaged) return;
  if (!mainProcessSourcesChanged()) {
    for (const win of appWindows) reloadWindowRestoringProject(win, { ignoreCache: true });
    return;
  }
  // argv[1] is the app path (`electron .`). Switches carry over (a
  // --user-data-dir especially: without it the new process would join
  // another instance), but an open target from the original command line
  // is dropped: the restore list already holds every project that was
  // open, and reopening it would steal the active one.
  const args = [
    process.argv[1],
    ...process.argv
      .slice(2)
      .filter((a) => a.startsWith('-') && a !== '--addon-dev' && !a.startsWith('--addon-dev=') && !a.startsWith(RESTORE_PROJECTS_ARG)),
    ...addonDevDirs().map((dir) => `--addon-dev=${dir}`),
  ];
  // One entry per window, null for a window with no project open, so the
  // relaunch comes back with as many windows as there were.
  const payload = [...appWindows].map((win) => openProjectsOf(win, { withTabs: true }));
  if (payload.length > 1 || payload[0]) {
    args.push(RESTORE_PROJECTS_ARG + Buffer.from(JSON.stringify(payload), 'utf-8').toString('base64'));
  }
  // Registered for 'will-quit' rather than with app.relaunch() right away:
  // closing can still be cancelled at the unsaved-changes prompt, and a
  // relaunch registered up front would fire whenever the app quits later.
  relaunchArgsOnQuit = args;
  app.quit();
}

app.on('will-quit', () => {
  if (relaunchArgsOnQuit) app.relaunch({ args: relaunchArgsOnQuit });
});

// The first window is already open; every further entry gets a window of
// its own.
function restoreProjectsFromArgv(argv, firstWindow) {
  const arg = argv.find((a) => a.startsWith(RESTORE_PROJECTS_ARG));
  if (!arg || !firstWindow) return;
  let payload;
  try {
    payload = JSON.parse(Buffer.from(arg.slice(RESTORE_PROJECTS_ARG.length), 'base64').toString('utf-8'));
  } catch (err) {
    return;
  }
  // A process from before multiple windows hands over one window's
  // { roots, active } on its own.
  const entries = Array.isArray(payload) ? payload : [payload];
  entries.forEach((entry, i) => {
    const win = i === 0 ? firstWindow : createWindow();
    if (entry && Array.isArray(entry.roots) && entry.roots.length) {
      sendToWindowWhenLoaded(win, 'projects:restore', entry);
    }
  });
}

function setLanguage(lang) {
  if (!SUPPORTED_LANGUAGES.includes(lang) || lang === currentLanguage) return;
  currentLanguage = lang;
  saveSettings({ ...loadSettings(), language: lang });
  // Add-on names and titles come in the app's language.
  if (addonRegistry) addonRegistry.rescan({ language: lang });
  buildAppMenu();
  // The renderer applies its string table once at startup, so a reload is
  // still the way to re-translate everything already on screen.
  for (const win of appWindows) reloadWindowRestoringProject(win);
}

const THEME_SOURCES = ['system', 'light', 'dark'];

function setThemeSource(source) {
  if (!THEME_SOURCES.includes(source) || source === nativeTheme.themeSource) return;
  nativeTheme.themeSource = source;
  saveSettings({ ...loadSettings(), themeSource: source });
  buildAppMenu();
  // No reload here: every themed rule in the shell and in the preview
  // iframe is a prefers-color-scheme media query, and setting
  // nativeTheme.themeSource propagates to the live window (iframe
  // included), so both repaint in place. Reloading instead would throw
  // away the open project, the current document and any unsaved edits.
}

function recentProjectsFilePath() {
  return path.join(app.getPath('userData'), 'recent-projects.json');
}

function loadRecentProjects() {
  try {
    const raw = fs.readFileSync(recentProjectsFilePath(), 'utf-8');
    const list = JSON.parse(raw);
    return Array.isArray(list) ? list : [];
  } catch (err) {
    return [];
  }
}

function saveRecentProjects(list) {
  const dir = path.dirname(recentProjectsFilePath());
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(recentProjectsFilePath(), JSON.stringify(list, null, 2), 'utf-8');
}

function addRecentProject(rootPath) {
  const normalized = path.resolve(rootPath);
  let list = loadRecentProjects();
  list = list.filter((p) => path.resolve(p) !== normalized);
  list.unshift(normalized);
  list = list.slice(0, MAX_RECENT_PROJECTS);
  saveRecentProjects(list);
  return list;
}

function removeRecentProject(rootPath) {
  const normalized = path.resolve(rootPath);
  const list = loadRecentProjects().filter((p) => path.resolve(p) !== normalized);
  saveRecentProjects(list);
  return list;
}

function toFileUrl(p) {
  let resolved = path.resolve(p).replace(/\\/g, '/');
  if (!resolved.startsWith('/')) resolved = '/' + resolved;
  return 'file://' + encodeURI(resolved).replace(/#/g, '%23');
}

// Wiki-style links omit the extension (e.g. `[Setup](guide/setup)`). When a
// link has no extension and isn't a directory reference, resolve it as a
// ".md" page if that file actually exists; otherwise leave it as-is so
// links to real extension-less files (Makefile, LICENSE, ...) still work.
function safeDecodeUri(text) {
  try {
    return decodeURIComponent(text);
  } catch (e) {
    return text;
  }
}

function resolveInternalLinkPath(baseDir, relPath) {
  const absPath = path.resolve(baseDir, relPath);
  if (relPath.endsWith('/') || path.extname(relPath)) return absPath;
  const withMdExt = absPath + '.md';
  return fs.existsSync(withMdExt) ? withMdExt : absPath;
}

// CommonMark only lets `**` close right after punctuation when whitespace or
// more punctuation follows, so in Korean, where particles attach with no
// space, `**함수()**를` or `**"인용"**이` stays literal. A CJK character on
// the outer side of a delimiter run is treated like whitespace for that
// check (the direction of CommonMark's CJK-friendly amendment); runs with
// no CJK neighbour keep the stock behaviour.
const CJK_CHAR_RE = /[\p{Script=Hangul}\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;

function useCjkFriendlyEmphasis(md) {
  const { isWhiteSpace, isMdAsciiPunct, isPunctChar } = md.utils;
  const BaseState = md.inline.State;
  class CjkFriendlyState extends BaseState {
    scanDelims(start, canSplitWord) {
      const result = super.scanDelims(start, canSplitWord);
      const lastChar = start > 0 ? Array.from(this.src.slice(Math.max(0, start - 2), start)).pop() : ' ';
      const pos = start + result.length;
      const nextChar = pos < this.posMax ? String.fromCodePoint(this.src.codePointAt(pos)) : ' ';
      const isLastCjk = CJK_CHAR_RE.test(lastChar);
      const isNextCjk = CJK_CHAR_RE.test(nextChar);
      if (!isLastCjk && !isNextCjk) return result;

      const isPunct = (ch) => isMdAsciiPunct(ch.codePointAt(0)) || isPunctChar(ch);
      const isLastPunct = isPunct(lastChar);
      const isNextPunct = isPunct(nextChar);
      const isLastSpace = isWhiteSpace(lastChar.codePointAt(0));
      const isNextSpace = isWhiteSpace(nextChar.codePointAt(0));
      const leftFlanking = !isNextSpace && (!isNextPunct || isLastSpace || isLastPunct || isLastCjk);
      const rightFlanking = !isLastSpace && (!isLastPunct || isNextSpace || isNextPunct || isNextCjk);
      // `_` still never opens or closes inside a word, CJK or not, so file
      // names like 보고서_초안_최종.md stay as written.
      return {
        can_open: leftFlanking && (canSplitWord || !rightFlanking || isLastPunct),
        can_close: rightFlanking && (canSplitWord || !leftFlanking || isNextPunct),
        length: result.length,
      };
    }
  }
  md.inline.State = CjkFriendlyState;
}

function createMarkdownRenderer(baseDir) {
  const md = new MarkdownIt({
    html: true,
    linkify: true,
    typographer: true,
    breaks: false,
    highlight(str, lang) {
      if (lang && hljs.getLanguage(lang)) {
        try {
          return hljs.highlight(str, { language: lang }).value;
        } catch (e) {
          /* fall through to default escaping */
        }
      }
      return md.utils.escapeHtml(str);
    },
  })
    .use(taskLists, { enabled: true, label: true })
    // GitLab/GitHub wiki footnotes: `[^1]` in the text, `[^1]: ...` anywhere
    // in the document, collected into a numbered list at the end.
    .use(footnote);
  // Show the reference as a bare superscript number like GitLab does, not
  // the plugin's default "[1]" ("[1:1]" for a repeated reference).
  md.renderer.rules.footnote_caption = (tokens, idx) => String(tokens[idx].meta.id + 1);
  useCjkFriendlyEmphasis(md);

  // Tags block-level elements with their originating source line range, so
  // the renderer can map a match found while searching the preview (see
  // docFind in src/renderer.js) back to an exact position in the source
  // editor — token.map is [startLine, endLine) in the original markdown.
  md.core.ruler.push('inject_source_line', (state) => {
    state.tokens.forEach((token) => {
      if (token.map && !token.type.endsWith('_close')) {
        token.attrSet('data-source-line', String(token.map[0]));
        token.attrSet('data-source-endline', String(token.map[1]));
      }
    });
  });

  const defaultFenceRule =
    md.renderer.rules.fence ||
    function (tokens, idx, options, env, self) {
      return self.renderToken(tokens, idx, options);
    };
  md.renderer.rules.fence = (tokens, idx, options, env, self) => {
    const token = tokens[idx];
    const lang = token.info.trim().split(/\s+/)[0].toLowerCase();
    if (PLANTUML_FENCE_LANGS.has(lang)) {
      // PlantUML rendering is async (see renderPlantUmlSvg) but markdown-it's
      // own render pass is synchronous, so every puml/plantuml fence in this
      // document is pre-rendered up front by renderMarkdownText and stashed
      // on env — this rule just looks the result up.
      return (env.pumlResults && env.pumlResults.get(token)) || '';
    }
    if (MERMAID_FENCE_LANGS.has(lang)) {
      // Pre-rendered up front by renderMarkdownText, for the same reason as
      // puml fences: rendering is async, this rule is not.
      return (env.mermaidResults && env.mermaidResults.get(token)) || '';
    }
    return defaultFenceRule(tokens, idx, options, env, self);
  };

  const defaultImageRule =
    md.renderer.rules.image ||
    function (tokens, idx, options, env, self) {
      return self.renderToken(tokens, idx, options);
    };
  md.renderer.rules.image = (tokens, idx, options, env, self) => {
    const token = tokens[idx];
    const srcIndex = token.attrIndex('src');
    if (srcIndex >= 0) {
      const src = token.attrs[srcIndex][1];
      if (!/^([a-z]+:)?\/\//i.test(src) && !src.startsWith('data:')) {
        token.attrs[srcIndex][1] = toFileUrl(path.resolve(baseDir, src));
      }
    }
    return defaultImageRule(tokens, idx, options, env, self);
  };

  const defaultLinkOpenRule =
    md.renderer.rules.link_open ||
    function (tokens, idx, options, env, self) {
      return self.renderToken(tokens, idx, options);
    };
  md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
    const token = tokens[idx];
    const hrefIndex = token.attrIndex('href');
    if (hrefIndex >= 0) {
      const href = token.attrs[hrefIndex][1];
      if (!/^([a-z]+:)?\/\//i.test(href) && !href.startsWith('#') && !href.startsWith('mailto:')) {
        // relative link: resolve to an absolute path (+ optional #hash) so the
        // renderer can intercept the click and either open it in-app or via the OS
        // markdown-it has already percent-encoded the href, so a Korean file
        // name or "#설치-방법" would otherwise never match a path on disk or
        // a heading id.
        const hashAt = href.indexOf('#');
        const relPath = safeDecodeUri(hashAt === -1 ? href : href.slice(0, hashAt));
        const hash = hashAt === -1 ? '' : safeDecodeUri(href.slice(hashAt + 1));
        const absPath = relPath ? resolveInternalLinkPath(baseDir, relPath) : '';
        token.attrSet('data-internal-href', absPath + (hash ? '#' + hash : ''));
      }
    }
    return defaultLinkOpenRule(tokens, idx, options, env, self);
  };

  return md;
}

function sanitizeMarkdownHtml(rawHtml) {
  return sanitizeHtml(rawHtml, {
    allowedTags: sanitizeHtml.defaults.allowedTags.concat([
      'img', 'h1', 'h2', 'input', 'details', 'summary', 'video', 'audio', 'source', 'button',
    ]),
    allowedAttributes: {
      ...sanitizeHtml.defaults.allowedAttributes,
      '*': [
        'id', 'class', 'style', 'title', 'data-internal-href', 'data-zoom', 'data-fit',
        'data-source-line', 'data-source-endline',
      ],
      a: ['href', 'name', 'target', 'rel', 'data-internal-href'],
      img: ['src', 'alt', 'title', 'width', 'height'],
      input: ['type', 'checked', 'disabled'],
      video: ['src', 'controls', 'width', 'height'],
      audio: ['src', 'controls'],
      source: ['src', 'type'],
      button: ['type'],
    },
    allowedSchemes: ['http', 'https', 'mailto', 'file', 'data'],
    allowProtocolRelative: false,
    allowedSchemesByTag: { img: ['http', 'https', 'file', 'data'] },
  });
}

async function renderMarkdownText(text, baseDir, requestId) {
  const md = createMarkdownRenderer(baseDir);
  const env = {};
  const tokens = md.parse(text, env);

  const fenceLang = (token) => token.info.trim().split(/\s+/)[0].toLowerCase();
  const pumlTokens = tokens.filter(
    (token) => token.type === 'fence' && PLANTUML_FENCE_LANGS.has(fenceLang(token))
  );
  const pumlResults = new Map();
  await Promise.all(
    pumlTokens.map(async (token) => {
      const controller = new AbortController();
      registerAbort(requestId, controller);
      try {
        const src = await plantumlImageSrc(token.content, controller.signal);
        pumlResults.set(token, plantumlDiagramHtml(src) + '\n');
      } catch (err) {
        pumlResults.set(token, `<div class="plantuml-diagram plantuml-error">${md.utils.escapeHtml(err.message)}</div>\n`);
      } finally {
        unregisterAbort(requestId, controller);
      }
    })
  );
  env.pumlResults = pumlResults;

  // Mermaid diagrams render one at a time rather than in parallel like the
  // puml ones: they all go through the single hidden render window, whose
  // page lays every diagram out in the same host element.
  const mermaidResults = new Map();
  for (const token of tokens) {
    if (token.type !== 'fence' || !MERMAID_FENCE_LANGS.has(fenceLang(token))) continue;
    try {
      mermaidResults.set(token, mermaidDiagramHtml(await renderMermaidSvg(token.content)) + '\n');
    } catch (err) {
      mermaidResults.set(
        token,
        `<div class="mermaid-diagram mermaid-error">${md.utils.escapeHtml(err.message)}</div>\n`
      );
    }
  }
  env.mermaidResults = mermaidResults;

  const html = md.renderer.render(tokens, md.options, env);
  return sanitizeMarkdownHtml(html);
}

async function renderMarkdownFile(filePath, requestId) {
  const raw = fs.readFileSync(filePath, 'utf-8');
  return renderMarkdownText(raw, path.dirname(filePath), requestId);
}

async function renderPlantUmlText(text, requestId) {
  const controller = new AbortController();
  registerAbort(requestId, controller);
  try {
    const src = await plantumlImageSrc(text, controller.signal);
    return plantumlDiagramHtml(src);
  } catch (err) {
    return `<div class="plantuml-diagram plantuml-error">${escapeHtmlText(err.message)}</div>`;
  } finally {
    unregisterAbort(requestId, controller);
  }
}

async function renderPlantUmlFile(filePath, requestId) {
  const raw = fs.readFileSync(filePath, 'utf-8');
  return renderPlantUmlText(raw, requestId);
}

function escapeHtmlText(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Renders one JSON value (and, recursively, its children) as a collapsible
// <li>. Expand/collapse and value editing are wired up by the renderer via
// event delegation (the preview iframe has no allow-scripts, so this HTML
// must stay purely structural, no inline handlers). Every node carries a
// data-path attribute (a JSON-encoded array of string keys / numeric
// indices) so the renderer can show "where am I" and, for leaf values,
// write an edit back to the right spot in the source.
function jsonValueHtml(value, keyLabel, keyClass, isLast, isArrayIndex, path) {
  const comma = isLast ? '' : ',';
  const keyHtml =
    keyLabel !== null
      ? `<span class="${keyClass}">${escapeHtmlText(isArrayIndex ? keyLabel : JSON.stringify(keyLabel))}</span><span class="json-colon">: </span>`
      : '';
  const pathAttr = `data-path="${escapeHtmlText(JSON.stringify(path))}"`;

  if (value === null) {
    return `<li class="json-leaf" ${pathAttr}>${keyHtml}<span class="json-null json-editable-value">null</span>${comma}</li>`;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) {
      return `<li class="json-leaf" ${pathAttr}>${keyHtml}<span class="json-bracket">[]</span>${comma}</li>`;
    }
    const children = value
      .map((v, i) => jsonValueHtml(v, `[${i}]`, 'json-index', i === value.length - 1, true, [...path, i]))
      .join('');
    const count = `${value.length} item${value.length === 1 ? '' : 's'}`;
    return (
      `<li class="json-branch" ${pathAttr}><span class="json-toggle" role="button" tabindex="0" aria-label="toggle"></span>` +
      `${keyHtml}<span class="json-bracket">[</span><span class="json-summary">${count}</span>` +
      `<ul class="json-children">${children}</ul>` +
      `<span class="json-bracket json-closing">]</span>${comma}</li>`
    );
  }
  const type = typeof value;
  if (type === 'object') {
    const keys = Object.keys(value);
    if (keys.length === 0) {
      return `<li class="json-leaf" ${pathAttr}>${keyHtml}<span class="json-brace">{}</span>${comma}</li>`;
    }
    const children = keys
      .map((k, i) => jsonValueHtml(value[k], k, 'json-key', i === keys.length - 1, false, [...path, k]))
      .join('');
    const count = `${keys.length} key${keys.length === 1 ? '' : 's'}`;
    return (
      `<li class="json-branch" ${pathAttr}><span class="json-toggle" role="button" tabindex="0" aria-label="toggle"></span>` +
      `${keyHtml}<span class="json-brace">{</span><span class="json-summary">${count}</span>` +
      `<ul class="json-children">${children}</ul>` +
      `<span class="json-brace json-closing">}</span>${comma}</li>`
    );
  }
  if (type === 'string') {
    return (
      `<li class="json-leaf" ${pathAttr}>${keyHtml}` +
      `<span class="json-string json-editable-value">${escapeHtmlText(JSON.stringify(value))}</span>${comma}</li>`
    );
  }
  // number / boolean
  return (
    `<li class="json-leaf" ${pathAttr}>${keyHtml}` +
    `<span class="json-${type} json-editable-value">${value}</span>${comma}</li>`
  );
}

function renderJsonText(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return `<div class="json-error">${escapeHtmlText(err.message)}</div>`;
  }
  return `<div class="json-tree"><ul class="json-root">${jsonValueHtml(parsed, null, null, true, false, [])}</ul></div>`;
}

function renderJsonFile(filePath) {
  const raw = fs.readFileSync(filePath, 'utf-8');
  return renderJsonText(raw);
}

// A source file renders as one fenced code block of its language (the same
// markup markdown-it gives a fence, so it picks up the same styling).
function renderPlainText(text, filePath) {
  const lang = codeLanguageOf(filePath, hljs);
  if (lang) {
    let body = null;
    if (text.length <= CODE_HIGHLIGHT_MAX_LENGTH) {
      try {
        body = hljs.highlight(text, { language: lang, ignoreIllegals: true }).value;
      } catch (e) {
        /* fall through to escaping */
      }
    }
    return `<pre class="code-view"><code class="language-${lang}">${body ?? escapeHtmlText(text)}</code></pre>`;
  }
  return `<pre class="plaintext-view">${escapeHtmlText(text)}</pre>`;
}

function renderPlainTextFile(filePath) {
  const raw = fs.readFileSync(filePath, 'utf-8');
  return renderPlainText(raw, filePath);
}

function isHidden(name) {
  return name.startsWith('.');
}

function listDir(dirPath) {
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  const plainTextPattern = plainTextExtensionPattern();
  const isUserHidden = hiddenNameMatcher();
  const items = entries
    // Hidden folders (.vscode, ...) are listed so they can be browsed, and
    // the tree shows them dimmed; hidden files stay out, and so does
    // anything on the user's hidden list (.git, .mdviewer by default).
    .filter((e) => (!isHidden(e.name) || e.isDirectory()) && !isUserHidden(e.name))
    .map((e) => {
      const full = path.join(dirPath, e.name);
      const isDir = e.isDirectory();
      // Lets the tree fade documents nobody has touched in a while. A file
      // that can't be stat'ed (locked, vanished mid-listing) just isn't faded.
      let mtimeMs = null;
      if (!isDir) {
        try {
          mtimeMs = fs.statSync(full).mtimeMs;
        } catch (err) {
          /* leave it unfaded */
        }
      }
      return {
        name: e.name,
        path: full,
        isDir,
        isHidden: isHidden(e.name),
        mtimeMs,
        isMarkdown: !isDir && /\.(md|markdown)$/i.test(e.name),
        isPuml: !isDir && /\.puml$/i.test(e.name),
        isJson: !isDir && /\.json$/i.test(e.name),
        isHtml: !isDir && /\.(html?|xhtml)$/i.test(e.name),
        isPdf: !isDir && /\.pdf$/i.test(e.name),
        isPlainText: !isDir && plainTextPattern.test(e.name),
      };
    });
  items.sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
  });
  return items;
}

// ---------------------------------------------------------------------
// Project-wide document search
// ---------------------------------------------------------------------

// Only the text-ish documents the app can actually open are searched — a
// project folder can also hold images and other binaries, and reading those
// just to throw the bytes away would dominate the cost of a search.
const SEARCH_SKIP_DIRS = new Set(['node_modules']);
const SEARCH_MAX_FILE_BYTES = 2 * 1024 * 1024;
const SEARCH_MAX_MATCHES_PER_FILE = 200;
const SEARCH_MAX_TOTAL_MATCHES = 2000;
const SEARCH_MAX_LINE_CHARS = 400;
// How much of the line to keep in front of the first match when a very long
// line has to be windowed down to SEARCH_MAX_LINE_CHARS.
const SEARCH_LINE_LEAD_CHARS = 40;

// Searches the renderer has given up on (the user typed another character,
// or closed the panel) land here; the walk below checks the set between
// files so a stale search stops reading the disk instead of running to
// completion for a result nobody will look at.
const canceledSearches = new Set();

function escapeRegExpText(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Whole-word guards are written as lookarounds over Unicode letter/number
// classes rather than \b, so they behave sensibly for non-ASCII (e.g.
// Korean) queries. \p{...} needs the 'u' flag, which in turn rejects some
// otherwise-valid patterns the user may type in regex mode — hence the
// plain-ASCII fallbacks.
function buildSearchRegex(query, { caseSensitive = false, wholeWord = false, useRegex = false } = {}) {
  const source = useRegex ? query : escapeRegExpText(query);
  const flags = caseSensitive ? '' : 'i';
  if (wholeWord) {
    try {
      return new RegExp(`(?<![\\p{L}\\p{N}_])(?:${source})(?![\\p{L}\\p{N}_])`, 'gu' + flags);
    } catch (err) {
      return new RegExp(`\\b(?:${source})\\b`, 'g' + flags);
    }
  }
  try {
    return new RegExp(source, 'gu' + flags);
  } catch (err) {
    return new RegExp(source, 'g' + flags);
  }
}

// Collects every match on one line as [start, end] index pairs. A
// zero-length match (from a user regex like "a*") would spin forever on its
// own, so lastIndex is nudged past those by hand.
function matchRangesInLine(regex, line, limit) {
  const ranges = [];
  regex.lastIndex = 0;
  let m;
  while ((m = regex.exec(line)) !== null) {
    if (m[0].length === 0) {
      regex.lastIndex += 1;
      continue;
    }
    ranges.push([m.index, m.index + m[0].length]);
    if (ranges.length >= limit) break;
  }
  return ranges;
}

// Trims the indentation off a matched line and, if it's still enormous,
// keeps only a window around the first match — shifting the match ranges to
// stay aligned with the text actually sent to the renderer.
function trimMatchedLine(line, ranges) {
  const leading = line.length - line.trimStart().length;
  let text = line.slice(leading).trimEnd();
  let shift = leading;

  if (text.length > SEARCH_MAX_LINE_CHARS) {
    const firstStart = Math.max(0, ranges[0][0] - leading);
    const from = Math.max(0, firstStart - SEARCH_LINE_LEAD_CHARS);
    const to = from + SEARCH_MAX_LINE_CHARS;
    const prefix = from > 0 ? '…' : '';
    const suffix = to < text.length ? '…' : '';
    text = prefix + text.slice(from, to) + suffix;
    shift += from - prefix.length;
  }

  const shifted = [];
  for (const [start, end] of ranges) {
    const s = start - shift;
    const e = end - shift;
    if (s >= 0 && e <= text.length) shifted.push([s, e]);
  }
  return { text, ranges: shifted };
}

function searchMatchesInContent(content, regex, remainingTotal) {
  const lines = content.split(/\r\n|\r|\n/);
  const matches = [];
  let matchCount = 0;
  let truncated = false;

  for (let i = 0; i < lines.length; i++) {
    const budget = Math.min(SEARCH_MAX_MATCHES_PER_FILE, remainingTotal) - matchCount;
    if (budget <= 0) {
      truncated = true;
      break;
    }
    const ranges = matchRangesInLine(regex, lines[i], budget);
    if (!ranges.length) continue;
    const trimmed = trimMatchedLine(lines[i], ranges);
    if (!trimmed.ranges.length) continue;
    // `ordinal` is the match's position among all matches in the file, in
    // document order — the renderer uses it to jump to the right occurrence
    // for file kinds (JSON, plain text) whose rendered output carries no
    // source-line markers.
    matches.push({ line: i, text: trimmed.text, ranges: trimmed.ranges, ordinal: matchCount });
    matchCount += ranges.length;
  }

  return { matches, matchCount, truncated };
}

async function searchProjectDocuments(rootPath, query, options = {}) {
  const searchId = options.searchId || null;
  let regex;
  try {
    regex = buildSearchRegex(query, options);
  } catch (err) {
    return { ok: false, invalidPattern: true, error: err.message };
  }

  const plainTextPattern = plainTextExtensionPattern();
  const isSearchableFile = (name) =>
    /\.(md|markdown|puml|json)$/i.test(name) || plainTextPattern.test(name);
  const isCanceled = () => !!searchId && canceledSearches.has(searchId);
  const isUserHidden = hiddenNameMatcher();

  const files = [];
  let totalMatches = 0;
  let truncated = false;

  async function walk(dir) {
    if (truncated || isCanceled()) return;
    let entries;
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch (err) {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));

    // Files in this folder first, then its subfolders, so results come back
    // grouped the same way the tree shows them.
    const subDirs = [];
    for (const entry of entries) {
      if (isHidden(entry.name) || isUserHidden(entry.name)) continue;
      if (entry.isDirectory()) {
        if (!SEARCH_SKIP_DIRS.has(entry.name.toLowerCase())) subDirs.push(path.join(dir, entry.name));
        continue;
      }
      if (!entry.isFile() || !isSearchableFile(entry.name)) continue;
      if (truncated || isCanceled()) return;

      const full = path.join(dir, entry.name);
      let content;
      try {
        const stat = await fs.promises.stat(full);
        if (stat.size > SEARCH_MAX_FILE_BYTES) continue;
        content = await fs.promises.readFile(full, 'utf-8');
      } catch (err) {
        continue;
      }
      // A NUL byte up front means this isn't really text, whatever the
      // extension claims (e.g. a binary blob saved as .log).
      if (content.slice(0, 8192).includes('\u0000')) continue;

      const result = searchMatchesInContent(content, regex, SEARCH_MAX_TOTAL_MATCHES - totalMatches);
      if (!result.matches.length) continue;

      files.push({
        path: full,
        name: entry.name,
        relDir: path.relative(rootPath, dir),
        matches: result.matches,
        matchCount: result.matchCount,
        truncated: result.truncated,
      });
      totalMatches += result.matchCount;
      if (totalMatches >= SEARCH_MAX_TOTAL_MATCHES) {
        truncated = true;
        return;
      }
    }

    for (const subDir of subDirs) {
      if (truncated || isCanceled()) return;
      await walk(subDir);
    }
  }

  const canceledMidway = await (async () => {
    try {
      await walk(rootPath);
      return isCanceled();
    } finally {
      if (searchId) canceledSearches.delete(searchId);
    }
  })();

  if (canceledMidway) return { ok: true, canceled: true, files: [], totalMatches: 0, truncated: false };
  return { ok: true, canceled: false, files, totalMatches, truncated };
}

function projectCssPath(rootPath) {
  return path.join(rootPath, CONFIG_DIR_NAME, CSS_FILE_NAME);
}

function loadProjectCss(rootPath) {
  const cssPath = projectCssPath(rootPath);
  if (fs.existsSync(cssPath)) {
    return fs.readFileSync(cssPath, 'utf-8');
  }
  const defaultPath = path.join(__dirname, 'assets', 'default-user-css.css');
  return fs.readFileSync(defaultPath, 'utf-8');
}

function saveProjectCss(rootPath, css) {
  const dir = path.join(rootPath, CONFIG_DIR_NAME);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(projectCssPath(rootPath), css, 'utf-8');
}

const STATE_FILE_NAME = 'state.json';

function projectStatePath(rootPath) {
  return path.join(rootPath, CONFIG_DIR_NAME, STATE_FILE_NAME);
}

function loadProjectState(rootPath) {
  try {
    const raw = fs.readFileSync(projectStatePath(rootPath), 'utf-8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (err) {
    return {};
  }
}

// A file opened from outside the app (file association, command line)
// usually belongs to a project somewhere above it. The nearest ancestor
// folder holding a .mdviewer config folder is that project; null when
// there is none, so the caller falls back to the file's own folder.
function findProjectRootForFile(filePath) {
  let dir = path.dirname(path.resolve(filePath));
  for (;;) {
    try {
      if (fs.statSync(path.join(dir, CONFIG_DIR_NAME)).isDirectory()) return dir;
    } catch (err) {
      /* no config folder here; keep walking up */
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

// How long a document's remembered scroll offset is kept (the tabs drop
// older ones when they read them, see restoreScrollPosition in doc.js).
const SCROLL_POSITION_MAX_AGE_MS = 24 * 60 * 60 * 1000;

// Per file, the newer of two remembered scroll offsets.
function mergeScrollPositions(saved, incoming) {
  const merged = {};
  const cutoff = Date.now() - SCROLL_POSITION_MAX_AGE_MS;
  for (const source of [saved, incoming]) {
    if (!source || typeof source !== 'object') continue;
    for (const [file, entry] of Object.entries(source)) {
      if (!entry || !(entry.savedAt >= cutoff)) continue;
      if (!merged[file] || merged[file].savedAt < entry.savedAt) merged[file] = entry;
    }
  }
  return merged;
}

// Several pages write a project's state, each its own keys: the window page
// (the CSS editor's switch and pane) and every tab of the project (open
// file, scroll offsets, zoom). Each write is merged into what is on disk,
// so none of them overwrites another's part.
function saveProjectState(rootPath, patch) {
  const current = loadProjectState(rootPath);
  const merged = { ...current, ...patch };
  if (patch && patch.scrollPositions) {
    merged.scrollPositions = mergeScrollPositions(current.scrollPositions, patch.scrollPositions);
  }
  const dir = path.join(rootPath, CONFIG_DIR_NAME);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(projectStatePath(rootPath), JSON.stringify(merged, null, 2), 'utf-8');
}

const MAX_RECENT_MENU_ITEMS = 5;

function buildAppMenu() {
  const recentItems = loadRecentProjects().slice(0, MAX_RECENT_MENU_ITEMS);
  const recentSubmenu =
    recentItems.length > 0
      ? recentItems.map((p) => ({
          label: p,
          click: (item, win) => sendToWindow(win, 'menu:open-recent', p),
        }))
      : [{ label: t('menu.noRecentProjects'), enabled: false }];

  const menu = Menu.buildFromTemplate([
    {
      label: t('menu.file'),
      submenu: [
        {
          label: t('menu.newWindow'),
          accelerator: 'CmdOrCtrl+Shift+N',
          click: () => createWindow(),
        },
        { type: 'separator' },
        {
          label: t('menu.newDocument'),
          accelerator: 'CmdOrCtrl+N',
          click: (item, win) => {
            const host = docHostFor(win);
            if (host) createTab(host, { draft: true });
          },
        },
        { type: 'separator' },
        {
          label: t('menu.openFolder'),
          accelerator: 'CmdOrCtrl+O',
          click: (item, win) => sendToWindow(win, 'menu:open-folder'),
        },
        {
          label: t('menu.openFile'),
          accelerator: 'CmdOrCtrl+Shift+O',
          click: (item, win) => sendToWindow(win, 'menu:open-file'),
        },
        { type: 'separator' },
        {
          label: t('menu.save'),
          accelerator: 'CmdOrCtrl+S',
          click: (item, win) => sendToActiveDoc(win, 'menu:save-file'),
        },
        {
          label: t('menu.autoSave'),
          type: 'checkbox',
          checked: getAutoSave(),
          click: (item) => setAutoSave(item.checked),
        },
        {
          label: t('menu.closeDocument'),
          accelerator: 'CmdOrCtrl+W',
          click: (item, win) => closeTab(activeTabOf(docHostFor(win))),
        },
        {
          label: t('menu.moveTabToNewWindow'),
          click: (item, win) => {
            const tab = activeTabOf(docHostFor(win));
            if (tab) detachTab(tab);
          },
        },
        { type: 'separator' },
        {
          label: t('menu.exportPdf'),
          click: (item, win) => sendToActiveDoc(win, 'menu:export-pdf'),
        },
        { type: 'separator' },
        {
          label: t('menu.recentProjects'),
          submenu: recentSubmenu,
        },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: t('menu.view'),
      submenu: [
        {
          label: t('menu.find'),
          accelerator: 'CmdOrCtrl+F',
          click: (item, win) => sendToActiveDoc(win, 'menu:toggle-find', undefined, { focus: true }),
        },
        {
          label: t('menu.searchProject'),
          accelerator: 'CmdOrCtrl+Shift+F',
          click: (item, win) => sendToWindow(win, 'menu:search-project'),
        },
        { type: 'separator' },
        {
          label: t('menu.toggleCssEditor'),
          accelerator: 'CmdOrCtrl+E',
          click: (item, win) => sendToWindow(win, 'menu:toggle-css-editor'),
        },
        {
          label: t('menu.toggleEditMode'),
          accelerator: 'CmdOrCtrl+Shift+E',
          click: (item, win) => sendToActiveDoc(win, 'menu:toggle-edit-mode', undefined, { focus: true }),
        },
        {
          label: t('menu.toggleTerminal'),
          accelerator: 'CmdOrCtrl+`',
          click: (item, win) => sendToWindow(win, 'menu:toggle-terminal'),
        },
        { type: 'separator' },
        {
          label: t('menu.nextTab'),
          accelerator: 'Ctrl+Tab',
          click: (item, win) => cycleTab(win, 1),
        },
        {
          label: t('menu.prevTab'),
          accelerator: 'Ctrl+Shift+Tab',
          click: (item, win) => cycleTab(win, -1),
        },
        { type: 'separator' },
        {
          label: t('menu.fullscreenDocument'),
          accelerator: 'F11',
          click: (item, win) => sendToActiveDoc(win, 'menu:toggle-document-fullscreen'),
        },
        { type: 'separator' },
        {
          label: t('menu.reload'),
          accelerator: 'CmdOrCtrl+R',
          click: (item, win) => {
            const target = targetWindow(win);
            if (target) reloadWindowRestoringProject(target);
          },
        },
        {
          // The page with the keyboard: a program window's (its tabs are
          // frames in it) or a tab window's.
          label: t('menu.toggleDevTools'),
          accelerator: 'Ctrl+Shift+I',
          click: () => {
            const contents = webContents.getFocusedWebContents();
            if (contents) contents.toggleDevTools();
          },
        },
      ],
    },
    {
      label: t('menu.addons'),
      submenu: [
        { label: t('menu.manageAddons'), click: (item, win) => sendToWindow(win, 'menu:manage-addons') },
        { label: t('menu.rescanAddons'), click: () => rescanAddons() },
        ...addonTabMenuItems((choice, win) => openAddonTab(docHostFor(win), choice.addonId, choice.tabId)),
      ],
    },
    {
      label: t('menu.settings'),
      submenu: [
        {
          label: t('menu.language'),
          submenu: [
            {
              label: t('menu.languageEnglish'),
              type: 'radio',
              checked: currentLanguage === 'en',
              click: () => setLanguage('en'),
            },
            {
              label: t('menu.languageKorean'),
              type: 'radio',
              checked: currentLanguage === 'ko',
              click: () => setLanguage('ko'),
            },
          ],
        },
        {
          label: t('menu.theme'),
          submenu: [
            {
              label: t('menu.themeSystem'),
              type: 'radio',
              checked: nativeTheme.themeSource === 'system',
              click: () => setThemeSource('system'),
            },
            {
              label: t('menu.themeLight'),
              type: 'radio',
              checked: nativeTheme.themeSource === 'light',
              click: () => setThemeSource('light'),
            },
            {
              label: t('menu.themeDark'),
              type: 'radio',
              checked: nativeTheme.themeSource === 'dark',
              click: () => setThemeSource('dark'),
            },
          ],
        },
        {
          label: t('menu.previewWidthLimit'),
          type: 'checkbox',
          checked: getPreviewWidthLimit(),
          click: (item) => setPreviewWidthLimit(item.checked),
        },
        {
          label: t('menu.editorLayout'),
          submenu: [
            {
              label: t('menu.editorLayoutHorizontal'),
              type: 'radio',
              checked: getEditorLayout() === 'horizontal',
              click: () => setEditorLayout('horizontal'),
            },
            {
              label: t('menu.editorLayoutVertical'),
              type: 'radio',
              checked: getEditorLayout() === 'vertical',
              click: () => setEditorLayout('vertical'),
            },
          ],
        },
        { type: 'separator' },
        {
          label: t('menu.customExtensions'),
          click: (item, win) => sendToWindow(win, 'menu:manage-custom-extensions'),
        },
        {
          label: t('menu.hiddenNames'),
          click: (item, win) => sendToWindow(win, 'menu:manage-hidden-names'),
        },
      ],
    },
    {
      label: t('menu.help'),
      submenu: [
        // Only when run from source (npm start): picks up edits to the
        // program without closing and restarting it by hand.
        ...(app.isPackaged
          ? []
          : [
              {
                label: t('menu.reloadProgram'),
                accelerator: 'CmdOrCtrl+Shift+F5',
                click: () => reloadProgram(),
              },
              {
                label: t('menu.toggleTestPane'),
                accelerator: 'Ctrl+Alt+E',
                click: (item, win) => sendToActiveDoc(win, 'menu:toggle-pane', undefined, { focus: true }),
              },
              { type: 'separator' },
            ]),
        {
          label: t('menu.about'),
          click: (item, win) => showAboutDialog(win),
        },
      ],
    },
  ]);
  Menu.setApplicationMenu(menu);
}

function showAboutDialog(win) {
  dialog.showMessageBox(targetWindow(win), {
    type: 'info',
    icon: path.join(__dirname, 'assets', 'icon.png'),
    title: t('about.title'),
    message: 'MD Viewer',
    detail: t('about.detail', {
      version: app.getVersion(),
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node,
      year: String(new Date().getFullYear()),
    }),
    buttons: ['OK'],
  });
}

// ---- Main window size and position ----
// Saved when the window closes and applied to the next one, so a restart —
// by hand or through Reload Program — opens where the last window was.
// Normal (unmaximized) bounds are kept alongside the maximized flag, so
// un-maximizing after a restore still lands on the user's own size.
const DEFAULT_WINDOW_SIZE = { width: 1280, height: 840 };
// How much of the window must still be on some display for saved bounds to
// be used; less than this (a monitor since unplugged, a resolution change)
// would leave the window unreachable, so it opens at the default instead.
const MIN_VISIBLE_WINDOW_PART = { width: 200, height: 100 };

function savedWindowBounds(state) {
  const b = state && state.bounds;
  if (!b || ![b.x, b.y, b.width, b.height].every(Number.isFinite)) return null;
  if (b.width < 200 || b.height < 150) return null;
  const visible = screen.getAllDisplays().some(({ workArea: a }) => {
    const w = Math.min(b.x + b.width, a.x + a.width) - Math.max(b.x, a.x);
    const h = Math.min(b.y + b.height, a.y + a.height) - Math.max(b.y, a.y);
    return w >= MIN_VISIBLE_WINDOW_PART.width && h >= MIN_VISIBLE_WINDOW_PART.height;
  });
  return visible ? { x: b.x, y: b.y, width: b.width, height: b.height } : null;
}

function saveWindowState(win) {
  // Fullscreen isn't restored (the renderer's fullscreen document view
  // starts fresh), but the maximized state under it is.
  const state = { bounds: win.getNormalBounds(), maximized: win.isMaximized() };
  try {
    saveSettings({ ...loadSettings(), windowState: state });
  } catch (err) {
    // Not worth failing the close over.
  }
}

// A window opened next to existing ones (File > New Window) is offset from
// the one the user is in, so it doesn't land exactly on top of it.
const NEW_WINDOW_CASCADE_OFFSET = 30;

function cascadedWindowBounds() {
  const from = targetWindow();
  if (!from) return null;
  const b = from.getNormalBounds();
  return savedWindowBounds({
    bounds: { ...b, x: b.x + NEW_WINDOW_CASCADE_OFFSET, y: b.y + NEW_WINDOW_CASCADE_OFFSET },
  });
}

// bounds: where to put a window opened for a purpose of its own (a tab
// dragged out of another window); kept only if enough of it is on screen.
function createWindow({ bounds: requestedBounds = null } = {}) {
  const savedSettings = loadSettings();
  if (SUPPORTED_LANGUAGES.includes(savedSettings.language)) currentLanguage = savedSettings.language;
  if (THEME_SOURCES.includes(savedSettings.themeSource)) nativeTheme.themeSource = savedSettings.themeSource;

  // The saved size and position belong to the first window; any further
  // one cascades from the window the user is in and starts unmaximized.
  const isFirstWindow = appWindows.size === 0;
  const windowState = isFirstWindow ? savedSettings.windowState : null;
  const bounds =
    (requestedBounds && savedWindowBounds({ bounds: requestedBounds })) ||
    (isFirstWindow ? savedWindowBounds(windowState) : cascadedWindowBounds());
  const win = new BrowserWindow({
    ...(bounds || DEFAULT_WINDOW_SIZE),
    backgroundColor: '#1e1e1e',
    icon: path.join(__dirname, 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // The tabs are iframes of the page (src/doc.html), each with the
      // same bridge (see preload.js).
      nodeIntegrationInSubFrames: true,
      additionalArguments: [APP_PAGES_ARG],
    },
  });

  // Re-applied on every title update rather than set once, since the page's
  // own <title> would otherwise win as soon as it loads.
  if (PREVIEW_VERSION_SUFFIX) {
    win.on('page-title-updated', (event, title) => {
      event.preventDefault();
      win.setTitle(title + PREVIEW_VERSION_SUFFIX);
    });
  }

  if (windowState && windowState.maximized) win.maximize();

  const host = createTabHost(win);
  win.loadFile(path.join(__dirname, 'src', 'index.html'));
  buildAppMenu();

  // A reload of the window page (Ctrl+R, a language change) keeps the
  // tabs; the fresh page draws them again.
  win.webContents.on('did-finish-load', () => {
    resetTabsAfterPageLoad(win);
    win.webContents.send('shell:doc-fullscreen', { container: 'main', enabled: win.isFullScreen() });
  });
  win.webContents.on('render-process-gone', () => settleTabAsksOf(win));

  // Tab windows (see detachTab) are opened by this window's page.
  win.webContents.setWindowOpenHandler((details) => handleWindowOpen(win, details));
  win.webContents.on('did-create-window', (child, details) => onTabWindowCreated(win, child, details.frameName));

  wireDocWindowEvents(win, host);

  // The renderer blocks unload (beforeunload) while the editor holds unsaved
  // text — an untitled draft exists nowhere else — and Electron leaves the
  // asking to us: closing or reloading silently does nothing otherwise.
  win.webContents.on('will-prevent-unload', (event) => {
    const choice = dialog.showMessageBoxSync(win, {
      type: 'warning',
      title: t('close.discardTitle'),
      message: t('close.discardMessage'),
      buttons: [t('close.discardButton'), t('close.cancelButton')],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
    });
    if (choice === 0) event.preventDefault();
    // Cancelled: the window stays, so a pending Reload Program is off.
    else relaunchArgsOnQuit = null;
  });

  // 'close' still has the window to read; it fires again if closing is
  // cancelled at the unsaved-changes prompt and retried, which only saves
  // the same state twice. Tabs holding unsaved text close first, each
  // saving it (auto save) or asking; the window only goes once they have.
  win.on('close', (event) => {
    saveWindowState(win);
    if (host.closingApproved) return;
    const unsaved = tabsOwnedBy(win).filter(isTabDirty);
    if (!unsaved.length) return;
    event.preventDefault();
    closeTabs(unsaved).then((closed) => {
      if (!closed || win.isDestroyed()) return;
      host.closingApproved = true;
      win.close();
    });
  });

  win.on('focus', () => {
    lastFocusedWindow = win;
  });

  const webContentsId = win.webContents.id;
  const windowId = win.id;
  win.on('closed', () => {
    stopWatching(webContentsId);
    killTerminal(webContentsId);
    windowProjects.delete(webContentsId);
    settleTabAsksOf(win);
    // Its tab windows' contents belong to its page, which is gone.
    for (const tabHost of hostsOwnedBy(win)) {
      if (tabHost === host) continue;
      tabHost.closingApproved = true;
      if (!tabHost.win.isDestroyed()) tabHost.win.close();
    }
    for (const tab of [...host.tabs]) {
      stopWatching(tabWatchKey(tab));
      tabsById.delete(tab.id);
    }
    tabHosts.delete(windowId);
    appWindows.delete(win);
    if (lastFocusedWindow === win) lastFocusedWindow = null;
    if (appWindows.size) return;
    // 'window-all-closed' — and with it quitting the app — waits for every
    // window, including ones the user cannot see.
    closeMermaidWindow();
    stopPlantUmlServer();
    if (backgroundFrames) backgroundFrames.stopAll();
  });

  appWindows.add(win);
  lastFocusedWindow = win;
  return win;
}

function stopWatching(webContentsId) {
  const watcher = fileWatchers.get(webContentsId);
  if (watcher) {
    watcher.close();
    fileWatchers.delete(webContentsId);
  }
}

// ---- Document tabs ----
// Each tab is one document — the viewer and, in edit mode, the source
// editor beside it — shown by a page of its own (src/doc.html) in an
// iframe. Every tab of a program window lives in that window's renderer:
// in its tab area, or in a window of its own the tab was moved out to (a
// "tab window", opened by the window page with window.open, which keeps it
// in the same renderer as the page that opened it, the way VS Code's
// editor windows are). The tabs' order, the one on screen and what each
// shows are kept here; the window page draws the strips and the iframes
// from that (tabs:changed).
//
// An iframe cannot change documents without loading again, so a tab that
// moves to another window hands over what it holds first (tab:ask
// 'snapshot': its document, unsaved text, caret, scroll offsets, history)
// and the new iframe opens on that. Only the editor's undo history stays
// behind.

// What a document tab's page last reported of its document (doc:state).
// fileKind: how the document is shown ('markdown', 'puml', 'json', 'text').
const DEFAULT_DOC_STATE = {
  path: null,
  fileKind: 'markdown',
  dirty: false,
  editMode: false,
  draft: false,
  instantView: false,
};

const DOC_PAGE_URL = pathToFileURL(path.join(__dirname, 'src', 'doc.html')).href;
const FILE_BADGES = { markdown: 'md', puml: 'puml', json: 'json', html: 'html', pdf: 'pdf', text: 'text' };

// The sandbox of a page that is not the app's own (the test kind now,
// add-on tabs later): its scripts run, in its own origin, and nothing more
// — no popups, no navigating the window, no dialogs.
const FOREIGN_TAB_SANDBOX = 'allow-scripts allow-same-origin allow-forms';

function withTabHint(url, id) {
  const at = url.search(/#|$/);
  return `${url.slice(0, at)}${url.slice(0, at).includes('?') ? '&' : '?'}tab=${id}${url.slice(at)}`;
}

// What an add-on page handed over (`{ state }`, see preload.js), as long as
// it stays within ADDON_SNAPSHOT_MAX_BYTES as JSON; else nothing.
const ADDON_SNAPSHOT_MAX_BYTES = 1024 * 1024;
function addonStateIn(answer) {
  if (!answer || typeof answer !== 'object' || !('state' in answer)) return null;
  try {
    const json = JSON.stringify(answer.state);
    return json !== undefined && Buffer.byteLength(json, 'utf8') <= ADDON_SNAPSHOT_MAX_BYTES ? JSON.parse(json) : null;
  } catch (err) {
    return null;
  }
}

// The tab an add-on contributes under this id (contributes.tabs), with
// its add-on, while that add-on runs.
function addonTabContribution(addonId, tabId) {
  const entry = addonRegistry && addonRegistry.running(addonId);
  const tabs = entry && entry.manifest.contributes && entry.manifest.contributes.tabs;
  const contribution = tabs && tabs.find((t) => t.id === tabId);
  return contribution ? { entry, contribution } : null;
}

// What differs between kinds of tab: document tabs ('doc') and add-on tabs
// ('addon', a tab an add-on contributes, protocol 12.7). The window page
// builds each tab's strip entry and iframe from what this gives (see
// tabForPage), without knowing the kinds itself.
//   state: the kind's own state for a new tab (tab[kind]), from its init.
//   reopen: what its page opens on when it loads again on its own (its
//     window gone).
//   handOver: what its page opens on after being asked for a snapshot
//     before it moves or its window reloads (`reason`: 'moved',
//     'reloaded'); `answer` is the page's answer, null when it gave none.
//   closeTimeout: how long its page gets to answer tab:ask 'close' before
//     the tab closes anyway (0: as long as it takes — a document tab may
//     be asking the user).
//   page: the iframe's address (and sandbox attribute, when it has one).
//   view: the strip entry — title, tooltip, icon, unsaved mark.
//   restoreEntry: what brings the tab back after a relaunch, or null.
//   hello: its page has loaded (tab:hello) and waits for what to show.
const TAB_KINDS = {
  doc: {
    state: (init) => ({
      ...DEFAULT_DOC_STATE,
      path: init.filePath || null,
      fileKind: init.filePath ? fileKindOf(init.filePath) : 'markdown',
      draft: !!init.draft,
      instantView: !!init.instantView,
    }),
    reopen: (tab) => initFromDoc(tab),
    handOver: (tab, answer) => answer || initFromDoc(tab),
    closeTimeout: 0,
    page: (tab) => ({ url: `${DOC_PAGE_URL}?tab=${tab.id}` }),
    view: (tab) => {
      const { path: filePath, fileKind, draft, dirty } = tab.doc;
      return {
        title: draft ? t('draft.title') : filePath ? path.basename(filePath) : t('tabs.empty'),
        tooltip: filePath || '',
        icon: { badge: draft ? 'md' : FILE_BADGES[fileKind] || 'md', path: filePath || '' },
        dirty,
      };
    },
    restoreEntry: (tab) => (tab.doc.path && !tab.doc.instantView ? { path: tab.doc.path } : null),
    // Its page has loaded (tab:hello): what to show, and the window's
    // projects. A later load brings back the document it shows by then,
    // without the one-time extras.
    hello: (tab) => {
      sendToTab(tab, 'doc:init', {
        ...tab.init,
        context: tabContextFor(tab.host),
        active: tab.id === tab.host.activeId,
      });
      tab.init = initFromDoc(tab);
    },
  },
  // init: { addonId, tabId } and, when its page loads again, restore (see
  // addon:hello). The page is the contribution's entry in the add-on's
  // origin (mdviewer-addon://<id>/<entry>).
  addon: {
    state: (init) => ({ id: String(init.addonId), tabId: String(init.tabId) }),
    reopen: () => ({}),
    // The add-on page gets back what it handed over.
    handOver: (tab, answer, reason) => ({ restore: { reason, state: addonStateIn(answer) } }),
    // An add-on page cannot hold its tab open: its onWillClose handler gets
    // 3 s (protocol 7.4, timed in preload.js), the answer a little more.
    closeTimeout: 3500,
    // The address carries the tab id, which the page gives back in
    // addon:hello as a hint (main checks the frame itself).
    page: (tab) => {
      const found = addonTabContribution(tab.addon.id, tab.addon.tabId);
      const entry = found ? found.contribution.entry : 'index.html';
      return { url: withTabHint(`${ADDON_SCHEME}://${tab.addon.id}/${entry}`, tab.id), sandbox: FOREIGN_TAB_SANDBOX };
    },
    view: (tab) => {
      const found = addonTabContribution(tab.addon.id, tab.addon.tabId);
      const title = found ? found.contribution.title : tab.addon.tabId;
      const icon = found && found.contribution.icon ? { url: `${ADDON_SCHEME}://${tab.addon.id}/${found.contribution.icon}` } : { badge: 'ext' };
      return { title, tooltip: found ? `${found.entry.manifest.name}: ${title}` : title, icon, dirty: false };
    },
    restoreEntry: (tab) => ({ addon: tab.addon.id, tab: tab.addon.tabId }),
    // Not the app's page: it never says tab:hello (addon:hello instead).
    hello: () => {},
  },
};

// BrowserWindow.id -> { key, win, owner, aux, tabs, activeId, closingApproved }.
// One per program window (key 'main', owner = the window itself) and one
// per tab window (key 'aux-N', owner = the program window that opened it).
const tabHosts = new Map();
const tabsById = new Map(); // tab id -> { id, host, kind, [kind], init, frame }
let nextTabId = 1;
let nextTabWindowId = 1;
// The CSS editor's unsaved text per project (normalized root -> { css,
// enabled }), so a tab opened while it is being edited shows it too.
const liveCssByRoot = new Map();

// How long a tab's page gets to hand over its state before it moves
// without it (a page that hangs shouldn't hold the tab hostage).
const TAB_SNAPSHOT_TIMEOUT_MS = 5000;
const TAB_WINDOW_OPEN_TIMEOUT_MS = 5000;

function createTabHost(win, { owner = win, key = 'main' } = {}) {
  const host = { key, win, owner, aux: owner !== win, tabs: [], activeId: null, closingApproved: false };
  tabHosts.set(win.id, host);
  return host;
}

function hostOf(win) {
  return win ? tabHosts.get(win.id) || null : null;
}

function hostsOwnedBy(owner) {
  return [...tabHosts.values()].filter((host) => host.owner === owner);
}

function tabsOwnedBy(owner) {
  return hostsOwnedBy(owner).flatMap((host) => host.tabs);
}

function activeTabOf(host) {
  return host ? host.tabs.find((tab) => tab.id === host.activeId) || null : null;
}

// The program window behind a window: itself, or for a tab window the one
// whose page opened it, which has the explorer, the terminal and the open
// projects.
function ownerOf(win) {
  const host = hostOf(win);
  return host ? host.owner : win;
}

function windowFor(contents) {
  return contents ? BrowserWindow.fromWebContents(contents) : null;
}

// The tab area of the window the sender is in — its own, or, from the
// window page, the one named by `key` (a tab window it draws).
function senderHost(event, key) {
  const owner = ownerOf(windowFor(event.sender));
  if (!owner) return null;
  return hostsOwnedBy(owner).find((host) => host.key === (key || 'main')) || hostOf(owner);
}

function sameFrame(a, b) {
  return !!a && !!b && a.processId === b.processId && a.routingId === b.routingId;
}

// The tab whose page sent an IPC message, if a tab's page sent it.
function senderTab(event) {
  const frame = event.senderFrame;
  if (!frame) return null;
  for (const tab of tabsById.values()) {
    if (sameFrame(tab.frame, frame)) return tab;
  }
  return null;
}

function sendToFrame(frame, channel, ...args) {
  if (!frame) return;
  try {
    if (!frame.detached) frame.send(channel, ...args);
  } catch (err) {
    /* the frame went away */
  }
}

function sendToTab(tab, channel, ...args) {
  if (tab) sendToFrame(tab.frame, channel, ...args);
}

// The tab area a command given in `win` is about: a tab window's own, or
// the program window's.
function docHostFor(win) {
  return (win && !win.isDestroyed() && hostOf(win)) || hostOf(targetWindow(win));
}

// Sends to the document on screen in the window — what menu commands about
// "the document" (save, edit mode, find, back/forward) mean. focus: the
// command needs the keyboard there (the find bar's input, the editor).
function sendToActiveDoc(win, channel, payload, { focus = false } = {}) {
  const tab = activeTabOf(docHostFor(win));
  if (!tab) return;
  if (focus) focusTab(tab);
  sendToTab(tab, channel, payload);
}

// Gives the tab's iframe the keyboard (the window page does that).
function focusTab(tab) {
  const host = tab.host;
  if (host.owner.isDestroyed()) return;
  host.owner.webContents.send('tabs:focus', { container: host.key, id: tab.id });
}

// View > Next/Previous Tab (Ctrl+Tab, Ctrl+Shift+Tab).
function cycleTab(win, delta) {
  const host = docHostFor(win);
  if (!host || host.tabs.length < 2) return;
  const index = host.tabs.indexOf(activeTabOf(host));
  const next = host.tabs[(index + delta + host.tabs.length) % host.tabs.length];
  activateTab(host, next.id);
}

function sendToHostTabs(host, channel, ...args) {
  for (const tab of host.tabs) sendToTab(tab, channel, ...args);
}

function sendToAllTabs(channel, ...args) {
  for (const tab of tabsById.values()) sendToTab(tab, channel, ...args);
}

function isTabDirty(tab) {
  return !!(tab.doc && tab.doc.dirty);
}

function fileKindOf(filePath) {
  if (/\.(html?|xhtml)$/i.test(filePath)) return 'html';
  if (/\.pdf$/i.test(filePath)) return 'pdf';
  if (/\.puml$/i.test(filePath)) return 'puml';
  if (/\.json$/i.test(filePath)) return 'json';
  if (plainTextExtensionPattern().test(filePath)) return 'text';
  return 'markdown';
}

// The program window's open projects, which decide what project a tab's
// document belongs to (see doc:context in doc.js).
function tabContextFor(host) {
  const entry = windowProjects.get(host.owner.webContents.id);
  return { roots: entry && entry.roots ? [...entry.roots] : [], active: (entry && entry.active) || null };
}

// What a document tab's page opens on when nothing more was handed over:
// the document it shows.
function initFromDoc(tab) {
  return { filePath: tab.doc.path, draft: tab.doc.draft, instantView: tab.doc.instantView };
}

// A tab as the window page gets it (tabs:changed). doc: what the page
// needs of a document tab's document (the active project follows it, and
// two tabs of the same name are told apart by their folders).
function tabForPage(tab) {
  const kind = TAB_KINDS[tab.kind];
  return {
    id: tab.id,
    kind: tab.kind,
    view: kind.view(tab),
    page: kind.page(tab),
    doc: tab.kind === 'doc' ? { path: tab.doc.path, instantView: tab.doc.instantView } : null,
  };
}

// focusId: the tab whose iframe should take the keyboard.
function notifyTabsChanged(host, { focusId = null } = {}) {
  if (!host || host.owner.isDestroyed()) return;
  host.owner.webContents.send('tabs:changed', {
    container: host.key,
    tabs: host.tabs.map(tabForPage),
    activeId: host.activeId,
    focusId,
  });
}

function activateTab(host, id, { focus = true } = {}) {
  const tab = host.tabs.find((t) => t.id === id);
  if (!tab) return;
  const previous = activeTabOf(host);
  host.activeId = id;
  if (previous && previous !== tab) sendToTab(previous, 'tab:activated', false);
  sendToTab(tab, 'tab:activated', true);
  // A tab in another window than the one in use (a link to a document
  // open in a tab window) brings that window forward.
  if (focus && !host.win.isDestroyed() && !host.win.isFocused()) host.win.focus();
  notifyTabsChanged(host, { focusId: focus ? id : null });
}

// The tab to show once the active one leaves: the one that took its place
// in the strip, else the one before it.
function activateNeighbour(host, index) {
  const next = host.tabs[neighbourIndex(host.tabs.length, index)];
  host.activeId = null;
  if (next) activateTab(host, next.id, { focus: false });
  else notifyTabsChanged(host);
}

// init: what the page opens with — for a document tab (doc:init)
// { filePath } or { draft }, plus instantView, editMode and target (a spot
// to show, see applyDocTarget in doc.js), or a moved tab's snapshot; for
// other kinds see TAB_KINDS.
function createTab(host, init, { kind = 'doc', index, activate = true, focus = true } = {}) {
  const tab = {
    id: nextTabId++,
    host,
    kind,
    [kind]: TAB_KINDS[kind].state(init),
    init,
    // The tab's page once it has loaded (tab:hello); null while it loads.
    frame: null,
  };
  tabsById.set(tab.id, tab);
  const activeIndex = host.tabs.indexOf(activeTabOf(host));
  const at = Number.isInteger(index)
    ? Math.max(0, Math.min(index, host.tabs.length))
    : activeIndex === -1
    ? host.tabs.length
    : activeIndex + 1;
  host.tabs.splice(at, 0, tab);
  if (activate) activateTab(host, tab.id, { focus });
  else notifyTabsChanged(host);
  return tab;
}

function tabWatchKey(tab) {
  return `tab:${tab.id}`;
}

function removeTab(tab) {
  stopWatching(tabWatchKey(tab));
  tabsById.delete(tab.id);
  tab.frame = null;
  const host = tab.host;
  const index = host.tabs.indexOf(tab);
  if (index !== -1) host.tabs.splice(index, 1);
  if (host.activeId === tab.id) activateNeighbour(host, index);
  else notifyTabsChanged(host);
  closeTabWindowIfEmpty(host);
}

// A tab window goes once its last tab has left it.
function closeTabWindowIfEmpty(host) {
  if (!host.aux || host.tabs.length || host.win.isDestroyed()) return;
  host.closingApproved = true;
  host.win.close();
}

// ---- The app's IPC and its pages ----
// Only the app's own pages talk to main: a program window's page (its top
// frame, src/index.html) and the document tab pages in it (iframes right
// under that page, at doc.html?tab=N for a tab of that window). Every
// handler is registered through appIpc, which turns anything else away —
// a frame inside a document, and from 2.x add-on frames, which get their
// own bridge instead. Frames are also kept from reaching the app's pages
// by navigating (see guardFrameNavigation), so a frame cannot become one.

const WINDOW_PAGE_URL = pathToFileURL(path.join(__dirname, 'src', 'index.html')).href;
const APP_PAGES = { docPageUrl: DOC_PAGE_URL, appPageUrls: [WINDOW_PAGE_URL, DOC_PAGE_URL], addonScheme: ADDON_SCHEME };

function isAppSender(event) {
  const frame = event.senderFrame;
  const win = windowFor(event.sender);
  if (!frame || !win) return false;
  const owner = ownerOf(win);
  if (!appWindows.has(owner)) return false;
  if (!frame.parent) return win === owner && isAppPageUrl(frame.url, [WINDOW_PAGE_URL]);
  if (frame.parent.parent) return false;
  const tab = tabsById.get(docTabIdOf(frame.url, DOC_PAGE_URL));
  return !!tab && tab.kind === 'doc' && tab.host.owner === owner;
}

// Logged once per channel and address, so a frame that keeps trying
// doesn't flood the log.
const refusedIpc = new Set();
function refuseIpc(event, channel) {
  const url = event.senderFrame ? event.senderFrame.url : '?';
  const key = `${channel} ${url}`;
  if (refusedIpc.has(key)) return;
  refusedIpc.add(key);
  console.warn(`[ipc] refused ${channel} from ${url}`);
}

const appIpc = {
  handle(channel, listener) {
    ipcMain.handle(channel, (event, ...args) => {
      if (isAppSender(event)) return listener(event, ...args);
      refuseIpc(event, channel);
      throw new Error(`${channel} is not available to this frame`);
    });
  },
  on(channel, listener) {
    ipcMain.on(channel, (event, ...args) => {
      if (isAppSender(event)) return listener(event, ...args);
      refuseIpc(event, channel);
      // A sendSync caller waits for this.
      event.returnValue = null;
    });
  },
};

// Frames below a window's page (tabs, and whatever is inside them) never
// navigate to an app page, a tab's page never navigates away, and an
// add-on's page never leaves its add-on's origin.
function guardFrameNavigation(win) {
  win.webContents.on('will-frame-navigate', (details) => {
    if (details.isMainFrame) return;
    const frame = details.frame;
    const fromUrl = frame ? frame.url : '';
    const tabLevel = !!frame && !!frame.parent && !frame.parent.parent;
    if (subframeNavigationAllowed({ fromUrl, targetUrl: details.url, tabLevel }, APP_PAGES)) return;
    details.preventDefault();
    console.warn(`[nav] blocked a frame going from ${fromUrl || 'nothing'} to ${details.url}`);
  });
}

// ---- Asking a tab's page ----
// tab:ask { id, kind } → tab:answer (id, value). kind 'close': may it close
// (unsaved text saved or let go)? kind 'snapshot': what it holds, for the
// page that takes over from it.

const tabAsks = new Map(); // ask id -> { frame, owner, settle }
let nextTabAskId = 1;

// Resolves to the page's answer, or null when it has none to give (not
// loaded, gone, or out of time).
function askTab(tab, kind, options) {
  return askFrame(tab.frame, tab.host.owner, kind, options);
}

// The same question to any page the tab host knows (a tab's, or the pane
// in a document tab).
function askFrame(frame, owner, kind, { timeout = 0 } = {}) {
  if (!frame) return Promise.resolve(null);
  return new Promise((resolve) => {
    const id = nextTabAskId++;
    let timer = null;
    const settle = (value) => {
      clearTimeout(timer);
      tabAsks.delete(id);
      resolve(value);
    };
    tabAsks.set(id, { frame, owner, settle });
    if (timeout) timer = setTimeout(() => settle(null), timeout);
    sendToFrame(frame, 'tab:ask', { id, kind });
  });
}

// A document tab's pane hands over its state too (before the tab's page
// goes); the new pane gets it back in addon:hello.
async function snapshotPaneOf(tab, reason) {
  if (!tab.pane || !tab.pane.frame) return;
  const answer = await askFrame(tab.pane.frame, tab.host.owner, 'snapshot', { timeout: TAB_SNAPSHOT_TIMEOUT_MS });
  tab.paneRestore = { reason, state: addonStateIn(answer) };
}

// The window page went away (reload, crash) and its tabs' pages with it:
// nothing will answer.
function settleTabAsksOf(owner) {
  for (const ask of [...tabAsks.values()]) {
    if (ask.owner === owner) ask.settle(null);
  }
}

// Only the page that was asked answers — an add-on's page as well as the
// app's (so not through appIpc).
ipcMain.on('tab:answer', (event, id, value) => {
  const ask = tabAsks.get(id);
  if (ask && sameFrame(event.senderFrame, ask.frame)) ask.settle(value);
});

// Closes a tab the way closing a window always has: its page saves
// unsaved edits (auto save) or the user is asked. Resolves to whether it
// closed. force: already settled by the page itself — no questions.
function closeTab(tab, { force = false } = {}) {
  if (!tab || !tabsById.has(tab.id)) return Promise.resolve(true);
  if (tab.closing) return tab.closing;
  tab.closing = (async () => {
    const answer = force ? true : await askTab(tab, 'close', { timeout: TAB_KINDS[tab.kind].closeTimeout });
    tab.closing = null;
    if (answer === false) {
      // Kept: so is its window, and a pending Reload Program is off.
      relaunchArgsOnQuit = null;
      return false;
    }
    if (tabsById.has(tab.id)) removeTab(tab);
    return true;
  })();
  return tab.closing;
}

// One after another, so the questions come one at a time. Stops at the
// first the user keeps.
async function closeTabs(tabs) {
  for (const tab of tabs) {
    if (!(await closeTab(tab))) return false;
  }
  return true;
}

// The tab already showing the file in the program window or one of its
// tab windows, if any.
function findTabForPath(owner, filePath) {
  return tabsOwnedBy(owner).find((tab) => tab.kind === 'doc' && samePath(tab.doc.path, filePath)) || null;
}

// Opens a document in a tab: the one already showing it, else a new one.
function openDocumentInTab(host, filePath, { editMode = false, target = null, focus = true, instantView = false } = {}) {
  const existing = findTabForPath(host.owner, filePath);
  if (existing) {
    activateTab(existing.host, existing.id, { focus });
    if (target || editMode) sendToTab(existing, 'doc:navigate', { target, editMode });
    return existing;
  }
  return createTab(host, { filePath, target, editMode, instantView }, { focus });
}

// Puts a tab into another window (or another place in its own strip).
async function moveTab(tab, toHost, index) {
  const fromHost = tab.host;
  if (fromHost === toHost) {
    // Dropped on its own window's document area: already where it goes.
    if (!Number.isInteger(index)) return;
    const from = fromHost.tabs.indexOf(tab);
    const at = reorderIndex(fromHost.tabs.length, from, index);
    fromHost.tabs.splice(from, 1);
    fromHost.tabs.splice(at, 0, tab);
    notifyTabsChanged(fromHost);
    return;
  }
  if (tab.moving) return;
  tab.moving = true;
  const [snapshot] = await Promise.all([
    askTab(tab, 'snapshot', { timeout: TAB_SNAPSHOT_TIMEOUT_MS }),
    snapshotPaneOf(tab, 'moved'),
  ]);
  tab.moving = false;
  // Closed, or the window it was going to closed, while it packed up.
  if (!tabsById.has(tab.id) || tab.host !== fromHost || toHost.win.isDestroyed()) return;
  tab.init = TAB_KINDS[tab.kind].handOver(tab, snapshot && typeof snapshot === 'object' ? snapshot : null, 'moved');
  tab.frame = null;
  stopWatching(tabWatchKey(tab));
  const from = fromHost.tabs.indexOf(tab);
  fromHost.tabs.splice(from, 1);
  if (fromHost.activeId === tab.id) activateNeighbour(fromHost, from);
  else notifyTabsChanged(fromHost);
  tab.host = toHost;
  toHost.tabs.splice(insertIndex(toHost.tabs.length, index), 0, tab);
  activateTab(toHost, tab.id);
  closeTabWindowIfEmpty(fromHost);
  // Another program window shows the document's project in its explorer.
  if (fromHost.owner !== toHost.owner && tab.kind === 'doc' && tab.doc.path && !tab.doc.instantView) {
    sendToWindowWhenLoaded(toHost.owner, 'shell:request', {
      action: 'ensure-project',
      payload: { path: tab.doc.path },
    });
  }
}

// Where, from the pointer, a tab window opened for a dragged-out tab goes:
// its tab strip ends up roughly under the pointer.
const TAB_WINDOW_POINTER_OFFSET = { x: 120, y: 16 };
// A tab window has no explorer; it starts narrower than the program window.
const TAB_WINDOW_WIDTH_RATIO = 0.7;
const TAB_WINDOW_MIN_SIZE = { width: 640, height: 480 };

// A tab leaving its window for a tab window of its own — under the pointer
// when it was dropped outside every window. Already alone in a tab
// window, it is where it would go.
async function detachTab(tab, screenPoint) {
  const fromHost = tab.host;
  if (fromHost.aux && fromHost.tabs.length === 1) return;
  const source = fromHost.win.isDestroyed() ? fromHost.owner : fromHost.win;
  const normal = source.getNormalBounds();
  const width = Math.max(TAB_WINDOW_MIN_SIZE.width, Math.round(normal.width * TAB_WINDOW_WIDTH_RATIO));
  const height = Math.max(TAB_WINDOW_MIN_SIZE.height, normal.height);
  const atPointer = screenPoint && Number.isFinite(screenPoint.x) && Number.isFinite(screenPoint.y);
  const requested = atPointer
    ? { x: screenPoint.x - TAB_WINDOW_POINTER_OFFSET.x, y: screenPoint.y - TAB_WINDOW_POINTER_OFFSET.y, width, height }
    : { x: normal.x + NEW_WINDOW_CASCADE_OFFSET, y: normal.y + NEW_WINDOW_CASCADE_OFFSET, width, height };
  const bounds = savedWindowBounds({
    bounds: { ...requested, x: Math.round(requested.x), y: Math.round(requested.y) },
  });
  const toHost = await openTabWindow(fromHost.owner, bounds);
  if (toHost) await moveTab(tab, toHost, 0);
}

// Tab windows on their way: the window page was asked to open one
// (shell:open-tab-window) and main.js waits for it here.
const pendingTabWindows = new Map(); // key -> { owner, bounds, settle }

function openTabWindow(owner, bounds) {
  if (owner.isDestroyed()) return Promise.resolve(null);
  const key = `aux-${nextTabWindowId++}`;
  return new Promise((resolve) => {
    const timer = setTimeout(() => settle(null), TAB_WINDOW_OPEN_TIMEOUT_MS);
    const settle = (host) => {
      clearTimeout(timer);
      pendingTabWindows.delete(key);
      resolve(host);
    };
    pendingTabWindows.set(key, { owner, bounds, settle });
    owner.webContents.send('shell:open-tab-window', { key });
  });
}

// A tab window is just the document: no title bar (its tab strip is the
// handle to move it by, see body.tab-window in ui.css) and no menu bar.
function tabWindowOptions(bounds) {
  return {
    ...(bounds || DEFAULT_WINDOW_SIZE),
    frame: false,
    backgroundColor: '#1e1e1e',
    icon: path.join(__dirname, 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      nodeIntegrationInSubFrames: true,
      additionalArguments: [APP_PAGES_ARG],
    },
  };
}

// window.open from a program window's page: only the tab windows it was
// asked for. A web link that wants a window of its own opens in the
// browser instead.
function handleWindowOpen(owner, { url, frameName }) {
  const pending = pendingTabWindows.get(frameName);
  if (pending && pending.owner === owner) {
    return { action: 'allow', overrideBrowserWindowOptions: tabWindowOptions(pending.bounds) };
  }
  if (/^https?:\/\//i.test(url)) shell.openExternal(url);
  return { action: 'deny' };
}

function onTabWindowCreated(owner, win, frameName) {
  const pending = pendingTabWindows.get(frameName);
  if (!pending || pending.owner !== owner) {
    win.destroy();
    return;
  }
  pending.settle(setupTabWindow(owner, win, frameName));
}

function setupTabWindow(owner, win, key) {
  const host = createTabHost(win, { owner, key });
  // The menu's shortcuts still work with the bar hidden, as in fullscreen;
  // Alt doesn't bring it up.
  win.setAutoHideMenuBar(false);
  win.setMenuBarVisibility(false);
  if (PREVIEW_VERSION_SUFFIX) {
    win.on('page-title-updated', (event, title) => {
      event.preventDefault();
      win.setTitle(title + PREVIEW_VERSION_SUFFIX);
    });
  }
  wireDocWindowEvents(win, host);
  // Menu commands about the program (the explorer, the terminal) go to the
  // window that has them.
  win.on('focus', () => {
    lastFocusedWindow = owner;
  });
  // Closing a tab window puts its tabs back in the program window, the way
  // closing a VS Code editor window does.
  win.on('close', (event) => {
    if (host.closingApproved || owner.isDestroyed()) return;
    event.preventDefault();
    returnTabsToOwner(host);
  });
  win.on('closed', () => {
    // Gone without 'close' getting its say (its page closed it): the tabs
    // still come back, as they were last loaded.
    const mainHost = owner.isDestroyed() ? null : hostOf(owner);
    for (const tab of [...host.tabs]) {
      stopWatching(tabWatchKey(tab));
      if (!mainHost) {
        tabsById.delete(tab.id);
        continue;
      }
      tab.frame = null;
      tab.init = TAB_KINDS[tab.kind].reopen(tab);
      tab.host = mainHost;
      mainHost.tabs.push(tab);
    }
    if (mainHost && host.tabs.length) {
      host.tabs = [];
      if (!activeTabOf(mainHost)) mainHost.activeId = mainHost.tabs[0].id;
      notifyTabsChanged(mainHost);
    }
    tabHosts.delete(win.id);
    if (!owner.isDestroyed()) owner.webContents.send('shell:tab-window-closed', { key });
  });
  return host;
}

async function returnTabsToOwner(host) {
  const mainHost = hostOf(host.owner);
  if (!mainHost) return;
  for (const tab of [...host.tabs]) await moveTab(tab, mainHost);
}

// What a program window and a tab window both do for the document on
// screen in them.
function wireDocWindowEvents(win, host) {
  // A web link followed inside an .html file the viewer shows (see
  // showEmbeddedFile in doc.js) opens in the browser, as links in a
  // rendered document do, instead of loading the site into the tab.
  win.webContents.on('will-frame-navigate', (event) => {
    if (event.isMainFrame || !/^https?:\/\//i.test(event.url)) return;
    event.preventDefault();
    shell.openExternal(event.url);
  });
  guardFrameNavigation(win);

  // Mouse "back"/"forward" buttons (Windows: XButton1/XButton2) — the app
  // has no real browser-style navigation for webContents.goBack() to
  // operate on (every document switch is a same-page innerHTML swap, not a
  // page load), so intercept the OS-level commands here and hand them to
  // the tab's own navigation history instead of leaving them unhandled.
  win.on('app-command', (event, cmd) => {
    if (cmd === 'browser-backward') {
      event.preventDefault();
      sendToActiveDoc(win, 'mdviewer:nav-back');
    } else if (cmd === 'browser-forward') {
      event.preventDefault();
      sendToActiveDoc(win, 'mdviewer:nav-forward');
    }
  });

  // The window can also leave fullscreen without the tab asking (the OS
  // window controls, the window page opening the terminal), which would
  // strand the fullscreen document view with its chrome still hidden.
  win.on('leave-full-screen', () => {
    if (!host.aux) win.setMenuBarVisibility(true);
    if (!host.owner.isDestroyed()) {
      host.owner.webContents.send('shell:doc-fullscreen', { container: host.key, enabled: false });
    }
    sendToActiveDoc(win, 'window:fullscreen-changed', false);
  });
}

// The program window's page has (re)loaded: the tabs' pages went with the
// old one, the tab windows' contents too (they belong to the page that
// opened them). Their tabs come back into the program window, each to be
// loaded again in a new iframe.
function resetTabsAfterPageLoad(owner) {
  settleTabAsksOf(owner);
  const mainHost = hostOf(owner);
  if (!mainHost) return;
  for (const host of hostsOwnedBy(owner)) {
    if (host === mainHost) continue;
    for (const tab of host.tabs) {
      tab.host = mainHost;
      mainHost.tabs.push(tab);
    }
    host.tabs = [];
    host.closingApproved = true;
    if (!host.win.isDestroyed()) host.win.close();
  }
  for (const tab of mainHost.tabs) {
    tab.frame = null;
    stopWatching(tabWatchKey(tab));
  }
  if (!activeTabOf(mainHost)) mainHost.activeId = mainHost.tabs.length ? mainHost.tabs[0].id : null;
  notifyTabsChanged(mainHost);
}

// Before the window page reloads: each tab hands over what it holds, so it
// comes back as it was (unsaved text included).
async function snapshotTabsOf(owner) {
  const tabs = tabsOwnedBy(owner);
  const [snapshots] = await Promise.all([
    Promise.all(tabs.map((tab) => askTab(tab, 'snapshot', { timeout: TAB_SNAPSHOT_TIMEOUT_MS }))),
    Promise.all(tabs.map((tab) => snapshotPaneOf(tab, 'reloaded'))),
  ]);
  tabs.forEach((tab, i) => {
    const answer = snapshots[i] && typeof snapshots[i] === 'object' ? snapshots[i] : null;
    // A document tab that gave nothing keeps what it opens on already.
    if (answer || tab.kind !== 'doc') tab.init = TAB_KINDS[tab.kind].handOver(tab, answer, 'reloaded');
  });
}

function tabFromEvent(event, id) {
  const tab = tabsById.get(id);
  if (!tab) return null;
  return tab.host.owner === ownerOf(windowFor(event.sender)) ? tab : null;
}

// ---- The window page's side ----

appIpc.handle('tabs:open', (event, filePath, options = {}) => {
  const host = senderHost(event);
  if (!host || typeof filePath !== 'string' || !filePath) return { ok: false };
  const tab = openDocumentInTab(host, filePath, options || {});
  return { ok: true, id: tab.id };
});

// ---- Add-on tabs ----
// Opened from Extensions in the menu bar or the tab strip's "+" (and from
// commands, F3). instances "single" (the default) brings forward the tab
// already open in the program window; "multiple" opens another.

function openAddonTab(host, addonId, tabId, { init = {}, activate = true } = {}) {
  const found = addonTabContribution(addonId, tabId);
  if (!host || !found) return null;
  if ((found.contribution.instances || 'single') === 'single') {
    const open = tabsOwnedBy(host.owner).find((t) => t.kind === 'addon' && t.addon.id === addonId && t.addon.tabId === tabId);
    if (open) {
      activateAddons(`onTab:${tabId}`, (a) => a === `onTab:${tabId}`, addonId);
      if (activate) activateTab(open.host, open.id);
      return open;
    }
  }
  activateAddons(`onTab:${tabId}`, (a) => a === `onTab:${tabId}`, addonId);
  return createTab(host, { ...init, addonId, tabId }, { kind: 'addon', activate });
}

// One menu item per tab a running add-on contributes: "Add-on: Tab".
function addonTabMenuItems(onChoose) {
  if (!addonRegistry) return [];
  const items = [];
  for (const entry of addonRegistry.list()) {
    if (!addonRegistry.running(entry.id)) continue;
    for (const tab of (entry.manifest.contributes && entry.manifest.contributes.tabs) || []) {
      items.push({ label: `${entry.manifest.name}: ${tab.title}`, click: (item, win) => onChoose({ addonId: entry.id, tabId: tab.id }, win) });
    }
  }
  return items.length ? [{ type: 'separator' }, ...items] : [];
}

// The tab strip's "+": a new document, and the add-on tabs.
appIpc.handle('tabs:show-new-menu', (event, container) => {
  const host = senderHost(event, container);
  if (!host) return { ok: false };
  const items = [
    { label: t('menu.newDocument'), click: () => createTab(host, { draft: true }) },
    ...addonTabMenuItems((choice) => openAddonTab(host, choice.addonId, choice.tabId)),
  ];
  Menu.buildFromTemplate(items).popup({ window: host.win });
  return { ok: true };
});

// An add-on that stops running (turned off, gone, blocked) takes its tabs
// with it.
function closeTabsOfStoppedAddons() {
  for (const tab of [...tabsById.values()]) {
    if (tab.kind === 'addon' && !addonRegistry.running(tab.addon.id)) closeTab(tab, { force: true });
  }
}

// ---- Add-on tab frames (F0-b) ----
// An add-on's page in a tab gets a bridge of its own (mdviewerAddon, see
// preload.js) once main has made sure the frame really is that tab's
// page: an add-on page right under a program window's page (or one of its
// tab windows), in the origin of the add-on the tab is for. Until add-on
// tabs come (F2), test tabs are the ones that show add-on pages. These
// channels are outside appIpc, which keeps add-on frames away from the
// app's own.

function addonIdOf(url) {
  const origin = originIn(url, ADDON_SCHEME);
  return origin ? origin.slice(ADDON_SCHEME.length + 3) : '';
}

// The add-on page that sent `event`, as { tab, kind }: kind 'tab' for a
// test tab's page (right under a window page), 'pane' for a document tab's
// pane (right under that tab's page) — in the origin of the add-on the tab
// or pane is for. hint: the tab id from the page's address; the frame's
// place decides.
function addonFrameFor(event, hint) {
  const frame = event.senderFrame;
  if (!frame) return null;
  // A top frame: a background frame's page in its window.
  if (!frame.parent) {
    const rec = backgroundFrames && backgroundFrames.byContents(event.sender);
    return rec && addonIdOf(frame.url) === rec.id ? { rec, kind: 'background' } : null;
  }
  const win = windowFor(event.sender);
  if (!win) return null;
  const owner = ownerOf(win);
  const tab = tabsById.get(Number(hint));
  if (!appWindows.has(owner) || !tab || tab.host.owner !== owner) return null;
  const id = addonIdOf(frame.url);
  if (!id) return null;
  if (!frame.parent.parent) {
    return tab.kind === 'addon' && tab.addon.id === id ? { tab, kind: 'tab' } : null;
  }
  if (frame.parent.parent.parent) return null;
  const isPane = tab.kind === 'doc' && tab.pane && sameFrame(tab.frame, frame.parent) && addonIdOf(tab.pane.url) === id;
  return isPane ? { tab, kind: 'pane' } : null;
}

// Who an add-on call comes from: a frame that said hello, never what it
// claims.
function addonCallerOf(event) {
  const frame = event.senderFrame;
  if (!frame) return null;
  if (!frame.parent) {
    const rec = backgroundFrames && backgroundFrames.byContents(event.sender);
    return rec && rec.ready !== undefined ? { rec, kind: 'background', addonId: rec.id, tab: null } : null;
  }
  for (const tab of tabsById.values()) {
    if (tab.kind === 'addon' && sameFrame(tab.frame, frame)) return { tab, kind: 'tab', addonId: tab.addon.id };
    if (tab.pane && sameFrame(tab.pane.frame, frame)) return { tab, kind: 'pane', addonId: addonIdOf(tab.pane.url) };
  }
  return null;
}

// An add-on page's process can end on its own (a crash, killed from
// outside), and no event says so for a frame in another process: its
// WebFrameMain just stops being usable. So while add-on tabs and panes
// exist their frames are checked now and then. A document tab whose pane
// is gone is told (doc:pane-gone); for an add-on tab the window page
// shows that it stopped (tabs:frame-gone).
const ADDON_FRAME_CHECK_MS = 1500;
let addonFrameCheckTimer = null;

function frameGone(frame) {
  try {
    return !!frame.detached;
  } catch (err) {
    return true;
  }
}

function watchAddonFrames() {
  if (addonFrameCheckTimer) return;
  addonFrameCheckTimer = setInterval(() => {
    let any = false;
    for (const tab of tabsById.values()) {
      if (tab.kind === 'addon' && tab.frame) {
        any = true;
        if (frameGone(tab.frame)) {
          tab.frame = null;
          if (!tab.host.owner.isDestroyed()) tab.host.owner.webContents.send('tabs:frame-gone', { container: tab.host.key, id: tab.id });
        }
      }
      if (!tab.pane || !tab.pane.frame) continue;
      any = true;
      if (!frameGone(tab.pane.frame)) continue;
      tab.pane.frame = null;
      // Its page went too (moved, reloaded): nobody to tell.
      if (tab.frame && !frameGone(tab.frame)) sendToTab(tab, 'doc:pane-gone');
    }
    if (!any) {
      clearInterval(addonFrameCheckTimer);
      addonFrameCheckTimer = null;
    }
  }, ADDON_FRAME_CHECK_MS);
}

// A page has 10 s after hello to say it is ready (protocol 7.4); one that
// doesn't is logged (a background frame is also stopped, see there).
const ADDON_READY_TIMEOUT_MS = 10000;

function expectReady(holder, what) {
  clearTimeout(holder.readyTimer);
  holder.ready = false;
  holder.readyTimer = setTimeout(() => {
    if (!holder.ready) console.warn(`[addons] ${what} did not call ready() within ${ADDON_READY_TIMEOUT_MS / 1000} s`);
  }, ADDON_READY_TIMEOUT_MS);
}

// While run from source, a document tab's pane is the test add-on's.
const TEST_PANE_URL = `${ADDON_SCHEME}://test/pane.html`;

appIpc.handle('doc:open-pane', (event) => {
  const tab = senderTab(event);
  if (app.isPackaged || !tab || tab.kind !== 'doc') return null;
  if (!tab.pane) tab.pane = { url: TEST_PANE_URL, frame: null };
  return { url: `${withTabHint(tab.pane.url, tab.id)}&pane=1`, sandbox: FOREIGN_TAB_SANDBOX };
});

// Synchronous: the page's scripts must find the bridge in place. restore:
// what the page handed over before it moved or its window reloaded
// ({ reason: 'moved' | 'reloaded', state }), else { reason: 'new' }.
ipcMain.on('addon:hello', (event, hint) => {
  const found = addonFrameFor(event, hint);
  if (!found) {
    refuseIpc(event, 'addon:hello');
    // A page that reloaded into something refused is no longer the tab's
    // (or pane's) page: nothing there will answer for it.
    for (const other of tabsById.values()) {
      if (sameFrame(other.frame, event.senderFrame)) other.frame = null;
      if (other.pane && sameFrame(other.pane.frame, event.senderFrame)) other.pane.frame = null;
    }
    event.returnValue = { ok: false };
    return;
  }
  const { tab, kind } = found;
  let restore;
  if (kind === 'background') {
    restore = { reason: 'new', state: null };
  } else if (kind === 'pane') {
    tab.pane.frame = event.senderFrame;
    expectReady(tab.pane, `${addonIdOf(tab.pane.url)} pane of tab ${tab.id}`);
    restore = tab.paneRestore || { reason: 'new', state: null };
    tab.paneRestore = null;
  } else {
    tab.frame = event.senderFrame;
    expectReady(tab.addon, `${tab.addon.id} tab ${tab.id}`);
    restore = (tab.init && tab.init.restore) || { reason: 'new', state: null };
    tab.init = TAB_KINDS[tab.kind].reopen(tab);
  }
  watchAddonFrames();
  const addonId = kind === 'background' ? found.rec.id : kind === 'pane' ? addonIdOf(tab.pane.url) : tab.addon.id;
  const entry = addonRegistry.running(addonId);
  if (!entry) {
    event.returnValue = { ok: false };
    return;
  }
  const caller = apiCaller({ kind, addonId, tab: tab || null, rec: found.rec || null });
  event.returnValue = { ok: true, kind, app: addonAppInfo(entry), methods: addonApi.methodsFor(caller), restore };
});

ipcMain.on('addon:ready', (event) => {
  const caller = addonCallerOf(event);
  if (!caller) return;
  if (caller.kind === 'background') {
    backgroundFrames.markReady(caller.rec);
    return;
  }
  const holder = caller.kind === 'pane' ? caller.tab.pane : caller.tab.addon;
  holder.ready = true;
  clearTimeout(holder.readyTimer);
});

// Every add-on API call. The caller is the frame itself (a tab page that
// said hello), never what it claims.
// ---- Add-on API (protocol 8, 13) ----
// addons/api-router.js checks each call against the caller's add-on; the
// areas are in addons/api/*.js.
const addonApi = new ApiRouter();

registerAppApi(addonApi, {
  openExternal: (url) => shell.openExternal(url),
  writeClipboard: (text) => clipboard.writeText(text),
  // Until ui/* draws in the window page (F4), a native question.
  confirmOpen: async (caller, url) => {
    const win = (caller.tab && caller.tab.host.win) || targetWindow();
    const { response } = await dialog.showMessageBox(win, {
      type: 'question',
      message: t('addons.openExternal', { name: caller.entry.manifest.name }),
      detail: url,
      buttons: [t('addons.openExternalOk'), t('close.cancelButton')],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
    });
    return response === 0;
  },
});

// Not in the protocol: what the host knows of the calling frame, for
// trying things out (experimental, so only --addon-dev add-ons and those
// policy allows get it).
addonApi.register('app/info', {
  experimental: 'host.info',
  handler: ({ tab, kind, addonId }) => ({
    version: app.getVersion(),
    language: currentLanguage,
    addon: addonId,
    kind,
    tab: tab ? tab.id : null,
    window: tab ? tab.host.key : null,
  }),
});

// The experimental APIs open to an add-on: those its manifest names, if it
// was loaded with --addon-dev or policy allows it (protocol 5.4).
function openExperimentalApi(entry) {
  const named = (entry.manifest && entry.manifest.experimentalApi) || [];
  if (entry.source === 'dev') return named;
  const allowed = addonRegistryOptions().policy.allowExperimentalApi;
  return allowed.includes(entry.id) ? named : [];
}

// The caller as the router sees it: the frame (addonCallerOf) and its
// add-on, while that runs.
function apiCaller(found) {
  const entry = addonRegistry && addonRegistry.running(found.addonId);
  return entry ? { ...found, entry, experimentalApi: openExperimentalApi(entry) } : null;
}

// What mdviewerAddon.app holds (protocol 5.1, 7.4).
function addonAppInfo(entry) {
  return {
    version: app.getVersion(),
    language: currentLanguage,
    apiVersion: ADDON_HOST.api,
    capabilities: { ...ADDON_HOST.capabilities },
    experimentalApi: openExperimentalApi(entry),
    resources: { threadBudget: Math.max(1, Math.floor(os.cpus().length / 2)) },
  };
}

// Every add-on API call: { ok, result } or { ok: false, error }.
ipcMain.handle('addon:call', async (event, method, params) => {
  const found = addonCallerOf(event);
  const caller = found && apiCaller(found);
  if (!caller) {
    refuseIpc(event, 'addon:call');
    return { ok: false, error: { code: -32001, name: 'PermissionDenied', message: 'This frame is not a running add-on page' } };
  }
  if (caller.kind === 'background') backgroundFrames.callStarted(caller.rec);
  try {
    return await addonApi.call(caller, method, params);
  } finally {
    if (caller.kind === 'background') backgroundFrames.callEnded(caller.rec);
  }
});

appIpc.handle('tabs:new-draft', (event, container) => {
  const host = senderHost(event, container);
  if (!host) return { ok: false };
  createTab(host, { draft: true });
  return { ok: true };
});

appIpc.handle('tabs:activate', (event, id) => {
  const tab = tabFromEvent(event, id);
  if (tab) activateTab(tab.host, id);
});

appIpc.handle('tabs:close', async (event, id) => {
  const tab = tabFromEvent(event, id);
  return { closed: tab ? await closeTab(tab) : false };
});

// A tab dropped on a tab strip (container: which of the window page's) or
// on a document (into that document's window): from the same window it
// just changes place, from another one it moves in.
appIpc.handle('tabs:move-here', async (event, id, index, container) => {
  const dropTarget = senderTab(event);
  const host = dropTarget ? dropTarget.host : senderHost(event, container);
  const tab = tabsById.get(id);
  if (!host || !tab) return { ok: false };
  await moveTab(tab, host, index);
  return { ok: true };
});

appIpc.handle('tabs:detach', async (event, id, screenPoint) => {
  const tab = tabFromEvent(event, id);
  if (!tab) return { ok: false };
  await detachTab(tab, screenPoint);
  return { ok: true };
});

appIpc.handle('tabs:show-context-menu', (event, id) => {
  const tab = tabFromEvent(event, id);
  if (!tab) return { ok: false };
  const host = tab.host;
  const index = host.tabs.indexOf(tab);
  const others = host.tabs.filter((t) => t !== tab);
  const filePath = tab.kind === 'doc' ? tab.doc.path : null;
  const items = [
    { label: t('tabs.close'), accelerator: 'CmdOrCtrl+W', click: () => closeTab(tab) },
    { label: t('tabs.closeOthers'), enabled: others.length > 0, click: () => closeTabs(others) },
    {
      label: t('tabs.closeRight'),
      enabled: index < host.tabs.length - 1,
      click: () => closeTabs(host.tabs.slice(index + 1)),
    },
  ];
  items.push({ type: 'separator' });
  if (host.aux) {
    items.push({ label: t('tabs.moveToMainWindow'), click: () => moveTab(tab, hostOf(host.owner)) });
  }
  items.push({
    label: t('tabs.moveToNewWindow'),
    enabled: !(host.aux && host.tabs.length === 1),
    click: () => detachTab(tab),
  });
  if (filePath) {
    items.push(
      { type: 'separator' },
      { label: t('tabs.copyPath'), click: () => clipboard.writeText(filePath) },
      { label: t('tabs.showInFolder'), click: () => shell.showItemInFolder(filePath) }
    );
  }
  Menu.buildFromTemplate(items).popup({ window: host.win });
  return { ok: true };
});

// After a relaunch: the window's tabs as they were. Only the active one
// is focused; all of them load.
appIpc.handle('tabs:restore', (event, tabs, activeIndex) => {
  const host = senderHost(event);
  if (!host || !Array.isArray(tabs)) return { ok: false };
  let activeTab = null;
  tabs.forEach((entry, i) => {
    if (!entry) return;
    let tab = null;
    if (typeof entry.addon === 'string' && typeof entry.tab === 'string') {
      // An add-on that no longer runs leaves its tab behind.
      tab = openAddonTab(host, entry.addon, entry.tab, { init: { restore: { reason: 'restored', state: null } }, activate: false });
    } else if (typeof entry.path === 'string' && !findTabForPath(host.owner, entry.path)) {
      tab = createTab(host, { filePath: entry.path }, { activate: false });
    }
    if (tab && i === activeIndex) activeTab = tab;
  });
  const target = activeTab || host.tabs[0];
  if (target) activateTab(host, target.id);
  return { ok: true };
});

// Closing projects closes their documents' tabs (in tab windows too),
// unsaved edits asked about one at a time. Resolves to whether they all
// closed.
appIpc.handle('tabs:close-under', async (event, roots) => {
  const owner = ownerOf(windowFor(event.sender));
  if (!owner || !Array.isArray(roots)) return false;
  const inside = tabsOwnedBy(owner).filter(
    (tab) =>
      tab.kind === 'doc' &&
      tab.doc.path &&
      !tab.doc.instantView &&
      roots.some((root) => isPathInside(tab.doc.path, root))
  );
  return closeTabs(inside);
});

appIpc.on('css:live', (event, rootPath, css, enabled) => {
  if (!rootPath) return;
  liveCssByRoot.set(path.resolve(rootPath).toLowerCase(), { css: String(css || ''), enabled: enabled !== false });
  sendToAllTabs('css:live', { root: rootPath, css: String(css || ''), enabled: enabled !== false });
});

appIpc.handle('css:get-live', (event, rootPath) => {
  if (!rootPath) return null;
  return liveCssByRoot.get(path.resolve(rootPath).toLowerCase()) || null;
});

// Brings the program window forward with the keyboard on its page (the
// terminal, from a tab in a tab window).
appIpc.handle('window:focus-page', (event) => {
  const owner = ownerOf(windowFor(event.sender));
  if (!owner || owner.isDestroyed()) return;
  if (!owner.isFocused()) owner.focus();
  owner.webContents.focus();
});

// ---- The tab page's side ----

// A tab's page has loaded — the tab is new, moved, or its window's page
// reloaded — and asks what to show.
appIpc.on('tab:hello', (event, id) => {
  const tab = tabsById.get(Number(id));
  if (!tab || !event.senderFrame) return;
  if (ownerOf(windowFor(event.sender)) !== tab.host.owner) return;
  tab.frame = event.senderFrame;
  // A pane went with the page it was in; the page asks again.
  tab.pane = null;
  TAB_KINDS[tab.kind].hello(tab);
});

appIpc.on('doc:state', (event, docState) => {
  const tab = senderTab(event);
  if (!tab || tab.kind !== 'doc' || !docState) return;
  tab.doc = {
    path: typeof docState.path === 'string' ? docState.path : null,
    fileKind: docState.kind || 'markdown',
    dirty: !!docState.dirty,
    editMode: !!docState.editMode,
    draft: !!docState.draft,
    instantView: !!docState.instantView,
  };
  notifyTabsChanged(tab.host);
});

// A link to another document: when another tab of the program window (or
// its tab windows) already shows it, that tab comes forward (and shows the
// spot linked to) instead of this one navigating away.
appIpc.handle('doc:open', (event, filePath, target) => {
  const tab = senderTab(event);
  if (!tab || !filePath) return { handled: false };
  const other = findTabForPath(tab.host.owner, filePath);
  if (!other || other === tab) return { handled: false };
  activateTab(other.host, other.id);
  if (target && Object.keys(target).length) sendToTab(other, 'doc:navigate', { target });
  return { handled: true };
});

// Leaving edit mode on a draft discards it, and its tab with it (the page
// has settled its text already).
appIpc.handle('doc:close-self', (event) => {
  const tab = senderTab(event);
  if (tab) closeTab(tab, { force: true });
});

// A tab closing with unsaved text that auto save couldn't write.
// Saving would write over a file changed on disk since it was read:
// 'overwrite', 'reload' (take the disk's text) or 'cancel'.
appIpc.handle('doc:confirm-save-conflict', (event, filePath) => {
  const win = windowFor(event.sender);
  const choice = dialog.showMessageBoxSync(win, {
    type: 'warning',
    title: t('conflict.title'),
    message: t('conflict.message', { name: path.basename(filePath || '') }),
    detail: t('conflict.detail'),
    buttons: [t('conflict.overwrite'), t('conflict.reload'), t('close.cancelButton')],
    defaultId: 2,
    cancelId: 2,
    noLink: true,
  });
  return ['overwrite', 'reload', 'cancel'][choice] || 'cancel';
});

appIpc.handle('doc:confirm-discard', (event) => {
  const win = windowFor(event.sender);
  const choice = dialog.showMessageBoxSync(win, {
    type: 'warning',
    title: t('close.discardTitle'),
    message: t('close.discardMessage'),
    buttons: [t('close.discardButton'), t('close.cancelButton')],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
  });
  return choice === 0;
});

appIpc.on('doc:shell-request', (event, action, payload) => {
  const owner = ownerOf(windowFor(event.sender));
  if (!owner || owner.isDestroyed()) return;
  owner.webContents.send('shell:request', { action, payload });
});

// ---- Bottom terminal panel: real PTY-backed shells per window ----
// Uses node-pty (ConPTY on Windows / a real pty on macOS/Linux) so the
// embedded terminal behaves like a normal shell: colors, cursor movement,
// Tab completion, Ctrl+C, and interactive/curses programs all work.

// Shells killed on purpose (restart, project closed, window closed). Their
// exit is expected, so it isn't reported as "shell exited" — on a restart
// that report would land in the session's fresh shell.
const killedTerminals = new WeakSet();

function getTerminal(webContentsId, key) {
  const sessions = terminals.get(webContentsId);
  return sessions ? sessions.get(key) : undefined;
}

// Kills one session, or every session of the window when key is omitted.
function killTerminal(webContentsId, key) {
  const sessions = terminals.get(webContentsId);
  if (!sessions) return;
  const keys = key === undefined ? [...sessions.keys()] : [key];
  for (const k of keys) {
    const proc = sessions.get(k);
    if (!proc) continue;
    killedTerminals.add(proc);
    try {
      proc.kill();
    } catch (err) {
      /* already dead */
    }
    sessions.delete(k);
  }
  if (!sessions.size) terminals.delete(webContentsId);
}

function spawnTerminalFor(event, key, cwd, cols, rows) {
  const webContentsId = event.sender.id;
  killTerminal(webContentsId, key);

  const isWin = process.platform === 'win32';
  const shellExe = isWin ? 'powershell.exe' : process.env.SHELL || '/bin/bash';
  // Windows PowerShell's default console output encoding is the legacy
  // OEM/ANSI codepage, not UTF-8, which garbles non-ASCII (e.g. Korean)
  // output/filenames even under ConPTY. Force UTF-8 before dropping into
  // the interactive session.
  // The prompt is also wrapped to report the shell's current folder before
  // each prompt (OSC 9;9, as Windows Terminal reads it), so "Duplicate" on
  // a terminal tab can start the copy where the shell has cd'd to. -Command
  // runs after the profile, so this wraps whatever prompt the profile set.
  const shellArgs = isWin
    ? [
        '-NoLogo',
        '-NoExit',
        '-Command',
        '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; chcp 65001 | Out-Null; ' +
          '$global:__mdvPrompt = $function:prompt; ' +
          'function global:prompt { ' +
          "$loc = $executionContext.SessionState.Path.CurrentLocation; $out = ''; " +
          "if ($loc.Provider.Name -eq 'FileSystem') { $out = [char]27 + ']9;9;' + [char]34 + $loc.ProviderPath + [char]34 + [char]7 }; " +
          '$out + (& $global:__mdvPrompt) }',
      ]
    : [];

  const ptyProcess = pty.spawn(shellExe, shellArgs, {
    name: 'xterm-color',
    cols: cols || 80,
    rows: rows || 24,
    cwd,
    env: process.env,
  });
  if (!terminals.has(webContentsId)) terminals.set(webContentsId, new Map());
  terminals.get(webContentsId).set(key, ptyProcess);

  const sender = event.sender;
  ptyProcess.onData((data) => {
    if (!sender.isDestroyed()) sender.send('term:data', key, data);
  });
  ptyProcess.onExit(({ exitCode }) => {
    if (killedTerminals.has(ptyProcess)) return;
    if (!sender.isDestroyed()) sender.send('term:exit', key, exitCode);
    const sessions = terminals.get(webContentsId);
    if (sessions && sessions.get(key) === ptyProcess) {
      sessions.delete(key);
      if (!sessions.size) terminals.delete(webContentsId);
    }
  });
}

// Only one instance may hold the file association: a second double-click
// on a .md file should hand its path to the window the user was last in
// instead of spawning a competing process. Starting the program again with
// nothing to open asks for another window, which this process opens.
// ---- Add-ons: finding them ----
// The add-ons the app knows (addons/registry.js), looked for in protocol
// 4.2's order: --addon-dev folders (run from source only), the folders in
// the addons.extraDirs setting, then the install folder. Only an add-on
// that can run has its pages served (addons/protocol.js).
registerAddonScheme([EMBED_FILE_SCHEME_ENTRY]);
// An add-on's tabs (iframes under the app's file: page) and its background
// frame (a window of its own) are the same origin and share web storage
// (protocol 4.4). Chromium would otherwise key an iframe's storage by the
// page it sits in as well; the app embeds no third-party sites, which is
// what that partitioning guards against. (The background check in
// test/app notices if this switch ever stops working.)
app.commandLine.appendSwitch('disable-features', 'ThirdPartyStoragePartitioning');

let addonRegistry = null;
let backgroundFrames = null;

// A background frame's window stays on its add-on's pages and opens no
// windows.
function guardBackgroundWindow(win) {
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event) => {
    const here = originIn(win.webContents.getURL(), ADDON_SCHEME);
    if (here && originIn(event.url, ADDON_SCHEME) !== here) {
      event.preventDefault();
      console.warn(`[nav] blocked a background frame going from ${win.webContents.getURL()} to ${event.url}`);
    }
  });
}

// Whether an add-on has a tab or pane open (it is not idle then).
function addonHasOpenFrames(id) {
  for (const tab of tabsById.values()) {
    if (tab.kind === 'addon' && tab.addon.id === id) return true;
    if (tab.pane && addonIdOf(tab.pane.url) === id) return true;
  }
  return false;
}

// ---- Add-ons: activation (protocol 7.3) ----
// An activation event starts the background frame of each running add-on
// that has one and listens for the event. onCommand comes with commands
// (F3).

function activateAddons(why, matches, onlyId = null) {
  if (!addonRegistry || !backgroundFrames) return;
  for (const entry of addonRegistry.list()) {
    if (onlyId && entry.id !== onlyId) continue;
    if (!addonRegistry.running(entry.id) || !entry.manifest.background) continue;
    if (entry.activation.some(matches)) backgroundFrames.start(entry, why);
  }
}

function openProjectRoots() {
  return [...windowProjects.values()].flatMap((entry) => entry.roots || []);
}

// onStartup, onProject and onProjectContains:<name>, as things are now.
function activateForStartupAndProjects() {
  activateAddons('onStartup', (a) => a === 'onStartup');
  const roots = openProjectRoots();
  if (!roots.length) return;
  activateAddons('onProject', (a) => a === 'onProject');
  activateAddons('onProjectContains', (a) => {
    if (!a.startsWith('onProjectContains:')) return false;
    const name = a.slice('onProjectContains:'.length);
    return roots.some((root) => fs.existsSync(path.join(root, name)));
  });
}

function addonDevDirs() {
  return app.isPackaged ? [] : switchValues(process.argv, '--addon-dev').map((dir) => path.resolve(dir));
}

// %LOCALAPPDATA%\mdviewer\addons, out of the roaming profile (an add-on
// can be big). Run from source, MDVIEWER_ADDONS_DIR can point elsewhere
// (the app checks use an empty one).
function addonInstallDir() {
  if (!app.isPackaged && process.env.MDVIEWER_ADDONS_DIR) return process.env.MDVIEWER_ADDONS_DIR;
  return path.join(process.env.LOCALAPPDATA || app.getPath('appData'), 'mdviewer', 'addons');
}

// policy.json next to the installed program (an administrator's, protocol
// 10.4). Run from source, MDVIEWER_POLICY_FILE can name one.
function addonPolicyFile() {
  const file = app.isPackaged ? path.join(path.dirname(app.getPath('exe')), 'policy.json') : process.env.MDVIEWER_POLICY_FILE;
  if (!file) return {};
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf-8'));
    return value && typeof value === 'object' ? value : {};
  } catch (err) {
    return {};
  }
}

let addonStore = null;

// Where to look, the policy and the user's choices, as of now (the
// settings may have changed since the last look).
function addonRegistryOptions() {
  const settings = loadSettings();
  const extraDirs = settings['addons.extraDirs'];
  return {
    language: currentLanguage,
    devDirs: addonDevDirs(),
    extraDirs: Array.isArray(extraDirs) ? extraDirs.filter((d) => typeof d === 'string') : [],
    installDir: addonInstallDir(),
    policy: mergePolicy(settings, addonPolicyFile()),
    isEnabled: (id) => addonStore.isEnabled(id),
  };
}

function startAddonRegistry() {
  addonStore = new AddonStore(path.join(app.getPath('userData'), 'addons-state.json'));
  addonRegistry = new AddonRegistry(addonRegistryOptions());
  backgroundFrames = createBackgroundFrames({
    BrowserWindow,
    preload: path.join(__dirname, 'preload.js'),
    scheme: ADDON_SCHEME,
    ask: (frame, kind, timeout) => askFrame(frame, null, kind, { timeout }),
    busy: (id) => addonHasOpenFrames(id),
    running: (id) => addonRegistry.running(id),
    log: (message) => console.log(message),
    onChange: () => notifyAddonsChanged(),
    guard: guardBackgroundWindow,
  });
  for (const entry of addonRegistry.rescan()) {
    const why = entry.problems.map((p) => `${p.path || '-'} ${p.code}${p.detail ? ` (${p.detail})` : ''}`).join('; ');
    console.log(`[addons] ${entry.id} (${entry.source}) ${entry.status}${entry.enabled ? '' : ', off'}${why ? `: ${why}` : ''}`);
  }
}

// What the management screen shows of each add-on found.
function addonListForPage() {
  return addonRegistry.list().map((e) => ({
    id: e.id,
    name: (e.manifest && e.manifest.name) || e.id,
    version: (e.manifest && e.manifest.version) || '',
    description: (e.manifest && e.manifest.description) || '',
    publisher: (e.manifest && e.manifest.publisher) || '',
    source: e.source,
    dir: e.dir,
    status: e.status,
    enabled: e.enabled,
    problems: e.problems,
    warnings: e.warnings,
    activation: e.activation,
    // Its background frame: 'starting', 'running', 'stopping', 'error',
    // 'failed' or null (not running).
    background: e.manifest && e.manifest.background ? backgroundFrames.stateOf(e.id) : undefined,
    // The tabs it can open now (for the tab strip's "+").
    tabs: addonRegistry.running(e.id) ? ((e.manifest.contributes && e.manifest.contributes.tabs) || []).map((tab) => tab.id) : [],
  }));
}

function notifyAddonsChanged() {
  const list = addonListForPage();
  for (const win of appWindows) {
    if (!win.isDestroyed()) win.webContents.send('addons:changed', list);
  }
  return list;
}

// Looks again, as of the settings and policy now (Extensions > Rescan, the
// management screen's button).
function rescanAddons() {
  addonRegistry.rescan(addonRegistryOptions());
  closeTabsOfStoppedAddons();
  for (const id of backgroundFrames.ids()) {
    if (!addonRegistry.running(id)) backgroundFrames.stop(id, 'turned off');
  }
  activateForStartupAndProjects();
  buildAppMenu();
  return notifyAddonsChanged();
}

appIpc.handle('addons:list', () => addonListForPage());
appIpc.handle('addons:rescan', () => rescanAddons());
appIpc.handle('addons:set-enabled', (event, id, enabled) => {
  if (typeof id !== 'string' || !addonRegistry.get(id)) return addonListForPage();
  addonStore.setEnabled(id, !!enabled);
  return rescanAddons();
});

function resolveAddonPages(id) {
  const entry = addonRegistry && addonRegistry.running(id);
  if (!entry) return null;
  const network = entry.manifest.network;
  return { dir: entry.dir, hosts: network && Array.isArray(network.hosts) ? network.hosts : [] };
}

const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', (event, argv, workingDirectory) => {
    if (!app.isReady()) return;
    const target = extractOpenTargetFromArgv(argv, workingDirectory);
    if (!target) {
      createWindow();
      return;
    }
    const win = targetWindow() || createWindow();
    if (win.isMinimized()) win.restore();
    win.focus();
    openTargetInWindow(win, target);
  });

  app.whenReady().then(() => {
    registerEmbedFileProtocol();
    startAddonRegistry();
    serveAddonPages(resolveAddonPages);
    limitPermissionsToAppPages();
    refuseAddonDownloads();
    const win = createWindow();
    activateForStartupAndProjects();
    const target = extractOpenTargetFromArgv(process.argv);
    if (target) openTargetInWindow(win, target);
    restoreProjectsFromArgv(process.argv, win);

    app.on('activate', () => {
      if (appWindows.size === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}

// ---- IPC handlers ----

appIpc.handle('dialog:open-folder', async (event) => {
  const result = await dialog.showOpenDialog(windowFor(event.sender), {
    properties: ['openDirectory'],
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});

appIpc.handle('dialog:open-file', async (event) => {
  const customExtensions = getCustomTextExtensions();
  const result = await dialog.showOpenDialog(windowFor(event.sender), {
    properties: ['openFile'],
    filters: [
      {
        name: 'Supported Files',
        extensions: [
          'md', 'markdown', 'puml', 'json', 'pdf', 'txt', 'log', ...Object.keys(CODE_LANGUAGE_BY_EXT), ...customExtensions,
        ],
      },
      { name: 'Markdown', extensions: ['md', 'markdown'] },
      { name: 'HTML', extensions: ['html', 'htm', 'xhtml'] },
      { name: 'PDF', extensions: ['pdf'] },
      { name: 'PlantUML', extensions: ['puml'] },
      { name: 'JSON', extensions: ['json'] },
      { name: 'Text', extensions: ['txt', 'log', ...customExtensions] },
      { name: 'Source Code', extensions: Object.keys(CODE_LANGUAGE_BY_EXT) },
    ],
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});

// Save As for an untitled draft: the draft has no path until the user
// picks one here.
appIpc.handle('dialog:save-file', async (event, defaultDir, defaultName) => {
  const result = await dialog.showSaveDialog(windowFor(event.sender), {
    title: t('draft.saveDialogTitle'),
    defaultPath: defaultDir ? path.join(defaultDir, defaultName) : defaultName,
    filters: [
      { name: 'Markdown', extensions: ['md', 'markdown'] },
      { name: 'All Files', extensions: ['*'] },
    ],
  });
  if (result.canceled || !result.filePath) return null;
  return result.filePath;
});

appIpc.handle('fs:list-dir', (event, dirPath) => {
  try {
    return { ok: true, items: listDir(dirPath) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

appIpc.handle('search:project', async (event, rootPath, query, options) => {
  try {
    return await searchProjectDocuments(rootPath, query, options || {});
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

appIpc.handle('search:cancel', (event, searchId) => {
  if (searchId) {
    // A cancel that lands after its search already finished leaves the id
    // behind (nothing is left to delete it); keep the set from growing
    // without bound, since each window has at most one search in flight.
    if (canceledSearches.size > 64) canceledSearches.clear();
    canceledSearches.add(searchId);
  }
  return { ok: true };
});

appIpc.handle('fs:render-markdown', async (event, filePath, requestId) => {
  try {
    const html = await renderMarkdownFile(filePath, requestId);
    return { ok: true, html, name: path.basename(filePath) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

appIpc.handle('fs:render-plantuml', async (event, filePath, requestId) => {
  try {
    const html = await renderPlantUmlFile(filePath, requestId);
    return { ok: true, html, name: path.basename(filePath) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

appIpc.handle('fs:render-json', (event, filePath) => {
  try {
    const html = renderJsonFile(filePath);
    return { ok: true, html, name: path.basename(filePath) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

appIpc.handle('fs:render-plaintext', (event, filePath) => {
  try {
    const html = renderPlainTextFile(filePath);
    return { ok: true, html, name: path.basename(filePath) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// version: see lib/doc-version.js. Passed back to fs:write-file, it keeps
// a save from writing over what changed on disk since the read
// ({ ok: false, conflict: true }).
appIpc.handle('fs:read-file', (event, filePath) => {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    return { ok: true, content, version: contentVersion(content) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

appIpc.handle('fs:write-file', (event, filePath, content, expectedVersion) => {
  try {
    return writeIfUnchanged(fs, filePath, content, expectedVersion);
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// Windows-illegal filename characters, plus the path separators and control
// characters — a bare name for a single new entry, not a path, so any of
// these means it's trying to escape the target directory or would fail at
// the filesystem level anyway.
function validateNewEntryName(name) {
  const trimmed = (name || '').trim();
  if (!trimmed) return { ok: false, error: t('tree.newNameEmpty') };
  if (trimmed === '.' || trimmed === '..') return { ok: false, error: t('tree.newNameInvalid') };
  if (/[\\/<>:"|?*\x00-\x1f]/.test(trimmed)) return { ok: false, error: t('tree.newNameInvalid') };
  return { ok: true, name: trimmed };
}

function createTreeEntry(dirPath, name, kind) {
  const validation = validateNewEntryName(name);
  if (!validation.ok) return { ok: false, error: validation.error };
  const fullPath = path.join(dirPath, validation.name);
  if (fs.existsSync(fullPath)) return { ok: false, error: t('tree.newAlreadyExists') };
  try {
    if (kind === 'folder') fs.mkdirSync(fullPath);
    else fs.writeFileSync(fullPath, '', 'utf-8');
    return { ok: true, path: fullPath };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

appIpc.handle('fs:create-file', (event, dirPath, name) => createTreeEntry(dirPath, name, 'file'));
appIpc.handle('fs:create-folder', (event, dirPath, name) => createTreeEntry(dirPath, name, 'folder'));

// ---------------------------------------------------------------------
// Drag-and-drop copy into the project
// ---------------------------------------------------------------------

// Path identity for the comparisons below. Windows paths are compared
// case-insensitively because the filesystem is, so C:\Docs and c:\docs are
// the same folder for "is this being copied into itself?" purposes.
function samePathKey(p) {
  const resolved = path.resolve(p);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

// True when `child` IS `parent` or sits underneath it. Copying a folder into
// itself or into one of its own descendants would otherwise recurse until
// the disk filled up.
function isSameOrInside(parent, child) {
  const rel = path.relative(samePathKey(parent), samePathKey(child));
  return rel === '' || (!rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel));
}

// A dropped name that already exists is never overwritten — the copy gets a
// numbered suffix instead, the way pasted images do. Dropping is an easy
// gesture to make by accident, so it must not be able to destroy work.
function uniqueDestPath(dir, name) {
  let candidate = path.join(dir, name);
  if (!fs.existsSync(candidate)) return candidate;
  const ext = path.extname(name);
  const stem = path.basename(name, ext);
  let n = 2;
  do {
    candidate = path.join(dir, `${stem} (${n++})${ext}`);
  } while (fs.existsSync(candidate));
  return candidate;
}

async function copyEntriesInto(targetDir, sourcePaths) {
  let targetStat;
  try {
    targetStat = await fs.promises.stat(targetDir);
  } catch (err) {
    return { ok: false, error: err.message };
  }
  if (!targetStat.isDirectory()) return { ok: false, error: 'Drop target is not a folder' };

  const copied = [];
  const skipped = [];

  for (const source of sourcePaths) {
    const name = path.basename(source);
    let sourceStat;
    try {
      sourceStat = await fs.promises.stat(source);
    } catch (err) {
      skipped.push({ name, reason: 'missing' });
      continue;
    }
    if (sourceStat.isDirectory() && isSameOrInside(source, targetDir)) {
      skipped.push({ name, reason: 'intoItself' });
      continue;
    }

    const dest = uniqueDestPath(targetDir, name);
    try {
      // errorOnExist guards the (impossible by construction) race where
      // something else creates the name between the check and the copy —
      // better to report a skip than to clobber it.
      await fs.promises.cp(source, dest, { recursive: true, errorOnExist: true, force: false });
      copied.push({ path: dest, name: path.basename(dest), renamed: path.basename(dest) !== name });
    } catch (err) {
      skipped.push({ name, reason: 'error', error: err.message });
    }
  }

  return { ok: true, copied, skipped };
}

appIpc.handle('fs:copy-entries', async (event, targetDir, sourcePaths) => {
  try {
    return await copyEntriesInto(targetDir, Array.isArray(sourcePaths) ? sourcePaths : []);
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// Moves one tree entry into another folder (tree drag and drop). Unlike a
// copy, a name clash is refused rather than renamed: the user is relocating
// a specific file, and quietly turning it into "name (2)" would break every
// link that points at it.
async function moveEntryInto(sourcePath, targetDir) {
  let targetStat;
  try {
    targetStat = await fs.promises.stat(targetDir);
  } catch (err) {
    return { ok: false, code: 'error', error: err.message };
  }
  if (!targetStat.isDirectory()) return { ok: false, code: 'error', error: 'Drop target is not a folder' };

  let sourceStat;
  try {
    sourceStat = await fs.promises.stat(sourcePath);
  } catch (err) {
    return { ok: false, code: 'missing', error: err.message };
  }
  if (sourceStat.isDirectory() && isSameOrInside(sourcePath, targetDir)) {
    return { ok: false, code: 'intoItself' };
  }

  const dest = path.join(targetDir, path.basename(sourcePath));
  if (samePathKey(dest) === samePathKey(sourcePath)) return { ok: true, path: sourcePath, unchanged: true };
  if (fs.existsSync(dest)) return { ok: false, code: 'exists', name: path.basename(dest) };

  try {
    await fs.promises.rename(sourcePath, dest);
  } catch (err) {
    // rename cannot cross drives; fall back to copy-then-delete there.
    if (err.code !== 'EXDEV') return { ok: false, code: 'error', error: err.message };
    try {
      await fs.promises.cp(sourcePath, dest, { recursive: true, errorOnExist: true, force: false });
      await fs.promises.rm(sourcePath, { recursive: true, force: true });
    } catch (copyErr) {
      return { ok: false, code: 'error', error: copyErr.message };
    }
  }
  return { ok: true, path: dest };
}

appIpc.handle('fs:move-entry', async (event, sourcePath, targetDir) => {
  // On Windows an open document's watcher holds a handle on its folder,
  // which makes renaming that folder (or one above it) fail with EPERM. Any
  // tab in any window may have one, so all go; every tab is then told where
  // the entry went (nowhere, if the move failed) and watches its document
  // again from there.
  for (const id of [...fileWatchers.keys()]) stopWatching(id);
  let result;
  try {
    result = await moveEntryInto(sourcePath, targetDir);
  } catch (err) {
    result = { ok: false, code: 'error', error: err.message };
  }
  const to = result.ok && !result.unchanged ? result.path : sourcePath;
  sendToAllTabs('doc:path-moved', { from: sourcePath, to });
  return result;
});

// Renames one tree entry in place (F2 / the tree's Rename menu item). As
// with a move, an existing name is refused rather than overwritten — except
// when only the letter case changes, which on Windows and macOS names the
// same entry.
async function renameEntryTo(sourcePath, newName) {
  const validation = validateNewEntryName(newName);
  if (!validation.ok) return { ok: false, code: 'invalid', error: validation.error };
  try {
    await fs.promises.stat(sourcePath);
  } catch (err) {
    return { ok: false, code: 'missing', error: err.message };
  }
  const dest = path.join(path.dirname(sourcePath), validation.name);
  if (dest === sourcePath) return { ok: true, path: sourcePath, unchanged: true };
  if (samePathKey(dest) !== samePathKey(sourcePath) && fs.existsSync(dest)) {
    return { ok: false, code: 'exists', error: t('tree.newAlreadyExists') };
  }
  try {
    await fs.promises.rename(sourcePath, dest);
  } catch (err) {
    return { ok: false, code: 'error', error: err.message };
  }
  return { ok: true, path: dest };
}

appIpc.handle('fs:rename-entry', async (event, sourcePath, newName) => {
  // Same watcher dance as fs:move-entry: a watched folder can't be renamed
  // on Windows, and the tabs need to learn the new path either way.
  for (const id of [...fileWatchers.keys()]) stopWatching(id);
  let result;
  try {
    result = await renameEntryTo(sourcePath, newName);
  } catch (err) {
    result = { ok: false, code: 'error', error: err.message };
  }
  const to = result.ok && !result.unchanged ? result.path : sourcePath;
  sendToAllTabs('doc:path-moved', { from: sourcePath, to });
  return result;
});

// F2 in a document tab (see src/doc.js): the explorer of the window the tab
// belongs to starts renaming that document's file.
appIpc.handle('tree:request-rename', (event, itemPath) => {
  const owner = ownerOf(windowFor(event.sender));
  if (!owner || owner.isDestroyed() || !itemPath) return;
  if (!owner.isFocused()) owner.focus();
  owner.webContents.focus();
  owner.webContents.send('tree:rename', { itemPath });
});

appIpc.handle('fs:stat-path', async (event, targetPath) => {
  try {
    const stat = await fs.promises.stat(targetPath);
    return { ok: true, isDir: stat.isDirectory(), isFile: stat.isFile() };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// ---------------------------------------------------------------------
// File links: Ctrl+click on a file name in the terminal or the source
// editor (see findPathCandidates in src/renderer.js). The renderer sends the
// path-looking tokens it found and gets back, for each, the existing files
// it names — usually one, several when only a bare file name was written
// and the project has more than one file by that name.
// ---------------------------------------------------------------------

// Every file under a project by lowercased name, for names written without
// their folder (or relative to a folder the shell has cd'd into, which the
// app cannot see). Rebuilt at most every few seconds: the terminal asks
// again on every line the mouse crosses.
const LINK_INDEX_TTL_MS = 10 * 1000;
const LINK_INDEX_MAX_FILES = 50000;
const linkIndexCache = new Map(); // rootPath -> { builtAt, promise }

async function buildLinkIndex(rootPath) {
  const byName = new Map();
  const isUserHidden = hiddenNameMatcher();
  let count = 0;
  async function walk(dir) {
    if (count >= LINK_INDEX_MAX_FILES) return;
    let entries;
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch (err) {
      return;
    }
    const subDirs = [];
    for (const entry of entries) {
      if (isHidden(entry.name) || isUserHidden(entry.name)) continue;
      if (entry.isDirectory()) {
        if (!SEARCH_SKIP_DIRS.has(entry.name.toLowerCase())) subDirs.push(path.join(dir, entry.name));
        continue;
      }
      if (!entry.isFile()) continue;
      if (++count > LINK_INDEX_MAX_FILES) return;
      const key = entry.name.toLowerCase();
      const full = path.join(dir, entry.name);
      const list = byName.get(key);
      if (list) list.push(full);
      else byName.set(key, [full]);
    }
    for (const sub of subDirs) await walk(sub);
  }
  await walk(rootPath);
  return byName;
}

function linkIndexFor(rootPath) {
  const cached = linkIndexCache.get(rootPath);
  if (cached && Date.now() - cached.builtAt < LINK_INDEX_TTL_MS) return cached.promise;
  const promise = buildLinkIndex(rootPath);
  linkIndexCache.set(rootPath, { builtAt: Date.now(), promise });
  return promise;
}

async function isExistingFile(filePath) {
  try {
    return (await fs.promises.stat(filePath)).isFile();
  } catch (err) {
    return false;
  }
}

async function resolveLinkPath(candidate, baseDirs, rootPath) {
  // Git Bash prints /d/work/x.md for D:\work\x.md.
  if (process.platform === 'win32') {
    candidate = candidate.replace(/^\/([a-zA-Z])(?=\/)/, (m, drive) => drive.toUpperCase() + ':');
  }
  if (path.isAbsolute(candidate)) {
    const full = path.normalize(candidate);
    return (await isExistingFile(full)) ? [full] : [];
  }
  for (const base of baseDirs) {
    if (!base) continue;
    const full = path.resolve(base, candidate);
    if (await isExistingFile(full)) return [full];
  }
  if (!rootPath) return [];
  // Not found where it was expected: any file in the project whose path
  // ends with what was written.
  const index = await linkIndexFor(rootPath);
  const normalized = path.normalize(candidate).replace(/^(\.[\\/])+/, '').toLowerCase();
  const matches = index.get(path.basename(normalized)) || [];
  return matches.filter((full) => {
    const lower = full.toLowerCase();
    return lower === normalized || lower.endsWith(path.sep + normalized);
  });
}

appIpc.handle('fs:resolve-link-paths', async (event, candidates, baseDirs, rootPath) => {
  const results = [];
  for (const candidate of candidates) {
    try {
      results.push(await resolveLinkPath(candidate, baseDirs || [], rootPath || ''));
    } catch (err) {
      results.push([]);
    }
  }
  return results;
});

// A popup listing the files a link could mean; resolves with the picked
// index, or -1 when the menu was dismissed.
appIpc.handle('menu:pick-path', (event, labels) => {
  const win = windowFor(event.sender);
  return new Promise((resolve) => {
    let picked = -1;
    const menu = Menu.buildFromTemplate(
      labels.map((label, i) => ({
        // A single & would be read as a mnemonic marker on Windows.
        label: String(label).replace(/&/g, '&&'),
        click: () => {
          picked = i;
        },
      }))
    );
    // The close callback can run before the clicked item's handler.
    menu.popup({ window: win, callback: () => setTimeout(() => resolve(picked), 0) });
  });
});

appIpc.handle('md:render-text', async (event, text, baseDir, requestId) => {
  try {
    return { ok: true, html: await renderMarkdownText(text, baseDir, requestId) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

appIpc.handle('puml:render-text', async (event, text, requestId) => {
  try {
    return { ok: true, html: await renderPlantUmlText(text, requestId) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// Lets the renderer abort whatever java process(es) are still running for a
// render request once the user has navigated away from it (see
// activeRenderAborts above) — otherwise a huge diagram nobody's looking at
// anymore would keep burning CPU until it finishes on its own.
appIpc.handle('render:cancel', (event, requestId) => {
  const controllers = activeRenderAborts.get(requestId);
  if (controllers) {
    for (const controller of controllers) controller.abort();
  }
  return { ok: true };
});

appIpc.handle('json:render-text', (event, text) => {
  try {
    return { ok: true, html: renderJsonText(text) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

appIpc.handle('plaintext:render-text', (event, text, filePath) => {
  try {
    return { ok: true, html: renderPlainText(text, filePath) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

appIpc.handle('fs:load-project-css', (event, rootPath) => {
  try {
    return { ok: true, css: loadProjectCss(rootPath) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

appIpc.handle('fs:save-project-css', (event, rootPath, css) => {
  try {
    saveProjectCss(rootPath, css);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

appIpc.handle('fs:find-project-root', (event, filePath) => findProjectRootForFile(filePath));

appIpc.handle('fs:load-project-state', (event, rootPath) => {
  try {
    return { ok: true, state: loadProjectState(rootPath) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

appIpc.handle('fs:save-project-state', (event, rootPath, projectState) => {
  try {
    saveProjectState(rootPath, projectState);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

appIpc.handle('fs:get-base-styles', () => getBaseStyles());

// One watched file per tab (the document it shows).
appIpc.handle('fs:watch-file', (event, filePath) => {
  const tab = senderTab(event);
  const key = tab ? tabWatchKey(tab) : event.sender.id;
  const frame = event.senderFrame;
  stopWatching(key);
  try {
    const watcher = fs.watch(filePath, { persistent: false }, (eventType) => {
      sendToFrame(frame, 'file-changed', filePath);
    });
    fileWatchers.set(key, watcher);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

appIpc.handle('shell:open-external', async (event, url) => {
  try {
    await shell.openExternal(url);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

appIpc.handle('shell:open-path', async (event, folderPath) => {
  const errorMessage = await shell.openPath(folderPath);
  return errorMessage ? { ok: false, error: errorMessage } : { ok: true };
});

appIpc.handle('shell:show-in-folder', (event, itemPath) => {
  shell.showItemInFolder(itemPath);
});

// Real OS fullscreen for the renderer's fullscreen document view. The menu
// bar goes with it: on Windows it would otherwise keep sitting above a view
// whose whole point is that nothing surrounds the document. Its
// accelerators (F11 included) keep working while it is hidden.
appIpc.handle('window:set-fullscreen', (event, enabled) => {
  const win = windowFor(event.sender);
  if (!win) return { ok: false, error: 'no window' };
  const host = hostOf(win);
  win.setFullScreen(!!enabled);
  // A tab window never shows it.
  win.setMenuBarVisibility(!enabled && !(host && host.aux));
  // The window page hides everything around the tab for the duration.
  if (host && !host.owner.isDestroyed()) {
    host.owner.webContents.send('shell:doc-fullscreen', { container: host.key, enabled: !!enabled });
  }
  return { ok: true };
});

// An item's path relative to the open project, with forward slashes so it
// drops straight into a markdown link and matches how the breadcrumb and
// search results already render paths. Falls back to the absolute path
// when there is no project root, or the item sits outside it (another
// drive, say), where a relative path would be useless or misleading.
function projectRelativePath(itemPath, rootPath) {
  if (!rootPath) return itemPath;
  // Right-clicking empty tree space targets the root itself, whose
  // relative path is the empty string — its name is the useful answer.
  if (path.resolve(itemPath) === path.resolve(rootPath)) return path.basename(rootPath);
  const rel = path.relative(rootPath, itemPath);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return itemPath;
  return rel.replace(/\\/g, '/');
}

appIpc.handle('tree:show-context-menu', (event, itemPath, rootPath, options = {}) => {
  const win = windowFor(event.sender);
  const isDir = fs.statSync(itemPath).isDirectory();
  // New File/Folder/Refresh act on whatever was right-clicked: inside it for
  // a folder (or empty tree space, whose itemPath is the project root), or
  // relative to its parent for a file — matching common editor convention.
  const targetDir = isDir ? itemPath : path.dirname(itemPath);

  const items = [
    {
      label: t('context.newFile'),
      click: () => win.webContents.send('tree:create-new', { targetDir, kind: 'file' }),
    },
    {
      label: t('context.newFolder'),
      click: () => win.webContents.send('tree:create-new', { targetDir, kind: 'folder' }),
    },
    { type: 'separator' },
  ];
  // A project root's name is the project itself (recent list, saved
  // state), so it isn't renamed from here.
  if (!(options && options.isProjectRoot)) {
    items.push(
      {
        label: t('context.rename'),
        // Shown only; the tree's own keydown handler does the work, so F2
        // acts on the tree's selection rather than on the whole window.
        accelerator: 'F2',
        registerAccelerator: false,
        click: () => win.webContents.send('tree:rename', { itemPath }),
      },
      { type: 'separator' }
    );
  }
  items.push(
    {
      label: t('context.refresh'),
      click: () => win.webContents.send('tree:refresh-dir', { targetDir }),
    },
    {
      label: t('context.openInExplorer'),
      click: () => shell.showItemInFolder(itemPath),
    },
    {
      label: t('context.openInTerminal'),
      click: () => win.webContents.send('terminal:open-in', { dir: targetDir }),
    },
    { type: 'separator' },
    {
      label: t('context.copyAbsolutePath'),
      click: () => clipboard.writeText(itemPath),
    },
    {
      label: t('context.copyRelativePath'),
      click: () => clipboard.writeText(projectRelativePath(itemPath, rootPath)),
    }
  );
  if (!isDir && /\.(md|markdown)$/i.test(itemPath)) {
    items.push({ type: 'separator' });
    items.push({
      label: t('context.exportPdf'),
      click: () => exportMarkdownToPdf(itemPath, win, rootPath),
    });
    items.push({
      label: t('context.exportHtml'),
      click: () => exportMarkdownToHtml(itemPath, win, rootPath),
    });
    items.push({
      label: t('context.copyAsHtml'),
      click: () => copyMarkdownAsHtml(itemPath, win, rootPath),
    });
  }
  if (!isDir && /\.puml$/i.test(itemPath)) {
    items.push({ type: 'separator' });
    items.push({
      label: t('context.convertSvg'),
      click: () => convertPumlToSvg(itemPath, win),
    });
  }
  // A project's own row in the explorer, where several projects can be
  // open side by side.
  if (options && options.isProjectRoot) {
    items.push({ type: 'separator' });
    items.push({
      label: t('context.openInNewWindow'),
      click: () => openTargetInWindow(createWindow(), { type: 'folder', path: itemPath }),
    });
    items.push({
      label: t('context.closeProject'),
      click: () => win.webContents.send('tree:close-project', { rootPath: itemPath }),
    });
  }
  const menu = Menu.buildFromTemplate(items);
  menu.popup({ window: win });
});

// Right-click on empty explorer space, below every project: the menu for
// the explorer as a whole rather than for any one folder in it.
appIpc.handle('tree:show-empty-context-menu', (event, { hasProjects }) => {
  const win = windowFor(event.sender);
  const menu = Menu.buildFromTemplate([
    {
      label: t('context.newProject'),
      click: () => createNewProject(win),
    },
    {
      label: t('context.openProject'),
      click: () => win.webContents.send('menu:open-folder'),
    },
    { type: 'separator' },
    {
      label: t('context.closeAllProjects'),
      enabled: !!hasProjects,
      click: () => win.webContents.send('tree:close-all-projects'),
    },
  ]);
  menu.popup({ window: win });
});

// New Project: the user names a folder that doesn't exist yet, and it is
// created with its .mdviewer folder already in place — which is what makes
// it an mdviewer project (see findProjectRootForFile) even while empty —
// then opened in the explorer like any other folder.
async function createNewProject(win) {
  const result = await dialog.showSaveDialog(win, {
    title: t('project.newDialogTitle'),
    buttonLabel: t('project.newDialogButton'),
    defaultPath: t('project.newDefaultName'),
  });
  if (result.canceled || !result.filePath) return;
  const rootPath = result.filePath;
  if (fs.existsSync(rootPath)) {
    dialog.showErrorBox(
      t('project.newFailedTitle'),
      t('project.newAlreadyExists', { name: path.basename(rootPath) })
    );
    return;
  }
  try {
    fs.mkdirSync(path.join(rootPath, CONFIG_DIR_NAME), { recursive: true });
  } catch (err) {
    dialog.showErrorBox(t('project.newFailedTitle'), t('project.newFailedMessage', { error: err.message }));
    return;
  }
  if (!win.isDestroyed()) win.webContents.send('folder:open-path', rootPath);
}

// Backs both the tree's "Export to PDF..." context menu item and the new
// File > Export to PDF... menu item (which targets whatever's currently
// open in the renderer, so it needs its own IPC entry point rather than
// reusing the context-menu one above).
// Writes the diagram out as a standalone .svg beside its source, using the
// same bundled plantuml.jar the preview renders with — no plantuml.com round
// trip, so it works offline and isn't bounded by that server's request-size
// limit.
//
// No save dialog and no "overwrite?" prompt: the answer is always the same
// file name in the same folder, and the .svg is a derived artifact of the
// .puml sitting next to it, so re-converting after an edit should just
// replace it. Since nothing pops up to confirm it either, the window is told
// to refresh that folder in the tree (so the new file appears where the user
// is already looking) and to show what was written in the toolbar status.
async function convertPumlToSvg(filePath, parentWindow) {
  const outPath = path.join(
    path.dirname(filePath),
    `${path.basename(filePath, path.extname(filePath))}.svg`
  );
  try {
    const svg = await renderPlantUmlSvg(fs.readFileSync(filePath, 'utf-8'));
    fs.writeFileSync(outPath, svg, 'utf-8');
    if (parentWindow && !parentWindow.isDestroyed()) {
      parentWindow.webContents.send('tree:refresh-dir', { targetDir: path.dirname(filePath) });
      parentWindow.webContents.send('puml:svg-converted', { outPath });
    }
  } catch (err) {
    dialog.showErrorBox(
      t('export.svgFailedTitle'),
      t('export.svgFailedMessage', { name: path.basename(filePath), error: err.message })
    );
  }
}

appIpc.handle('export:pdf', (event, filePath, rootPath) => {
  const win = windowFor(event.sender);
  return exportMarkdownToPdf(filePath, win, rootPath);
});

// Renders the file the same way the preview does, then prints that HTML to
// PDF from an offscreen window rather than the app's own window — the app
// window shows the whole UI chrome (sidebar, toolbar...), not just the
// document, and printToPDF prints whatever a webContents currently shows.
// Forces light colors for the duration of the export via nativeTheme (a
// dark-background PDF is rarely what anyone wants out of "export to PDF")
// — this is process-wide, so it very briefly affects the main window's own
// colors too, but the export completes in well under a second for a
// typical document, same as e.g. a quick native print-preview flash.
// A rendered document as a page of its own, styled the way the project's
// preview shows it. extraCss goes last so it can override everything else.
function buildStandaloneHtml(html, rootPath, extraCss = '') {
  const { defaultCss, hljsCss } = getBaseStyles();
  // Match whatever the project's own preview currently shows: only pull
  // in custom.css if the user has it toggled on (same default as the
  // renderer's own cssEnabled flag — on unless explicitly turned off).
  let userCss = '';
  if (rootPath) {
    const projectState = loadProjectState(rootPath);
    const cssEnabled = projectState.cssEnabled !== undefined ? projectState.cssEnabled : true;
    if (cssEnabled) userCss = loadProjectCss(rootPath);
  }
  return (
    '<!DOCTYPE html><html><head><meta charset="utf-8">' +
    `<style>${defaultCss}</style><style>${hljsCss}</style><style>${userCss}</style>` +
    `<style>${extraCss}</style>` +
    '</head><body class="markdown-body">' + html + '</body></html>'
  );
}

async function exportMarkdownToPdf(filePath, parentWindow, rootPath) {
  const defaultName = `${path.basename(filePath, path.extname(filePath))}.pdf`;
  const saveResult = await dialog.showSaveDialog(parentWindow, {
    defaultPath: path.join(path.dirname(filePath), defaultName),
    filters: [{ name: 'PDF', extensions: ['pdf'] }],
  });
  if (saveResult.canceled || !saveResult.filePath) return;

  let exportWin;
  const previousThemeSource = nativeTheme.themeSource;
  try {
    // Switched before rendering, not just before printing: the PDF is always
    // light, so anything rendered into it should be rendered for a light page.
    nativeTheme.themeSource = 'light';
    const fullHtml = buildStandaloneHtml(await renderMarkdownFile(filePath), rootPath);

    exportWin = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
    await exportWin.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(fullHtml)}`);
    const pdfData = await exportWin.webContents.printToPDF({
      printBackground: true,
      pageSize: 'A4',
      margins: { marginType: 'none' },
    });
    fs.writeFileSync(saveResult.filePath, pdfData);
    shell.showItemInFolder(saveResult.filePath);
  } catch (err) {
    dialog.showErrorBox(
      t('export.pdfFailedTitle'),
      t('export.pdfFailedMessage', { name: path.basename(filePath), error: err.message })
    );
  } finally {
    nativeTheme.themeSource = previousThemeSource;
    if (exportWin) exportWin.destroy();
  }
}

const IMAGE_MIME_BY_EXT = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml',
};

// Whatever the HTML is pasted into can't reach files on this disk (a mail
// client, a web editor), so local images travel inside the HTML itself.
async function inlineLocalImages(html) {
  const pattern = /(<img\b[^>]*?\ssrc=")(file:\/\/[^"]+)(")/gi;
  const sources = [...new Set([...html.matchAll(pattern)].map((m) => m[2]))];
  const dataUrls = new Map();
  await Promise.all(
    sources.map(async (src) => {
      try {
        const filePath = filePathFromUrl(src.replace(/&amp;/g, '&')).replace(/%23/g, '#');
        const mime = IMAGE_MIME_BY_EXT[path.extname(filePath).toLowerCase()];
        if (!mime) return;
        const bytes = await fs.promises.readFile(filePath);
        dataUrls.set(src, `data:${mime};base64,${bytes.toString('base64')}`);
      } catch {
        // A missing image stays a broken link, as it is in the preview.
      }
    })
  );
  return html.replace(pattern, (all, before, src, after) =>
    dataUrls.has(src) ? before + dataUrls.get(src) + after : all
  );
}

// Runs inside the hidden copy window. Paste targets (Word, Outlook, web
// editors) drop or ignore <style> sheets, so every rule that matters is
// written onto the elements themselves; SVG images, which most of them
// can't show, are rasterised to PNG. Returns the finished HTML fragment.
async function htmlForClipboardInPage() {
  const INHERITED = [
    'color', 'font-family', 'font-size', 'font-weight', 'font-style',
    'line-height', 'text-align', 'white-space', 'list-style-type', 'border-collapse',
  ];
  const OWN = [
    'background-color', 'text-decoration-line', 'vertical-align',
    'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
    'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
    'border-radius',
  ];
  const SIDES = ['top', 'right', 'bottom', 'left'];

  const images = [...document.images];
  await Promise.all(images.map((img) => img.decode().catch(() => {})));
  for (const img of images) {
    const width = img.width;
    const height = img.height;
    if (!width || !height) continue;
    if (/^data:image\/svg\+xml/i.test(img.src)) {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(width * 2);
        canvas.height = Math.round(height * 2);
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        img.src = canvas.toDataURL('image/png');
      } catch {
        // Left as SVG: still fine wherever SVG is supported.
      }
    }
    // The rendered size, so the paste target doesn't fall back to the
    // image's natural (often much larger, or 2x rasterised) size.
    img.setAttribute('width', String(Math.round(width)));
    img.setAttribute('height', String(Math.round(height)));
  }

  // What an element looks like with no stylesheet at all, per tag: only
  // values that differ from it are worth writing down.
  const blank = document.createElement('iframe');
  document.body.appendChild(blank);
  const blankDoc = blank.contentDocument;
  const defaults = new Map();
  const defaultsFor = (tag) => {
    if (!defaults.has(tag)) {
      const probe = blankDoc.createElement(tag);
      blankDoc.body.appendChild(probe);
      const cs = blankDoc.defaultView.getComputedStyle(probe);
      defaults.set(tag, Object.fromEntries(OWN.map((p) => [p, cs.getPropertyValue(p)])));
      probe.remove();
    }
    return defaults.get(tag);
  };

  const root = document.body;
  const styles = new Map();
  for (const node of root.querySelectorAll('*')) {
    if (node.closest('iframe, style, script')) continue;
    const cs = getComputedStyle(node);
    const parentCs = getComputedStyle(node.parentElement);
    const own = defaultsFor(node.tagName.toLowerCase());
    const decls = [];
    for (const p of INHERITED) {
      const v = cs.getPropertyValue(p);
      if (v !== parentCs.getPropertyValue(p)) decls.push(`${p}: ${v}`);
    }
    // A centred block image's auto margins come back as this layout's pixel
    // widths, which would push it off-centre anywhere narrower or wider.
    const centred =
      node.tagName === 'IMG' && cs.display === 'block' &&
      parseFloat(cs.marginLeft) > 0 && cs.marginLeft === cs.marginRight;
    if (centred) decls.push('display: block', 'margin-left: auto', 'margin-right: auto');
    for (const p of OWN) {
      if (centred && (p === 'margin-left' || p === 'margin-right')) continue;
      const v = cs.getPropertyValue(p);
      if (v !== own[p]) decls.push(`${p}: ${v}`);
    }
    // Only the sides that actually draw a line: an unset border's colour
    // is still reported (as the text colour) and would be pure noise.
    for (const side of SIDES) {
      const style = cs.getPropertyValue(`border-${side}-style`);
      const width = cs.getPropertyValue(`border-${side}-width`);
      if (style === 'none' || style === 'hidden' || parseFloat(width) === 0) continue;
      decls.push(`border-${side}: ${width} ${style} ${cs.getPropertyValue(`border-${side}-color`)}`);
    }
    styles.set(node, decls.join('; '));
  }
  blank.remove();

  const bodyCs = getComputedStyle(root);
  const rootDecls = INHERITED.map((p) => `${p}: ${bodyCs.getPropertyValue(p)}`).join('; ');
  for (const [node, decls] of styles) {
    if (decls) node.setAttribute('style', decls);
    // Preview-only hooks (classes, data-source-line, ...) mean nothing
    // where this is pasted.
    for (const attr of [...node.attributes]) {
      if (attr.name === 'class' || attr.name.startsWith('data-')) node.removeAttribute(attr.name);
    }
  }
  return `<div style="${rootDecls.replace(/"/g, "'")}">${root.innerHTML}</div>`;
}

const HTML_FRAGMENT_WIDTH = 680;

// The document as one self-styled HTML fragment: every rule written onto
// the elements, images embedded, diagrams as PNG. Clipboard copy and HTML
// export both use it, so what is pasted and what is saved look the same.
// Always light-themed, like the PDF.
async function renderStandaloneFragment(raw, filePath, rootPath) {
  let renderWin;
  const previousThemeSource = nativeTheme.themeSource;
  try {
    nativeTheme.themeSource = 'light';
    const html = await inlineLocalImages(await renderMarkdownText(raw, path.dirname(filePath)));
    // Laid out at roughly a printed page's text width rather than the
    // preview's, so images keep a size that fits where they are pasted.
    const fullHtml = buildStandaloneHtml(
      html,
      rootPath,
      'body.markdown-body { max-width: none; margin: 0; padding: 0; overflow: hidden; }'
    );
    renderWin = new BrowserWindow({
      show: false,
      width: HTML_FRAGMENT_WIDTH,
      height: 800,
      useContentSize: true,
      webPreferences: { sandbox: true },
    });
    await renderWin.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(fullHtml)}`);
    return await renderWin.webContents.executeJavaScript(`(${htmlForClipboardInPage.toString()})()`);
  } finally {
    nativeTheme.themeSource = previousThemeSource;
    if (renderWin) renderWin.destroy();
  }
}

// Puts the document on the clipboard as formatted HTML (with its markdown
// source as the plain-text alternative), for pasting into a mail, a Word
// document or a wiki editor.
async function copyMarkdownAsHtml(filePath, parentWindow, rootPath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const fragment = await renderStandaloneFragment(raw, filePath, rootPath);
    clipboard.write({ html: fragment, text: raw });
    if (parentWindow && !parentWindow.isDestroyed()) {
      parentWindow.webContents.send('viewer:html-copied', { name: path.basename(filePath) });
    }
  } catch (err) {
    dialog.showErrorBox(
      t('export.htmlCopyFailedTitle'),
      t('export.htmlCopyFailedMessage', { name: path.basename(filePath), error: err.message })
    );
  }
}

// Saves the document as one self-contained .html page holding the same
// fragment the clipboard copy produces, on a plain white page of the same
// width, so the file still shows correctly after it is moved or sent.
async function exportMarkdownToHtml(filePath, parentWindow, rootPath) {
  const defaultName = `${path.basename(filePath, path.extname(filePath))}.html`;
  const saveResult = await dialog.showSaveDialog(parentWindow, {
    defaultPath: path.join(path.dirname(filePath), defaultName),
    filters: [{ name: 'HTML', extensions: ['html', 'htm'] }],
  });
  if (saveResult.canceled || !saveResult.filePath) return;

  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const fragment = await renderStandaloneFragment(raw, filePath, rootPath);
    const title = escapeHtmlText(path.basename(filePath, path.extname(filePath)));
    const fullHtml =
      '<!DOCTYPE html><html><head><meta charset="utf-8">' +
      '<meta name="viewport" content="width=device-width, initial-scale=1">' +
      `<title>${title}</title></head>` +
      '<body style="margin: 0; background: #ffffff; color-scheme: light">' +
      `<div style="box-sizing: content-box; max-width: ${HTML_FRAGMENT_WIDTH}px; margin: 0 auto; padding: 32px 24px 80px">` +
      fragment +
      '</div></body></html>';
    fs.writeFileSync(saveResult.filePath, fullHtml, 'utf-8');
    if (parentWindow && !parentWindow.isDestroyed()) {
      parentWindow.webContents.send('tree:refresh-dir', { targetDir: path.dirname(saveResult.filePath) });
    }
    shell.showItemInFolder(saveResult.filePath);
  } catch (err) {
    dialog.showErrorBox(
      t('export.htmlFailedTitle'),
      t('export.htmlFailedMessage', { name: path.basename(filePath), error: err.message })
    );
  }
}

// Light-mode counterpart to highlight.js's own github-dark.css (used below
// as the unconditional/dark default), matching the exact same class
// groupings so every token category dark defines also gets a light value —
// no gaps for a dark color to leak through unstyled. Values are the exact
// "prettylights" hex colors from VS Code's own bundled Default Light 2026
// theme (extensions/theme-defaults/themes/2026-light.json), not an
// approximation — cross-checked token-by-token against 2026-dark.json,
// where github-dark.css's shipped colors already matched exactly.
//
// .hljs-params/.hljs-tag/.hljs-link/etc. are deliberately left unstyled
// here too (matching github-dark.css and the real theme's
// variable.parameter.function, which is styled as plain text, not a
// special color) — they fall through to .markdown-body pre code's
// color: inherit, i.e. the same color as normal prose text.
const HLJS_LIGHT_OVERRIDE_CSS = `
@media (prefers-color-scheme: light) {
  .hljs-doctag,
  .hljs-keyword,
  .hljs-meta .hljs-keyword,
  .hljs-template-tag,
  .hljs-template-variable,
  .hljs-type,
  .hljs-variable.language_ {
    color: #cf222e;
  }
  .hljs-title,
  .hljs-title.class_,
  .hljs-title.class_.inherited__,
  .hljs-title.function_ {
    color: #8250df;
  }
  .hljs-attr,
  .hljs-attribute,
  .hljs-literal,
  .hljs-meta,
  .hljs-number,
  .hljs-operator,
  .hljs-variable,
  .hljs-selector-attr,
  .hljs-selector-class,
  .hljs-selector-id {
    color: #0550ae;
  }
  .hljs-regexp,
  .hljs-string,
  .hljs-meta .hljs-string {
    color: #0a3069;
  }
  .hljs-built_in,
  .hljs-symbol {
    color: #953800;
  }
  .hljs-comment,
  .hljs-code,
  .hljs-formula {
    color: #6e7781;
  }
  .hljs-name,
  .hljs-quote,
  .hljs-selector-tag,
  .hljs-selector-pseudo {
    color: #116329;
  }
  .hljs-subst {
    color: #1f2328;
  }
  .hljs-section {
    color: #0550ae;
    font-weight: bold;
  }
  .hljs-emphasis {
    color: #1f2328;
    font-style: italic;
  }
  .hljs-strong {
    color: #1f2328;
    font-weight: bold;
  }
}
`;

// Shared between the preview iframe's 'fs:get-base-styles' handler and PDF
// export above, so exported PDFs and the in-app preview stay visually
// consistent.
function getBaseStyles() {
  const defaultCss = fs.readFileSync(path.join(__dirname, 'assets', 'preview-base.css'), 'utf-8');
  const hljsDarkCss = fs.readFileSync(require.resolve('highlight.js/styles/github-dark.css'), 'utf-8');
  const hljsCss = hljsDarkCss + HLJS_LIGHT_OVERRIDE_CSS;
  return { defaultCss, hljsCss };
}

appIpc.handle('i18n:get', () => {
  return { language: currentLanguage, strings: STRINGS[currentLanguage] };
});

appIpc.handle('settings:set-language', (event, lang) => {
  setLanguage(lang);
  return { ok: true, language: currentLanguage };
});

appIpc.handle('settings:get-auto-save', () => getAutoSave());
appIpc.handle('settings:get-preview-width-limit', () => getPreviewWidthLimit());
appIpc.handle('settings:get-editor-layout', () => getEditorLayout());
appIpc.handle('settings:set-editor-layout', (event, layout) => setEditorLayout(layout));
appIpc.handle('settings:get-scroll-sync', () => getScrollSync());
appIpc.handle('settings:set-scroll-sync', (event, enabled) => setScrollSync(enabled));

// Synchronous on purpose: the renderer saves from 'beforeunload', where an
// async write would be cut off by the page going away.
appIpc.on('fs:write-file-sync', (event, filePath, content, expectedVersion) => {
  try {
    event.returnValue = writeIfUnchanged(fs, filePath, content, expectedVersion);
  } catch (err) {
    event.returnValue = { ok: false, error: err.message };
  }
});

appIpc.handle('settings:get-custom-extensions', () => {
  return { ok: true, extensions: getCustomTextExtensions() };
});

appIpc.handle('settings:set-custom-extensions', (event, list) => {
  const extensions = setCustomTextExtensions(list);
  sendToAllTabs('settings:custom-extensions-changed', extensions);
  return { ok: true, extensions };
});

appIpc.handle('settings:get-hidden-names', () => {
  return { ok: true, names: getHiddenNames(), defaults: [...DEFAULT_HIDDEN_NAMES] };
});

appIpc.handle('settings:set-hidden-names', (event, list) => {
  return { ok: true, names: setHiddenNames(list) };
});

appIpc.handle('recent:list', () => {
  return loadRecentProjects().map((p) => ({
    path: p,
    name: path.basename(p),
    exists: fs.existsSync(p),
  }));
});

appIpc.handle('project:set-open', (event, roots, active) => {
  windowProjects.set(event.sender.id, {
    roots: Array.isArray(roots) ? roots : [],
    active: active || null,
  });
  // The window's tabs judge which project their documents belong to by
  // these (see doc:context in doc.js).
  const owner = windowFor(event.sender);
  for (const host of hostsOwnedBy(owner)) sendToHostTabs(host, 'doc:context', tabContextFor(host));
  activateForStartupAndProjects();
  return { ok: true };
});

appIpc.handle('recent:add', (event, rootPath) => {
  addRecentProject(rootPath);
  buildAppMenu();
});

appIpc.handle('recent:remove', (event, rootPath) => {
  removeRecentProject(rootPath);
  buildAppMenu();
});

appIpc.handle('term:start', (event, key, cwd, cols, rows) => {
  try {
    spawnTerminalFor(event, key || '', cwd || app.getPath('home'), cols, rows);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

appIpc.handle('term:input', (event, key, data) => {
  const t = getTerminal(event.sender.id, key || '');
  if (!t) return { ok: false, error: translate(currentLanguage, 'term.noRunningTerminal') };
  try {
    t.write(data);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

appIpc.handle('term:resize', (event, key, cols, rows) => {
  const t = getTerminal(event.sender.id, key || '');
  if (t) {
    try {
      t.resize(cols, rows);
    } catch (err) {
      /* ignore resize races with process exit */
    }
  }
  return { ok: true };
});

appIpc.handle('term:stop', (event, key) => {
  killTerminal(event.sender.id, key || '');
  return { ok: true };
});

// Right-click on a terminal tab. The window page owns the tabs, so the
// choice goes back to it (terminal:tab-action) to carry out.
appIpc.handle('term:show-tab-context-menu', (event, key, { hasOthers } = {}) => {
  const sender = event.sender;
  const action = (name) => () => {
    if (!sender.isDestroyed()) sender.send('terminal:tab-action', { key, action: name });
  };
  const menu = Menu.buildFromTemplate([
    { label: t('terminal.duplicateTab'), click: action('duplicate') },
    { label: t('terminal.restartTab'), click: action('restart') },
    { type: 'separator' },
    { label: t('terminal.closeTab'), click: action('close') },
    { label: t('terminal.closeOtherTabs'), enabled: !!hasOthers, click: action('close-others') },
  ]);
  menu.popup({ window: windowFor(sender) });
  return { ok: true };
});

// The viewer's own context menu: copy the selected text, or copy a diagram
// as an image. Only the items that apply to what was right-clicked are
// built, and each one hands the work back to the tab's page, which is where
// the selection and the diagram's <img> actually are.
appIpc.handle('viewer:show-context-menu', (event, payload) => {
  const win = windowFor(event.sender);
  if (!win) return { ok: false };
  const page = event.senderFrame;
  const items = [];
  if (payload && payload.hasSelection) {
    items.push({
      label: t('context.copy'),
      click: () => sendToFrame(page, 'viewer:copy-selection'),
    });
  }
  if (payload && payload.hasImage) {
    items.push({
      label: t('context.copyImage'),
      click: () => sendToFrame(page, 'viewer:copy-image'),
    });
  }
  if (payload && payload.hasSelection) {
    items.push({ type: 'separator' }, ...sendToTerminalItems(page, 'viewer', payload.hasLocation));
  } else if (payload) {
    if (items.length) items.push({ type: 'separator' });
    items.push(...viewerDocumentItems(win, page, payload));
  }
  if (items.length === 0) return { ok: false };
  Menu.buildFromTemplate(items).popup({ window: win });
  return { ok: true };
});

// The viewer's menu when nothing is selected: the document's history, its
// file and folder, and the view. Items the renderer has to carry out go
// back to it as 'viewer:context-action' with the action's name.
function viewerDocumentItems(win, page, payload) {
  const action = (name) => () => sendToFrame(page, 'viewer:context-action', { action: name });
  const { filePath, rootPath } = payload;
  const items = [
    { label: t('context.back'), enabled: !!payload.canGoBack, click: action('back') },
    { label: t('context.forward'), enabled: !!payload.canGoForward, click: action('forward') },
    { type: 'separator' },
    { label: t('context.selectAll'), click: action('selectAll') },
    { type: 'separator' },
    { label: t('context.openInTerminal'), click: action('openInTerminal') },
  ];
  if (filePath) {
    items.push(
      { label: t('context.openInExplorer'), click: () => shell.showItemInFolder(filePath) },
      { type: 'separator' },
      { label: t('context.copyAbsolutePath'), click: () => clipboard.writeText(filePath) },
      {
        label: t('context.copyRelativePath'),
        enabled: !!rootPath,
        click: () => clipboard.writeText(projectRelativePath(filePath, rootPath)),
      },
      { type: 'separator' },
      {
        label: t('context.editMode'),
        type: 'checkbox',
        checked: !!payload.editMode,
        click: action('toggleEditMode'),
      },
      { label: t('context.refresh'), click: action('refresh') }
    );
    if (payload.isMarkdown) {
      items.push({
        label: t('context.exportPdf'),
        click: () => exportMarkdownToPdf(filePath, win, rootPath || path.dirname(filePath)),
      });
    }
  }
  items.push(
    { type: 'separator' },
    {
      label: t('menu.fullscreenDocument'),
      type: 'checkbox',
      checked: !!payload.docFullscreen,
      click: action('toggleFullscreen'),
    }
  );
  return items;
}

// "Send to terminal" types a reference to the selection (@path#Lstart-end)
// into the terminal panel's shell, without Enter, so a prompt can follow
// it — the form Claude Code reads as a file mention. The renderer works out
// the reference; source tells it which pane's selection to use.
function sendToTerminalItems(page, source, hasLocation) {
  const send = (withText) => sendToFrame(page, 'selection:send-to-terminal', { source, withText });
  const items = [];
  if (hasLocation) {
    items.push({ label: t('context.sendLocationToTerminal'), click: () => send(false) });
  }
  items.push({
    label: t(hasLocation ? 'context.sendLocationAndTextToTerminal' : 'context.sendTextToTerminal'),
    click: () => send(true),
  });
  return items;
}

// The split-view source editor's menu. A textarea gets no menu of its own
// in Electron, so cut/copy/paste come along with the terminal items.
appIpc.handle('editor:show-context-menu', (event, payload) => {
  const win = windowFor(event.sender);
  if (!win) return { ok: false };
  const hasSelection = !!(payload && payload.hasSelection);
  const items = [
    { label: t('context.cut'), role: 'cut', enabled: hasSelection },
    { label: t('context.copy'), role: 'copy', enabled: hasSelection },
    { label: t('context.paste'), role: 'paste' },
  ];
  if (hasSelection) {
    items.push({ type: 'separator' }, ...sendToTerminalItems(event.senderFrame, 'editor', payload.hasLocation));
  }
  Menu.buildFromTemplate(items).popup({ window: win });
  return { ok: true };
});

// Diagrams are SVG, which nativeImage cannot read — the renderer rasterises
// them to a PNG data URL first (see copyImageAsBitmap in renderer.js).
appIpc.handle('clipboard:write-image', (event, pngDataUrl) => {
  try {
    const image = nativeImage.createFromDataURL(pngDataUrl);
    if (image.isEmpty()) return { ok: false, error: 'image could not be read' };
    clipboard.writeImage(image);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

function filePathFromUrl(fileUrl) {
  const withoutScheme = fileUrl.replace(/^file:\/\//, '');
  const decoded = decodeURI(withoutScheme);
  // A Windows path comes back as /D:/docs/a.png; a UNC one as //host/share.
  return /^\/[a-zA-Z]:/.test(decoded) ? decoded.slice(1) : decoded;
}

async function readImageSource(src) {
  if (src.startsWith('file://')) {
    const filePath = filePathFromUrl(src);
    return { bytes: await fs.promises.readFile(filePath), name: path.basename(filePath) };
  }
  if (/^https?:\/\//i.test(src)) {
    const response = await net.fetch(src);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return { bytes: Buffer.from(await response.arrayBuffer()), name: src };
  }
  throw new Error('unsupported image source');
}

// Copies an image the document pulled in from somewhere else — a file on
// disk, or an http(s) URL. It is read here rather than in the renderer
// because a canvas that has drawn a file:// or cross-origin image cannot be
// read back (it is tainted), and because a photo or screenshot should land
// on the clipboard as its own pixels rather than being re-encoded.
//
// An SVG is the exception: nothing can put one on the clipboard usefully, so
// it goes back to the renderer as a data URL to be rasterised like a diagram.
appIpc.handle('image:copy-source', async (event, src) => {
  try {
    const { bytes, name } = await readImageSource(src);
    const looksLikeSvg = /\.svg($|[?#])/i.test(name) || /^\s*(<\?xml|<svg)/i.test(bytes.slice(0, 200).toString('utf-8'));
    if (looksLikeSvg) {
      return { ok: true, svgDataUrl: `data:image/svg+xml;base64,${bytes.toString('base64')}` };
    }
    const image = nativeImage.createFromBuffer(bytes);
    if (image.isEmpty()) return { ok: false, error: 'unsupported image format' };
    clipboard.writeImage(image);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

appIpc.handle('clipboard:write-text', (event, text) => {
  clipboard.writeText(text || '');
});

appIpc.handle('clipboard:read-text', () => {
  return clipboard.readText();
});

// Saves whatever image is currently on the clipboard next to the given
// markdown/text file, under a ".resources" subfolder, and returns the
// relative path to use in a markdown image link. Used by the source
// editor's paste handler (see the 'paste' listener on #md-source-editor in
// renderer.js) so pasting a screenshot/copied image inserts a working link
// instead of dumping raw image data into the text.
appIpc.handle('fs:save-pasted-image', (event, targetFilePath) => {
  try {
    const image = clipboard.readImage();
    if (image.isEmpty()) return { ok: false, error: 'Clipboard has no image' };

    const resourcesDir = path.join(path.dirname(targetFilePath), '.resources');
    fs.mkdirSync(resourcesDir, { recursive: true });

    let filename = `pasted-image-${Date.now()}.png`;
    let fullPath = path.join(resourcesDir, filename);
    let n = 2;
    while (fs.existsSync(fullPath)) {
      filename = `pasted-image-${Date.now()}-${n++}.png`;
      fullPath = path.join(resourcesDir, filename);
    }

    fs.writeFileSync(fullPath, image.toPNG());
    return { ok: true, relPath: `.resources/${filename}` };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});
