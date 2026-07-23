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
  };

  const el = {
    btnOpenFolder: document.getElementById('btn-open-folder'),
    btnOpenFile: document.getElementById('btn-open-file'),
    projectPath: document.getElementById('project-path'),
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
    editStatus: document.getElementById('edit-status'),
  };

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
      `</head><body class="markdown-body"><div class="mdviewer-empty-state">폴더를 열고 마크다운 파일을 선택하세요</div></body></html>`
    );
    doc.close();

    // Event delegation for link clicks inside the rendered document.
    doc.addEventListener('click', onPreviewClick, true);
  }

  function onPreviewClick(e) {
    const anchor = e.target.closest('a');
    if (!anchor) return;

    const internal = anchor.getAttribute('data-internal-href');
    if (internal) {
      e.preventDefault();
      const [absPath, hash] = internal.split('#');
      if (/\.(md|markdown)$/i.test(absPath)) {
        guardNavigation().then((ok) => {
          if (ok) loadAndRenderFile(absPath);
        });
      } else if (absPath) {
        window.mdviewer.openExternal(pathToFileUrl(absPath));
      } else if (hash) {
        const target = el.frame.contentDocument.getElementById(hash);
        if (target) target.scrollIntoView();
      }
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

  function pathToFileUrl(p) {
    let resolved = p.replace(/\\/g, '/');
    if (!resolved.startsWith('/')) resolved = '/' + resolved;
    return 'file://' + resolved;
  }

  function dirnameOf(p) {
    const idx = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
    return idx >= 0 ? p.substring(0, idx) : '';
  }

  function setUserCssLive(css) {
    const styleTag = el.frame.contentDocument.getElementById('user-css');
    if (styleTag) styleTag.textContent = css;
  }

  function updateCssAppliedBadge() {
    el.cssAppliedBadge.classList.toggle('active', state.cssEnabled);
    el.cssAppliedBadge.classList.toggle('disabled', !state.cssEnabled);
    el.cssAppliedBadge.title = state.cssEnabled ? '커스텀 CSS 적용됨' : '커스텀 CSS 적용 안 함 (기본 스타일)';
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
  }

  function showWelcomeScreen() {
    el.previewBody.classList.add('hidden');
    el.welcomeScreen.classList.remove('hidden');
    populateRecentList();
  }

  async function openFolder(folderPath) {
    if (!(await guardNavigation())) return false;

    const check = await window.mdviewer.listDir(folderPath);
    if (!check.ok) {
      await window.mdviewer.removeRecentProject(folderPath);
      showWelcomeScreen();
      const errRow = document.createElement('li');
      errRow.className = 'recent-empty';
      errRow.textContent = '폴더를 열 수 없습니다: ' + check.error;
      el.recentList.prepend(errRow);
      return false;
    }

    state.rootPath = folderPath;
    el.projectPath.textContent = folderPath;
    el.projectPath.title = folderPath;
    el.tree.innerHTML = '';
    buildTreeNodes(el.tree, check.items, 0);
    await loadProjectCss({ silent: true });
    await window.mdviewer.addRecentProject(folderPath);
    showProjectView();
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
      empty.textContent = '최근에 연 프로젝트가 없습니다';
      el.recentList.appendChild(empty);
      return;
    }
    for (const item of items) {
      const li = document.createElement('li');
      li.className = 'recent-item' + (item.exists ? '' : ' missing');
      li.title = item.exists ? item.path : item.path + ' (찾을 수 없음)';

      const info = document.createElement('div');
      info.className = 'recent-item-info';
      const name = document.createElement('div');
      name.className = 'recent-item-name';
      name.textContent = item.name;
      const pathEl = document.createElement('div');
      pathEl.className = 'recent-item-path';
      pathEl.textContent = item.exists ? item.path : item.path + ' — 찾을 수 없음';
      info.appendChild(name);
      info.appendChild(pathEl);
      li.appendChild(info);

      const removeBtn = document.createElement('button');
      removeBtn.className = 'recent-item-remove';
      removeBtn.textContent = '✕';
      removeBtn.title = '목록에서 제거';
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

  async function renderTreeLevel(container, dirPath, depth) {
    const result = await window.mdviewer.listDir(dirPath);
    if (!result.ok) {
      const errRow = document.createElement('div');
      errRow.className = 'tree-row non-md';
      errRow.textContent = '(읽을 수 없음: ' + result.error + ')';
      container.appendChild(errRow);
      return;
    }
    buildTreeNodes(container, result.items, depth);
  }

  function buildTreeNodes(container, items, depth) {
    for (const item of items) {
      const node = document.createElement('div');
      node.className = 'tree-node';

      const row = document.createElement('div');
      row.className = 'tree-row' + (item.isDir ? ' dir' : item.isMarkdown ? ' md' : ' non-md');
      row.style.paddingLeft = 10 + depth * 16 + 'px';

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

      if (item.isDir) {
        const childrenContainer = document.createElement('div');
        childrenContainer.className = 'tree-children';
        node.appendChild(childrenContainer);

        row.addEventListener('click', async () => {
          const expanded = childrenContainer.classList.toggle('expanded');
          caret.classList.toggle('expanded', expanded);
          if (expanded && childrenContainer.dataset.loaded !== '1') {
            childrenContainer.dataset.loaded = '1';
            await renderTreeLevel(childrenContainer, item.path, depth + 1);
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

  async function loadAndRenderFile(filePath) {
    const result = await window.mdviewer.renderMarkdown(filePath);
    if (!result.ok) {
      el.frame.contentDocument.body.innerHTML =
        `<div class="mdviewer-empty-state">파일을 열 수 없습니다: ${escapeHtml(result.error)}</div>`;
      return;
    }
    el.frame.contentDocument.body.innerHTML = result.html;
    el.fileName.textContent = result.name;
    el.fileName.title = filePath;
    state.currentFilePath = filePath;
    window.mdviewer.watchFile(filePath);
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
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
    return window.confirm('저장하지 않은 변경 사항이 있습니다. 저장하지 않고 이동하시겠습니까?');
  }

  function forceExitEditMode() {
    state.editMode = false;
    state.sourceDirty = false;
    setEditModeUI(false);
    el.editStatus.textContent = '';
  }

  async function guardNavigation() {
    if (!confirmDiscardIfDirty()) return false;
    if (state.editMode) forceExitEditMode();
    return true;
  }

  function setEditModeUI(enabled) {
    el.mdSourceEditor.classList.toggle('hidden', !enabled);
    el.editorResizer.classList.toggle('hidden', !enabled);
    el.btnToggleEdit.classList.toggle('active', enabled);
    el.btnSaveSource.classList.toggle('hidden', !enabled);
  }

  async function enterEditMode() {
    if (!state.currentFilePath) {
      el.editStatus.textContent = '먼저 문서를 선택하세요';
      return;
    }
    const result = await window.mdviewer.readFile(state.currentFilePath);
    if (!result.ok) {
      el.editStatus.textContent = '읽기 실패: ' + result.error;
      return;
    }
    el.mdSourceEditor.value = result.content;
    state.editMode = true;
    state.sourceDirty = false;
    setEditModeUI(true);
    el.editStatus.textContent = '';
    el.mdSourceEditor.focus();
  }

  function exitEditMode() {
    if (!confirmDiscardIfDirty()) return;
    state.editMode = false;
    state.sourceDirty = false;
    setEditModeUI(false);
    el.editStatus.textContent = '';
    if (state.currentFilePath) loadAndRenderFile(state.currentFilePath);
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
    }
  }

  async function saveSource() {
    if (!state.currentFilePath) return;
    state.suppressNextWatch = true;
    const result = await window.mdviewer.writeFile(state.currentFilePath, el.mdSourceEditor.value);
    if (result.ok) {
      state.sourceDirty = false;
      el.editStatus.textContent = '저장됨';
    } else {
      state.suppressNextWatch = false;
      el.editStatus.textContent = '저장 실패: ' + result.error;
    }
  }

  el.mdSourceEditor.addEventListener('input', () => {
    clearTimeout(state.sourceDebounceTimer);
    state.sourceDebounceTimer = setTimeout(renderSourcePreview, 200);
    state.sourceDirty = true;
    el.editStatus.textContent = '저장되지 않은 변경 사항이 있습니다';
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
  // CSS editor
  // ---------------------------------------------------------------------

  async function loadProjectCss({ silent = false } = {}) {
    const result = await window.mdviewer.loadProjectCss(state.rootPath);
    const css = result.ok ? result.css : '';
    el.cssEditor.value = css;
    applyLiveCss();
    state.cssDirty = false;
    el.cssStatus.textContent = silent ? '' : '마지막 저장 상태로 되돌렸습니다';
  }

  el.cssEditor.addEventListener('input', () => {
    clearTimeout(state.cssDebounceTimer);
    state.cssDebounceTimer = setTimeout(() => {
      applyLiveCss();
    }, 120);
    state.cssDirty = true;
    el.cssStatus.textContent = '저장되지 않은 변경 사항이 있습니다';
  });

  el.cssEnabledToggle.addEventListener('change', () => {
    state.cssEnabled = el.cssEnabledToggle.checked;
    applyLiveCss();
    el.cssStatus.textContent = state.cssEnabled
      ? '커스텀 CSS를 적용했습니다'
      : '커스텀 CSS를 껐습니다 (기본 스타일 표시 중)';
  });

  el.btnSaveCss.addEventListener('click', async () => {
    if (!state.rootPath) {
      el.cssStatus.textContent = '먼저 폴더를 열어야 저장할 수 있습니다';
      return;
    }
    const result = await window.mdviewer.saveProjectCss(state.rootPath, el.cssEditor.value);
    if (result.ok) {
      state.cssDirty = false;
      el.cssStatus.textContent = '저장됨 (.mdviewer/custom.css)';
    } else {
      el.cssStatus.textContent = '저장 실패: ' + result.error;
    }
  });

  el.btnResetCss.addEventListener('click', () => {
    loadProjectCss();
  });

  // ---- Import base style from another project ----

  async function importCssFrom(sourcePath) {
    const result = await window.mdviewer.loadProjectCss(sourcePath);
    if (!result.ok) {
      el.cssStatus.textContent = '가져오기 실패: ' + result.error;
      return;
    }
    el.cssEditor.value = result.css;
    applyLiveCss();
    state.cssDirty = true;
    el.cssStatus.textContent = `가져옴 (저장 전): ${sourcePath}`;
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
      empty.textContent = '가져올 다른 프로젝트가 없습니다';
      el.importRecentList.appendChild(empty);
      return;
    }
    for (const item of items) {
      const li = document.createElement('li');
      li.className = 'import-recent-item';
      li.title = item.path;

      const name = document.createElement('div');
      name.className = 'import-recent-item-name';
      name.textContent = item.name + (item.exists ? '' : ' (찾을 수 없음)');
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

  // ---------------------------------------------------------------------
  // Pane resizers
  // ---------------------------------------------------------------------

  function setupResizer(resizerEl, targetEl, mode) {
    let dragging = false;
    resizerEl.addEventListener('mousedown', (e) => {
      dragging = true;
      resizerEl.classList.add('dragging');
      e.preventDefault();
    });
    window.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      const rect = targetEl.parentElement.getBoundingClientRect();
      if (mode === 'left') {
        targetEl.style.width = Math.max(160, e.clientX - rect.left) + 'px';
      } else {
        targetEl.style.width = Math.max(220, rect.right - e.clientX) + 'px';
      }
    });
    window.addEventListener('mouseup', () => {
      dragging = false;
      resizerEl.classList.remove('dragging');
    });
  }

  setupResizer(el.resizerLeft, el.sidebar, 'left');
  setupResizer(el.resizerRight, el.cssPane, 'right');
  setupResizer(el.editorResizer, el.mdSourceEditor, 'left');

  // ---------------------------------------------------------------------
  // Init
  // ---------------------------------------------------------------------

  initPreviewFrame();
  showWelcomeScreen();
  updateCssAppliedBadge();
})();
