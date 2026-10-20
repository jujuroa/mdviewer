// What the mdviewer-addon:// scheme serves, worked out without Electron
// (see protocol.js for the scheme itself): which file an address names,
// its type, and the Content-Security-Policy every add-on page gets.
const path = require('path');
const { isPathInside } = require('../lib/paths.js');

const SCHEME = 'mdviewer-addon';

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
};

function contentTypeOf(filePath) {
  return CONTENT_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
}

// The file under the add-on's folder that a URL path names, or null for
// one that would leave the folder (or names the folder itself).
function addonFileFor(dir, pathname) {
  let rel;
  try {
    rel = decodeURIComponent(pathname || '');
  } catch (err) {
    return null;
  }
  rel = rel.replace(/^[/\\]+/, '');
  if (!rel || rel.includes('\0')) return null;
  const root = path.resolve(dir);
  const file = path.resolve(root, rel);
  return file !== root && isPathInside(file, root) ? file : null;
}

// A host an add-on may connect to (manifest network.hosts) as a CSP
// source: "api.example.com" means https only; a scheme or a port given
// stays as given. Anything that isn't a plain host is dropped.
function hostSource(host) {
  const m = /^(?:(https?|wss?):\/\/)?([a-z0-9.-]+|\*\.[a-z0-9.-]+|\[[0-9a-f:]+\])(?::(\d{1,5}))?$/i.exec(String(host || '').trim());
  if (!m) return null;
  const [, scheme, name, port] = m;
  return `${scheme || 'https'}://${name}${port ? `:${port}` : ''}`;
}

// Its own folder for scripts, styles, images and workers; the network only
// to its own pages and the hosts it declares; no frames, no form posts, no
// plugins.
function contentSecurityPolicy(hosts = []) {
  const connect = ["'self'", ...hosts.map(hostSource).filter(Boolean)];
  return [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "media-src 'self' blob:",
    `connect-src ${connect.join(' ')}`,
    "worker-src 'self'",
    "frame-src 'none'",
    "child-src 'none'",
    "object-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
  ].join('; ');
}

module.exports = { SCHEME, contentTypeOf, addonFileFor, hostSource, contentSecurityPolicy };
