const { app, BrowserWindow, ipcMain, dialog, shell, Menu, clipboard } = require('electron');
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

function setLanguage(lang) {
  if (!SUPPORTED_LANGUAGES.includes(lang) || lang === currentLanguage) return;
  currentLanguage = lang;
  saveSettings({ ...loadSettings(), language: lang });
  buildAppMenu();
  if (mainWindow) mainWindow.reload();
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
  const savedLanguage = loadSettings().language;
  if (SUPPORTED_LANGUAGES.includes(savedLanguage)) currentLanguage = savedLanguage;

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

ipcMain.handle('fs:get-base-styles', () => {
  const defaultCss = fs.readFileSync(
    path.join(__dirname, 'assets', 'preview-base.css'),
    'utf-8'
  );
  const hljsCss = fs.readFileSync(
    require.resolve('highlight.js/styles/vs2015.css'),
    'utf-8'
  );
  return { defaultCss, hljsCss };
});

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

ipcMain.handle('tree:show-context-menu', (event, itemPath) => {
  const menu = Menu.buildFromTemplate([
    {
      label: t('context.openInExplorer'),
      click: () => shell.showItemInFolder(itemPath),
    },
  ]);
  menu.popup({ window: BrowserWindow.fromWebContents(event.sender) });
});

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
