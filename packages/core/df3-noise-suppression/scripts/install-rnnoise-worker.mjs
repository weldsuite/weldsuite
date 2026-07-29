#!/usr/bin/env node
/**
 * Bundles the RNNoise Web Worker into a single self-contained ESM file and
 * copies it to the consumer app's public folder. Mirror of install-worker.mjs
 * for the DF3 worker.
 *
 * The RNNoise wasm is inlined (base64) by the `createRNNWasmModuleSync` build,
 * so — unlike the DF3 worker — there is NO separate .wasm to serve.
 *
 * Usage (e.g. from an app's `postinstall` script):
 *   node node_modules/@weldsuite/df3-noise-suppression/scripts/install-rnnoise-worker.mjs public/rnnoise-worker.js
 */
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const entryPoint = resolve(here, '..', 'src', 'rnnoise-worker.ts');

const target = process.argv[2];
if (!target) {
  console.error('Usage: install-rnnoise-worker.mjs <target-path>');
  process.exit(2);
}
const outfile = resolve(process.cwd(), target);
mkdirSync(dirname(outfile), { recursive: true });

// Resolve esbuild from the package's own node_modules or the workspace root.
const require = createRequire(import.meta.url);
let esbuild;
try {
  esbuild = require('esbuild');
} catch {
  try {
    esbuild = require(resolve(here, '..', '..', '..', 'node_modules', 'esbuild'));
  } catch {
    console.error('[rnnoise] esbuild not found. Run: pnpm add -D esbuild in df3-noise-suppression');
    process.exit(1);
  }
}

await esbuild.build({
  entryPoints: [entryPoint],
  bundle: true,
  format: 'esm',
  platform: 'browser',
  // The Emscripten glue references node-only globals behind ENVIRONMENT_IS_NODE
  // guards; keep them defined-away so the browser bundle stays clean.
  define: { 'process.env.NODE_ENV': '"production"' },
  outfile,
  logLevel: 'info',
});

console.log(`[rnnoise] worker bundle → ${outfile}`);
