// Finding add-ons (protocol 4.2) and what the app knows about each: where
// it is, its manifest (strings in the app's language), whether it can run
// — 'ok', 'invalid' (a broken manifest), 'incompatible' (protocol 5.2),
// 'blocked' (by policy, protocol 10.4) or 'shadowed' (the same id found in
// a place that comes first) — and whether the user has it on. No Electron
// here; main.js hands in the places to look, the policy and the choices.
const fs = require('fs');
const path = require('path');
const { HOST, checkManifest, compatibilityProblems, activationEvents, localize } = require('./manifest.js');
const { DEFAULT_POLICY, policyProblems } = require('./policy.js');

function readJson(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf-8');
  } catch (err) {
    return { error: err.code === 'ENOENT' ? 'noManifest' : 'unreadable' };
  }
  try {
    return { value: JSON.parse(text.replace(/^﻿/, '')) };
  } catch (err) {
    return { error: 'badJson', detail: err.message };
  }
}

// The folders to look at, first to last: each --addon-dev folder is an
// add-on itself; the extra folders and the install folder hold one add-on
// per subfolder (folders starting with a dot, such as the installer's
// .staging, are skipped).
function candidateFolders({ devDirs = [], extraDirs = [], installDir = null }) {
  const list = devDirs.map((dir) => ({ dir: path.resolve(dir), source: 'dev' }));
  const roots = [...extraDirs.map((root) => ({ root, source: 'extra' }))];
  if (installDir) roots.push({ root: installDir, source: 'installed' });
  for (const { root, source } of roots) {
    let names = [];
    try {
      names = fs
        .readdirSync(root, { withFileTypes: true })
        .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
        .map((e) => e.name)
        .sort();
    } catch (err) {
      /* not there (yet) */
    }
    for (const name of names) list.push({ dir: path.join(root, name), source });
  }
  return list;
}

function loadAddon({ dir, source }, { language, host, policy }) {
  const folder = path.basename(dir);
  const entry = { id: folder, dir, source, status: 'ok', problems: [], warnings: [], manifest: null, activation: [] };
  const read = readJson(path.join(dir, 'manifest.json'));
  if (read.error) {
    entry.status = 'invalid';
    entry.problems.push(read.detail ? { path: 'manifest.json', code: read.error, detail: read.detail } : { path: 'manifest.json', code: read.error });
    return entry;
  }
  const raw = read.value;
  const { errors, warnings } = checkManifest(raw, folder);
  entry.warnings = warnings;
  if (errors.length) {
    entry.status = 'invalid';
    entry.problems = errors;
    return entry;
  }
  const strings = [language, 'en'].map((lang) => readJson(path.join(dir, 'locales', `${lang}.json`)).value || null);
  entry.manifest = localize(raw, strings);
  entry.activation = activationEvents(raw);
  const experimentalAllowed = source === 'dev' || policy.allowExperimentalApi.includes(raw.id);
  entry.problems = compatibilityProblems(raw, { host, experimentalAllowed });
  if (entry.problems.length) {
    entry.status = 'incompatible';
    return entry;
  }
  entry.problems = policyProblems(raw, policy);
  if (entry.problems.length) entry.status = 'blocked';
  return entry;
}

// Every add-on found, in the order looked at. options: the places (see
// candidateFolders), language, host (manifest.js HOST), policy (policy.js
// mergePolicy), isEnabled(id) (the user's choice).
function discover({ language = 'en', host = HOST, policy = DEFAULT_POLICY, isEnabled = () => true, ...places } = {}) {
  const found = [];
  const first = new Map();
  for (const candidate of candidateFolders(places)) {
    const entry = loadAddon(candidate, { language, host, policy });
    entry.enabled = isEnabled(entry.id);
    const winner = first.get(entry.id);
    if (winner) {
      entry.status = 'shadowed';
      entry.problems = [{ path: '', code: 'shadowed', detail: winner.dir }];
    } else {
      first.set(entry.id, entry);
    }
    found.push(entry);
  }
  return found;
}

// The add-ons found last time and the places to look again.
class Registry {
  constructor(options) {
    this.options = options;
    this.entries = [];
  }

  rescan(changes = {}) {
    this.options = { ...this.options, ...changes };
    this.entries = discover(this.options);
    return this.entries;
  }

  list() {
    return this.entries;
  }

  // The add-on that answers to this id (not one it shadows).
  get(id) {
    return this.entries.find((e) => e.id === id && e.status !== 'shadowed') || null;
  }

  // The add-on under this id if it runs: found fine and on.
  running(id) {
    const entry = this.get(id);
    return entry && entry.status === 'ok' && entry.enabled ? entry : null;
  }
}

module.exports = { Registry, discover, candidateFolders };
