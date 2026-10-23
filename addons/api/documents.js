// The workspace, documents and editor areas (protocol 13.1–13.3), and the
// experimental documents.sync (documents/save, documents/reload — see
// .lab/addon/api/documents.md). A document open in a tab is read from its
// tab (unsaved text included); others from disk. deps:
//   roots() -> every open project root; projectsOf(caller) -> [{ root, name, active }]
//   docTabFor(path) -> the document tab showing it, or null
//   activeDocTab(caller) -> the document tab on screen in the caller's window, or null
//   ask(tab, kind, args) -> the tab page's answer (text, selection, save, reload)
//   readFile(path) -> text; version(text) -> SHA-1 hex
//   listFiles(root, extensions) -> [{ path, size, mtimeMs }]
//   openDocument(caller, path, line)
const path = require('path');
const { ApiError } = require('../api-router.js');
const { isPathInside } = require('../../lib/paths.js');
const { rangeOf } = require('../../lib/text-range.js');

const DOCUMENT_MAX_CHARS = 16 * 1024 * 1024;

function registerDocumentsApi(router, deps) {
  // An absolute path inside an open project (protocol 8.2).
  function projectPath(value, name = 'path') {
    if (typeof value !== 'string' || !path.isAbsolute(value)) throw new ApiError('InvalidParams', `${name} must be an absolute path`);
    const resolved = path.resolve(value);
    if (!deps.roots().some((root) => isPathInside(resolved, root))) throw new ApiError('OutsideProject', `${value} is outside the open projects`);
    return resolved;
  }

  // { text, dirty, editMode } of a document: its tab's editor while it is
  // being edited, else the file.
  async function current(filePath, tab = deps.docTabFor(filePath)) {
    let answer = null;
    if (tab) answer = await deps.ask(tab, 'text');
    if (answer && typeof answer.text === 'string') return { text: answer.text, dirty: !!answer.dirty, editMode: true };
    let text;
    try {
      text = deps.readFile(filePath);
    } catch (err) {
      throw new ApiError('NotFound', `Cannot read ${filePath}`);
    }
    return { text, dirty: false, editMode: !!(answer && answer.editMode) };
  }

  router.register('workspace/projects', { handler: (caller) => deps.projectsOf(caller) });

  router.register('workspace/listFiles', {
    permission: 'documents.read',
    handler: (caller, { root, extensions }) => {
      const resolved = projectPath(root, 'root');
      if (!deps.roots().some((r) => path.resolve(r).toLowerCase() === resolved.toLowerCase())) {
        throw new ApiError('InvalidParams', 'root must be an open project root');
      }
      if (extensions !== undefined && (!Array.isArray(extensions) || extensions.some((e) => typeof e !== 'string'))) {
        throw new ApiError('InvalidParams', 'extensions must be a list of strings');
      }
      return deps.listFiles(resolved, extensions ? extensions.map((e) => e.replace(/^\./, '').toLowerCase()) : null);
    },
  });

  router.register('workspace/openDocument', {
    handler: async (caller, { path: p, line }) => {
      const filePath = projectPath(p);
      if (line !== undefined && (!Number.isInteger(line) || line < 0)) throw new ApiError('InvalidParams', 'line must be a line number from 0');
      await deps.openDocument(caller, filePath, line);
      return null;
    },
  });

  router.register('documents/read', {
    permission: 'documents.read',
    handler: async (caller, { path: p }) => {
      const filePath = projectPath(p);
      const doc = await current(filePath);
      if (doc.text.length > DOCUMENT_MAX_CHARS) throw new ApiError('TooLarge', 'The document is over 16 MiB');
      return { path: filePath, text: doc.text, version: deps.version(doc.text), dirty: doc.dirty };
    },
  });

  router.register('documents/active', {
    permission: 'documents.read',
    handler: async (caller) => {
      const tab = deps.activeDocTab(caller);
      if (!tab || !tab.doc.path) return null;
      const doc = await current(tab.doc.path, tab);
      return { path: tab.doc.path, version: deps.version(doc.text), editMode: !!tab.doc.editMode };
    },
  });

  router.register('editor/selection', {
    permission: 'documents.read',
    handler: async (caller) => {
      const tab = deps.activeDocTab(caller);
      if (!tab || !tab.doc.path) return null;
      const answer = await deps.ask(tab, 'selection');
      if (!answer || !Number.isInteger(answer.start) || !Number.isInteger(answer.end)) return null;
      const text = typeof answer.text === 'string' ? answer.text : deps.readFile(tab.doc.path);
      const start = Math.max(0, Math.min(answer.start, text.length));
      const end = Math.max(start, Math.min(answer.end, text.length));
      return {
        path: tab.doc.path,
        range: rangeOf(text, start, end),
        text: text.slice(start, end),
        version: deps.version(text),
        source: answer.source === 'viewer' ? 'viewer' : 'editor',
      };
    },
  });

  // documents.sync (experimental): saving and reloading open documents —
  // what a sync or git add-on needs around its own writes.
  function openDocTargets(paths) {
    if (paths === undefined) return null;
    if (!Array.isArray(paths)) throw new ApiError('InvalidParams', 'paths must be a list');
    return paths.map((p) => projectPath(p));
  }

  router.register('documents/save', {
    permission: 'documents.write',
    experimental: 'documents.sync',
    handler: async (caller, { paths }) => {
      const wanted = openDocTargets(paths);
      const tabs = wanted ? wanted.map((p) => ({ p, tab: deps.docTabFor(p) })) : deps.dirtyDocTabs().map((tab) => ({ p: tab.doc.path, tab }));
      const out = [];
      for (const { p, tab } of tabs) {
        if (!tab) {
          out.push({ path: p, status: 'clean' });
          continue;
        }
        const answer = (await deps.ask(tab, 'save')) || { status: 'failed' };
        out.push({ path: p, status: answer.status, ...(answer.version ? { version: answer.version } : {}) });
      }
      return out;
    },
  });

  router.register('documents/reload', {
    permission: 'documents.read',
    experimental: 'documents.sync',
    handler: async (caller, { paths, ifDirty = 'skip' }) => {
      if (ifDirty !== 'skip' && ifDirty !== 'ask') throw new ApiError('InvalidParams', 'ifDirty must be "skip" or "ask"');
      const wanted = openDocTargets(paths);
      const targets = wanted || (deps.activeDocTab(caller) ? [deps.activeDocTab(caller).doc.path] : []);
      const out = [];
      for (const p of targets) {
        const tab = deps.docTabFor(p);
        if (!tab) {
          out.push({ path: p, status: 'notOpen' });
          continue;
        }
        const answer = (await deps.ask(tab, 'reload', { ifDirty })) || { status: 'canceled' };
        out.push({ path: p, status: answer.status, ...(answer.version ? { version: answer.version } : {}) });
      }
      return out;
    },
  });
}

module.exports = { registerDocumentsApi };
