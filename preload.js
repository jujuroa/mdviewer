const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('mdviewer', {
  openFolderDialog: () => ipcRenderer.invoke('dialog:open-folder'),
  openFileDialog: () => ipcRenderer.invoke('dialog:open-file'),
  listDir: (dirPath) => ipcRenderer.invoke('fs:list-dir', dirPath),
  renderMarkdown: (filePath) => ipcRenderer.invoke('fs:render-markdown', filePath),
  renderPlantUmlFile: (filePath) => ipcRenderer.invoke('fs:render-plantuml', filePath),
  renderPlantUmlText: (text) => ipcRenderer.invoke('puml:render-text', text),
  loadProjectCss: (rootPath) => ipcRenderer.invoke('fs:load-project-css', rootPath),
  saveProjectCss: (rootPath, css) => ipcRenderer.invoke('fs:save-project-css', rootPath, css),
  getBaseStyles: () => ipcRenderer.invoke('fs:get-base-styles'),
  watchFile: (filePath) => ipcRenderer.invoke('fs:watch-file', filePath),
  openExternal: (url) => ipcRenderer.invoke('shell:open-external', url),
  readFile: (filePath) => ipcRenderer.invoke('fs:read-file', filePath),
  writeFile: (filePath, content) => ipcRenderer.invoke('fs:write-file', filePath, content),
  renderMarkdownText: (text, baseDir) => ipcRenderer.invoke('md:render-text', text, baseDir),
  showTreeContextMenu: (itemPath) => ipcRenderer.invoke('tree:show-context-menu', itemPath),
  showInFolder: (itemPath) => ipcRenderer.invoke('shell:show-in-folder', itemPath),
  openPath: (folderPath) => ipcRenderer.invoke('shell:open-path', folderPath),
  loadProjectState: (rootPath) => ipcRenderer.invoke('fs:load-project-state', rootPath),
  saveProjectState: (rootPath, projectState) =>
    ipcRenderer.invoke('fs:save-project-state', rootPath, projectState),

  listRecentProjects: () => ipcRenderer.invoke('recent:list'),
  addRecentProject: (rootPath) => ipcRenderer.invoke('recent:add', rootPath),
  removeRecentProject: (rootPath) => ipcRenderer.invoke('recent:remove', rootPath),

  getI18n: () => ipcRenderer.invoke('i18n:get'),
  setLanguage: (lang) => ipcRenderer.invoke('settings:set-language', lang),

  startTerminal: (cwd, cols, rows) => ipcRenderer.invoke('term:start', cwd, cols, rows),
  sendTerminalInput: (data) => ipcRenderer.invoke('term:input', data),
  resizeTerminal: (cols, rows) => ipcRenderer.invoke('term:resize', cols, rows),
  stopTerminal: () => ipcRenderer.invoke('term:stop'),

  clipboardWriteText: (text) => ipcRenderer.invoke('clipboard:write-text', text),
  clipboardReadText: () => ipcRenderer.invoke('clipboard:read-text'),

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
  onMenuToggleCssEditor: (callback) => ipcRenderer.on('menu:toggle-css-editor', callback),
  onMenuToggleEditMode: (callback) => ipcRenderer.on('menu:toggle-edit-mode', callback),
  onMenuSaveFile: (callback) => ipcRenderer.on('menu:save-file', callback),
  onMenuToggleTerminal: (callback) => ipcRenderer.on('menu:toggle-terminal', callback),

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
