// npm run test:app [name ...]: runs each check in this folder (or the ones
// named) one after another, each against a throwaway instance of the app.
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import path from 'node:path';

const dir = import.meta.dirname;
const wanted = process.argv.slice(2);
const files = readdirSync(dir)
  .filter((f) => f.endsWith('.check.mjs'))
  .filter((f) => !wanted.length || wanted.some((w) => f.startsWith(w)))
  .sort();

const summary = [];
for (const file of files) {
  console.log(`\n=== ${file}`);
  const r = spawnSync(process.execPath, [path.join(dir, file)], { stdio: 'inherit', timeout: 10 * 60 * 1000 });
  summary.push(`${r.status === 0 ? 'ok  ' : 'FAIL'}  ${file}`);
}
console.log(`\n${summary.join('\n')}`);
process.exitCode = summary.some((l) => l.startsWith('FAIL')) ? 1 : 0;
