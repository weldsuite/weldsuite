#!/usr/bin/env node
/**
 * Packages type-checked by the "Type Check · app-api" CI job:
 * app-api, the module API workers, api-modules, worker-* and every domain.
 *
 * `--shard N --shards M` prints one round-robin slice (1-based), one
 * directory per line. A new module worker or domain is picked up from
 * disk, same as the full list.
 * Needs Node 22.18+ (imports the TypeScript manifest with native type stripping).
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const { MODULE_WORKERS } = await import(
  pathToFileURL(path.join(repoRoot, 'packages/core/api-modules/src/index.ts')).href
);

function hasTypecheck(dir) {
  const manifest = path.join(repoRoot, dir, 'package.json');
  if (!existsSync(manifest)) return false;
  const { scripts } = JSON.parse(readFileSync(manifest, 'utf8'));
  return Boolean(scripts?.['type-check']);
}

const targets = new Set();
function add(dir) {
  if (hasTypecheck(dir)) targets.add(dir);
}

add('apps/workers/app-api');
for (const worker of MODULE_WORKERS) add(`apps/workers/${worker.worker}`);

for (const parent of ['packages/core', 'packages/domains']) {
  const abs = path.join(repoRoot, parent);
  if (!existsSync(abs)) continue;
  for (const entry of readdirSync(abs, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = `${parent}/${entry.name}`;
    if (parent === 'packages/core' && entry.name !== 'api-modules' && !entry.name.startsWith('worker-')) {
      continue;
    }
    add(dir);
  }
}

const sorted = [...targets].sort();

function slice() {
  const shardFlag = process.argv.indexOf('--shard');
  const shardsFlag = process.argv.indexOf('--shards');
  if (shardFlag === -1 && shardsFlag === -1) return sorted;
  if (shardFlag === -1 || shardsFlag === -1) {
    console.error('--shard and --shards must be passed together');
    process.exit(1);
  }
  const shard = Number(process.argv[shardFlag + 1]);
  const shards = Number(process.argv[shardsFlag + 1]);
  if (
    !Number.isInteger(shard) ||
    !Number.isInteger(shards) ||
    shards < 1 ||
    shard < 1 ||
    shard > shards
  ) {
    console.error(`Invalid shard ${process.argv[shardFlag + 1]} of ${process.argv[shardsFlag + 1]}`);
    process.exit(1);
  }
  return sorted.filter((_, index) => index % shards === shard - 1);
}

process.stdout.write(`${slice().join('\n')}\n`);
