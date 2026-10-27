// The settings, secrets and context areas (protocol 13.7–13.9).
// deps: settings (AddonSettings), secrets (AddonSecrets),
// setContext(addonId, key, value), changed(entry, key) after a setting
// takes a new value, openForm(caller) to show the add-on's own settings screen.
const { ApiError } = require('../api-router.js');

const KEY = /^[A-Za-z0-9_.-]{1,100}$/;

function key(params) {
  if (typeof params.key !== 'string' || !KEY.test(params.key)) throw new ApiError('InvalidParams', 'key must be a short name');
  return params.key;
}

function registerSettingsApi(router, deps) {
  router.register('settings/get', {
    handler: (caller, params) => {
      if (params.key === undefined) return deps.settings.get(caller.entry);
      const value = deps.settings.get(caller.entry, key(params));
      if (value === undefined) throw new ApiError('NotFound', `No setting "${params.key}" in the manifest`);
      return value;
    },
  });
  router.register('settings/update', {
    handler: (caller, params) => {
      const before = deps.settings.get(caller.entry, key(params));
      try {
        deps.settings.update(caller.entry, key(params), params.value);
      } catch (err) {
        if (err instanceof ApiError) throw err;
        throw new ApiError(err.reason === 'unknownKey' ? 'NotFound' : 'InvalidParams', err.message);
      }
      if (before !== params.value) deps.changed(caller.entry, params.key);
      return null;
    },
  });
  // The Extensions screen's settings for the caller's add-on, in the
  // caller's program window. Resolves once shown, not when closed.
  router.register('settings/open', {
    experimental: 'settings.open',
    handler: (caller) => {
      const c = caller.entry.manifest.contributes || {};
      if (!(c.settings || []).length && !(c.secrets || []).length) throw new ApiError('NotFound', 'The manifest declares no settings or secrets');
      deps.openForm(caller);
      return null;
    },
  });

  // Only the caller's own; never logged (the router logs no parameters).
  router.register('secrets/get', { handler: (caller, params) => deps.secrets.get(caller.addonId, key(params)) });
  router.register('secrets/set', {
    handler: (caller, params) => {
      try {
        deps.secrets.set(caller.addonId, key(params), params.value);
      } catch (err) {
        if (err instanceof ApiError) throw err;
        throw new ApiError({ notAvailable: 'NotSupported', tooLarge: 'TooLarge' }[err.reason] || 'InvalidParams', err.message);
      }
      return null;
    },
  });
  router.register('secrets/delete', {
    handler: (caller, params) => {
      deps.secrets.delete(caller.addonId, key(params));
      return null;
    },
  });

  // For when conditions: <add-on id>.<key>.
  router.register('context/set', {
    handler: (caller, params) => {
      const value = params.value;
      if (value !== null && !['string', 'number', 'boolean'].includes(typeof value)) {
        throw new ApiError('InvalidParams', 'value must be a string, number, boolean or null');
      }
      deps.setContext(caller.addonId, key(params), value);
      return null;
    },
  });
}

module.exports = { registerSettingsApi };
