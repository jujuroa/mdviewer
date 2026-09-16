// Copies the mermaid browser bundle out of node_modules into
// thirdparty/mermaid/, next to the PlantUML runtime: outside the asar,
// outside git, and packaged into the installer via build.extraResources.
//
// mermaid is a devDependency on purpose. Only this one built file is needed
// at runtime (main.js injects it into the hidden render window — see
// assets/mermaid-render.js), whereas making it a runtime dependency would
// pack the whole package and its dependency tree (mermaid + d3 + cytoscape,
// tens of MB) into the installer for nothing.
//
// Runs automatically before `npm start` / `npm run pack` / `npm run dist`
// (see package.json pre* hooks).

const fs = require('fs');
const path = require('path');

const PACKAGE_DIR = path.join(__dirname, '..', 'node_modules', 'mermaid');
const SOURCE = path.join(PACKAGE_DIR, 'dist', 'mermaid.min.js');
const OUT_DIR = path.join(__dirname, '..', 'thirdparty', 'mermaid');
const OUT = path.join(OUT_DIR, 'mermaid.min.js');
const VERSION_STAMP = path.join(OUT_DIR, 'version.txt');

function installedVersion() {
  return JSON.parse(fs.readFileSync(path.join(PACKAGE_DIR, 'package.json'), 'utf-8')).version;
}

function main() {
  if (!fs.existsSync(SOURCE)) {
    console.error(
      '[prepare-mermaid] node_modules/mermaid/dist/mermaid.min.js not found. Run "npm install" first.'
    );
    process.exit(1);
  }

  const version = installedVersion();
  const prepared =
    fs.existsSync(OUT) &&
    fs.existsSync(VERSION_STAMP) &&
    fs.readFileSync(VERSION_STAMP, 'utf-8').trim() === version;
  if (prepared) {
    console.log(`[prepare-mermaid] mermaid ${version} already prepared, skipping.`);
    return;
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.copyFileSync(SOURCE, OUT);
  fs.writeFileSync(VERSION_STAMP, `${version}\n`, 'utf-8');
  console.log(`[prepare-mermaid] mermaid ${version} -> thirdparty/mermaid/mermaid.min.js`);
}

main();
