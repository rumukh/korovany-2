import { readFileSync, writeFileSync } from 'node:fs';

const path = new URL('../package-lock.json', import.meta.url);
const lock = JSON.parse(readFileSync(path, 'utf8'));
let changed = 0;
for (const entry of Object.values(lock.packages)) {
  if (!entry.resolved || entry.link || !entry.resolved.startsWith('https:')) continue;
  if (entry.resolved.startsWith('https://registry.npmjs.org/')) continue;
  const match = /^https:\/\/[^/]+\.pkgs\.visualstudio\.com\/[^/]+\/_packaging\/[^/]+\/npm\/registry\/(.+)$/.exec(entry.resolved);
  if (!match) throw new Error(`Unrecognized registry URL: ${entry.resolved}`);
  entry.resolved = `https://registry.npmjs.org/${match[1]}`;
  changed++;
}
if (changed && !process.argv.includes('--write')) {
  throw new Error(`${changed} game lock URLs require canonicalization; run npm run lock:canonicalize`);
}
if (changed) writeFileSync(path, `${JSON.stringify(lock, null, 2)}\n`);
console.log(`Canonical game lock: ${changed} URL(s) updated`);
