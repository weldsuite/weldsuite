// Builds the two scripts the collector serves:
//   dist/panel.global.js           /s.js    the core
//   dist/panel-recorder.global.js  /rec.js  the recording plugin, loaded only for recorded sessions
// Workspace consumers import src/ directly; only the script tags need bundles.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { build } from 'esbuild';

/** The plan's budget for the core script (docs/plans/weldpanel.md, "SDK"). */
const CORE_MAX_GZIP_BYTES = 10 * 1024;
/** The recorder is rrweb's record() plus chunking: about 25 KB; fail well before it gets heavy. */
const RECORDER_MAX_GZIP_BYTES = 80 * 1024;

const root = fileURLToPath(new URL('.', import.meta.url));
const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
const kb = (n) => `${(n / 1024).toFixed(2)} KB`;

const bundles = [
  { entry: 'src/global.ts', outfile: 'dist/panel.global.js', max: CORE_MAX_GZIP_BYTES, banner: '' },
  {
    entry: 'src/recorder-global.ts',
    outfile: 'dist/panel-recorder.global.js',
    max: RECORDER_MAX_GZIP_BYTES,
    banner: ' | includes rrweb (MIT, https://github.com/rrweb-io/rrweb)',
  },
];

let failed = false;
for (const bundle of bundles) {
  await build({
    absWorkingDir: root,
    entryPoints: [bundle.entry],
    outfile: bundle.outfile,
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'es2018',
    minify: true,
    legalComments: 'none',
    banner: { js: `/*! @weldsuite/panel-sdk ${version} | MIT${bundle.banner} */` },
    logLevel: 'warning',
  });

  const code = readFileSync(new URL(bundle.outfile, new URL('.', import.meta.url)));
  const gzipped = gzipSync(code, { level: 9 }).length;
  console.log(`${bundle.outfile}  ${kb(code.length)} minified, ${kb(gzipped)} gzipped`);
  if (gzipped > bundle.max) {
    console.error(`${bundle.outfile} is over the ${kb(bundle.max)} gzipped budget`);
    failed = true;
  }
}
if (failed) process.exit(1);
