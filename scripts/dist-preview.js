// Builds an NSIS installer stamped as a prerelease of the *next* version, so
// the work leading up to a release can be installed and used without pretending
// to be that release.
//
//   npm run dist:preview                      -> 1.3.0-preview.1, .2, .3, ...
//   npm run dist:preview -- 1.3.0-preview.7   (explicit full version)
//   npm run dist:preview -- --base=1.4.0      (different target version)
//   npm run dist:preview -- --dry-run         (print the version, build nothing)
//
// Apart from the version and the output directory, the build is exactly what
// `npm run dist` produces - same target, same compression - so what is tested
// is what would ship.
//
// The version is injected with electron-builder's `extraMetadata`, not by
// editing package.json: the repo keeps reporting the last released version,
// while the built app reports the preview version everywhere it matters - the
// installer file name, the About dialog, and the title bar (see
// PREVIEW_VERSION_SUFFIX in main.js).
//
// This is an overwrite-style preview: same appId and productName as the
// release, so installing it upgrades the installed MD Viewer in place and
// inherits its settings. To go back, re-run the last release installer from
// dist/.
//
// Output goes to dist/preview/ rather than dist/, so preview builds neither
// pile up next to the release installers nor clobber their latest.yml.

delete process.env.ELECTRON_RUN_AS_NODE;

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'dist', 'preview');
const PRODUCT_NAME = require(path.join(ROOT, 'package.json')).build.productName;

// 1.2.2 -> 1.3.0: a preview is for the next feature release, since that is
// what accumulating unreleased changes adds up to. --base overrides it for a
// major bump or a patch-only release.
function nextMinor(version) {
  const [major, minor] = version.split('-')[0].split('.').map(Number);
  return `${major}.${minor + 1}.0`;
}

// Preview numbering is derived from what is already in dist/preview/ rather
// than from a counter file, so it stays correct after the directory is
// cleaned out and needs nothing committed to the repo.
function nextPreviewNumber(base) {
  if (!fs.existsSync(OUT_DIR)) return 1;
  const pattern = new RegExp(
    `^${escapeRegExp(PRODUCT_NAME)} Setup ${escapeRegExp(base)}-preview\\.(\\d+)\\.exe$`
  );
  let highest = 0;
  for (const name of fs.readdirSync(OUT_DIR)) {
    const match = name.match(pattern);
    if (match) highest = Math.max(highest, Number(match[1]));
  }
  return highest + 1;
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const args = process.argv.slice(2);
const baseArg = args.find((a) => a.startsWith('--base='));
const dryRun = args.includes('--dry-run');
const explicitVersion = args.find((a) => !a.startsWith('--'));

const pkgVersion = require(path.join(ROOT, 'package.json')).version;
const base = baseArg ? baseArg.slice('--base='.length) : nextMinor(pkgVersion);
const version = explicitVersion || `${base}-preview.${nextPreviewNumber(base)}`;

if (!/-/.test(version)) {
  console.error(
    `[dist-preview] "${version}" has no prerelease tag - that would build a real release.\n` +
      '              Use npm run dist for that, or pass e.g. 1.3.0-preview.1.'
  );
  process.exit(1);
}

console.log(`[dist-preview] ${PRODUCT_NAME} ${version}`);
console.log(`[dist-preview] output: ${path.relative(ROOT, OUT_DIR)}`);
if (dryRun) process.exit(0);

// electron-builder's cli.js is run with this same node binary, not through
// `npx electron-builder`: going through the npx.cmd shim silently dropped the
// `-c.*` overrides (so it built a plain release straight into dist/, on top of
// the real release installer) and swallowed electron-builder's output along
// with it. Invoking the CLI's entry point directly avoids both.
const result = spawnSync(
  process.execPath,
  [
    require.resolve('electron-builder/cli.js'),
    '--win',
    'nsis',
    `-c.extraMetadata.version=${version}`,
    `-c.directories.output=dist/preview`,
  ],
  { cwd: ROOT, stdio: 'inherit', env: process.env }
);

if (result.status !== 0) process.exit(result.status ?? 1);

console.log(`\n[dist-preview] built: dist/preview/${PRODUCT_NAME} Setup ${version}.exe`);
