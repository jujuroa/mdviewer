// The window page: the explorer and the open projects, project search, the
// tab strip, the terminal and the CSS editor. Each document tab is a page
// of its own (doc.html) in an iframe this page puts in a tab area (#doc-host
// here, or the same area in a tab window this page opened with window.open,
// so both run in this renderer). A tab moving to another window loads anew
// there from a snapshot of its state. main.js owns the tab list: this page
// tells it what to open and draws what it reports back (tabs:changed), and
// main.js relays what a tab asks of the window (shell:request).
(() => {
  const {
    t,
    initI18n,
    normalizePath,
    isPathUnder,
    pathToFileUrl,
    dirnameOf,
    basenameOf,
    pathBasename,
    projectRootIn,
    escapeHtml,
    isPlainTextPathWith,
    CODE_FILE_EXTENSIONS,
    fileBadgeSvg,
    treeAgeStep,
    TREE_AGE_STEPS_DAYS,
    findPathCandidates,
    resolveLinkCandidates,
    setupResizer,
  } = window.MdvCommon;

  const state = {
    // Every project folder shown in the explorer, in the order opened.
    // rootPath is the active one among them: the project of the document
    // on screen, whose CSS, search, breadcrumb and terminal apply (see
    // followActiveTab / activateProject).
    projects: [],
    rootPath: null,
    cssDirty: false,
    cssDebounceTimer: null,
    cssEnabled: true,
    terminalOpen: false,
    customTextExtensions: [],
    baseCss: '',
    hljsCss: '',
    cssRefExpanded: false,
    // The tab's fullscreen document view: this page hides everything
    // around the tab area while it is on (see onDocFullscreen).
    docFullscreen: false,
    // The tabs as main.js last reported them (see tabs:changed), and the
    // document of the one on screen.
    tabs: [],
    activeTabId: null,
    activeDocPath: null,
  };

  const el = {
    btnOpenFolder: document.getElementById('btn-open-folder'),
    btnOpenFile: document.getElementById('btn-open-file'),
    projectPath: document.getElementById('project-path'),
    btnOpenProjectFolder: document.getElementById('btn-open-project-folder'),
    tree: document.getElementById('tree'),
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
    welcomeNewDocument: document.getElementById('welcome-new-document'),
    btnImportCss: document.getElementById('btn-import-css'),
    importDropdown: document.getElementById('import-css-dropdown'),
    importRecentList: document.getElementById('import-recent-list'),
    btnImportBrowse: document.getElementById('btn-import-browse'),
    cssEnabledToggle: document.getElementById('css-enabled-toggle'),
    treeDropHint: document.getElementById('tree-drop-hint'),
    treeDropTarget: document.getElementById('tree-drop-target'),
    btnToggleSearch: document.getElementById('btn-toggle-search'),
    searchPanel: document.getElementById('search-panel'),
    searchInput: document.getElementById('search-input'),
    searchClose: document.getElementById('search-close'),
    searchOptCase: document.getElementById('search-opt-case'),
    searchOptWord: document.getElementById('search-opt-word'),
    searchOptRegex: document.getElementById('search-opt-regex'),
    searchStatus: document.getElementById('search-status'),
    searchResults: document.getElementById('search-results'),
    appShell: document.getElementById('app-shell'),
    btnToggleTerminal: document.getElementById('btn-toggle-terminal'),
    terminalPanel: document.getElementById('terminal-panel'),
    resizerTerminal: document.getElementById('resizer-terminal'),
    terminalTabs: document.getElementById('terminal-tabs'),
    btnTerminalNewTab: document.getElementById('btn-terminal-new-tab'),
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
    hiddenOverlay: document.getElementById('hidden-settings-overlay'),
    hiddenInput: document.getElementById('hidden-input'),
    btnHiddenAdd: document.getElementById('btn-hidden-add'),
    hiddenList: document.getElementById('hidden-list'),
    hiddenError: document.getElementById('hidden-error'),
    btnHiddenReset: document.getElementById('btn-hidden-reset'),
    btnCloseHiddenSettings: document.getElementById('btn-close-hidden-settings'),
    docTabs: document.getElementById('doc-tabs'),
    docHost: document.getElementById('doc-host'),
    docEmpty: document.getElementById('doc-empty'),
    shellStatus: document.getElementById('shell-status'),
  };

  function projectRootFor(filePath) {
    return projectRootIn(state.projects, filePath);
  }
  // ---------------------------------------------------------------------
  // Custom text extensions settings
  // ---------------------------------------------------------------------

  const BUILTIN_KIND_EXTENSIONS = new Set(['md', 'markdown', 'puml', 'json', 'txt', 'log', ...CODE_FILE_EXTENSIONS]);

  async function loadCustomExtensions() {
    const result = await window.mdviewer.getCustomExtensions();
    state.customTextExtensions = result.ok ? result.extensions : [];
  }

  // Rebuilds every project's top level (subfolders collapse again), leaving
  // each project row expanded or collapsed as the user had it.
  async function refreshTreeRoot() {
    for (const root of state.projects) {
      const node = findProjectNode(root);
      if (!node) continue;
      const result = await window.mdviewer.listDir(root);
      if (!result.ok) continue;
      const childrenContainer = node.querySelector(':scope > .tree-children');
      childrenContainer.innerHTML = '';
      buildTreeNodes(childrenContainer, result.items, 1);
    }
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
  // Extensions (add-on management)
  //
  // What main found (addons/registry.js) and why each add-on can or cannot
  // run; the user turns found add-ons on and off and has main look again.
  // ---------------------------------------------------------------------

  const addonsEl = {
    overlay: document.getElementById('addons-overlay'),
    list: document.getElementById('addons-list'),
    close: document.getElementById('btn-close-addons'),
    rescan: document.getElementById('btn-addons-rescan'),
  };

  function addonProblemItem(problem, warning) {
    const li = document.createElement('li');
    if (warning) li.className = 'warning';
    if (problem.path) {
      const code = document.createElement('code');
      code.textContent = problem.path;
      li.append(code, ': ');
    }
    li.append(t(`addons.problem.${problem.code}`) + (problem.detail ? ` (${problem.detail})` : ''));
    return li;
  }

  function renderAddons(list) {
    addonsEl.list.textContent = '';
    if (!list.length) {
      const empty = document.createElement('li');
      empty.className = 'ext-list-empty';
      empty.textContent = t('addons.empty');
      addonsEl.list.appendChild(empty);
      return;
    }
    for (const addon of list) {
      const item = document.createElement('li');
      item.className = 'addon-item';
      item.dataset.addonId = addon.id;
      item.dataset.source = addon.source;
      item.classList.toggle('off', !addon.enabled || addon.status !== 'ok');

      const head = document.createElement('div');
      head.className = 'addon-head';
      const name = document.createElement('span');
      name.className = 'addon-name';
      name.textContent = addon.name;
      const version = document.createElement('span');
      version.className = 'addon-version';
      version.textContent = addon.version ? `${addon.id} ${addon.version}` : addon.id;
      const status = document.createElement('span');
      const shown = addon.status === 'ok' && !addon.enabled ? 'off' : addon.status;
      status.className = `addon-status ${shown}`;
      status.textContent = t(`addons.status.${shown}`);
      head.append(name, version, status);
      if (addon.status !== 'shadowed') {
        const toggle = document.createElement('label');
        toggle.className = 'addon-toggle';
        const box = document.createElement('input');
        box.type = 'checkbox';
        box.checked = addon.enabled;
        box.addEventListener('change', async () => {
          renderAddons(await window.mdviewer.setAddonEnabled(addon.id, box.checked));
        });
        toggle.append(box, t('addons.enabled'));
        head.appendChild(toggle);
      }
      item.appendChild(head);

      if (addon.description) {
        const desc = document.createElement('div');
        desc.className = 'addon-meta';
        desc.textContent = addon.description;
        item.appendChild(desc);
      }
      const from = document.createElement('div');
      from.className = 'addon-meta';
      from.textContent = t('addons.from', { source: t(`addons.source.${addon.source}`), dir: addon.dir });
      item.appendChild(from);
      if (addon.status === 'ok' && addon.activation.length) {
        const act = document.createElement('div');
        act.className = 'addon-meta';
        act.textContent = t('addons.activation', { events: addon.activation.join(', ') });
        item.appendChild(act);
      }
      if (addon.problems.length || addon.warnings.length) {
        const problems = document.createElement('ul');
        problems.className = 'addon-problems';
        for (const p of addon.problems) problems.appendChild(addonProblemItem(p, false));
        for (const p of addon.warnings) problems.appendChild(addonProblemItem(p, true));
        item.appendChild(problems);
      }
      addonsEl.list.appendChild(item);
    }
  }

  async function openAddons() {
    renderAddons(await window.mdviewer.listAddons());
    addonsEl.overlay.classList.remove('hidden');
    addonsEl.close.focus();
  }

  function closeAddons() {
    addonsEl.overlay.classList.add('hidden');
  }

  addonsEl.close.addEventListener('click', closeAddons);
  addonsEl.overlay.addEventListener('click', (e) => {
    if (e.target === addonsEl.overlay) closeAddons();
  });
  addonsEl.overlay.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeAddons();
  });
  addonsEl.rescan.addEventListener('click', async () => renderAddons(await window.mdviewer.rescanAddons()));
  window.mdviewer.onMenuManageAddons(openAddons);
  window.mdviewer.onAddonsChanged((list) => {
    if (!addonsEl.overlay.classList.contains('hidden')) renderAddons(list);
  });

  // ---------------------------------------------------------------------
  // Hidden items settings
  // ---------------------------------------------------------------------

  // Names (or `*`/`?` patterns) left out of the tree and project search.
  // Main owns the list and the matching; this only edits it.
  const hiddenSettings = { names: [], defaults: [] };

  function renderHiddenList() {
    el.hiddenList.innerHTML = '';
    if (hiddenSettings.names.length === 0) {
      const empty = document.createElement('li');
      empty.className = 'ext-list-empty';
      empty.textContent = t('hiddenNames.empty');
      el.hiddenList.appendChild(empty);
      return;
    }
    for (const name of hiddenSettings.names) {
      const li = document.createElement('li');
      li.className = 'ext-list-item';
      const label = document.createElement('span');
      label.textContent = name;
      li.appendChild(label);
      const removeBtn = document.createElement('button');
      removeBtn.className = 'ext-list-remove';
      removeBtn.textContent = '✕';
      removeBtn.title = t('hiddenNames.removeTitle');
      removeBtn.addEventListener('click', () => saveHiddenNames(hiddenSettings.names.filter((n) => n !== name)));
      li.appendChild(removeBtn);
      el.hiddenList.appendChild(li);
    }
  }

  function showHiddenError(key) {
    el.hiddenError.textContent = t(key);
    el.hiddenError.classList.remove('hidden');
  }

  function hideHiddenError() {
    el.hiddenError.classList.add('hidden');
    el.hiddenError.textContent = '';
  }

  async function saveHiddenNames(next) {
    const result = await window.mdviewer.setHiddenNames(next);
    hiddenSettings.names = result.ok ? result.names : next;
    renderHiddenList();
    await refreshTreeRoot();
  }

  async function addHiddenName() {
    const raw = el.hiddenInput.value.trim().replace(/[\\/]+$/, '');
    if (!raw || /[\\/]/.test(raw)) {
      showHiddenError('hiddenNames.errorInvalid');
      return;
    }
    if (hiddenSettings.names.some((n) => n.toLowerCase() === raw.toLowerCase())) {
      showHiddenError('hiddenNames.errorDuplicate');
      return;
    }
    hideHiddenError();
    el.hiddenInput.value = '';
    await saveHiddenNames([...hiddenSettings.names, raw]);
  }

  async function openHiddenSettings() {
    const result = await window.mdviewer.getHiddenNames();
    hiddenSettings.names = result.ok ? result.names : [];
    hiddenSettings.defaults = result.ok ? result.defaults : [];
    hideHiddenError();
    el.hiddenInput.value = '';
    renderHiddenList();
    el.hiddenOverlay.classList.remove('hidden');
    el.hiddenInput.focus();
  }

  function closeHiddenSettings() {
    el.hiddenOverlay.classList.add('hidden');
  }

  el.btnCloseHiddenSettings.addEventListener('click', closeHiddenSettings);
  el.hiddenOverlay.addEventListener('click', (e) => {
    if (e.target === el.hiddenOverlay) closeHiddenSettings();
  });
  el.btnHiddenAdd.addEventListener('click', addHiddenName);
  el.btnHiddenReset.addEventListener('click', () => {
    hideHiddenError();
    saveHiddenNames([...hiddenSettings.defaults]);
  });
  el.hiddenInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      addHiddenName();
    } else if (e.key === 'Escape') {
      closeHiddenSettings();
    }
  });
  window.mdviewer.onMenuManageHiddenNames(openHiddenSettings);


  function isPlainTextPath(filePath) {
    return isPlainTextPathWith(state.customTextExtensions, filePath);
  }

  // ---------------------------------------------------------------------
  // Folder / file opening
  // ---------------------------------------------------------------------

  // The tab area shows, under whatever tab view main.js lays over it, the
  // welcome screen while nothing is open at all, and the "select a
  // document" note while projects are open but no tab is.
  function updateDocHostView() {
    const nothingOpen = !state.projects.length && !state.tabs.length;
    el.welcomeScreen.classList.toggle('hidden', !nothingOpen);
    el.docEmpty.classList.toggle('hidden', nothingOpen || !!state.activeTabId);
    if (nothingOpen) populateRecentList();
  }

  function isOpenProject(folderPath) {
    return state.projects.some((root) => normalizePath(root) === normalizePath(folderPath));
  }

  function findProjectNode(rootPath) {
    const rootNorm = normalizePath(rootPath);
    for (const node of el.tree.querySelectorAll(':scope > .project-node')) {
      if (normalizePath(node.dataset.projectRoot) === rootNorm) return node;
    }
    return null;
  }

  // Runs after every change to the open projects or the active one. Lets
  // the main process reopen these projects after a reload it has to do
  // itself (a language change) and tell the tabs which projects their
  // documents belong to, and keeps a terminal per project with the active
  // project's on screen.
  function syncOpenProjects() {
    window.mdviewer.setOpenProjects(state.projects, state.rootPath);
    syncTerminalSessions();
    updateDocHostView();
  }

  function markActiveProjectRow() {
    for (const node of el.tree.querySelectorAll(':scope > .project-node')) {
      const row = node.querySelector(':scope > .tree-row');
      row.classList.toggle('active-project', !!state.rootPath && node.dataset.projectRoot === state.rootPath);
    }
  }

  // A project's top-level row in the explorer: a folder row like any other
  // (so arrow keys, drops and New File treat it as one), plus the
  // project-only items on its context menu.
  function buildProjectNode(rootPath, items) {
    const node = document.createElement('div');
    node.className = 'tree-node project-node';
    node.dataset.projectRoot = rootPath;

    const row = document.createElement('div');
    row.className = 'tree-row dir project-root';
    row.style.paddingLeft = '6px';
    row.dataset.path = rootPath;
    row.title = rootPath;

    const caret = document.createElement('span');
    caret.className = 'tree-caret expanded';
    caret.textContent = '▶';
    row.appendChild(caret);

    // The app's own icon in grayscale: an emoji here was hard to tell from
    // the folder and file icons below it.
    const icon = document.createElement('span');
    icon.className = 'tree-icon';
    const iconImg = document.createElement('img');
    iconImg.className = 'tree-project-icon';
    iconImg.src = '../assets/icon.png';
    iconImg.alt = '';
    icon.appendChild(iconImg);
    row.appendChild(icon);

    const label = document.createElement('span');
    label.className = 'tree-label';
    label.textContent = pathBasename(rootPath) || rootPath;
    row.appendChild(label);

    node.appendChild(row);
    node.appendChild(buildProjectSearchBox(rootPath, node));

    const childrenContainer = document.createElement('div');
    childrenContainer.className = 'tree-children expanded';
    childrenContainer.dataset.loaded = '1';
    buildTreeNodes(childrenContainer, items, 1);
    node.appendChild(childrenContainer);

    row.addEventListener('click', () => {
      selectTreeRow(row);
      const expanded = childrenContainer.classList.toggle('expanded');
      caret.classList.toggle('expanded', expanded);
    });
    row.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      window.mdviewer.showTreeContextMenu(rootPath, rootPath, { isProjectRoot: true });
    });

    return node;
  }

  function addProjectToTree(rootPath, items) {
    state.projects.push(rootPath);
    el.tree.appendChild(buildProjectNode(rootPath, items));
    markActiveProjectRow();
    syncOpenProjects();
  }

  // What this page keeps in a project's saved state (.mdviewer/state.json):
  // the CSS editor's switch and whether it is open. The tabs save their own
  // part (open file, scroll offsets, zoom); main.js merges the parts.
  function persistProjectState() {
    if (!state.rootPath) return Promise.resolve();
    return window.mdviewer.saveProjectState(state.rootPath, {
      cssEnabled: state.cssEnabled,
      cssEditorOpen: !el.cssPane.classList.contains('hidden'),
    });
  }

  // Makes rootPath the active project: loads its CSS into the editor and
  // its panel layout. Leaves the tabs alone — callers decide what to show.
  async function applyProjectState(rootPath) {
    state.rootPath = rootPath;
    el.projectPath.textContent = rootPath;
    el.projectPath.title = rootPath;
    el.btnOpenProjectFolder.disabled = false;
    resetProjectSearch();
    markActiveProjectRow();

    const stateResult = await window.mdviewer.loadProjectState(rootPath);
    const savedState = stateResult.ok ? stateResult.state : {};

    state.cssEnabled = savedState.cssEnabled !== undefined ? savedState.cssEnabled : true;
    el.cssEnabledToggle.checked = state.cssEnabled;
    await loadProjectCss({ silent: true });

    const cssEditorOpen = !!savedState.cssEditorOpen;
    el.cssPane.classList.toggle('hidden', !cssEditorOpen);
    el.resizerRight.classList.toggle('hidden', !cssEditorOpen);

    syncOpenProjects();
    return savedState;
  }

  // Activates a project and opens its last open document in a tab, the way
  // opening it fresh always has. openLastFile: false for a caller that is
  // about to open a document of its own.
  async function activateProject(rootPath, { openLastFile = true } = {}) {
    const savedState = await applyProjectState(rootPath);
    const lastFile = openLastFile ? savedState.lastOpenFile : null;
    if (lastFile && (await window.mdviewer.statPath(lastFile)).ok) {
      await openDocument(lastFile, { editMode: !!savedState.editModeOpen });
      // Unfold the tree down to the restored document so it's visible
      // (and marked) without hunting for it in collapsed folders.
      await revealPathInTree(lastFile, { select: true });
    }
  }

  // Adds the folder to the explorer next to the projects already open (or,
  // if it's already there, switches to it) and makes it the active project.
  async function openFolder(folderPath, { openLastFile = true } = {}) {
    const existing = state.projects.find((root) => normalizePath(root) === normalizePath(folderPath));
    if (existing && existing === state.rootPath) {
      await revealPathInTree(existing, { select: true });
      return true;
    }

    // The new project's tree is the whole point of opening it; don't land
    // in a chrome-less fullscreen view of the document being left behind.
    exitDocFullscreen();

    let rootPath = existing;
    if (!rootPath) {
      const check = await window.mdviewer.listDir(folderPath);
      if (!check.ok) {
        await window.mdviewer.removeRecentProject(folderPath);
        const message = t('folder.openFailed', { error: check.error });
        // With other projects open the view stays as it is; the welcome
        // screen (and its recent list) is only on screen when none are.
        if (state.projects.length || state.tabs.length) {
          setToolbarStatus(message);
          return false;
        }
        updateDocHostView();
        const errRow = document.createElement('li');
        errRow.className = 'recent-empty';
        errRow.textContent = message;
        el.recentList.prepend(errRow);
        return false;
      }
      rootPath = folderPath;
      addProjectToTree(rootPath, check.items);
    }

    await window.mdviewer.addRecentProject(rootPath);
    await activateProject(rootPath, { openLastFile });
    const row = findTreeRow(rootPath);
    if (row) row.scrollIntoView({ block: 'nearest' });
    return true;
  }

  // Explorer > project context menu > Close Project. Its documents' tabs
  // close with it (unsaved edits asked about first); the other projects
  // stay open, and if the closed one was active, the next one takes over.
  async function closeProject(rootPath) {
    const index = state.projects.findIndex((root) => normalizePath(root) === normalizePath(rootPath));
    if (index < 0) return;
    const root = state.projects[index];
    const closingActive = root === state.rootPath;
    if (!(await window.mdviewer.closeTabsUnder([root]))) return;

    if (closingActive) await persistProjectState();

    state.projects.splice(index, 1);
    const node = findProjectNode(root);
    if (node) node.remove();
    if (selectedRow && !selectedRow.isConnected) selectedRow = null;

    if (closingActive) {
      const next = projectRootFor(state.activeDocPath) || state.projects[Math.min(index, state.projects.length - 1)];
      if (!next) {
        clearActiveProject();
      } else if (state.activeTabId || state.tabs.length) {
        // Tabs from elsewhere are still open: move the project over.
        await applyProjectState(next);
      } else {
        await activateProject(next);
      }
    }
    syncOpenProjects();
  }

  // Explorer empty-space menu > Close All Projects.
  async function closeAllProjects() {
    if (!state.projects.length) return;
    if (!(await window.mdviewer.closeTabsUnder([...state.projects]))) return;
    await persistProjectState();
    state.projects = [];
    for (const node of el.tree.querySelectorAll(':scope > .project-node')) node.remove();
    selectedRow = null;
    clearActiveProject();
    syncOpenProjects();
  }

  // Last project closed: back to the state the app starts in.
  function clearActiveProject() {
    state.rootPath = null;
    el.projectPath.textContent = t('sidebar.noFolderOpen');
    el.projectPath.title = '';
    el.btnOpenProjectFolder.disabled = true;
    resetProjectSearch();
    el.cssEditor.value = '';
    state.cssDirty = false;
    el.cssStatus.textContent = '';
    updateDocHostView();
  }

  // findProject: the file came from outside the app (double-click, command
  // line, a drop with no project open), so open the nearest ancestor folder
  // that is an mdviewer project (has a .mdviewer folder) rather than just
  // the file's own folder. Already inside an open project → stay in it.
  // The file opens in a tab of its own, at `line` when given.
  async function openSingleFile(filePath, { findProject = false, line = null } = {}) {
    if (!projectRootFor(filePath)) {
      let dir = dirnameOf(filePath);
      if (findProject) {
        const projectRoot = await window.mdviewer.findProjectRoot(filePath);
        if (projectRoot) dir = projectRoot;
      }
      const opened = await openFolder(dir, { openLastFile: false });
      if (!opened) return;
    }
    await openDocument(filePath, { target: line ? { line } : null });
    await revealPathInTree(filePath, { select: true });
  }

  // Opens a document in a tab (main.js picks it: the tab already showing
  // it, else a new one). focus: false leaves the keyboard here rather than
  // in the tab.
  function openDocument(filePath, { editMode = false, target = null, focus = true } = {}) {
    exitDocFullscreen();
    return window.mdviewer.openTab(filePath, { editMode, target, focus });
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

  // A file just modified (saved here, or changed on disk while open) is
  // as recent as it gets; drop its fade without rebuilding the tree.
  function markTreeRowFresh(filePath) {
    const row = findTreeRow(filePath);
    if (!row) return;
    for (let step = 1; step <= TREE_AGE_STEPS_DAYS.length; step++) row.classList.remove('age-' + step);
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
          : item.isHtml
          ? ' html'
          : item.isPdf
          ? ' pdf'
          : item.isPlainText
          ? ' plaintext'
          : ' non-md');
      row.style.paddingLeft = 6 + depth * indentUnit + 'px';
      row.dataset.path = item.path;
      const ageStep = item.isDir ? 0 : treeAgeStep(item.mtimeMs);
      if (ageStep) row.classList.add('age-' + ageStep);
      if (item.isHidden) row.classList.add('dot-entry');
      // markActiveDocRow() can only mark rows that exist when it runs, so a
      // subtree built later (a folder expanded for the first time, a refresh,
      // the whole tree after reopening a project) re-applies the marker for
      // itself as it goes.
      if (
        !item.isDir &&
        state.activeDocPath &&
        normalizePath(item.path) === normalizePath(state.activeDocPath)
      ) {
        row.classList.add('active-doc');
      }

      const caret = document.createElement('span');
      caret.className = 'tree-caret';
      caret.textContent = item.isDir ? '▶' : '';
      row.appendChild(caret);

      const icon = document.createElement('span');
      icon.className = 'tree-icon';
      const badgeKind = item.isDir
        ? null
        : item.isMarkdown
        ? 'md'
        : item.isPuml
        ? 'puml'
        : item.isJson
        ? 'json'
        : item.isHtml
        ? 'html'
        : item.isPdf
        ? 'pdf'
        : item.isPlainText
        ? 'text'
        : null;
      if (badgeKind) icon.innerHTML = fileBadgeSvg(badgeKind, item.name);
      else icon.textContent = item.isDir ? '📁' : '·';
      row.appendChild(icon);

      const label = document.createElement('span');
      label.className = 'tree-label';
      label.textContent = item.name;
      row.appendChild(label);

      node.appendChild(row);

      row.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        window.mdviewer.showTreeContextMenu(item.path, projectRootFor(item.path) || state.rootPath);
      });

      // Dragging a row moves the entry to another folder (see the tree's
      // internal-move handlers next to the external-file drop code).
      row.draggable = true;
      row.addEventListener('dragstart', (e) => beginTreeMoveDrag(e, row));

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
      } else if (item.isMarkdown || item.isPuml || item.isJson || item.isHtml || item.isPdf || item.isPlainText) {
        // A click opens the document in a tab (or brings forward the tab
        // already showing it).
        row.addEventListener('click', () => {
          selectTreeRow(row);
          openDocument(item.path);
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
    // A project nested in another open project also shows up as a folder
    // inside the outer one; its own top-level row is the one meant.
    const projectNode = findProjectNode(targetPath);
    if (projectNode) return projectNode.querySelector(':scope > .tree-row');
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
    if (!state.projects.length) return;
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
    if (!state.projects.length) return;

    // A project root is a folder row too, so this covers creating at the
    // top of a project as well.
    const dirRow = findTreeRow(targetDir);
    if (!dirRow) return; // target folder isn't currently visible in the tree
    const parentContainer = dirRow.parentElement.querySelector(':scope > .tree-children');
    if (!parentContainer) return;
    const depth = treeRowDepth(dirRow) + 1;
    if (!parentContainer.classList.contains('expanded') || parentContainer.dataset.loaded !== '1') {
      parentContainer.classList.add('expanded');
      const caret = dirRow.querySelector('.tree-caret');
      if (caret) caret.classList.add('expanded');
      parentContainer.innerHTML = '';
      parentContainer.dataset.loaded = '1';
      await renderTreeLevel(parentContainer, targetDir, depth, 16);
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
    if (kind === 'folder') icon.textContent = '📁';
    else icon.innerHTML = fileBadgeSvg('md');
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
      if (kind === 'file') await openDocument(result.path);
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

  // Renames an entry in place (F2 or the Rename menu item): the row's label
  // turns into a text box holding the current name, with the part before
  // the extension selected. Enter renames, Escape or clicking away cancels.
  // Project rows aren't renamed here (see the tree context menu in main.js).
  function beginRenameTreeEntry(row) {
    if (!row || !row.dataset.path) return;
    if (row.parentElement.classList.contains('project-node')) return;
    if (row.classList.contains('tree-row-editing')) return;
    const label = row.querySelector(':scope > .tree-label');
    if (!label) return;

    const stale = el.tree.querySelector('.tree-row-editing');
    if (stale) {
      const staleInput = stale.querySelector('.tree-new-input');
      if (staleInput) staleInput.blur();
    }

    const sourcePath = row.dataset.path;
    const oldName = pathBasename(sourcePath);
    const isDir = row.classList.contains('dir');

    const input = document.createElement('input');
    input.className = 'tree-new-input';
    input.type = 'text';
    input.spellcheck = false;
    input.value = oldName;
    // The row's own click/dblclick would open or toggle it, and dragging the
    // row would start a move; neither should happen from inside the box.
    for (const type of ['click', 'dblclick', 'mousedown', 'contextmenu']) {
      input.addEventListener(type, (e) => e.stopPropagation());
    }
    const wasDraggable = row.draggable;
    row.draggable = false;
    row.classList.add('tree-row-editing');
    label.style.display = 'none';
    label.after(input);
    input.focus();
    const dot = isDir ? -1 : oldName.lastIndexOf('.');
    input.setSelectionRange(0, dot > 0 ? dot : oldName.length);

    let settled = false;
    let submitting = false;
    const finish = () => {
      settled = true;
      input.remove();
      label.style.display = '';
      row.classList.remove('tree-row-editing');
      row.draggable = wasDraggable;
    };

    input.addEventListener('keydown', async (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        finish();
        el.tree.focus({ preventScroll: true });
        return;
      }
      if (e.key !== 'Enter') return;
      e.preventDefault();
      if (settled || submitting) return;
      const newName = input.value.trim();
      if (!newName || newName === oldName) {
        finish();
        el.tree.focus({ preventScroll: true });
        return;
      }

      submitting = true;
      input.classList.remove('tree-new-input-error');
      const result = await window.mdviewer.renameEntry(sourcePath, newName);
      submitting = false;

      if (!result.ok) {
        input.classList.add('tree-new-input-error');
        input.title = result.error || '';
        setToolbarStatus(t('rename.failed', { name: oldName, error: result.error || '' }));
        return;
      }
      finish();
      if (result.unchanged) return;
      await refreshTreeDir(dirnameOf(sourcePath));
      await revealPathInTree(result.path, { select: true });
      setToolbarStatus(t('rename.renamed', { name: oldName, newName: pathBasename(result.path) }));
    });

    input.addEventListener('blur', () => {
      setTimeout(() => {
        if (!settled && !submitting) finish();
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

  // The "this is the document you're reading" marker, deliberately separate
  // from the selection above: selection follows the last click or arrow key
  // (a folder row included), while this one stays on whatever the preview is
  // showing. Without it, opening a document and then poking around the tree
  // leaves nothing pointing at the open file.
  //
  // Rows are matched by path rather than remembered by reference, since the
  // tree rebuilds itself often (refresh, new file, reopened project) and any
  // remembered element would be detached from the DOM by then.
  function markActiveDocRow() {
    for (const row of el.tree.querySelectorAll('.tree-row.active-doc')) {
      row.classList.remove('active-doc');
    }
    if (!state.activeDocPath) return;
    const row = findTreeRow(state.activeDocPath);
    if (row) row.classList.add('active-doc');
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
    // Text boxes inside the tree (a project's search box, a new-entry name)
    // need their arrows, Enter and Space for themselves.
    if (e.target instanceof HTMLInputElement) return;
    if (e.key === 'F2') {
      if (!selectedRow) return;
      e.preventDefault();
      beginRenameTreeEntry(selectedRow);
      return;
    }
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

//@@PERSIST@@
  async function revealPathInTree(targetPath, { select = false } = {}) {
    if (!state.projects.length) return;
    const targetNorm = normalizePath(targetPath);

    let container = el.tree;
    let depth = 0;
    let matchedRow = null;

    while (container) {
      // Only the top level (project rows) can hold more than one match,
      // when projects nest — the innermost one is where the path lives.
      const rows = Array.from(container.querySelectorAll(':scope > .tree-node > .tree-row'));
      const ancestorRow = rows
        .filter((r) => isPathUnder(targetPath, r.dataset.path))
        .sort((a, b) => b.dataset.path.length - a.dataset.path.length)[0];
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

  // A search box and the results it lists. The sidebar's search panel is
  // one (it searches the active project); every project row in the explorer
  // also has its own inline one, scoped to that project. Each view keeps its
  // own options, debounce, in-flight search and selected row, so typing in
  // one never disturbs another.
  function createSearchView({ input, status, results, optCase, optWord, optRegex, rootPath, isShown, onQueryChange }) {
    return {
      input,
      status,
      results,
      optCase,
      optWord,
      optRegex,
      rootPath, // () => the folder this view searches, or null
      isShown, // () => whether the box is on screen (to hand the caret back)
      onQueryChange: onQueryChange || null,
      activeSearchId: null,
      debounceTimer: null,
      selectedRow: null,
    };
  }

  function searchOptionsFromUI(view) {
    return {
      caseSensitive: view.optCase.classList.contains('active'),
      wholeWord: view.optWord.classList.contains('active'),
      useRegex: view.optRegex.classList.contains('active'),
    };
  }

  function setSearchStatus(view, text, isError = false) {
    view.status.textContent = text;
    view.status.classList.toggle('error', isError && !!text);
  }

  function clearSearchResults(view) {
    view.results.innerHTML = '';
    view.selectedRow = null;
  }

  // Tells the main process to stop walking for the view's in-flight search.
  // Its IPC promise still resolves, but runProjectSearch ignores any result
  // that isn't from the newest search the view issued.
  function cancelActiveSearch(view) {
    if (!view.activeSearchId) return;
    window.mdviewer.cancelSearch(view.activeSearchId);
    view.activeSearchId = null;
  }

  function resetSearchView(view) {
    cancelActiveSearch(view);
    clearTimeout(view.debounceTimer);
    clearSearchResults(view);
    setSearchStatus(view, '');
  }

  function scheduleProjectSearch(view, { immediate = false } = {}) {
    clearTimeout(view.debounceTimer);
    const query = view.input.value;
    if (!query || (!immediate && query.length < SEARCH_MIN_AUTO_CHARS)) {
      cancelActiveSearch(view);
      clearSearchResults(view);
      setSearchStatus(view, '');
      return;
    }
    if (immediate) {
      runProjectSearch(view);
    } else {
      view.debounceTimer = setTimeout(() => runProjectSearch(view), SEARCH_DEBOUNCE_MS);
    }
  }

  async function runProjectSearch(view) {
    const query = view.input.value;
    if (!query) return;
    const rootPath = view.rootPath();
    if (!rootPath) {
      clearSearchResults(view);
      setSearchStatus(view, t('search.openFolderFirst'), true);
      return;
    }

    cancelActiveSearch(view);
    const searchId = 'search-' + ++searchSeq;
    view.activeSearchId = searchId;
    setSearchStatus(view, t('search.searching'));

    const result = await window.mdviewer.searchProject(rootPath, query, {
      ...searchOptionsFromUI(view),
      searchId,
    });

    // Superseded by a newer search while this one was running.
    if (view.activeSearchId !== searchId) return;
    view.activeSearchId = null;

    if (!result.ok) {
      clearSearchResults(view);
      setSearchStatus(
        view,
        result.invalidPattern ? t('search.invalidPattern') : t('search.failed', { error: result.error }),
        true
      );
      return;
    }
    if (result.canceled) return;
    renderSearchResults(view, result);
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

  function buildSearchFileGroup(view, file) {
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

      matchRow.addEventListener('click', () => openSearchMatch(view, file, match, matchRow));
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

  function renderSearchResults(view, result) {
    clearSearchResults(view);

    if (!result.files.length) {
      setSearchStatus(view, t('search.noResults'));
      return;
    }
    setSearchStatus(
      view,
      t(result.truncated ? 'search.summaryTruncated' : 'search.summary', {
        matches: result.totalMatches,
        files: result.files.length,
      })
    );

    const frag = document.createDocumentFragment();
    for (const file of result.files) frag.appendChild(buildSearchFileGroup(view, file));
    view.results.appendChild(frag);
  }

  function visibleSearchMatchRows(view) {
    // Rows inside a collapsed file group stay in the DOM but have no
    // offsetParent, the same trick getVisibleTreeRows uses.
    return Array.from(view.results.querySelectorAll('.search-match')).filter(
      (row) => row.offsetParent !== null
    );
  }

  function selectSearchRow(view, row) {
    if (view.selectedRow) view.selectedRow.classList.remove('selected');
    view.selectedRow = row || null;
    if (row) {
      row.classList.add('selected');
      row.scrollIntoView({ block: 'nearest' });
    }
  }

  function stepSearchSelection(view, delta) {
    const rows = visibleSearchMatchRows(view);
    if (!rows.length) return;
    const current = view.selectedRow ? rows.indexOf(view.selectedRow) : -1;
    if (current === -1) {
      selectSearchRow(view, delta > 0 ? rows[0] : rows[rows.length - 1]);
      return;
    }
    selectSearchRow(view, rows[Math.min(Math.max(current + delta, 0), rows.length - 1)]);
  }

  // Opens the hit's document in a tab, whose find bar then highlights the
  // match and scrolls to it (see applyDocTarget in doc.js).
  async function openSearchMatch(view, file, match, rowEl) {
    // The search box keeps the keyboard, so the user can keep
    // typing/arrowing through the results.
    await openDocument(file.path, { target: { searchMatch: match }, focus: false });
    // A project's inline results stand in for its tree, so there is no
    // row on screen to reveal there; the panel hides the whole tree but
    // keeps it in sync for when it closes.
    if (view === panelSearch) await revealPathInTree(file.path, { select: true });
    // Clicking a result (or revealPathInTree selecting a row) moves focus to
    // the tree; the caret goes back to the search box.
    if (view.isShown()) view.input.focus({ preventScroll: true });
    selectSearchRow(view, rowEl);
  }

  function toggleSearchOption(view, button) {
    button.classList.toggle('active');
    scheduleProjectSearch(view, { immediate: true });
  }

  // Typing, the option toggles and the result-list keys, shared by every
  // search box. Escape is the box's own business (close vs. clear).
  function bindSearchView(view, { onEscape }) {
    view.optCase.addEventListener('click', () => toggleSearchOption(view, view.optCase));
    view.optWord.addEventListener('click', () => toggleSearchOption(view, view.optWord));
    view.optRegex.addEventListener('click', () => toggleSearchOption(view, view.optRegex));

    view.input.addEventListener('input', () => {
      selectSearchRow(view, null);
      scheduleProjectSearch(view);
      if (view.onQueryChange) view.onQueryChange();
    });

    view.input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        stepSearchSelection(view, e.key === 'ArrowDown' ? 1 : -1);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        // Once a result is picked, Enter opens it; before that it's the
        // "search now" key (which also covers queries too short to auto-run).
        if (view.selectedRow) view.selectedRow.click();
        else scheduleProjectSearch(view, { immediate: true });
      } else if (e.key === 'Escape') {
        e.preventDefault();
        onEscape();
      }
    });
  }

  // --- The sidebar's search panel (Ctrl+Shift+F): replaces the tree ---

  const panelSearch = createSearchView({
    input: el.searchInput,
    status: el.searchStatus,
    results: el.searchResults,
    optCase: el.searchOptCase,
    optWord: el.searchOptWord,
    optRegex: el.searchOptRegex,
    rootPath: () => state.rootPath,
    isShown: () => searchPanelOpen(),
  });

  function searchPanelOpen() {
    return !el.searchPanel.classList.contains('hidden');
  }

  function resetProjectSearch() {
    resetSearchView(panelSearch);
  }

  function openSearchPanel() {
    exitDocFullscreen();
    el.searchPanel.classList.remove('hidden');
    el.tree.classList.add('hidden');
    el.btnToggleSearch.classList.add('active');
    el.searchInput.focus();
    el.searchInput.select();
    if (!state.rootPath) setSearchStatus(panelSearch, t('search.openFolderFirst'), true);
  }

  function closeSearchPanel() {
    cancelActiveSearch(panelSearch);
    clearTimeout(panelSearch.debounceTimer);
    el.searchPanel.classList.add('hidden');
    el.tree.classList.remove('hidden');
    el.btnToggleSearch.classList.remove('active');
    el.tree.focus({ preventScroll: true });
  }

  function toggleSearchPanel() {
    if (searchPanelOpen()) closeSearchPanel();
    else openSearchPanel();
  }

  el.btnToggleSearch.addEventListener('click', toggleSearchPanel);
  el.searchClose.addEventListener('click', closeSearchPanel);
  bindSearchView(panelSearch, { onEscape: closeSearchPanel });

  window.mdviewer.onMenuSearchProject(openSearchPanel);

  // --- A project's inline search box, right under its row in the tree ---
  //
  // Searches just that project. While it holds a query the project's file
  // tree is swapped for the results (the .searching class); clearing the
  // box brings the tree back.

  function buildProjectSearchBox(rootPath, projectNode) {
    const wrap = document.createElement('div');
    wrap.className = 'project-search';

    const box = document.createElement('div');
    box.className = 'project-search-box';

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'project-search-input';
    input.spellcheck = false;
    input.placeholder = t('search.projectPlaceholder');

    const makeOpt = (label, titleKey, extraClass) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'search-opt' + (extraClass ? ' ' + extraClass : '');
      btn.textContent = label;
      btn.title = t(titleKey);
      return btn;
    };
    const optCase = makeOpt('Aa', 'search.caseTitle');
    const optWord = makeOpt('ab', 'search.wordTitle', 'search-opt-word');
    const optRegex = makeOpt('.*', 'search.regexTitle');

    const clear = document.createElement('button');
    clear.type = 'button';
    clear.className = 'search-close hidden';
    clear.textContent = '✕';
    clear.title = t('search.clearTitle');

    box.append(input, optCase, optWord, optRegex, clear);

    const status = document.createElement('div');
    status.className = 'search-status';
    const results = document.createElement('div');
    results.className = 'search-results';

    wrap.append(box, status, results);

    const syncSearching = () => {
      const searching = !!input.value;
      projectNode.classList.toggle('searching', searching);
      clear.classList.toggle('hidden', !searching);
    };

    const view = createSearchView({
      input,
      status,
      results,
      optCase,
      optWord,
      optRegex,
      rootPath: () => rootPath,
      isShown: () => input.isConnected && input.offsetParent !== null,
      onQueryChange: syncSearching,
    });

    const clearQuery = () => {
      input.value = '';
      resetSearchView(view);
      syncSearching();
    };

    clear.addEventListener('click', () => {
      clearQuery();
      input.focus();
    });
    bindSearchView(view, {
      // First Escape clears the query; on an empty box it hands the
      // keyboard back to the tree.
      onEscape: () => {
        if (input.value) clearQuery();
        else el.tree.focus({ preventScroll: true });
      },
    });

    return wrap;
  }

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

  // The editor's text shows live in every tab of the project it styles,
  // saved or not (see onLiveCss in doc.js).
  function applyLiveCss() {
    if (state.rootPath) window.mdviewer.broadcastLiveCss(state.rootPath, el.cssEditor.value, state.cssEnabled);
    renderCssRefTree();
  }

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

  // Right-clicking empty tree space (not any specific row) gets the menu
  // for the explorer as a whole: new/open project, close them all.
  // Row-level contextmenu handlers (see buildTreeNodes) don't call
  // stopPropagation, so this only fires when the click didn't land on a row.
  el.tree.addEventListener('contextmenu', (e) => {
    if (e.target.closest('.tree-row, .project-search')) return;
    e.preventDefault();
    window.mdviewer.showTreeEmptyContextMenu({ hasProjects: state.projects.length > 0 });
  });

  window.mdviewer.onTreeCreateNew(({ targetDir, kind }) => {
    beginCreateTreeEntry({ targetDir, kind });
  });

  window.mdviewer.onTreeRename(async ({ itemPath }) => {
    // From a document tab the file's row may sit in a collapsed folder.
    if (!findTreeRow(itemPath)) await revealPathInTree(itemPath);
    const row = findTreeRow(itemPath);
    if (!row) return;
    selectTreeRow(row);
    beginRenameTreeEntry(row);
  });

  window.mdviewer.onTreeRefreshDir(({ targetDir }) => {
    refreshTreeDir(targetDir);
  });

  window.mdviewer.onTreeCloseProject(({ rootPath }) => {
    closeProject(rootPath);
  });

  window.mdviewer.onTreeCloseAllProjects(() => {
    closeAllProjects();
  });

  // After a reload the main process did itself (a language change): put
  // every project back in the explorer, in order, then reactivate the one
  // that was active.
  window.mdviewer.onRestoreProjects(async ({ roots, active, tabs, activeTab } = {}) => {
    await appReady;
    for (const root of roots || []) {
      if (isOpenProject(root)) continue;
      const result = await window.mdviewer.listDir(root);
      if (result.ok) addProjectToTree(root, result.items);
    }
    const target = (active && isOpenProject(active) && active) || state.projects[0];
    // After a relaunch the tabs come back as they were; otherwise (and
    // after a reload of just this page, whose tabs never went away) the
    // active project opens the way it always has.
    if (Array.isArray(tabs) && tabs.length) {
      if (target) await applyProjectState(target);
      await window.mdviewer.restoreTabs(tabs, activeTab);
    } else if (target && !state.tabs.length) {
      await openFolder(target);
    } else if (target) {
      await applyProjectState(target);
    }
  });

  // "Convert to SVG" writes the file with no dialog of any kind, so this
  // line is what tells the user it happened (see convertPumlToSvg in
  // main.js; the tree refresh above shows the file itself).
  window.mdviewer.onPumlSvgConverted(({ outPath }) => {
    setToolbarStatus(t('export.svgSaved', { name: pathBasename(outPath) }));
  });

  window.mdviewer.onViewerHtmlCopied(({ name }) => {
    setToolbarStatus(t('export.htmlCopied', { name }));
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

  window.mdviewer.onOpenPathFromOS(async (filePath) => {
    await appReady;
    openSingleFile(filePath, { findProject: true });
  });

  window.mdviewer.onOpenFolderFromOS(async (folderPath) => {
    await appReady;
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
  // The tree is here; the viewer is in the tab's own page (doc.js), which
  // takes its drops itself.

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
    return /\.(md|markdown|puml|json|pdf)$/i.test(filePath) || isPlainTextPath(filePath);
  }

  // The window's one-line status slot, at the end of the tab strip, shared
  // by everything here that finishes without a dialog of its own: drop and
  // move results, SVG conversion. It clears itself after a while.
  const SHELL_STATUS_MS = 8000;
  let shellStatusTimer = null;
  function setToolbarStatus(message) {
    el.shellStatus.textContent = message;
    el.shellStatus.title = message;
    clearTimeout(shellStatusTimer);
    if (message) shellStatusTimer = setTimeout(() => setToolbarStatus(''), SHELL_STATUS_MS);
  }

  function setTreeDropRow(row) {
    if (treeDropRow === row) return;
    if (treeDropRow) treeDropRow.classList.remove('drop-target');
    treeDropRow = row;
    if (treeDropRow) treeDropRow.classList.add('drop-target');
  }

  function setDropAffordance(active) {
    const canCopy = active && !!state.rootPath;
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
      setToolbarStatus(t('drop.noProject'));
      return;
    }
    if (!paths.length || !targetDir) return;

    const result = await window.mdviewer.copyEntries(targetDir, paths);
    if (!result.ok) {
      setToolbarStatus(t('drop.copyFailed', { error: result.error }));
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
    setToolbarStatus(message);

    if (result.copied.length) await revealPathInTree(result.copied[0].path, { select: true });
  });

  // ---- Moving entries inside the tree by drag and drop ----
  //
  // A row drag carries its own data type rather than 'Files', so none of the
  // external-drop handlers above react to it (no copy hint, no viewer
  // overlay); these handlers only react to it. Holding Ctrl while dropping
  // copies the entry instead, as in a native file explorer.

  const TREE_MOVE_TYPE = 'application/x-mdviewer-tree-path';
  const TREE_MOVE_EXPAND_DELAY_MS = 700;
  let treeMoveSource = null;
  let treeMoveExpandTimer = null;
  let treeMoveExpandRow = null;

  function beginTreeMoveDrag(e, row) {
    treeMoveSource = row.dataset.path;
    e.dataTransfer.setData(TREE_MOVE_TYPE, treeMoveSource);
    e.dataTransfer.effectAllowed = 'copyMove';
    row.classList.add('tree-row-dragging');
  }

  function isTreeMoveDrag(e) {
    const types = e.dataTransfer && e.dataTransfer.types;
    return !!treeMoveSource && !!types && Array.prototype.includes.call(types, TREE_MOVE_TYPE);
  }

  // Where a move would land, or null when dropping there would do nothing
  // (its own folder) or is impossible (a folder into itself or below it).
  function treeMoveTargetDir(e) {
    const targetDir = treeDropTargetDir(e);
    if (!targetDir || !treeMoveSource) return null;
    if (normalizePath(targetDir) === normalizePath(dirnameOf(treeMoveSource))) return null;
    if (isPathUnder(targetDir, treeMoveSource)) return null;
    return targetDir;
  }

  // Where a Ctrl-drag copy would land. Unlike a move, its own folder is a
  // fine target: the copy gets a numbered name there (see copyEntriesInto).
  function treeCopyTargetDir(e) {
    const targetDir = treeDropTargetDir(e);
    if (!targetDir || !treeMoveSource) return null;
    if (isPathUnder(targetDir, treeMoveSource)) return null;
    return targetDir;
  }

  function clearTreeMoveExpand() {
    clearTimeout(treeMoveExpandTimer);
    treeMoveExpandTimer = null;
    treeMoveExpandRow = null;
  }

  // Hovering a collapsed folder for a moment opens it, so a deep target can
  // be reached without letting go of the drag.
  function scheduleTreeMoveExpand(row) {
    if (row === treeMoveExpandRow) return;
    clearTreeMoveExpand();
    if (!row || !row.classList.contains('dir')) return;
    const childrenContainer = row.parentElement.querySelector(':scope > .tree-children');
    if (!childrenContainer || childrenContainer.classList.contains('expanded')) return;
    treeMoveExpandRow = row;
    treeMoveExpandTimer = setTimeout(async () => {
      treeMoveExpandTimer = null;
      childrenContainer.classList.add('expanded');
      const caret = row.querySelector('.tree-caret');
      if (caret) caret.classList.add('expanded');
      if (childrenContainer.dataset.loaded !== '1') {
        childrenContainer.dataset.loaded = '1';
        await renderTreeLevel(childrenContainer, row.dataset.path, treeRowDepth(row) + 1, 16);
      }
    }, TREE_MOVE_EXPAND_DELAY_MS);
  }

  function endTreeMoveDrag() {
    const dragging = el.tree.querySelector('.tree-row-dragging');
    if (dragging) dragging.classList.remove('tree-row-dragging');
    treeMoveSource = null;
    clearTreeMoveExpand();
    setTreeDropRow(null);
  }

  el.tree.addEventListener('dragover', (e) => {
    if (!isTreeMoveDrag(e)) return;
    e.preventDefault();
    const row = e.target.closest('.tree-row');
    scheduleTreeMoveExpand(row);
    const copy = e.ctrlKey;
    const targetDir = copy ? treeCopyTargetDir(e) : treeMoveTargetDir(e);
    e.dataTransfer.dropEffect = targetDir ? (copy ? 'copy' : 'move') : 'none';
    setTreeDropRow(targetDir ? findTreeRow(targetDir) : null);
  });

  el.tree.addEventListener('dragleave', (e) => {
    if (!isTreeMoveDrag(e)) return;
    if (!el.tree.contains(e.relatedTarget)) {
      setTreeDropRow(null);
      clearTreeMoveExpand();
    }
  });

  el.tree.addEventListener('dragend', endTreeMoveDrag);

  el.tree.addEventListener('drop', async (e) => {
    if (!isTreeMoveDrag(e)) return;
    e.preventDefault();
    e.stopPropagation();
    const sourcePath = treeMoveSource;
    const copy = e.ctrlKey;
    const targetDir = copy ? treeCopyTargetDir(e) : treeMoveTargetDir(e);
    endTreeMoveDrag();
    if (!targetDir) return;
    if (copy) await copyTreeEntry(sourcePath, targetDir);
    else await moveTreeEntry(sourcePath, targetDir);
  });

  async function copyTreeEntry(sourcePath, targetDir) {
    const name = pathBasename(sourcePath);
    const dirLabel = pathBasename(targetDir) || targetDir;
    const result = await window.mdviewer.copyEntries(targetDir, [sourcePath]);
    if (!result.ok || !result.copied.length) {
      const skip = result.ok ? result.skipped[0] : null;
      const key = skip && skip.reason === 'intoItself' ? 'copy.intoItself' : 'copy.failed';
      const error = result.ok ? (skip && skip.error) || '' : result.error;
      setToolbarStatus(t(key, { name, error }));
      return;
    }
    await refreshTreeDir(targetDir);
    await revealPathInTree(result.copied[0].path, { select: true });
    setToolbarStatus(t('copy.copied', { name: result.copied[0].name, dir: dirLabel }));
  }

  // The documents open in tabs follow their files on their own: main.js
  // tells every tab about the move (see fs:move-entry), and a tab with
  // unsaved edits keeps them and saves them to the new place.
  async function moveTreeEntry(sourcePath, targetDir) {
    const name = pathBasename(sourcePath);
    const result = await window.mdviewer.moveEntry(sourcePath, targetDir);
    if (!result.ok || result.unchanged) {
      if (!result.ok) {
        const dirLabel = pathBasename(targetDir) || targetDir;
        const key =
          result.code === 'exists'
            ? 'move.exists'
            : result.code === 'intoItself'
            ? 'move.intoItself'
            : 'move.failed';
        setToolbarStatus(t(key, { name, dir: dirLabel, error: result.error || '' }));
      }
      return;
    }

    const newPath = result.path;

    // Refresh the folder it left and the one it arrived in; when one holds
    // the other, rebuilding the outer one covers both.
    const sourceDir = dirnameOf(sourcePath);
    if (isPathUnder(targetDir, sourceDir)) {
      await refreshTreeDir(sourceDir);
    } else if (isPathUnder(sourceDir, targetDir)) {
      await refreshTreeDir(targetDir);
    } else {
      await refreshTreeDir(sourceDir);
      await refreshTreeDir(targetDir);
    }

    await revealPathInTree(newPath, { select: true });
    setToolbarStatus(t('move.moved', { name, dir: pathBasename(targetDir) || targetDir }));
  }

  // ---------------------------------------------------------------------
  // File links: Ctrl+click on a file name in the terminal or the source
  // editor opens that file, at the line when one is written after it
  // (`docs/guide.md:42`, as compilers and grep print it).
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

    const line = link.line || null;
    if (!isViewablePath(target)) {
      // Hands anything the app cannot show to the OS.
      const result = await window.mdviewer.openExternal(pathToFileUrl(target));
      if (!result || !result.ok) {
        console.error('[mdviewer] Failed to open externally:', target, result && result.error);
      }
    } else if (!projectRootFor(target)) {
      // Outside every open project: open it the way "Open File" does, in
      // the nearest project above it.
      await openSingleFile(target, { findProject: true, line });
    } else {
      await openDocument(target, { target: line ? { line } : null });
    }
  }

  // The cells of one logical terminal line — a long line the terminal
  // wrapped spans several rows — as a string, with a way back from string
  // offsets to cell positions. Wide (CJK) characters take two cells, so the
  // two don't line up one to one.
  function readTerminalLogicalLine(term, row) {
    const buffer = term.buffer.active;
    let first = row;
    while (first > 0 && buffer.getLine(first) && buffer.getLine(first).isWrapped) first--;
    let last = row;
    while (buffer.getLine(last + 1) && buffer.getLine(last + 1).isWrapped) last++;

    const cell = buffer.getNullCell();
    const cells = []; // per UTF-16 offset: { x, y, width }, 1-based
    let text = '';
    for (let y = first; y <= last; y++) {
      const line = buffer.getLine(y);
      if (!line) break;
      for (let x = 0; x < line.length; x++) {
        line.getCell(x, cell);
        const width = cell.getWidth();
        // The second half of a wide character.
        if (width === 0) continue;
        const chars = cell.getChars() || ' ';
        for (let i = 0; i < chars.length; i++) cells.push({ x: x + 1, y: y + 1, width });
        text += chars;
      }
    }
    return {
      text,
      rangeFor(start, end) {
        const a = cells[start];
        const b = cells[end - 1];
        return { start: { x: a.x, y: a.y }, end: { x: b.x + b.width - 1, y: b.y } };
      },
    };
  }

  // The shell's working directory isn't visible to the app, so paths are
  // resolved against the folder the tab was opened in and its project,
  // falling back to any project file whose path ends with what was printed
  // (see resolveLinkPath in main.js).
  function registerTerminalFileLinks(term, cwd, rootPath, container) {
    const baseDirs = [cwd, rootPath].filter((dir, i, all) => dir && all.indexOf(dir) === i);
    term.registerLinkProvider({
      provideLinks(y, callback) {
        const row = readTerminalLogicalLine(term, y - 1);
        const candidates = findPathCandidates(row.text);
        if (!candidates.length) {
          callback(undefined);
          return;
        }
        resolveLinkCandidates(candidates, baseDirs, rootPath).then(
          (links) => {
            callback(
              links.map((link) => ({
                range: row.rangeFor(link.start, link.end),
                text: row.text.slice(link.start, link.end),
                decorations: { pointerCursor: true, underline: true },
                activate: (event) => {
                  if (event.ctrlKey || event.metaKey) openFileLink(link);
                },
                hover: () => {
                  container.title = t('link.ctrlClickToOpen');
                },
                leave: () => {
                  container.title = '';
                },
              }))
            );
          },
          () => callback(undefined)
        );
      },
    });
  }

  // ---------------------------------------------------------------------
  // Bottom terminal panel
  // ---------------------------------------------------------------------

  // Every shell is a tab. Each open project gets one of its own, started
  // together when the panel opens; more come from the "+" button and from
  // "Open in Terminal", and each can be closed on its own. A tab belongs to
  // a project (projectKey: its root, '' for the home-folder shell used
  // while no project is open) and goes when that project is closed.
  // Switching projects brings up the tab last used in that project. The
  // tab's id is the key main.js files its PTY under.
  // The tabs are shown grouped by project, in the explorer's project
  // order, and in this map's order within a group (see
  // renderTerminalTabLabels).
  const terminalSessions = new Map(); // id -> { id, cwd, liveCwd, projectKey, term, fitAddon, container, tab, started }
  const lastTerminalByProject = new Map(); // projectKey -> id
  let activeTerminalId = null;
  let terminalSeq = 0;
  // The projects and the active one as of the last sync, so a sync can tell
  // a newly opened project, and a project switch, from a plain refresh.
  let terminalProjectsSeen = [];
  let terminalShownRoot = null;

  function activeTerminalKey() {
    return state.rootPath || '';
  }

  function activeTerminal() {
    return terminalSessions.get(activeTerminalId) || null;
  }

  // after: a session to place the new tab right behind (see
  // duplicateTerminalTab); otherwise it goes last.
  function createTerminalSession({ cwd, projectKey, after = null }) {
    const id = `term-${++terminalSeq}`;
    const container = document.createElement('div');
    container.className = 'terminal-session hidden';
    el.terminalXterm.appendChild(container);

    const term = new window.Terminal({
      fontFamily:
        '"D2Coding", "D2Coding ligature", Consolas, "Cascadia Mono", "Cascadia Code", "SFMono-Regular", Menlo, monospace',
      fontSize: 13,
      lineHeight: 1.3,
      cursorBlink: true,
      scrollback: 5000,
      theme: { background: '#1e1e1e', foreground: '#d4d4d4' },
    });
    const fitAddon = new window.FitAddon.FitAddon();
    term.loadAddon(fitAddon);
    term.open(container);
    registerTerminalFileLinks(term, cwd, projectKey || cwd, container);
    term.onData((data) => {
      window.mdviewer.sendTerminalInput(id, data);
    });
    // Shift+Enter inserts a line break instead of submitting. xterm sends a
    // bare CR for it, same as Enter, so programs can't tell the two apart.
    // ESC+CR (Alt+Enter) is what Claude Code and other line editors take as
    // "newline", the same mapping VS Code's terminal uses for Shift+Enter.
    // Every event type is swallowed so xterm never emits its own CR as well.
    term.attachCustomKeyEventHandler((e) => {
      if (e.key !== 'Enter' || !e.shiftKey || e.ctrlKey || e.altKey || e.metaKey || e.isComposing) {
        return true;
      }
      if (e.type === 'keydown') {
        e.preventDefault();
        window.mdviewer.sendTerminalInput(id, '\x1b\r');
      }
      return false;
    });
    term.onResize(({ cols, rows }) => {
      window.mdviewer.resizeTerminal(id, cols, rows);
    });
    // Right-click is this app's copy/paste gesture in the terminal (the
    // contextmenu handler below), so the right button must never reach
    // xterm's mouse reporting. Once a full-screen program turns mouse
    // tracking on -- Claude Code, vim, htop -- xterm forwards both the press
    // and the release to the program as escape sequences
    // ([<2;col;rowM / ...m), and a program that reads a right-button
    // report as "paste" pastes on each of them, on top of the paste this
    // panel already did: one right-click, up to three pastes. Swallowing the
    // event in the capture phase, before it reaches the xterm element
    // underneath, keeps right-click meaning exactly one thing no matter what
    // is running in the shell.
    for (const type of ['mousedown', 'mouseup', 'auxclick']) {
      container.addEventListener(
        type,
        (e) => {
          if (e.button !== 2) return;
          e.stopPropagation();
        },
        true
      );
    }

    container.addEventListener('contextmenu', async (e) => {
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

    const session = { id, cwd, liveCwd: null, projectKey, term, fitAddon, container, tab: null, started: false };
    // The shell's current folder, as the shell reports it: OSC 9;9 (the
    // PowerShell prompt main.js sets up) or OSC 7 (file://host/path, sent
    // by many POSIX shell setups). Without either, liveCwd stays null and
    // the tab's starting folder stands in for it.
    term.parser.registerOscHandler(9, (data) => {
      const m = /^9;(.*)$/s.exec(data);
      if (!m) return false;
      const dir = m[1].replace(/^"(.*)"$/s, '$1');
      if (dir) session.liveCwd = dir;
      return true;
    });
    term.parser.registerOscHandler(7, (data) => {
      try {
        const url = new URL(data);
        if (url.protocol !== 'file:') return false;
        let dir = decodeURIComponent(url.pathname);
        if (/^\/[A-Za-z]:/.test(dir)) dir = dir.slice(1).replace(/\//g, '\\');
        if (dir) session.liveCwd = dir;
      } catch (err) {
        return false;
      }
      return true;
    });
    session.tab = createTerminalTab(session);
    if (after && terminalSessions.has(after.id)) {
      const entries = [...terminalSessions.entries()];
      const at = entries.findIndex(([key]) => key === after.id) + 1;
      entries.splice(at, 0, [id, session]);
      terminalSessions.clear();
      for (const [key, value] of entries) terminalSessions.set(key, value);
    } else {
      terminalSessions.set(id, session);
    }
    return session;
  }

  function createTerminalTab(session) {
    const tab = document.createElement('div');
    tab.className = 'terminal-tab';
    tab.setAttribute('role', 'tab');
    tab.title = session.cwd || '~';
    const label = document.createElement('span');
    label.className = 'terminal-tab-label';
    const close = document.createElement('button');
    close.className = 'terminal-tab-close';
    close.textContent = '×';
    close.title = t('terminal.closeTabTitle');
    tab.append(label, close);

    tab.addEventListener('click', (e) => {
      if (e.target === close) return;
      activateTerminal(session.id);
    });
    close.addEventListener('click', () => closeTerminalTab(session.id));
    // Middle-click closes, as on browser tabs.
    tab.addEventListener('mousedown', (e) => {
      if (e.button === 1) e.preventDefault();
    });
    tab.addEventListener('auxclick', (e) => {
      if (e.button === 1) closeTerminalTab(session.id);
    });
    tab.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      window.mdviewer.showTerminalTabContextMenu(session.id, { hasOthers: terminalSessions.size > 1 });
    });
    return tab;
  }

  // The tabs of each project sit together in a group of their own, in the
  // explorer's project order (the home-folder shell's group, used while no
  // project is open, comes last). With more than one group, each starts
  // with its project's name, and a "+" beside it for a new shell at that
  // project's root, and a divider sets it off from the one before; the
  // active project's name is highlighted. Tab elements are moved, not
  // rebuilt, so a tab keeps its listeners and its place in the scroll.
  function layoutTerminalTabGroups() {
    const keys = [...state.projects, ''];
    for (const session of terminalSessions.values()) {
      if (!keys.includes(session.projectKey)) keys.push(session.projectKey);
    }
    const used = keys.filter((key) => [...terminalSessions.values()].some((s) => s.projectKey === key));
    const groups = new Map();
    for (const group of el.terminalTabs.querySelectorAll(':scope > .terminal-tab-group')) {
      groups.set(group.dataset.projectKey, group);
    }
    for (const [key, group] of groups) {
      if (!used.includes(key)) group.remove();
    }
    for (const key of used) {
      let group = groups.get(key);
      if (!group) {
        group = document.createElement('div');
        group.className = 'terminal-tab-group';
        group.dataset.projectKey = key;
        const name = document.createElement('span');
        name.className = 'terminal-tab-group-label';
        const add = document.createElement('button');
        add.className = 'terminal-tab-group-new';
        add.textContent = '+';
        add.addEventListener('click', () => newTerminalTabAtRoot(key));
        group.append(name, add);
      }
      const name = group.querySelector('.terminal-tab-group-label');
      name.textContent = key ? basenameOf(key) || key : '~';
      name.title = key || '~';
      name.classList.toggle('hidden', used.length < 2);
      const add = group.querySelector('.terminal-tab-group-new');
      add.title = t('terminal.newProjectTabTitle', { name: name.textContent });
      add.classList.toggle('hidden', used.length < 2);
      group.classList.toggle('active-project', used.length > 1 && key === activeTerminalKey());
      for (const session of terminalSessions.values()) {
        if (session.projectKey === key) group.appendChild(session.tab);
      }
      el.terminalTabs.appendChild(group);
    }
  }

  // Tabs are named after their folder; two tabs on the same folder are
  // told apart by a number.
  function renderTerminalTabLabels() {
    layoutTerminalTabGroups();
    const seen = new Map();
    for (const session of terminalSessions.values()) {
      const name = session.cwd ? basenameOf(session.cwd) || session.cwd : '~';
      const count = (seen.get(name) || 0) + 1;
      seen.set(name, count);
      session.tab.querySelector('.terminal-tab-label').textContent = count > 1 ? `${name} (${count})` : name;
      session.tab.classList.toggle('active', session.id === activeTerminalId);
      session.tab.classList.toggle('exited', !session.started);
      session.tab.setAttribute('aria-selected', String(session.id === activeTerminalId));
    }
  }

  async function startTerminalSession(session) {
    // Marked before the await so a second sync running meanwhile doesn't
    // start the same shell twice.
    session.started = true;
    renderTerminalTabLabels();
    // A hidden xterm has no size of its own to fit to, so it takes the
    // shown one's: they all sit in the same panel. Starting at the default
    // 80 columns instead and resizing on first show leaves ConPTY wrapping
    // the prompt where xterm doesn't, and typed text lands mid-line.
    if (!session.container.classList.contains('hidden')) {
      session.fitAddon.fit();
    } else {
      matchTerminalSize(session);
    }
    const result = await window.mdviewer.startTerminal(
      session.id,
      session.cwd || undefined,
      session.term.cols,
      session.term.rows
    );
    if (!result || !result.ok) {
      session.started = false;
      renderTerminalTabLabels();
    }
  }

  function disposeTerminalSession(session) {
    window.mdviewer.stopTerminal(session.id);
    session.term.dispose();
    session.container.remove();
    session.tab.remove();
    terminalSessions.delete(session.id);
    if (lastTerminalByProject.get(session.projectKey) === session.id) {
      lastTerminalByProject.delete(session.projectKey);
    }
    if (activeTerminalId === session.id) activeTerminalId = null;
  }

  // The tab to show for a project: the one last used there, else its first.
  function terminalForProject(projectKey) {
    const last = terminalSessions.get(lastTerminalByProject.get(projectKey));
    if (last) return last;
    for (const session of terminalSessions.values()) {
      if (session.projectKey === projectKey) return session;
    }
    return null;
  }

  function activateTerminal(id) {
    const session = terminalSessions.get(id);
    if (!session) return;
    activeTerminalId = id;
    lastTerminalByProject.set(session.projectKey, id);
    showActiveTerminal();
    session.tab.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    session.term.focus();
  }

  // Closing the last tab closes the panel; opening the panel again starts
  // a fresh shell for each project.
  function closeTerminalTab(id) {
    const session = terminalSessions.get(id);
    if (!session) return;
    const wasActive = activeTerminalId === id;
    disposeTerminalSession(session);
    if (!terminalSessions.size) {
      closeTerminalPanel();
      return;
    }
    if (wasActive) {
      const next = terminalForProject(session.projectKey) || [...terminalSessions.values()].pop();
      activateTerminal(next.id);
    } else {
      renderTerminalTabLabels();
    }
  }

  // Sizes a hidden session like the one on screen.
  function matchTerminalSize(session) {
    const shown = activeTerminal();
    if (!shown || shown === session || shown.container.classList.contains('hidden')) return;
    if (session.term.cols !== shown.term.cols || session.term.rows !== shown.term.rows) {
      session.term.resize(shown.term.cols, shown.term.rows);
    }
  }

  // Fits the session on screen to the panel and keeps the hidden ones the
  // same size, so switching tabs never resizes a shell (see
  // startTerminalSession for why that matters).
  function fitActiveTerminal() {
    // Fullscreen hides the terminal panel; fitting it at zero size there
    // would only have to be undone on the way out (exitDocFullscreen refits).
    if (!state.terminalOpen || state.docFullscreen) return;
    const session = activeTerminal();
    if (!session) return;
    session.fitAddon.fit();
    for (const other of terminalSessions.values()) matchTerminalSize(other);
  }

  function showActiveTerminal() {
    for (const session of terminalSessions.values()) {
      session.container.classList.toggle('hidden', session.id !== activeTerminalId);
    }
    renderTerminalTabLabels();
    fitActiveTerminal();
  }

  // Brings the tabs in line with the open projects: a closed project's
  // tabs are stopped right away, while a newly opened project only gets its
  // shell once the panel is (or gets) open. startExited — the panel being
  // opened — also gives every project without a tab a fresh one and
  // restarts shells that exited on their own, as opening the panel has
  // always done.
  async function syncTerminalSessions({ startExited = false } = {}) {
    const wanted = state.projects.length ? [...state.projects] : [''];
    for (const session of [...terminalSessions.values()]) {
      if (!wanted.includes(session.projectKey)) disposeTerminalSession(session);
    }
    const toStart = [];
    if (state.terminalOpen) {
      for (const key of wanted) {
        const isNew = !terminalProjectsSeen.includes(key);
        if ((startExited || isNew) && !terminalForProject(key)) {
          toStart.push(createTerminalSession({ cwd: key, projectKey: key }));
        }
      }
      if (startExited) {
        for (const session of terminalSessions.values()) {
          if (!session.started && !toStart.includes(session)) {
            session.term.reset();
            toStart.push(session);
          }
        }
      }
    }
    terminalProjectsSeen = wanted;

    const root = activeTerminalKey();
    if (root !== terminalShownRoot || !activeTerminal()) {
      const session = terminalForProject(root) || [...terminalSessions.values()][0];
      activeTerminalId = session ? session.id : null;
      if (session) lastTerminalByProject.set(session.projectKey, session.id);
    }
    terminalShownRoot = root;
    showActiveTerminal();
    await Promise.all(toStart.map(startTerminalSession));
  }

  async function openTerminalPanel() {
    exitDocFullscreen();
    el.terminalPanel.classList.remove('hidden');
    el.resizerTerminal.classList.remove('hidden');
    el.btnToggleTerminal.classList.add('active');
    state.terminalOpen = true;
    await syncTerminalSessions({ startExited: true });
    const session = activeTerminal();
    if (session) session.term.focus();
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

  // A new tab in the given folder, in the project the folder lies in (the
  // active one for a folder outside every project). Opening the panel for
  // it already starts a shell in each project's root, so a folder that is
  // such a root just brings that tab up instead of starting a second one.
  //
  // insertText is typed at the new shell's prompt, without Enter, once the
  // shell has settled (see waitForTerminalIdle).
  async function openTerminalAt(dir, { insertText = '' } = {}) {
    const projectKey = projectRootFor(dir) || activeTerminalKey();
    let session = null;
    if (!state.terminalOpen) {
      await openTerminalPanel();
      session = [...terminalSessions.values()].find(
        (s) => s.cwd && normalizePath(s.cwd) === normalizePath(dir)
      );
      if (session) activateTerminal(session.id);
    }
    if (!session) {
      session = createTerminalSession({ cwd: dir, projectKey });
      activateTerminal(session.id);
      await startTerminalSession(session);
    }
    if (!insertText) return;
    await waitForTerminalIdle(session);
    if (!terminalSessions.has(session.id) || !session.started) return;
    session.term.paste(insertText);
    session.term.focus();
  }

  // A shell that is still starting up drops or garbles what is typed at
  // it (PowerShell's line editor redraws the prompt over it), so input is
  // held until the shell has printed something and then gone quiet.
  function waitForTerminalIdle(session, { quietMs = 400, timeoutMs = 8000 } = {}) {
    const startedAt = Date.now();
    return new Promise((resolve) => {
      const check = () => {
        const now = Date.now();
        const settled = session.lastOutputAt && now - session.lastOutputAt >= quietMs;
        if (settled || now - startedAt >= timeoutMs) resolve();
        else setTimeout(check, 100);
      };
      check();
    });
  }

  // A file name as one shell word: quoted when it holds a space or a
  // character the shell would read as syntax. Windows runs PowerShell (see
  // spawnTerminalFor in main.js), where a quote inside quotes is doubled;
  // POSIX shells close, escape and reopen.
  function shellQuote(name) {
    if (/^[\p{L}\p{N}_.,+@%=:/-]+$/u.test(name)) return name;
    const isWin = /Windows/i.test(navigator.userAgent);
    return `'${name.replace(/'/g, isWin ? "''" : "'\\''")}'`;
  }

  // "+": another shell in the folder of the tab on screen.
  async function newTerminalTab() {
    const current = activeTerminal();
    if (!state.terminalOpen) {
      await openTerminalPanel();
      return;
    }
    const cwd = current ? current.cwd : activeTerminalKey();
    const session = createTerminalSession({ cwd, projectKey: current ? current.projectKey : activeTerminalKey() });
    activateTerminal(session.id);
    await startTerminalSession(session);
  }

  // A group's "+": another shell at its project's root, last in the group.
  async function newTerminalTabAtRoot(projectKey) {
    const session = createTerminalSession({ cwd: projectKey, projectKey });
    activateTerminal(session.id);
    await startTerminalSession(session);
  }

  // Duplicate (tab right-click): another shell for the same project, in
  // the folder the shell has moved to if it has reported one (see liveCwd
  // in createTerminalSession), placed right after the original.
  async function duplicateTerminalTab(id) {
    const original = terminalSessions.get(id);
    if (!original) return;
    const session = createTerminalSession({
      cwd: original.liveCwd || original.cwd,
      projectKey: original.projectKey,
      after: original,
    });
    activateTerminal(session.id);
    await startTerminalSession(session);
  }

  function closeOtherTerminalTabs(id) {
    if (!terminalSessions.has(id)) return;
    for (const session of [...terminalSessions.values()]) {
      if (session.id !== id) disposeTerminalSession(session);
    }
    activateTerminal(id);
  }

  // Restarts only the given shell (the one on screen by default); the
  // other tabs keep running.
  async function restartTerminal(id = activeTerminalId) {
    const session = terminalSessions.get(id);
    if (!session) return;
    await window.mdviewer.stopTerminal(session.id);
    session.term.reset();
    await startTerminalSession(session);
    session.term.focus();
  }

  el.btnToggleTerminal.addEventListener('click', toggleTerminalPanel);
  window.mdviewer.onMenuToggleTerminal(toggleTerminalPanel);
  el.btnTerminalClose.addEventListener('click', closeTerminalPanel);
  el.btnTerminalNewTab.addEventListener('click', newTerminalTab);
  el.btnTerminalClear.addEventListener('click', () => {
    const session = activeTerminal();
    if (session) session.term.clear();
  });
  el.btnTerminalRestart.addEventListener('click', () => restartTerminal());
  window.mdviewer.onTerminalTabAction(({ key, action }) => {
    if (action === 'duplicate') duplicateTerminalTab(key);
    else if (action === 'restart') restartTerminal(key);
    else if (action === 'close') closeTerminalTab(key);
    else if (action === 'close-others') closeOtherTerminalTabs(key);
  });
  window.mdviewer.onOpenInTerminal(({ dir }) => openTerminalAt(dir));

  window.mdviewer.onTerminalData((id, data) => {
    const session = terminalSessions.get(id);
    if (!session) return;
    session.lastOutputAt = Date.now();
    session.term.write(data);
  });

  window.mdviewer.onTerminalExit((id, code) => {
    const session = terminalSessions.get(id);
    if (!session) return;
    session.term.write(`\r\n\x1b[31m[${t('terminal.shellExited', { code })}]\x1b[0m\r\n`);
    session.started = false;
    renderTerminalTabLabels();
  });

  window.addEventListener('resize', fitActiveTerminal);

  // "Send to terminal" from a tab: the tab works out the reference and the
  // source text (see sendSelectionToTerminal in doc.js); this types it into
  // the terminal panel's shell, without Enter, so a prompt can follow it.
  // The path is relative to the shell's folder (the project root) when the
  // file lies under it.
  function terminalPathFor(filePath, shellCwd) {
    const shown =
      shellCwd && isPathUnder(filePath, shellCwd) && normalizePath(filePath) !== normalizePath(shellCwd)
        ? filePath.slice(shellCwd.replace(/[\\/]+$/, '').length + 1)
        : filePath;
    return shown.replace(/\\/g, '/');
  }

  async function typeSelectionIntoTerminal({ filePath, fragment, body, withText }) {
    if (!state.terminalOpen || !activeTerminal() || !activeTerminal().started) {
      await openTerminalPanel();
    }
    const session = activeTerminal();
    if (!session) return;

    const reference = filePath ? `@${terminalPathFor(filePath, session.cwd)}${fragment || ''}` : '';
    // A plain shell prompt would run each pasted line as a command; only a
    // program that asked for bracketed paste (Claude Code, an editor) takes
    // several lines as one input. Elsewhere everything stays on one line.
    const multiline = session.term.modes.bracketedPasteMode;
    let text;
    if (!withText) {
      text = `${reference} `;
    } else if (multiline) {
      text = reference ? `${reference}\n${body}\n` : `${body} `;
    } else if (!body.includes('\n')) {
      text = `${reference ? `${reference} ` : ''}${body} `;
    } else {
      setToolbarStatus(t('context.multilineNeedsBracketedPaste'));
      text = reference ? `${reference} ` : '';
    }
    if (text) session.term.paste(text);
    session.term.focus();
    window.mdviewer.focusWindowPage();
  }

  // ---------------------------------------------------------------------
  // Fullscreen document view
  //
  // F11 belongs to the tab (see enterDocFullscreen in doc.js), which hides
  // its own toolbar and editor; main.js tells this page to hide everything
  // around the tab area of the window it is in for the duration. Anything
  // here that opens one of the hidden panes (the CSS editor, the terminal,
  // project search) leaves the mode first.
  // ---------------------------------------------------------------------

  function onDocFullscreen({ container = 'main', enabled = false } = {}) {
    if (container !== 'main') {
      const area = tabAreas.get(container);
      if (area) area.root.classList.toggle('doc-fullscreen', !!enabled);
      return;
    }
    state.docFullscreen = !!enabled;
    el.appShell.classList.toggle('doc-fullscreen', state.docFullscreen);
    // xterm sizes itself from the panel's pixel box, which stayed frozen at
    // display:none for as long as the mode was on.
    if (!state.docFullscreen) fitActiveTerminal();
  }

  function exitDocFullscreen() {
    if (state.docFullscreen) window.mdviewer.setWindowFullscreen(false);
  }

  window.mdviewer.onDocFullscreen(onDocFullscreen);

  // ---------------------------------------------------------------------
  // Tab areas
  //
  // Each tab is a page in an iframe — a document tab is one document with
  // its viewer and, in edit mode, the source editor beside it (src/doc.html).
  // The tabs themselves live in main.js (their order, the one on screen,
  // what each shows); this page draws, from what it reports (tabs:changed:
  // each tab's strip entry and page address), the strip and the iframes of
  // every tab area it has: its own, and those of the tab windows tabs were
  // moved out to. A tab window is opened from here (window.open keeps it in
  // this renderer) and filled by this page, the way VS Code's editor
  // windows are.
  // ---------------------------------------------------------------------

  const TAB_DRAG_TYPE = 'application/x-mdviewer-tab';

  // key ('main', or a tab window's 'aux-N') -> { key, win, doc, root,
  // strip, host, tabs, activeId, frames (tab id -> iframe) }
  const tabAreas = new Map();

  function tabTitle(tab) {
    return tab.view.title;
  }

  function renderTabStrip(area) {
    const { doc, strip } = area;
    strip.textContent = '';
    // Two tabs with the same file name get their folder after it.
    const titles = area.tabs.map(tabTitle);
    area.tabs.forEach((tab, i) => {
      const node = doc.createElement('div');
      node.className = 'doc-tab';
      node.classList.toggle('active', tab.id === area.activeId);
      node.classList.toggle('dirty', !!tab.view.dirty);
      node.dataset.tabId = String(tab.id);
      node.draggable = true;
      node.setAttribute('role', 'tab');
      node.setAttribute('aria-selected', tab.id === area.activeId ? 'true' : 'false');
      node.title = tab.view.tooltip || titles[i];

      const icon = doc.createElement('span');
      icon.className = 'doc-tab-icon';
      const { badge, path: iconPath } = tab.view.icon || {};
      icon.innerHTML = fileBadgeSvg(badge || 'md', iconPath || '');
      node.appendChild(icon);

      const label = doc.createElement('span');
      label.className = 'doc-tab-label';
      label.textContent = titles[i];
      const docPath = tab.doc && tab.doc.path;
      if (docPath && titles.filter((title) => title === titles[i]).length > 1) {
        const dir = doc.createElement('span');
        dir.className = 'doc-tab-dir';
        dir.textContent = pathBasename(dirnameOf(docPath));
        label.appendChild(dir);
      }
      node.appendChild(label);

      const close = doc.createElement('button');
      close.className = 'doc-tab-close';
      close.tabIndex = -1;
      close.title = t('tabs.closeTitle');
      close.setAttribute('aria-label', t('tabs.closeTitle'));
      node.appendChild(close);

      strip.appendChild(node);
    });
    const activeNode = strip.querySelector('.doc-tab.active');
    if (activeNode) activeNode.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    // A tab window is named after the document on screen in it.
    if (area.key !== 'main') {
      const active = area.tabs.find((tab) => tab.id === area.activeId);
      doc.title = active ? `${tabTitle(active)} - MD Viewer` : 'MD Viewer';
    }
  }

  // One iframe per tab, the one on screen shown. A tab that arrives here
  // from another tab area gets a new iframe, which opens on what the old
  // one handed over (see moveTab in main.js).
  // One iframe per tab, at the address main.js gave it (page.url, with
  // page.sandbox as its sandbox attribute when there is one).
  function syncTabFrames(area, focusId) {
    const ids = new Set(area.tabs.map((tab) => tab.id));
    for (const [id, frame] of area.frames) {
      if (ids.has(id)) continue;
      frame.remove();
      area.frames.delete(id);
    }
    for (const tab of area.tabs) {
      let frame = area.frames.get(tab.id);
      if (!frame) {
        frame = area.doc.createElement('iframe');
        frame.className = 'doc-frame';
        if (tab.page.sandbox != null) frame.setAttribute('sandbox', tab.page.sandbox);
        frame.src = tab.page.url;
        area.host.appendChild(frame);
        area.frames.set(tab.id, frame);
      }
      frame.classList.toggle('active', tab.id === area.activeId);
    }
    if (focusId) focusTabFrame(area, focusId);
  }

  function focusTabFrame(area, id) {
    const frame = area.frames.get(id);
    if (frame) frame.focus();
  }

  window.mdviewer.onTabsFocus(({ container, id } = {}) => {
    const area = tabAreas.get(container);
    if (area) focusTabFrame(area, id);
  });

  // The tab on screen decides the active project (its CSS in the editor,
  // its terminal) and the explorer's "open document" mark. Only a change of
  // that tab or its document moves them: opening a project that has no
  // document to show leaves another project's tab on screen, and the user's
  // choice of project stands until they switch tabs. Tab windows have no
  // say in it.
  async function followActiveTab(previousId, previousPath) {
    const active = state.tabs.find((tab) => tab.id === state.activeTabId) || null;
    const activeDoc = active && active.doc;
    state.activeDocPath = activeDoc && activeDoc.path && !activeDoc.instantView ? activeDoc.path : null;
    markActiveDocRow();
    updateDocHostView();
    const changed = state.activeTabId !== previousId || state.activeDocPath !== previousPath;
    if (!changed || !state.activeDocPath) return;
    const root = projectRootFor(state.activeDocPath);
    if (root && root !== state.rootPath) await applyProjectState(root);
  }

  window.mdviewer.onTabsChanged(({ container = 'main', tabs, activeId, focusId } = {}) => {
    const area = tabAreas.get(container);
    if (!area) return;
    area.tabs = Array.isArray(tabs) ? tabs : [];
    area.activeId = activeId || null;
    renderTabStrip(area);
    syncTabFrames(area, focusId);
    if (container !== 'main') return;
    const previousId = state.activeTabId;
    const previousPath = state.activeDocPath;
    state.tabs = area.tabs;
    state.activeTabId = area.activeId;
    followActiveTab(previousId, previousPath);
  });

  function tabIdFromEvent(e) {
    const node = e.target.closest ? e.target.closest('.doc-tab') : null;
    return node ? Number(node.dataset.tabId) : null;
  }

  function isTabDrag(e) {
    const types = e.dataTransfer && e.dataTransfer.types;
    return !!types && Array.prototype.includes.call(types, TAB_DRAG_TYPE);
  }

  // The tab being dragged out of one of this page's strips, if any.
  let tabDrag = null;

  // The strip's clicks and drags, for this page's own tab area and for
  // each tab window's alike.
  function wireTabArea(area) {
    const { strip, host } = area;

    strip.addEventListener('click', (e) => {
      const id = tabIdFromEvent(e);
      if (id == null) return;
      if (e.target.closest('.doc-tab-close')) window.mdviewer.closeTab(id);
      else window.mdviewer.activateTab(id);
    });
    // Middle click closes, as in a browser.
    strip.addEventListener('mousedown', (e) => {
      if (e.button === 1) e.preventDefault();
    });
    strip.addEventListener('auxclick', (e) => {
      if (e.button !== 1) return;
      const id = tabIdFromEvent(e);
      if (id != null) window.mdviewer.closeTab(id);
    });
    strip.addEventListener('dblclick', (e) => {
      if (e.target === strip) window.mdviewer.newDraftTab(area.key);
    });
    strip.addEventListener('contextmenu', (e) => {
      const id = tabIdFromEvent(e);
      if (id == null) return;
      e.preventDefault();
      window.mdviewer.showTabContextMenu(id);
    });

    // Dragging a tab: within the strip it reorders; onto another window's
    // strip or document it moves there; dropped outside every window it
    // opens in a tab window of its own under the pointer.
    const tabDropIndex = (e) => {
      const nodes = Array.from(strip.querySelectorAll('.doc-tab'));
      for (let i = 0; i < nodes.length; i++) {
        const rect = nodes[i].getBoundingClientRect();
        if (e.clientX < rect.left + rect.width / 2) return i;
      }
      return nodes.length;
    };

    const showTabDropMarker = (index) => {
      const nodes = Array.from(strip.querySelectorAll('.doc-tab'));
      nodes.forEach((node, i) => {
        node.classList.toggle('drop-before', i === index);
        node.classList.toggle('drop-after', index === nodes.length && i === nodes.length - 1);
      });
    };

    strip.addEventListener('dragstart', (e) => {
      const id = tabIdFromEvent(e);
      if (id == null) return;
      tabDrag = { id, dropped: false };
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData(TAB_DRAG_TYPE, String(id));
    });

    strip.addEventListener('dragover', (e) => {
      if (!isTabDrag(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      showTabDropMarker(tabDropIndex(e));
    });

    strip.addEventListener('dragleave', (e) => {
      if (!strip.contains(e.relatedTarget)) showTabDropMarker(-1);
    });

    // The tab may come from this window or another one; main.js moves it
    // either way, since it holds every window's tabs.
    const dropTab = (e, index) => {
      e.preventDefault();
      const id = Number(e.dataTransfer.getData(TAB_DRAG_TYPE));
      if (!id) return;
      if (tabDrag && tabDrag.id === id) tabDrag.dropped = true;
      window.mdviewer.moveTabHere(id, index, area.key);
    };

    strip.addEventListener('drop', (e) => {
      if (!isTabDrag(e)) return;
      showTabDropMarker(-1);
      dropTab(e, tabDropIndex(e));
    });

    // The tab area's own background (no tab on screen to take the drop).
    host.addEventListener('dragover', (e) => {
      if (!isTabDrag(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
    });
    host.addEventListener('drop', (e) => {
      if (isTabDrag(e)) dropTab(e, undefined);
    });

    strip.addEventListener('dragend', (e) => {
      showTabDropMarker(-1);
      const drag = tabDrag;
      tabDrag = null;
      if (!drag || drag.dropped || e.dataTransfer.dropEffect !== 'none') return;
      // Dropped on no tab strip at all: outside this window it becomes a
      // window of its own.
      const win = area.win;
      const outside =
        e.screenX < win.screenX ||
        e.screenX > win.screenX + win.outerWidth ||
        e.screenY < win.screenY ||
        e.screenY > win.screenY + win.outerHeight;
      if (outside) window.mdviewer.detachTab(drag.id, { x: e.screenX, y: e.screenY });
    });
  }

  function addTabArea(key, win, { root, strip, host }) {
    const area = { key, win, doc: win.document, root, strip, host, tabs: [], activeId: null, frames: new Map() };
    tabAreas.set(key, area);
    wireTabArea(area);
    return area;
  }

  addTabArea('main', window, { root: el.appShell, strip: el.docTabs, host: el.docHost });

  // main.js asks for a tab window when a tab leaves for one (see
  // detachTab there); it gives the window its place and size, and moves
  // the tab in once it exists. This page writes what is in it: a tab strip
  // and a tab area, styled like its own.
  window.mdviewer.onOpenTabWindow(({ key } = {}) => {
    if (!key || tabAreas.has(key)) return;
    const win = window.open('about:blank', key);
    if (!win) return;
    const doc = win.document;
    doc.open();
    doc.write(
      `<!DOCTYPE html><html lang="${escapeHtml(document.documentElement.lang || 'en')}"><head>` +
        `<meta charset="UTF-8"><title>MD Viewer</title>` +
        `<link rel="stylesheet" href="${escapeHtml(new URL('ui.css', location.href).href)}">` +
        `</head><body class="tab-window"><div id="app-shell">` +
        `<div class="tab-bar"><div class="doc-tabs" role="tablist"></div></div>` +
        `<div class="doc-host"></div>` +
        `</div></body></html>`
    );
    doc.close();
    addTabArea(key, win, {
      root: doc.getElementById('app-shell'),
      strip: doc.querySelector('.doc-tabs'),
      host: doc.querySelector('.doc-host'),
    });
  });

  window.mdviewer.onTabWindowClosed(({ key } = {}) => {
    if (key && key !== 'main') tabAreas.delete(key);
  });

  // ---------------------------------------------------------------------
  // Requests from the tabs (relayed by main.js; see askWindow in doc.js)
  // ---------------------------------------------------------------------

  const SHELL_REQUESTS = {
    reveal: ({ path, select }) => revealPathInTree(path, { select: !!select }),
    fresh: ({ path }) => markTreeRowFresh(path),
    'refresh-dir': ({ dir }) => refreshTreeDir(dir),
    'open-terminal': ({ dir, fileName }) =>
      openTerminalAt(dir || state.rootPath || '', fileName ? { insertText: shellQuote(fileName) } : {}),
    'send-to-terminal': (payload) => typeSelectionIntoTerminal(payload),
    'open-folder': ({ path }) => openFolder(path),
    'open-file': ({ path, findProject, line }) => openSingleFile(path, { findProject: !!findProject, line }),
    // A tab's document lies outside every open project (a draft just saved
    // there, a tab moved in from a window that had the project open).
    'ensure-project': async ({ dir, path, reveal }) => {
      let folder = dir;
      if (!folder && path) folder = (await window.mdviewer.findProjectRoot(path)) || dirnameOf(path);
      if (!folder || projectRootFor(path || folder)) return;
      await openFolder(folder, { openLastFile: false });
      if (reveal) await revealPathInTree(reveal, { select: true });
    },
  };

  window.mdviewer.onShellRequest(async ({ action, payload } = {}) => {
    await appReady;
    const handler = SHELL_REQUESTS[action];
    if (handler) handler(payload || {});
  });

  el.welcomeNewDocument.addEventListener('click', () => window.mdviewer.newDraftTab());

  // ---------------------------------------------------------------------
  // Init
  // ---------------------------------------------------------------------

  setupResizer(el.resizerLeft, el.sidebar, 'left');
  setupResizer(el.resizerRight, el.cssPane, 'right');
  setupResizer(el.resizerTerminal, el.terminalPanel, 'bottom', () => {
    fitActiveTerminal();
  });

  // What the main process sends right after the page loads (projects to
  // restore, a file to open) waits for this.
  const appReady = (async () => {
    await initI18n();
    await loadCustomExtensions();
    const { defaultCss, hljsCss } = await window.mdviewer.getBaseStyles();
    state.baseCss = defaultCss;
    state.hljsCss = hljsCss;
    updateDocHostView();
  })();
})();
