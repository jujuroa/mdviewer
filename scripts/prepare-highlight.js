// Builds a browser copy of highlight.js into src/vendor/highlight/ for the
// source editor's colouring layer (doc.html loads it with a plain <script>).
//
// The viewer highlights in the main process with the npm package, but the
// tab pages are sandboxed and can't require() it, and the package ships only
// CommonJS. Its core and language files have no require()s of their own,
// though, so wrapping each in a module shim and registering the languages
// the way lib/index.js does gives the same highlighter, every language
// included, so the editor colours code exactly as the viewer does.
//
// Runs automatically before `npm start` / `npm run pack` / `npm run dist`
// (see package.json pre* hooks). The output is not committed.

const fs = require('fs');
const path = require('path');

const PACKAGE_DIR = path.join(__dirname, '..', 'node_modules', 'highlight.js');
const LIB_DIR = path.join(PACKAGE_DIR, 'lib');
const OUT_DIR = path.join(__dirname, '..', 'src', 'vendor', 'highlight');
const OUT = path.join(OUT_DIR, 'highlight.js');
const VERSION_STAMP = path.join(OUT_DIR, 'version.txt');

function installedVersion() {
  return JSON.parse(fs.readFileSync(path.join(PACKAGE_DIR, 'package.json'), 'utf-8')).version;
}

// A CommonJS file as an expression evaluating to its module.exports.
function wrapModule(file) {
  const source = fs.readFileSync(file, 'utf-8');
  return `(function () {\nvar module = { exports: {} }, exports = module.exports;\n${source}\nreturn module.exports;\n})()`;
}

function main() {
  if (!fs.existsSync(path.join(LIB_DIR, 'index.js'))) {
    console.error('[prepare-highlight] node_modules/highlight.js not found. Run "npm install" first.');
    process.exit(1);
  }

  const version = installedVersion();
  const prepared =
    fs.existsSync(OUT) &&
    fs.existsSync(VERSION_STAMP) &&
    fs.readFileSync(VERSION_STAMP, 'utf-8').trim() === version;
  if (prepared) {
    console.log(`[prepare-highlight] highlight.js ${version} already prepared, skipping.`);
    return;
  }

  const index = fs.readFileSync(path.join(LIB_DIR, 'index.js'), 'utf-8');
  const registrations = [...index.matchAll(/registerLanguage\('([^']+)',\s*require\('\.\/languages\/([^']+)'\)\)/g)];
  if (registrations.length === 0) {
    console.error('[prepare-highlight] no languages found in highlight.js/lib/index.js.');
    process.exit(1);
  }

  const parts = [
    `/* highlight.js ${version} (BSD-3-Clause), browser build made by scripts/prepare-highlight.js */`,
    'window.hljs = (function () {',
    `var hljs = ${wrapModule(path.join(LIB_DIR, 'core.js'))};`,
  ];
  for (const [, name, file] of registrations) {
    parts.push(`hljs.registerLanguage(${JSON.stringify(name)}, ${wrapModule(path.join(LIB_DIR, 'languages', `${file}.js`))});`);
  }
  parts.push('return hljs;', '})();', '');

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(OUT, parts.join('\n'), 'utf-8');
  fs.writeFileSync(VERSION_STAMP, `${version}\n`, 'utf-8');
  console.log(`[prepare-highlight] highlight.js ${version} (${registrations.length} languages) -> src/vendor/highlight/highlight.js`);
}

main();
