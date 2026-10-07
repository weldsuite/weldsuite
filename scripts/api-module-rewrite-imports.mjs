#!/usr/bin/env node
/**
 * Rewrite app-api-relative imports in a module worker after its files were
 * `git mv`-ed out of app-api (docs/plans/app-api-module-split.md, step 2 of
 * .claude/skills/extract-api-module).
 *
 *   node scripts/api-module-rewrite-imports.mjs <module>-api [--dry]
 *
 * Only imports that resolve OUTSIDE the worker's src/ are rewritten, and only the
 * ones with a known new home (the kit, worker-email, the worker's own types).
 * Anything else that still points outside src/ is printed so it can be handled
 * (moved into the worker, or into a package).
 */

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const worker = process.argv[2];
const dry = process.argv.includes('--dry');
if (!worker) {
  console.error('Usage: node scripts/api-module-rewrite-imports.mjs <module>-api [--dry]');
  process.exit(1);
}
const src = path.join(repo, 'apps/workers', worker, 'src');
if (!existsSync(src)) {
  console.error(`No such worker: ${src}`);
  process.exit(1);
}

// What the import pointed at inside app-api/src → where it lives now.
const APP_API_SRC = path.join(repo, 'apps/workers/app-api/src');
const MAP = new Map(
  Object.entries({
    'db/index': '@weldsuite/worker-kit/db',
    'lib/response': '@weldsuite/worker-kit/response',
    'lib/id': '@weldsuite/worker-kit/id',
    'lib/log-safe': '@weldsuite/worker-kit/log-safe',
    'lib/atomically': '@weldsuite/worker-kit/atomically',
    'lib/webhook-token': '@weldsuite/worker-kit/webhook-token',
    'lib/pg-errors': '@weldsuite/worker-kit/pg-errors',
    'lib/dns-lookup': '@weldsuite/worker-kit/dns-lookup',
    'lib/cors-origins': '@weldsuite/worker-kit/cors',
    'lib/cloudflare-email': '@weldsuite/worker-email',
    'middleware/clerk': '@weldsuite/worker-kit/middleware/clerk',
    'middleware/workspace-db': '@weldsuite/worker-kit/middleware/workspace-db',
    'middleware/feature-flags': '@weldsuite/worker-kit/middleware/feature-flags',
    'middleware/request-id': '@weldsuite/worker-kit/middleware/request-id',
    'test/harness': '@weldsuite/worker-kit/testing',
    'test/pglite': '@weldsuite/worker-kit/testing/pglite',
  }),
);

const files = readdirSync(src, { recursive: true, encoding: 'utf8' })
  .filter((f) => f.endsWith('.ts'))
  .map((f) => path.join(src, f));

const unresolved = [];
let changedFiles = 0;

for (const file of files) {
  const before = readFileSync(file, 'utf8');
  const after = before.replace(
    /((?:from|import|vi\.mock|vi\.importActual)\s*(?:\(\s*)?)(['"])(\.{1,2}\/[^'"]+)\2/g,
    (whole, lead, quote, spec) => {
      const abs = path.resolve(path.dirname(file), spec);
      const existsHere = [abs, `${abs}.ts`, path.join(abs, 'index.ts')].some((p) => existsSync(p));
      if (abs.startsWith(src + path.sep) && existsHere) return whole; // stays inside the worker
      // Where would this have resolved inside app-api/src before the move?
      const workerRel = path.relative(src, path.dirname(file));
      const appApiAbs = path.resolve(APP_API_SRC, workerRel, spec);
      const key = path.relative(APP_API_SRC, appApiAbs).split(path.sep).join('/').replace(/\/index$/, (m) => m);
      const normalized = key === 'db' ? 'db/index' : key;
      if (normalized === 'types') {
        const toTypes = path.relative(path.dirname(file), path.join(src, 'types')).split(path.sep).join('/');
        const typesPath = toTypes.startsWith('.') ? toTypes : `./${toTypes}`;
        return `${lead}${quote}${typesPath}${quote}`;
      }
      const target = MAP.get(normalized);
      if (target) return `${lead}${quote}${target}${quote}`;
      unresolved.push(`${path.relative(repo, file)}: ${spec}  (app-api/src/${normalized})`);
      return whole;
    },
  );
  if (after !== before) {
    changedFiles++;
    if (!dry) writeFileSync(file, after);
  }
}

console.log(`${dry ? 'would rewrite' : 'rewrote'} imports in ${changedFiles} file(s)`);
if (unresolved.length) {
  console.log('\nStill pointing outside the worker (move these, or put them in a package):');
  for (const u of unresolved) console.log(`  ${u}`);
  process.exitCode = 2;
}
