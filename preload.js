const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('mdviewer', {
  openFolderDialog: () => ipcRenderer.invoke('dialog:open-folder'),
  openFileDialog: () => ipcRenderer.invoke('dialog:open-file'),
  listDir: (dirPath) => ipcRenderer.invoke('fs:list-dir', dirPath),
  renderMarkdown: (filePath, requestId) => ipcRenderer.invoke('fs:render-markdown', filePath, requestId),
  renderPlantUmlFile: (filePath, requestId) => ipcRenderer.invoke('fs:render-plantuml', filePath, requestId),
  renderPlantUmlText: (text, requestId) => ipcRenderer.invoke('puml:render-text', text, requestId),
  cancelRender: (requestId) => ipcRenderer.invoke('render:cancel', requestId),
  renderJsonFile: (filePath) => ipcRenderer.invoke('fs:render-json', filePath),
  renderJsonText: (text) => ipcRenderer.invoke('json:render-text', text),
  renderPlainTextFile: (filePath) => ipcRenderer.invoke('fs:render-plaintext', filePath),
  renderPlainTextText: (text) => ipcRenderer.invoke('plaintext:render-text', text),
  searchProject: (rootPath, query, options) => ipcRenderer.invoke('search:project', rootPath, query, options),
  cancelSearch: (searchId) => ipcRenderer.invoke('search:cancel', searchId),
  loadProjectCss: (rootPath) => ipcRenderer.invoke('fs:load-project-css', rootPath),
  saveProjectCss: (rootPath, css) => ipcRenderer.invoke('fs:save-project-css', rootPath, css),
  getBaseStyles: () => ipcRenderer.invoke('fs:get-base-styles'),
  watchFile: (filePath) => ipcRenderer.invoke('fs:watch-file', filePath),
  openExternal: (url) => ipcRenderer.invoke('shell:open-external', url),
  readFile: (filePath) => ipcRenderer.invoke('fs:read-file', filePath),
  writeFile: (filePath, content) => ipcRenderer.invoke('fs:write-file', filePath, content),
  createFile: (dirPath, name) => ipcRenderer.invoke('fs:create-file', dirPath, name),
  copyEntries: (targetDir, sourcePaths) => ipcRenderer.invoke('fs:copy-entries', targetDir, sourcePaths),
  statPath: (targetPath) => ipcRenderer.invoke('fs:stat-path', targetPath),
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
  showTreeContextMenu: (itemPath, rootPath) => ipcRenderer.invoke('tree:show-context-menu', itemPath, rootPath),
  showInFolder: (itemPath) => ipcRenderer.invoke('shell:show-in-folder', itemPath),
  openPath: (folderPath) => ipcRenderer.invoke('shell:open-path', folderPath),
  setWindowFullscreen: (enabled) => ipcRenderer.invoke('window:set-fullscreen', enabled),
  exportPdf: (filePath, rootPath) => ipcRenderer.invoke('export:pdf', filePath, rootPath),
  loadProjectState: (rootPath) => ipcRenderer.invoke('fs:load-project-state', rootPath),
  saveProjectState: (rootPath, projectState) =>
    ipcRenderer.invoke('fs:save-project-state', rootPath, projectState),

  listRecentProjects: () => ipcRenderer.invoke('recent:list'),
  addRecentProject: (rootPath) => ipcRenderer.invoke('recent:add', rootPath),
  setActiveProject: (rootPath) => ipcRenderer.invoke('project:set-active', rootPath),
  removeRecentProject: (rootPath) => ipcRenderer.invoke('recent:remove', rootPath),

  getI18n: () => ipcRenderer.invoke('i18n:get'),
  setLanguage: (lang) => ipcRenderer.invoke('settings:set-language', lang),
  getCustomExtensions: () => ipcRenderer.invoke('settings:get-custom-extensions'),
  setCustomExtensions: (list) => ipcRenderer.invoke('settings:set-custom-extensions', list),

  startTerminal: (cwd, cols, rows) => ipcRenderer.invoke('term:start', cwd, cols, rows),
  sendTerminalInput: (data) => ipcRenderer.invoke('term:input', data),
  resizeTerminal: (cols, rows) => ipcRenderer.invoke('term:resize', cols, rows),
  stopTerminal: () => ipcRenderer.invoke('term:stop'),

  clipboardWriteText: (text) => ipcRenderer.invoke('clipboard:write-text', text),
  clipboardWriteImage: (pngDataUrl) => ipcRenderer.invoke('clipboard:write-image', pngDataUrl),
  showViewerContextMenu: (payload) => ipcRenderer.invoke('viewer:show-context-menu', payload),
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
  onPumlSvgConverted: (callback) => {
    const listener = (event, payload) => callback(payload);
    ipcRenderer.on('puml:svg-converted', listener);
    return () => ipcRenderer.removeListener('puml:svg-converted', listener);
  },
  onMenuToggleCssEditor: (callback) => ipcRenderer.on('menu:toggle-css-editor', callback),
  onMenuManageCustomExtensions: (callback) => ipcRenderer.on('menu:manage-custom-extensions', callback),
  onMenuToggleEditMode: (callback) => ipcRenderer.on('menu:toggle-edit-mode', callback),
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

  onTerminalData: (callback) => {
    const listener = (event, data) => callback(data);
    ipcRenderer.on('term:data', listener);
    return () => ipcRenderer.removeListener('term:data', listener);
  },
  onTerminalExit: (callback) => {
    const listener = (event, code) => callback(code);
    ipcRenderer.on('term:exit', listener);
    return () => ipcRenderer.removeListener('term:exit', listener);
  },
});
