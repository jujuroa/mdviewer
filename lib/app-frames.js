// Which frames hold the app's own pages, told from their addresses. Pure,
// so it can be tested without Electron: main.js looks at the frames
// themselves (where they sit, which tab they claim) and keeps every other
// frame away from the app's IPC and its pages.

// An address without its query and fragment, in one spelling: the app's
// own page addresses come from pathToFileURL and a frame's from Chromium,
// which may escape characters (a space, Hangul in an install path) or
// write the drive letter differently, and Windows paths ignore case.
function pageKey(url) {
  if (typeof url !== 'string') return '';
  const page = url.replace(/[?#].*$/, '');
  try {
    return decodeURI(page).toLowerCase();
  } catch (err) {
    return page.toLowerCase();
  }
}

function isAppPageUrl(url, appPageUrls) {
  const key = pageKey(url);
  return !!key && appPageUrls.some((page) => pageKey(page) === key);
}

// The tab id in a document tab page's address (`<doc page>?tab=N`, nothing
// else), or 0.
function docTabIdOf(url, docPageUrl) {
  if (typeof url !== 'string') return 0;
  const at = url.indexOf('?');
  if (at === -1 || pageKey(url.slice(0, at)) !== pageKey(docPageUrl)) return 0;
  const match = /^tab=([1-9]\d*)$/.exec(url.slice(at + 1));
  return match ? Number(match[1]) : 0;
}

// `scheme://host` of an address in the given scheme (an add-on page's
// origin, `mdviewer-addon://<id>`), or ''.
function originIn(url, scheme) {
  if (typeof url !== 'string' || !scheme) return '';
  const m = /^([a-z][a-z0-9+.-]*):\/\/([^/?#]*)/i.exec(url);
  return m && m[1].toLowerCase() === scheme ? `${scheme}://${m[2].toLowerCase()}` : '';
}

// Whether a frame below a window's page may go to `targetUrl`. tabLevel:
// the frame is an iframe of the window page itself, where tabs are. An app
// page only loads as a new tab iframe's first page (the window page making
// a tab), and a frame showing an app page never leaves it except to load
// it again. A frame showing an add-on's page (addonScheme) stays within
// that add-on's origin.
function subframeNavigationAllowed({ fromUrl, targetUrl, tabLevel }, { docPageUrl, appPageUrls, addonScheme }) {
  if (isAppPageUrl(fromUrl, appPageUrls)) return targetUrl === fromUrl;
  const addonOrigin = originIn(fromUrl, addonScheme);
  if (addonOrigin) return originIn(targetUrl, addonScheme) === addonOrigin;
  if (!isAppPageUrl(targetUrl, appPageUrls)) return true;
  const fresh = !fromUrl || fromUrl === 'about:blank';
  return tabLevel && fresh && docTabIdOf(targetUrl, docPageUrl) > 0;
}

module.exports = { isAppPageUrl, docTabIdOf, originIn, subframeNavigationAllowed };
