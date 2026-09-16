const { app, BrowserWindow, ipcMain, dialog, shell, Menu, clipboard, nativeTheme } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const pty = require('node-pty');
const MarkdownIt = require('markdown-it');
const taskLists = require('markdown-it-task-lists');
const hljs = require('highlight.js');
const sanitizeHtml = require('sanitize-html');
const { DEFAULT_LANGUAGE, SUPPORTED_LANGUAGES, STRINGS, translate } = require('./assets/i18n.js');

const CONFIG_DIR_NAME = '.mdviewer';
const CSS_FILE_NAME = 'custom.css';
const MAX_RECENT_PROJECTS = 8;
const PLANTUML_FENCE_LANGS = new Set(['plantuml', 'puml']);
const MERMAID_FENCE_LANGS = new Set(['mermaid']);
const MERMAID_SERVER = 'https://mermaid.ink';

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

// Runs java as an async child process rather than spawnSync: large/complex
// diagrams can take java a few seconds (JVM startup + layout), and
// spawnSync blocks the ENTIRE main process's event loop for that whole
// time — freezing every window, menu, and IPC call in the app, not just the
// diagram being rendered. spawn() lets the main process keep servicing
// everything else while java runs in its own OS process.
function renderPlantUmlSvg(source, signal) {
  const { jar, java } = plantumlRuntimePaths();
  if (!fs.existsSync(jar) || !fs.existsSync(java)) {
    return Promise.reject(new Error(
      'PlantUML runtime not found. Run "npm run prepare:plantuml" (or npm start / npm run dist, which do this automatically).'
    ));
  }
  const trimmed = source.trim();
  const body = /@start\w+/i.test(trimmed) ? trimmed : `@startuml\n${trimmed}\n@enduml`;

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

async function plantumlImageSrc(source, signal) {
  const svg = await renderPlantUmlSvg(source, signal);
  return `data:image/svg+xml;base64,${Buffer.from(svg, 'utf-8').toString('base64')}`;
}

// Wraps the rendered diagram with a zoom control bar and a separate scroll
// area, so the controls stay fixed in a corner while the (potentially huge)
// diagram scrolls underneath. Zoom/pan interactivity itself is wired up from
// the renderer (see initPreviewFrame in src/renderer.js) since the preview
// iframe is sandboxed without allow-scripts.
function plantumlDiagramHtml(imgSrc) {
  return (
    '<div class="plantuml-diagram" data-zoom="100">' +
      '<div class="plantuml-zoom-controls">' +
        '<button type="button" class="puml-zoom-out" title="Zoom out">−</button>' +
        '<span class="puml-zoom-level">100%</span>' +
        '<button type="button" class="puml-zoom-in" title="Zoom in">+</button>' +
        '<button type="button" class="puml-zoom-reset" title="Reset zoom">⟳</button>' +
      '</div>' +
      `<div class="plantuml-scroll"><img src="${imgSrc}" alt="PlantUML diagram"></div>` +
    '</div>'
  );
}

function mermaidImageSrc(source) {
  const encoded = Buffer.from(source.trim(), 'utf-8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  return `${MERMAID_SERVER}/svg/${encoded}`;
}

let mainWindow;

// The project folder the renderer currently has open. A settings change
// that has to reload the window (see setLanguage) uses this to put the
// user back where they were instead of dropping them on the welcome
// screen; the per-project .mdviewer/state.json takes it from there and
// restores the open file, scroll offset and panel layout.
let activeProjectRoot = null;
const fileWatchers = new Map(); // webContents.id -> fs.FSWatcher
const terminals = new Map(); // webContents.id -> { proc: ChildProcess }

// When launched by double-clicking a .md file (file association), via
// `mdviewer.exe file.md`, or via `mdviewer .` from a shell (PATH-installed),
// Windows/argv passes the path as a plain argument. Packaged apps also get
// electron's own args prepended, so only argv beyond index 1 (dev) / index 0
// (packaged) are candidates.
function extractOpenTargetFromArgv(argv, cwd) {
  const args = app.isPackaged ? argv.slice(1) : argv.slice(2);
  const candidate = args.find((a) => !a.startsWith('-'));
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

function openTargetInWindow(target) {
  if (!mainWindow) return;
  const channel = target.type === 'folder' ? 'folder:open-path' : 'file:open-path';
  const send = () => mainWindow.webContents.send(channel, target.path);
  if (mainWindow.webContents.isLoadingMainFrame()) {
    mainWindow.webContents.once('did-finish-load', send);
  } else {
    send();
  }
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

const BUILTIN_KIND_EXTENSIONS = new Set(['md', 'markdown', 'puml', 'json', 'txt', 'log']);

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

function plainTextExtensionPattern() {
  const all = ['txt', 'log', ...getCustomTextExtensions()];
  return new RegExp('\\.(' + all.join('|') + ')$', 'i');
}

function reloadWindowRestoringProject() {
  if (!mainWindow) return;
  // Registered before reload() so the listener is in place by the time
  // the fresh page finishes loading. The renderer's 'folder:open-path'
  // handler is the same one the OS/CLI "open this folder" path uses.
  if (activeProjectRoot) {
    const root = activeProjectRoot;
    mainWindow.webContents.once('did-finish-load', () => {
      mainWindow.webContents.send('folder:open-path', root);
    });
  }
  mainWindow.reload();
}

function setLanguage(lang) {
  if (!SUPPORTED_LANGUAGES.includes(lang) || lang === currentLanguage) return;
  currentLanguage = lang;
  saveSettings({ ...loadSettings(), language: lang });
  buildAppMenu();
  // The renderer applies its string table once at startup, so a reload is
  // still the way to re-translate everything already on screen.
  reloadWindowRestoringProject();
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
function resolveInternalLinkPath(baseDir, relPath) {
  const absPath = path.resolve(baseDir, relPath);
  if (relPath.endsWith('/') || path.extname(relPath)) return absPath;
  const withMdExt = absPath + '.md';
  return fs.existsSync(withMdExt) ? withMdExt : absPath;
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
  }).use(taskLists, { enabled: true, label: true });

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
      const src = mermaidImageSrc(token.content);
      return `<div class="mermaid-diagram"><img src="${src}" alt="Mermaid diagram"></div>\n`;
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
        const [relPath, hash] = href.split('#');
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
        'id', 'class', 'style', 'title', 'data-internal-href', 'data-zoom',
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

  const pumlTokens = tokens.filter(
    (token) => token.type === 'fence' && PLANTUML_FENCE_LANGS.has(token.info.trim().split(/\s+/)[0].toLowerCase())
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

function renderPlainText(text) {
  return `<pre class="plaintext-view">${escapeHtmlText(text)}</pre>`;
}

function renderPlainTextFile(filePath) {
  const raw = fs.readFileSync(filePath, 'utf-8');
  return renderPlainText(raw);
}

function isHidden(name) {
  return name.startsWith('.');
}

function listDir(dirPath) {
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  const plainTextPattern = plainTextExtensionPattern();
  const items = entries
    .filter((e) => !isHidden(e.name))
    .map((e) => {
      const full = path.join(dirPath, e.name);
      const isDir = e.isDirectory();
      return {
        name: e.name,
        path: full,
        isDir,
        isMarkdown: !isDir && /\.(md|markdown)$/i.test(e.name),
        isPuml: !isDir && /\.puml$/i.test(e.name),
        isJson: !isDir && /\.json$/i.test(e.name),
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
      if (isHidden(entry.name)) continue;
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

function saveProjectState(rootPath, projectState) {
  const dir = path.join(rootPath, CONFIG_DIR_NAME);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(projectStatePath(rootPath), JSON.stringify(projectState, null, 2), 'utf-8');
}

const MAX_RECENT_MENU_ITEMS = 5;

function buildAppMenu() {
  const recentItems = loadRecentProjects().slice(0, MAX_RECENT_MENU_ITEMS);
  const recentSubmenu =
    recentItems.length > 0
      ? recentItems.map((p) => ({
          label: p,
          click: () => mainWindow && mainWindow.webContents.send('menu:open-recent', p),
        }))
      : [{ label: t('menu.noRecentProjects'), enabled: false }];

  const menu = Menu.buildFromTemplate([
    {
      label: t('menu.file'),
      submenu: [
        {
          label: t('menu.openFolder'),
          accelerator: 'CmdOrCtrl+O',
          click: () => mainWindow.webContents.send('menu:open-folder'),
        },
        {
          label: t('menu.openFile'),
          accelerator: 'CmdOrCtrl+Shift+O',
          click: () => mainWindow.webContents.send('menu:open-file'),
        },
        { type: 'separator' },
        {
          label: t('menu.save'),
          accelerator: 'CmdOrCtrl+S',
          click: () => mainWindow.webContents.send('menu:save-file'),
        },
        { type: 'separator' },
        {
          label: t('menu.exportPdf'),
          click: () => mainWindow.webContents.send('menu:export-pdf'),
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
          click: () => mainWindow.webContents.send('menu:toggle-find'),
        },
        {
          label: t('menu.searchProject'),
          accelerator: 'CmdOrCtrl+Shift+F',
          click: () => mainWindow.webContents.send('menu:search-project'),
        },
        { type: 'separator' },
        {
          label: t('menu.toggleCssEditor'),
          accelerator: 'CmdOrCtrl+E',
          click: () => mainWindow.webContents.send('menu:toggle-css-editor'),
        },
        {
          label: t('menu.toggleEditMode'),
          accelerator: 'CmdOrCtrl+Shift+E',
          click: () => mainWindow.webContents.send('menu:toggle-edit-mode'),
        },
        {
          label: t('menu.toggleTerminal'),
          accelerator: 'CmdOrCtrl+`',
          click: () => mainWindow.webContents.send('menu:toggle-terminal'),
        },
        { type: 'separator' },
        { label: t('menu.reload'), role: 'reload' },
        { label: t('menu.toggleDevTools'), role: 'toggledevtools' },
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
        { type: 'separator' },
        {
          label: t('menu.customExtensions'),
          click: () => mainWindow.webContents.send('menu:manage-custom-extensions'),
        },
      ],
    },
    {
      label: t('menu.help'),
      submenu: [
        {
          label: t('menu.about'),
          click: () => showAboutDialog(),
        },
      ],
    },
  ]);
  Menu.setApplicationMenu(menu);
}

function showAboutDialog() {
  dialog.showMessageBox(mainWindow, {
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

function createWindow() {
  const savedSettings = loadSettings();
  if (SUPPORTED_LANGUAGES.includes(savedSettings.language)) currentLanguage = savedSettings.language;
  if (THEME_SOURCES.includes(savedSettings.themeSource)) nativeTheme.themeSource = savedSettings.themeSource;

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 840,
    backgroundColor: '#1e1e1e',
    icon: path.join(__dirname, 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'src', 'index.html'));
  buildAppMenu();

  // Mouse "back" button (Windows: XButton1) — the app has no real
  // browser-style navigation for webContents.goBack() to operate on (every
  // document switch is a same-page innerHTML swap, not a page load), so
  // intercept the OS-level command here and hand it to the renderer's own
  // navigation-history logic instead of leaving it unhandled.
  mainWindow.on('app-command', (event, cmd) => {
    if (cmd === 'browser-backward') {
      event.preventDefault();
      mainWindow.webContents.send('mdviewer:nav-back');
    }
  });

  const webContentsId = mainWindow.webContents.id;
  mainWindow.on('closed', () => {
    stopWatching(webContentsId);
    killTerminal(webContentsId);
    mainWindow = null;
  });
}

function stopWatching(webContentsId) {
  const watcher = fileWatchers.get(webContentsId);
  if (watcher) {
    watcher.close();
    fileWatchers.delete(webContentsId);
  }
}

// ---- Bottom terminal panel: real PTY-backed shell per window ----
// Uses node-pty (ConPTY on Windows / a real pty on macOS/Linux) so the
// embedded terminal behaves like a normal shell: colors, cursor movement,
// Tab completion, Ctrl+C, and interactive/curses programs all work.

function killTerminal(webContentsId) {
  const t = terminals.get(webContentsId);
  if (t) {
    try {
      t.kill();
    } catch (err) {
      /* already dead */
    }
    terminals.delete(webContentsId);
  }
}

function spawnTerminalFor(event, cwd, cols, rows) {
  const webContentsId = event.sender.id;
  killTerminal(webContentsId);

  const isWin = process.platform === 'win32';
  const shellExe = isWin ? 'powershell.exe' : process.env.SHELL || '/bin/bash';
  // Windows PowerShell's default console output encoding is the legacy
  // OEM/ANSI codepage, not UTF-8, which garbles non-ASCII (e.g. Korean)
  // output/filenames even under ConPTY. Force UTF-8 before dropping into
  // the interactive session.
  const shellArgs = isWin
    ? [
        '-NoLogo',
        '-NoExit',
        '-Command',
        '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; chcp 65001 | Out-Null',
      ]
    : [];

  const ptyProcess = pty.spawn(shellExe, shellArgs, {
    name: 'xterm-color',
    cols: cols || 80,
    rows: rows || 24,
    cwd,
    env: process.env,
  });
  terminals.set(webContentsId, ptyProcess);

  const sender = event.sender;
  ptyProcess.onData((data) => {
    if (!sender.isDestroyed()) sender.send('term:data', data);
  });
  ptyProcess.onExit(({ exitCode }) => {
    if (!sender.isDestroyed()) sender.send('term:exit', exitCode);
    terminals.delete(webContentsId);
  });
}

// Only one instance may hold the file association: a second double-click
// on a .md file should hand its path to the already-running window instead
// of spawning a competing process.
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', (event, argv, workingDirectory) => {
    const target = extractOpenTargetFromArgv(argv, workingDirectory);
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
    if (target) openTargetInWindow(target);
  });

  app.whenReady().then(() => {
    createWindow();
    const target = extractOpenTargetFromArgv(process.argv);
    if (target) openTargetInWindow(target);

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}

// ---- IPC handlers ----

ipcMain.handle('dialog:open-folder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});

ipcMain.handle('dialog:open-file', async () => {
  const customExtensions = getCustomTextExtensions();
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    filters: [
      {
        name: 'Supported Files',
        extensions: ['md', 'markdown', 'puml', 'json', 'txt', 'log', ...customExtensions],
      },
      { name: 'Markdown', extensions: ['md', 'markdown'] },
      { name: 'PlantUML', extensions: ['puml'] },
      { name: 'JSON', extensions: ['json'] },
      { name: 'Text', extensions: ['txt', 'log', ...customExtensions] },
    ],
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});

ipcMain.handle('fs:list-dir', (event, dirPath) => {
  try {
    return { ok: true, items: listDir(dirPath) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('search:project', async (event, rootPath, query, options) => {
  try {
    return await searchProjectDocuments(rootPath, query, options || {});
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('search:cancel', (event, searchId) => {
  if (searchId) {
    // A cancel that lands after its search already finished leaves the id
    // behind (nothing is left to delete it); keep the set from growing
    // without bound, since only one search is ever in flight.
    if (canceledSearches.size > 64) canceledSearches.clear();
    canceledSearches.add(searchId);
  }
  return { ok: true };
});

ipcMain.handle('fs:render-markdown', async (event, filePath, requestId) => {
  try {
    const html = await renderMarkdownFile(filePath, requestId);
    return { ok: true, html, name: path.basename(filePath) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('fs:render-plantuml', async (event, filePath, requestId) => {
  try {
    const html = await renderPlantUmlFile(filePath, requestId);
    return { ok: true, html, name: path.basename(filePath) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('fs:render-json', (event, filePath) => {
  try {
    const html = renderJsonFile(filePath);
    return { ok: true, html, name: path.basename(filePath) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('fs:render-plaintext', (event, filePath) => {
  try {
    const html = renderPlainTextFile(filePath);
    return { ok: true, html, name: path.basename(filePath) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('fs:read-file', (event, filePath) => {
  try {
    return { ok: true, content: fs.readFileSync(filePath, 'utf-8') };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('fs:write-file', (event, filePath, content) => {
  try {
    fs.writeFileSync(filePath, content, 'utf-8');
    return { ok: true };
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

ipcMain.handle('fs:create-file', (event, dirPath, name) => createTreeEntry(dirPath, name, 'file'));
ipcMain.handle('fs:create-folder', (event, dirPath, name) => createTreeEntry(dirPath, name, 'folder'));

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

ipcMain.handle('fs:copy-entries', async (event, targetDir, sourcePaths) => {
  try {
    return await copyEntriesInto(targetDir, Array.isArray(sourcePaths) ? sourcePaths : []);
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('fs:stat-path', async (event, targetPath) => {
  try {
    const stat = await fs.promises.stat(targetPath);
    return { ok: true, isDir: stat.isDirectory(), isFile: stat.isFile() };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('md:render-text', async (event, text, baseDir, requestId) => {
  try {
    return { ok: true, html: await renderMarkdownText(text, baseDir, requestId) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('puml:render-text', async (event, text, requestId) => {
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
ipcMain.handle('render:cancel', (event, requestId) => {
  const controllers = activeRenderAborts.get(requestId);
  if (controllers) {
    for (const controller of controllers) controller.abort();
  }
  return { ok: true };
});

ipcMain.handle('json:render-text', (event, text) => {
  try {
    return { ok: true, html: renderJsonText(text) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('plaintext:render-text', (event, text) => {
  try {
    return { ok: true, html: renderPlainText(text) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('fs:load-project-css', (event, rootPath) => {
  try {
    return { ok: true, css: loadProjectCss(rootPath) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('fs:save-project-css', (event, rootPath, css) => {
  try {
    saveProjectCss(rootPath, css);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('fs:load-project-state', (event, rootPath) => {
  try {
    return { ok: true, state: loadProjectState(rootPath) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('fs:save-project-state', (event, rootPath, projectState) => {
  try {
    saveProjectState(rootPath, projectState);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('fs:get-base-styles', () => getBaseStyles());

ipcMain.handle('fs:watch-file', (event, filePath) => {
  const wcId = event.sender.id;
  stopWatching(wcId);
  try {
    const watcher = fs.watch(filePath, { persistent: false }, (eventType) => {
      if (!event.sender.isDestroyed()) {
        event.sender.send('file-changed', filePath);
      }
    });
    fileWatchers.set(wcId, watcher);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('shell:open-external', async (event, url) => {
  try {
    await shell.openExternal(url);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('shell:open-path', async (event, folderPath) => {
  const errorMessage = await shell.openPath(folderPath);
  return errorMessage ? { ok: false, error: errorMessage } : { ok: true };
});

ipcMain.handle('shell:show-in-folder', (event, itemPath) => {
  shell.showItemInFolder(itemPath);
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

ipcMain.handle('tree:show-context-menu', (event, itemPath, rootPath) => {
  const win = BrowserWindow.fromWebContents(event.sender);
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
    {
      label: t('context.refresh'),
      click: () => win.webContents.send('tree:refresh-dir', { targetDir }),
    },
    {
      label: t('context.openInExplorer'),
      click: () => shell.showItemInFolder(itemPath),
    },
    { type: 'separator' },
    {
      label: t('context.copyAbsolutePath'),
      click: () => clipboard.writeText(itemPath),
    },
    {
      label: t('context.copyRelativePath'),
      click: () => clipboard.writeText(projectRelativePath(itemPath, rootPath)),
    },
  ];
  if (!isDir && /\.(md|markdown)$/i.test(itemPath)) {
    items.push({ type: 'separator' });
    items.push({
      label: t('context.exportPdf'),
      click: () => exportMarkdownToPdf(itemPath, win, rootPath),
    });
  }
  const menu = Menu.buildFromTemplate(items);
  menu.popup({ window: win });
});

// Backs both the tree's "Export to PDF..." context menu item and the new
// File > Export to PDF... menu item (which targets whatever's currently
// open in the renderer, so it needs its own IPC entry point rather than
// reusing the context-menu one above).
ipcMain.handle('export:pdf', (event, filePath, rootPath) => {
  const win = BrowserWindow.fromWebContents(event.sender);
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
    const html = await renderMarkdownFile(filePath);
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
    const fullHtml =
      '<!DOCTYPE html><html><head><meta charset="utf-8">' +
      `<style>${defaultCss}</style><style>${hljsCss}</style><style>${userCss}</style>` +
      '</head><body class="markdown-body">' + html + '</body></html>';

    nativeTheme.themeSource = 'light';
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

ipcMain.handle('i18n:get', () => {
  return { language: currentLanguage, strings: STRINGS[currentLanguage] };
});

ipcMain.handle('settings:set-language', (event, lang) => {
  setLanguage(lang);
  return { ok: true, language: currentLanguage };
});

ipcMain.handle('settings:get-custom-extensions', () => {
  return { ok: true, extensions: getCustomTextExtensions() };
});

ipcMain.handle('settings:set-custom-extensions', (event, list) => {
  return { ok: true, extensions: setCustomTextExtensions(list) };
});

ipcMain.handle('recent:list', () => {
  return loadRecentProjects().map((p) => ({
    path: p,
    name: path.basename(p),
    exists: fs.existsSync(p),
  }));
});

ipcMain.handle('project:set-active', (event, rootPath) => {
  activeProjectRoot = rootPath || null;
  return { ok: true };
});

ipcMain.handle('recent:add', (event, rootPath) => {
  addRecentProject(rootPath);
  buildAppMenu();
});

ipcMain.handle('recent:remove', (event, rootPath) => {
  removeRecentProject(rootPath);
  buildAppMenu();
});

ipcMain.handle('term:start', (event, cwd, cols, rows) => {
  try {
    spawnTerminalFor(event, cwd || app.getPath('home'), cols, rows);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('term:input', (event, data) => {
  const t = terminals.get(event.sender.id);
  if (!t) return { ok: false, error: translate(currentLanguage, 'term.noRunningTerminal') };
  try {
    t.write(data);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('term:resize', (event, cols, rows) => {
  const t = terminals.get(event.sender.id);
  if (t) {
    try {
      t.resize(cols, rows);
    } catch (err) {
      /* ignore resize races with process exit */
    }
  }
  return { ok: true };
});

ipcMain.handle('term:stop', (event) => {
  killTerminal(event.sender.id);
  return { ok: true };
});

ipcMain.handle('clipboard:write-text', (event, text) => {
  clipboard.writeText(text || '');
});

ipcMain.handle('clipboard:read-text', () => {
  return clipboard.readText();
});

// Saves whatever image is currently on the clipboard next to the given
// markdown/text file, under a ".resources" subfolder, and returns the
// relative path to use in a markdown image link. Used by the source
// editor's paste handler (see the 'paste' listener on #md-source-editor in
// renderer.js) so pasting a screenshot/copied image inserts a working link
// instead of dumping raw image data into the text.
ipcMain.handle('fs:save-pasted-image', (event, targetFilePath) => {
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
