/**
 * Basis Universal helpers for ktx2_glb.py (Node.js only, no packages).
 *
 * node ktx2_tool.mjs encode <basisu_st.wasm> <work dir> <basisu arguments...>
 *   Runs the single-threaded WASI build of the Basis Universal command-line encoder through Node's WASI, with <work dir>
 *   mounted at /work (arguments name files as /work/<name>). WebAssembly runs the same on every host and the build has no
 *   threads, so the output bytes do not depend on the machine.
 *
 * node ktx2_tool.mjs levels <transcoder dir> <file.ktx2> <out dir>
 *   Opens the file with the game's own transcoder (three.js's basis_transcoder.js and .wasm from <transcoder dir>) and
 *   transcodes every mip level to every GPU format three.js's KTX2Loader may pick for it (ASTC 4x4, BC7, BC1/BC3,
 *   ETC1/ETC2, PVRTC1) and to RGBA8; any failure stops. Writes the RGBA8 levels as <out dir>/level-<n>.rgba and a
 *   summary as <out dir>/levels.json.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { WASI } from 'node:wasi';

const [command, ...rest] = process.argv.slice(2);

/** Transcoder formats by the alpha flag: KTX2Loader's choices for UASTC (its TranscoderFormat values), then RGBA8. */
const TARGETS = {
  'ASTC 4x4': [10, 10], 'BC7': [7, 7], 'BC1/BC3': [2, 3], 'ETC1/ETC2': [0, 1], 'PVRTC1': [8, 9], 'RGBA8': [13, 13],
};

async function encode(wasmPath, dir, args) {
  const wasi = new WASI({ version: 'preview1', args: ['basisu', ...args], env: {}, preopens: { '/work': dir }, returnOnExit: true });
  const module = await WebAssembly.compile(readFileSync(wasmPath));
  const instance = await WebAssembly.instantiate(module, wasi.getImportObject());
  const code = wasi.start(instance);
  if (code !== 0) throw new Error(`basisu exited with ${code}`);
}

async function levels(transcoderDir, file, outDir) {
  const script = join(transcoderDir, 'basis_transcoder.js');
  const factory = new Function('require', 'module', 'exports', '__filename', '__dirname', `${readFileSync(script, 'utf8')}\nreturn BASIS;`);
  const BASIS = factory(createRequire(import.meta.url), undefined, undefined, script, transcoderDir);
  const basis = await BASIS({ wasmBinary: readFileSync(join(transcoderDir, 'basis_transcoder.wasm')) });
  basis.initializeBasis();
  const ktx2 = new basis.KTX2File(new Uint8Array(readFileSync(file)));
  try {
    if (!ktx2.isValid()) throw new Error(`${file}: not a valid KTX2 file for this transcoder`);
    if (!ktx2.isUASTC()) throw new Error(`${file}: expected UASTC 4x4`);
    const alpha = ktx2.getHasAlpha() ? 1 : 0;
    const summary = {
      width: ktx2.getWidth(), height: ktx2.getHeight(), levels: ktx2.getLevels(), layers: ktx2.getLayers(), faces: ktx2.getFaces(),
      hasAlpha: Boolean(alpha), transferFunction: ktx2.getDFDTransferFunc(), targets: Object.keys(TARGETS), rgba: [],
    };
    if (summary.faces !== 1 || summary.layers > 1) throw new Error(`${file}: expected one 2D image`);
    if (!ktx2.startTranscoding()) throw new Error(`${file}: startTranscoding failed`);
    mkdirSync(outDir, { recursive: true });
    for (let level = 0; level < summary.levels; level++) {
      const info = ktx2.getImageLevelInfo(level, 0, 0);
      for (const [name, formats] of Object.entries(TARGETS)) {
        const format = formats[alpha];
        const out = new Uint8Array(ktx2.getImageTranscodedSizeInBytes(level, 0, 0, format));
        if (!ktx2.transcodeImage(out, level, 0, 0, format, 0, -1, -1)) throw new Error(`${file}: level ${level} did not transcode to ${name}`);
        if (format === 13) {
          if (out.length !== info.origWidth * info.origHeight * 4) throw new Error(`${file}: level ${level} RGBA8 size`);
          writeFileSync(join(outDir, `level-${level}.rgba`), out);
          summary.rgba.push({ level, width: info.origWidth, height: info.origHeight, sha256: createHash('sha256').update(out).digest('hex') });
        }
      }
    }
    writeFileSync(join(outDir, 'levels.json'), `${JSON.stringify(summary, null, 2)}\n`);
  } finally {
    ktx2.close();
    ktx2.delete();
  }
}

if (command === 'encode') await encode(rest[0], rest[1], rest.slice(2));
else if (command === 'levels') await levels(rest[0], rest[1], rest[2]);
else throw new Error('usage: ktx2_tool.mjs encode <wasm> <dir> <args...> | levels <transcoder dir> <file.ktx2> <out dir>');
