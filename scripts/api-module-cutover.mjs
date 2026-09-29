#!/usr/bin/env node
/**
 * The app-api side of moving a module to its own worker
 * (docs/plans/app-api-module-split.md, step 5 of .claude/skills/extract-api-module):
 *
 *   node scripts/api-module-cutover.mjs <module>
 *
 * - wrangler.toml: adds the <MODULE>_API service binding in dev, test and
 *   production (next to the last module binding) and appends the module to
 *   API_FORWARD_MODULES in all three [vars].
 * - src/types.ts: adds `<MODULE>_API?: Fetcher` to Env.
 *
 * Idempotent. Unmounting the module's routes in src/index.ts stays manual.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { getApiModule } = await import(
  pathToFileURL(path.join(repo, 'packages/core/api-modules/src/index.ts')).href
);

const id = process.argv[2];
if (!id || id === 'core') {
  console.error('Usage: node scripts/api-module-cutover.mjs <module>');
  process.exit(1);
}
const mod = getApiModule(id);
const script = `weldsuite-${mod.worker}`;

function edit(rel, fn) {
  const p = path.join(repo, rel);
  const raw = readFileSync(p, 'utf8');
  const crlf = raw.includes('\r\n');
  const next = fn(raw.replace(/\r\n/g, '\n'));
  writeFileSync(p, crlf ? next.replace(/\n/g, '\r\n') : next);
}

edit('apps/workers/app-api/wrangler.toml', (s) => {
  // 1. API_FORWARD_MODULES in every [vars] block.
  s = s.replace(/^API_FORWARD_MODULES = "([^"]*)"$/gm, (line, list) => {
    const ids = list.split(',').map((x) => x.trim()).filter(Boolean);
    if (!ids.includes(mod.id)) ids.push(mod.id);
    return `API_FORWARD_MODULES = "${ids.join(',')}"`;
  });

  // 2. Service bindings, after the PASS_API binding of each environment.
  if (s.includes(`binding = "${mod.binding}"`)) return s;
  const envs = [
    { table: '[[services]]', anchor: 'binding = "PASS_API"\nservice = "weldsuite-pass-api"\n', service: script },
    { table: '[[env.test.services]]', anchor: 'binding = "PASS_API"\nservice = "weldsuite-pass-api-test"\n', service: `${script}-test` },
    { table: '[[env.production.services]]', anchor: 'binding = "PASS_API"\nservice = "weldsuite-pass-api"\n', service: script },
  ];
  for (const env of envs) {
    const header = `${env.table}\n${env.anchor}`;
    const at = s.indexOf(header);
    if (at < 0) throw new Error(`PASS_API binding missing for ${env.table}`);
    const end = at + header.length;
    const block = `\n${env.table}\nbinding = "${mod.binding}"\nservice = "${env.service}"\n`;
    s = s.slice(0, end) + block + s.slice(end);
  }
  return s;
});

edit('apps/workers/app-api/src/types.ts', (s) => {
  if (s.includes(`  ${mod.binding}?: Fetcher;`)) return s;
  const anchor = '  PASS_API?: Fetcher;\n';
  if (!s.includes(anchor)) throw new Error('PASS_API missing from app-api Env');
  const doc = `  /** ${mod.worker}. Target of the forwarder for the ${mod.id} module's paths. */\n`;
  return s.replace(anchor, `${anchor}${doc}  ${mod.binding}?: Fetcher;\n`);
});

console.log(`app-api now forwards "${mod.id}" to ${script} over ${mod.binding}.`);
console.log(`Remaining by hand: unmount the ${mod.id} routes/crons in apps/workers/app-api/src/index.ts.`);
