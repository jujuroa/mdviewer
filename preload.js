const { contextBridge, ipcRenderer, webUtils } = require('electron');

// This runs in every frame of a program window (its tabs are iframes, see
// the tab host in main.js), but only the app's own two pages get the
// bridge: the window page and the tab page. The rendered documents inside
// a tab, and the tab windows the window page fills itself, get nothing;
// an add-on's page gets the add-on bridge below.
const PAGE = location.protocol === 'file:' ? location.pathname.split('/').pop() : '';
const TAB_ID = PAGE === 'doc.html' ? Number(new URLSearchParams(location.search).get('tab')) || 0 : 0;

// An add-on's page — in a tab (mdviewer-addon://<id>/...?tab=N), a
// document tab's pane, or a background frame's hidden window — gets a
// bridge of its own, mdviewerAddon, nothing of the app's, once main has
// made sure what the frame is (addon:hello, synchronous so the bridge is
// there before the page's scripts run).
const ADDON_SNAPSHOT_TIMEOUT_MS = 2000;
const ADDON_WILL_CLOSE_TIMEOUT_MS = 3000;
if (location.protocol === 'mdviewer-addon:') {
  const hint = Number(new URLSearchParams(location.search).get('tab')) || 0;
  const hello = ipcRenderer.sendSync('addon:hello', hint);
  if (hello && hello.ok) {
    let snapshotHandler = null;
    let willCloseHandler = null;
    // A handler gets so long, then the host goes on without it.
    const within = (handler, ms) =>
      Promise.race([Promise.resolve().then(handler), new Promise((resolve) => setTimeout(resolve, ms))]);
    // The tab host asks before the tab moves or its window reloads: the
    // page's onSnapshot handler gets ADDON_SNAPSHOT_TIMEOUT_MS to give
    // what it wants back (tabs.getRestoreState() in the new page).
    ipcRenderer.on('tab:ask', async (event, { id, kind } = {}) => {
      let value = null;
      if (kind === 'close') {
        // Closing never waits for long, nor can it be refused (protocol 7.4).
        if (willCloseHandler) await within(willCloseHandler, ADDON_WILL_CLOSE_TIMEOUT_MS).catch(() => {});
        value = true;
      } else if (kind === 'snapshot' && snapshotHandler) {
        try {
          const state = await within(snapshotHandler, ADDON_SNAPSHOT_TIMEOUT_MS);
          if (state !== undefined) value = { state };
        } catch (err) {
          value = null;
        }
      }
      try {
        ipcRenderer.send('tab:answer', id, value);
      } catch (err) {
        ipcRenderer.send('tab:answer', id, null); // not cloneable
      }
    });
    // Every method resolves to its result or rejects with the protocol's
    // error ({ code, name, message, data }, protocol 8.5).
    const call = async (method, params) => {
      const answer = await ipcRenderer.invoke('addon:call', method, params);
      if (answer && answer.ok) return answer.result;
      throw (answer && answer.error) || { code: -32603, name: 'InternalError', message: 'No answer from the host' };
    };
    // mdviewerAddon.<area>.<action>(params) for each method main lists for
    // this add-on (so new methods need no change here).
    const areas = {};
    for (const name of hello.methods || []) {
      const at = name.indexOf('/');
      const area = name.slice(0, at);
      const action = name.slice(at + 1);
      if (!areas[area]) areas[area] = {};
      areas[area][action] = (params) => call(name, params);
    }
    contextBridge.exposeInMainWorld('mdviewerAddon', {
      ...areas,
      app: { ...hello.app, ...(areas.app || {}) },
      call,
      // The page has set up what it handles (protocol 7.4).
      ready: () => ipcRenderer.send('addon:ready'),
      lifecycle: {
        onSnapshot: (handler) => {
          snapshotHandler = typeof handler === 'function' ? handler : null;
        },
        onWillClose: (handler) => {
          willCloseHandler = typeof handler === 'function' ? handler : null;
        },
      },
      tabs: {
        ...(areas.tabs || {}),
        getRestoreState: () => hello.restore,
      },
    });
  }
}

if (PAGE === 'index.html' || TAB_ID) contextBridge.exposeInMainWorld('mdviewer', {
  openFolderDialog: () => ipcRenderer.invoke('dialog:open-folder'),
  openFileDialog: () => ipcRenderer.invoke('dialog:open-file'),
  saveFileDialog: (defaultDir, defaultName) => ipcRenderer.invoke('dialog:save-file', defaultDir, defaultName),
  listDir: (dirPath) => ipcRenderer.invoke('fs:list-dir', dirPath),
  renderMarkdown: (filePath, requestId) => ipcRenderer.invoke('fs:render-markdown', filePath, requestId),
  renderPlantUmlFile: (filePath, requestId) => ipcRenderer.invoke('fs:render-plantuml', filePath, requestId),
  renderPlantUmlText: (text, requestId) => ipcRenderer.invoke('puml:render-text', text, requestId),
  cancelRender: (requestId) => ipcRenderer.invoke('render:cancel', requestId),
  renderJsonFile: (filePath) => ipcRenderer.invoke('fs:render-json', filePath),
  renderJsonText: (text) => ipcRenderer.invoke('json:render-text', text),
  renderPlainTextFile: (filePath) => ipcRenderer.invoke('fs:render-plaintext', filePath),
  renderPlainTextText: (text, filePath) => ipcRenderer.invoke('plaintext:render-text', text, filePath),
  searchProject: (rootPath, query, options) => ipcRenderer.invoke('search:project', rootPath, query, options),
  cancelSearch: (searchId) => ipcRenderer.invoke('search:cancel', searchId),
  loadProjectCss: (rootPath) => ipcRenderer.invoke('fs:load-project-css', rootPath),
  saveProjectCss: (rootPath, css) => ipcRenderer.invoke('fs:save-project-css', rootPath, css),
  getBaseStyles: () => ipcRenderer.invoke('fs:get-base-styles'),
  watchFile: (filePath) => ipcRenderer.invoke('fs:watch-file', filePath),
  openExternal: (url) => ipcRenderer.invoke('shell:open-external', url),
  readFile: (filePath) => ipcRenderer.invoke('fs:read-file', filePath),
  writeFile: (filePath, content, expectedVersion) => ipcRenderer.invoke('fs:write-file', filePath, content, expectedVersion),
  createFile: (dirPath, name) => ipcRenderer.invoke('fs:create-file', dirPath, name),
  copyEntries: (targetDir, sourcePaths) => ipcRenderer.invoke('fs:copy-entries', targetDir, sourcePaths),
  moveEntry: (sourcePath, targetDir) => ipcRenderer.invoke('fs:move-entry', sourcePath, targetDir),
  statPath: (targetPath) => ipcRenderer.invoke('fs:stat-path', targetPath),
  resolveLinkPaths: (candidates, baseDirs, rootPath) =>
    ipcRenderer.invoke('fs:resolve-link-paths', candidates, baseDirs, rootPath),
  pickPath: (labels) => ipcRenderer.invoke('menu:pick-path', labels),
  // Electron 32 dropped File.path; this is the supported way to turn a
  // dropped/selected File back into a path on disk.
  getPathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file);
    } catch (err) {
      return '';
    }
  },
  createFolder: (dirPath, name) => ipcRenderer.invoke('fs:create-folder', dirPath, name),
  renderMarkdownText: (text, baseDir, requestId) => ipcRenderer.invoke('md:render-text', text, baseDir, requestId),
  showTreeContextMenu: (itemPath, rootPath, options) =>
    ipcRenderer.invoke('tree:show-context-menu', itemPath, rootPath, options),
  showTreeEmptyContextMenu: (options) => ipcRenderer.invoke('tree:show-empty-context-menu', options),
  showInFolder: (itemPath) => ipcRenderer.invoke('shell:show-in-folder', itemPath),
  openPath: (folderPath) => ipcRenderer.invoke('shell:open-path', folderPath),
  setWindowFullscreen: (enabled) => ipcRenderer.invoke('window:set-fullscreen', enabled),
  exportPdf: (filePath, rootPath) => ipcRenderer.invoke('export:pdf', filePath, rootPath),
  findProjectRoot: (filePath) => ipcRenderer.invoke('fs:find-project-root', filePath),
  loadProjectState: (rootPath) => ipcRenderer.invoke('fs:load-project-state', rootPath),
  saveProjectState: (rootPath, projectState) =>
    ipcRenderer.invoke('fs:save-project-state', rootPath, projectState),

  listRecentProjects: () => ipcRenderer.invoke('recent:list'),
  addRecentProject: (rootPath) => ipcRenderer.invoke('recent:add', rootPath),
  setOpenProjects: (roots, active) => ipcRenderer.invoke('project:set-open', roots, active),

  // ---- Document tabs: the window page's side (see the tab host in main.js) ----
  openTab: (filePath, options) => ipcRenderer.invoke('tabs:open', filePath, options),
  newDraftTab: (container) => ipcRenderer.invoke('tabs:new-draft', container),
  activateTab: (id) => ipcRenderer.invoke('tabs:activate', id),
  closeTab: (id) => ipcRenderer.invoke('tabs:close', id),
  moveTabHere: (id, index, container) => ipcRenderer.invoke('tabs:move-here', id, index, container),
  detachTab: (id, screenPoint) => ipcRenderer.invoke('tabs:detach', id, screenPoint),
  showNewTabMenu: (container) => ipcRenderer.invoke('tabs:show-new-menu', container),
  onTabFrameGone: (callback) => ipcRenderer.on('tabs:frame-gone', (event, payload) => callback(payload)),
  showTabContextMenu: (id) => ipcRenderer.invoke('tabs:show-context-menu', id),
  restoreTabs: (tabs, activeIndex) => ipcRenderer.invoke('tabs:restore', tabs, activeIndex),
  closeTabsUnder: (roots) => ipcRenderer.invoke('tabs:close-under', roots),
  broadcastLiveCss: (rootPath, css, enabled) => ipcRenderer.send('css:live', rootPath, css, enabled),
  focusWindowPage: () => ipcRenderer.invoke('window:focus-page'),
  onTabsChanged: (callback) => ipcRenderer.on('tabs:changed', (event, payload) => callback(payload)),
  onShellRequest: (callback) => ipcRenderer.on('shell:request', (event, payload) => callback(payload)),
  onDocFullscreen: (callback) => ipcRenderer.on('shell:doc-fullscreen', (event, payload) => callback(payload)),
  onTabsFocus: (callback) => ipcRenderer.on('tabs:focus', (event, payload) => callback(payload)),
  onOpenTabWindow: (callback) => ipcRenderer.on('shell:open-tab-window', (event, payload) => callback(payload)),
  onTabWindowClosed: (callback) => ipcRenderer.on('shell:tab-window-closed', (event, payload) => callback(payload)),

  // ---- Document tabs: the tab page's side (doc.js) ----
  // The page is ready for its document (doc:init answers).
  docReady: () => ipcRenderer.send('tab:hello', TAB_ID),
  onDocAsk: (callback) => ipcRenderer.on('tab:ask', (event, payload) => callback(payload)),
  answerDoc: (id, value) => ipcRenderer.send('tab:answer', id, value),
  confirmDiscard: () => ipcRenderer.invoke('doc:confirm-discard'),
  confirmSaveConflict: (filePath) => ipcRenderer.invoke('doc:confirm-save-conflict', filePath),
  requestWindow: (action, payload) => ipcRenderer.send('doc:shell-request', action, payload),
  reportDocState: (docState) => ipcRenderer.send('doc:state', docState),
  openDocument: (filePath, target) => ipcRenderer.invoke('doc:open', filePath, target),
  closeThisTab: () => ipcRenderer.invoke('doc:close-self'),
  getLiveCss: (rootPath) => ipcRenderer.invoke('css:get-live', rootPath),
  onDocInit: (callback) => ipcRenderer.on('doc:init', (event, init) => callback(init)),
  onDocNavigate: (callback) => ipcRenderer.on('doc:navigate', (event, payload) => callback(payload)),
  onDocContext: (callback) => ipcRenderer.on('doc:context', (event, context) => callback(context)),
  onDocActivated: (callback) => ipcRenderer.on('tab:activated', (event, active) => callback(active)),
  onDocPathMoved: (callback) => ipcRenderer.on('doc:path-moved', (event, payload) => callback(payload)),
  onLiveCss: (callback) => ipcRenderer.on('css:live', (event, payload) => callback(payload)),
  onCustomExtensionsChanged: (callback) =>
    ipcRenderer.on('settings:custom-extensions-changed', (event, extensions) => callback(extensions)),
  removeRecentProject: (rootPath) => ipcRenderer.invoke('recent:remove', rootPath),

  getI18n: () => ipcRenderer.invoke('i18n:get'),
  setLanguage: (lang) => ipcRenderer.invoke('settings:set-language', lang),
  getCustomExtensions: () => ipcRenderer.invoke('settings:get-custom-extensions'),
  getAutoSave: () => ipcRenderer.invoke('settings:get-auto-save'),
  onAutoSaveChanged: (callback) => ipcRenderer.on('settings:auto-save-changed', (event, enabled) => callback(enabled)),
  getPreviewWidthLimit: () => ipcRenderer.invoke('settings:get-preview-width-limit'),
  onPreviewWidthLimitChanged: (callback) =>
    ipcRenderer.on('settings:preview-width-limit-changed', (event, enabled) => callback(enabled)),
  getEditorLayout: () => ipcRenderer.invoke('settings:get-editor-layout'),
  setEditorLayout: (layout) => ipcRenderer.invoke('settings:set-editor-layout', layout),
  onEditorLayoutChanged: (callback) =>
    ipcRenderer.on('settings:editor-layout-changed', (event, layout) => callback(layout)),
  getScrollSync: () => ipcRenderer.invoke('settings:get-scroll-sync'),
  setScrollSync: (enabled) => ipcRenderer.invoke('settings:set-scroll-sync', enabled),
  onScrollSyncChanged: (callback) =>
    ipcRenderer.on('settings:scroll-sync-changed', (event, enabled) => callback(enabled)),
  writeFileSync: (filePath, content, expectedVersion) =>
    ipcRenderer.sendSync('fs:write-file-sync', filePath, content, expectedVersion),
  setCustomExtensions: (list) => ipcRenderer.invoke('settings:set-custom-extensions', list),
  getHiddenNames: () => ipcRenderer.invoke('settings:get-hidden-names'),
  setHiddenNames: (list) => ipcRenderer.invoke('settings:set-hidden-names', list),

  startTerminal: (key, cwd, cols, rows) => ipcRenderer.invoke('term:start', key, cwd, cols, rows),
  sendTerminalInput: (key, data) => ipcRenderer.invoke('term:input', key, data),
  resizeTerminal: (key, cols, rows) => ipcRenderer.invoke('term:resize', key, cols, rows),
  stopTerminal: (key) => ipcRenderer.invoke('term:stop', key),
  showTerminalTabContextMenu: (key, options) => ipcRenderer.invoke('term:show-tab-context-menu', key, options),

  clipboardWriteText: (text) => ipcRenderer.invoke('clipboard:write-text', text),
  clipboardWriteImage: (pngDataUrl) => ipcRenderer.invoke('clipboard:write-image', pngDataUrl),
  showViewerContextMenu: (payload) => ipcRenderer.invoke('viewer:show-context-menu', payload),
  showEditorContextMenu: (payload) => ipcRenderer.invoke('editor:show-context-menu', payload),
  copyImageSource: (src) => ipcRenderer.invoke('image:copy-source', src),
  clipboardReadText: () => ipcRenderer.invoke('clipboard:read-text'),
  savePastedImage: (targetFilePath) => ipcRenderer.invoke('fs:save-pasted-image', targetFilePath),

  onFileChanged: (callback) => {
    const listener = (event, filePath) => callback(filePath);
    ipcRenderer.on('file-changed', listener);
    return () => ipcRenderer.removeListener('file-changed', listener);
  },
  onMenuOpenFolder: (callback) => ipcRenderer.on('menu:open-folder', callback),
  onMenuOpenFile: (callback) => ipcRenderer.on('menu:open-file', callback),
  onOpenPathFromOS: (callback) => {
    const listener = (event, filePath) => callback(filePath);
    ipcRenderer.on('file:open-path', listener);
    return () => ipcRenderer.removeListener('file:open-path', listener);
  },
  onRestoreProjects: (callback) => {
    const listener = (event, payload) => callback(payload);
    ipcRenderer.on('projects:restore', listener);
    return () => ipcRenderer.removeListener('projects:restore', listener);
  },
  onOpenFolderFromOS: (callback) => {
    const listener = (event, folderPath) => callback(folderPath);
    ipcRenderer.on('folder:open-path', listener);
    return () => ipcRenderer.removeListener('folder:open-path', listener);
  },
  onMenuOpenRecent: (callback) => {
    const listener = (event, folderPath) => callback(folderPath);
    ipcRenderer.on('menu:open-recent', listener);
    return () => ipcRenderer.removeListener('menu:open-recent', listener);
  },
  onMenuToggleFind: (callback) => ipcRenderer.on('menu:toggle-find', callback),
  onMenuSearchProject: (callback) => ipcRenderer.on('menu:search-project', callback),
  onMenuExportPdf: (callback) => ipcRenderer.on('menu:export-pdf', callback),
  onTreeCreateNew: (callback) => {
    const listener = (event, payload) => callback(payload);
    ipcRenderer.on('tree:create-new', listener);
    return () => ipcRenderer.removeListener('tree:create-new', listener);
  },
  onTreeRefreshDir: (callback) => {
    const listener = (event, payload) => callback(payload);
    ipcRenderer.on('tree:refresh-dir', listener);
    return () => ipcRenderer.removeListener('tree:refresh-dir', listener);
  },
  onTreeCloseAllProjects: (callback) => ipcRenderer.on('tree:close-all-projects', callback),
  onTreeCloseProject: (callback) => {
    const listener = (event, payload) => callback(payload);
    ipcRenderer.on('tree:close-project', listener);
    return () => ipcRenderer.removeListener('tree:close-project', listener);
  },
  onPumlSvgConverted: (callback) => {
    const listener = (event, payload) => callback(payload);
    ipcRenderer.on('puml:svg-converted', listener);
    return () => ipcRenderer.removeListener('puml:svg-converted', listener);
  },
  onMenuToggleCssEditor: (callback) => ipcRenderer.on('menu:toggle-css-editor', callback),
  onMenuManageCustomExtensions: (callback) => ipcRenderer.on('menu:manage-custom-extensions', callback),
  onMenuManageAddons: (callback) => ipcRenderer.on('menu:manage-addons', callback),
  listAddons: () => ipcRenderer.invoke('addons:list'),
  setAddonEnabled: (id, enabled) => ipcRenderer.invoke('addons:set-enabled', id, enabled),
  rescanAddons: () => ipcRenderer.invoke('addons:rescan'),
  onAddonsChanged: (callback) => ipcRenderer.on('addons:changed', (event, list) => callback(list)),
  onMenuManageHiddenNames: (callback) => ipcRenderer.on('menu:manage-hidden-names', callback),
  onMenuToggleEditMode: (callback) => ipcRenderer.on('menu:toggle-edit-mode', callback),
  onMenuTogglePane: (callback) => ipcRenderer.on('menu:toggle-pane', callback),
  // The pane this document tab may show ({ url, sandbox }), or null.
  openPane: () => ipcRenderer.invoke('doc:open-pane'),
  onPaneGone: (callback) => ipcRenderer.on('doc:pane-gone', () => callback()),
  onMenuSaveFile: (callback) => ipcRenderer.on('menu:save-file', callback),
  onMenuToggleTerminal: (callback) => ipcRenderer.on('menu:toggle-terminal', callback),
  onMenuToggleDocumentFullscreen: (callback) =>
    ipcRenderer.on('menu:toggle-document-fullscreen', callback),
  onWindowFullscreenChanged: (callback) => {
    const listener = (event, isFullscreen) => callback(isFullscreen);
    ipcRenderer.on('window:fullscreen-changed', listener);
    return () => ipcRenderer.removeListener('window:fullscreen-changed', listener);
  },
  onNavBack: (callback) => ipcRenderer.on('mdviewer:nav-back', callback),
  onNavForward: (callback) => ipcRenderer.on('mdviewer:nav-forward', callback),
  onViewerCopySelection: (callback) => ipcRenderer.on('viewer:copy-selection', callback),
  onViewerCopyImage: (callback) => ipcRenderer.on('viewer:copy-image', callback),
  onViewerContextAction: (callback) => {
    const listener = (event, payload) => callback(payload);
    ipcRenderer.on('viewer:context-action', listener);
    return () => ipcRenderer.removeListener('viewer:context-action', listener);
  },
  onOpenInTerminal: (callback) => {
    const listener = (event, payload) => callback(payload);
    ipcRenderer.on('terminal:open-in', listener);
    return () => ipcRenderer.removeListener('terminal:open-in', listener);
  },
  onSendSelectionToTerminal: (callback) => {
    const listener = (event, payload) => callback(payload);
    ipcRenderer.on('selection:send-to-terminal', listener);
    return () => ipcRenderer.removeListener('selection:send-to-terminal', listener);
  },
  onViewerHtmlCopied: (callback) => {
    const listener = (event, payload) => callback(payload);
    ipcRenderer.on('viewer:html-copied', listener);
    return () => ipcRenderer.removeListener('viewer:html-copied', listener);
  },

  onTerminalData: (callback) => {
    const listener = (event, key, data) => callback(key, data);
    ipcRenderer.on('term:data', listener);
    return () => ipcRenderer.removeListener('term:data', listener);
  },
  onTerminalExit: (callback) => {
    const listener = (event, key, code) => callback(key, code);
    ipcRenderer.on('term:exit', listener);
    return () => ipcRenderer.removeListener('term:exit', listener);
  },
  onTerminalTabAction: (callback) => {
    const listener = (event, payload) => callback(payload);
    ipcRenderer.on('terminal:tab-action', listener);
    return () => ipcRenderer.removeListener('terminal:tab-action', listener);
  },
});
