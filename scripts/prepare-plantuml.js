// Prepares a self-contained local PlantUML runtime under thirdparty/plantuml/:
//   plantuml.jar   - the PlantUML tool itself (downloaded once, sha256-pinned)
//   jre/           - a minimal jlink'd JRE containing only the modules plantuml.jar needs
//
// This lets main.js render diagrams by shelling out to a bundled java, instead of
// depending on the public plantuml.com server (which rejects large/complex diagrams
// with HTTP 400 once the encoded source exceeds its request-size limit).
//
// Runs automatically before `npm start` / `npm run dist` (see package.json pre* hooks).
// Building requires a JDK (for jlink) on PATH; the resulting app does NOT — the jlink'd
// JRE is bundled into the installer via build.extraResources.

const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const PLANTUML_VERSION = '1.2026.6';
const PLANTUML_URL = `https://github.com/plantuml/plantuml/releases/download/v${PLANTUML_VERSION}/plantuml.jar`;
const PLANTUML_SHA256 = '89948f14c93756c7a3fb7b69078ff37e8489fd79dd430c582b931e2f65358690';

// jlink dependency set for plantuml.jar, as reported by:
//   jdeps --multi-release 21 --ignore-missing-deps --print-module-deps --recursive plantuml.jar
// plus jdk.charsets (non-UTF charset support) and jdk.zipfs (safety margin for jar/zip access).
const JLINK_MODULES = [
  'java.base', 'java.desktop', 'java.logging', 'java.prefs',
  'java.scripting', 'jdk.unsupported', 'jdk.charsets', 'jdk.zipfs',
].join(',');

const OUT_DIR = path.join(__dirname, '..', 'thirdparty', 'plantuml');
const JAR_PATH = path.join(OUT_DIR, 'plantuml.jar');
const JRE_DIR = path.join(OUT_DIR, 'jre');
const JAVA_BIN = path.join(JRE_DIR, 'bin', process.platform === 'win32' ? 'java.exe' : 'java');

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function download(url, destPath) {
  return new Promise((resolve, reject) => {
    const request = (currentUrl) => {
      https.get(currentUrl, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          request(res.headers.location);
          return;
        }
        if (res.statusCode !== 200) {
          reject(new Error(`Download failed: HTTP ${res.statusCode} for ${currentUrl}`));
          res.resume();
          return;
        }
        const file = fs.createWriteStream(destPath);
        res.pipe(file);
        file.on('finish', () => file.close(resolve));
        file.on('error', reject);
      }).on('error', reject);
    };
    request(url);
  });
}

async function ensureJar() {
  if (fs.existsSync(JAR_PATH) && sha256File(JAR_PATH) === PLANTUML_SHA256) {
    console.log('[prepare-plantuml] plantuml.jar already present and verified, skipping download.');
    return;
  }
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const tmpPath = `${JAR_PATH}.download`;
  console.log(`[prepare-plantuml] Downloading plantuml.jar v${PLANTUML_VERSION}...`);
  await download(PLANTUML_URL, tmpPath);
  const actualSha256 = sha256File(tmpPath);
  if (actualSha256 !== PLANTUML_SHA256) {
    fs.unlinkSync(tmpPath);
    throw new Error(
      `plantuml.jar checksum mismatch (expected ${PLANTUML_SHA256}, got ${actualSha256}). Aborting.`
    );
  }
  fs.renameSync(tmpPath, JAR_PATH);
  console.log('[prepare-plantuml] plantuml.jar downloaded and verified.');
}

function ensureJre() {
  if (fs.existsSync(JAVA_BIN)) {
    console.log('[prepare-plantuml] Local JRE already present, skipping jlink.');
    return;
  }
  fs.rmSync(JRE_DIR, { recursive: true, force: true });
  console.log('[prepare-plantuml] Building minimal JRE via jlink...');
  try {
    execFileSync('jlink', [
      '--add-modules', JLINK_MODULES,
      '--strip-debug',
      '--no-header-files',
      '--no-man-pages',
      '--compress=zip-9',
      '--output', JRE_DIR,
    ], { stdio: 'inherit' });
  } catch (err) {
    throw new Error(
      'jlink failed. A JDK (17+) must be installed and on PATH to build the bundled PlantUML runtime.\n' +
      `Original error: ${err.message}`
    );
  }
  console.log('[prepare-plantuml] Minimal JRE built at', JRE_DIR);
}

async function main() {
  await ensureJar();
  ensureJre();
  console.log('[prepare-plantuml] Ready.');
}

main().catch((err) => {
  console.error('[prepare-plantuml] FAILED:', err.message);
  process.exit(1);
});
