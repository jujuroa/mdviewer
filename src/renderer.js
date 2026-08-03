(() => {
  const state = {
    rootPath: null,
    currentFilePath: null,
    currentFileKind: 'markdown',
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
    suppressScrollSync: false,
    customTextExtensions: [],
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
    btnRefreshPuml: document.getElementById('btn-refresh-puml'),
    jsonPathBar: document.getElementById('json-path-bar'),
    findBar: document.getElementById('find-bar'),
    findInput: document.getElementById('find-input'),
    findCount: document.getElementById('find-count'),
    findPrev: document.getElementById('find-prev'),
    findNext: document.getElementById('find-next'),
    findClose: document.getElementById('find-close'),
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
    extOverlay: document.getElementById('ext-settings-overlay'),
    extInput: document.getElementById('ext-input'),
    btnExtAdd: document.getElementById('btn-ext-add'),
    extList: document.getElementById('ext-list'),
    extError: document.getElementById('ext-error'),
    btnCloseExtSettings: document.getElementById('btn-close-ext-settings'),
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
  // Custom text extensions settings
  // ---------------------------------------------------------------------

  const BUILTIN_KIND_EXTENSIONS = new Set(['md', 'markdown', 'puml', 'json', 'txt', 'log']);

  async function loadCustomExtensions() {
    const result = await window.mdviewer.getCustomExtensions();
    state.customTextExtensions = result.ok ? result.extensions : [];
  }

  async function refreshTreeRoot() {
    if (!state.rootPath) return;
    const result = await window.mdviewer.listDir(state.rootPath);
    if (!result.ok) return;
    el.tree.innerHTML = '';
    buildTreeNodes(el.tree, result.items, 0);
  }

  function renderExtList() {
    el.extList.innerHTML = '';
    if (state.customTextExtensions.length === 0) {
      const empty = document.createElement('li');
      empty.className = 'ext-list-empty';
      empty.textContent = t('ext.empty');
      el.extList.appendChild(empty);
      return;
    }
    for (const ext of state.customTextExtensions) {
      const li = document.createElement('li');
      li.className = 'ext-list-item';
      const label = document.createElement('span');
      label.textContent = '.' + ext;
      li.appendChild(label);
      const removeBtn = document.createElement('button');
      removeBtn.className = 'ext-list-remove';
      removeBtn.textContent = '✕';
      removeBtn.title = t('ext.removeTitle');
      removeBtn.addEventListener('click', () => removeCustomExtension(ext));
      li.appendChild(removeBtn);
      el.extList.appendChild(li);
    }
  }

  function showExtError(key) {
    el.extError.textContent = t(key);
    el.extError.classList.remove('hidden');
  }

  function hideExtError() {
    el.extError.classList.add('hidden');
    el.extError.textContent = '';
  }

  async function addCustomExtension() {
    const raw = el.extInput.value.trim().replace(/^\./, '').toLowerCase();
    if (!raw || !/^[a-z0-9]+$/.test(raw)) {
      showExtError('ext.errorInvalid');
      return;
    }
    if (BUILTIN_KIND_EXTENSIONS.has(raw)) {
      showExtError('ext.errorBuiltin');
      return;
    }
    if (state.customTextExtensions.includes(raw)) {
      showExtError('ext.errorDuplicate');
      return;
    }
    hideExtError();
    const next = [...state.customTextExtensions, raw];
    const result = await window.mdviewer.setCustomExtensions(next);
    state.customTextExtensions = result.ok ? result.extensions : next;
    el.extInput.value = '';
    renderExtList();
    await refreshTreeRoot();
  }

  async function removeCustomExtension(ext) {
    const next = state.customTextExtensions.filter((e) => e !== ext);
    const result = await window.mdviewer.setCustomExtensions(next);
    state.customTextExtensions = result.ok ? result.extensions : next;
    renderExtList();
    await refreshTreeRoot();
  }

  function openExtSettings() {
    hideExtError();
    el.extInput.value = '';
    renderExtList();
    el.extOverlay.classList.remove('hidden');
    el.extInput.focus();
  }

  function closeExtSettings() {
    el.extOverlay.classList.add('hidden');
  }

  el.btnCloseExtSettings.addEventListener('click', closeExtSettings);
  el.extOverlay.addEventListener('click', (e) => {
    if (e.target === el.extOverlay) closeExtSettings();
  });
  el.btnExtAdd.addEventListener('click', addCustomExtension);
  el.extInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      addCustomExtension();
    } else if (e.key === 'Escape') {
      closeExtSettings();
    }
  });
  window.mdviewer.onMenuManageCustomExtensions(openExtSettings);

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

    // Event delegation for JSON tree expand/collapse toggles. Delegated on
    // `doc` (rather than re-attached per render) since the tree is rebuilt
    // wholesale on every keystroke while editing.
    doc.addEventListener('click', onJsonTreeToggle);
    doc.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      if (!e.target.classList || !e.target.classList.contains('json-toggle')) return;
      e.preventDefault();
      onJsonTreeToggle(e);
    });

    // Click a JSON node's key or value to see its path; double-click a leaf
    // value to edit it in place.
    doc.addEventListener('click', onJsonNodeClick);
    doc.addEventListener('dblclick', onJsonNodeDblClick);

    // PlantUML diagram zoom (+/-/reset buttons, Ctrl+wheel) and click-drag pan.
    doc.addEventListener('click', onPumlZoomControlClick);
    doc.addEventListener('wheel', onPumlWheel, { passive: false });
    doc.addEventListener('mousedown', onPumlPanStart);
    doc.addEventListener('mousemove', onPumlPanMove);
    doc.addEventListener('mouseup', onPumlPanEnd);
    doc.addEventListener('mouseleave', onPumlPanEnd);

    // Debounced scroll-position tracking, so re-opening a file later can
    // restore where the reader left off (see loadAndRenderFile).
    let viewerEditorSyncQueued = false;
    el.frame.contentWindow.addEventListener('scroll', () => {
      clearTimeout(state.scrollDebounceTimer);
      state.scrollDebounceTimer = setTimeout(() => {
        captureScrollPosition();
        persistProjectState();
      }, 400);

      if (!state.suppressScrollSync && !viewerEditorSyncQueued) {
        viewerEditorSyncQueued = true;
        requestAnimationFrame(() => {
          viewerEditorSyncQueued = false;
          syncEditorScrollToViewer();
        });
      }
    });
  }

  // shell.openExternal can fail (missing file, no associated app, etc.);
  // log that instead of failing silently, so it's diagnosable in DevTools.
  function openExternalSafe(url) {
    window.mdviewer.openExternal(url).then((result) => {
      if (!result || !result.ok) {
        console.error('[mdviewer] Failed to open externally:', url, result && result.error);
      }
    });
  }

  function onJsonTreeToggle(e) {
    const toggle = e.target.closest('.json-toggle');
    if (!toggle) return;
    const branch = toggle.closest('.json-branch');
    if (branch) branch.classList.toggle('collapsed');
  }

  // ---------------------------------------------------------------------
  // PlantUML diagram zoom / pan
  //
  // The preview iframe is sandboxed without allow-scripts (see
  // initPreviewFrame), so the diagram markup itself carries no behavior —
  // all interactivity is wired up here from the parent frame instead.
  // ---------------------------------------------------------------------

  const PUML_ZOOM_MIN = 25;
  const PUML_ZOOM_MAX = 400;
  const PUML_ZOOM_STEP = 25;
  let pumlPanState = null;

  function setPumlZoom(diagramEl, percent) {
    const clamped = Math.max(PUML_ZOOM_MIN, Math.min(PUML_ZOOM_MAX, Math.round(percent)));
    diagramEl.dataset.zoom = String(clamped);
    const img = diagramEl.querySelector('.plantuml-scroll img');
    if (img) {
      const naturalWidth = img.naturalWidth || parseInt(img.getAttribute('width'), 10) || 0;
      img.style.width = clamped === 100 || !naturalWidth ? '' : `${Math.round(naturalWidth * clamped / 100)}px`;
    }
    const label = diagramEl.querySelector('.puml-zoom-level');
    if (label) label.textContent = `${clamped}%`;
  }

  function onPumlZoomControlClick(e) {
    const btn = e.target.closest('.puml-zoom-in, .puml-zoom-out, .puml-zoom-reset');
    if (!btn) return;
    const diagramEl = btn.closest('.plantuml-diagram');
    if (!diagramEl) return;
    e.preventDefault();
    const current = parseInt(diagramEl.dataset.zoom || '100', 10);
    if (btn.classList.contains('puml-zoom-in')) setPumlZoom(diagramEl, current + PUML_ZOOM_STEP);
    else if (btn.classList.contains('puml-zoom-out')) setPumlZoom(diagramEl, current - PUML_ZOOM_STEP);
    else setPumlZoom(diagramEl, 100);
  }

  function onPumlWheel(e) {
    if (!e.ctrlKey) return;
    const diagramEl = e.target.closest('.plantuml-diagram');
    if (!diagramEl) return;
    e.preventDefault();
    const current = parseInt(diagramEl.dataset.zoom || '100', 10);
    setPumlZoom(diagramEl, current + (e.deltaY < 0 ? PUML_ZOOM_STEP : -PUML_ZOOM_STEP));
  }

  function onPumlPanStart(e) {
    const scrollEl = e.target.closest('.plantuml-scroll');
    if (!scrollEl || e.button !== 0) return;
    if (scrollEl.scrollWidth <= scrollEl.clientWidth && scrollEl.scrollHeight <= scrollEl.clientHeight) return;
    pumlPanState = {
      scrollEl,
      startX: e.clientX,
      startY: e.clientY,
      startLeft: scrollEl.scrollLeft,
      startTop: scrollEl.scrollTop,
    };
    scrollEl.classList.add('puml-panning');
    e.preventDefault();
  }

  function onPumlPanMove(e) {
    if (!pumlPanState) return;
    const { scrollEl, startX, startY, startLeft, startTop } = pumlPanState;
    scrollEl.scrollLeft = startLeft - (e.clientX - startX);
    scrollEl.scrollTop = startTop - (e.clientY - startY);
  }

  function onPumlPanEnd() {
    if (!pumlPanState) return;
    pumlPanState.scrollEl.classList.remove('puml-panning');
    pumlPanState = null;
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
      openExternalSafe(href);
    } else if (href.startsWith('mailto:')) {
      e.preventDefault();
      openExternalSafe(href);
    }
    // '#fragment' links fall through to default same-doc scrolling behavior.
  }

  // Whether a path's extension should open in the plain-text viewer/editor:
  // the built-in .txt/.log set, plus any user-added custom extensions from
  // the "Custom Extensions..." settings dialog.
  function isPlainTextPath(filePath) {
    if (/\.(txt|log)$/i.test(filePath)) return true;
    const m = /\.([a-zA-Z0-9]+)$/.exec(filePath);
    if (!m) return false;
    return state.customTextExtensions.includes(m[1].toLowerCase());
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
    } else if (/\.puml$/i.test(absPath)) {
      if (!(await guardNavigation())) return;
      await loadAndRenderPuml(absPath);
      await revealPathInTree(absPath, { select: true });
    } else if (/\.json$/i.test(absPath)) {
      if (!(await guardNavigation())) return;
      await loadAndRenderJson(absPath);
      await revealPathInTree(absPath, { select: true });
    } else if (isPlainTextPath(absPath)) {
      if (!(await guardNavigation())) return;
      await loadAndRenderText(absPath);
      await revealPathInTree(absPath, { select: true });
    } else if (absPath) {
      openExternalSafe(pathToFileUrl(absPath));
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
    state.currentFileKind = 'markdown';
    updateFileKindUI();

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
      await loadAndRenderByPath(savedState.lastOpenFile);
      if (savedState.editModeOpen && state.currentFilePath) {
        await enterEditMode();
      }
    }

    return true;
  }

  async function openSingleFile(filePath) {
    const dir = filePath.substring(0, Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\')));
    const opened = await openFolder(dir);
    if (!opened) return;
    await loadAndRenderByPath(filePath);
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
      row.className =
        'tree-row' +
        (item.isDir
          ? ' dir'
          : item.isMarkdown
          ? ' md'
          : item.isPuml
          ? ' puml'
          : item.isJson
          ? ' json'
          : item.isPlainText
          ? ' plaintext'
          : ' non-md');
      row.style.paddingLeft = 6 + depth * indentUnit + 'px';
      row.dataset.path = item.path;

      const caret = document.createElement('span');
      caret.className = 'tree-caret';
      caret.textContent = item.isDir ? '▶' : '';
      row.appendChild(caret);

      const icon = document.createElement('span');
      icon.className = 'tree-icon';
      icon.textContent =
        item.isDir
          ? '📁'
          : item.isMarkdown
          ? '📄'
          : item.isPuml
          ? '📐'
          : item.isJson
          ? '🗂'
          : item.isPlainText
          ? '📃'
          : '·';
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
      } else if (item.isPuml) {
        row.addEventListener('click', async () => {
          if (!(await guardNavigation())) return;
          selectTreeRow(row);
          loadAndRenderPuml(item.path);
        });
      } else if (item.isJson) {
        row.addEventListener('click', async () => {
          if (!(await guardNavigation())) return;
          selectTreeRow(row);
          loadAndRenderJson(item.path);
        });
      } else if (item.isPlainText) {
        row.addEventListener('click', async () => {
          if (!(await guardNavigation())) return;
          selectTreeRow(row);
          loadAndRenderText(item.path);
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

  // Toggles toolbar/preview affordances that only make sense for one file
  // kind (e.g. JSON/plain-text views need the preview body's prose
  // max-width lifted so wide content (JSON columns, long log lines) has
  // room instead of being squeezed). The refresh button applies to any open
  // file, so it only depends on whether one is open at all.
  function updateFileKindUI() {
    el.btnRefreshPuml.classList.toggle('hidden', !state.currentFilePath);
    const isWideView = state.currentFileKind === 'json' || state.currentFileKind === 'text';
    el.frame.contentDocument.body.classList.toggle('wide-view', isWideView);
    // Reserve the path bar's space for the whole time a JSON file is open
    // (even before any node has been clicked), so clicking the first node
    // doesn't shift the layout by suddenly introducing the bar.
    el.jsonPathBar.classList.toggle('hidden', state.currentFileKind !== 'json');
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
    state.currentFileKind = 'markdown';
    updateFileKindUI();
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

  // PlantUML files are viewed as a rendered diagram (no live-render-on-type):
  // re-rendering only happens on open, save, and the explicit refresh button.
  async function loadAndRenderPuml(filePath) {
    captureScrollPosition();
    const result = await window.mdviewer.renderPlantUmlFile(filePath);
    if (!result.ok) {
      el.frame.contentDocument.body.innerHTML =
        `<div class="mdviewer-empty-state">${escapeHtml(t('file.openFailed', { error: result.error }))}</div>`;
      return;
    }
    el.frame.contentDocument.body.innerHTML = result.html;
    renderBreadcrumb(filePath);
    state.currentFilePath = filePath;
    state.currentFileKind = 'puml';
    updateFileKindUI();
    window.mdviewer.watchFile(filePath);
    restoreScrollPosition(filePath);

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

  // Dispatches to the right loader for a file path based on its extension.
  async function loadAndRenderByPath(filePath) {
    if (/\.puml$/i.test(filePath)) {
      await loadAndRenderPuml(filePath);
    } else if (/\.json$/i.test(filePath)) {
      await loadAndRenderJson(filePath);
    } else if (isPlainTextPath(filePath)) {
      await loadAndRenderText(filePath);
    } else {
      await loadAndRenderFile(filePath);
    }
  }

  // Re-renders the current PlantUML diagram from the given source text
  // (either the live editor buffer, or freshly re-read from disk).
  async function renderPumlFromText(text) {
    const result = await window.mdviewer.renderPlantUmlText(text);
    if (result.ok) {
      el.frame.contentDocument.body.innerHTML = result.html;
    }
  }

  // Reloads the currently open file from disk, whatever its kind — picks up
  // changes made in another editor. Outside edit mode the file watcher
  // already does this automatically, but it deliberately stays silent
  // during edit mode to avoid clobbering in-progress edits (see the
  // 'file-changed' handler below), so this button is the manual way to
  // pull in external changes while editing. Confirms first if there are
  // unsaved edits, since this discards them the same way switching files
  // or exiting edit mode does.
  async function refreshCurrentFile() {
    if (!state.currentFilePath) return;
    if (!confirmDiscardIfDirty()) return;

    if (!state.editMode) {
      await loadAndRenderByPath(state.currentFilePath);
      return;
    }

    const readResult = await window.mdviewer.readFile(state.currentFilePath);
    if (!readResult.ok) return;
    el.mdSourceEditor.value = readResult.content;
    state.sourceDirty = false;
    el.editStatus.textContent = '';

    if (state.currentFileKind === 'puml') {
      await renderPumlFromText(readResult.content);
    } else {
      await renderSourcePreview();
    }
  }

  // JSON files are shown as a collapsible tree. Like markdown (and unlike
  // PlantUML), the tree re-renders live as you type in edit mode.
  async function loadAndRenderJson(filePath) {
    captureScrollPosition();
    clearJsonPath();
    const result = await window.mdviewer.renderJsonFile(filePath);
    if (!result.ok) {
      el.frame.contentDocument.body.innerHTML =
        `<div class="mdviewer-empty-state">${escapeHtml(t('file.openFailed', { error: result.error }))}</div>`;
      return;
    }
    el.frame.contentDocument.body.innerHTML = result.html;
    renderBreadcrumb(filePath);
    state.currentFilePath = filePath;
    state.currentFileKind = 'json';
    updateFileKindUI();
    window.mdviewer.watchFile(filePath);
    restoreScrollPosition(filePath);

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

  // .txt/.log files are shown as plain, unrendered text. Like markdown and
  // JSON (and unlike PlantUML), it re-renders live as you type.
  async function loadAndRenderText(filePath) {
    captureScrollPosition();
    const result = await window.mdviewer.renderPlainTextFile(filePath);
    if (!result.ok) {
      el.frame.contentDocument.body.innerHTML =
        `<div class="mdviewer-empty-state">${escapeHtml(t('file.openFailed', { error: result.error }))}</div>`;
      return;
    }
    el.frame.contentDocument.body.innerHTML = result.html;
    renderBreadcrumb(filePath);
    state.currentFilePath = filePath;
    state.currentFileKind = 'text';
    updateFileKindUI();
    window.mdviewer.watchFile(filePath);
    restoreScrollPosition(filePath);

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

  async function renderJsonFromText(text) {
    const result = await window.mdviewer.renderJsonText(text);
    if (result.ok) {
      el.frame.contentDocument.body.innerHTML = result.html;
    }
    return result.ok;
  }

  // Clears the path bar's text without hiding it — visibility is handled
  // separately by updateFileKindUI, which keeps it (empty) reserved for the
  // whole time a JSON file is open rather than only once a node is clicked.
  function clearJsonPath() {
    el.jsonPathBar.textContent = '';
  }

  // Formats a data-path array (string keys, numeric array indices) as a
  // JSONPath-ish string developers will recognize, e.g. $.scripts.start or
  // $.dependencies["@xterm/addon-fit"] or $.tags[0].
  function formatJsonPath(path) {
    let result = '$';
    for (const segment of path) {
      if (typeof segment === 'number') {
        result += `[${segment}]`;
      } else if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(segment)) {
        result += `.${segment}`;
      } else {
        result += `[${JSON.stringify(segment)}]`;
      }
    }
    return result;
  }

  function jsonPathFromElement(node) {
    const withPath = node.closest('[data-path]');
    if (!withPath) return null;
    try {
      return JSON.parse(withPath.getAttribute('data-path'));
    } catch (err) {
      return null;
    }
  }

  // Applies a single edited leaf value back into the full JSON document and
  // re-renders. Reuses the same source-editor buffer + dirty/Save machinery
  // as the raw-text editor, so "edit a value in the tree" and "edit the
  // text" stay consistent and a single Save covers either.
  async function commitJsonValueEdit(path, rawInputValue, originalText) {
    const trimmed = rawInputValue.trim();
    if (trimmed === originalText.trim()) return true;

    let newValue;
    try {
      newValue = JSON.parse(trimmed);
    } catch (err) {
      return false;
    }

    let sourceText;
    if (state.sourceDirty && el.mdSourceEditor.value) {
      sourceText = el.mdSourceEditor.value;
    } else {
      const readResult = await window.mdviewer.readFile(state.currentFilePath);
      if (!readResult.ok) return false;
      sourceText = readResult.content;
    }

    let root;
    try {
      root = JSON.parse(sourceText);
    } catch (err) {
      return false;
    }

    if (path.length === 0) {
      root = newValue;
    } else {
      let target = root;
      for (let i = 0; i < path.length - 1; i++) target = target[path[i]];
      target[path[path.length - 1]] = newValue;
    }

    const newText = JSON.stringify(root, null, 2);
    el.mdSourceEditor.value = newText;
    state.sourceDirty = true;
    el.editStatus.textContent = t('edit.unsavedChanges');
    el.btnSaveSource.classList.remove('hidden');

    return renderJsonFromText(newText);
  }

  function startJsonValueEdit(span, path) {
    if (!path || span.tagName !== 'SPAN') return;
    const originalText = span.textContent;
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'json-value-input';
    input.value = originalText;
    input.style.width = `${Math.max(3, originalText.length) + 1.5}ch`;
    span.replaceWith(input);
    input.focus();
    input.select();

    let settled = false;
    const finish = async (commit) => {
      if (settled) return;
      if (commit) {
        const ok = await commitJsonValueEdit(path, input.value, originalText);
        if (ok) {
          settled = true;
          return; // tree was re-rendered; this input is no longer in the DOM
        }
        input.classList.add('json-value-input-error');
        return; // keep editing so the user can fix the invalid JSON
      }
      settled = true;
      input.replaceWith(span);
    };

    input.addEventListener('input', () => input.classList.remove('json-value-input-error'));
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        finish(true);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        finish(false);
      }
    });
    input.addEventListener('blur', () => finish(true));
  }

  // Single click (on a key or a leaf value) just shows the node's path —
  // editing needs a double-click so casually clicking around the tree can't
  // accidentally drop you into an edit field.
  function onJsonNodeClick(e) {
    if (state.currentFileKind !== 'json') return;
    const node = e.target.closest('.json-editable-value, .json-key, .json-index');
    if (!node) return;
    const path = jsonPathFromElement(node);
    if (!path) return;
    el.jsonPathBar.textContent = formatJsonPath(path);
    el.jsonPathBar.classList.remove('hidden');
  }

  function onJsonNodeDblClick(e) {
    if (state.currentFileKind !== 'json') return;
    const valueSpan = e.target.closest('.json-editable-value');
    if (!valueSpan) return;
    const path = jsonPathFromElement(valueSpan);
    if (!path) return;
    el.jsonPathBar.textContent = formatJsonPath(path);
    el.jsonPathBar.classList.remove('hidden');
    startJsonValueEdit(valueSpan, path);
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
    loadAndRenderByPath(changedPath);
  });

  // ---------------------------------------------------------------------
  // Split-view scroll sync (editor <-> viewer)
  //
  // Keeps the source editor and the rendered preview scrolled to the same
  // spot at all times while both are visible, using the same
  // data-source-line/data-source-endline block markers the find feature
  // uses to map matches back to source lines (see inject_source_line in
  // main.js). Each side's scroll handler drives the other, guarded by
  // state.suppressScrollSync so a synced scroll doesn't immediately bounce
  // back and forth between the two.
  // ---------------------------------------------------------------------

  function splitViewActive() {
    return state.editMode && !el.mdSourceEditor.classList.contains('hidden');
  }

  function getEditorLineHeight() {
    return parseFloat(getComputedStyle(el.mdSourceEditor).lineHeight) || 20;
  }

  function getSourceLineElements() {
    const doc = el.frame.contentDocument;
    if (!doc || !doc.body) return [];
    return Array.from(doc.body.querySelectorAll('[data-source-line]'));
  }

  function viewerDocTop(node) {
    return node.getBoundingClientRect().top + el.frame.contentWindow.scrollY;
  }

  // The last block whose source line starts at or before `line` — i.e. the
  // block that would be visible at the top of the viewer if the editor's
  // current top line were scrolled into view.
  function findViewerElementForLine(line) {
    const elems = getSourceLineElements();
    let best = null;
    for (const node of elems) {
      const start = parseInt(node.getAttribute('data-source-line'), 10);
      if (Number.isNaN(start)) continue;
      if (start <= line) best = node;
      else break;
    }
    return best || elems[0] || null;
  }

  // The topmost block currently visible in the viewer's viewport.
  function findTopVisibleViewerElement() {
    const elems = getSourceLineElements();
    const scrollY = el.frame.contentWindow.scrollY;
    let best = null;
    for (const node of elems) {
      if (viewerDocTop(node) <= scrollY + 2) best = node;
      else break;
    }
    return best || elems[0] || null;
  }

  function withScrollSyncSuppressed(fn) {
    state.suppressScrollSync = true;
    fn();
    // The resulting 'scroll' event dispatches asynchronously (next frame or
    // later); a plain requestAnimationFrame can race it, so give it a bit
    // more room before letting the other side's scroll listener re-arm.
    setTimeout(() => {
      state.suppressScrollSync = false;
    }, 100);
  }

  function syncViewerScrollToEditor() {
    if (!splitViewActive()) return;
    const topLine = Math.floor(el.mdSourceEditor.scrollTop / getEditorLineHeight());
    const target = findViewerElementForLine(topLine);
    if (!target) return;
    withScrollSyncSuppressed(() => {
      el.frame.contentWindow.scrollTo(0, Math.max(0, viewerDocTop(target)));
    });
  }

  function syncEditorScrollToViewer() {
    if (!splitViewActive()) return;
    const target = findTopVisibleViewerElement();
    if (!target) return;
    const line = parseInt(target.getAttribute('data-source-line'), 10);
    if (Number.isNaN(line)) return;
    withScrollSyncSuppressed(() => {
      el.mdSourceEditor.scrollTop = Math.max(0, line * getEditorLineHeight());
    });
  }

  let viewerSyncQueued = false;
  el.mdSourceEditor.addEventListener('scroll', () => {
    if (state.suppressScrollSync || viewerSyncQueued) return;
    viewerSyncQueued = true;
    requestAnimationFrame(() => {
      viewerSyncQueued = false;
      syncViewerScrollToEditor();
    });
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
    // Start the split view aligned to wherever the viewer was already
    // scrolled to, rather than snapping the editor back to the top.
    syncEditorScrollToViewer();
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
      loadAndRenderByPath(state.currentFilePath);
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
    if (state.currentFileKind === 'json') {
      await renderJsonFromText(el.mdSourceEditor.value);
      refreshToc();
      return;
    }
    if (state.currentFileKind === 'text') {
      const result = await window.mdviewer.renderPlainTextText(el.mdSourceEditor.value);
      if (result.ok) {
        el.frame.contentDocument.body.innerHTML = result.html;
        refreshToc();
      }
      return;
    }
    const baseDir = dirnameOf(state.currentFilePath);
    const result = await window.mdviewer.renderMarkdownText(el.mdSourceEditor.value, baseDir);
    if (result.ok) {
      el.frame.contentDocument.body.innerHTML = result.html;
      refreshToc();
      // Re-rendering replaces the whole preview body, which would otherwise
      // reset its scroll to the top on every keystroke — snap it back to
      // wherever the editor currently is instead.
      syncViewerScrollToEditor();
    }
  }

  async function saveSource() {
    if (!state.currentFilePath) return;
    state.suppressNextWatch = true;
    const result = await window.mdviewer.writeFile(state.currentFilePath, el.mdSourceEditor.value);
    if (result.ok) {
      state.sourceDirty = false;
      el.editStatus.textContent = t('edit.saved');
      if (state.currentFileKind === 'puml') {
        await renderPumlFromText(el.mdSourceEditor.value);
      }
    } else {
      state.suppressNextWatch = false;
      el.editStatus.textContent = t('edit.saveFailed', { error: result.error });
    }
  }

  el.mdSourceEditor.addEventListener('input', () => {
    state.sourceDirty = true;
    el.editStatus.textContent = t('edit.unsavedChanges');
    // PlantUML re-renders only on open/save/refresh, not on every keystroke.
    if (state.currentFileKind === 'puml') return;
    clearTimeout(state.sourceDebounceTimer);
    state.sourceDebounceTimer = setTimeout(renderSourcePreview, 200);
  });

  el.mdSourceEditor.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
      e.preventDefault();
      saveSource();
      return;
    }
    if (e.key === 'Tab') {
      e.preventDefault();
      const ta = el.mdSourceEditor;
      ta.setRangeText('\t', ta.selectionStart, ta.selectionEnd, 'end');
      ta.dispatchEvent(new Event('input', { bubbles: true }));
    }
  });

  el.btnToggleEdit.addEventListener('click', toggleEditMode);
  el.btnSaveSource.addEventListener('click', saveSource);
  el.btnRefreshPuml.addEventListener('click', refreshCurrentFile);

  window.mdviewer.onMenuToggleEditMode(toggleEditMode);
  window.mdviewer.onMenuSaveFile(() => {
    if (state.editMode) saveSource();
  });

  // ---------------------------------------------------------------------
  // Find in document (Ctrl+F)
  //
  // Searches only the rendered preview (the "viewer"), not the whole app
  // window. An earlier version delegated to Electron's native
  // webContents.findInPage, but that searches the entire window — sidebar
  // tree, TOC panel, toolbar labels — so next/prev would jump through
  // unrelated UI matches instead of staying within the document. This
  // walks the preview iframe's own text nodes and wraps matches in <mark>
  // directly, which also lets it map a match back to its markdown source
  // line (via data-source-line, see inject_source_line in main.js) to
  // sync the split-view editor to the viewer's current match afterward.
  // ---------------------------------------------------------------------

  let docFindMatches = [];
  let docFindIndex = -1;

  function clearDocFindHighlights() {
    const doc = el.frame.contentDocument;
    if (!doc) return;
    doc.querySelectorAll('mark.mdviewer-find-hit').forEach((mark) => {
      const parent = mark.parentNode;
      if (!parent) return;
      parent.replaceChild(doc.createTextNode(mark.textContent), mark);
      parent.normalize();
    });
  }

  // Wraps every case-insensitive occurrence of `query` within the preview
  // body's text nodes in a <mark>, and returns them in document order.
  function highlightDocFindMatches(query) {
    const doc = el.frame.contentDocument;
    if (!doc || !doc.body) return [];
    const lowerQuery = query.toLowerCase();

    const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (!node.nodeValue || !node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
        const parentTag = node.parentNode && node.parentNode.nodeName;
        if (parentTag === 'MARK' || parentTag === 'SCRIPT' || parentTag === 'STYLE') {
          return NodeFilter.FILTER_REJECT;
        }
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    const textNodes = [];
    let node;
    while ((node = walker.nextNode())) textNodes.push(node);

    const marks = [];
    textNodes.forEach((textNode) => {
      const text = textNode.nodeValue;
      const lowerText = text.toLowerCase();
      const spans = [];
      let searchFrom = 0;
      let at;
      while ((at = lowerText.indexOf(lowerQuery, searchFrom)) !== -1) {
        spans.push([at, at + query.length]);
        searchFrom = at + query.length;
      }
      if (!spans.length) return;

      const frag = doc.createDocumentFragment();
      let cursor = 0;
      spans.forEach(([start, end]) => {
        if (start > cursor) frag.appendChild(doc.createTextNode(text.slice(cursor, start)));
        const mark = doc.createElement('mark');
        mark.className = 'mdviewer-find-hit';
        mark.textContent = text.slice(start, end);
        frag.appendChild(mark);
        marks.push(mark);
        cursor = end;
      });
      if (cursor < text.length) frag.appendChild(doc.createTextNode(text.slice(cursor)));
      textNode.parentNode.replaceChild(frag, textNode);
    });
    return marks;
  }

  // After the viewer jumps to a match, scroll the split-view source editor
  // to the corresponding line — the editor follows the viewer, not the
  // other way around, and only once the viewer's own jump has happened.
  // How many lines of context to keep above the synced match, rather than
  // centering it — makes the surrounding source easier to read at a glance.
  const EDITOR_SYNC_CONTEXT_LINES = 8;

  function syncEditorToDocFindMatch(mark) {
    if (!state.editMode || el.mdSourceEditor.classList.contains('hidden')) return;
    const lineEl = mark.closest('[data-source-line]');
    if (!lineEl) return;
    const startLine = parseInt(lineEl.getAttribute('data-source-line'), 10);
    if (Number.isNaN(startLine)) return;
    const endLineAttr = parseInt(lineEl.getAttribute('data-source-endline'), 10);
    const endLine = Number.isNaN(endLineAttr) ? startLine + 1 : endLineAttr;

    const sourceLines = el.mdSourceEditor.value.split('\n');
    let blockStart = 0;
    for (let i = 0; i < startLine && i < sourceLines.length; i++) blockStart += sourceLines[i].length + 1;
    let blockEnd = blockStart;
    for (let i = startLine; i < endLine && i < sourceLines.length; i++) blockEnd += sourceLines[i].length + 1;

    // The block may span several source lines (e.g. a wrapped paragraph);
    // locate the exact occurrence of the matched text within it so the
    // editor selects the same text the viewer highlighted, not just the
    // start of the block.
    const blockText = el.mdSourceEditor.value.slice(blockStart, blockEnd);
    const query = mark.textContent;
    const localIndex = blockText.toLowerCase().indexOf(query.toLowerCase());

    let selStart, targetLine;
    if (localIndex !== -1) {
      selStart = blockStart + localIndex;
      targetLine = startLine + blockText.slice(0, localIndex).split('\n').length - 1;
    } else {
      selStart = blockStart;
      targetLine = startLine;
    }
    el.mdSourceEditor.setSelectionRange(selStart, selStart + (localIndex !== -1 ? query.length : 0));

    const lineHeight = parseFloat(getComputedStyle(el.mdSourceEditor).lineHeight) || 20;
    el.mdSourceEditor.scrollTop = Math.max(0, (targetLine - EDITOR_SYNC_CONTEXT_LINES) * lineHeight);
  }

  function updateFindCountUI() {
    if (!docFindMatches.length) {
      const hasQuery = !!el.findInput.value;
      el.findCount.classList.toggle('no-results', hasQuery);
      el.findCount.textContent = hasQuery ? t('find.noResults') : '';
      return;
    }
    el.findCount.classList.remove('no-results');
    el.findCount.textContent = t('find.matchCount', {
      current: docFindIndex + 1,
      total: docFindMatches.length,
    });
  }

  function gotoDocFindMatch(index) {
    const prevMark = docFindMatches[docFindIndex];
    if (prevMark) prevMark.classList.remove('current');
    docFindIndex = index;
    const mark = docFindMatches[docFindIndex];
    if (mark) {
      mark.classList.add('current');
      mark.scrollIntoView({ block: 'center' });
      syncEditorToDocFindMatch(mark);
    }
    updateFindCountUI();
  }

  function runDocFind() {
    clearDocFindHighlights();
    docFindMatches = [];
    docFindIndex = -1;
    const query = el.findInput.value;
    if (!query) {
      updateFindCountUI();
      return;
    }
    docFindMatches = highlightDocFindMatches(query);
    if (docFindMatches.length) gotoDocFindMatch(0);
    else updateFindCountUI();
  }

  function stepDocFind(delta) {
    if (!docFindMatches.length) {
      runDocFind();
      return;
    }
    gotoDocFindMatch((docFindIndex + delta + docFindMatches.length) % docFindMatches.length);
  }

  function openFindBar() {
    el.findBar.classList.remove('hidden');
    el.findInput.focus();
    el.findInput.select();
    if (el.findInput.value) runDocFind();
  }

  function closeFindBar() {
    el.findBar.classList.add('hidden');
    clearDocFindHighlights();
    docFindMatches = [];
    docFindIndex = -1;
    updateFindCountUI();
  }

  el.findInput.addEventListener('input', runDocFind);
  el.findInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      stepDocFind(e.shiftKey ? -1 : 1);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      closeFindBar();
    }
  });
  el.findPrev.addEventListener('click', () => stepDocFind(-1));
  el.findNext.addEventListener('click', () => stepDocFind(1));
  el.findClose.addEventListener('click', closeFindBar);

  window.mdviewer.onMenuToggleFind(openFindBar);

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
      let type = 'internal-file';
      if (/\.(md|markdown)$/i.test(absPath)) type = 'internal-doc';
      else if (/\.puml$/i.test(absPath)) type = 'internal-puml';
      else if (/\.json$/i.test(absPath)) type = 'internal-json';
      else if (isPlainTextPath(absPath)) type = 'internal-text';
      return { type, absPath, hash: hash || '', key: internal };
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
    'internal-puml': '📐',
    'internal-json': '🗂',
    'internal-text': '📃',
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
          openExternalSafe(info.href);
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

  window.mdviewer.onOpenFolderFromOS((folderPath) => {
    openFolder(folderPath);
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
    await loadCustomExtensions();
    initPreviewFrame();
    showWelcomeScreen();
    updateCssAppliedBadge();
  })();
})();
