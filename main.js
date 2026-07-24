const { app, BrowserWindow, ipcMain, dialog, shell, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const pty = require('node-pty');
const MarkdownIt = require('markdown-it');
const taskLists = require('markdown-it-task-lists');
const hljs = require('highlight.js');
const sanitizeHtml = require('sanitize-html');
const { DEFAULT_LANGUAGE, SUPPORTED_LANGUAGES, STRINGS, translate } = require('./assets/i18n.js');

const CONFIG_DIR_NAME = '.mdviewer';
const CSS_FILE_NAME = 'custom.css';
const MAX_RECENT_PROJECTS = 8;

let mainWindow;
const fileWatchers = new Map(); // webContents.id -> fs.FSWatcher
const terminals = new Map(); // webContents.id -> { proc: ChildProcess }

// When launched by double-clicking a .md file (file association) or via
// `mdviewer.exe file.md`, Windows/argv passes the file path as a plain
// argument. Packaged apps also get electron's own args prepended, so only
// argv beyond index 1 (dev) / index 0 (packaged) are candidates.
function extractFilePathFromArgv(argv) {
  const args = app.isPackaged ? argv.slice(1) : argv.slice(2);
  const candidate = args.find((a) => !a.startsWith('-') && /\.(md|markdown)$/i.test(a));
  return candidate ? path.resolve(candidate) : null;
}

function openFileInWindow(filePath) {
  if (!mainWindow) return;
  const send = () => mainWindow.webContents.send('file:open-path', filePath);
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
        const absPath = relPath ? path.resolve(baseDir, relPath) : '';
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
      'img', 'h1', 'h2', 'input', 'details', 'summary', 'video', 'audio', 'source',
    ]),
    allowedAttributes: {
      ...sanitizeHtml.defaults.allowedAttributes,
      '*': ['id', 'class', 'style', 'title', 'data-internal-href'],
      a: ['href', 'name', 'target', 'rel', 'data-internal-href'],
      img: ['src', 'alt', 'title', 'width', 'height'],
      input: ['type', 'checked', 'disabled'],
      video: ['src', 'controls', 'width', 'height'],
      audio: ['src', 'controls'],
      source: ['src', 'type'],
    },
    allowedSchemes: ['http', 'https', 'mailto', 'file', 'data'],
    allowProtocolRelative: false,
    allowedSchemesByTag: { img: ['http', 'https', 'file', 'data'] },
  });
}

function renderMarkdownText(text, baseDir) {
  const md = createMarkdownRenderer(baseDir);
  return sanitizeMarkdownHtml(md.render(text));
}

function renderMarkdownFile(filePath) {
  const raw = fs.readFileSync(filePath, 'utf-8');
  return renderMarkdownText(raw, path.dirname(filePath));
}

function isHidden(name) {
  return name.startsWith('.');
}

function listDir(dirPath) {
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
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
    minWidth: 800,
    minHeight: 500,
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
  app.on('second-instance', (event, argv) => {
    const filePath = extractFilePathFromArgv(argv);
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
    if (filePath) openFileInWindow(filePath);
  });

  app.whenReady().then(() => {
    createWindow();
    const filePath = extractFilePathFromArgv(process.argv);
    if (filePath) openFileInWindow(filePath);

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
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    filters: [{ name: 'Markdown', extensions: ['md', 'markdown'] }],
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

ipcMain.handle('fs:render-markdown', (event, filePath) => {
  try {
    const html = renderMarkdownFile(filePath);
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

ipcMain.handle('md:render-text', (event, text, baseDir) => {
  try {
    return { ok: true, html: renderMarkdownText(text, baseDir) };
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

ipcMain.handle('shell:open-external', (event, url) => {
  shell.openExternal(url);
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
