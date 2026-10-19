// The document page: one per tab. Each runs in an iframe of the window
// page's tab area (or of a tab window the tab was moved out to, see the tab
// host in main.js) and holds one document with its viewer and, in edit
// mode, the source editor beside it. An iframe loads again when it changes
// windows, so a tab on the move hands over what it holds (docSnapshot) and
// the page taking over opens on that (restoreHandedOver).
//
// The window page (renderer.js) owns everything around it: the explorer
// and the open projects, the tab strip, the terminal, the CSS editor. What
// this page needs from there arrives as messages relayed by main.js (the
// open projects, live CSS edits), and what it asks of the window (reveal a
// file in the explorer, type into the terminal) goes back the same way.
(() => {
  const {
    t,
    initI18n,
    normalizePath,
    isPathUnder,
    pathToFileUrl,
    dirnameOf,
    basenameOf,
    basenameNoExt,
    pathBasename,
    projectRootIn,
    escapeHtml,
    isPlainTextPathWith,
    fileBadgeSvg,
    treeAgeStep,
    findPathCandidates,
    resolveLinkCandidates,
    setupResizer,
  } = window.MdvCommon;

  const state = {
    // The window's open projects and its active one (see doc:context).
    // projects decides which project a document belongs to; rootPath is
    // where a draft, which has no file yet, resolves links and saves to.
    projects: [],
    rootPath: null,
    // The project of the document shown here, whose saved state (scroll
    // offsets, zoom) and custom CSS apply to it (see applyDocProject).
    docRoot: null,
    // Whether this tab is the one on screen in its window: only that one
    // records itself as its project's last open file.
    isActiveTab: false,
    currentFilePath: null,
    currentFileKind: 'markdown',
    cssEnabled: true,
    userCss: '',
    editMode: false,
    sourceDirty: false,
    sourceDebounceTimer: null,
    suppressNextWatch: false,
    scrollPositions: {},
    scrollDebounceTimer: null,
    suppressScrollSync: false,
    // Custom back/forward navigation (see navigateBack and
    // navigateForward): docHistoryStack holds the documents visited before
    // the current one and docForwardStack the ones stepped back out of;
    // scrollJumpStack holds pre-jump scroll offsets for same-document anchor
    // jumps (TOC/§-ref/in-page links) made within the *current* document,
    // and scrollForwardStack the jump targets stepped back out of. Back pops
    // the scroll stack first and only falls back to switching documents once
    // it's empty; forward mirrors that. As in a browser, any navigation that
    // isn't itself a back/forward step drops the forward trail.
    docHistoryStack: [],
    docForwardStack: [],
    scrollJumpStack: [],
    scrollForwardStack: [],
    navigatingBack: false,
    navigatingForward: false,
    customTextExtensions: [],
    // File > Auto Save (see canAutoSave).
    autoSave: true,
    activeRequestId: null,
    baseCss: '',
    hljsCss: '',
    previewZoom: 100,
    // Fullscreen document view (see enterDocFullscreen) — deliberately not
    // part of the saved project state: it's a way to read right now, not a
    // layout the project should reopen in.
    docFullscreen: false,
    // Set while the viewer is showing a file that was dropped on it rather
    // than opened from the project tree — see instantViewDropped().
    instantViewPath: null,
    // Set while the editor holds an untitled draft (File > New Document):
    // text with no file behind it yet, so currentFilePath stays null until
    // the first save picks a path (see saveUntitledDraft).
    untitledDraft: false,
  };

  // Set just before a loadAndRender* call to mark the document it is about
  // to open as an instant view; beginDocumentNavigation consumes it. Lives
  // here, next to `state`, because that consumer is defined well above the
  // drag-and-drop block that sets it.
  let pendingInstantViewPath = null;

  const SCROLL_POSITION_MAX_AGE_MS = 24 * 60 * 60 * 1000;

  const el = {
    frame: document.getElementById('preview-frame'),
    fileName: document.getElementById('current-file-name'),
    cssAppliedBadge: document.getElementById('css-applied-badge'),
    previewBody: document.getElementById('preview-body'),
    viewerDropOverlay: document.getElementById('viewer-drop-overlay'),
    instantViewBadge: document.getElementById('instant-view-badge'),
    mdSourceEditor: document.getElementById('md-source-editor'),
    editorPane: document.getElementById('editor-pane'),
    editorHighlight: document.getElementById('editor-highlight'),
    editorSyntax: document.getElementById('editor-syntax'),
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
    zoomIndicator: document.getElementById('zoom-indicator'),
    appShell: document.getElementById('app-shell'),
    btnFullscreen: document.getElementById('btn-fullscreen'),
    btnNavBack: document.getElementById('btn-nav-back'),
    btnNavForward: document.getElementById('btn-nav-forward'),
    btnExitFullscreen: document.getElementById('btn-exit-fullscreen'),
    fullscreenHint: document.getElementById('fullscreen-hint'),
    editStatus: document.getElementById('edit-status'),
  };

  function isPlainTextPath(filePath) {
    return isPlainTextPathWith(state.customTextExtensions, filePath);
  }

  function projectRootFor(filePath) {
    return projectRootIn(state.projects, filePath);
  }

  // Asks the window this tab is in to do something on its side (see
  // shell:request in renderer.js).
  function askWindow(action, payload = {}) {
    window.mdviewer.requestWindow(action, payload);
  }

  // The explorer marks and unfolds to the document on screen; a tab in the
  // background leaves it alone.
  function revealPathInTree(targetPath, { select = false } = {}) {
    if (!state.isActiveTab || !targetPath) return;
    askWindow('reveal', { path: targetPath, select });
  }

  // The tab strip marks a tab with unsaved text, and closing a window asks
  // about exactly those tabs (see the window's 'close' in main.js), so any
  // change to either flag is reported — once per turn, however many places
  // set them along the way.
  let docStateReportQueued = false;
  function scheduleDocStateReport() {
    if (docStateReportQueued) return;
    docStateReportQueued = true;
    queueMicrotask(() => {
      docStateReportQueued = false;
      reportDocState();
    });
  }

  for (const key of ['editMode', 'sourceDirty']) {
    let value = state[key];
    Object.defineProperty(state, key, {
      enumerable: true,
      get: () => value,
      set: (next) => {
        if (next === value) return;
        value = next;
        scheduleDocStateReport();
      },
    });
  }

  // The window's tab strip, title and explorer follow what this page shows.
  function reportDocState() {
    window.mdviewer.reportDocState({
      path: state.currentFilePath,
      kind: state.currentFileKind,
      dirty: !!(state.editMode && state.sourceDirty),
      editMode: !!state.editMode,
      draft: !!state.untitledDraft,
      instantView: !!state.instantViewPath,
    });
  }

  // ---------------------------------------------------------------------
  // Custom text extensions (edited in the window's settings dialog)
  // ---------------------------------------------------------------------

  async function loadCustomExtensions() {
    const result = await window.mdviewer.getCustomExtensions();
    state.customTextExtensions = result.ok ? result.extensions : [];
  }

  window.mdviewer.onCustomExtensionsChanged((extensions) => {
    state.customTextExtensions = Array.isArray(extensions) ? extensions : [];
  });

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

    // PlantUML diagram zoom (+/-/fit/reset buttons, Ctrl+wheel) and
    // click-drag pan.
    doc.addEventListener('click', onPumlZoomControlClick);
    doc.addEventListener('wheel', onPumlWheel, { passive: false });
    doc.addEventListener('load', onPumlImageLoad, true);
    // Dragging the sidebar, opening the edit pane and resizing the window all
    // change the iframe's own viewport, so its resize event covers every way
    // a fitted diagram's percentage can go stale.
    el.frame.contentWindow.addEventListener('resize', refreshPumlFitLabels);
    // Ctrl+wheel zooms the whole preview. Registered after onPumlWheel so a
    // diagram under the cursor gets first refusal on the event.
    doc.addEventListener('wheel', onPreviewWheel, { passive: false });
    doc.addEventListener('keydown', onPreviewZoomKey);
    // Ahead of onFullscreenEscape so Esc closes the popup before it would
    // leave fullscreen.
    doc.addEventListener('keydown', onFootnotePopupEscape);
    doc.addEventListener('keydown', onFullscreenEscape);
    el.frame.contentWindow.addEventListener('resize', closeFootnotePopup);
    // Mirrors a selection dragged out in the viewer onto the split-view
    // editor (see updateEditorMirror). 'selectionchange' covers dragging,
    // double-click-to-select and keyboard selection alike.
    doc.addEventListener('selectionchange', updateEditorMirror);
    // Right-drag gestures (see onGestureStart). The capturing contextmenu
    // listener runs ahead of onPreviewContextMenu so a finished gesture
    // never pops the menu up.
    doc.addEventListener('mousedown', onGestureStart);
    doc.addEventListener('mousemove', onGestureMove);
    doc.addEventListener('mouseup', onGestureEnd);
    doc.addEventListener('contextmenu', onGestureContextMenu, true);
    doc.addEventListener('contextmenu', onPreviewContextMenu);
    doc.addEventListener('mousedown', onPumlPanStart);
    doc.addEventListener('mousemove', onPumlPanMove);
    doc.addEventListener('mouseup', onPumlPanEnd);
    doc.addEventListener('mouseleave', onPumlPanEnd);

    // Mouse "back"/"forward" buttons — see the window-level listener
    // why this is also bound here: the iframe is a separate browsing
    // context, so a plain `window.addEventListener` on the outer document
    // never sees mouse events that occur while the cursor is over the
    // preview.
    doc.addEventListener('mouseup', onMouseNavButton);

    // Debounced scroll-position tracking, so re-opening a file later can
    // restore where the reader left off (see loadAndRenderFile).
    let viewerEditorSyncQueued = false;
    let tocActiveQueued = false;
    const queueTocActive = () => {
      if (tocActiveQueued) return;
      tocActiveQueued = true;
      requestAnimationFrame(() => {
        tocActiveQueued = false;
        updateTocActive();
      });
    };
    // Resizing the viewer moves headings without any scroll.
    el.frame.contentWindow.addEventListener('resize', queueTocActive);
    el.frame.contentWindow.addEventListener('scroll', () => {
      queueTocActive();
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

  function pumlNaturalWidth(img) {
    return img.naturalWidth || parseInt(img.getAttribute('width'), 10) || 0;
  }

  // The percentage a diagram is actually being shown at. Under fit-to-width
  // the width is the browser's to decide, so it is measured rather than
  // stored - which is also what keeps the label honest after a resize.
  function pumlEffectiveZoom(diagramEl) {
    const img = diagramEl.querySelector('.plantuml-scroll img');
    if (diagramEl.dataset.fit === '1' && img) {
      const naturalWidth = pumlNaturalWidth(img);
      if (naturalWidth) return Math.round((img.clientWidth / naturalWidth) * 100);
    }
    return parseInt(diagramEl.dataset.zoom || '100', 10);
  }

  function updatePumlZoomLabel(diagramEl) {
    const label = diagramEl.querySelector('.puml-zoom-level');
    if (label) label.textContent = `${pumlEffectiveZoom(diagramEl)}%`;
  }

  function setPumlZoom(diagramEl, percent) {
    const clamped = Math.max(PUML_ZOOM_MIN, Math.min(PUML_ZOOM_MAX, Math.round(percent)));
    delete diagramEl.dataset.fit;
    diagramEl.dataset.zoom = String(clamped);
    const img = diagramEl.querySelector('.plantuml-scroll img');
    if (img) {
      const naturalWidth = pumlNaturalWidth(img);
      img.style.width = clamped === 100 || !naturalWidth ? '' : `${Math.round(naturalWidth * clamped / 100)}px`;
    }
    updatePumlZoomLabel(diagramEl);
  }

  // Fit-to-width is a mode rather than a percentage: the image is handed to
  // CSS at max-width: 100% (see .plantuml-diagram[data-fit] in
  // preview-base.css) so it keeps fitting when the space around it changes -
  // the window, the sidebar, the edit pane - instead of freezing at whatever
  // percentage happened to fit when it was turned on. It is also the only way
  // to fit a diagram so wide that the percentage would fall below
  // PUML_ZOOM_MIN. Diagrams open in this mode; the markup carries data-fit
  // from the start (see plantumlDiagramHtml in main.js).
  function setPumlFit(diagramEl) {
    const img = diagramEl.querySelector('.plantuml-scroll img');
    if (!img) return;
    diagramEl.dataset.fit = '1';
    img.style.width = '';
    updatePumlZoomLabel(diagramEl);
  }

  // A diagram opens fitted, so the percentage its control bar should show is
  // not known until the image has decoded and the browser has laid it out -
  // the markup can only ship a placeholder. An <img>'s load event doesn't
  // bubble, so this is registered in the capture phase instead, which covers
  // every diagram in every document rendered from here on with one listener
  // rather than re-wiring after each render.
  function onPumlImageLoad(e) {
    const img = e.target;
    if (!img.matches || !img.matches('.plantuml-scroll img')) return;
    const diagramEl = img.closest('.plantuml-diagram');
    if (diagramEl) updatePumlZoomLabel(diagramEl);
  }

  // A fit diagram's percentage is a measurement, so it goes stale whenever
  // the space around it changes. Called from the preview frame's resize.
  function refreshPumlFitLabels() {
    const doc = el.frame.contentDocument;
    if (!doc) return;
    for (const diagramEl of doc.querySelectorAll('.plantuml-diagram[data-fit="1"]')) {
      updatePumlZoomLabel(diagramEl);
    }
  }

  function onPumlZoomControlClick(e) {
    const btn = e.target.closest('.puml-zoom-in, .puml-zoom-out, .puml-zoom-fit, .puml-zoom-reset');
    if (!btn) return;
    const diagramEl = btn.closest('.plantuml-diagram');
    if (!diagramEl) return;
    e.preventDefault();
    // Stepping out of fit mode continues from the size actually on screen,
    // so "fit, then a bit bigger" does what it looks like.
    const current = pumlEffectiveZoom(diagramEl);
    if (btn.classList.contains('puml-zoom-in')) setPumlZoom(diagramEl, current + PUML_ZOOM_STEP);
    else if (btn.classList.contains('puml-zoom-out')) setPumlZoom(diagramEl, current - PUML_ZOOM_STEP);
    else if (btn.classList.contains('puml-zoom-fit')) {
      // Pressing it while already fitted drops to 100% - with fit being the
      // default, that is the way to ask for the diagram's actual size.
      if (diagramEl.dataset.fit === '1') setPumlZoom(diagramEl, 100);
      else setPumlFit(diagramEl);
    } else setPumlFit(diagramEl); // reset: back to how the diagram opened
  }

  function onPumlWheel(e) {
    if (!e.ctrlKey) return;
    const diagramEl = e.target.closest('.plantuml-diagram');
    if (!diagramEl) return;
    e.preventDefault();
    const current = pumlEffectiveZoom(diagramEl);
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
  // duration. This page hides its own toolbar and source editor; main.js
  // tells the window page to hide the explorer, tab strip, CSS editor and
  // terminal around the tab. The table of contents stays, since it is the
  // one piece of chrome that helps with reading rather than competing with
  // it.
  //
  // All of that hiding is one class on #app-shell rather than each pane's
  // own `hidden` class, so leaving the mode restores the layout exactly as
  // the user had it.
  //
  // Anything that opens one of the panes the mode hides (edit mode here;
  // the CSS editor, the terminal, project search in the window) leaves the
  // mode first — a command whose whole visible effect is hidden would
  // otherwise look like it did nothing at all.
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
  el.btnNavBack.addEventListener('click', () => navigateBack());
  el.btnNavForward.addEventListener('click', () => navigateForward());
  el.btnExitFullscreen.addEventListener('click', exitDocFullscreen);
  window.mdviewer.onMenuToggleDocumentFullscreen(toggleDocFullscreen);
  // The window can also leave fullscreen without going through
  // exitDocFullscreen (the OS window controls, the window page opening the
  // terminal), which would otherwise strand the mode with its chrome still
  // hidden.
  window.mdviewer.onWindowFullscreenChanged((isFullscreen) => {
    if (!isFullscreen) exitDocFullscreen();
  });

  // Footnote popup: clicking a footnote number shows the note in a small
  // floating box next to it instead of jumping to the list at the bottom.
  // It lives inside the preview document (so it scrolls with the text and
  // picks up the preview's styles) and goes away with the body on the next
  // render.
  let footnotePopup = null;
  let footnotePopupRef = null;

  function closeFootnotePopup() {
    if (footnotePopup) footnotePopup.remove();
    footnotePopup = null;
    footnotePopupRef = null;
  }

  // Position in the document's own layout pixels. The preview zoom is CSS
  // zoom on the root element, which client rects are measured across but
  // offsets are not, so offsets keep the popup aligned at any zoom level.
  function documentOffset(node) {
    let left = 0;
    let top = 0;
    for (let n = node; n; n = n.offsetParent) {
      left += n.offsetLeft;
      top += n.offsetTop;
    }
    return { left, top };
  }

  function showFootnotePopup(anchor) {
    const doc = el.frame.contentDocument;
    const win = el.frame.contentWindow;
    if (footnotePopup && footnotePopupRef === anchor) {
      closeFootnotePopup();
      return;
    }
    closeFootnotePopup();
    const note = doc.getElementById(decodeAnchor(anchor.getAttribute('href').slice(1)));
    if (!note) return;

    const popup = doc.createElement('div');
    popup.className = 'footnote-popup';
    for (const child of note.childNodes) popup.appendChild(child.cloneNode(true));
    popup.querySelectorAll('.footnote-backref').forEach((a) => a.remove());
    // A copy must not answer for the original: ids would duplicate the
    // targets, and source-line tags would pull find/scroll sync to it.
    popup.querySelectorAll('[id], [data-source-line]').forEach((n) => {
      n.removeAttribute('id');
      n.removeAttribute('data-source-line');
      n.removeAttribute('data-source-endline');
    });
    // "[n]" in front of the note jumps to it in the list at the bottom. It is
    // a plain "#fn.." link, so onPreviewClick closes the popup and scrolls
    // there with the usual back-navigation history.
    const jump = doc.createElement('a');
    jump.className = 'footnote-popup-jump';
    jump.href = anchor.getAttribute('href');
    jump.textContent = `[${anchor.textContent}]`;
    jump.title = t('preview.footnoteJump');
    const first = popup.firstElementChild;
    if (first && first.tagName === 'P') first.prepend(jump, ' ');
    else popup.prepend(jump);
    // Measured at the origin, so its shrink-to-fit width is not squeezed by
    // wherever it would have landed on its own.
    popup.style.left = '0px';
    popup.style.top = '0px';
    doc.body.appendChild(popup);

    const body = doc.body;
    const ref = documentOffset(anchor);
    const bodyLeft = documentOffset(body).left;
    const minLeft = bodyLeft + 8;
    const maxLeft = bodyLeft + body.offsetWidth - popup.offsetWidth - 8;
    popup.style.left = Math.max(minLeft, Math.min(ref.left - 12, maxLeft)) + 'px';
    popup.style.top = ref.top + anchor.offsetHeight + 6 + 'px';

    // Flip above the reference when there is no room below it on screen.
    const rect = popup.getBoundingClientRect();
    const refRect = anchor.getBoundingClientRect();
    if (rect.bottom > win.innerHeight && refRect.top - rect.height - 6 >= 0) {
      popup.style.top = ref.top - popup.offsetHeight - 6 + 'px';
    }

    footnotePopup = popup;
    footnotePopupRef = anchor;
  }

  function onFootnotePopupEscape(e) {
    // The body swap of a re-render takes a popup with it without telling us.
    if (e.key !== 'Escape' || e.defaultPrevented || !footnotePopup || !footnotePopup.isConnected) return;
    e.preventDefault();
    closeFootnotePopup();
  }

  // Capture phase, to get ahead of the fullscreen Esc bound earlier.
  document.addEventListener('keydown', onFootnotePopupEscape, true);

  function onPreviewClick(e) {
    if (footnotePopup && !footnotePopup.contains(e.target) && !e.target.closest('.footnote-ref')) {
      closeFootnotePopup();
    }
    const anchor = e.target.closest('a');
    if (!anchor) return;

    if (anchor.closest('.footnote-ref') && (anchor.getAttribute('href') || '').startsWith('#')) {
      e.preventDefault();
      showFootnotePopup(anchor);
      return;
    }
    // A link followed from inside the popup leaves it behind.
    if (footnotePopup && footnotePopup.contains(anchor)) closeFootnotePopup();

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
      const target = findAnchorTarget(href.slice(1));
      if (target) {
        pushScrollJumpHistory();
        target.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    }
  }

  // Shared handler for "internal" links (resolved by the main process to an
  // absolute path): navigates in-app for documents the app shows, hands off
  // to the OS for anything else, and jumps to same-page anchors. Used both
  // by clicks inside the rendered document and by the TOC links list.
  async function openInternalLink(absPath, hash) {
    if (absPath && isViewablePath(absPath)) {
      await openDocumentHere(absPath, { hash });
    } else if (absPath) {
      openExternalSafe(pathToFileUrl(absPath));
    } else if (hash) {
      const target = findAnchorTarget(hash);
      if (target) {
        pushScrollJumpHistory();
        target.scrollIntoView();
      }
    }
  }

  // Follows a link to another document the way a browser tab does: right
  // here — unless another tab in this window already shows it, which main.js
  // then brings forward instead (see doc:open). Resolves to whether the
  // document is now on screen in this tab.
  async function openDocumentHere(absPath, target = {}) {
    const sameDoc = !!state.currentFilePath && normalizePath(state.currentFilePath) === normalizePath(absPath);
    if (!sameDoc) {
      const result = await window.mdviewer.openDocument(absPath, target);
      if (result && result.handled) return false;
      if (!(await guardNavigation())) return false;
      await loadAndRenderByPath(absPath);
      if (!state.currentFilePath || normalizePath(state.currentFilePath) !== normalizePath(absPath)) return false;
    }
    revealPathInTree(absPath, { select: true });
    applyDocTarget(target);
    return true;
  }

  // Brings a spot in the document on screen: a heading anchor, a 1-based
  // source line (a file link written as `file.md:42`), or a project search
  // hit, which the find bar then highlights.
  function applyDocTarget({ hash = '', line = null, searchMatch = null } = {}) {
    if (hash) {
      const target = findAnchorTarget(hash);
      if (target) target.scrollIntoView();
    }
    if (line) revealSourceLine(line - 1);
    if (searchMatch) jumpToSearchMatchInDocument(searchMatch);
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
    setUserCssLive(state.cssEnabled ? state.userCss : '');
    updateCssAppliedBadge();
  }

  // The window's CSS editor shows its edits live in every document of the
  // project being styled, saved or not.
  window.mdviewer.onLiveCss(({ root, css, enabled }) => {
    if (!state.docRoot || !root || normalizePath(root) !== normalizePath(state.docRoot)) return;
    state.userCss = css;
    state.cssEnabled = enabled !== false;
    applyLiveCss();
  });

  // ---------------------------------------------------------------------
  // The document's project: its saved state and custom CSS
  // ---------------------------------------------------------------------

  function sameRoot(a, b) {
    return !!a && !!b && normalizePath(a) === normalizePath(b);
  }

  // Makes `root` the project whose saved scroll offsets, zoom, TOC fold and
  // custom CSS apply to this page (null: none of them). Unsaved edits in
  // the window's CSS editor count over the saved file (see getLiveCss).
  async function applyDocProject(root) {
    state.docRoot = root || null;
    const stateResult = root ? await window.mdviewer.loadProjectState(root) : null;
    const saved = stateResult && stateResult.ok ? stateResult.state : {};
    state.scrollPositions = saved.scrollPositions || {};
    state.cssEnabled = saved.cssEnabled !== undefined ? saved.cssEnabled : true;
    restorePreviewZoom(saved.previewZoom);
    el.tocPanel.classList.toggle('collapsed', !!saved.tocCollapsed);
    let css = '';
    if (root) {
      const live = await window.mdviewer.getLiveCss(root);
      if (live) {
        css = live.css;
        state.cssEnabled = live.enabled !== false;
      } else {
        const result = await window.mdviewer.loadProjectCss(root);
        css = result.ok ? result.css : '';
      }
    }
    state.userCss = css;
    applyLiveCss();
  }

  // Opening a document of another project (a link, the back button) moves
  // this page over to that project, so its CSS and saved state apply. A
  // file outside every project (an instant view) keeps the current one.
  async function switchProjectForPath(filePath) {
    const root = projectRootFor(filePath);
    if (!root || sameRoot(root, state.docRoot)) return;
    if (state.docRoot) {
      captureScrollPosition();
      await persistProjectState();
    }
    await applyDocProject(root);
  }

  // What this page adds to its project's saved state (.mdviewer/state.json).
  // The window page saves its own part (the CSS editor) and main.js merges
  // the parts, so tabs and window never overwrite each other's keys. Only
  // the tab on screen speaks for which document the project had open.
  function docProjectStatePatch() {
    const patch = {
      tocCollapsed: el.tocPanel.classList.contains('collapsed'),
      scrollPositions: state.scrollPositions,
      previewZoom: state.previewZoom,
    };
    if (state.isActiveTab) {
      patch.lastOpenFile = state.currentFilePath || null;
      patch.editModeOpen = state.editMode;
    }
    return patch;
  }

  async function persistProjectState() {
    if (!state.docRoot) return;
    // A draft has no file to record; saving now would only overwrite
    // lastOpenFile with nothing.
    if (state.untitledDraft) return;
    // An instant-viewed file isn't part of the project; recording it as
    // lastOpenFile would reopen an unrelated document on the next launch.
    if (state.instantViewPath) return;
    await window.mdviewer.saveProjectState(state.docRoot, docProjectStatePatch());
  }

  function captureScrollPosition() {
    if (!state.currentFilePath) return;
    // Right after a switch to another project, the document still on screen
    // belongs to the previous one, which already saved its offset.
    const owner = projectRootFor(state.currentFilePath);
    if (owner && !sameRoot(owner, state.docRoot)) return;
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
  // return to it. A switch that is neither a back nor a forward step is a
  // new move, so it drops whatever was ahead, exactly as opening a page in a
  // browser does. Any pending same-document anchor-jump history belongs to
  // the document being left, so it's cleared here rather than carried over.
  function beginDocumentNavigation(nextFilePath) {
    // Every loadAndRender* entry point comes through here, so consuming the
    // marker in one place means a document opened any other way (tree click,
    // link, back button) clears the instant-view flag on its own.
    state.instantViewPath = pendingInstantViewPath === nextFilePath ? nextFilePath : null;
    pendingInstantViewPath = null;
    // Opening any document leaves the draft behind (guardNavigation has
    // already asked about its unsaved text).
    state.untitledDraft = false;

    captureScrollPosition();
    if (!state.navigatingBack && state.currentFilePath && state.currentFilePath !== nextFilePath) {
      state.docHistoryStack.push(state.currentFilePath);
    }
    if (!state.navigatingBack && !state.navigatingForward) {
      state.docForwardStack = [];
    }
    state.scrollJumpStack = [];
    state.scrollForwardStack = [];
    updateNavButtons();
  }

  // Toggles toolbar/preview affordances that only make sense for one file
  // kind (e.g. non-prose views need the preview body's prose max-width
  // lifted so wide content — JSON columns, long log lines, a diagram — has
  // room instead of being squeezed). The refresh button applies to any open
  // file, so it only depends on whether one is open at all.
  function updateFileKindUI() {
    el.instantViewBadge.classList.toggle('hidden', !state.instantViewPath);
    el.btnRefreshPuml.classList.toggle('hidden', !state.currentFilePath);
    el.btnFullscreen.classList.toggle('hidden', !state.currentFilePath);
    // A .puml document is one diagram and nothing else: the prose reading
    // width would only make it scroll inside a narrow column while the
    // window sits half empty next to it.
    const isWideView =
      state.currentFileKind === 'json' ||
      state.currentFileKind === 'text' ||
      state.currentFileKind === 'puml';
    el.frame.contentDocument.body.classList.toggle('wide-view', isWideView);
    // Reserve the path bar's space for the whole time a JSON file is open
    // (even before any node has been clicked), so clicking the first node
    // doesn't shift the layout by suddenly introducing the bar.
    el.jsonPathBar.classList.toggle('hidden', state.currentFileKind !== 'json');
    reportDocState();
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
    await switchProjectForPath(filePath);
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
    await switchProjectForPath(filePath);
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
  // whichever document was open right before the current one. Every step it
  // takes is recorded so navigateForward can retrace it.
  async function navigateBack() {
    const win = el.frame.contentWindow;
    if (state.scrollJumpStack.length > 0) {
      const y = state.scrollJumpStack.pop();
      if (win) state.scrollForwardStack.push(win.scrollY);
      el.frame.contentWindow.scrollTo(0, y);
      updateNavButtons();
      return;
    }
    if (state.docHistoryStack.length === 0) return;
    if (!(await guardNavigation())) return;
    const prevPath = state.docHistoryStack.pop();
    if (state.currentFilePath) state.docForwardStack.push(state.currentFilePath);
    state.navigatingBack = true;
    try {
      await loadAndRenderByPath(prevPath);
      await revealPathInTree(prevPath, { select: true });
    } finally {
      state.navigatingBack = false;
      updateNavButtons();
    }
  }

  // The other direction (XButton2 / 'browser-forward'), retracing what
  // navigateBack stepped out of, most recent step first. The flag is what
  // keeps beginDocumentNavigation from treating this as a new move and
  // throwing away the rest of the forward trail — while still letting it
  // record the document being left, so back keeps working from here.
  async function navigateForward() {
    const win = el.frame.contentWindow;
    if (state.scrollForwardStack.length > 0) {
      const y = state.scrollForwardStack.pop();
      if (win) state.scrollJumpStack.push(win.scrollY);
      el.frame.contentWindow.scrollTo(0, y);
      updateNavButtons();
      return;
    }
    if (state.docForwardStack.length === 0) return;
    if (!(await guardNavigation())) return;
    const nextPath = state.docForwardStack.pop();
    state.navigatingForward = true;
    try {
      await loadAndRenderByPath(nextPath);
      await revealPathInTree(nextPath, { select: true });
    } finally {
      state.navigatingForward = false;
      updateNavButtons();
    }
  }

  // Enables the toolbar back/forward buttons only while navigateBack /
  // navigateForward would actually do something. The stacks change in many
  // places, so this is also called from beginDocumentNavigation,
  // pushScrollJumpHistory, renderBreadcrumb and the project open/close paths.
  function updateNavButtons() {
    el.btnNavBack.disabled = !state.scrollJumpStack.length && !state.docHistoryStack.length;
    el.btnNavForward.disabled = !state.scrollForwardStack.length && !state.docForwardStack.length;
  }

  // Records where the viewer was scrolled to before an in-document anchor
  // jump (TOC click, §-ref link, in-content "#hash" link), so navigateBack
  // can undo it. Call this immediately before performing the jump — which is
  // a new move, so anything the forward trail was still holding goes.
  function pushScrollJumpHistory() {
    const win = el.frame.contentWindow;
    if (win) state.scrollJumpStack.push(win.scrollY);
    state.scrollForwardStack = [];
    state.docForwardStack = [];
    updateNavButtons();
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
    await settleAutoSave();
    if (!(await confirmDiscardIfDirty())) return;

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
    await switchProjectForPath(filePath);
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
    await switchProjectForPath(filePath);
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

  // ---------------------------------------------------------------------
  // Breadcrumb (project-root-relative path in the toolbar)
  // ---------------------------------------------------------------------

  function renderBreadcrumb(filePath) {
    updateNavButtons();
    el.fileName.innerHTML = '';
    el.fileName.title = filePath;

    const rootPath = projectRootFor(filePath) || state.docRoot;
    if (!rootPath) {
      el.fileName.textContent = pathBasename(filePath);
      return;
    }

    const sep = rootPath.includes('\\') && !rootPath.includes('/') ? '\\' : '/';
    const rootNorm = normalizePath(rootPath);
    const fileNorm = normalizePath(filePath);
    let rel = '';
    if (fileNorm === rootNorm) {
      rel = '';
    } else if (fileNorm.startsWith(rootNorm + '/')) {
      rel = filePath.slice(rootPath.replace(/[\\/]+$/, '').length);
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

    addSegment(pathBasename(rootPath) || rootPath, rootPath, true);

    let acc = rootPath.replace(/[\\/]+$/, '');
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
    if (!state.projects.length) return;

    if (state.projects.some((root) => sameRoot(root, folderPath))) {
      revealPathInTree(folderPath);
      return;
    }

    const companion = await findCompanionMarkdownFile(folderPath);
    if (companion && normalizePath(companion) !== normalizePath(state.currentFilePath || '')) {
      // Already open in another tab: that tab comes forward instead.
      const result = await window.mdviewer.openDocument(companion, {});
      if (result && result.handled) return;
      if (!(await guardNavigation())) return;
      if (state.editMode) forceExitEditMode();
      await revealPathInTree(companion, { select: true });
      loadAndRenderFile(companion);
    } else {
      await revealPathInTree(folderPath);
    }
  }

  // The app rewrites a project's .mdviewer/state.json itself on every
  // document load (persistProjectState), and each write carries a fresh
  // scroll timestamp. Auto-reloading it would load -> persist -> watch ->
  // load forever, cancelling whatever navigation the user starts in between.
  function isProjectStateFile(filePath) {
    return /\/\.mdviewer\/state\.json$/.test(normalizePath(filePath));
  }

  // A file just modified (saved here, or changed on disk while open) is as
  // recent as it gets; the explorer drops its fade.
  function markTreeRowFresh(filePath) {
    askWindow('fresh', { path: filePath });
  }

  window.mdviewer.onFileChanged((changedPath) => {
    if (changedPath !== state.currentFilePath) return;
    if (isProjectStateFile(changedPath)) return;
    markTreeRowFresh(changedPath);
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
    return state.editMode && !el.editorPane.classList.contains('hidden');
  }

  function getEditorLineHeight() {
    return parseFloat(getComputedStyle(el.mdSourceEditor).lineHeight) || 20;
  }

  // Top offset (in the textarea's scroll space) of every source line, as
  // laid out with the editor's current width. The editor wraps long lines
  // (pre-wrap), so `line * lineHeight` drifts further off the narrower the
  // pane gets; this measures the real wrapping in an off-screen copy that
  // shares the textarea's text metrics. Cached until the text or width
  // changes.
  let editorLineTopsCache = null;

  function getEditorLineTops() {
    const ta = el.mdSourceEditor;
    const value = ta.value;
    const width = ta.clientWidth;
    const cache = editorLineTopsCache;
    if (cache && cache.width === width && cache.value === value) return cache.tops;

    const cs = getComputedStyle(ta);
    const measure = document.createElement('div');
    measure.setAttribute('aria-hidden', 'true');
    Object.assign(measure.style, {
      position: 'absolute',
      visibility: 'hidden',
      pointerEvents: 'none',
      left: '-100000px',
      top: '0',
      boxSizing: 'border-box',
      width: width + 'px',
      padding: cs.padding,
      border: '0',
      font: cs.font,
      letterSpacing: cs.letterSpacing,
      lineHeight: cs.lineHeight,
      tabSize: cs.tabSize,
      whiteSpace: cs.whiteSpace,
      overflowWrap: cs.overflowWrap,
      wordBreak: cs.wordBreak,
    });
    const frag = document.createDocumentFragment();
    for (const line of value.split('\n')) {
      const div = document.createElement('div');
      // An empty div would collapse to zero height; a textarea still gives
      // the blank line a full line box.
      div.textContent = line || '​';
      frag.appendChild(div);
    }
    measure.appendChild(frag);
    document.body.appendChild(measure);
    const paddingTop = parseFloat(cs.paddingTop) || 0;
    const tops = Array.from(measure.children, (div) => div.offsetTop - paddingTop);
    measure.remove();

    editorLineTopsCache = { value, width, tops };
    return tops;
  }

  function editorScrollTopForLine(line) {
    const tops = getEditorLineTops();
    if (!tops.length) return 0;
    return Math.max(0, tops[Math.max(0, Math.min(line, tops.length - 1))]);
  }

  // The source line at the top of the editor's viewport.
  function editorLineAtScrollTop(scrollTop) {
    const tops = getEditorLineTops();
    let lo = 0;
    let hi = tops.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (tops[mid] <= scrollTop + 1) lo = mid;
      else hi = mid - 1;
    }
    return Math.max(0, lo);
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
    const topLine = editorLineAtScrollTop(el.mdSourceEditor.scrollTop);
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
      el.mdSourceEditor.scrollTop = editorScrollTopForLine(line);
    });
  }

  let viewerSyncQueued = false;
  el.mdSourceEditor.addEventListener('scroll', () => {
    syncEditorMirrorScroll();
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
  // A source line captured *before* a layout change we cause ourselves (the
  // TOC collapse toggle). Once the resize settles, both panes go back to it
  // instead of re-reading the viewer's top, which may already have drifted
  // if the viewer itself was reflowed.
  let splitViewAnchor = null;

  function holdSplitViewAnchor() {
    const target = findTopVisibleViewerElement();
    const line = target ? parseInt(target.getAttribute('data-source-line'), 10) : NaN;
    splitViewAnchor = Number.isNaN(line)
      ? null
      : { line, frameWidth: el.frame.getBoundingClientRect().width };
    scheduleSplitViewResync();
  }

  function resyncSplitView() {
    if (!splitViewActive()) {
      splitViewAnchor = null;
      return;
    }
    const anchor = splitViewAnchor;
    splitViewAnchor = null;
    if (!anchor) {
      syncEditorScrollToViewer();
      return;
    }
    // The viewer only needs moving if its own width changed (the editor was
    // already at its minimum and couldn't absorb the whole TOC delta).
    const viewerReflowed = el.frame.getBoundingClientRect().width !== anchor.frameWidth;
    const target = viewerReflowed ? findViewerElementForLine(anchor.line) : null;
    withScrollSyncSuppressed(() => {
      if (target) el.frame.contentWindow.scrollTo(0, Math.max(0, viewerDocTop(target)));
      el.mdSourceEditor.scrollTop = editorScrollTopForLine(anchor.line);
    });
  }

  function scheduleSplitViewResync() {
    clearTimeout(splitViewResizeTimer);
    splitViewResizeTimer = setTimeout(resyncSplitView, 150);
  }

  const splitViewResizeObserver = new ResizeObserver(() => {
    if (!splitViewActive()) return;
    scheduleSplitViewResync();
  });
  splitViewResizeObserver.observe(el.mdSourceEditor);
  splitViewResizeObserver.observe(el.frame);


  // ---------------------------------------------------------------------
  // Markdown syntax colouring in the source editor
  //
  // A textarea can only draw its text in one colour, so its text is drawn
  // transparent and a layer underneath (#editor-syntax) repaints the same
  // characters in colour. Only colours change, never font weight or style:
  // a bolder glyph could be wider and the caret would drift off the text.
  // The colouring is line-based and deliberately forgiving — it only has to
  // look right, not parse CommonMark exactly.
  // ---------------------------------------------------------------------
  function escapeSyntaxHtml(text) {
    return text.replace(/[&<>]/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;'));
  }

  function syntaxSpan(cls, text) {
    return text ? `<span class="md-${cls}">${escapeSyntaxHtml(text)}</span>` : '';
  }

  // Inline constructs, tried at each position in order. Each `re` is sticky
  // (anchored at lastIndex) and `render` turns the match into html.
  const INLINE_SYNTAX = [
    {
      re: /(`+)([^`]|[^`].*?[^`])\1(?!`)/y,
      render: (m) => syntaxSpan('code', m[0]),
    },
    {
      re: /\\[\\`*_{}[\]()#+\-.!|~<>]/y,
      render: (m) => syntaxSpan('escape', m[0]),
    },
    {
      re: /(!?\[)([^\]]*)(\]\()([^)]*)(\))/y,
      render: (m) =>
        syntaxSpan('link-mark', m[1]) + `<span class="md-link-text">${renderInlineSyntax(m[2])}</span>` +
        syntaxSpan('link-mark', m[3]) + syntaxSpan('link-url', m[4]) + syntaxSpan('link-mark', m[5]),
    },
    {
      re: /<(?:https?:\/\/|mailto:)[^<>\s]+>/y,
      render: (m) => syntaxSpan('link-url', m[0]),
    },
    {
      re: /<!--.*?-->|<\/?[A-Za-z][\w-]*(?:\s[^<>]*)?\/?>/y,
      render: (m) => syntaxSpan(m[0].startsWith('<!--') ? 'comment' : 'html', m[0]),
    },
    {
      re: /(\*\*|__)(?=\S)(.*?\S)\1/y,
      render: (m) => `<span class="md-strong">${m[1]}${renderInlineSyntax(m[2])}${m[1]}</span>`,
    },
    {
      re: /~~(?=\S)(.*?\S)~~/y,
      render: (m) => `<span class="md-strike">~~${renderInlineSyntax(m[1])}~~</span>`,
    },
    {
      re: /([*_])(?=[^\s*_])(.*?[^\s\\])\1(?![*_\w])/y,
      render: (m) => `<span class="md-em">${m[1]}${renderInlineSyntax(m[2])}${m[1]}</span>`,
    },
  ];
  const INLINE_SYNTAX_START = /[`\\![<*_~]/;

  function renderInlineSyntax(text) {
    let html = '';
    let plainFrom = 0;
    let i = 0;
    while (i < text.length) {
      const c = text[i];
      // `_` inside a word (snake_case) is not emphasis.
      if (!INLINE_SYNTAX_START.test(c) || (c === '_' && /\w/.test(text[i - 1] || ''))) {
        i++;
        continue;
      }
      let match = null;
      let rule = null;
      for (rule of INLINE_SYNTAX) {
        rule.re.lastIndex = i;
        match = rule.re.exec(text);
        if (match) break;
      }
      if (!match) {
        i++;
        continue;
      }
      html += escapeSyntaxHtml(text.slice(plainFrom, i)) + rule.render(match);
      i += match[0].length;
      plainFrom = i;
    }
    return html + escapeSyntaxHtml(text.slice(plainFrom));
  }

  const FENCE_OPEN_RE = /^( {0,3})(`{3,}|~{3,})(.*)$/;
  const FENCE_CLOSE_RE = /^ {0,3}(`{3,}|~{3,})\s*$/;
  const ATX_HEADING_RE = /^( {0,3})(#{1,6})(?=\s|$)(.*)$/;
  const SETEXT_UNDERLINE_RE = /^ {0,3}(=+|-+)\s*$/;
  const HR_RE = /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/;
  const QUOTE_RE = /^(?: {0,3}>\s?)+/;
  const LIST_RE = /^(\s*)([-*+]|\d{1,9}[.)])(\s+)(\[[ xX]\](?=\s|$))?/;
  const TABLE_SEPARATOR_RE = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-*:?\s*)*\|?\s*$/;

  function renderTableRowSyntax(line) {
    return line
      .split(/(?<!\\)\|/)
      .map(renderInlineSyntax)
      .join('<span class="md-table-pipe">|</span>');
  }

  // Lines are coloured one at a time, carrying just enough state across
  // lines for the multi-line constructs: fenced code and HTML comments.
  function renderMarkdownSyntax(text) {
    const lines = text.split('\n');
    const out = [];
    let fence = null; // { char, length } while inside a fenced block
    let inComment = false;
    let prevParagraph = false; // the previous line could be a setext heading

    lines.forEach((line, index) => {
      let html;
      let paragraph = false;
      let m;

      if (fence) {
        m = line.match(FENCE_CLOSE_RE);
        if (m && m[1][0] === fence.char && m[1].length >= fence.length) {
          html = syntaxSpan('fence', line);
          fence = null;
        } else {
          html = syntaxSpan('code-block', line);
        }
      } else if (inComment || /^\s*<!--/.test(line)) {
        html = syntaxSpan('comment', line);
        inComment = line.lastIndexOf('-->') < Math.max(line.lastIndexOf('<!--'), 0) || !line.includes('-->');
      } else if ((m = line.match(FENCE_OPEN_RE)) && !(m[2][0] === '`' && m[3].includes('`'))) {
        fence = { char: m[2][0], length: m[2].length };
        html = syntaxSpan('fence', m[1] + m[2]) + syntaxSpan('fence-info', m[3]);
      } else if ((m = line.match(ATX_HEADING_RE))) {
        html = `<span class="md-heading md-h${m[2].length}">` +
          syntaxSpan('heading-mark', m[1] + m[2]) + renderInlineSyntax(m[3]) + '</span>';
      } else if (prevParagraph && SETEXT_UNDERLINE_RE.test(line)) {
        const level = line.trim()[0] === '=' ? 1 : 2;
        out[index - 1] = `<span class="md-heading md-h${level}">${renderInlineSyntax(lines[index - 1])}</span>`;
        html = syntaxSpan('heading-mark', line);
      } else if (HR_RE.test(line)) {
        html = syntaxSpan('hr', line);
      } else if ((m = line.match(QUOTE_RE))) {
        html = syntaxSpan('quote-mark', m[0]) +
          `<span class="md-quote">${renderInlineSyntax(line.slice(m[0].length))}</span>`;
      } else if ((m = line.match(LIST_RE))) {
        html = escapeSyntaxHtml(m[1]) + syntaxSpan('list-mark', m[2]) + escapeSyntaxHtml(m[3]) +
          syntaxSpan('task', m[4] || '') + renderInlineSyntax(line.slice(m[0].length));
      } else if (/^\s*\|/.test(line)) {
        html = TABLE_SEPARATOR_RE.test(line) ? syntaxSpan('table-pipe', line) : renderTableRowSyntax(line);
      } else {
        html = renderInlineSyntax(line);
        paragraph = line.trim() !== '';
      }
      out.push(html);
      prevParagraph = paragraph;
    });
    return out.join('\n');
  }

  // The layers have no scrollbar of their own, so they are padded by the
  // width of the textarea's; otherwise their lines would wrap at a
  // different place than the text they sit under.
  function syncEditorLayerWidth() {
    const ta = el.mdSourceEditor;
    const padding = `${20 + ta.offsetWidth - ta.clientWidth}px`;
    for (const layer of [el.editorHighlight, el.editorSyntax]) {
      if (layer.style.paddingRight !== padding) layer.style.paddingRight = padding;
    }
  }
  new ResizeObserver(syncEditorLayerWidth).observe(el.mdSourceEditor);

  // The layer is repainted from the textarea's text at most once a frame,
  // whatever changed it: typing, or a file being loaded into the editor.
  let editorSyntaxQueued = false;
  function scheduleEditorSyntax() {
    if (editorSyntaxQueued) return;
    editorSyntaxQueued = true;
    requestAnimationFrame(() => {
      editorSyntaxQueued = false;
      const value = el.mdSourceEditor.value;
      const html = state.currentFileKind === 'markdown' ? renderMarkdownSyntax(value) : escapeSyntaxHtml(value);
      // The trailing newline gives a final empty line a line box, as the
      // textarea has, so the layer can scroll as far as the textarea does.
      el.editorSyntax.innerHTML = html + '\n';
      syncEditorLayerWidth();
      syncEditorMirrorScroll();
    });
  }

  // Files are loaded by assigning `value`, which fires no event: hook the
  // setter on this one element so every assignment repaints the layer.
  {
    const valueProp = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value');
    Object.defineProperty(el.mdSourceEditor, 'value', {
      configurable: true,
      get() {
        return valueProp.get.call(this);
      },
      set(v) {
        valueProp.set.call(this, v);
        scheduleEditorSyntax();
      },
    });
  }
  el.mdSourceEditor.addEventListener('input', scheduleEditorSyntax);

  // ---------------------------------------------------------------------
  // Viewer selection mirrored into the source editor
  //
  // Dragging out a selection in the preview marks the matching text in the
  // split-view editor, so you can see at a glance where the rendered
  // passage lives in the source. It is painted on a layer behind the
  // textarea rather than being the textarea's own selection: a textarea
  // doesn't draw its selection at all while the focus is elsewhere (which
  // it is — the drag happened in the viewer), and hijacking the real
  // selection would put the caret somewhere the user didn't ask for.
  // ---------------------------------------------------------------------

  function editorLineOffsets(value) {
    const offsets = [0];
    let at = 0;
    for (const line of value.split('\n')) {
      at += line.length + 1;
      offsets.push(at);
    }
    return offsets;
  }

  function blockElementFor(node) {
    if (!node) return null;
    const element = node.nodeType === 1 ? node : node.parentElement;
    return element ? element.closest('[data-source-line]') : null;
  }

  // Which slice of the source the viewer's current selection corresponds to.
  // The block markers (data-source-line/-endline, see inject_source_line in
  // main.js) only go down to block level, so the span they give is narrowed
  // by looking for the selected text itself inside it: an exact hit for a
  // plain-prose selection, and for a selection that crosses blocks (where
  // the source carries markdown the rendered text doesn't) the stretch from
  // its first line to its last.
  function sourceRangeForViewerSelection() {
    const blocks = viewerSelectionBlocks();
    return blocks ? sourceRangeInBlocks(el.mdSourceEditor.value, blocks) : null;
  }

  // The selected text and the source lines [startLine, endLine) of the
  // blocks it starts and ends in, or null when nothing in the viewer is
  // selected or the render carries no block markers (JSON, plain text).
  function viewerSelectionBlocks() {
    const doc = el.frame.contentDocument;
    const selection = doc && doc.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;
    const selected = selection.toString();
    if (!selected.trim()) return null;

    const range = selection.getRangeAt(0);
    const startBlock = blockElementFor(range.startContainer);
    const endBlock = blockElementFor(range.endContainer) || startBlock;
    if (!startBlock) return null;

    const startLine = parseInt(startBlock.getAttribute('data-source-line'), 10);
    if (Number.isNaN(startLine)) return null;
    const endAttr = parseInt(endBlock.getAttribute('data-source-endline'), 10);
    const endLine = Number.isNaN(endAttr) ? startLine + 1 : endAttr;
    return { selected, startLine, endLine };
  }

  // Narrows the blocks' span of value down to the selected text itself.
  function sourceRangeInBlocks(value, { selected, startLine, endLine }) {
    const offsets = editorLineOffsets(value);
    const spanStart = offsets[Math.min(startLine, offsets.length - 1)];
    const spanEnd = Math.min(offsets[Math.min(endLine, offsets.length - 1)], value.length);
    if (spanEnd <= spanStart) return null;

    const span = value.slice(spanStart, spanEnd);
    const exact = span.indexOf(selected);
    if (exact !== -1) return [spanStart + exact, spanStart + exact + selected.length];

    const lines = selected.split('\n').map((line) => line.trim()).filter(Boolean);
    if (lines.length > 0) {
      const from = span.indexOf(lines[0]);
      const lastLine = lines[lines.length - 1];
      const to = span.lastIndexOf(lastLine);
      if (from !== -1 && to !== -1 && to + lastLine.length > from) {
        return [spanStart + from, spanStart + to + lastLine.length];
      }
    }
    // Nothing of the selection could be matched literally (a table cell, an
    // image's alt text, a rendered list marker): mark the whole block, which
    // is still the right neighbourhood.
    return [spanStart, spanEnd];
  }

  // The layer holds the editor's exact text with the given slices wrapped,
  // so only their background shows (the text itself is transparent — the
  // real glyphs come from the textarea sitting on top). `mode` picks the
  // colour: the viewer-selection mirror and find hits look different (see
  // ui.css), and `current` is the find hit the user is standing on.
  function renderEditorMarks(mode, ranges, currentIndex) {
    const layer = el.editorHighlight;
    layer.dataset.mode = mode;
    layer.textContent = '';
    if (!ranges.length) return;
    const value = el.mdSourceEditor.value;
    let cursor = 0;
    ranges.forEach(([rawStart, rawEnd], i) => {
      const start = Math.max(cursor, Math.min(rawStart, value.length));
      const end = Math.max(start, Math.min(rawEnd, value.length));
      if (start > cursor) layer.appendChild(document.createTextNode(value.slice(cursor, start)));
      const mark = document.createElement('mark');
      if (i === currentIndex) mark.className = 'current';
      mark.textContent = value.slice(start, end);
      layer.appendChild(mark);
      cursor = end;
    });
    if (cursor < value.length) layer.appendChild(document.createTextNode(value.slice(cursor)));
    syncEditorMirrorScroll();
  }

  function renderEditorMirror(range) {
    renderEditorMarks('mirror', range ? [range] : [], -1);
  }

  function syncEditorMirrorScroll() {
    for (const layer of [el.editorHighlight, el.editorSyntax]) {
      layer.scrollTop = el.mdSourceEditor.scrollTop;
      layer.scrollLeft = el.mdSourceEditor.scrollLeft;
    }
  }

  // Selection changes arrive in bursts while dragging, so the mapping runs
  // at most once per frame.
  let editorMirrorQueued = false;
  function updateEditorMirror() {
    if (editorMirrorQueued) return;
    editorMirrorQueued = true;
    requestAnimationFrame(() => {
      editorMirrorQueued = false;
      // Find-in-source owns the layer while it is open; a stray selection
      // in the viewer must not wipe its hits.
      if (!splitViewActive() || editorFindActive()) return;
      renderEditorMirror(sourceRangeForViewerSelection());
    });
  }

  // Selecting text in the editor faintly marks every other place the same
  // text appears, as code editors do. Only a one-line, non-blank selection
  // counts, matched case-sensitively; the selection itself is left to the
  // textarea's own highlight.
  const OCCURRENCE_MAX_LENGTH = 200;
  const OCCURRENCE_MAX_MATCHES = 2000;

  function editorOccurrenceRanges() {
    const ta = el.mdSourceEditor;
    const { selectionStart: selStart, selectionEnd: selEnd, value } = ta;
    if (selEnd <= selStart || selEnd - selStart > OCCURRENCE_MAX_LENGTH) return [];
    const needle = value.slice(selStart, selEnd);
    if (needle.includes('\n') || !needle.trim()) return [];
    const ranges = [];
    let at = value.indexOf(needle);
    while (at !== -1 && ranges.length < OCCURRENCE_MAX_MATCHES) {
      if (at !== selStart) ranges.push([at, at + needle.length]);
      at = value.indexOf(needle, at + needle.length);
    }
    return ranges;
  }

  let editorOccurrenceQueued = false;
  function updateEditorOccurrences() {
    if (editorOccurrenceQueued) return;
    editorOccurrenceQueued = true;
    requestAnimationFrame(() => {
      editorOccurrenceQueued = false;
      // Only the user's own selection in the editor drives this; find hits
      // own the layer while the bar is open.
      if (!state.editMode || editorFindActive()) return;
      if (document.activeElement !== el.mdSourceEditor) return;
      const ranges = editorOccurrenceRanges();
      // Nothing to mark: drop earlier occurrence marks, but leave a
      // viewer-selection mirror alone.
      if (!ranges.length && el.editorHighlight.dataset.mode !== 'occurrence') return;
      renderEditorMarks('occurrence', ranges, -1);
    });
  }
  // A textarea's selection changes are reported on the document.
  document.addEventListener('selectionchange', updateEditorOccurrences);

  // ---------------------------------------------------------------------
  // Body (source) editing
  // ---------------------------------------------------------------------

  // Auto save covers documents that have a file; an untitled draft would
  // need a save dialog, so it is always asked about instead.
  function canAutoSave() {
    return state.autoSave && state.editMode && !state.untitledDraft && !!state.currentFilePath;
  }

  // Resolves to whether the caller may go ahead and drop the editor's text.
  // With auto save on, unsaved edits are saved instead of asked about; only
  // a save that fails falls back to the question.
  async function confirmDiscardIfDirty() {
    if (!state.editMode || !state.sourceDirty) return true;
    if (canAutoSave()) {
      await saveSource();
      if (!state.sourceDirty) return true;
    }
    return window.confirm(t('confirm.discardChanges'));
  }

  window.mdviewer.onAutoSaveChanged((enabled) => {
    state.autoSave = enabled;
  });

  function forceExitEditMode() {
    state.editMode = false;
    state.sourceDirty = false;
    state.untitledDraft = false;
    setEditModeUI(false);
    el.editStatus.textContent = '';
  }

  async function guardNavigation() {
    await settleAutoSave();
    return confirmDiscardIfDirty();
  }

  function setEditModeUI(enabled) {
    el.editorPane.classList.toggle('hidden', !enabled);
    el.editorResizer.classList.toggle('hidden', !enabled);
    if (!enabled) {
      // There is no source pane left to search or to mark.
      if (editorFindActive()) closeFindBar();
      renderEditorMirror(null);
    }
    el.btnToggleEdit.classList.toggle('active', enabled);
    el.btnSaveSource.classList.toggle('hidden', !enabled);
    if (enabled) sizeEditorPaneForViewer();
  }

  // Opening the editor shouldn't squeeze the document: the viewer keeps the
  // width its prose column (body max-width) needs, and the editor gets the
  // rest. Only when that would leave the editor narrower than
  // EDITOR_OPEN_MIN_WIDTH does the editor take that much and the viewer
  // shrink. Views without a max-width (JSON, text, .puml) have no natural
  // width to keep, so they leave the pane at its current/default width.
  const EDITOR_OPEN_MIN_WIDTH = 400;

  function sizeEditorPaneForViewer() {
    if (el.frame.classList.contains('hidden')) return;
    const doc = el.frame.contentDocument;
    if (!doc || !doc.body) return;
    const cs = doc.defaultView.getComputedStyle(doc.body);
    let viewerWidth = parseFloat(cs.maxWidth);
    if (Number.isNaN(viewerWidth)) return;
    if (cs.boxSizing !== 'border-box') {
      viewerWidth +=
        parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight) +
        parseFloat(cs.borderLeftWidth) + parseFloat(cs.borderRightWidth);
    }
    // Room for the frame's vertical scrollbar.
    viewerWidth += el.frame.clientWidth - doc.documentElement.clientWidth;
    const total =
      el.editorPane.getBoundingClientRect().width + el.frame.getBoundingClientRect().width;
    const editorWidth = Math.max(EDITOR_OPEN_MIN_WIDTH, total - viewerWidth);
    el.editorPane.style.width = Math.round(editorWidth) + 'px';
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

  async function exitEditMode() {
    await settleAutoSave();
    if (!(await confirmDiscardIfDirty())) return;
    state.editMode = false;
    state.sourceDirty = false;
    setEditModeUI(false);
    el.editStatus.textContent = '';
    if (state.untitledDraft) {
      // A draft is only viewable through the editor, so leaving edit mode
      // discards it, and its tab with it.
      window.mdviewer.closeThisTab();
    } else if (state.currentFilePath) {
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
    // A draft resolves relative links/images against the project root until
    // it is saved somewhere.
    const baseDir = state.currentFilePath ? dirnameOf(state.currentFilePath) : state.rootPath || '';
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
    if (state.untitledDraft) {
      await saveUntitledDraft();
      return;
    }
    if (!state.currentFilePath) return;
    state.suppressNextWatch = true;
    const result = await window.mdviewer.writeFile(state.currentFilePath, el.mdSourceEditor.value);
    if (result.ok) {
      state.sourceDirty = false;
      el.editStatus.textContent = t('edit.saved');
      markTreeRowFresh(state.currentFilePath);
      if (state.currentFileKind === 'puml') {
        await renderPumlFromText(el.mdSourceEditor.value);
      }
    } else {
      state.suppressNextWatch = false;
      el.editStatus.textContent = t('edit.saveFailed', { error: result.error });
    }
  }

  // Leaving the editor (clicking elsewhere in the app, switching to another
  // window) saves what was typed, while File > Auto Save is on. A draft has
  // no file yet and saving it would open a dialog, so it still waits for an
  // explicit save.
  let autoSavePromise = null;
  el.mdSourceEditor.addEventListener('blur', () => {
    if (!state.sourceDirty || !canAutoSave()) return;
    const filePath = state.currentFilePath;
    const save = (autoSavePromise || Promise.resolve())
      .then(() => {
        // Still the same document with edits outstanding: an earlier save in
        // the chain or a file switch may have settled it meanwhile.
        if (state.editMode && state.sourceDirty && state.currentFilePath === filePath) return saveSource();
      })
      .catch(() => {
        // saveSource reports its own failures in the status line.
      });
    autoSavePromise = save;
    save.then(() => {
      if (autoSavePromise === save) autoSavePromise = null;
    });
  });

  // The click that took focus out of the editor is handled right after the
  // save its blur started; whatever would otherwise ask about unsaved
  // changes waits for that save, so the question never comes up for edits
  // that are about to be on disk.
  async function settleAutoSave() {
    while (autoSavePromise) await autoSavePromise;
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
    if (!items) return;
    const hasImage = Array.from(items).some((item) => item.type.startsWith('image/'));
    if (!hasImage) return;
    // The image is saved next to the document, which a draft doesn't have.
    if (state.untitledDraft) {
      e.preventDefault();
      el.editStatus.textContent = t('draft.pasteImageNeedsSave');
      return;
    }
    if (!state.currentFilePath) return;
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

  el.mdSourceEditor.addEventListener('input', () => {
    // Editing moves every offset after the caret, so a stale mark would
    // point at the wrong text: re-scan while find-in-source is open, and
    // otherwise just drop the selection mirror.
    if (editorFindActive()) runEditorFind();
    else renderEditorMirror(null);
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
      const multiLine = ta.value.slice(ta.selectionStart, ta.selectionEnd).includes('\n');
      if (multiLine || e.shiftKey) {
        shiftEditorLines(ta, e.shiftKey);
        return;
      }
      replaceEditorText(ta, '\t', ta.selectionStart, ta.selectionEnd);
    }
  });

  // Replace [from, to) in the editor through execCommand so the change lands
  // on the textarea's native undo stack (setRangeText bypasses it, leaving
  // Ctrl+Z unable to take the edit back). execCommand fires 'input' itself;
  // the setRangeText path is only a fallback should the command be refused.
  function replaceEditorText(ta, text, from, to) {
    ta.focus();
    ta.setSelectionRange(from, to);
    const ok = text
      ? document.execCommand('insertText', false, text)
      : from === to || document.execCommand('delete');
    if (ok) return;
    ta.setRangeText(text, from, to, 'end');
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  }

  // Tab / Shift+Tab over a multi-line selection (or Shift+Tab anywhere):
  // indent or outdent every line the selection touches, the way code
  // editors do, instead of replacing the selection with a tab. Outdent
  // strips one leading tab or up to two spaces (the editor's tab-size).
  function shiftEditorLines(ta, outdent) {
    const { value, selectionStart: start, selectionEnd: end } = ta;
    const blockStart = value.lastIndexOf('\n', start - 1) + 1;
    // A selection that ends right after a newline doesn't reach into the
    // next line, so that line is left alone.
    const lastPos = end > start && value[end - 1] === '\n' ? end - 1 : end;
    let blockEnd = value.indexOf('\n', lastPos);
    if (blockEnd === -1) blockEnd = value.length;

    const lines = value.slice(blockStart, blockEnd).split('\n');
    const edits = [];
    let at = blockStart;
    const shifted = lines.map((line) => {
      let next = line;
      if (outdent) {
        const m = /^(\t| {1,2})/.exec(line);
        if (m) next = line.slice(m[0].length);
      } else if (line.length || lines.length === 1) {
        // Blank lines inside a block stay blank rather than gaining a tab.
        next = '\t' + line;
      }
      edits.push({ at, delta: next.length - line.length });
      at += line.length + 1;
      return next;
    });
    if (edits.every((edit) => edit.delta === 0)) return;

    // Carry an original offset through the edits: an offset at a line's
    // very start stays there (so whole-line selections stay whole), and
    // one inside removed indentation lands on the new line start.
    const mapPos = (pos) => {
      let shift = 0;
      for (const edit of edits) {
        if (pos <= edit.at) break;
        shift += edit.delta > 0 ? edit.delta : -Math.min(-edit.delta, pos - edit.at);
      }
      return pos + shift;
    };
    const newStart = mapPos(start);
    const newEnd = mapPos(end);
    replaceEditorText(ta, shifted.join('\n'), blockStart, blockEnd);
    ta.setSelectionRange(newStart, newEnd);
  }

  // ---------------------------------------------------------------------
  // Untitled drafts: write first, pick a file name on the first save
  // ---------------------------------------------------------------------

  function fileKindForPath(filePath) {
    if (/\.puml$/i.test(filePath)) return 'puml';
    if (/\.json$/i.test(filePath)) return 'json';
    if (isPlainTextPath(filePath)) return 'text';
    return 'markdown';
  }

  // Starts this tab as an empty markdown draft in the split editor (File >
  // New Document opens a tab for it). Works with or without a project
  // open; nothing touches the disk until it is saved.
  async function startUntitledDraft() {
    beginRenderRequest();
    await applyDocProject(state.rootPath);
    state.untitledDraft = true;
    state.currentFilePath = null;
    state.currentFileKind = 'markdown';
    el.frame.contentDocument.body.innerHTML = '';
    el.fileName.textContent = t('draft.title');
    el.fileName.title = '';
    updateFileKindUI();

    el.mdSourceEditor.value = '';
    state.editMode = true;
    state.sourceDirty = false;
    setEditModeUI(true);
    el.editStatus.textContent = '';
    el.mdSourceEditor.focus();
    refreshToc();
  }

  // First save of a draft: ask where, write it, then carry on editing the
  // new file in place (same buffer, so undo history and caret survive).
  async function saveUntitledDraft() {
    const filePath = await window.mdviewer.saveFileDialog(state.rootPath || '', t('draft.defaultFileName'));
    if (!filePath || !state.untitledDraft) return;
    const content = el.mdSourceEditor.value;
    const result = await window.mdviewer.writeFile(filePath, content);
    if (!result.ok) {
      el.editStatus.textContent = t('edit.saveFailed', { error: result.error });
      return;
    }
    state.untitledDraft = false;
    state.sourceDirty = false;

    state.currentFilePath = filePath;
    state.currentFileKind = fileKindForPath(filePath);
    renderBreadcrumb(filePath);
    updateFileKindUI();
    window.mdviewer.watchFile(filePath);
    if (projectRootFor(filePath)) {
      await switchProjectForPath(filePath);
      askWindow('refresh-dir', { dir: dirnameOf(filePath) });
      revealPathInTree(filePath, { select: true });
    } else {
      // Outside every open project there is no tree to show the file in:
      // the window opens its folder as a project, the same way Open File
      // does (the context update that follows moves this page over to it),
      // and editing carries on here.
      askWindow('ensure-project', { dir: dirnameOf(filePath), reveal: filePath });
    }
    el.editStatus.textContent = t('edit.saved');
    if (state.currentFileKind === 'puml') {
      await renderPumlFromText(content);
    } else {
      await renderSourcePreview();
    }
    persistProjectState();
  }

  // Set once the editor's unsaved text no longer has to be kept when this
  // page goes: handed over to the page taking over, or let go when the tab
  // closed.
  let textSettled = false;

  // Closing a tab asks here first (see closeTab in main.js), which saves
  // unsaved text (auto save) or asks about it.
  async function prepareToClose() {
    if (textSettled || !state.editMode || !state.sourceDirty) return true;
    await settleAutoSave();
    if (canAutoSave() && state.sourceDirty) await saveSource();
    if (!state.sourceDirty) return true;
    if (!(await window.mdviewer.confirmDiscard())) return false;
    textSettled = true;
    return true;
  }

  // Reloading the window any other way would drop unsaved editor text
  // without a word (for a draft, with no copy anywhere); blocking unload
  // hands the question to main.js's 'will-prevent-unload' dialog.
  window.addEventListener('beforeunload', (e) => {
    if (textSettled || !state.editMode || !state.sourceDirty) return;
    // With auto save on, the text is written out (synchronously: the page
    // is going away) instead of asked about.
    if (canAutoSave()) {
      const result = window.mdviewer.writeFileSync(state.currentFilePath, el.mdSourceEditor.value);
      if (result && result.ok) {
        state.sourceDirty = false;
        return;
      }
    }
    e.preventDefault();
    e.returnValue = '';
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
      window.mdviewer.exportPdf(state.currentFilePath, state.docRoot || dirnameOf(state.currentFilePath));
    }
  });

  // Mouse "back"/"forward" buttons. main.js's 'app-command' listener
  // catches the Windows-level XButton1/XButton2 commands; the mouseup
  // listeners here are a fallback for whenever those don't fire (e.g. some
  // non-Windows mouse/OS combinations still deliver a plain DOM button-3 /
  // button-4 mouseup). Both routes converge on the same navigate* calls.
  window.mdviewer.onNavBack(() => navigateBack());
  window.mdviewer.onNavForward(() => navigateForward());
  function onMouseNavButton(e) {
    if (e.button !== 3 && e.button !== 4) return;
    e.preventDefault();
    if (e.button === 3) navigateBack();
    else navigateForward();
  }
  window.addEventListener('mouseup', onMouseNavButton);

  // ---------------------------------------------------------------------
  // Right-button mouse gestures in the viewer
  //
  // Hold the right button over the preview and drag: ← back, → forward,
  // ↑ / ↓ to the top / bottom of the document. A drag shorter than GESTURE_MIN_STROKE is an
  // ordinary right-click and still opens the context menu; a longer one
  // draws a trail with the action it will take, and swallows the
  // contextmenu event that follows the button's release (Windows fires it
  // on mouseup). A drag that turns a corner matches nothing and does nothing.
  // ---------------------------------------------------------------------

  const GESTURE_MIN_STROKE = 30;
  const GESTURES = {
    L: { label: 'gesture.back', run: () => navigateBack() },
    R: { label: 'gesture.forward', run: () => navigateForward() },
    U: { label: 'gesture.top', run: () => scrollViewerToEnd(false) },
    D: { label: 'gesture.bottom', run: () => scrollViewerToEnd(true) },
  };

  let gesture = null;
  let suppressGestureContextMenu = false;

  function scrollViewerToEnd(bottom) {
    const win = el.frame.contentWindow;
    if (!win) return;
    const top = bottom ? win.document.documentElement.scrollHeight : 0;
    win.scrollTo({ top, behavior: 'smooth' });
  }

  function onGestureStart(e) {
    suppressGestureContextMenu = false;
    if (e.button !== 2) return;
    endGesture();
    gesture = {
      doc: e.currentTarget,
      anchorX: e.clientX,
      anchorY: e.clientY,
      points: [`${e.clientX},${e.clientY}`],
      dirs: '',
      overlay: null,
    };
  }

  function onGestureMove(e) {
    if (!gesture) return;
    if (!(e.buttons & 2)) {
      endGesture();
      return;
    }
    gesture.points.push(`${e.clientX},${e.clientY}`);
    const dx = e.clientX - gesture.anchorX;
    const dy = e.clientY - gesture.anchorY;
    if (Math.hypot(dx, dy) >= GESTURE_MIN_STROKE) {
      const dir = Math.abs(dx) > Math.abs(dy) ? (dx < 0 ? 'L' : 'R') : dy < 0 ? 'U' : 'D';
      if (!gesture.dirs.endsWith(dir)) gesture.dirs += dir;
      gesture.anchorX = e.clientX;
      gesture.anchorY = e.clientY;
    }
    if (gesture.dirs) drawGestureTrail();
  }

  function onGestureEnd(e) {
    if (e.button !== 2 || !gesture) return;
    const { dirs } = gesture;
    endGesture();
    if (!dirs) return;
    suppressGestureContextMenu = true;
    const match = GESTURES[dirs];
    if (match) match.run();
  }

  function onGestureContextMenu(e) {
    if (!suppressGestureContextMenu) return;
    suppressGestureContextMenu = false;
    e.preventDefault();
    e.stopImmediatePropagation();
  }

  function drawGestureTrail() {
    const { doc } = gesture;
    if (!gesture.overlay) {
      const svgNs = 'http://www.w3.org/2000/svg';
      const svg = doc.createElementNS(svgNs, 'svg');
      svg.setAttribute(
        'style',
        'position:fixed;inset:0;width:100vw;height:100vh;pointer-events:none;z-index:2147483647'
      );
      const line = doc.createElementNS(svgNs, 'polyline');
      line.setAttribute(
        'style',
        'fill:none;stroke:rgba(37,99,235,0.75);stroke-width:4;stroke-linecap:round;stroke-linejoin:round'
      );
      svg.appendChild(line);
      const label = doc.createElement('div');
      label.setAttribute(
        'style',
        'position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);padding:8px 16px;' +
          'border-radius:8px;background:rgba(0,0,0,0.7);color:#fff;font:600 15px/1.4 system-ui,sans-serif;' +
          'pointer-events:none;z-index:2147483647;white-space:nowrap'
      );
      doc.documentElement.append(svg, label);
      gesture.overlay = { svg, line, label };
    }
    const { line, label } = gesture.overlay;
    line.setAttribute('points', gesture.points.join(' '));
    const match = GESTURES[gesture.dirs];
    const arrows = gesture.dirs.replace(/[LRUD]/g, (d) => ({ L: '←', R: '→', U: '↑', D: '↓' })[d]);
    label.textContent = `${arrows}  ${match ? t(match.label) : t('gesture.none')}`;
  }

  function endGesture() {
    if (gesture && gesture.overlay) {
      gesture.overlay.svg.remove();
      gesture.overlay.label.remove();
    }
    gesture = null;
  }


  // ---------------------------------------------------------------------
  // Viewer context menu (copy text / copy an image)
  //
  // Right-clicking the preview offers "copy" for the selected text and
  // "copy as image" for any image under the pointer — a rendered PlantUML
  // or mermaid diagram, or a picture the document pulled in with
  // `![](...)`, including an .svg file. What was right-clicked is
  // remembered here because the menu is native: the click on an item comes
  // back as an IPC message long after the contextmenu event is over (see
  // viewer:show-context-menu in main.js).
  // ---------------------------------------------------------------------

  // Vector images are rasterised at twice their laid-out size so a pasted
  // diagram still looks sharp in a document or a chat window, up to a sane
  // pixel budget (a full-page PlantUML diagram can be thousands of pixels
  // wide). Photos and screenshots are never scaled — see copyImageSource in
  // main.js, which copies their own pixels instead.
  const IMAGE_COPY_SCALE = 2;
  const IMAGE_COPY_MAX_PIXELS = 16e6;

  let contextMenuSelection = '';
  let contextMenuImageSrc = '';

  function onPreviewContextMenu(e) {
    const doc = el.frame.contentDocument;
    const selection = doc ? doc.getSelection() : null;
    const selectedText = selection && !selection.isCollapsed ? selection.toString() : '';
    // Any image counts, and a click anywhere on a diagram's card (its
    // padding, its zoom controls' row) counts as a click on the diagram.
    const target = e.target.closest ? e.target : null;
    const diagram = target ? target.closest('.plantuml-diagram, .mermaid-diagram') : null;
    const image =
      (target && target.closest('img')) || (diagram ? diagram.querySelector('img') : null);

    contextMenuSelection = selectedText.trim() ? selectedText : '';
    contextMenuImageSrc = image ? image.src : '';

    // Taken now, while the selection is certainly still there, for "send
    // to terminal" (see sendSelectionToTerminal).
    pendingTerminalSelection = contextMenuSelection
      ? {
          filePath: state.currentFilePath,
          text: contextMenuSelection,
          blocks: viewerSelectionBlocks(),
        }
      : null;

    e.preventDefault();
    // Without a selection the menu is about the document itself: history,
    // its file and folder, and the view (see viewer:show-context-menu).
    const filePath = state.currentFilePath || '';
    window.mdviewer.showViewerContextMenu({
      hasSelection: !!contextMenuSelection,
      hasImage: !!contextMenuImageSrc,
      hasLocation: !!filePath,
      filePath,
      rootPath: projectRootFor(filePath) || state.docRoot || '',
      canGoBack: !el.btnNavBack.disabled,
      canGoForward: !el.btnNavForward.disabled,
      isMarkdown: !!filePath && state.currentFileKind === 'markdown',
      editMode: !!state.editMode,
      docFullscreen: !!state.docFullscreen,
    });
  }

  // The document menu's items that act on this window rather than on the
  // file, sent back from main.js by name.
  const VIEWER_CONTEXT_ACTIONS = {
    back: () => navigateBack(),
    forward: () => navigateForward(),
    selectAll: () => {
      const doc = el.frame.contentDocument;
      if (doc && doc.body) doc.getSelection().selectAllChildren(doc.body);
    },
    openInTerminal: () =>
      state.currentFilePath
        ? askWindow('open-terminal', {
            dir: dirnameOf(state.currentFilePath),
            fileName: basenameOf(state.currentFilePath),
          })
        : askWindow('open-terminal', { dir: state.docRoot || state.rootPath || '' }),
    toggleEditMode: () => toggleEditMode(),
    refresh: () => refreshCurrentFile(),
    toggleFullscreen: () => toggleDocFullscreen(),
  };
  window.mdviewer.onViewerContextAction(({ action }) => {
    if (VIEWER_CONTEXT_ACTIONS[action]) VIEWER_CONTEXT_ACTIONS[action]();
  });

  // Draws an SVG into a canvas and puts the resulting PNG on the clipboard:
  // an SVG on the clipboard is useless to most applications, and
  // nativeImage can't read one anyway. The image is re-created in this
  // document rather than reusing the iframe's element so the drawing doesn't
  // depend on the other document's decode state.
  async function copyImageAsBitmap(src) {
    const image = new Image();
    image.src = src;
    await image.decode();
    const width = image.naturalWidth;
    const height = image.naturalHeight;
    if (!width || !height) throw new Error('image has no size');

    const budgeted = Math.sqrt(IMAGE_COPY_MAX_PIXELS / (width * height));
    const scale = Math.max(1, Math.min(IMAGE_COPY_SCALE, budgeted));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(width * scale);
    canvas.height = Math.round(height * scale);
    const ctx = canvas.getContext('2d');
    // Diagrams are drawn for the preview's white card and have no
    // background of their own; on the clipboard there is no page behind
    // them, so paint one in.
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height);

    const result = await window.mdviewer.clipboardWriteImage(canvas.toDataURL('image/png'));
    if (!result || !result.ok) throw new Error((result && result.error) || 'clipboard write failed');
  }

  // Diagrams arrive as an SVG data URL, which this document can rasterise
  // itself. Anything the document imported (file:// or http(s)) has to go
  // through the main process: a canvas that has drawn such an image cannot
  // be read back, and a photo belongs on the clipboard as its own pixels
  // rather than re-encoded. An imported .svg comes back as a data URL to be
  // rasterised here after all.
  async function copyImageUnderPointer(src) {
    if (src.startsWith('data:')) {
      if (/^data:image\/svg\+xml/i.test(src)) {
        await copyImageAsBitmap(src);
        return;
      }
      const result = await window.mdviewer.clipboardWriteImage(src);
      if (!result || !result.ok) throw new Error((result && result.error) || 'clipboard write failed');
      return;
    }
    const result = await window.mdviewer.copyImageSource(src);
    if (result && result.svgDataUrl) {
      await copyImageAsBitmap(result.svgDataUrl);
      return;
    }
    if (!result || !result.ok) throw new Error((result && result.error) || 'copy failed');
  }

  window.mdviewer.onViewerCopySelection(() => {
    if (contextMenuSelection) window.mdviewer.clipboardWriteText(contextMenuSelection);
  });

  window.mdviewer.onViewerCopyImage(async () => {
    if (!contextMenuImageSrc) return;
    try {
      await copyImageUnderPointer(contextMenuImageSrc);
      setToolbarStatus(t('context.imageCopied'));
    } catch (err) {
      setToolbarStatus(t('context.imageCopyFailed', { error: err.message }));
    }
  });

  // ---------------------------------------------------------------------
  // Send selection to terminal
  //
  // Right-click > "Send ... to Terminal" in the viewer or the source editor
  // types a reference to the selection into the terminal panel's shell:
  // @path#L12-18 (1-based, inclusive), the form Claude Code reads as a file
  // mention, optionally followed by the selected source text. No Enter is
  // sent, so a prompt can be typed after it. The path is relative to the
  // shell's folder (the project root) when the file lies under it.
  // ---------------------------------------------------------------------

  // What the last menu was opened on: { filePath, text, blocks } for the
  // viewer (blocks from viewerSelectionBlocks), { filePath, text, range }
  // for the editor (range as [start, end) offsets into its value).
  let pendingTerminalSelection = null;

  el.mdSourceEditor.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const editor = el.mdSourceEditor;
    const { selectionStart: start, selectionEnd: end } = editor;
    const text = editor.value.slice(start, end);
    pendingTerminalSelection = text.trim()
      ? { filePath: state.currentFilePath, text, range: [start, end], source: editor.value }
      : null;
    window.mdviewer.showEditorContextMenu({
      hasSelection: start !== end,
      hasLocation: !!state.currentFilePath,
    });
  });

  function lineNumberAt(value, offset) {
    let line = 1;
    for (let i = value.indexOf('\n'); i !== -1 && i < offset; i = value.indexOf('\n', i + 1)) line++;
    return line;
  }

  // "#L12" or "#L12-18" for the [start, end) slice of value. A selection
  // that runs up to and including a line break ends on the line before it.
  function lineFragment(value, [start, end]) {
    const first = lineNumberAt(value, start);
    const last = lineNumberAt(value, end > start && value[end - 1] === '\n' ? end - 1 : end);
    return last > first ? `#L${first}-${last}` : `#L${first}`;
  }

  // The source the viewer's selection was rendered from: the editor while
  // it holds this file (it may be ahead of the disk), else the file itself.
  async function sourceTextFor(filePath) {
    if (state.editMode && state.currentFilePath === filePath) return el.mdSourceEditor.value;
    const result = await window.mdviewer.readFile(filePath);
    return result && result.ok ? result.content : null;
  }

  // The source slice and the "#L.." fragment for the pending selection;
  // both empty when it can't be placed (a JSON or plain-text render, which
  // has no block markers, or a file that can no longer be read).
  async function resolveSelectionLocation(pending) {
    if (pending.range) {
      return {
        fragment: lineFragment(pending.source, pending.range),
        sourceText: pending.text,
      };
    }
    if (!pending.blocks || !pending.filePath) return { fragment: '', sourceText: '' };
    const value = await sourceTextFor(pending.filePath);
    if (value == null) return { fragment: '', sourceText: '' };
    const range = sourceRangeInBlocks(value, pending.blocks);
    if (!range) return { fragment: '', sourceText: '' };
    return { fragment: lineFragment(value, range), sourceText: value.slice(range[0], range[1]) };
  }

  // Works out the reference and the source text here, where the document
  // is; the window, which has the terminal, types it in (see
  // typeSelectionIntoTerminal in renderer.js).
  async function sendSelectionToTerminal({ withText }) {
    const pending = pendingTerminalSelection;
    if (!pending) return;
    const { fragment, sourceText } = await resolveSelectionLocation(pending);
    const body = (sourceText || pending.text).replace(/\r\n/g, '\n').replace(/\n+$/, '');
    askWindow('send-to-terminal', { filePath: pending.filePath || '', fragment, body, withText: !!withText });
  }

  window.mdviewer.onSendSelectionToTerminal(sendSelectionToTerminal);

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
  // Which text the find bar is acting on: 'viewer' (the rendered document)
  // or 'editor' (the markdown source). See openFindBar.
  let findTarget = 'viewer';

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
    if (!state.editMode || el.editorPane.classList.contains('hidden')) return;
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

    el.mdSourceEditor.scrollTop = Math.max(
      0,
      editorScrollTopForLine(targetLine) - EDITOR_SYNC_CONTEXT_LINES * getEditorLineHeight()
    );
  }

  function updateFindCountUI() {
    const editorMode = findTarget === 'editor';
    const total = editorMode ? editorFindMatches.length : docFindMatches.length;
    const index = editorMode ? editorFindIndex : docFindIndex;
    if (!total) {
      const hasQuery = !!el.findInput.value;
      el.findCount.classList.toggle('no-results', hasQuery);
      el.findCount.textContent = hasQuery ? t('find.noResults') : '';
      return;
    }
    el.findCount.classList.remove('no-results');
    el.findCount.textContent = t('find.matchCount', { current: index + 1, total });
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


  // ---------------------------------------------------------------------
  // Find in the source editor (Ctrl+F with the caret in the editor)
  //
  // Ctrl+F searches whatever the user is looking at: the rendered document
  // normally, and the markdown source when the caret is in the editor —
  // where searching the rendering would be the wrong text (you cannot find
  // `**bold**` or a link's URL in it). Both modes share the one find bar;
  // findTarget says which text the bar's input, Enter and next/prev act on.
  //
  // Hits are painted on the editor's highlight layer (the same one the
  // viewer-selection mirror uses) rather than through the textarea's own
  // selection, which isn't drawn at all while the focus sits in the find
  // input. The layer also gives exact match positions — offsetTop accounts
  // for wrapped lines, which a line-height estimate cannot.
  // ---------------------------------------------------------------------

  let editorFindMatches = [];
  let editorFindIndex = -1;
  // Where the caret was when the bar opened, so the first hit shown is the
  // next one from there rather than always the top of the file.
  let editorFindOrigin = 0;

  function editorFindActive() {
    return findTarget === 'editor' && !el.findBar.classList.contains('hidden');
  }

  function clearEditorFind() {
    editorFindMatches = [];
    editorFindIndex = -1;
    renderEditorMarks('mirror', [], -1);
  }

  function scrollEditorToCurrentFind() {
    const markEl = el.editorHighlight.querySelector('mark.current');
    if (!markEl) return;
    const ta = el.mdSourceEditor;
    const top = markEl.offsetTop;
    const bottom = top + markEl.offsetHeight;
    const margin = getEditorLineHeight() * 2;
    if (top < ta.scrollTop + margin || bottom > ta.scrollTop + ta.clientHeight - margin) {
      ta.scrollTop = Math.max(0, top - ta.clientHeight / 2);
    }
    syncEditorMirrorScroll();
  }

  function gotoEditorFindMatch(index) {
    editorFindIndex = index;
    renderEditorMarks('find', editorFindMatches, editorFindIndex);
    const match = editorFindMatches[editorFindIndex];
    if (match) {
      // Left on the textarea as well: it is invisible while the find input
      // has the focus, but it means closing the bar leaves the caret on the
      // hit the user stopped at.
      el.mdSourceEditor.setSelectionRange(match[0], match[1]);
      scrollEditorToCurrentFind();
    }
    updateFindCountUI();
  }

  function runEditorFind() {
    editorFindMatches = [];
    editorFindIndex = -1;
    const query = el.findInput.value;
    if (!query) {
      clearEditorFind();
      updateFindCountUI();
      return;
    }
    const value = el.mdSourceEditor.value;
    const haystack = value.toLowerCase();
    const needle = query.toLowerCase();
    let at = haystack.indexOf(needle);
    while (at !== -1) {
      editorFindMatches.push([at, at + query.length]);
      at = haystack.indexOf(needle, at + query.length);
    }
    if (!editorFindMatches.length) {
      clearEditorFind();
      updateFindCountUI();
      return;
    }
    const fromCaret = editorFindMatches.findIndex(([start]) => start >= editorFindOrigin);
    gotoEditorFindMatch(fromCaret === -1 ? 0 : fromCaret);
  }

  function stepEditorFind(delta) {
    if (!editorFindMatches.length) {
      runEditorFind();
      return;
    }
    gotoEditorFindMatch(
      (editorFindIndex + delta + editorFindMatches.length) % editorFindMatches.length
    );
  }

  function runFind() {
    if (findTarget === 'editor') runEditorFind();
    else runDocFind();
  }

  function stepFind(delta) {
    if (findTarget === 'editor') stepEditorFind(delta);
    else stepDocFind(delta);
  }

  function setFindTarget(target) {
    if (findTarget === target) return;
    // Leave nothing of the old mode behind: its highlights live in a
    // different place (the viewer's DOM vs. the editor's layer).
    if (findTarget === 'editor') clearEditorFind();
    else {
      clearDocFindHighlights();
      docFindMatches = [];
      docFindIndex = -1;
    }
    findTarget = target;
    el.findInput.placeholder = t(target === 'editor' ? 'find.placeholderEditor' : 'find.placeholder');
  }

  function openFindBar() {
    // Ctrl+F searches wherever the caret is: the source when it's in the
    // editor, the rendered document otherwise. Pressing it again while the
    // bar is already open (so the focus is in its input) keeps the mode.
    const wasOpen = !el.findBar.classList.contains('hidden');
    if (splitViewActive() && document.activeElement === el.mdSourceEditor) {
      editorFindOrigin = el.mdSourceEditor.selectionStart || 0;
      const selected = el.mdSourceEditor.value.slice(
        el.mdSourceEditor.selectionStart,
        el.mdSourceEditor.selectionEnd
      );
      setFindTarget('editor');
      // An editor's find seeds itself from what's selected, if that is a
      // plain one-line stretch of text.
      if (selected && !selected.includes('\n')) el.findInput.value = selected;
    } else if (!wasOpen) {
      setFindTarget('viewer');
    }

    el.findBar.classList.remove('hidden');
    el.findInput.focus();
    el.findInput.select();
    if (el.findInput.value) runFind();
    else updateFindCountUI();
  }

  function closeFindBar() {
    el.findBar.classList.add('hidden');
    if (findTarget === 'editor') {
      const match = editorFindMatches[editorFindIndex];
      clearEditorFind();
      // Hand the editor back with the caret on the hit that was showing.
      el.mdSourceEditor.focus();
      if (match) el.mdSourceEditor.setSelectionRange(match[0], match[1]);
    }
    clearDocFindHighlights();
    docFindMatches = [];
    docFindIndex = -1;
    updateFindCountUI();
  }

  el.findInput.addEventListener('input', runFind);
  el.findInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      stepFind(e.shiftKey ? -1 : 1);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      closeFindBar();
    }
  });
  el.findPrev.addEventListener('click', () => stepFind(-1));
  el.findNext.addEventListener('click', () => stepFind(1));
  el.findClose.addEventListener('click', closeFindBar);

  window.mdviewer.onMenuToggleFind(openFindBar);

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

    // A project-search hit is always a hit in the rendered document, so
    // this opens the bar on the viewer even if it was last used on the
    // source.
    setFindTarget('viewer');
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

  // ---------------------------------------------------------------------
  // Floating table of contents / sibling pages
  // ---------------------------------------------------------------------

  // Heading anchor convention (GitHub-style), e.g.
  //   "# 1. 시작하기 전에!"             -> #1-시작하기-전에
  //   "## 설치 방법 (Windows & Mac)"    -> #설치-방법-windows--mac
  //   "### API Reference: User Auth"   -> #api-reference-user-auth
  //   "## 🚀 향후 업데이트 계획"         -> #향후-업데이트-계획
  // Lowercase, drop emoji and punctuation (letters/digits of any script,
  // "_" and "-" stay), trim, then every remaining space becomes "-" one for
  // one — which is why "Windows & Mac" keeps its double dash.
  function slugify(text) {
    return text
      .toLowerCase()
      .replace(/[\p{Extended_Pictographic}‍️]/gu, '')
      .replace(/[^\p{L}\p{N}\p{M}\s_-]/gu, '')
      .trim()
      .replace(/\s/g, '-');
  }

  // Punctuation- and dash-insensitive form of an anchor, so links written
  // against a slightly different slug rule (collapsed dashes, a leading
  // dash left by a stripped emoji) still find their heading.
  function looseAnchorKey(text) {
    return text.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
  }

  function decodeAnchor(hash) {
    try {
      return decodeURIComponent(hash);
    } catch (e) {
      return hash;
    }
  }

  // The element a "#hash" link points at in the current document: an exact
  // id (or <a name>) first, then a heading whose slug matches loosely.
  function findAnchorTarget(hash) {
    const doc = el.frame.contentDocument;
    if (!doc || !hash) return null;
    const id = decodeAnchor(hash);
    const exact = doc.getElementById(id) || doc.getElementsByName(id)[0];
    if (exact) return exact;
    const key = looseAnchorKey(id);
    if (!key) return null;
    for (const heading of doc.querySelectorAll('h1, h2, h3, h4, h5, h6')) {
      if (looseAnchorKey(heading.id || slugify(heading.textContent)) === key) return heading;
    }
    return null;
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

    ta.scrollTop = Math.max(0, editorScrollTopForLine(lineNumber) - ta.clientHeight / 2);
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
    updateTocActive();
  }

  // Index of the TOC entry currently marked as being read (-1: none), so the
  // list only scrolls to follow it when it actually moves.
  let tocActiveIndex = -1;

  // The section being read: the last heading that has scrolled up past a
  // line a fifth of the way down the viewer. At the very bottom of the
  // document, headings too close to the end to ever reach that line count
  // as soon as they're on screen — otherwise the last short sections could
  // never be marked.
  function currentTocIndex() {
    const win = el.frame.contentWindow;
    const doc = el.frame.contentDocument;
    if (!win || !doc || !tocEntries.length) return -1;
    const viewHeight = win.innerHeight;
    const atBottom = win.scrollY + viewHeight >= doc.documentElement.scrollHeight - 2;
    const line = atBottom ? viewHeight : viewHeight * 0.2;
    let index = -1;
    for (let i = 0; i < tocEntries.length; i++) {
      const heading = tocEntries[i].heading;
      if (!heading.isConnected) continue;
      if (heading.getBoundingClientRect().top > line) break;
      index = i;
    }
    return index;
  }

  // Marks the section being read in the TOC. Inside a folded heading the
  // mark goes to the nearest heading still showing, so it's never lost.
  function updateTocActive() {
    let index = currentTocIndex();
    const collapsed = tocCollapsedSet();
    while (index !== -1 && tocEntryHidden(tocEntries[index], collapsed)) index = tocEntries[index].parent;
    tocEntries.forEach((entry, i) => {
      if (entry.li) entry.li.classList.toggle('toc-active', i === index);
    });
    if (index === tocActiveIndex) return;
    tocActiveIndex = index;
    const li = index !== -1 ? tocEntries[index].li : null;
    if (li) scrollTocItemIntoView(li);
  }

  // Keeps the marked row inside the TOC's own scroll box. Done by hand
  // rather than with scrollIntoView, which would also scroll the app's
  // overflow:hidden layout boxes around it.
  function scrollTocItemIntoView(li) {
    const box = li.closest('.toc-panel-body');
    if (!box || !li.offsetParent) return;
    const boxRect = box.getBoundingClientRect();
    const liRect = li.getBoundingClientRect();
    const margin = 24;
    if (liRect.top < boxRect.top + margin) {
      box.scrollTop -= boxRect.top + margin - liRect.top;
    } else if (liRect.bottom > boxRect.bottom - margin) {
      box.scrollTop += liRect.bottom - (boxRect.bottom - margin);
    }
  }

  function renderTocList() {
    el.tocList.innerHTML = '';
    tocActiveIndex = -1;
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
        const base = slugify(heading.textContent.trim()) || `section-${index}`;
        // Repeats get "-1", "-2", ... like GitHub, so "#개요-1" reaches the
        // second "개요".
        let candidate = base;
        let n = 1;
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
      return { type: 'anchor', hash: decodeAnchor(href.slice(1)), key: href };
    }
    return null;
  }

  // Link kinds that point at a file the app opens get the explorer's badge;
  // the rest keep a text glyph.
  const LINK_TYPE_BADGE = {
    'internal-doc': 'md',
    'internal-puml': 'puml',
    'internal-json': 'json',
    'internal-text': 'text',
  };
  const LINK_TYPE_ICON = {
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
      // Footnote numbers and their ↩︎ back-links are in-page jumps labelled
      // "1", "↩︎" — noise in a list of where the document links to.
      if (anchor.closest('.footnote-ref, .footnote-backref')) continue;
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
      li.className = 'toc-item toc-link-item';
      const icon = document.createElement('span');
      icon.className = 'toc-link-icon';
      const badgeKind = LINK_TYPE_BADGE[info.type];
      if (badgeKind) icon.innerHTML = fileBadgeSvg(badgeKind, info.absPath);
      else icon.textContent = LINK_TYPE_ICON[info.type];
      li.appendChild(icon);
      li.appendChild(document.createTextNode(label));
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
          const target = findAnchorTarget(info.hash);
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
    await renderSiblingLevel(el.tocSiblingsList, subFolder.path, 0);
  }

  // The sub-pages list: the companion folder's files laid out like the
  // explorer's rows (folders unfold on click), opening documents in place.
  const SIBLING_INDENT = 10;

  async function renderSiblingLevel(container, dirPath, depth) {
    const result = await window.mdviewer.listDir(dirPath);
    if (!result.ok) {
      const errRow = document.createElement('div');
      errRow.className = 'tree-row non-md';
      errRow.textContent = t('tree.readError', { error: result.error });
      container.appendChild(errRow);
      return;
    }
    for (const item of result.items) {
      const node = document.createElement('div');
      node.className = 'tree-node';
      const row = document.createElement('div');
      const kind = item.isDir
        ? 'dir'
        : item.isMarkdown
        ? 'md'
        : item.isPuml
        ? 'puml'
        : item.isJson
        ? 'json'
        : item.isPlainText
        ? 'plaintext'
        : 'non-md';
      row.className = 'tree-row ' + kind;
      row.style.paddingLeft = 6 + depth * SIBLING_INDENT + 'px';
      row.dataset.path = item.path;
      const ageStep = item.isDir ? 0 : treeAgeStep(item.mtimeMs);
      if (ageStep) row.classList.add('age-' + ageStep);
      if (item.isHidden) row.classList.add('dot-entry');
      if (state.currentFilePath && !item.isDir && normalizePath(item.path) === normalizePath(state.currentFilePath)) {
        row.classList.add('active-doc');
      }

      const caret = document.createElement('span');
      caret.className = 'tree-caret';
      caret.textContent = item.isDir ? '▶' : '';
      const icon = document.createElement('span');
      icon.className = 'tree-icon';
      const badgeKind = { md: 'md', puml: 'puml', json: 'json', plaintext: 'text' }[kind];
      if (badgeKind) icon.innerHTML = fileBadgeSvg(badgeKind, item.name);
      else icon.textContent = item.isDir ? '📁' : '·';
      const label = document.createElement('span');
      label.className = 'tree-label';
      label.textContent = item.name;
      row.append(caret, icon, label);
      node.appendChild(row);

      if (item.isDir) {
        const children = document.createElement('div');
        children.className = 'tree-children';
        node.appendChild(children);
        row.addEventListener('click', async () => {
          const expanded = children.classList.toggle('expanded');
          caret.classList.toggle('expanded', expanded);
          if (expanded && children.dataset.loaded !== '1') {
            children.dataset.loaded = '1';
            await renderSiblingLevel(children, item.path, depth + 1);
          }
        });
      } else if (badgeKind) {
        row.addEventListener('click', () => openDocumentHere(item.path));
      } else {
        row.addEventListener('dblclick', () => window.mdviewer.openPath(item.path));
      }
      container.appendChild(node);
    }
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
    const splitView = splitViewActive();
    // Rewrapping the editor moves its text, so remember which source line
    // is on top before the widths change and return both panes to it after.
    if (splitView) holdSplitViewAnchor();
    el.tocPanel.classList.toggle('collapsed');
    // Widening/narrowing the TOC panel would otherwise resize the preview
    // frame (flex:1). Steal the width from the editor pane instead, so the
    // preview stays visually fixed as long as the editor has room to give.
    // Size the pane, not the textarea: the textarea (and the highlight layer
    // behind it) must keep filling the pane, or they fall out of step with
    // it and stop following later window/splitter resizes.
    if (splitView) {
      const currentWidth = el.editorPane.getBoundingClientRect().width;
      const delta = expanding ? TOC_WIDTH_DELTA : -TOC_WIDTH_DELTA;
      const newWidth = Math.max(EDITOR_MIN_WIDTH, currentWidth - delta);
      el.editorPane.style.width = newWidth + 'px';
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
  // Drag and drop: a file dropped on the viewer is shown right now
  // ---------------------------------------------------------------------
  //
  // The explorer, in the window page, copies what is dropped on it into the
  // project; a drop here only shows the document, without copying. The
  // preview is an <iframe>, which swallows drag events before they reach
  // this document, so a drop target is laid over it for the duration of the
  // drag instead.

  let dragDepth = 0;

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

  // The toolbar's one-line status slot, the same place save and paste
  // results are reported, shared by everything that finishes without a
  // dialog of its own.
  function setToolbarStatus(message) {
    el.editStatus.textContent = message;
  }

  function setDropAffordance(active) {
    el.viewerDropOverlay.classList.toggle('hidden', !active);
  }

  // dragenter/dragleave fire per element as the pointer crosses children, so
  // the pair is counted rather than trusted individually — otherwise moving
  // over a nested element would read as having left the page.
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

  // A tab dragged from a window's tab strip and dropped on a document moves
  // into that document's window (see tabs:move-here in main.js), the same
  // as dropping it on the strip there.
  const TAB_DRAG_TYPE = 'application/x-mdviewer-tab';

  function isTabDrag(e) {
    const types = e.dataTransfer && e.dataTransfer.types;
    return !!types && Array.prototype.includes.call(types, TAB_DRAG_TYPE);
  }

  // Without these the page would navigate away to the dropped file, which
  // replaces the whole tab with it.
  window.addEventListener('dragover', (e) => {
    e.preventDefault();
    if (isTabDrag(e)) e.dataTransfer.dropEffect = 'move';
  });
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    dragDepth = 0;
    setDropAffordance(false);
    if (!isTabDrag(e)) return;
    const id = Number(e.dataTransfer.getData(TAB_DRAG_TYPE));
    if (id) window.mdviewer.moveTabHere(id);
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
  // copy, no project switch.
  async function instantViewDropped(paths) {
    if (!paths.length) return;
    const filePath = paths[0];

    const stat = await window.mdviewer.statPath(filePath);
    if (!stat.ok) {
      setToolbarStatus(t('drop.openFailed', { name: pathBasename(filePath), error: stat.error }));
      return;
    }

    // A folder has nothing to instant-view, so it opens as a project — the
    // same thing dragging one onto the app would mean anywhere else.
    if (stat.isDir) {
      askWindow('open-folder', { path: filePath });
      return;
    }

    if (!isViewablePath(filePath)) {
      setToolbarStatus(t('drop.unsupported', { name: pathBasename(filePath) }));
      return;
    }

    // A file of an open project is just opened, in its own tab if it has
    // one; anything else is shown here as an instant view.
    if (projectRootFor(filePath)) {
      await openDocumentHere(filePath);
    } else {
      if (!(await guardNavigation())) return;
      pendingInstantViewPath = filePath;
      await loadAndRenderByPath(filePath);
    }
    setToolbarStatus('');
  }

  // ---------------------------------------------------------------------
  // File links: Ctrl+click on a file name in the source editor opens that
  // file, at the line when one is written after it (`docs/guide.md:42`, as
  // compilers and grep print it). The terminal's links are the window's.
  // ---------------------------------------------------------------------

  function projectRelativeLabel(filePath) {
    const root = projectRootFor(filePath);
    return root ? filePath.slice(root.length).replace(/^[\\/]/, '') : filePath;
  }

  async function openFileLink(link) {
    let target = link.targets[0];
    if (link.targets.length > 1) {
      const index = await window.mdviewer.pickPath(link.targets.map(projectRelativeLabel));
      if (index < 0) return;
      target = link.targets[index];
    }
    if (!isViewablePath(target)) {
      // Hands anything the app cannot show to the OS.
      await openInternalLink(target);
    } else if (!projectRootFor(target)) {
      // Outside every open project: the window opens it the way "Open File"
      // does, in the nearest project above it.
      askWindow('open-file', { path: target, findProject: true, line: link.line });
    } else {
      await openDocumentHere(target, { line: link.line });
    }
  }

  // Brings a 0-based source line of the open document into view.
  function revealSourceLine(line) {
    if (state.editMode) {
      // The viewer follows through the split view's scroll sync.
      scrollSourceToLine(line);
    } else if (state.currentFileKind === 'markdown' || state.currentFileKind === 'puml') {
      const block = findViewerElementForLine(line);
      if (block) block.scrollIntoView({ block: 'center' });
    } else if (state.currentFileKind === 'text') {
      scrollPlainTextToLine(line);
    }
  }

  // The plain-text view is one <pre> without per-line markers, so the line
  // is found by counting newlines through its text.
  function scrollPlainTextToLine(line) {
    const doc = el.frame.contentDocument;
    const win = el.frame.contentWindow;
    const pre = doc && doc.querySelector('.plaintext-view');
    if (!pre) return;
    const walker = doc.createTreeWalker(pre, NodeFilter.SHOW_TEXT);
    let remaining = line;
    let node;
    while ((node = walker.nextNode())) {
      let offset = 0;
      while (remaining > 0) {
        const nl = node.data.indexOf('\n', offset);
        if (nl === -1) break;
        offset = nl + 1;
        remaining--;
      }
      if (remaining > 0 || offset >= node.data.length) continue;
      const range = doc.createRange();
      range.setStart(node, offset);
      range.setEnd(node, offset + 1);
      const rect = range.getBoundingClientRect();
      win.scrollTo(0, Math.max(0, rect.top + win.scrollY - win.innerHeight / 2));
      return;
    }
  }

  // The editor is a textarea, whose text has no elements to hit-test, so
  // the link is read off the line around the caret the click just placed.
  el.mdSourceEditor.addEventListener('click', async (e) => {
    if (!(e.ctrlKey || e.metaKey) || e.button !== 0) return;
    const ta = el.mdSourceEditor;
    if (ta.selectionStart !== ta.selectionEnd) return;
    const caret = ta.selectionStart;
    const value = ta.value;
    const lineStart = value.lastIndexOf('\n', caret - 1) + 1;
    let lineEnd = value.indexOf('\n', caret);
    if (lineEnd === -1) lineEnd = value.length;
    const column = caret - lineStart;
    const candidate = findPathCandidates(value.slice(lineStart, lineEnd)).find(
      (c) => c.start <= column && column <= c.end
    );
    if (!candidate) return;

    const rootPath = projectRootFor(state.currentFilePath) || state.docRoot || state.rootPath || '';
    const baseDirs = state.currentFilePath ? [dirnameOf(state.currentFilePath), rootPath] : [rootPath];
    const [link] = await resolveLinkCandidates([candidate], baseDirs, rootPath);
    if (!link) {
      setToolbarStatus(t('link.notFound', { path: candidate.path }));
      return;
    }
    await openFileLink(link);
  });

  setupResizer(el.editorResizer, el.editorPane, 'left');

  // ---------------------------------------------------------------------
  // Messages from the tab host (main.js)
  // ---------------------------------------------------------------------

  // The open projects of the window this tab is in: on start, whenever the
  // window opens or closes one, and when the tab moves to another window.
  function setContext(context) {
    state.projects = context && Array.isArray(context.roots) ? context.roots : [];
    state.rootPath = (context && context.active) || null;
  }

  window.mdviewer.onDocContext(async (context) => {
    await appReady;
    setContext(context);
    if (!state.currentFilePath) return;
    // A document whose project has just been opened (a draft saved outside
    // every project, a tab moved here) takes on that project's styling.
    await switchProjectForPath(state.currentFilePath);
    renderBreadcrumb(state.currentFilePath);
  });

  window.mdviewer.onDocActivated((active) => {
    state.isActiveTab = !!active;
    // Coming on screen makes this the project's last open document.
    if (active) persistProjectState();
  });

  // What the tab is opened on: a document, a draft, or what the page it
  // takes over from held (a moved tab, a reloaded window).
  async function initDocument(init) {
    await appReady;
    setContext(init.context);
    state.isActiveTab = !!init.active;
    if (init.draft) {
      await startUntitledDraft();
    } else if (init.filePath) {
      // A file outside every project is viewed with the styling of the
      // window's active project, as an instant view always has been.
      if (!projectRootFor(init.filePath)) {
        await applyDocProject(state.rootPath);
        if (init.instantView) pendingInstantViewPath = init.filePath;
      }
      await loadAndRenderByPath(init.filePath);
      if (init.editMode && state.currentFilePath && !state.editMode) await enterEditMode();
    } else {
      return;
    }
    restoreHandedOver(init);
    applyDocTarget(init.target || {});
  }

  // What the page taking over from this one opens on (see initDocument).
  // The editor's undo history is the one thing that stays behind.
  function docSnapshot() {
    const ta = el.mdSourceEditor;
    const win = el.frame.contentWindow;
    const snapshot = {
      filePath: state.untitledDraft ? null : state.currentFilePath,
      draft: !!state.untitledDraft,
      instantView: !!state.instantViewPath,
      editMode: !!state.editMode,
      viewerScroll: win ? win.scrollY : 0,
      history: { back: [...state.docHistoryStack], forward: [...state.docForwardStack] },
    };
    if (state.editMode) {
      snapshot.editor = {
        // Text on disk is read again; only what isn't there travels.
        text: state.sourceDirty || state.untitledDraft ? ta.value : null,
        selection: [ta.selectionStart, ta.selectionEnd, ta.selectionDirection],
        scrollTop: ta.scrollTop,
        width: el.editorPane.style.width || '',
      };
    }
    return snapshot;
  }

  function restoreHandedOver(init) {
    if (init.history) {
      state.docHistoryStack = Array.isArray(init.history.back) ? init.history.back : [];
      state.docForwardStack = Array.isArray(init.history.forward) ? init.history.forward : [];
      updateNavButtons();
    }
    const editor = init.editor;
    if (editor && state.editMode) {
      const ta = el.mdSourceEditor;
      if (editor.width) el.editorPane.style.width = editor.width;
      if (typeof editor.text === 'string' && editor.text !== ta.value) {
        ta.value = editor.text;
        // Marks it unsaved and renders it, as typing it would have.
        ta.dispatchEvent(new Event('input', { bubbles: true }));
      }
      const [start, end, direction] = Array.isArray(editor.selection) ? editor.selection : [];
      if (Number.isInteger(start) && Number.isInteger(end)) ta.setSelectionRange(start, end, direction || 'none');
      if (Number.isFinite(editor.scrollTop)) ta.scrollTop = editor.scrollTop;
    } else if (Number.isFinite(init.viewerScroll) && el.frame.contentWindow) {
      el.frame.contentWindow.scrollTo(0, init.viewerScroll);
    }
  }

  // Questions from the tab host (see askDoc in main.js).
  window.mdviewer.onDocAsk(async ({ id, kind } = {}) => {
    await appReady;
    let value = null;
    if (kind === 'close') {
      value = await prepareToClose();
    } else if (kind === 'snapshot') {
      value = docSnapshot();
      textSettled = true;
    }
    window.mdviewer.answerDoc(id, value);
  });

  window.mdviewer.onDocInit((init) => initDocument(init || {}));

  // Another document for this tab (the preview tab taking the next click
  // in the explorer), or a spot to show in the one it has (a search hit, a
  // file link's line) when it was asked for while already open here.
  window.mdviewer.onDocNavigate(async ({ filePath, target, editMode } = {}) => {
    await appReady;
    const sameDoc =
      !filePath || (!!state.currentFilePath && normalizePath(state.currentFilePath) === normalizePath(filePath));
    if (!sameDoc) {
      if (!(await guardNavigation())) return;
      await loadAndRenderByPath(filePath);
    }
    if (editMode && state.currentFilePath && !state.editMode) await enterEditMode();
    applyDocTarget(target || {});
  });

  // A file or folder was moved in the explorer: a document inside it now
  // lives somewhere else, and so do the entries of the back/forward history.
  // main.js dropped every file watcher before the move (Windows holds a
  // handle on a watched file's folder), so the document is watched again.
  window.mdviewer.onDocPathMoved(async ({ from, to } = {}) => {
    await appReady;
    if (!from || !to) return;
    const remap = (p) => (p && isPathUnder(p, from) ? to + p.substring(from.length) : p);
    state.docHistoryStack = state.docHistoryStack.map(remap);
    state.docForwardStack = state.docForwardStack.map(remap);
    if (!state.currentFilePath) return;
    const moved = remap(state.currentFilePath);
    if (moved === state.currentFilePath) {
      window.mdviewer.watchFile(state.currentFilePath);
      return;
    }
    // Setting the path first keeps the old one, which no longer exists, out
    // of the back history.
    state.currentFilePath = moved;
    if (state.editMode) {
      // The text being edited stays; it is saved to the new place.
      renderBreadcrumb(moved);
      updateFileKindUI();
      window.mdviewer.watchFile(moved);
    } else {
      // Re-rendered from the new location so relative links and images
      // resolve against it.
      await loadAndRenderByPath(moved);
    }
  });

  // ---------------------------------------------------------------------
  // Init
  // ---------------------------------------------------------------------

  // What main.js sends right after the page loads waits for this, so it
  // never lands in a preview frame that initPreviewFrame is about to wipe.
  const appReady = (async () => {
    await initI18n();
    await loadCustomExtensions();
    state.autoSave = (await window.mdviewer.getAutoSave()) !== false;
    await initPreviewFrame();
    updateCssAppliedBadge();
  })();

  // Every listener is in place: the tab host may send the document.
  window.mdviewer.docReady();
})();
