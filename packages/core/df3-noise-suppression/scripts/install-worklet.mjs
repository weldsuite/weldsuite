#!/usr/bin/env node
/**
 * Copies the DF3 AudioWorkletProcessor JS into the consumer app's public
 * folder so it can be served at a same-origin URL — `addModule()` rejects
 * cross-origin URLs.
 *
 * Usage (e.g. from an app's `postinstall` script):
 *   node node_modules/@weldsuite/df3-noise-suppression/scripts/install-worklet.mjs public/df3-worklet-processor.js
 */
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const source = resolve(here, '..', 'src', 'df3-worklet-processor.js');

const target = process.argv[2];
if (!target) {
  console.error('Usage: install-worklet.mjs <target-path>');
  process.exit(2);
}
const targetAbs = resolve(process.cwd(), target);
mkdirSync(dirname(targetAbs), { recursive: true });
if (!existsSync(source)) {
  console.error(`[df3] worklet source missing at ${source}`);
  process.exit(1);
}
copyFileSync(source, targetAbs);
console.log(`[df3] worklet → ${targetAbs}`);
