// The `app` area (protocol 13.10). deps: openExternal(url),
// writeClipboard(text), confirmOpen(caller, url) -> whether the user
// agreed.
const { ApiError } = require('../api-router.js');

const CLIPBOARD_MAX_CHARS = 1024 * 1024;

function registerAppApi(router, deps) {
  // Opened by the OS's default program, after the user agrees; only web
  // pages and mail.
  router.register('app/openExternal', {
    handler: async (caller, { url }) => {
      let parsed;
      try {
        parsed = new URL(url);
      } catch (err) {
        throw new ApiError('InvalidParams', 'url must be an address');
      }
      if (parsed.protocol !== 'https:' && parsed.protocol !== 'mailto:') {
        throw new ApiError('PermissionDenied', 'Only https and mailto addresses can be opened');
      }
      if (!(await deps.confirmOpen(caller, parsed.href))) throw new ApiError('UserCanceled', 'The user did not open it');
      await deps.openExternal(parsed.href);
      return null;
    },
  });

  router.register('app/copyToClipboard', {
    handler: (caller, { text }) => {
      if (typeof text !== 'string') throw new ApiError('InvalidParams', 'text must be a string');
      if (text.length > CLIPBOARD_MAX_CHARS) throw new ApiError('TooLarge', 'text is over 1 MiB');
      deps.writeClipboard(text);
      return null;
    },
  });
}

module.exports = { registerAppApi };
