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

// Switches whose value may come as the next argument (`--addon-dev <dir>`).
const VALUE_SWITCHES = new Set(['--addon-dev']);

// The arguments that are neither switches nor a switch's value.
function plainArgs(argv) {
  const plain = [];
  for (let i = 1; i < argv.length; i++) {
    if (VALUE_SWITCHES.has(argv[i])) i++;
    else if (!argv[i].startsWith('-')) plain.push(argv[i]);
  }
  return plain;
}

// The path to open from a command line, as given (not resolved). argv[0] is
// the executable, and an unpackaged run (`electron .`) also has the app path
// as its first plain argument — which is not always argv[1]: the argv a
// second instance hands over has its switches moved ahead of it.
function openArgFromArgv(argv, isPackaged) {
  const plain = plainArgs(argv);
  return (isPackaged ? plain[0] : plain[1]) || null;
}

// Every value of a switch: `--name value` or `--name=value`, any number of
// times.
function switchValues(argv, name) {
  const values = [];
  for (let i = 1; i < argv.length; i++) {
    if (argv[i] === name && i + 1 < argv.length) values.push(argv[++i]);
    else if (argv[i].startsWith(`${name}=`)) values.push(argv[i].slice(name.length + 1));
  }
  return values.filter(Boolean);
}

module.exports = { samePath, isPathInside, openArgFromArgv, switchValues };
