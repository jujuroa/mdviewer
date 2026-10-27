// Helpers shared by the window page (index.html: explorer, tab strip,
// terminal) and the document page each tab runs (doc.html: viewer and
// editor). Both load this before their own script, which picks what it
// needs off window.MdvCommon.
(() => {
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
  // Paths
  // ---------------------------------------------------------------------

  function normalizePath(p) {
    return p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  }

  function isPathUnder(filePath, rootPath) {
    const target = normalizePath(filePath);
    const root = normalizePath(rootPath);
    return target === root || target.startsWith(root + '/');
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

  function basenameOf(p) {
    const trimmed = p.replace(/[\\/]+$/, '');
    return trimmed.substring(Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\')) + 1);
  }

  function basenameNoExt(p) {
    const idx = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
    const base = idx >= 0 ? p.substring(idx + 1) : p;
    return base.replace(/\.(md|markdown)$/i, '');
  }

  function pathBasename(p) {
    const trimmed = p.replace(/[\\/]+$/, '');
    const idx = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
    return idx >= 0 ? trimmed.slice(idx + 1) : trimmed;
  }

  // The open project a path belongs to — the innermost one when projects
  // nest — or null when it sits outside all of them.
  function projectRootIn(projects, filePath) {
    if (!filePath) return null;
    let best = null;
    for (const root of projects) {
      if (isPathUnder(filePath, root) && (!best || root.length > best.length)) best = root;
    }
    return best;
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  // ---------------------------------------------------------------------
  // File kinds and their icons
  // ---------------------------------------------------------------------

  // Source files that open in the text viewer/editor and are shown as a
  // highlighted code block (see code-languages.js).
  const CODE_FILE_EXTENSIONS = new Set(Object.keys(window.MdvCodeLanguages.CODE_LANGUAGE_BY_EXT));

  // Whether a path's extension should open in the plain-text viewer/editor:
  // the built-in .txt/.log set and source files, plus any user-added custom
  // extensions from the "Custom Extensions..." settings dialog.
  function isPlainTextPathWith(customExtensions, filePath) {
    if (/\.(txt|log)$/i.test(filePath)) return true;
    const m = /\.([a-zA-Z0-9]+)$/.exec(filePath);
    if (!m) return false;
    const ext = m[1].toLowerCase();
    return CODE_FILE_EXTENSIONS.has(ext) || customExtensions.includes(ext);
  }

  // Files the viewer shows as the page itself, in a frame of their own,
  // rather than as markup it renders: 'html' (the page, its source in the
  // editor) and 'pdf' (the built-in PDF viewer, not editable). Null for the
  // rest. An .html file is a source file too (isPlainTextPathWith), so this
  // is checked first.
  function embeddedKindOf(filePath) {
    if (/\.(html?|xhtml)$/i.test(filePath || '')) return 'html';
    if (/\.pdf$/i.test(filePath || '')) return 'pdf';
    return null;
  }

  // Page-with-a-label-band icon for the files the app opens, used by the
  // explorer, the tab strip and the TOC links list. Emoji for these were
  // hard to tell apart at tree size; the band colour carries the kind, the
  // text confirms it.
  const FILE_BADGE_COLOR = {
    md: '#1f6feb',
    puml: '#8a3ffc',
    json: '#d48c00',
    text: '#6e7781',
    html: '#e34c26',
    pdf: '#b30b00',
  };

  // `kind` is one of the FILE_BADGE_COLOR keys; plain-text files show their
  // own extension (TXT, LOG or a custom one), clipped to 4 letters.
  function fileBadgeSvg(kind, filePath) {
    let label = kind === 'md' ? 'MD' : kind.toUpperCase();
    if (kind === 'text') {
      const m = /\.([a-zA-Z0-9]+)$/.exec(filePath || '');
      label = (m ? m[1] : 'TXT').slice(0, 4).toUpperCase();
    }
    const fontSize = label.length <= 2 ? 14 : label.length === 3 ? 13 : 12;
    const fit = label.length > 2 ? ' textLength="29" lengthAdjust="spacingAndGlyphs"' : '';
    return (
      '<svg class="file-badge" viewBox="0 0 32 32" aria-hidden="true">' +
      '<path d="M7.5 1.5h12L27 9v20a1.5 1.5 0 0 1-1.5 1.5h-18A1.5 1.5 0 0 1 6 29V3a1.5 1.5 0 0 1 1.5-1.5z"' +
      ' fill="#fff" stroke="#555" stroke-width="2" stroke-linejoin="round"/>' +
      '<path d="M19.5 1.5V9H27" fill="none" stroke="#555" stroke-width="2" stroke-linejoin="round"/>' +
      `<rect x="0.5" y="12" width="31" height="16" rx="2" fill="${FILE_BADGE_COLOR[kind]}"/>` +
      `<text x="16" y="24.8" text-anchor="middle" font-family="Bahnschrift, 'Arial Narrow', 'Segoe UI', sans-serif"` +
      ` font-weight="700" font-size="${fontSize}" fill="#fff"${fit}>${label}</text>` +
      '</svg>'
    );
  }

  // How long ago a file was last modified, as a fade step for its tree row
  // (0 = recent, shown as is; higher = older, shown fainter — see the
  // .tree-row.age-N rules in ui.css). Steps rather than a continuous fade
  // so "this week" and "this month" read as visibly different groups.
  const DAY_MS = 24 * 60 * 60 * 1000;
  const TREE_AGE_STEPS_DAYS = [7, 30, 180, 365];
  function treeAgeStep(mtimeMs) {
    if (!mtimeMs) return 0;
    const days = (Date.now() - mtimeMs) / DAY_MS;
    let step = 0;
    while (step < TREE_AGE_STEPS_DAYS.length && days >= TREE_AGE_STEPS_DAYS[step]) step += 1;
    return step;
  }

  // ---------------------------------------------------------------------
  // File links: file names written in terminal output or the source editor
  // ---------------------------------------------------------------------

  // Runs of characters a path can be made of; quotes, brackets and the like
  // end a run so `[x](docs/a.md)` and "a.md" yield just the path.
  const PATH_RUN_RE = /[^\s"'`<>()[\]{}|*?,;]+/g;
  // The path itself must end in an extension, so ordinary words never turn
  // into links. A #fragment (markdown link) or :line[:col] may follow, and
  // after the line anything else (grep's `file:12:matched text`).
  const PATH_TOKEN_RE = /^((.+?\.[A-Za-z0-9_]+)(#[^#:]*)?(?::(\d+)(?::\d+)?)?)(?::.*)?$/;

  // Path-looking tokens of one line of text: [{ start, end, path, line }],
  // start/end being string offsets of the part to underline and line the
  // 1-based line number written after it, if any.
  function findPathCandidates(text) {
    const result = [];
    PATH_RUN_RE.lastIndex = 0;
    let m;
    while ((m = PATH_RUN_RE.exec(text))) {
      let token = m[0];
      let start = m.index;
      // Claude Code's @file mentions.
      const lead = /^@/.exec(token);
      if (lead) {
        token = token.slice(lead[0].length);
        start += lead[0].length;
      }
      // Sentence punctuation is not part of the path.
      token = token.replace(/[.:!]+$/, '');
      if (/:\/\//.test(token) || /^(www\.|mailto:)/i.test(token)) continue;
      const parts = PATH_TOKEN_RE.exec(token);
      if (!parts) continue;
      let filePath = parts[2];
      if (/%[0-9A-Fa-f]{2}/.test(filePath)) {
        try {
          filePath = decodeURIComponent(filePath);
        } catch (err) {
          // Not percent-encoding after all; use it as written.
        }
      }
      result.push({
        start,
        end: start + parts[1].length,
        path: filePath,
        line: parts[4] ? parseInt(parts[4], 10) : null,
      });
    }
    return result;
  }

  // Keeps the candidates that name existing files, each with `targets`: the
  // absolute paths it may mean (more than one only for an ambiguous bare
  // file name).
  async function resolveLinkCandidates(candidates, baseDirs, rootPath) {
    if (!candidates.length) return [];
    const results = await window.mdviewer.resolveLinkPaths(
      candidates.map((c) => c.path),
      baseDirs,
      rootPath
    );
    return candidates
      .map((c, i) => ({ ...c, targets: (results && results[i]) || [] }))
      .filter((c) => c.targets.length);
  }

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
      // A function picks the side per drag, for a pane that can move.
      const side = typeof mode === 'function' ? mode() : mode;
      if (side === 'left') {
        targetEl.style.width = Math.max(160, e.clientX - rect.left) + 'px';
      } else if (side === 'top') {
        // Leaves the pane below at least as tall as the pane's own minimum.
        const height = Math.min(rect.height - 80 - resizerEl.offsetHeight, e.clientY - rect.top);
        targetEl.style.height = Math.max(80, height) + 'px';
      } else if (side === 'bottom') {
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

  window.MdvCommon = {
    t,
    applyStaticTranslations,
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
    embeddedKindOf,
    CODE_FILE_EXTENSIONS,
    fileBadgeSvg,
    treeAgeStep,
    TREE_AGE_STEPS_DAYS,
    findPathCandidates,
    resolveLinkCandidates,
    setupResizer,
  };
})();
