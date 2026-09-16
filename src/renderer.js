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
    // Custom back-navigation (see navigateBack): docHistoryStack holds the
    // documents visited before the current one; scrollJumpStack holds
    // pre-jump scroll offsets for same-document anchor jumps (TOC/§-ref/
    // in-page links) made within the *current* document. Back pops the
    // scroll stack first, and only falls back to switching documents once
    // it's empty.
    docHistoryStack: [],
    scrollJumpStack: [],
    navigatingBack: false,
    customTextExtensions: [],
    activeRequestId: null,
    baseCss: '',
    hljsCss: '',
    cssRefExpanded: false,
    previewZoom: 100,
    // Fullscreen document view (see enterDocFullscreen) — deliberately not
    // part of the saved project state: it's a way to read right now, not a
    // layout the project should reopen in.
    docFullscreen: false,
    // Set while the viewer is showing a file that was dropped on it rather
    // than opened from the project tree — see instantViewDropped().
    instantViewPath: null,
  };

  // Set just before a loadAndRender* call to mark the document it is about
  // to open as an instant view; beginDocumentNavigation consumes it. Lives
  // here, next to `state`, because that consumer is defined well above the
  // drag-and-drop block that sets it.
  let pendingInstantViewPath = null;

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
    cssRefPanel: document.getElementById('css-ref-panel'),
    cssRefHeader: document.getElementById('css-ref-header'),
    cssRefChevron: document.getElementById('css-ref-chevron'),
    cssRefBody: document.getElementById('css-ref-body'),
    cssRefSearch: document.getElementById('css-ref-search'),
    cssRefTree: document.getElementById('css-ref-tree'),
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
    viewerDropOverlay: document.getElementById('viewer-drop-overlay'),
    treeDropHint: document.getElementById('tree-drop-hint'),
    treeDropTarget: document.getElementById('tree-drop-target'),
    instantViewBadge: document.getElementById('instant-view-badge'),
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
    btnToggleSearch: document.getElementById('btn-toggle-search'),
    searchPanel: document.getElementById('search-panel'),
    searchInput: document.getElementById('search-input'),
    searchClose: document.getElementById('search-close'),
    searchOptCase: document.getElementById('search-opt-case'),
    searchOptWord: document.getElementById('search-opt-word'),
    searchOptRegex: document.getElementById('search-opt-regex'),
    searchStatus: document.getElementById('search-status'),
    searchResults: document.getElementById('search-results'),
    tocPanel: document.getElementById('toc-panel'),
    tocPanelHeader: document.getElementById('toc-panel-header'),
    tocCollapseBtn: document.getElementById('toc-collapse-btn'),
    tocList: document.getElementById('toc-list'),
    tocLinksList: document.getElementById('toc-links-list'),
    tocSiblingsList: document.getElementById('toc-siblings-list'),
    zoomIndicator: document.getElementById('zoom-indicator'),
    appShell: document.getElementById('app-shell'),
    btnFullscreen: document.getElementById('btn-fullscreen'),
    btnExitFullscreen: document.getElementById('btn-exit-fullscreen'),
    fullscreenHint: document.getElementById('fullscreen-hint'),
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
    state.baseCss = defaultCss;
    state.hljsCss = hljsCss;
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

    // A drag that enters the window directly over the preview lands on the
    // iframe's own document, and those events don't bubble out to this one —
    // so without this the drop overlay would never come up for the most
    // natural approach angle. Once it's up it covers the frame and the rest
    // of the drag is handled out there; the enter/leave pair is counted in
    // the same dragDepth so the two documents can hand off mid-drag.
    doc.addEventListener('dragenter', (e) => {
      if (!dragHasFiles(e)) return;
      dragDepth++;
      setDropAffordance(true);
    });
    doc.addEventListener('dragleave', (e) => {
      if (!dragHasFiles(e)) return;
      dragDepth = Math.max(0, dragDepth - 1);
      if (dragDepth === 0) setDropAffordance(false);
    });
    doc.addEventListener('dragover', (e) => e.preventDefault());
    doc.addEventListener('drop', (e) => {
      e.preventDefault();
      dragDepth = 0;
      setDropAffordance(false);
    });

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
    // Ctrl+wheel zooms the whole preview. Registered after onPumlWheel so a
    // diagram under the cursor gets first refusal on the event.
    doc.addEventListener('wheel', onPreviewWheel, { passive: false });
    doc.addEventListener('keydown', onPreviewZoomKey);
    doc.addEventListener('keydown', onFullscreenEscape);
    doc.addEventListener('mousedown', onPumlPanStart);
    doc.addEventListener('mousemove', onPumlPanMove);
    doc.addEventListener('mouseup', onPumlPanEnd);
    doc.addEventListener('mouseleave', onPumlPanEnd);

    // Mouse "back" button — see the window-level listener further down for
    // why this is also bound here: the iframe is a separate browsing
    // context, so a plain `window.addEventListener` on the outer document
    // never sees mouse events that occur while the cursor is over the
    // preview.
    doc.addEventListener('mouseup', onMouseBackButton);

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


  // ---------------------------------------------------------------------
  // Preview zoom (Ctrl+wheel over the viewer, Ctrl+0 to reset)
  //
  // Scales the whole preview document via CSS zoom on its root element, so
  // text, images, tables, JSON trees and diagrams all grow together — the
  // same thing browser zoom does, but confined to the viewer so the sidebar
  // and toolbar keep their size.
  // ---------------------------------------------------------------------

  // A ladder rather than a fixed percentage step, so each notch is a similar
  // *proportional* jump at both ends of the range.
  const PREVIEW_ZOOM_STEPS = [50, 67, 75, 80, 90, 100, 110, 125, 150, 175, 200, 250, 300];
  const PREVIEW_ZOOM_MIN = PREVIEW_ZOOM_STEPS[0];
  const PREVIEW_ZOOM_MAX = PREVIEW_ZOOM_STEPS[PREVIEW_ZOOM_STEPS.length - 1];

  function normalizePreviewZoom(percent) {
    const n = Number(percent);
    if (!Number.isFinite(n)) return 100;
    return Math.max(PREVIEW_ZOOM_MIN, Math.min(PREVIEW_ZOOM_MAX, Math.round(n)));
  }

  // The next rung up or down. A current value that isn't on the ladder (an
  // older state file, say) moves to the nearest rung in that direction.
  function steppedPreviewZoom(current, direction) {
    const idx = PREVIEW_ZOOM_STEPS.indexOf(current);
    if (idx !== -1) {
      return PREVIEW_ZOOM_STEPS[Math.min(Math.max(idx + direction, 0), PREVIEW_ZOOM_STEPS.length - 1)];
    }
    if (direction > 0) {
      return PREVIEW_ZOOM_STEPS.find((z) => z > current) || PREVIEW_ZOOM_MAX;
    }
    return PREVIEW_ZOOM_STEPS.slice().reverse().find((z) => z < current) || PREVIEW_ZOOM_MIN;
  }

  function applyPreviewZoomStyle(percent) {
    const doc = el.frame.contentDocument;
    if (!doc || !doc.documentElement) return;
    // Left unset at 100% so the default path stays byte-identical to what it
    // was before zoom existed (CSS zoom creates a containing block, which can
    // subtly affect fixed/absolute positioning inside the document).
    doc.documentElement.style.zoom = percent === 100 ? '' : String(percent / 100);
  }

  function updateZoomIndicator() {
    const atDefault = state.previewZoom === 100;
    el.zoomIndicator.classList.toggle('hidden', atDefault);
    el.zoomIndicator.textContent = state.previewZoom + '%';
  }

  // Applies a zoom level without touching scroll or persisting — for
  // restoring the saved level when a project is opened.
  function restorePreviewZoom(percent) {
    state.previewZoom = normalizePreviewZoom(percent === undefined ? 100 : percent);
    applyPreviewZoomStyle(state.previewZoom);
    updateZoomIndicator();
  }

  // `anchor` is a point in the viewer's client coordinates to hold still
  // across the change — the mouse position, for a wheel zoom.
  function setPreviewZoom(percent, anchor) {
    const doc = el.frame.contentDocument;
    const win = el.frame.contentWindow;
    const next = normalizePreviewZoom(percent);
    if (!doc || !win || next === state.previewZoom) return;

    // Anchored by measurement rather than arithmetic: CSS zoom on the root
    // element also rescales the scroll offset behind our back, so predicting
    // the new offset from the old one gets it wrong. Noting where the element
    // under the cursor sits, applying the zoom, then scrolling by however far
    // it actually moved holds it still regardless.
    const anchorEl = anchor ? doc.elementFromPoint(anchor.x, anchor.y) : null;
    const beforeRect = anchorEl ? anchorEl.getBoundingClientRect() : null;

    state.previewZoom = next;
    applyPreviewZoomStyle(next);

    if (beforeRect) {
      const afterRect = anchorEl.getBoundingClientRect();
      win.scrollBy(afterRect.left - beforeRect.left, afterRect.top - beforeRect.top);
    }

    updateZoomIndicator();
    persistProjectState();
  }

  function onPreviewWheel(e) {
    if (!e.ctrlKey) return;
    // A PlantUML diagram under the cursor has its own Ctrl+wheel zoom
    // (onPumlWheel, registered first); if it took the event, leave the
    // document's own zoom alone.
    if (e.defaultPrevented) return;
    e.preventDefault();
    const direction = e.deltaY < 0 ? 1 : -1;
    setPreviewZoom(steppedPreviewZoom(state.previewZoom, direction), { x: e.clientX, y: e.clientY });
  }

  // Bound in both documents: the viewer is a separate browsing context, so
  // whichever of the two has focus needs its own listener for this to work.
  function onPreviewZoomKey(e) {
    if (!(e.ctrlKey || e.metaKey) || e.key !== '0') return;
    e.preventDefault();
    setPreviewZoom(100);
  }

  document.addEventListener('keydown', onPreviewZoomKey);
  el.zoomIndicator.addEventListener('click', () => setPreviewZoom(100));

  // ---------------------------------------------------------------------
  // Fullscreen document view (F11)
  //
  // A reading mode for the document that is already open: the window goes
  // into real OS fullscreen (menu bar included — see window:set-fullscreen
  // in main.js) and everything around the viewer is hidden for the
  // duration: tree, toolbar, CSS editor, terminal, source editor. The table
  // of contents stays, since it is the one piece of chrome that helps with
  // reading rather than competing with it.
  //
  // All of that hiding is one class on #app-shell rather than each pane's
  // own `hidden` class, so leaving the mode restores the layout exactly as
  // the user had it — and currentProjectStateSnapshot, which reads those
  // classes, keeps recording the real layout throughout.
  //
  // Anything that opens one of the panes the mode hides (edit mode, the CSS
  // editor, the terminal, project search) calls exitDocFullscreen() first —
  // a command whose whole visible effect is hidden would otherwise look like
  // it did nothing at all.
  // ---------------------------------------------------------------------

  const FULLSCREEN_HINT_MS = 2600;
  let fullscreenHintTimer = null;

  function enterDocFullscreen() {
    if (state.docFullscreen) return;
    // Nothing to show without an open document — and no tree to pick one
    // from once the chrome is gone.
    if (!state.currentFilePath) {
      el.editStatus.textContent = t('edit.selectFirst');
      return;
    }
    state.docFullscreen = true;
    el.appShell.classList.add('doc-fullscreen');
    el.btnExitFullscreen.classList.remove('hidden');
    el.fullscreenHint.classList.add('visible');
    clearTimeout(fullscreenHintTimer);
    fullscreenHintTimer = setTimeout(() => {
      el.fullscreenHint.classList.remove('visible');
    }, FULLSCREEN_HINT_MS);
    window.mdviewer.setWindowFullscreen(true);
  }

  function exitDocFullscreen() {
    if (!state.docFullscreen) return;
    state.docFullscreen = false;
    el.appShell.classList.remove('doc-fullscreen');
    el.btnExitFullscreen.classList.add('hidden');
    el.fullscreenHint.classList.remove('visible');
    clearTimeout(fullscreenHintTimer);
    window.mdviewer.setWindowFullscreen(false);
    // xterm sizes itself from the panel's pixel box, which stayed frozen at
    // display:none for as long as the mode was on.
    if (state.terminalOpen && fitAddon) fitAddon.fit();
  }

  function toggleDocFullscreen() {
    if (state.docFullscreen) exitDocFullscreen();
    else enterDocFullscreen();
  }

  // Bound in both documents (like onPreviewZoomKey) so Esc works whether
  // the focus is in the shell or inside the preview iframe. An Escape some
  // other handler already claimed — the find bar's input, say — is left to
  // it: the mode only ends once nothing else wants the key.
  function onFullscreenEscape(e) {
    if (e.key !== 'Escape' || e.defaultPrevented || !state.docFullscreen) return;
    e.preventDefault();
    // Find stays reachable in this mode, so Esc closes it first, the same
    // order it would take with the rest of the chrome on screen.
    if (!el.findBar.classList.contains('hidden')) {
      closeFindBar();
      return;
    }
    exitDocFullscreen();
  }

  document.addEventListener('keydown', onFullscreenEscape);
  el.btnFullscreen.addEventListener('click', toggleDocFullscreen);
  el.btnExitFullscreen.addEventListener('click', exitDocFullscreen);
  window.mdviewer.onMenuToggleDocumentFullscreen(toggleDocFullscreen);
  // The window can also leave fullscreen without going through
  // exitDocFullscreen (the OS window controls, a main-process reload), which
  // would otherwise strand the mode with its chrome still hidden.
  window.mdviewer.onWindowFullscreenChanged((isFullscreen) => {
    if (!isFullscreen) exitDocFullscreen();
  });

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
    } else if (href.startsWith('#') && href.length > 1) {
      // Handled manually (rather than left to the default same-doc
      // navigation) so it goes through pushScrollJumpHistory and mouse-back
      // can undo it — the default behavior would otherwise add a real
      // browsing-context history entry that Electron's own back handling
      // can pick up and get confused by once the body has since been
      // swapped out for a different document.
      e.preventDefault();
      const target = el.frame.contentDocument.getElementById(href.slice(1));
      if (target) {
        pushScrollJumpHistory();
        target.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    }
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
      if (target) {
        pushScrollJumpHistory();
        target.scrollIntoView();
      }
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
    renderCssRefTree();
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
    // The new project's tree is the whole point of opening it; don't land
    // in a chrome-less fullscreen view of the document being left behind.
    exitDocFullscreen();

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
    state.docHistoryStack = [];
    state.scrollJumpStack = [];
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
    resetProjectSearch();
    el.tree.innerHTML = '';
    buildTreeNodes(el.tree, check.items, 0);

    const stateResult = await window.mdviewer.loadProjectState(folderPath);
    const savedState = stateResult.ok ? stateResult.state : {};

    state.cssEnabled = savedState.cssEnabled !== undefined ? savedState.cssEnabled : true;
    el.cssEnabledToggle.checked = state.cssEnabled;
    state.scrollPositions = savedState.scrollPositions || {};
    restorePreviewZoom(savedState.previewZoom);
    await loadProjectCss({ silent: true });

    const cssEditorOpen = !!savedState.cssEditorOpen;
    el.cssPane.classList.toggle('hidden', !cssEditorOpen);
    el.resizerRight.classList.toggle('hidden', !cssEditorOpen);

    el.tocPanel.classList.toggle('collapsed', !!savedState.tocCollapsed);

    await window.mdviewer.addRecentProject(folderPath);
    // Lets the main process reopen this project after a reload it has to
    // do itself (a language change), so the user keeps their place.
    await window.mdviewer.setActiveProject(folderPath);
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
        window.mdviewer.showTreeContextMenu(item.path, state.rootPath);
      });

      if (item.isDir) {
        const childrenContainer = document.createElement('div');
        childrenContainer.className = 'tree-children';
        node.appendChild(childrenContainer);

        row.addEventListener('click', async () => {
          selectTreeRow(row);
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
      } else {
        // No in-app renderer for this type — a single click just selects it
        // (matching a native file explorer, since there's nothing to
        // preview), and a double-click (or Enter once selected via
        // keyboard — see the tree's keydown handler) hands it to the OS's
        // default application instead.
        row.addEventListener('click', () => selectTreeRow(row));
        row.addEventListener('dblclick', () => window.mdviewer.openPath(item.path));
      }

      container.appendChild(node);
    }
  }

  // Finds the .tree-row for an arbitrary path anywhere in the tree,
  // regardless of nesting depth. Used to refresh/reveal a specific folder
  // after creating a new file/folder in it — revealPathInTree can't be
  // reused for this since it only lazy-loads folders it hasn't already
  // loaded, and stops as soon as an ancestor isn't in the (possibly stale)
  // DOM yet.
  function findTreeRow(targetPath) {
    const targetNorm = normalizePath(targetPath);
    const rows = el.tree.querySelectorAll('.tree-row');
    for (const row of rows) {
      if (row.dataset.path && normalizePath(row.dataset.path) === targetNorm) return row;
    }
    return null;
  }

  // A row's nesting depth is however many .tree-children containers sit
  // between it and the tree root — matches the `depth` param
  // buildTreeNodes/renderTreeLevel used when that row itself was built.
  function treeRowDepth(row) {
    let depth = 0;
    let node = row.parentElement;
    while (node && node !== el.tree) {
      if (node.classList.contains('tree-children')) depth += 1;
      node = node.parentElement;
    }
    return depth;
  }

  // Re-renders a directory's children in place (expanding it first if
  // needed) — used after creating a new file/folder inside it, since the
  // existing DOM (if already loaded) has no idea the new entry exists.
  async function refreshTreeDir(dirPath) {
    if (!state.rootPath) return;
    if (normalizePath(dirPath) === normalizePath(state.rootPath)) {
      await refreshTreeRoot();
      return;
    }
    const row = findTreeRow(dirPath);
    if (!row) return;
    const childrenContainer = row.parentElement.querySelector(':scope > .tree-children');
    if (!childrenContainer) return;
    childrenContainer.classList.add('expanded');
    const caret = row.querySelector('.tree-caret');
    if (caret) caret.classList.add('expanded');
    const depth = treeRowDepth(row) + 1;
    childrenContainer.innerHTML = '';
    childrenContainer.dataset.loaded = '1';
    await renderTreeLevel(childrenContainer, dirPath, depth, 16);
  }

  // Shows an inline text input in the tree (VS Code-style "new file/folder"
  // UX) as a child of targetDir, expanding/loading targetDir first if
  // needed. Enter creates the entry via IPC and opens it (for files);
  // Escape cancels without creating anything.
  async function beginCreateTreeEntry({ targetDir, kind }) {
    if (!state.rootPath) return;

    let parentContainer;
    let depth;
    if (normalizePath(targetDir) === normalizePath(state.rootPath)) {
      parentContainer = el.tree;
      depth = 0;
    } else {
      const dirRow = findTreeRow(targetDir);
      if (!dirRow) return; // target folder isn't currently visible in the tree
      const childrenContainer = dirRow.parentElement.querySelector(':scope > .tree-children');
      if (!childrenContainer) return;
      depth = treeRowDepth(dirRow) + 1;
      if (!childrenContainer.classList.contains('expanded') || childrenContainer.dataset.loaded !== '1') {
        childrenContainer.classList.add('expanded');
        const caret = dirRow.querySelector('.tree-caret');
        if (caret) caret.classList.add('expanded');
        childrenContainer.innerHTML = '';
        childrenContainer.dataset.loaded = '1';
        await renderTreeLevel(childrenContainer, targetDir, depth, 16);
      }
      parentContainer = childrenContainer;
    }

    // Only one in-progress "new entry" row at a time.
    const stale = el.tree.querySelector('.tree-row-editing');
    if (stale) stale.closest('.tree-node').remove();

    const node = document.createElement('div');
    node.className = 'tree-node';
    const row = document.createElement('div');
    row.className = 'tree-row tree-row-editing';
    row.style.paddingLeft = 6 + depth * 16 + 'px';

    const caret = document.createElement('span');
    caret.className = 'tree-caret';
    row.appendChild(caret);

    const icon = document.createElement('span');
    icon.className = 'tree-icon';
    icon.textContent = kind === 'folder' ? '📁' : '📄';
    row.appendChild(icon);

    const input = document.createElement('input');
    input.className = 'tree-new-input';
    input.type = 'text';
    input.spellcheck = false;
    input.placeholder = kind === 'folder' ? t('tree.newFolderPlaceholder') : t('tree.newFilePlaceholder');
    row.appendChild(input);

    node.appendChild(row);
    parentContainer.prepend(node);
    input.focus();

    let settled = false;
    let submitting = false;
    const cancel = () => {
      settled = true;
      if (node.parentElement) node.remove();
    };

    input.addEventListener('keydown', async (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        cancel();
        return;
      }
      if (e.key !== 'Enter') return;
      e.preventDefault();
      if (settled || submitting) return;
      const name = input.value.trim();
      if (!name) return;

      submitting = true;
      input.classList.remove('tree-new-input-error');
      const result = kind === 'folder'
        ? await window.mdviewer.createFolder(targetDir, name)
        : await window.mdviewer.createFile(targetDir, name);
      submitting = false;

      if (!result.ok) {
        input.classList.add('tree-new-input-error');
        input.title = result.error;
        return;
      }
      settled = true;
      node.remove();
      await refreshTreeDir(targetDir);
      await revealPathInTree(result.path, { select: true });
      if (kind === 'file') {
        if (!(await guardNavigation())) return;
        await loadAndRenderByPath(result.path);
      }
    });

    input.addEventListener('blur', () => {
      // input.disabled would fire blur too, but we never disable it, so a
      // blur here always means the user clicked/tabbed away — cancel,
      // unless a submit is still in flight (rare, only for a slow fs call).
      setTimeout(() => {
        if (!settled && !submitting) cancel();
      }, 100);
    });
  }

  let selectedRow = null;
  function selectTreeRow(row) {
    if (selectedRow) selectedRow.classList.remove('selected');
    selectedRow = row;
    if (row) row.classList.add('selected');
    // Keep keyboard focus on the tree container itself (not per-row) so
    // arrow keys keep working right after any click, without adding a tab
    // stop per row.
    el.tree.focus({ preventScroll: true });
  }

  // Collapsed rows stay in the DOM (see .tree-children { display: none }),
  // so a plain query for .tree-row would let arrow navigation wander into
  // rows the user can't actually see — offsetParent is null exactly when an
  // ancestor (or the element itself) is display:none, a cheap way to filter
  // to what's currently visible without re-deriving depth/expand state.
  function getVisibleTreeRows() {
    return Array.from(el.tree.querySelectorAll('.tree-row')).filter((row) => row.offsetParent !== null);
  }

  // Arrow-key tree navigation (Up/Down move the selection, Right/Left
  // expand/collapse a folder or step into/out of it, Enter/Space activates
  // the selected row) — everything else about "what activating a row does"
  // is already implemented per-row in buildTreeNodes, so this reuses it by
  // simulating the same click/dblclick rather than duplicating that logic.
  el.tree.addEventListener('keydown', (e) => {
    if (!['ArrowDown', 'ArrowUp', 'ArrowRight', 'ArrowLeft', 'Enter', ' '].includes(e.key)) return;
    const rows = getVisibleTreeRows();
    if (!rows.length) return;
    const currentIndex = selectedRow ? rows.indexOf(selectedRow) : -1;

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      const next = rows[Math.min(currentIndex + 1, rows.length - 1)];
      selectTreeRow(next);
      next.scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      const prev = rows[Math.max(currentIndex - 1, 0)];
      selectTreeRow(prev);
      prev.scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      if (!selectedRow || !selectedRow.classList.contains('dir')) return;
      e.preventDefault();
      const childrenContainer = selectedRow.parentElement.querySelector(':scope > .tree-children');
      if (!childrenContainer) return;
      const isExpanded = childrenContainer.classList.contains('expanded');
      if (e.key === 'ArrowRight' && !isExpanded) {
        selectedRow.click();
      } else if (e.key === 'ArrowRight' && isExpanded) {
        const firstChildRow = childrenContainer.querySelector(':scope > .tree-node > .tree-row');
        if (firstChildRow) {
          selectTreeRow(firstChildRow);
          firstChildRow.scrollIntoView({ block: 'nearest' });
        }
      } else if (e.key === 'ArrowLeft' && isExpanded) {
        selectedRow.click();
      }
    } else if (e.key === 'Enter' || e.key === ' ') {
      if (!selectedRow) return;
      e.preventDefault();
      if (selectedRow.classList.contains('non-md')) {
        selectedRow.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
      } else {
        selectedRow.click();
      }
    }
  });

  function currentProjectStateSnapshot() {
    return {
      lastOpenFile: state.currentFilePath || null,
      editModeOpen: state.editMode,
      cssEnabled: state.cssEnabled,
      cssEditorOpen: !el.cssPane.classList.contains('hidden'),
      tocCollapsed: el.tocPanel.classList.contains('collapsed'),
      scrollPositions: state.scrollPositions,
      previewZoom: state.previewZoom,
    };
  }

  async function persistProjectState() {
    if (!state.rootPath) return;
    // An instant-viewed file isn't part of the project; recording it as
    // lastOpenFile would reopen an unrelated document on the next launch.
    if (state.instantViewPath) return;
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

  // Shared preamble for every loadAndRender* entry point: saves the
  // outgoing document's scroll offset (as captureScrollPosition always
  // did), and — unless this switch is itself a navigateBack() call — records
  // the outgoing document on the back-navigation stack so mouse-back can
  // return to it. Any pending same-document anchor-jump history belongs to
  // the document being left, so it's cleared here rather than carried over.
  function beginDocumentNavigation(nextFilePath) {
    // Every loadAndRender* entry point comes through here, so consuming the
    // marker in one place means a document opened any other way (tree click,
    // link, back button) clears the instant-view flag on its own.
    state.instantViewPath = pendingInstantViewPath === nextFilePath ? nextFilePath : null;
    pendingInstantViewPath = null;

    captureScrollPosition();
    if (!state.navigatingBack && state.currentFilePath && state.currentFilePath !== nextFilePath) {
      state.docHistoryStack.push(state.currentFilePath);
    }
    state.scrollJumpStack = [];
  }

  // Toggles toolbar/preview affordances that only make sense for one file
  // kind (e.g. JSON/plain-text views need the preview body's prose
  // max-width lifted so wide content (JSON columns, long log lines) has
  // room instead of being squeezed). The refresh button applies to any open
  // file, so it only depends on whether one is open at all.
  function updateFileKindUI() {
    el.instantViewBadge.classList.toggle('hidden', !state.instantViewPath);
    el.btnRefreshPuml.classList.toggle('hidden', !state.currentFilePath);
    el.btnFullscreen.classList.toggle('hidden', !state.currentFilePath);
    const isWideView = state.currentFileKind === 'json' || state.currentFileKind === 'text';
    el.frame.contentDocument.body.classList.toggle('wide-view', isWideView);
    // Reserve the path bar's space for the whole time a JSON file is open
    // (even before any node has been clicked), so clicking the first node
    // doesn't shift the layout by suddenly introducing the bar.
    el.jsonPathBar.classList.toggle('hidden', state.currentFileKind !== 'json');
  }

  // PlantUML rendering (java, spawned per-diagram — see main.js) can take a
  // few seconds for large/complex diagrams. Rendering itself runs off the
  // main process's event loop (async spawn, not spawnSync) so the app stays
  // responsive while it waits, but the preview pane still needs to show
  // *something* other than stale/blank content in the meantime. Only shown
  // if the render is still running after `delayMs`, so quick renders (the
  // common case — most files have no diagrams at all) never flash it.
  function scheduleLoadingIndicator(delayMs = 150) {
    const timer = setTimeout(() => {
      el.frame.contentDocument.body.innerHTML =
        `<div class="mdviewer-loading-state"><div class="mdviewer-spinner"></div><div>${escapeHtml(t('preview.rendering'))}</div></div>`;
    }, delayMs);
    return () => clearTimeout(timer);
  }

  // Renders (particularly PlantUML ones) are async and can take a few
  // seconds — long enough that the user may switch to a different file, or
  // this same file may get re-rendered again (edit/refresh/re-save), before
  // an earlier one finishes. Each render call gets a fresh id; starting a
  // new one cancels whatever was previously in flight (killing its
  // still-running java process(es) via main.js's render:cancel — see
  // activeRenderAborts there), and any render whose id no longer matches
  // state.activeRequestId by the time it resolves is stale and must not be
  // applied to the DOM, however it turns out (success or error).
  function beginRenderRequest() {
    if (state.activeRequestId) {
      window.mdviewer.cancelRender(state.activeRequestId);
    }
    const requestId = `req-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    state.activeRequestId = requestId;
    return requestId;
  }

  function isStaleRequest(requestId) {
    return requestId !== state.activeRequestId;
  }

  async function loadAndRenderFile(filePath) {
    beginDocumentNavigation(filePath);
    const requestId = beginRenderRequest();
    const cancelLoading = scheduleLoadingIndicator();
    const result = await window.mdviewer.renderMarkdown(filePath, requestId);
    cancelLoading();
    if (isStaleRequest(requestId)) return;
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
    beginDocumentNavigation(filePath);
    const requestId = beginRenderRequest();
    const cancelLoading = scheduleLoadingIndicator();
    const result = await window.mdviewer.renderPlantUmlFile(filePath, requestId);
    cancelLoading();
    if (isStaleRequest(requestId)) return;
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

  // Mouse-back navigation (triggered by main.js's 'app-command' handler and
  // the mouseup listeners below, for the Windows XButton1 "back" button).
  // Undoes same-document anchor jumps (TOC/§-ref/in-page links) one at a
  // time — see pushScrollJumpHistory — before falling back to switching to
  // whichever document was open right before the current one.
  async function navigateBack() {
    if (state.scrollJumpStack.length > 0) {
      const y = state.scrollJumpStack.pop();
      el.frame.contentWindow.scrollTo(0, y);
      return;
    }
    if (state.docHistoryStack.length === 0) return;
    if (!(await guardNavigation())) return;
    const prevPath = state.docHistoryStack.pop();
    state.navigatingBack = true;
    try {
      await loadAndRenderByPath(prevPath);
      await revealPathInTree(prevPath, { select: true });
    } finally {
      state.navigatingBack = false;
    }
  }

  // Records where the viewer was scrolled to before an in-document anchor
  // jump (TOC click, §-ref link, in-content "#hash" link), so navigateBack
  // can undo it. Call this immediately before performing the jump.
  function pushScrollJumpHistory() {
    const win = el.frame.contentWindow;
    if (win) state.scrollJumpStack.push(win.scrollY);
  }

  // Re-renders the current PlantUML diagram from the given source text
  // (either the live editor buffer, or freshly re-read from disk).
  async function renderPumlFromText(text) {
    const requestId = beginRenderRequest();
    const cancelLoading = scheduleLoadingIndicator();
    const result = await window.mdviewer.renderPlantUmlText(text, requestId);
    cancelLoading();
    if (isStaleRequest(requestId)) return;
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
    beginDocumentNavigation(filePath);
    beginRenderRequest(); // JSON itself renders synchronously; this just cancels/invalidates any slower request left over from before navigating here.
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
    beginDocumentNavigation(filePath);
    beginRenderRequest(); // plain text itself renders synchronously; this just cancels/invalidates any slower request left over from before navigating here.
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

  // Resizing either pane (window resize, dragging the sidebar/editor/css
  // splitters) reflows both the wrapped editor text and the rendered
  // preview without firing a 'scroll' event, so the two sides drift apart
  // until the next manual scroll. Re-anchor the editor to whatever is
  // currently at the top of the viewer once sizes settle. The viewer is
  // used as the source of truth because its data-source-line lookup is
  // based on actual layout position, unlike the editor's line-height
  // estimate which assumes unwrapped lines.
  let splitViewResizeTimer = null;
  const splitViewResizeObserver = new ResizeObserver(() => {
    if (!splitViewActive()) return;
    clearTimeout(splitViewResizeTimer);
    splitViewResizeTimer = setTimeout(() => {
      syncEditorScrollToViewer();
    }, 150);
  });
  splitViewResizeObserver.observe(el.mdSourceEditor);
  splitViewResizeObserver.observe(el.frame);

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
    exitDocFullscreen();
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
    // Each keystroke re-render cancels/invalidates whatever the previous one
    // kicked off — relevant mainly for markdown with an embedded puml fence,
    // where a still-rendering diagram from a few keystrokes ago must not
    // land after a newer one (or after the user's stopped editing this file).
    const requestId = beginRenderRequest();

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
    const result = await window.mdviewer.renderMarkdownText(el.mdSourceEditor.value, baseDir, requestId);
    if (isStaleRequest(requestId)) return;
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

  // Pasting an image (screenshot, copied from an image viewer/browser, ...)
  // saves it to disk instead of doing nothing/dumping binary data, and
  // inserts a markdown link to it. Checked synchronously via
  // clipboardData.items so plain text pastes are left completely alone —
  // preventDefault only happens once we're sure there's an image to handle.
  el.mdSourceEditor.addEventListener('paste', async (e) => {
    const items = e.clipboardData && e.clipboardData.items;
    if (!items || !state.currentFilePath) return;
    const hasImage = Array.from(items).some((item) => item.type.startsWith('image/'));
    if (!hasImage) return;
    e.preventDefault();

    const result = await window.mdviewer.savePastedImage(state.currentFilePath);
    if (!result.ok) {
      el.editStatus.textContent = t('edit.pasteImageFailed', { error: result.error });
      return;
    }

    const ta = el.mdSourceEditor;
    ta.setRangeText(`![](${result.relPath})`, ta.selectionStart, ta.selectionEnd, 'end');
    ta.dispatchEvent(new Event('input', { bubbles: true }));
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
  window.mdviewer.onMenuExportPdf(() => {
    if (state.currentFileKind === 'markdown' && state.currentFilePath) {
      window.mdviewer.exportPdf(state.currentFilePath, state.rootPath);
    }
  });

  // Mouse "back" button. main.js's 'app-command' listener catches the
  // Windows-level XButton1 command; the mouseup listeners here are a
  // fallback for whenever that command doesn't fire (e.g. some non-Windows
  // mouse/OS combinations still deliver a plain DOM button-3 mouseup). Both
  // routes converge on the same navigateBack().
  window.mdviewer.onNavBack(() => navigateBack());
  function onMouseBackButton(e) {
    if (e.button === 3) {
      e.preventDefault();
      navigateBack();
    }
  }
  window.addEventListener('mouseup', onMouseBackButton);

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
  // Project-wide document search (sidebar)
  //
  // The find bar above searches the *rendered* document; this searches the
  // raw text of every document in the open project (main process, see
  // searchProjectDocuments in main.js) and lists the hits grouped by file.
  // Activating a hit opens the document and then hands off to the find bar
  // to highlight and scroll to the matched occurrence.
  // ---------------------------------------------------------------------

  const SEARCH_DEBOUNCE_MS = 300;
  // Below this, typing doesn't auto-search — a one-character query matches
  // most of the project and the result is mostly noise. Enter still forces
  // it, for the cases where it isn't.
  const SEARCH_MIN_AUTO_CHARS = 2;

  let searchSeq = 0;
  let activeSearchId = null;
  let searchDebounceTimer = null;
  let selectedSearchRow = null;

  function searchPanelOpen() {
    return !el.searchPanel.classList.contains('hidden');
  }

  function searchOptionsFromUI() {
    return {
      caseSensitive: el.searchOptCase.classList.contains('active'),
      wholeWord: el.searchOptWord.classList.contains('active'),
      useRegex: el.searchOptRegex.classList.contains('active'),
    };
  }

  function setSearchStatus(text, isError = false) {
    el.searchStatus.textContent = text;
    el.searchStatus.classList.toggle('error', isError && !!text);
  }

  function clearSearchResults() {
    el.searchResults.innerHTML = '';
    selectedSearchRow = null;
  }

  // Tells the main process to stop walking for the in-flight search. Its
  // IPC promise still resolves, but runProjectSearch ignores any result
  // that isn't from the newest search it issued.
  function cancelActiveSearch() {
    if (!activeSearchId) return;
    window.mdviewer.cancelSearch(activeSearchId);
    activeSearchId = null;
  }

  function resetProjectSearch() {
    cancelActiveSearch();
    clearTimeout(searchDebounceTimer);
    clearSearchResults();
    setSearchStatus('');
  }

  function scheduleProjectSearch({ immediate = false } = {}) {
    clearTimeout(searchDebounceTimer);
    const query = el.searchInput.value;
    if (!query || (!immediate && query.length < SEARCH_MIN_AUTO_CHARS)) {
      cancelActiveSearch();
      clearSearchResults();
      setSearchStatus('');
      return;
    }
    if (immediate) {
      runProjectSearch();
    } else {
      searchDebounceTimer = setTimeout(runProjectSearch, SEARCH_DEBOUNCE_MS);
    }
  }

  async function runProjectSearch() {
    const query = el.searchInput.value;
    if (!query) return;
    if (!state.rootPath) {
      clearSearchResults();
      setSearchStatus(t('search.openFolderFirst'), true);
      return;
    }

    cancelActiveSearch();
    const searchId = 'search-' + ++searchSeq;
    activeSearchId = searchId;
    setSearchStatus(t('search.searching'));

    const result = await window.mdviewer.searchProject(state.rootPath, query, {
      ...searchOptionsFromUI(),
      searchId,
    });

    // Superseded by a newer search while this one was running.
    if (activeSearchId !== searchId) return;
    activeSearchId = null;

    if (!result.ok) {
      clearSearchResults();
      setSearchStatus(
        result.invalidPattern ? t('search.invalidPattern') : t('search.failed', { error: result.error }),
        true
      );
      return;
    }
    if (result.canceled) return;
    renderSearchResults(result);
  }

  // Rebuilds `container`'s children as text with the matched spans wrapped
  // in <mark>. `ranges` are index pairs into `text`, already sorted and
  // non-overlapping (see searchMatchesInContent in main.js).
  function appendHighlightedText(container, text, ranges) {
    let cursor = 0;
    for (const [start, end] of ranges) {
      if (start > cursor) container.appendChild(document.createTextNode(text.slice(cursor, start)));
      const mark = document.createElement('mark');
      mark.textContent = text.slice(start, end);
      container.appendChild(mark);
      cursor = end;
    }
    if (cursor < text.length) container.appendChild(document.createTextNode(text.slice(cursor)));
  }

  function buildSearchFileGroup(file) {
    const group = document.createElement('div');
    group.className = 'search-file';

    const row = document.createElement('div');
    row.className = 'search-file-row';
    row.title = file.path;

    const caret = document.createElement('span');
    caret.className = 'search-file-caret';
    caret.textContent = '▾';
    const name = document.createElement('span');
    name.className = 'search-file-name';
    name.textContent = file.name;
    const dir = document.createElement('span');
    dir.className = 'search-file-dir';
    dir.textContent = file.relDir ? file.relDir.replace(/\\/g, '/') : '';
    const count = document.createElement('span');
    count.className = 'search-file-count';
    count.textContent = String(file.matchCount);
    row.append(caret, name, dir, count);

    const matchesEl = document.createElement('div');
    matchesEl.className = 'search-file-matches';

    row.addEventListener('click', () => {
      const collapsed = matchesEl.classList.toggle('collapsed');
      caret.classList.toggle('collapsed', collapsed);
    });

    for (const match of file.matches) {
      const matchRow = document.createElement('div');
      matchRow.className = 'search-match';
      matchRow.title = file.name + ':' + (match.line + 1);

      const lineNo = document.createElement('span');
      lineNo.className = 'search-match-line';
      lineNo.textContent = String(match.line + 1);
      const text = document.createElement('span');
      text.className = 'search-match-text';
      appendHighlightedText(text, match.text, match.ranges);
      matchRow.append(lineNo, text);

      matchRow.addEventListener('click', () => openSearchMatch(file, match, matchRow));
      matchesEl.appendChild(matchRow);
    }

    if (file.truncated) {
      const more = document.createElement('div');
      more.className = 'search-file-truncated';
      more.textContent = t('search.fileTruncated', { count: file.matchCount });
      matchesEl.appendChild(more);
    }

    group.append(row, matchesEl);
    return group;
  }

  function renderSearchResults(result) {
    clearSearchResults();

    if (!result.files.length) {
      setSearchStatus(t('search.noResults'));
      return;
    }
    setSearchStatus(
      t(result.truncated ? 'search.summaryTruncated' : 'search.summary', {
        matches: result.totalMatches,
        files: result.files.length,
      })
    );

    const frag = document.createDocumentFragment();
    for (const file of result.files) frag.appendChild(buildSearchFileGroup(file));
    el.searchResults.appendChild(frag);
  }

  function visibleSearchMatchRows() {
    // Rows inside a collapsed file group stay in the DOM but have no
    // offsetParent, the same trick getVisibleTreeRows uses.
    return Array.from(el.searchResults.querySelectorAll('.search-match')).filter(
      (row) => row.offsetParent !== null
    );
  }

  function selectSearchRow(row) {
    if (selectedSearchRow) selectedSearchRow.classList.remove('selected');
    selectedSearchRow = row || null;
    if (row) {
      row.classList.add('selected');
      row.scrollIntoView({ block: 'nearest' });
    }
  }

  function stepSearchSelection(delta) {
    const rows = visibleSearchMatchRows();
    if (!rows.length) return;
    const current = selectedSearchRow ? rows.indexOf(selectedSearchRow) : -1;
    if (current === -1) {
      selectSearchRow(delta > 0 ? rows[0] : rows[rows.length - 1]);
      return;
    }
    selectSearchRow(rows[Math.min(Math.max(current + delta, 0), rows.length - 1)]);
  }

  // Which of the find bar's in-document hits corresponds to the result row
  // the user activated. Markdown/PlantUML renders carry data-source-line
  // markers, so the hit can be matched up by source line; JSON and plain
  // text don't, so those fall back to the match's ordinal position within
  // the file (exact for plain text, approximate for JSON).
  function docFindIndexForSearchMatch(match) {
    if (!docFindMatches.length) return -1;
    let bestIndex = -1;
    let bestDistance = Infinity;
    docFindMatches.forEach((mark, i) => {
      const block = mark.closest('[data-source-line]');
      if (!block) return;
      const start = parseInt(block.getAttribute('data-source-line'), 10);
      if (Number.isNaN(start)) return;
      const distance = Math.abs(start - match.line);
      if (distance < bestDistance) {
        bestDistance = distance;
        bestIndex = i;
      }
    });
    if (bestIndex !== -1) return bestIndex;
    return Math.min(match.ordinal, docFindMatches.length - 1);
  }

  // Highlights the matched text throughout the now-open document via the
  // find bar and scrolls to the specific occurrence that was clicked. The
  // literal comes from the match itself rather than the query box so that
  // regex searches land on real text too.
  function jumpToSearchMatchInDocument(match) {
    const literal = match.text.slice(match.ranges[0][0], match.ranges[0][1]);
    if (!literal) return;

    el.findBar.classList.remove('hidden');
    el.findInput.value = literal;
    runDocFind();

    const index = docFindIndexForSearchMatch(match);
    if (index !== -1) {
      gotoDocFindMatch(index);
      return;
    }
    // Nothing matched in the rendered output — the hit is in source-only
    // text (a link URL, a fence marker, front matter). Scroll to the block
    // that line belongs to so the user still lands in the right place.
    const block = findViewerElementForLine(match.line);
    if (block) block.scrollIntoView({ block: 'center' });
  }

  async function openSearchMatch(file, match, rowEl) {
    const alreadyOpen =
      state.currentFilePath && normalizePath(state.currentFilePath) === normalizePath(file.path);

    if (!alreadyOpen) {
      if (!(await guardNavigation())) return;
      await loadAndRenderByPath(file.path);
      await revealPathInTree(file.path, { select: true });
      // revealPathInTree focuses the tree when it selects a row; the search
      // box needs to keep the caret so the user can keep typing/arrowing.
      if (searchPanelOpen()) el.searchInput.focus({ preventScroll: true });
    }

    selectSearchRow(rowEl);
    jumpToSearchMatchInDocument(match);
  }

  function openSearchPanel() {
    exitDocFullscreen();
    el.searchPanel.classList.remove('hidden');
    el.tree.classList.add('hidden');
    el.btnToggleSearch.classList.add('active');
    el.searchInput.focus();
    el.searchInput.select();
    if (!state.rootPath) setSearchStatus(t('search.openFolderFirst'), true);
  }

  function closeSearchPanel() {
    cancelActiveSearch();
    clearTimeout(searchDebounceTimer);
    el.searchPanel.classList.add('hidden');
    el.tree.classList.remove('hidden');
    el.btnToggleSearch.classList.remove('active');
    el.tree.focus({ preventScroll: true });
  }

  function toggleSearchPanel() {
    if (searchPanelOpen()) closeSearchPanel();
    else openSearchPanel();
  }

  function toggleSearchOption(button) {
    button.classList.toggle('active');
    scheduleProjectSearch({ immediate: true });
  }

  el.btnToggleSearch.addEventListener('click', toggleSearchPanel);
  el.searchClose.addEventListener('click', closeSearchPanel);
  el.searchOptCase.addEventListener('click', () => toggleSearchOption(el.searchOptCase));
  el.searchOptWord.addEventListener('click', () => toggleSearchOption(el.searchOptWord));
  el.searchOptRegex.addEventListener('click', () => toggleSearchOption(el.searchOptRegex));

  el.searchInput.addEventListener('input', () => {
    selectSearchRow(null);
    scheduleProjectSearch();
  });

  el.searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      stepSearchSelection(e.key === 'ArrowDown' ? 1 : -1);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      // Once a result is picked, Enter opens it; before that it's the
      // "search now" key (which also covers queries too short to auto-run).
      if (selectedSearchRow) selectedSearchRow.click();
      else scheduleProjectSearch({ immediate: true });
    } else if (e.key === 'Escape') {
      e.preventDefault();
      closeSearchPanel();
    }
  });

  window.mdviewer.onMenuSearchProject(openSearchPanel);

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

  // Headings nest by level, so folding one hides every deeper heading that
  // follows it until the next heading at the same or a shallower level.
  // Folds are kept per document path, so a re-render (file watch, edit-mode
  // toggle) or a trip to another document and back doesn't reset them.
  const tocCollapsedByPath = new Map();
  // Structure of the TOC currently on screen, so toggling a caret can redraw
  // the list without re-walking the rendered document.
  let tocEntries = [];

  function tocCollapsedSet() {
    const key = state.currentFilePath ? normalizePath(state.currentFilePath) : '';
    let set = tocCollapsedByPath.get(key);
    if (!set) {
      set = new Set();
      tocCollapsedByPath.set(key, set);
    }
    return set;
  }

  // Hidden when ANY enclosing heading is folded, not just the immediate
  // parent — otherwise a deep item would reappear under a collapsed ancestor
  // whose own child happened to be left expanded.
  function tocEntryHidden(entry, collapsed) {
    for (let p = entry.parent; p !== -1; p = tocEntries[p].parent) {
      if (collapsed.has(tocEntries[p].id)) return true;
    }
    return false;
  }

  // Folding only changes which rows are showing, so the rows themselves are
  // reused rather than rebuilt — that keeps the caret's rotate transition
  // alive and holds the list's scroll position steady.
  function applyTocVisibility() {
    const collapsed = tocCollapsedSet();
    tocEntries.forEach((entry) => {
      if (entry.li) entry.li.classList.toggle('hidden', tocEntryHidden(entry, collapsed));
    });
  }

  function renderTocList() {
    el.tocList.innerHTML = '';
    const collapsed = tocCollapsedSet();

    tocEntries.forEach((entry) => {
      const li = document.createElement('li');
      entry.li = li;
      li.className = 'toc-item toc-item-node';
      li.style.paddingLeft = 6 + (entry.level - 1) * 12 + 'px';

      const caret = document.createElement('span');
      caret.className = 'toc-caret';
      if (entry.hasChildren) {
        caret.textContent = '▶';
        caret.classList.toggle('expanded', !collapsed.has(entry.id));
        caret.title = t('toc.itemToggleTitle');
        caret.addEventListener('click', (e) => {
          // The caret folds; the rest of the row still jumps to the heading.
          e.stopPropagation();
          const nowCollapsed = !collapsed.has(entry.id);
          if (nowCollapsed) collapsed.add(entry.id);
          else collapsed.delete(entry.id);
          caret.classList.toggle('expanded', !nowCollapsed);
          applyTocVisibility();
        });
      } else {
        caret.classList.add('toc-caret-leaf');
      }
      li.appendChild(caret);

      const label = document.createElement('span');
      label.className = 'toc-label';
      label.textContent = entry.text;
      li.appendChild(label);

      li.title = entry.text;
      li.addEventListener('click', () => {
        pushScrollJumpHistory();
        entry.heading.scrollIntoView({ behavior: 'smooth', block: 'start' });
        if (entry.sourceLine !== undefined) scrollSourceToLine(entry.sourceLine);
      });
      el.tocList.appendChild(li);
    });

    applyTocVisibility();
  }

  function populateToc() {
    el.tocList.innerHTML = '';
    tocEntries = [];
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

      tocEntries.push({
        heading,
        id: heading.id,
        text: heading.textContent,
        level: Number(heading.tagName[1]),
        sourceLine: sourceLines ? sourceLines[index] : undefined,
        parent: -1,
        hasChildren: false,
      });
    });

    // Levels can skip (an h1 followed by an h3), so the enclosing heading is
    // whatever is still open at a shallower level rather than exactly
    // level - 1.
    const openStack = [];
    tocEntries.forEach((entry, i) => {
      while (openStack.length && tocEntries[openStack[openStack.length - 1]].level >= entry.level) {
        openStack.pop();
      }
      if (openStack.length) {
        entry.parent = openStack[openStack.length - 1];
        tocEntries[entry.parent].hasChildren = true;
      }
      openStack.push(i);
    });

    // A heading that's gone from the document shouldn't keep its fold alive:
    // a later edit could hand the same id to an unrelated section.
    const collapsed = tocCollapsedSet();
    const liveIds = new Set(tocEntries.map((entry) => entry.id));
    for (const id of collapsed) {
      if (!liveIds.has(id)) collapsed.delete(id);
    }

    renderTocList();
    linkifySectionRefs(headings);
  }

  // In-document reference convention — two forms, both turned into a link
  // to the referenced heading so clicking scrolls straight to it:
  //   §/섹션명/   — matched against a heading's full text (e.g. "§/설치 방법/")
  //   §2.1        — matched against a heading's leading number (e.g. a
  //                 heading rendered as "### 2.1 새 로그 종류: ...")
  // Runs after the heading id-assignment loop above so every candidate
  // target already has an id to link to.
  const SECTION_REF_TEST_RE = /§(?:\/[^/\n]+\/|\d+(?:\.\d+)*)/;
  const SECTION_REF_RE = /§(?:\/([^/\n]+)\/|(\d+(?:\.\d+)*))/g;
  const HEADING_NUMBER_RE = /^(\d+(?:\.\d+)*)\.?(?=\s|$)/;

  function linkifySectionRefs(headings) {
    const byExactText = new Map();
    const bySlug = new Map();
    const byNumber = new Map();
    headings.forEach((heading) => {
      const text = heading.textContent.trim();
      if (!byExactText.has(text)) byExactText.set(text, heading.id);
      const slug = slugify(text);
      if (slug && !bySlug.has(slug)) bySlug.set(slug, heading.id);
      const numberMatch = HEADING_NUMBER_RE.exec(text);
      if (numberMatch && !byNumber.has(numberMatch[1])) byNumber.set(numberMatch[1], heading.id);
    });

    const doc = el.frame.contentDocument;
    const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (!SECTION_REF_TEST_RE.test(node.nodeValue)) return NodeFilter.FILTER_REJECT;
        return node.parentElement.closest('a, code, pre, script, style')
          ? NodeFilter.FILTER_REJECT
          : NodeFilter.FILTER_ACCEPT;
      },
    });
    const textNodes = [];
    let node;
    while ((node = walker.nextNode())) textNodes.push(node);

    textNodes.forEach((textNode) => {
      const text = textNode.nodeValue;
      SECTION_REF_RE.lastIndex = 0;
      let match;
      let lastIndex = 0;
      let changed = false;
      const frag = doc.createDocumentFragment();
      while ((match = SECTION_REF_RE.exec(text))) {
        const [sectionName, number] = [match[1], match[2]];
        const targetId = number
          ? byNumber.get(number)
          : byExactText.get(sectionName.trim()) || bySlug.get(slugify(sectionName.trim()));
        if (!targetId) continue;
        frag.appendChild(doc.createTextNode(text.slice(lastIndex, match.index)));
        const a = doc.createElement('a');
        a.href = '#' + targetId;
        a.className = 'section-ref-link';
        a.textContent = match[0];
        frag.appendChild(a);
        lastIndex = match.index + match[0].length;
        changed = true;
      }
      if (!changed) return;
      frag.appendChild(doc.createTextNode(text.slice(lastIndex)));
      textNode.parentNode.replaceChild(frag, textNode);
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
          if (target) {
            pushScrollJumpHistory();
            target.scrollIntoView({ behavior: 'smooth', block: 'start' });
          }
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
  // CSS reference tree — browsable, editable list of every selector the
  // preview's base stylesheet (and the active code-highlight theme) define,
  // since there's no other way to discover what's customizable. Editing a
  // value here writes an override into a dedicated, clearly-delimited block
  // at the end of the custom CSS textarea (CSS_REF_BLOCK_START/END below),
  // rather than touching anywhere else in it — the user's own hand-written
  // CSS is never rewritten or reformatted.
  // ---------------------------------------------------------------------

  // Not a general CSS parser — just enough to read our own hand-written
  // stylesheets (flat rules, one level of @media nesting, no @supports/
  // CSS-in-JS edge cases), which is all this ever needs to handle.
  function findMatchingBrace(source, openIdx) {
    let depth = 0;
    for (let i = openIdx; i < source.length; i++) {
      if (source[i] === '{') depth++;
      else if (source[i] === '}') {
        depth--;
        if (depth === 0) return i;
      }
    }
    return source.length - 1;
  }

  function parseCssRules(cssText) {
    const rules = [];
    const text = (cssText || '').replace(/\/\*[\s\S]*?\*\//g, '');

    function parseBlock(source, media) {
      let pos = 0;
      while (pos < source.length) {
        const braceIdx = source.indexOf('{', pos);
        if (braceIdx === -1) break;
        const selectorPart = source.slice(pos, braceIdx).trim();
        if (!selectorPart) {
          pos = braceIdx + 1;
          continue;
        }
        if (/^@media/.test(selectorPart)) {
          const end = findMatchingBrace(source, braceIdx);
          parseBlock(source.slice(braceIdx + 1, end), selectorPart);
          pos = end + 1;
          continue;
        }
        if (/^@(keyframes|font-face|supports|import)/.test(selectorPart)) {
          pos = findMatchingBrace(source, braceIdx) + 1;
          continue;
        }
        const end = source.indexOf('}', braceIdx);
        if (end === -1) break;
        const declarations = source
          .slice(braceIdx + 1, end)
          .split(';')
          .map((d) => d.trim())
          .filter(Boolean)
          .map((d) => {
            const idx = d.indexOf(':');
            if (idx === -1) return null;
            return { prop: d.slice(0, idx).trim(), value: d.slice(idx + 1).trim() };
          })
          .filter(Boolean);
        if (declarations.length) rules.push({ selector: selectorPart, media: media || null, declarations });
        pos = end + 1;
      }
    }
    parseBlock(text, null);
    return rules;
  }

  function deriveCssRefCategory(selector) {
    const first = selector.split(',')[0].trim();
    if (/\.hljs-/.test(first)) return t('cssRef.categoryHighlight');
    if (/^:root/.test(first) || first === '*' || /^html\b/.test(first)) return t('cssRef.categoryBase');
    const stripped = first.replace(/^body\.markdown-body\.?/, '').replace(/^\.markdown-body\.?/, '').trim();
    const token = (stripped || first)
      .replace(/^\./, '')
      .split(/[\s.>:#[]+/)
      .filter(Boolean)[0];
    return token || first;
  }

  const CSS_REF_BLOCK_START = '/* mdviewer:ref-editor:start */';
  const CSS_REF_BLOCK_END = '/* mdviewer:ref-editor:end */';

  function splitCssRefBlock(customCssText) {
    const startIdx = customCssText.indexOf(CSS_REF_BLOCK_START);
    const endIdx = customCssText.indexOf(CSS_REF_BLOCK_END);
    if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) {
      return { before: customCssText, after: '' };
    }
    return {
      before: customCssText.slice(0, startIdx),
      after: customCssText.slice(endIdx + CSS_REF_BLOCK_END.length),
    };
  }

  // selector -> Map(prop -> value), read from the managed block only (never
  // from the user's own rules elsewhere in the textarea).
  function getCssRefOverrides() {
    const { before, after } = splitCssRefBlock(el.cssEditor.value);
    const full = el.cssEditor.value;
    const blockText = full.slice(before.length, full.length - after.length);
    const rules = parseCssRules(blockText);
    const map = new Map();
    for (const rule of rules) {
      if (!map.has(rule.selector)) map.set(rule.selector, new Map());
      const propMap = map.get(rule.selector);
      for (const d of rule.declarations) propMap.set(d.prop, d.value);
    }
    return map;
  }

  function writeCssRefOverrides(overrides) {
    const { before, after } = splitCssRefBlock(el.cssEditor.value);
    if (overrides.size === 0) {
      el.cssEditor.value = (before + after).replace(/\n{3,}/g, '\n\n');
    } else {
      const ruleTexts = [];
      for (const [selector, propMap] of overrides) {
        const decls = Array.from(propMap.entries())
          .map(([prop, value]) => `  ${prop}: ${value};`)
          .join('\n');
        ruleTexts.push(`${selector} {\n${decls}\n}`);
      }
      const block =
        `${CSS_REF_BLOCK_START}\n` +
        `/* ${t('cssRef.editHint')} */\n` +
        `${ruleTexts.join('\n\n')}\n` +
        `${CSS_REF_BLOCK_END}\n`;
      el.cssEditor.value = before.replace(/\n*$/, before ? '\n\n' : '') + block + after;
    }
    applyLiveCss();
    state.cssDirty = true;
    el.cssStatus.textContent = t('css.unsavedChanges');
  }

  function setCssRefOverride(selector, prop, value) {
    const overrides = getCssRefOverrides();
    if (!overrides.has(selector)) overrides.set(selector, new Map());
    overrides.get(selector).set(prop, value);
    writeCssRefOverrides(overrides);
  }

  function clearCssRefOverride(selector, prop) {
    const overrides = getCssRefOverrides();
    const propMap = overrides.get(selector);
    if (propMap) {
      propMap.delete(prop);
      if (propMap.size === 0) overrides.delete(selector);
    }
    writeCssRefOverrides(overrides);
  }

  function beginEditCssRefValue(valueSpan, selector, prop, currentValue) {
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'css-ref-value-input';
    input.value = currentValue;
    input.spellcheck = false;
    valueSpan.replaceWith(input);
    input.focus();
    input.select();

    let settled = false;
    const commit = () => {
      if (settled) return;
      settled = true;
      const newValue = input.value.trim();
      if (newValue && newValue !== currentValue) setCssRefOverride(selector, prop, newValue);
      else renderCssRefTree();
    };
    const cancel = () => {
      if (settled) return;
      settled = true;
      renderCssRefTree();
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        commit();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        cancel();
      }
    });
    input.addEventListener('blur', commit);
  }

  // Remembers which categories/rules are expanded across re-renders (every
  // edit/reset rebuilds the whole tree from scratch) — otherwise committing
  // an edit would collapse everything the user had just navigated into.
  const cssRefExpandState = { categories: new Set(), rules: new Set() };
  function ruleExpandKey(rule) {
    return `${rule.selector}|${rule.media || ''}`;
  }

  function renderCssRefTree() {
    if (!state.cssRefExpanded) return;
    const baseRules = parseCssRules(state.baseCss);
    const hljsRules = parseCssRules(state.hljsCss);
    const overrides = getCssRefOverrides();

    const categories = new Map();
    for (const rule of [...baseRules, ...hljsRules]) {
      const cat = deriveCssRefCategory(rule.selector);
      if (!categories.has(cat)) categories.set(cat, []);
      categories.get(cat).push(rule);
    }

    const filter = el.cssRefSearch.value.trim().toLowerCase();
    el.cssRefTree.innerHTML = '';

    const sortedCats = Array.from(categories.keys()).sort((a, b) => a.localeCompare(b));
    for (const cat of sortedCats) {
      const rules = categories.get(cat);
      const matchingRules = filter
        ? rules.filter(
            (r) =>
              r.selector.toLowerCase().includes(filter) ||
              r.declarations.some((d) => d.prop.toLowerCase().includes(filter))
          )
        : rules;
      if (filter && matchingRules.length === 0) continue;

      const catNode = document.createElement('div');
      const catRow = document.createElement('div');
      catRow.className = 'css-ref-row css-ref-category';
      const catCaret = document.createElement('span');
      catCaret.className = 'css-ref-caret';
      const catLabel = document.createElement('span');
      catLabel.className = 'css-ref-label';
      catLabel.textContent = `${cat} (${matchingRules.length})`;
      catRow.append(catCaret, catLabel);
      catNode.appendChild(catRow);

      const catChildren = document.createElement('div');
      catChildren.className = 'css-ref-children';
      if (filter || cssRefExpandState.categories.has(cat)) {
        catChildren.classList.add('expanded');
        catCaret.classList.add('expanded');
      }
      catNode.appendChild(catChildren);
      catRow.addEventListener('click', () => {
        const expanded = catChildren.classList.toggle('expanded');
        catCaret.classList.toggle('expanded', expanded);
        if (expanded) cssRefExpandState.categories.add(cat);
        else cssRefExpandState.categories.delete(cat);
      });

      for (const rule of matchingRules) {
        const ruleNode = document.createElement('div');
        const ruleRow = document.createElement('div');
        ruleRow.className = 'css-ref-row css-ref-rule';
        const ruleCaret = document.createElement('span');
        ruleCaret.className = 'css-ref-caret';
        const ruleLabel = document.createElement('span');
        ruleLabel.className = 'css-ref-label css-ref-selector';
        ruleLabel.textContent = rule.selector + (rule.media ? (rule.media.includes('light') ? ' ☀' : ' 🌙') : '');
        ruleLabel.title = rule.selector + (rule.media ? ` — ${rule.media}` : '');
        const copyBtn = document.createElement('button');
        copyBtn.type = 'button';
        copyBtn.className = 'css-ref-copy-btn';
        copyBtn.textContent = '⧉';
        copyBtn.title = t('cssRef.copySelector');
        copyBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          window.mdviewer.clipboardWriteText(rule.selector);
        });
        ruleRow.append(ruleCaret, ruleLabel, copyBtn);
        ruleNode.appendChild(ruleRow);

        const ruleKey = ruleExpandKey(rule);
        const ruleChildren = document.createElement('div');
        ruleChildren.className = 'css-ref-children';
        if (filter || cssRefExpandState.rules.has(ruleKey)) {
          ruleChildren.classList.add('expanded');
          ruleCaret.classList.add('expanded');
        }
        ruleNode.appendChild(ruleChildren);
        ruleRow.addEventListener('click', () => {
          const expanded = ruleChildren.classList.toggle('expanded');
          ruleCaret.classList.toggle('expanded', expanded);
          if (expanded) cssRefExpandState.rules.add(ruleKey);
          else cssRefExpandState.rules.delete(ruleKey);
        });

        const overrideMap = overrides.get(rule.selector);
        for (const decl of rule.declarations) {
          const leafRow = document.createElement('div');
          leafRow.className = 'css-ref-row css-ref-leaf';
          const isOverridden = !!(overrideMap && overrideMap.has(decl.prop));
          const effectiveValue = isOverridden ? overrideMap.get(decl.prop) : decl.value;

          const propSpan = document.createElement('span');
          propSpan.className = 'css-ref-prop';
          propSpan.textContent = decl.prop + ':';

          const valueSpan = document.createElement('span');
          valueSpan.className = 'css-ref-value' + (isOverridden ? ' css-ref-value-overridden' : '');
          valueSpan.textContent = effectiveValue;
          valueSpan.title = t('cssRef.editHint');
          valueSpan.addEventListener('dblclick', () => {
            beginEditCssRefValue(valueSpan, rule.selector, decl.prop, effectiveValue);
          });

          leafRow.append(propSpan, valueSpan);

          if (isOverridden) {
            const resetBtn = document.createElement('button');
            resetBtn.type = 'button';
            resetBtn.className = 'css-ref-reset-btn';
            resetBtn.textContent = '↺';
            resetBtn.title = t('cssRef.resetToDefault');
            resetBtn.addEventListener('click', (e) => {
              e.stopPropagation();
              clearCssRefOverride(rule.selector, decl.prop);
            });
            leafRow.appendChild(resetBtn);
          }

          ruleChildren.appendChild(leafRow);
        }

        catChildren.appendChild(ruleNode);
      }

      el.cssRefTree.appendChild(catNode);
    }
  }

  el.cssRefHeader.addEventListener('click', () => {
    state.cssRefExpanded = !state.cssRefExpanded;
    el.cssRefBody.classList.toggle('hidden', !state.cssRefExpanded);
    el.cssRefChevron.classList.toggle('expanded', state.cssRefExpanded);
    if (state.cssRefExpanded) renderCssRefTree();
  });
  el.cssRefHeader.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      el.cssRefHeader.click();
    }
  });
  el.cssRefSearch.addEventListener('input', renderCssRefTree);

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
    if (!hidden) exitDocFullscreen();
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

  // Right-clicking empty tree space (not any specific row) creates new
  // files/folders at the project root — row-level contextmenu handlers
  // (see buildTreeNodes) don't call stopPropagation, so this only fires
  // when the click didn't land on a row.
  el.tree.addEventListener('contextmenu', (e) => {
    if (e.target.closest('.tree-row')) return;
    e.preventDefault();
    if (!state.rootPath) return;
    window.mdviewer.showTreeContextMenu(state.rootPath, state.rootPath);
  });

  window.mdviewer.onTreeCreateNew(({ targetDir, kind }) => {
    beginCreateTreeEntry({ targetDir, kind });
  });

  window.mdviewer.onTreeRefreshDir(({ targetDir }) => {
    refreshTreeDir(targetDir);
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
  // Drag and drop
  // ---------------------------------------------------------------------
  //
  // Two drop zones with deliberately different meanings:
  //   the tree   -> copy the dropped files/folders into the project
  //   the viewer -> show the dropped document right now, without copying
  //
  // The tree is ordinary DOM in this document, so it takes drop events
  // directly and can report which folder row the pointer is over. The
  // preview is an <iframe>, which swallows drag events before they reach
  // this document, so a drop target is laid over it for the duration of the
  // drag instead.

  let dragDepth = 0;
  let treeDropRow = null;

  function dragHasFiles(e) {
    const types = e.dataTransfer && e.dataTransfer.types;
    return !!types && Array.prototype.includes.call(types, 'Files');
  }

  // Must run synchronously inside the drop handler — dataTransfer is emptied
  // once the event returns, so the paths cannot be read after an await.
  function droppedPaths(e) {
    const files = (e.dataTransfer && e.dataTransfer.files) || [];
    const paths = [];
    for (const file of files) {
      const filePath = window.mdviewer.getPathForFile(file);
      if (filePath) paths.push(filePath);
    }
    return paths;
  }

  function isViewablePath(filePath) {
    return /\.(md|markdown|puml|json)$/i.test(filePath) || isPlainTextPath(filePath);
  }

  function isInsideProject(filePath) {
    if (!state.rootPath) return false;
    const root = normalizePath(state.rootPath);
    const target = normalizePath(filePath);
    return target === root || target.startsWith(root + '/');
  }

  // Drop feedback reuses the toolbar status slot, the same place save and
  // paste results are reported.
  function setDropStatus(message) {
    el.editStatus.textContent = message;
  }

  function setTreeDropRow(row) {
    if (treeDropRow === row) return;
    if (treeDropRow) treeDropRow.classList.remove('drop-target');
    treeDropRow = row;
    if (treeDropRow) treeDropRow.classList.add('drop-target');
  }

  function setDropAffordance(active) {
    const canCopy = active && !!state.rootPath;
    el.viewerDropOverlay.classList.toggle('hidden', !active);
    el.tree.classList.toggle('drop-active', canCopy);
    el.treeDropHint.classList.toggle('hidden', !canCopy);
    if (!active) setTreeDropRow(null);
  }

  // Which folder a drop on the tree copies into: the folder row under the
  // pointer, the containing folder for a file row, and the project root for
  // empty space below the rows.
  function treeDropTargetDir(e) {
    const row = e.target.closest && e.target.closest('.tree-row');
    if (!row || !row.dataset.path) return state.rootPath;
    if (row.classList.contains('dir')) return row.dataset.path;
    return dirnameOf(row.dataset.path);
  }

  // dragenter/dragleave fire per element as the pointer crosses children, so
  // the pair is counted rather than trusted individually — otherwise moving
  // over a nested row would read as having left the window.
  window.addEventListener('dragenter', (e) => {
    if (!dragHasFiles(e)) return;
    dragDepth++;
    setDropAffordance(true);
  });

  window.addEventListener('dragleave', (e) => {
    if (!dragHasFiles(e)) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) setDropAffordance(false);
  });

  window.addEventListener('dragend', () => {
    dragDepth = 0;
    setDropAffordance(false);
  });

  // Without these the window would navigate away to the dropped file, which
  // replaces the whole app UI with it.
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    dragDepth = 0;
    setDropAffordance(false);
  });

  el.tree.addEventListener('dragover', (e) => {
    if (!dragHasFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = state.rootPath ? 'copy' : 'none';
    if (!state.rootPath) return;
    const row = e.target.closest('.tree-row');
    setTreeDropRow(row && row.classList.contains('dir') ? row : null);
    const targetDir = treeDropTargetDir(e);
    el.treeDropTarget.textContent = targetDir ? pathBasename(targetDir) || targetDir : '';
  });

  el.tree.addEventListener('drop', async (e) => {
    if (!dragHasFiles(e)) return;
    e.preventDefault();
    e.stopPropagation();
    const targetDir = treeDropTargetDir(e);
    const paths = droppedPaths(e);
    dragDepth = 0;
    setDropAffordance(false);

    if (!state.rootPath) {
      setDropStatus(t('drop.noProject'));
      return;
    }
    if (!paths.length || !targetDir) return;

    const result = await window.mdviewer.copyEntries(targetDir, paths);
    if (!result.ok) {
      setDropStatus(t('drop.copyFailed', { error: result.error }));
      return;
    }

    await refreshTreeDir(targetDir);

    const dirLabel = pathBasename(targetDir) || targetDir;
    const renamed = result.copied.filter((entry) => entry.renamed).length;
    let message;
    if (!result.copied.length) {
      message = t('drop.nothingCopied');
    } else if (renamed) {
      message = t('drop.copiedRenamed', { count: result.copied.length, dir: dirLabel, renamed });
    } else {
      message = t('drop.copied', { count: result.copied.length, dir: dirLabel });
    }
    if (result.skipped.length) {
      message += ' · ' + t('drop.copySkipped', { count: result.skipped.length });
    }
    setDropStatus(message);

    if (result.copied.length) await revealPathInTree(result.copied[0].path, { select: true });
  });

  el.viewerDropOverlay.addEventListener('dragover', (e) => {
    if (!dragHasFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  });

  el.viewerDropOverlay.addEventListener('drop', async (e) => {
    if (!dragHasFiles(e)) return;
    e.preventDefault();
    e.stopPropagation();
    const paths = droppedPaths(e);
    dragDepth = 0;
    setDropAffordance(false);
    await instantViewDropped(paths);
  });

  // Renders a dropped document in place, leaving the project untouched: no
  // copy, no project switch, and the tree selection is cleared rather than
  // left pointing at a different file than the one on screen.
  async function instantViewDropped(paths) {
    if (!paths.length) return;
    const filePath = paths[0];

    const stat = await window.mdviewer.statPath(filePath);
    if (!stat.ok) {
      setDropStatus(t('drop.openFailed', { name: pathBasename(filePath), error: stat.error }));
      return;
    }

    // A folder has nothing to instant-view, so it opens as a project — the
    // same thing dragging one onto the app would mean anywhere else.
    if (stat.isDir) {
      if (!(await guardNavigation())) return;
      await openFolder(filePath);
      return;
    }

    if (!isViewablePath(filePath)) {
      setDropStatus(t('drop.unsupported', { name: pathBasename(filePath) }));
      return;
    }
    if (!(await guardNavigation())) return;

    // With no project open the preview pane is not even on screen (the
    // welcome screen is), so there is nothing to instant-view into: fall
    // back to opening the file's folder, the way "Open File" does.
    if (!state.rootPath) {
      await openSingleFile(filePath);
      return;
    }

    const inProject = isInsideProject(filePath);
    if (!inProject) pendingInstantViewPath = filePath;
    await loadAndRenderByPath(filePath);

    if (inProject) await revealPathInTree(filePath, { select: true });
    else selectTreeRow(null);

    setDropStatus('');
  }

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
    // Right-click is this app's copy/paste gesture in the terminal (the
    // contextmenu handler below), so the right button must never reach
    // xterm's mouse reporting. Once a full-screen program turns mouse
    // tracking on -- Claude Code, vim, htop -- xterm forwards both the press
    // and the release to the program as escape sequences
    // ([<2;col;rowM / ...m), and a program that reads a right-button
    // report as "paste" pastes on each of them, on top of the paste this
    // panel already did: one right-click, up to three pastes. Swallowing the
    // event in the capture phase, before it reaches the xterm element
    // underneath, keeps right-click meaning exactly one thing no matter what
    // is running in the shell.
    for (const type of ['mousedown', 'mouseup', 'auxclick']) {
      el.terminalXterm.addEventListener(
        type,
        (e) => {
          if (e.button !== 2) return;
          e.stopPropagation();
        },
        true
      );
    }

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
    exitDocFullscreen();
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
    // Fullscreen hides the terminal panel; fitting it at zero size there
    // would only have to be undone on the way out (exitDocFullscreen refits).
    if (state.terminalOpen && !state.docFullscreen && fitAddon) fitAddon.fit();
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
