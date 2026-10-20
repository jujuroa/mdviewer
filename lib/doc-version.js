// A document's version: the SHA-1 of its text as UTF-8, in hex (ADR-0004).
// Saving with the version the text was read at refuses to write over a
// file that has changed on disk since.
const crypto = require('crypto');

function contentVersion(text) {
  return crypto.createHash('sha1').update(String(text), 'utf8').digest('hex');
}

// Writes `content` unless the file on disk no longer has `expectedVersion`
// (when given). A file that is gone is written anew. fsImpl: the fs module
// (taken as an argument so tests can pass a fake one).
function writeIfUnchanged(fsImpl, filePath, content, expectedVersion) {
  if (expectedVersion) {
    let current = null;
    try {
      current = contentVersion(fsImpl.readFileSync(filePath, 'utf-8'));
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
    if (current !== null && current !== expectedVersion) return { ok: false, conflict: true, version: current };
  }
  fsImpl.writeFileSync(filePath, content, 'utf-8');
  return { ok: true, version: contentVersion(content) };
}

module.exports = { contentVersion, writeIfUnchanged };
