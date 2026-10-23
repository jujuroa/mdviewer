// edit/apply (protocol 13.4): checking a request and working out what each
// operation would do, before anything is shown or written. No Electron, no
// writes: main.js shows the result for confirmation and applies it.
//
// deps:
//   inProject(path) -> whether an absolute path is inside an open project
//   current(path) -> { text } of the document as the app has it now (its
//     tab's editor while edited, else the file) — throws when unreadable
//   exists(path) -> 'file' | 'dir' | null
//   version(text) -> SHA-1 hex
const path = require('path');
const { ApiError } = require('./api-router.js');
const { offsetsOf } = require('../lib/text-range.js');

const MAX_OPERATIONS = 100;

function absolute(value, name, deps) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) throw new ApiError('InvalidParams', `${name} must be an absolute path`);
  const resolved = path.resolve(value);
  if (!deps.inProject(resolved)) throw new ApiError('OutsideProject', `${value} is outside the open projects`);
  return resolved;
}

// The text after `changes` (ranges into `text`, which must not overlap).
function applyChanges(text, changes, where) {
  if (!Array.isArray(changes) || !changes.length) throw new ApiError('InvalidParams', `${where}.changes must be a non-empty list`);
  const spans = changes.map((c, i) => {
    if (!c || typeof c.newText !== 'string') throw new ApiError('InvalidParams', `${where}.changes[${i}].newText must be a string`);
    const offsets = offsetsOf(text, c.range);
    if (!offsets) throw new ApiError('InvalidParams', `${where}.changes[${i}].range is not in the document`);
    return { start: offsets[0], end: offsets[1], newText: c.newText };
  });
  spans.sort((a, b) => a.start - b.start || a.end - b.end);
  for (let i = 1; i < spans.length; i++) {
    if (spans[i].start < spans[i - 1].end) throw new ApiError('InvalidParams', `${where}.changes overlap`);
  }
  let out = '';
  let at = 0;
  for (const s of spans) {
    out += text.slice(at, s.start) + s.newText;
    at = s.end;
  }
  return out + text.slice(at);
}

// What the request would do: { label, confirm, operations: [...] } where
// each operation is { kind, path, before?, after?, baseVersion?, from?, to? }.
// Throws ApiError for anything that does not hold (all or nothing).
async function planEdit(params, deps) {
  const { label, confirm = 'always', operations } = params || {};
  if (label !== undefined && typeof label !== 'string') throw new ApiError('InvalidParams', 'label must be a string');
  if (confirm !== 'always' && confirm !== 'auto') throw new ApiError('InvalidParams', 'confirm must be "always" or "auto"');
  if (!Array.isArray(operations) || !operations.length) throw new ApiError('InvalidParams', 'operations must be a non-empty list');
  if (operations.length > MAX_OPERATIONS) throw new ApiError('TooLarge', `At most ${MAX_OPERATIONS} operations`);
  const touched = new Set();
  const touch = (p) => {
    const key = p.toLowerCase();
    if (touched.has(key)) throw new ApiError('InvalidParams', `${p} is in more than one operation`);
    touched.add(key);
  };
  const planned = [];
  for (let i = 0; i < operations.length; i++) {
    const op = operations[i] || {};
    const where = `operations[${i}]`;
    if (op.kind === 'change') {
      const p = absolute(op.path, `${where}.path`, deps);
      touch(p);
      if (typeof op.baseVersion !== 'string') throw new ApiError('InvalidParams', `${where}.baseVersion must be the version read`);
      let doc;
      try {
        doc = await deps.current(p);
      } catch (err) {
        throw new ApiError('NotFound', `${p} cannot be read`);
      }
      const currentVersion = deps.version(doc.text);
      if (currentVersion !== op.baseVersion) throw new ApiError('Conflict', `${p} changed since it was read`, { path: p, currentVersion });
      planned.push({ kind: 'change', path: p, before: doc.text, after: applyChanges(doc.text, op.changes, where), baseVersion: currentVersion });
    } else if (op.kind === 'create') {
      const p = absolute(op.path, `${where}.path`, deps);
      touch(p);
      if (typeof op.text !== 'string') throw new ApiError('InvalidParams', `${where}.text must be a string`);
      if (deps.exists(p)) throw new ApiError('Conflict', `${p} already exists`, { path: p });
      if (deps.exists(path.dirname(p)) !== 'dir') throw new ApiError('NotFound', `The folder of ${p} does not exist`);
      planned.push({ kind: 'create', path: p, before: '', after: op.text });
    } else if (op.kind === 'rename') {
      const from = absolute(op.from, `${where}.from`, deps);
      const to = absolute(op.to, `${where}.to`, deps);
      touch(from);
      touch(to);
      if (deps.exists(from) !== 'file') throw new ApiError('NotFound', `${from} is not a file`);
      if (deps.exists(to)) throw new ApiError('Conflict', `${to} already exists`, { path: to });
      if (deps.exists(path.dirname(to)) !== 'dir') throw new ApiError('NotFound', `The folder of ${to} does not exist`);
      planned.push({ kind: 'rename', from, to });
    } else if (op.kind === 'delete') {
      const p = absolute(op.path, `${where}.path`, deps);
      touch(p);
      if (deps.exists(p) !== 'file') throw new ApiError('NotFound', `${p} is not a file`);
      planned.push({ kind: 'delete', path: p });
    } else {
      throw new ApiError('InvalidParams', `${where}.kind must be change, create, rename or delete`);
    }
  }
  return { label: label || '', confirm, operations: planned };
}

// Whether the user must see it: always, unless the add-on asked for "auto"
// and the app lets it (rename and delete always ask).
function needsConfirmation(plan, alwaysConfirm) {
  if (alwaysConfirm || plan.confirm !== 'auto') return true;
  return plan.operations.some((op) => op.kind === 'rename' || op.kind === 'delete');
}

module.exports = { planEdit, needsConfirmation, applyChanges };
