// The tabs area (protocol 13.6): an add-on opens, closes and brings
// forward its own tabs, and a tab page sets its title, icon and unsaved
// mark and keeps a small state for after a relaunch. deps:
//   contributes(addonId, tabId) -> whether the add-on has that tab
//   open(caller, tabId, { args, reveal }) -> the tab (single: the open one)
//   instances(addonId, tabId, instanceId?) -> its open tabs
//   close(tab) -> Promise (its page and the user may keep it)
//   reveal(tab)
//   changed(tab) — its title, icon or unsaved mark changed
// A tab's own fields live on tab.addon: args, title, icon, dirty, state,
// restore.
const { ApiError } = require('../api-router.js');

const STATE_MAX_BYTES = 64 * 1024;
const TITLE_MAX = 200;

// A JSON copy at most STATE_MAX_BYTES, or TooLarge.
function smallJson(value, name) {
  let json;
  try {
    json = JSON.stringify(value);
  } catch (err) {
    throw new ApiError('InvalidParams', `${name} must be JSON`);
  }
  if (json === undefined) throw new ApiError('InvalidParams', `${name} must be JSON`);
  if (Buffer.byteLength(json, 'utf8') > STATE_MAX_BYTES) throw new ApiError('TooLarge', `${name} is over ${STATE_MAX_BYTES / 1024} KiB`);
  return JSON.parse(json);
}

// A file in the add-on's folder: relative, forward slashes, no way up.
function packagePath(value) {
  if (typeof value !== 'string' || !value || value.length > 260 || /^[/\\]|[:\\]|(^|\/)\.\.?(\/|$)/.test(value)) {
    throw new ApiError('InvalidParams', 'icon must be a path inside the add-on folder');
  }
  return value;
}

function registerTabsApi(router, deps) {
  // Only a tab page has a tab of its own.
  function ownTab(caller) {
    if (caller.kind !== 'tab' || !caller.tab) throw new ApiError('NotSupported', 'Only a tab page can do this');
    return caller.tab;
  }

  function tabIdOf(caller, params) {
    if (typeof params.tabId !== 'string' || !deps.contributes(caller.addonId, params.tabId)) {
      throw new ApiError('NotFound', `This add-on has no tab "${params.tabId}"`);
    }
    return params.tabId;
  }

  function instancesOf(caller, params) {
    const tabId = tabIdOf(caller, params);
    if (params.instanceId !== undefined && !Number.isInteger(params.instanceId)) throw new ApiError('InvalidParams', 'instanceId must be what tabs/open returned');
    const tabs = deps.instances(caller.addonId, tabId, params.instanceId);
    if (params.instanceId !== undefined && !tabs.length) throw new ApiError('NotFound', 'No such tab open');
    return tabs;
  }

  router.register('tabs/open', {
    handler: (caller, params) => {
      const tabId = tabIdOf(caller, params);
      const args = params.args === undefined ? null : smallJson(params.args, 'args');
      const tab = deps.open(caller, tabId, { args, reveal: params.reveal !== false });
      if (!tab) throw new ApiError('NotFound', 'There is no window to open it in');
      return { instanceId: tab.id };
    },
  });

  router.register('tabs/close', {
    handler: async (caller, params) => {
      for (const tab of instancesOf(caller, params)) await deps.close(tab);
      return null;
    },
  });

  router.register('tabs/reveal', {
    handler: (caller, params) => {
      const [tab] = instancesOf(caller, params);
      if (!tab) throw new ApiError('NotFound', 'No such tab open');
      deps.reveal(tab);
      return null;
    },
  });

  router.register('tabs/update', {
    handler: (caller, params) => {
      const tab = ownTab(caller);
      const next = {};
      if (params.title !== undefined) {
        if (params.title !== null && typeof params.title !== 'string') throw new ApiError('InvalidParams', 'title must be a string or null');
        next.title = params.title === null ? null : params.title.slice(0, TITLE_MAX);
      }
      if (params.icon !== undefined) next.icon = params.icon === null ? null : packagePath(params.icon);
      if (params.dirty !== undefined) {
        if (typeof params.dirty !== 'boolean') throw new ApiError('InvalidParams', 'dirty must be true or false');
        next.dirty = params.dirty;
      }
      Object.assign(tab.addon, next);
      deps.changed(tab);
      return null;
    },
  });

  router.register('tabs/setState', {
    handler: (caller, params) => {
      ownTab(caller).addon.state = params.state === undefined || params.state === null ? null : smallJson(params.state, 'state');
      return null;
    },
  });
  router.register('tabs/getState', {
    handler: (caller) => {
      const state = ownTab(caller).addon.state;
      return state === undefined ? null : state;
    },
  });
  router.register('tabs/getRestoreState', {
    handler: (caller) => ownTab(caller).addon.restore || { reason: 'new', state: null },
  });
  router.register('tabs/getArgs', {
    handler: (caller) => {
      const args = ownTab(caller).addon.args;
      return args === undefined ? null : args;
    },
  });
}

module.exports = { registerTabsApi, smallJson };
