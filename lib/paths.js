// Path helpers for the main process that need no Electron, so they can be
// tested on their own.
const path = require('path');

// Windows paths: the same file whatever the case or the form it is written in.
function samePath(a, b) {
  return !!a && !!b && path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
}

function isPathInside(filePath, rootPath) {
  const rel = path.relative(rootPath, filePath);
  return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel));
}

// The path to open from a command line, as given (not resolved). argv[0] is
// the executable, and an unpackaged run (`electron .`) also has the app path
// as its first plain argument — which is not always argv[1]: the argv a
// second instance hands over has its switches moved ahead of it.
function openArgFromArgv(argv, isPackaged) {
  const plain = argv.slice(1).filter((a) => !a.startsWith('-'));
  return (isPackaged ? plain[0] : plain[1]) || null;
}

module.exports = { samePath, isPathInside, openArgFromArgv };
