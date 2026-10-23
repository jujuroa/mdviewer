// Checking an add-on's manifest.json (protocol 6) and deciding whether this
// app can run it (protocol 5.2). Pure, so it can be tested without Electron.
// Problems come back as { path, code, detail? }: path points at the field
// (e.g. "contributes.commands[1].handler"), code is what the management
// screen translates ("addons.problem.<code>" in assets/i18n.js).
const semver = require('semver');
const { hostSource } = require('./pages.js');
const { parseWhen } = require('./when.js');

const ID_PATTERN = /^[a-z][a-z0-9-]{1,39}$/;
const KNOWN_FIELDS = new Set([
  'manifestVersion', 'id', 'name', 'description', 'version', 'publisher', 'license', 'homepage',
  'engines', 'background', 'permissions', 'network', 'executables', 'activation', 'experimentalApi', 'contributes',
]);
const PERMISSIONS = new Set(['documents.read', 'documents.write', 'terminal']);
const ACTIVATION_PATTERN = /^(onStartup|onProject|onProjectContains:.+|onCommand:.+|onTab:.+)$/;
const MENU_IDS = new Set([
  'menubar/addons', 'explorer/item', 'explorer/project', 'explorer/empty',
  'viewer/context', 'viewer/selection', 'editor/context', 'tab/context',
]);
const SETTING_TYPES = new Set(['string', 'number', 'boolean', 'enum']);

const isObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const isText = (v) => typeof v === 'string' && v.trim() !== '';
// A path inside the add-on folder, written with forward slashes.
const isEntry = (v) => isText(v) && !/^[/\\]|^[a-z]:|(^|[/\\])\.\.([/\\]|$)/i.test(v);

// Problems with `manifest` for an add-on found in a folder named
// `folderName`: { errors, warnings }. Any error keeps the add-on from
// loading.
function checkManifest(manifest, folderName) {
  const errors = [];
  const warnings = [];
  const err = (path, code, detail) => errors.push(detail === undefined ? { path, code } : { path, code, detail });
  const warn = (path, code, detail) => warnings.push(detail === undefined ? { path, code } : { path, code, detail });

  if (!isObject(manifest)) {
    err('', 'notObject');
    return { errors, warnings };
  }
  for (const key of Object.keys(manifest)) {
    if (!KNOWN_FIELDS.has(key)) warn(key, 'unknownField');
  }

  if (manifest.manifestVersion === undefined) err('manifestVersion', 'required');
  else if (!Number.isInteger(manifest.manifestVersion)) err('manifestVersion', 'notInteger');

  const id = manifest.id;
  if (id === undefined) err('id', 'required');
  else if (typeof id !== 'string' || !ID_PATTERN.test(id)) err('id', 'badId', String(id));
  else if (folderName !== undefined && id !== folderName) err('id', 'folderMismatch', folderName);

  if (manifest.name === undefined) err('name', 'required');
  else if (!isText(manifest.name)) err('name', 'notText');
  for (const key of ['description', 'publisher', 'license', 'homepage']) {
    if (manifest[key] !== undefined && typeof manifest[key] !== 'string') err(key, 'notText');
  }

  if (manifest.version === undefined) err('version', 'required');
  else if (typeof manifest.version !== 'string' || !semver.valid(manifest.version)) err('version', 'badVersion', String(manifest.version));

  const engines = manifest.engines;
  if (engines === undefined) err('engines', 'required');
  else if (!isObject(engines)) err('engines', 'notObject');
  else {
    if (engines.mdviewer === undefined) err('engines.mdviewer', 'required');
    else if (typeof engines.mdviewer !== 'string' || !semver.validRange(engines.mdviewer)) err('engines.mdviewer', 'badRange', String(engines.mdviewer));
    if (engines.api === undefined) err('engines.api', 'required');
    else if (!Number.isInteger(engines.api)) err('engines.api', 'notInteger');
    if (engines.capabilities !== undefined) {
      if (!isObject(engines.capabilities)) err('engines.capabilities', 'notObject');
      else {
        for (const [area, v] of Object.entries(engines.capabilities)) {
          if (!Number.isInteger(v) || v < 1) err(`engines.capabilities.${area}`, 'notInteger');
        }
      }
    }
  }

  const background = manifest.background;
  if (background !== undefined) {
    if (!isObject(background)) err('background', 'notObject');
    else {
      if (!isEntry(background.entry)) err('background.entry', 'badEntry', String(background.entry));
      if (background.idleTimeoutSec !== undefined && (!Number.isInteger(background.idleTimeoutSec) || background.idleTimeoutSec < 0)) {
        err('background.idleTimeoutSec', 'notInteger');
      }
    }
  }

  checkStringList(manifest.permissions, 'permissions', err, (p, path) => {
    if (!PERMISSIONS.has(p)) err(path, 'unknownPermission', p);
  });

  if (manifest.network !== undefined) {
    if (!isObject(manifest.network)) err('network', 'notObject');
    else {
      checkStringList(manifest.network.hosts, 'network.hosts', err, (h, path) => {
        if (!hostSource(h)) err(path, 'badHost', h);
      });
    }
  }

  if (manifest.executables !== undefined) {
    if (!Array.isArray(manifest.executables)) err('executables', 'notArray');
    else {
      const seen = new Set();
      manifest.executables.forEach((x, i) => {
        const path = `executables[${i}]`;
        if (!isObject(x)) return err(path, 'notObject');
        if (!isText(x.id)) err(`${path}.id`, 'required');
        else if (seen.has(x.id)) err(`${path}.id`, 'duplicate', x.id);
        else seen.add(x.id);
        if (!isEntry(x.path)) err(`${path}.path`, 'badEntry', String(x.path));
      });
    }
  }

  checkStringList(manifest.activation, 'activation', err, (a, path) => {
    if (!ACTIVATION_PATTERN.test(a)) err(path, 'badActivation', a);
  });
  checkStringList(manifest.experimentalApi, 'experimentalApi', err);

  const tabIds = new Set();
  const commandIds = new Set();
  const prefix = typeof id === 'string' ? `${id}.` : null;
  const ownId = (value, path) => {
    if (!isText(value)) return err(path, 'required'), false;
    if (prefix && !value.startsWith(prefix)) return err(path, 'notPrefixed', prefix), false;
    return true;
  };
  const contributes = manifest.contributes;
  if (contributes !== undefined && !isObject(contributes)) err('contributes', 'notObject');
  const c = isObject(contributes) ? contributes : {};

  eachItem(c.tabs, 'contributes.tabs', err, (tab, path) => {
    if (ownId(tab.id, `${path}.id`)) {
      if (tabIds.has(tab.id)) err(`${path}.id`, 'duplicate', tab.id);
      tabIds.add(tab.id);
    }
    if (!isText(tab.title)) err(`${path}.title`, 'required');
    if (!isEntry(tab.entry)) err(`${path}.entry`, 'badEntry', String(tab.entry));
    if (tab.icon !== undefined && !isEntry(tab.icon)) err(`${path}.icon`, 'badEntry', String(tab.icon));
    if (tab.instances !== undefined && tab.instances !== 'single' && tab.instances !== 'multiple') err(`${path}.instances`, 'badValue', String(tab.instances));
  });
  eachItem(c.commands, 'contributes.commands', err, (cmd, path) => {
    if (ownId(cmd.id, `${path}.id`)) {
      if (commandIds.has(cmd.id)) err(`${path}.id`, 'duplicate', cmd.id);
      commandIds.add(cmd.id);
    }
    if (!isText(cmd.title)) err(`${path}.title`, 'required');
    // Where it is handled (protocol 7.6): the background frame unless it
    // names a tab.
    const handler = cmd.handler === undefined ? 'background' : cmd.handler;
    if (handler === 'background') {
      if (!isObject(background)) err(`${path}.handler`, 'noBackground');
    } else if (typeof handler === 'string' && handler.startsWith('tab:')) {
      if (!tabIds.has(handler.slice(4))) err(`${path}.handler`, 'unknownTab', handler.slice(4));
    } else err(`${path}.handler`, 'badValue', String(handler));
  });
  if (c.menus !== undefined) {
    if (!isObject(c.menus)) err('contributes.menus', 'notObject');
    else {
      for (const [menu, items] of Object.entries(c.menus)) {
        const path = `contributes.menus.${menu}`;
        if (!MENU_IDS.has(menu)) {
          warn(path, 'unknownMenu');
          continue;
        }
        eachItem(items, path, err, (item, p) => {
          if (!commandIds.has(item.command)) err(`${p}.command`, 'unknownCommand', String(item.command));
          checkWhen(item.when, `${p}.when`, err);
        });
      }
    }
  }
  eachItem(c.keybindings, 'contributes.keybindings', err, (kb, path) => {
    if (!commandIds.has(kb.command)) err(`${path}.command`, 'unknownCommand', String(kb.command));
    if (!isText(kb.key)) err(`${path}.key`, 'required');
    checkWhen(kb.when, `${path}.when`, err);
  });
  const settingKeys = new Set();
  eachItem(c.settings, 'contributes.settings', err, (s, path) => {
    if (!isText(s.key)) err(`${path}.key`, 'required');
    else if (settingKeys.has(s.key)) err(`${path}.key`, 'duplicate', s.key);
    else settingKeys.add(s.key);
    if (!SETTING_TYPES.has(s.type)) err(`${path}.type`, 'badValue', String(s.type));
    if (s.type === 'enum' && (!Array.isArray(s.enum) || !s.enum.length)) err(`${path}.enum`, 'required');
  });
  eachItem(c.secrets, 'contributes.secrets', err, (s, path) => {
    if (!isText(s.key)) err(`${path}.key`, 'required');
  });
  for (const key of Object.keys(c)) {
    if (!['tabs', 'commands', 'menus', 'keybindings', 'settings', 'secrets', 'panels', 'statusBar', 'treeDecorations'].includes(key)) {
      warn(`contributes.${key}`, 'unknownField');
    }
  }

  // Code has to run somewhere.
  if (!isObject(background) && tabIds.size === 0) err('', 'nothingToRun');

  return { errors, warnings };
}

function checkWhen(value, path, err) {
  if (value === undefined) return;
  try {
    parseWhen(value);
  } catch (e) {
    err(path, 'badWhen', String(value));
  }
}

function checkStringList(value, path, err, each) {
  if (value === undefined) return;
  if (!Array.isArray(value)) return err(path, 'notArray');
  value.forEach((v, i) => {
    if (typeof v !== 'string' || !v) err(`${path}[${i}]`, 'notText');
    else if (each) each(v, `${path}[${i}]`);
  });
}

function eachItem(value, path, err, each) {
  if (value === undefined) return;
  if (!Array.isArray(value)) return err(path, 'notArray');
  value.forEach((item, i) => {
    if (!isObject(item)) err(`${path}[${i}]`, 'notObject');
    else each(item, `${path}[${i}]`);
  });
}

// What this app offers add-ons: its version for engines.mdviewer, the API
// version, the manifest versions it reads, and each area's version
// (protocol 5.1). Areas are added here as they are built.
const HOST = {
  // The add-on framework comes with 2.0.0; until the app itself is 2.0.0
  // (it is 1.x while the framework is being built), add-ons are judged
  // against this.
  version: '2.0.0',
  api: 1,
  manifestVersions: [1],
  capabilities: { app: 1, settings: 1, secrets: 1, context: 1 },
};

// Why the app cannot run a manifest that passed checkManifest, as problems
// (empty when it can). experimentalAllowed: whether this add-on may use
// experimental APIs (loaded with --addon-dev, or allowed by policy).
function compatibilityProblems(manifest, { host = HOST, experimentalAllowed = false } = {}) {
  const problems = [];
  if (!host.manifestVersions.includes(manifest.manifestVersion)) problems.push({ path: 'manifestVersion', code: 'unknownManifestVersion', detail: String(manifest.manifestVersion) });
  if (!semver.satisfies(host.version, manifest.engines.mdviewer, { includePrerelease: true })) {
    problems.push({ path: 'engines.mdviewer', code: 'appVersion', detail: `${manifest.engines.mdviewer} / ${host.version}` });
  }
  if (manifest.engines.api !== host.api) problems.push({ path: 'engines.api', code: 'apiVersion', detail: `${manifest.engines.api} / ${host.api}` });
  for (const [area, v] of Object.entries(manifest.engines.capabilities || {})) {
    if (!(host.capabilities[area] >= v)) problems.push({ path: `engines.capabilities.${area}`, code: 'capability', detail: `${area} ${v}` });
  }
  if ((manifest.experimentalApi || []).length && !experimentalAllowed) {
    problems.push({ path: 'experimentalApi', code: 'experimentalNotAllowed', detail: manifest.experimentalApi.join(', ') });
  }
  return problems;
}

// The activation events in effect: those inferred from contributes plus
// the manifest's own (protocol 7.3).
function activationEvents(manifest) {
  const c = manifest.contributes || {};
  const events = [
    ...(c.commands || []).map((cmd) => `onCommand:${cmd.id}`),
    ...(c.tabs || []).map((tab) => `onTab:${tab.id}`),
    ...(manifest.activation || []),
  ];
  return [...new Set(events)];
}

// `%key%` strings replaced from the add-on's strings for the language
// (locales/<lang>.json), falling back to English; one found in neither
// stays as written, so a missing string shows.
function localize(value, strings) {
  if (typeof value === 'string') {
    const m = /^%([^%]+)%$/.exec(value);
    if (!m) return value;
    for (const table of strings) {
      if (table && typeof table[m[1]] === 'string') return table[m[1]];
    }
    return value;
  }
  if (Array.isArray(value)) return value.map((v) => localize(v, strings));
  if (isObject(value)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, localize(v, strings)]));
  return value;
}

module.exports = { HOST, checkManifest, compatibilityProblems, activationEvents, localize };
