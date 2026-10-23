// The storage area (protocol 13.13): files in the add-on's own data folder
// (protocol 4.4) —
//   <base>/<id>/global/...
//   <base>/<id>/projects/<first 16 of the SHA-1 of the project root>/...
// Paths are relative to the scope's folder; nothing leads out of it.
// deps:
//   baseDir() -> the addon-data folder
//   projectRoots() -> the open project roots
const fs = require('fs');
const path = require('path');
const { createHash } = require('crypto');
const { ApiError } = require('../api-router.js');

const MAX_FILE_BYTES = 64 * 1024 * 1024;
const BAD_NAME = /[<>:"|?*\u0000-\u001f]|[. ]$/;
const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i; // Windows device names

function projectKey(root) {
  const normal = path.resolve(root);
  return createHash('sha1')
    .update(process.platform === 'win32' ? normal.toLowerCase() : normal, 'utf8')
    .digest('hex')
    .slice(0, 16);
}

// The parts of a relative path ('a/b.json', 'a\\b.json'), or InvalidParams.
function relativeParts(value, { optional = false } = {}) {
  if (value === undefined || value === '') {
    if (optional) return [];
    throw new ApiError('InvalidParams', 'path is required');
  }
  if (typeof value !== 'string' || value.length > 1024) throw new ApiError('InvalidParams', 'path must be a string');
  if (/^[/\\]/.test(value)) throw new ApiError('InvalidParams', 'path must be relative to the data folder');
  const parts = value.split(/[/\\]+/).filter((p, i, all) => p !== '' || i < all.length - 1);
  for (const part of parts) {
    if (part === '' || part === '.' || part === '..' || BAD_NAME.test(part) || RESERVED.test(part)) throw new ApiError('InvalidParams', `"${value}" is not a path inside the data folder`);
  }
  return parts;
}

function registerStorageApi(router, deps) {
  function addonDir(caller) {
    return path.join(deps.baseDir(), caller.addonId);
  }

  function projectRoot(root) {
    if (typeof root !== 'string' || !root) throw new ApiError('InvalidParams', 'scope "project" needs root, an open project root');
    const key = projectKey(root);
    if (!deps.projectRoots().some((r) => projectKey(r) === key)) throw new ApiError('OutsideProject', `${root} is not an open project`);
    return key;
  }

  function scopeDir(caller, params) {
    if (params.scope === 'global') return path.join(addonDir(caller), 'global');
    if (params.scope === 'project') return path.join(addonDir(caller), 'projects', projectRoot(params.root));
    throw new ApiError('InvalidParams', 'scope must be "global" or "project"');
  }

  function target(caller, params, opts) {
    const dir = scopeDir(caller, params);
    const full = path.join(dir, ...relativeParts(params.path, opts));
    // A last check that it stayed inside.
    const rel = path.relative(dir, full);
    if (rel.startsWith('..') || path.isAbsolute(rel)) throw new ApiError('InvalidParams', 'path leads out of the data folder');
    return { dir, full };
  }

  router.register('storage/readFile', {
    handler: (caller, params) => {
      const { full } = target(caller, params);
      const encoding = params.encoding === undefined ? 'utf8' : params.encoding;
      if (encoding !== 'utf8' && encoding !== 'binary') throw new ApiError('InvalidParams', 'encoding must be "utf8" or "binary"');
      let st;
      try {
        st = fs.statSync(full);
      } catch (err) {
        throw new ApiError('NotFound', `No file ${params.path}`);
      }
      if (!st.isFile()) throw new ApiError('NotFound', `${params.path} is not a file`);
      if (st.size > MAX_FILE_BYTES) throw new ApiError('TooLarge', `${params.path} is over ${MAX_FILE_BYTES / 1024 / 1024} MiB`);
      const data = fs.readFileSync(full);
      return encoding === 'utf8' ? data.toString('utf8') : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    },
  });

  router.register('storage/writeFile', {
    handler: (caller, params) => {
      const { full } = target(caller, params);
      const { data } = params;
      let bytes;
      if (typeof data === 'string') bytes = Buffer.from(data, 'utf8');
      else if (data instanceof Uint8Array) bytes = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
      else throw new ApiError('InvalidParams', 'data must be a string or a Uint8Array');
      if (bytes.length > MAX_FILE_BYTES) throw new ApiError('TooLarge', `data is over ${MAX_FILE_BYTES / 1024 / 1024} MiB`);
      try {
        if (fs.statSync(full).isDirectory()) throw new ApiError('Conflict', `${params.path} is a folder`);
      } catch (err) {
        if (err instanceof ApiError) throw err;
      }
      fs.mkdirSync(path.dirname(full), { recursive: true });
      // Written whole or not at all: a temporary file, then swapped in.
      const tmp = `${full}.${process.pid}.${Date.now()}.tmp`;
      try {
        fs.writeFileSync(tmp, bytes);
        fs.renameSync(tmp, full);
      } catch (err) {
        try {
          fs.unlinkSync(tmp);
        } catch (e) {
          /* not there */
        }
        throw new ApiError('InternalError', `Could not write ${params.path}`);
      }
      return null;
    },
  });

  router.register('storage/list', {
    handler: (caller, params) => {
      const { full } = target(caller, params, { optional: true });
      let entries;
      try {
        entries = fs.readdirSync(full, { withFileTypes: true });
      } catch (err) {
        // The scope's folder before anything was written: empty.
        if (params.path === undefined || params.path === '') return [];
        throw new ApiError('NotFound', `No folder ${params.path}`);
      }
      return entries
        .filter((e) => e.isFile() || e.isDirectory())
        .map((e) => {
          const st = fs.statSync(path.join(full, e.name));
          return { name: e.name, kind: e.isDirectory() ? 'dir' : 'file', size: e.isDirectory() ? 0 : st.size, mtime: st.mtimeMs };
        });
    },
  });

  // Deleting what is not there is fine; no path clears the scope.
  router.register('storage/delete', {
    handler: (caller, params) => {
      const { full } = target(caller, params, { optional: true });
      fs.rmSync(full, { recursive: true, force: true });
      return null;
    },
  });

  // Real folders, only to hand to an external program (protocol 13.13).
  router.register('storage/paths', {
    handler: (caller, params) => {
      const global = path.join(addonDir(caller), 'global');
      fs.mkdirSync(global, { recursive: true });
      const out = { global };
      if (params.root !== undefined) {
        out.project = path.join(addonDir(caller), 'projects', projectRoot(params.root));
        fs.mkdirSync(out.project, { recursive: true });
      }
      return out;
    },
  });
}

module.exports = { registerStorageApi, projectKey, relativeParts };
