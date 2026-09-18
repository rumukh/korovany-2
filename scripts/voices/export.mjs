import { build } from 'esbuild';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const output = process.argv[2];
if (!output) throw new Error('Usage: node scripts\\voices\\export.mjs <output-directory>');
const out = resolve(output);
await mkdir(out, { recursive: true });
const bundled = join(out, '.voice-export.mjs');
try {
  await build({ entryPoints: [join(dirname(fileURLToPath(import.meta.url)), 'catalogue.ts')],
    outfile: bundled, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' });
  const { createVoiceCatalogue, inventorySummary, hashText } = await import(pathToFileURL(bundled).href);
  const entries = createVoiceCatalogue();
  const inventory = { version: 1, sourceHash: hashText(JSON.stringify(entries)), summary: inventorySummary(entries), entries };
  await writeFile(join(out, 'inventory.json'), JSON.stringify(inventory, null, 2) + '\n', 'utf8');
  console.log(JSON.stringify({ sourceHash: inventory.sourceHash, ...inventory.summary }, null, 2));
} finally {
  await rm(bundled, { force: true });
}
