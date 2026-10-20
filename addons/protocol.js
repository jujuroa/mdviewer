// The mdviewer-addon:// scheme: each add-on's pages come from its folder,
// under an origin of its own (mdviewer-addon://<id>) — so its web storage
// is its own, and as another site than the app's file: pages its frames
// run in a process of their own — with the Content-Security-Policy from
// pages.js on every response.
const fs = require('fs');
const { protocol, session } = require('electron');
const { SCHEME, contentTypeOf, addonFileFor, contentSecurityPolicy } = require('./pages.js');

// Before the app is ready: a standard, secure scheme gets real origins,
// fetch() and web storage.
function registerAddonScheme() {
  protocol.registerSchemesAsPrivileged([
    { scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } },
  ]);
}

function notFound() {
  return new Response('Not found', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
}

// resolveAddon(id) -> { dir, hosts } for an add-on whose pages may be
// served, else null.
function serveAddonPages(resolveAddon) {
  protocol.handle(SCHEME, async (request) => {
    let url;
    try {
      url = new URL(request.url);
    } catch (err) {
      return notFound();
    }
    const addon = resolveAddon(url.hostname);
    const file = addon && addonFileFor(addon.dir, url.pathname);
    if (!file) return notFound();
    let body;
    try {
      body = await fs.promises.readFile(file);
    } catch (err) {
      return notFound();
    }
    return new Response(body, {
      status: 200,
      headers: {
        'Content-Type': contentTypeOf(file),
        'Content-Security-Policy': contentSecurityPolicy(addon.hosts),
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'no-store',
      },
    });
  });
}

function isAddonUrl(url) {
  return typeof url === 'string' && url.startsWith(`${SCHEME}:`);
}

// Browser permissions (camera, microphone, notifications, ...) are only
// for the app's own pages (file:); an add-on page — or anything else a
// frame ends up showing, such as the error page left by a blocked
// navigation — is refused. A request with no address (the window itself)
// keeps Electron's default.
function isAllowedRequester(url) {
  return !url || url.startsWith('file:');
}

function limitPermissionsToAppPages() {
  const ses = session.defaultSession;
  ses.setPermissionRequestHandler((contents, permission, callback, details) => {
    callback(isAllowedRequester(details && details.requestingUrl));
  });
  ses.setPermissionCheckHandler((contents, permission, requestingOrigin, details) => {
    return isAllowedRequester(requestingOrigin) && isAllowedRequester(details && details.requestingUrl);
  });
}

// Add-on frames are sandboxed without allow-downloads, so Chromium already
// refuses their downloads; one of an add-on's own files is refused here
// too, whoever starts it.
function refuseAddonDownloads() {
  session.defaultSession.on('will-download', (event, item) => {
    if (item.getURLChain().some(isAddonUrl)) event.preventDefault();
  });
}

module.exports = { registerAddonScheme, serveAddonPages, limitPermissionsToAppPages, refuseAddonDownloads, isAddonUrl };
