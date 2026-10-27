// Builds dist/panel.global.js, the script the collector serves as /s.js.
// Workspace consumers import src/ directly; only the snippet needs a bundle.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { build } from 'esbuild';

/** The plan's budget for the core script (docs/plans/weldpanel.md, "SDK"). */
const MAX_GZIP_BYTES = 10 * 1024;

const root = fileURLToPath(new URL('.', import.meta.url));
const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
const outfile = 'dist/panel.global.js';

await build({
  absWorkingDir: root,
  entryPoints: ['src/global.ts'],
  outfile,
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'es2018',
  minify: true,
  legalComments: 'none',
  banner: { js: `/*! @weldsuite/panel-sdk ${version} | MIT */` },
  logLevel: 'warning',
});

const code = readFileSync(new URL(outfile, new URL('.', import.meta.url)));
const gzipped = gzipSync(code, { level: 9 }).length;
const kb = (n) => `${(n / 1024).toFixed(2)} KB`;
console.log(`${outfile}  ${kb(code.length)} minified, ${kb(gzipped)} gzipped`);

if (gzipped > MAX_GZIP_BYTES) {
  console.error(`${outfile} is over the ${kb(MAX_GZIP_BYTES)} gzipped budget`);
  process.exit(1);
}
