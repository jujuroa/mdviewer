(() => {
  const state = {
    rootPath: null,
    currentFilePath: null,
    cssDirty: false,
    cssDebounceTimer: null,
    cssEnabled: true,
    editMode: false,
    sourceDirty: false,
    sourceDebounceTimer: null,
    suppressNextWatch: false,
    terminalOpen: false,
    terminalStarted: false,
    scrollPositions: {},
    scrollDebounceTimer: null,
  };

  const SCROLL_POSITION_MAX_AGE_MS = 24 * 60 * 60 * 1000;

  const el = {
    btnOpenFolder: document.getElementById('btn-open-folder'),
    btnOpenFile: document.getElementById('btn-open-file'),
    projectPath: document.getElementById('project-path'),
    btnOpenProjectFolder: document.getElementById('btn-open-project-folder'),
    tree: document.getElementById('tree'),
    frame: document.getElementById('preview-frame'),
    fileName: document.getElementById('current-file-name'),
    btnToggleCss: document.getElementById('btn-toggle-css'),
    cssPane: document.getElementById('css-editor-pane'),
    cssEditor: document.getElementById('css-editor'),
    btnSaveCss: document.getElementById('btn-save-css'),
    btnResetCss: document.getElementById('btn-reset-css'),
    cssStatus: document.getElementById('css-status'),
    resizerLeft: document.getElementById('resizer-left'),
    resizerRight: document.getElementById('resizer-right'),
    sidebar: document.getElementById('sidebar'),
    welcomeScreen: document.getElementById('welcome-screen'),
    recentList: document.getElementById('recent-list'),
    welcomeOpenFolder: document.getElementById('welcome-open-folder'),
    welcomeOpenFile: document.getElementById('welcome-open-file'),
    btnImportCss: document.getElementById('btn-import-css'),
    importDropdown: document.getElementById('import-css-dropdown'),
    importRecentList: document.getElementById('import-recent-list'),
    btnImportBrowse: document.getElementById('btn-import-browse'),
    cssEnabledToggle: document.getElementById('css-enabled-toggle'),
    cssAppliedBadge: document.getElementById('css-applied-badge'),
    previewBody: document.getElementById('preview-body'),
    mdSourceEditor: document.getElementById('md-source-editor'),
    editorResizer: document.getElementById('editor-resizer'),
    btnToggleEdit: document.getElementById('btn-toggle-edit'),
    btnSaveSource: document.getElementById('btn-save-source'),
    tocPanel: document.getElementById('toc-panel'),
    tocPanelHeader: document.getElementById('toc-panel-header'),
    tocCollapseBtn: document.getElementById('toc-collapse-btn'),
    tocList: document.getElementById('toc-list'),
    tocLinksList: document.getElementById('toc-links-list'),
    tocSiblingsList: document.getElementById('toc-siblings-list'),
    editStatus: document.getElementById('edit-status'),
    btnToggleTerminal: document.getElementById('btn-toggle-terminal'),
    terminalPanel: document.getElementById('terminal-panel'),
    resizerTerminal: document.getElementById('resizer-terminal'),
    terminalCwd: document.getElementById('terminal-cwd'),
    terminalXterm: document.getElementById('terminal-xterm'),
    btnTerminalClear: document.getElementById('btn-terminal-clear'),
    btnTerminalRestart: document.getElementById('btn-terminal-restart'),
    btnTerminalClose: document.getElementById('btn-terminal-close'),
  };

  // ---------------------------------------------------------------------
  // i18n
  // ---------------------------------------------------------------------

  const i18n = { language: 'ko', strings: {} };

  function t(key, vars) {
    let str = i18n.strings[key] || key;
    if (vars) {
      for (const name of Object.keys(vars)) {
        str = str.split('{' + name + '}').join(vars[name]);
      }
    }
    return str;
  }

  function applyStaticTranslations() {
    document.querySelectorAll('[data-i18n]').forEach((node) => {
      node.textContent = t(node.getAttribute('data-i18n'));
    });
    document.querySelectorAll('[data-i18n-title]').forEach((node) => {
      node.title = t(node.getAttribute('data-i18n-title'));
    });
    document.querySelectorAll('[data-i18n-placeholder]').forEach((node) => {
      node.placeholder = t(node.getAttribute('data-i18n-placeholder'));
    });
  }

  async function initI18n() {
    const result = await window.mdviewer.getI18n();
    i18n.language = result.language;
    i18n.strings = result.strings;
    document.documentElement.lang = result.language;
    applyStaticTranslations();
  }

  // ---------------------------------------------------------------------
  // Preview iframe setup
  // ---------------------------------------------------------------------

  async function initPreviewFrame() {
    const { defaultCss, hljsCss } = await window.mdviewer.getBaseStyles();
    const doc = el.frame.contentDocument;
    doc.open();
    doc.write(
      `<!DOCTYPE html><html><head><meta charset="utf-8">` +
      `<style id="base-css">${defaultCss}</style>` +
      `<style id="hljs-css">${hljsCss}</style>` +
      `<style id="user-css"></style>` +
      `</head><body class="markdown-body"><div class="mdviewer-empty-state">${escapeHtml(t('preview.emptyState'))}</div></body></html>`
    );
    doc.close();

    // Event delegation for link clicks inside the rendered document.
    doc.addEventListener('click', onPreviewClick, true);

    // Debounced scroll-position tracking, so re-opening a file later can
    // restore where the reader left off (see loadAndRenderFile).
    el.frame.contentWindow.addEventListener('scroll', () => {
      clearTimeout(state.scrollDebounceTimer);
      state.scrollDebounceTimer = setTimeout(() => {
        captureScrollPosition();
        persistProjectState();
      }, 400);
    });
  }

  function onPreviewClick(e) {
    const anchor = e.target.closest('a');
    if (!anchor) return;

    const internal = anchor.getAttribute('data-internal-href');
    if (internal) {
      e.preventDefault();
      const [absPath, hash] = internal.split('#');
      openInternalLink(absPath, hash);
      return;
    }

    const href = anchor.getAttribute('href') || '';
    if (/^https?:\/\//i.test(href)) {
      e.preventDefault();
      window.mdviewer.openExternal(href);
    } else if (href.startsWith('mailto:')) {
      e.preventDefault();
      window.mdviewer.openExternal(href);
    }
    // '#fragment' links fall through to default same-doc scrolling behavior.
  }

  // Shared handler for "internal" links (resolved by the main process to an
  // absolute path): navigates in-app for markdown targets, hands off to the
  // OS for anything else, and jumps to same-page anchors. Used both by
  // clicks inside the rendered document and by the TOC links list.
  async function openInternalLink(absPath, hash) {
    if (/\.(md|markdown)$/i.test(absPath)) {
      if (!(await guardNavigation())) return;
      await loadAndRenderFile(absPath);
      await revealPathInTree(absPath, { select: true });
      if (hash) {
        const target = el.frame.contentDocument.getElementById(hash);
        if (target) target.scrollIntoView();
      }
    } else if (absPath) {
      window.mdviewer.openExternal(pathToFileUrl(absPath));
    } else if (hash) {
      const target = el.frame.contentDocument.getElementById(hash);
      if (target) target.scrollIntoView();
    }
  }

  function pathToFileUrl(p) {
    let resolved = p.replace(/\\/g, '/');
    if (!resolved.startsWith('/')) resolved = '/' + resolved;
    return 'file://' + encodeURI(resolved).replace(/#/g, '%23');
  }

  function dirnameOf(p) {
    const idx = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
    return idx >= 0 ? p.substring(0, idx) : '';
  }

  function basenameNoExt(p) {
    const idx = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
    const base = idx >= 0 ? p.substring(idx + 1) : p;
    return base.replace(/\.(md|markdown)$/i, '');
  }

  function setUserCssLive(css) {
    const styleTag = el.frame.contentDocument.getElementById('user-css');
    if (styleTag) styleTag.textContent = css;
  }

  function updateCssAppliedBadge() {
    el.cssAppliedBadge.classList.toggle('active', state.cssEnabled);
    el.cssAppliedBadge.classList.toggle('disabled', !state.cssEnabled);
    el.cssAppliedBadge.title = state.cssEnabled ? t('toolbar.cssAppliedTitle') : t('toolbar.cssDisabledTitle');
  }

  function applyLiveCss() {
    setUserCssLive(state.cssEnabled ? el.cssEditor.value : '');
    updateCssAppliedBadge();
  }

  // ---------------------------------------------------------------------
  // Folder / file opening
  // ---------------------------------------------------------------------

  function showProjectView() {
    el.welcomeScreen.classList.add('hidden');
    el.previewBody.classList.remove('hidden');
    el.frame.classList.remove('hidden');
    el.tocPanel.classList.remove('hidden');
  }

  function showWelcomeScreen() {
    el.previewBody.classList.add('hidden');
    el.welcomeScreen.classList.remove('hidden');
    el.tocPanel.classList.add('hidden');
    populateRecentList();
  }

  async function openFolder(folderPath) {
    if (!(await guardNavigation())) return false;
    if (state.editMode) forceExitEditMode();

    const check = await window.mdviewer.listDir(folderPath);
    if (!check.ok) {
      await window.mdviewer.removeRecentProject(folderPath);
      showWelcomeScreen();
      const errRow = document.createElement('li');
      errRow.className = 'recent-empty';
      errRow.textContent = t('folder.openFailed', { error: check.error });
      el.recentList.prepend(errRow);
      return false;
    }

    state.rootPath = folderPath;
    state.currentFilePath = null;

    // Restart the shell in the newly opened project's folder so its cwd
    // stays in sync with what's shown in the tree/preview.
    if (state.terminalOpen) {
      ensureXterm();
      term.reset();
      await window.mdviewer.startTerminal(folderPath, term.cols, term.rows);
      state.terminalStarted = true;
      el.terminalCwd.textContent = folderPath;
      el.terminalCwd.title = folderPath;
    } else {
      state.terminalStarted = false;
    }

    el.projectPath.textContent = folderPath;
    el.projectPath.title = folderPath;
    el.btnOpenProjectFolder.disabled = false;
    el.fileName.textContent = t('toolbar.selectDocument');
    el.fileName.title = '';
    el.frame.contentDocument.body.innerHTML =
      `<div class="mdviewer-empty-state">${escapeHtml(t('toolbar.selectDocument'))}</div>`;
    el.tree.innerHTML = '';
    buildTreeNodes(el.tree, check.items, 0);

    const stateResult = await window.mdviewer.loadProjectState(folderPath);
    const savedState = stateResult.ok ? stateResult.state : {};

    state.cssEnabled = savedState.cssEnabled !== undefined ? savedState.cssEnabled : true;
    el.cssEnabledToggle.checked = state.cssEnabled;
    state.scrollPositions = savedState.scrollPositions || {};
    await loadProjectCss({ silent: true });

    const cssEditorOpen = !!savedState.cssEditorOpen;
    el.cssPane.classList.toggle('hidden', !cssEditorOpen);
    el.resizerRight.classList.toggle('hidden', !cssEditorOpen);

    el.tocPanel.classList.toggle('collapsed', !!savedState.tocCollapsed);

    await window.mdviewer.addRecentProject(folderPath);
    showProjectView();
    refreshToc();

    if (savedState.lastOpenFile) {
      await loadAndRenderFile(savedState.lastOpenFile);
      if (savedState.editModeOpen && state.currentFilePath) {
        await enterEditMode();
      }
    }

    return true;
  }

  async function openSingleFile(filePath) {
    const dir = filePath.substring(0, Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\')));
    const opened = await openFolder(dir);
    if (opened) await loadAndRenderFile(filePath);
  }

  async function populateRecentList() {
    const items = await window.mdviewer.listRecentProjects();
    el.recentList.innerHTML = '';
    if (items.length === 0) {
      const empty = document.createElement('li');
      empty.className = 'recent-empty';
      empty.textContent = t('recent.none');
      el.recentList.appendChild(empty);
      return;
    }
    for (const item of items) {
      const li = document.createElement('li');
      li.className = 'recent-item' + (item.exists ? '' : ' missing');
      li.title = item.exists ? item.path : item.path + t('recent.notFoundSuffix');

      const info = document.createElement('div');
      info.className = 'recent-item-info';
      const name = document.createElement('div');
      name.className = 'recent-item-name';
      name.textContent = item.name;
      const pathEl = document.createElement('div');
      pathEl.className = 'recent-item-path';
      pathEl.textContent = item.exists ? item.path : item.path + t('recent.notFoundPathSuffix');
      info.appendChild(name);
      info.appendChild(pathEl);
      li.appendChild(info);

      const removeBtn = document.createElement('button');
      removeBtn.className = 'recent-item-remove';
      removeBtn.textContent = '✕';
      removeBtn.title = t('recent.removeTitle');
      removeBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        await window.mdviewer.removeRecentProject(item.path);
        populateRecentList();
      });
      li.appendChild(removeBtn);

      li.addEventListener('click', () => openFolder(item.path));
      el.recentList.appendChild(li);
    }
  }

  async function renderTreeLevel(container, dirPath, depth, indentUnit = 16) {
    const result = await window.mdviewer.listDir(dirPath);
    if (!result.ok) {
      const errRow = document.createElement('div');
      errRow.className = 'tree-row non-md';
      errRow.textContent = t('tree.readError', { error: result.error });
      container.appendChild(errRow);
      return;
    }
    buildTreeNodes(container, result.items, depth, indentUnit);
  }

  function buildTreeNodes(container, items, depth, indentUnit = 16) {
    for (const item of items) {
      const node = document.createElement('div');
      node.className = 'tree-node';

      const row = document.createElement('div');
      row.className = 'tree-row' + (item.isDir ? ' dir' : item.isMarkdown ? ' md' : ' non-md');
      row.style.paddingLeft = 6 + depth * indentUnit + 'px';
      row.dataset.path = item.path;

      const caret = document.createElement('span');
      caret.className = 'tree-caret';
      caret.textContent = item.isDir ? '▶' : '';
      row.appendChild(caret);

      const icon = document.createElement('span');
      icon.className = 'tree-icon';
      icon.textContent = item.isDir ? '📁' : item.isMarkdown ? '📄' : '·';
      row.appendChild(icon);

      const label = document.createElement('span');
      label.className = 'tree-label';
      label.textContent = item.name;
      row.appendChild(label);

      node.appendChild(row);

      row.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        window.mdviewer.showTreeContextMenu(item.path);
      });

      if (item.isDir) {
        const childrenContainer = document.createElement('div');
        childrenContainer.className = 'tree-children';
        node.appendChild(childrenContainer);

        row.addEventListener('click', async () => {
          const expanded = childrenContainer.classList.toggle('expanded');
          caret.classList.toggle('expanded', expanded);
          if (expanded && childrenContainer.dataset.loaded !== '1') {
            childrenContainer.dataset.loaded = '1';
            await renderTreeLevel(childrenContainer, item.path, depth + 1, indentUnit);
          }
        });
      } else if (item.isMarkdown) {
        row.addEventListener('click', async () => {
          if (!(await guardNavigation())) return;
          selectTreeRow(row);
          loadAndRenderFile(item.path);
        });
      }

      container.appendChild(node);
    }
  }

  let selectedRow = null;
  function selectTreeRow(row) {
    if (selectedRow) selectedRow.classList.remove('selected');
    selectedRow = row;
    if (row) row.classList.add('selected');
  }

  function currentProjectStateSnapshot() {
    return {
      lastOpenFile: state.currentFilePath || null,
      editModeOpen: state.editMode,
      cssEnabled: state.cssEnabled,
      cssEditorOpen: !el.cssPane.classList.contains('hidden'),
      tocCollapsed: el.tocPanel.classList.contains('collapsed'),
      scrollPositions: state.scrollPositions,
    };
  }

  async function persistProjectState() {
    if (!state.rootPath) return;
    await window.mdviewer.saveProjectState(state.rootPath, currentProjectStateSnapshot());
  }

  function captureScrollPosition() {
    if (!state.currentFilePath) return;
    const win = el.frame.contentWindow;
    if (!win) return;
    state.scrollPositions[state.currentFilePath] = { top: win.scrollY, savedAt: Date.now() };
  }

  function restoreScrollPosition(filePath) {
    const saved = state.scrollPositions[filePath];
    if (saved && Date.now() - saved.savedAt <= SCROLL_POSITION_MAX_AGE_MS) {
      el.frame.contentWindow.scrollTo(0, saved.top);
    } else {
      if (saved) delete state.scrollPositions[filePath];
      el.frame.contentWindow.scrollTo(0, 0);
    }
  }

  async function loadAndRenderFile(filePath) {
    captureScrollPosition();
    const result = await window.mdviewer.renderMarkdown(filePath);
    if (!result.ok) {
      el.frame.contentDocument.body.innerHTML =
        `<div class="mdviewer-empty-state">${escapeHtml(t('file.openFailed', { error: result.error }))}</div>`;
      return;
    }
    el.frame.contentDocument.body.innerHTML = result.html;
    renderBreadcrumb(filePath);
    state.currentFilePath = filePath;
    window.mdviewer.watchFile(filePath);
    restoreScrollPosition(filePath);

    // Stay in edit mode across file switches: refresh the source editor with
    // the newly selected file's content instead of closing the edit pane.
    if (state.editMode) {
      const readResult = await window.mdviewer.readFile(filePath);
      if (readResult.ok) {
        el.mdSourceEditor.value = readResult.content;
      }
      state.sourceDirty = false;
      el.editStatus.textContent = '';
    }

    refreshToc();
    persistProjectState();
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  function pathBasename(p) {
    const trimmed = p.replace(/[\\/]+$/, '');
    const idx = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
    return idx >= 0 ? trimmed.slice(idx + 1) : trimmed;
  }

  // ---------------------------------------------------------------------
  // Breadcrumb (project-root-relative path in the toolbar)
  // ---------------------------------------------------------------------

  function renderBreadcrumb(filePath) {
    el.fileName.innerHTML = '';
    el.fileName.title = filePath;

    if (!state.rootPath) {
      el.fileName.textContent = pathBasename(filePath);
      return;
    }

    const sep = state.rootPath.includes('\\') && !state.rootPath.includes('/') ? '\\' : '/';
    const rootNorm = normalizePath(state.rootPath);
    const fileNorm = normalizePath(filePath);
    let rel = '';
    if (fileNorm === rootNorm) {
      rel = '';
    } else if (fileNorm.startsWith(rootNorm + '/')) {
      rel = filePath.slice(state.rootPath.replace(/[\\/]+$/, '').length);
    } else {
      rel = filePath;
    }
    const segments = rel.split(/[\\/]+/).filter(Boolean);

    const addSeparator = () => {
      const sepEl = document.createElement('span');
      sepEl.className = 'breadcrumb-sep';
      sepEl.textContent = '/';
      el.fileName.appendChild(sepEl);
    };

    const addSegment = (text, targetPath, clickable) => {
      const seg = document.createElement('span');
      seg.className = 'breadcrumb-segment' + (clickable ? ' breadcrumb-segment-dir' : ' breadcrumb-segment-file');
      seg.textContent = text;
      seg.title = targetPath;
      if (clickable) {
        seg.addEventListener('click', () => onBreadcrumbSegmentClick(targetPath));
      }
      el.fileName.appendChild(seg);
    };

    addSegment(pathBasename(state.rootPath) || state.rootPath, state.rootPath, true);

    let acc = state.rootPath.replace(/[\\/]+$/, '');
    for (let i = 0; i < segments.length; i++) {
      acc = acc + sep + segments[i];
      const isLast = i === segments.length - 1;
      addSeparator();
      addSegment(segments[i], acc, !isLast);
    }
  }

  // A folder's "companion" page is a markdown file that sits next to it and
  // shares its name (e.g. docs/guide.md is the landing page for docs/guide/),
  // the same convention populateSiblingPages() uses in the other direction.
  async function findCompanionMarkdownFile(folderPath) {
    const parentDir = dirnameOf(folderPath);
    const folderName = pathBasename(folderPath).toLowerCase();
    const result = await window.mdviewer.listDir(parentDir);
    if (!result.ok) return null;
    const match = result.items.find(
      (item) => !item.isDir && item.isMarkdown && basenameNoExt(item.name).toLowerCase() === folderName
    );
    return match ? match.path : null;
  }

  async function onBreadcrumbSegmentClick(folderPath) {
    if (!state.rootPath) return;

    if (normalizePath(folderPath) === normalizePath(state.rootPath)) {
      el.tree.scrollTop = 0;
      return;
    }

    const companion = await findCompanionMarkdownFile(folderPath);
    if (companion && normalizePath(companion) !== normalizePath(state.currentFilePath || '')) {
      if (!(await guardNavigation())) return;
      if (state.editMode) forceExitEditMode();
      await revealPathInTree(companion, { select: true });
      loadAndRenderFile(companion);
    } else {
      await revealPathInTree(folderPath);
    }
  }

  async function revealPathInTree(targetPath, { select = false } = {}) {
    if (!state.rootPath) return;
    const targetNorm = normalizePath(targetPath);

    if (targetNorm === normalizePath(state.rootPath)) {
      el.tree.scrollTop = 0;
      return;
    }

    let container = el.tree;
    let depth = 0;
    let matchedRow = null;

    while (container) {
      const rows = Array.from(container.querySelectorAll(':scope > .tree-node > .tree-row'));
      const ancestorRow = rows.find((r) => {
        const rPath = normalizePath(r.dataset.path);
        return rPath === targetNorm || targetNorm.startsWith(rPath + '/');
      });
      if (!ancestorRow) break;

      if (normalizePath(ancestorRow.dataset.path) === targetNorm) {
        matchedRow = ancestorRow;
        break;
      }

      const node = ancestorRow.parentElement;
      const childrenContainer = node.querySelector(':scope > .tree-children');
      if (!childrenContainer) break;
      const caret = ancestorRow.querySelector('.tree-caret');
      if (!childrenContainer.classList.contains('expanded')) {
        childrenContainer.classList.add('expanded');
        if (caret) caret.classList.add('expanded');
      }
      if (childrenContainer.dataset.loaded !== '1') {
        childrenContainer.dataset.loaded = '1';
        await renderTreeLevel(childrenContainer, ancestorRow.dataset.path, depth + 1, 16);
      }
      container = childrenContainer;
      depth += 1;
    }

    if (matchedRow) {
      matchedRow.scrollIntoView({ block: 'center' });
      flashTreeRow(matchedRow);
      if (select) selectTreeRow(matchedRow);
    }
  }

  function flashTreeRow(row) {
    row.classList.add('tree-row-flash');
    setTimeout(() => row.classList.remove('tree-row-flash'), 1200);
  }

  window.mdviewer.onFileChanged((changedPath) => {
    if (changedPath !== state.currentFilePath) return;
    if (state.suppressNextWatch) {
      state.suppressNextWatch = false;
      return;
    }
    if (state.editMode) return; // avoid clobbering in-progress edits
    loadAndRenderFile(changedPath);
  });

  // ---------------------------------------------------------------------
  // Body (source) editing
  // ---------------------------------------------------------------------

  function confirmDiscardIfDirty() {
    if (!state.editMode || !state.sourceDirty) return true;
    return window.confirm(t('confirm.discardChanges'));
  }

  function forceExitEditMode() {
    state.editMode = false;
    state.sourceDirty = false;
    setEditModeUI(false);
    el.editStatus.textContent = '';
  }

  async function guardNavigation() {
    return confirmDiscardIfDirty();
  }

  function setEditModeUI(enabled) {
    el.mdSourceEditor.classList.toggle('hidden', !enabled);
    el.editorResizer.classList.toggle('hidden', !enabled);
    el.btnToggleEdit.classList.toggle('active', enabled);
    el.btnSaveSource.classList.toggle('hidden', !enabled);
  }

  async function enterEditMode() {
    if (!state.currentFilePath) {
      el.editStatus.textContent = t('edit.selectFirst');
      return;
    }
    const result = await window.mdviewer.readFile(state.currentFilePath);
    if (!result.ok) {
      el.editStatus.textContent = t('edit.readFailed', { error: result.error });
      return;
    }
    el.mdSourceEditor.value = result.content;
    state.editMode = true;
    state.sourceDirty = false;
    setEditModeUI(true);
    el.editStatus.textContent = '';
    el.mdSourceEditor.focus();
    populateToc();
    persistProjectState();
  }

  function exitEditMode() {
    if (!confirmDiscardIfDirty()) return;
    state.editMode = false;
    state.sourceDirty = false;
    setEditModeUI(false);
    el.editStatus.textContent = '';
    if (state.currentFilePath) {
      loadAndRenderFile(state.currentFilePath);
    } else {
      persistProjectState();
    }
  }

  async function toggleEditMode() {
    if (state.editMode) {
      exitEditMode();
    } else {
      await enterEditMode();
    }
  }

  async function renderSourcePreview() {
    const baseDir = dirnameOf(state.currentFilePath);
    const result = await window.mdviewer.renderMarkdownText(el.mdSourceEditor.value, baseDir);
    if (result.ok) {
      el.frame.contentDocument.body.innerHTML = result.html;
      refreshToc();
    }
  }

  async function saveSource() {
    if (!state.currentFilePath) return;
    state.suppressNextWatch = true;
    const result = await window.mdviewer.writeFile(state.currentFilePath, el.mdSourceEditor.value);
    if (result.ok) {
      state.sourceDirty = false;
      el.editStatus.textContent = t('edit.saved');
    } else {
      state.suppressNextWatch = false;
      el.editStatus.textContent = t('edit.saveFailed', { error: result.error });
    }
  }

  el.mdSourceEditor.addEventListener('input', () => {
    clearTimeout(state.sourceDebounceTimer);
    state.sourceDebounceTimer = setTimeout(renderSourcePreview, 200);
    state.sourceDirty = true;
    el.editStatus.textContent = t('edit.unsavedChanges');
  });

  el.mdSourceEditor.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
      e.preventDefault();
      saveSource();
    }
  });

  el.btnToggleEdit.addEventListener('click', toggleEditMode);
  el.btnSaveSource.addEventListener('click', saveSource);

  window.mdviewer.onMenuToggleEditMode(toggleEditMode);
  window.mdviewer.onMenuSaveFile(() => {
    if (state.editMode) saveSource();
  });

  // ---------------------------------------------------------------------
  // Floating table of contents / sibling pages
  // ---------------------------------------------------------------------

  function slugify(text) {
    return text
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9가-힣\s-]/g, '')
      .replace(/\s+/g, '-')
      .slice(0, 60);
  }

  function findHeadingLineNumbers(sourceText) {
    const lines = sourceText.split('\n');
    const result = [];
    let inFence = false;
    lines.forEach((line, idx) => {
      if (/^\s*(```|~~~)/.test(line)) {
        inFence = !inFence;
        return;
      }
      if (!inFence && /^#{1,6}\s/.test(line)) {
        result.push(idx);
      }
    });
    return result;
  }

  function scrollSourceToLine(lineNumber) {
    const ta = el.mdSourceEditor;
    const lines = ta.value.split('\n');
    let offset = 0;
    for (let i = 0; i < lineNumber && i < lines.length; i++) {
      offset += lines[i].length + 1;
    }
    ta.focus();
    ta.setSelectionRange(offset, offset);

    const style = window.getComputedStyle(ta);
    const lineHeight = parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.4;
    ta.scrollTop = Math.max(0, lineNumber * lineHeight - ta.clientHeight / 2);
  }

  function populateToc() {
    el.tocList.innerHTML = '';
    const headings = Array.from(
      el.frame.contentDocument.querySelectorAll('h1, h2, h3, h4, h5, h6')
    );
    if (headings.length === 0) {
      const empty = document.createElement('li');
      empty.className = 'toc-empty';
      empty.textContent = t('toc.noHeadings');
      el.tocList.appendChild(empty);
      return;
    }
    const sourceLines = state.editMode ? findHeadingLineNumbers(el.mdSourceEditor.value) : null;

    const usedIds = new Set();
    headings.forEach((heading, index) => {
      if (!heading.id) {
        const base = slugify(heading.textContent) || `section-${index}`;
        let candidate = base;
        let n = 2;
        while (usedIds.has(candidate)) candidate = `${base}-${n++}`;
        heading.id = candidate;
      }
      usedIds.add(heading.id);

      const level = Number(heading.tagName[1]);
      const li = document.createElement('li');
      li.className = 'toc-item';
      li.style.paddingLeft = 6 + (level - 1) * 12 + 'px';
      li.textContent = heading.textContent;
      li.title = heading.textContent;
      li.addEventListener('click', () => {
        heading.scrollIntoView({ behavior: 'smooth', block: 'start' });
        if (sourceLines && sourceLines[index] !== undefined) {
          scrollSourceToLine(sourceLines[index]);
        }
      });
      el.tocList.appendChild(li);
    });
  }

  function tocEmpty(container, text) {
    const empty = document.createElement('div');
    empty.className = 'toc-empty';
    empty.textContent = text;
    container.appendChild(empty);
  }

  // Classifies a rendered <a> the same way onPreviewClick / openInternalLink
  // do, so the TOC links list and in-content clicks always agree on where a
  // link goes.
  function classifyAnchor(anchor) {
    const internal = anchor.getAttribute('data-internal-href');
    if (internal) {
      const [absPath, hash] = internal.split('#');
      const isMarkdown = /\.(md|markdown)$/i.test(absPath);
      return { type: isMarkdown ? 'internal-doc' : 'internal-file', absPath, hash: hash || '', key: internal };
    }
    const href = anchor.getAttribute('href') || '';
    if (/^https?:\/\//i.test(href) || href.startsWith('mailto:')) {
      return { type: 'external', href, key: href };
    }
    if (href.startsWith('#') && href.length > 1) {
      return { type: 'anchor', hash: href.slice(1), key: href };
    }
    return null;
  }

  const LINK_TYPE_ICON = {
    'internal-doc': '📄',
    'internal-file': '📎',
    anchor: '#',
    external: '↗',
  };

  function populateLinksList() {
    el.tocLinksList.innerHTML = '';
    if (!state.currentFilePath) {
      tocEmpty(el.tocLinksList, t('toc.selectDocument'));
      return;
    }

    const anchors = Array.from(el.frame.contentDocument.querySelectorAll('a'));
    const seen = new Set();
    const entries = [];
    for (const anchor of anchors) {
      const info = classifyAnchor(anchor);
      if (!info || seen.has(info.key)) continue;
      seen.add(info.key);
      const label = anchor.textContent.trim() || info.href || info.absPath || info.key;
      entries.push({ info, label });
    }

    if (entries.length === 0) {
      tocEmpty(el.tocLinksList, t('toc.noLinks'));
      return;
    }

    for (const entry of entries) {
      const { info, label } = entry;
      const li = document.createElement('li');
      li.className = 'toc-item';
      li.textContent = `${LINK_TYPE_ICON[info.type]} ${label}`;
      li.title =
        info.type === 'external'
          ? info.href
          : info.type === 'anchor'
          ? '#' + info.hash
          : info.absPath + (info.hash ? '#' + info.hash : '');
      li.addEventListener('click', () => {
        if (info.type === 'external') {
          window.mdviewer.openExternal(info.href);
        } else if (info.type === 'anchor') {
          const target = el.frame.contentDocument.getElementById(info.hash);
          if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
        } else {
          openInternalLink(info.absPath, info.hash);
        }
      });
      el.tocLinksList.appendChild(li);
    }
  }

  async function populateSiblingPages() {
    el.tocSiblingsList.innerHTML = '';
    if (!state.currentFilePath) {
      tocEmpty(el.tocSiblingsList, t('toc.selectDocument'));
      return;
    }
    const dir = dirnameOf(state.currentFilePath);
    const baseName = basenameNoExt(state.currentFilePath).toLowerCase();
    const result = await window.mdviewer.listDir(dir);
    if (!result.ok) return;
    const subFolder = result.items.find(
      (item) => item.isDir && item.name.toLowerCase() === baseName
    );
    if (!subFolder) {
      tocEmpty(el.tocSiblingsList, t('toc.noSubfolder', { name: basenameNoExt(state.currentFilePath) }));
      return;
    }
    await renderTreeLevel(el.tocSiblingsList, subFolder.path, 0, 10);
  }

  function refreshToc() {
    populateToc();
    populateLinksList();
    populateSiblingPages();
  }

  // Keep in sync with the collapsed/expanded widths in ui.css (.toc-panel / .toc-panel.collapsed).
  const TOC_WIDTH_DELTA = 240 - 32;
  const EDITOR_MIN_WIDTH = 160;

  function toggleTocCollapse() {
    const expanding = el.tocPanel.classList.contains('collapsed');
    el.tocPanel.classList.toggle('collapsed');
    // Widening/narrowing the TOC panel would otherwise resize the preview
    // frame (flex:1). Steal the width from the editor pane instead, so the
    // preview stays visually fixed as long as the editor has room to give.
    if (state.editMode && !el.mdSourceEditor.classList.contains('hidden')) {
      const currentWidth = el.mdSourceEditor.getBoundingClientRect().width;
      const delta = expanding ? TOC_WIDTH_DELTA : -TOC_WIDTH_DELTA;
      const newWidth = Math.max(EDITOR_MIN_WIDTH, currentWidth - delta);
      el.mdSourceEditor.style.width = newWidth + 'px';
    }
    persistProjectState();
  }

  el.tocPanelHeader.addEventListener('click', toggleTocCollapse);
  el.tocPanelHeader.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      toggleTocCollapse();
    }
  });

  // ---------------------------------------------------------------------
  // CSS editor
  // ---------------------------------------------------------------------

  async function loadProjectCss({ silent = false } = {}) {
    const result = await window.mdviewer.loadProjectCss(state.rootPath);
    const css = result.ok ? result.css : '';
    el.cssEditor.value = css;
    applyLiveCss();
    state.cssDirty = false;
    el.cssStatus.textContent = silent ? '' : t('css.restoredLastSaved');
  }

  el.cssEditor.addEventListener('input', () => {
    clearTimeout(state.cssDebounceTimer);
    state.cssDebounceTimer = setTimeout(() => {
      applyLiveCss();
    }, 120);
    state.cssDirty = true;
    el.cssStatus.textContent = t('css.unsavedChanges');
  });

  el.cssEnabledToggle.addEventListener('change', () => {
    state.cssEnabled = el.cssEnabledToggle.checked;
    applyLiveCss();
    el.cssStatus.textContent = state.cssEnabled
      ? t('css.appliedOn')
      : t('css.appliedOff');
    persistProjectState();
  });

  el.btnSaveCss.addEventListener('click', async () => {
    if (!state.rootPath) {
      el.cssStatus.textContent = t('css.openFolderFirst');
      return;
    }
    const result = await window.mdviewer.saveProjectCss(state.rootPath, el.cssEditor.value);
    if (result.ok) {
      state.cssDirty = false;
      el.cssStatus.textContent = t('css.savedTo');
    } else {
      el.cssStatus.textContent = t('css.saveFailed', { error: result.error });
    }
  });

  el.btnResetCss.addEventListener('click', () => {
    loadProjectCss();
  });

  // ---- Import base style from another project ----

  async function importCssFrom(sourcePath) {
    const result = await window.mdviewer.loadProjectCss(sourcePath);
    if (!result.ok) {
      el.cssStatus.textContent = t('css.importFailed', { error: result.error });
      return;
    }
    el.cssEditor.value = result.css;
    applyLiveCss();
    state.cssDirty = true;
    el.cssStatus.textContent = t('css.importedPending', { path: sourcePath });
    closeImportDropdown();
  }

  function openImportDropdown() {
    el.importDropdown.classList.remove('hidden');
    populateImportRecentList();
  }

  function closeImportDropdown() {
    el.importDropdown.classList.add('hidden');
  }

  async function populateImportRecentList() {
    const items = (await window.mdviewer.listRecentProjects()).filter(
      (item) => normalizePath(item.path) !== normalizePath(state.rootPath || '')
    );
    el.importRecentList.innerHTML = '';
    if (items.length === 0) {
      const empty = document.createElement('li');
      empty.className = 'import-recent-empty';
      empty.textContent = t('css.noOtherProjects');
      el.importRecentList.appendChild(empty);
      return;
    }
    for (const item of items) {
      const li = document.createElement('li');
      li.className = 'import-recent-item';
      li.title = item.path;

      const name = document.createElement('div');
      name.className = 'import-recent-item-name';
      name.textContent = item.name + (item.exists ? '' : t('recent.notFoundSuffix'));
      const pathEl = document.createElement('div');
      pathEl.className = 'import-recent-item-path';
      pathEl.textContent = item.path;

      li.appendChild(name);
      li.appendChild(pathEl);
      li.addEventListener('click', () => importCssFrom(item.path));
      el.importRecentList.appendChild(li);
    }
  }

  function normalizePath(p) {
    return p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  }

  el.btnImportCss.addEventListener('click', (e) => {
    e.stopPropagation();
    if (el.importDropdown.classList.contains('hidden')) {
      openImportDropdown();
    } else {
      closeImportDropdown();
    }
  });

  el.btnImportBrowse.addEventListener('click', async () => {
    const folder = await window.mdviewer.openFolderDialog();
    if (folder) importCssFrom(folder);
  });

  document.addEventListener('click', (e) => {
    if (!el.importDropdown.classList.contains('hidden') && !el.importDropdown.contains(e.target)) {
      closeImportDropdown();
    }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeImportDropdown();
  });

  function toggleCssEditor() {
    const hidden = el.cssPane.classList.toggle('hidden');
    el.resizerRight.classList.toggle('hidden', hidden);
    persistProjectState();
  }

  el.btnToggleCss.addEventListener('click', toggleCssEditor);
  window.mdviewer.onMenuToggleCssEditor(toggleCssEditor);

  // ---------------------------------------------------------------------
  // Open folder / file actions
  // ---------------------------------------------------------------------

  el.btnOpenFolder.addEventListener('click', async () => {
    const folder = await window.mdviewer.openFolderDialog();
    if (folder) openFolder(folder);
  });

  el.btnOpenProjectFolder.addEventListener('click', () => {
    if (state.rootPath) window.mdviewer.openPath(state.rootPath);
  });

  el.btnOpenFile.addEventListener('click', async () => {
    const file = await window.mdviewer.openFileDialog();
    if (file) openSingleFile(file);
  });

  el.welcomeOpenFolder.addEventListener('click', async () => {
    const folder = await window.mdviewer.openFolderDialog();
    if (folder) openFolder(folder);
  });

  el.welcomeOpenFile.addEventListener('click', async () => {
    const file = await window.mdviewer.openFileDialog();
    if (file) openSingleFile(file);
  });

  window.mdviewer.onMenuOpenFolder(async () => {
    const folder = await window.mdviewer.openFolderDialog();
    if (folder) openFolder(folder);
  });

  window.mdviewer.onMenuOpenFile(async () => {
    const file = await window.mdviewer.openFileDialog();
    if (file) openSingleFile(file);
  });

  window.mdviewer.onMenuOpenRecent((folderPath) => {
    openFolder(folderPath);
  });

  window.mdviewer.onOpenPathFromOS((filePath) => {
    openSingleFile(filePath);
  });

  // ---------------------------------------------------------------------
  // Bottom terminal panel
  // ---------------------------------------------------------------------

  let term = null;
  let fitAddon = null;

  function ensureXterm() {
    if (term) return;
    term = new window.Terminal({
      fontFamily:
        '"D2Coding", "D2Coding ligature", Consolas, "Cascadia Mono", "Cascadia Code", "SFMono-Regular", Menlo, monospace',
      fontSize: 13,
      lineHeight: 1.3,
      cursorBlink: true,
      scrollback: 5000,
      theme: { background: '#1e1e1e', foreground: '#d4d4d4' },
    });
    fitAddon = new window.FitAddon.FitAddon();
    term.loadAddon(fitAddon);
    term.open(el.terminalXterm);
    term.onData((data) => {
      window.mdviewer.sendTerminalInput(data);
    });
    term.onResize(({ cols, rows }) => {
      window.mdviewer.resizeTerminal(cols, rows);
    });
    el.terminalXterm.addEventListener('contextmenu', async (e) => {
      e.preventDefault();
      if (term.hasSelection()) {
        const selection = term.getSelection();
        term.clearSelection();
        await window.mdviewer.clipboardWriteText(selection);
      } else {
        const text = await window.mdviewer.clipboardReadText();
        if (text) term.paste(text);
      }
    });
  }

  async function ensureTerminalStarted() {
    ensureXterm();
    if (state.terminalStarted) return;
    const cwd = state.rootPath || undefined;
    fitAddon.fit();
    await window.mdviewer.startTerminal(cwd, term.cols, term.rows);
    state.terminalStarted = true;
    el.terminalCwd.textContent = cwd || '';
    el.terminalCwd.title = cwd || '';
  }

  async function openTerminalPanel() {
    el.terminalPanel.classList.remove('hidden');
    el.resizerTerminal.classList.remove('hidden');
    el.btnToggleTerminal.classList.add('active');
    state.terminalOpen = true;
    await ensureTerminalStarted();
    fitAddon.fit();
    term.focus();
  }

  function closeTerminalPanel() {
    el.terminalPanel.classList.add('hidden');
    el.resizerTerminal.classList.add('hidden');
    el.btnToggleTerminal.classList.remove('active');
    state.terminalOpen = false;
  }

  async function toggleTerminalPanel() {
    if (state.terminalOpen) {
      closeTerminalPanel();
    } else {
      await openTerminalPanel();
    }
  }

  async function restartTerminal() {
    await window.mdviewer.stopTerminal();
    state.terminalStarted = false;
    ensureXterm();
    term.reset();
    await ensureTerminalStarted();
    term.focus();
  }

  el.btnToggleTerminal.addEventListener('click', toggleTerminalPanel);
  window.mdviewer.onMenuToggleTerminal(toggleTerminalPanel);
  el.btnTerminalClose.addEventListener('click', closeTerminalPanel);
  el.btnTerminalClear.addEventListener('click', () => {
    if (term) term.clear();
  });
  el.btnTerminalRestart.addEventListener('click', restartTerminal);

  window.mdviewer.onTerminalData((data) => {
    if (term) term.write(data);
  });

  window.mdviewer.onTerminalExit((code) => {
    if (term) term.write(`\r\n\x1b[31m[${t('terminal.shellExited', { code })}]\x1b[0m\r\n`);
    state.terminalStarted = false;
  });

  window.addEventListener('resize', () => {
    if (state.terminalOpen && fitAddon) fitAddon.fit();
  });

  // ---------------------------------------------------------------------
  // Pane resizers
  // ---------------------------------------------------------------------

  function setupResizer(resizerEl, targetEl, mode, onResize) {
    // Pointer Events + setPointerCapture: the preview pane is an <iframe>
    // (a separate browsing context), so plain mouse events on `window` stop
    // bubbling once the cursor crosses into it, breaking the drag. Pointer
    // capture keeps events routed to the resizer regardless of what's
    // underneath.
    let dragging = false;
    resizerEl.addEventListener('pointerdown', (e) => {
      dragging = true;
      resizerEl.classList.add('dragging');
      resizerEl.setPointerCapture(e.pointerId);
      e.preventDefault();
    });
    resizerEl.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const rect = targetEl.parentElement.getBoundingClientRect();
      if (mode === 'left') {
        targetEl.style.width = Math.max(160, e.clientX - rect.left) + 'px';
      } else if (mode === 'bottom') {
        targetEl.style.height = Math.max(80, rect.bottom - e.clientY) + 'px';
      } else {
        targetEl.style.width = Math.max(220, rect.right - e.clientX) + 'px';
      }
      if (onResize) onResize();
    });
    function endDrag(e) {
      if (!dragging) return;
      dragging = false;
      resizerEl.classList.remove('dragging');
      if (resizerEl.hasPointerCapture(e.pointerId)) {
        resizerEl.releasePointerCapture(e.pointerId);
      }
    }
    resizerEl.addEventListener('pointerup', endDrag);
    resizerEl.addEventListener('pointercancel', endDrag);
  }

  setupResizer(el.resizerLeft, el.sidebar, 'left');
  setupResizer(el.resizerRight, el.cssPane, 'right');
  setupResizer(el.editorResizer, el.mdSourceEditor, 'left');
  setupResizer(el.resizerTerminal, el.terminalPanel, 'bottom', () => {
    if (fitAddon) fitAddon.fit();
  });

  // ---------------------------------------------------------------------
  // Init
  // ---------------------------------------------------------------------

  (async () => {
    await initI18n();
    initPreviewFrame();
    showWelcomeScreen();
    updateCssAppliedBadge();
  })();
})();
