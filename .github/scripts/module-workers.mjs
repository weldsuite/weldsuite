#!/usr/bin/env node
/**
 * Adds the per-module API workers (apps/workers/<module>-api, see
 * docs/plans/app-api-module-split.md) to the deploy matrix.
 *
 * The module list comes from @weldsuite/api-modules, so a new module worker
 * deploys without editing deploy.yml. A module worker is selected when:
 *   - FORCE_ALL is "true" (manual dispatch, lockfile / workspace / db change), or
 *   - the push changed its folder, @weldsuite/worker-kit or @weldsuite/api-modules, or
 *   - BEFORE is missing / unreachable (first push, force push): deploy all, to be safe.
 *
 * Env: FORCE_ALL, BEFORE (push `before` SHA), SHA, WORKERS (JSON array from the
 * hand-maintained matrix step). Writes `workers=<merged JSON>` to GITHUB_OUTPUT.
 * With `--list` it only prints the module workers that exist (ci.yml loops).
 * Needs Node 22.18+ (imports the TypeScript manifest with native type stripping).
 */

import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const { MODULE_WORKERS } = await import(
  pathToFileURL(path.join(repoRoot, 'packages/core/api-modules/src/index.ts')).href
);

const SHARED_PATHS = ['packages/core/worker-kit/', 'packages/core/api-modules/'];

const existing = MODULE_WORKERS.map((m) => m.worker).filter((w) =>
  existsSync(path.join(repoRoot, 'apps/workers', w, 'wrangler.toml')),
);

// `--list`: print the module workers that exist (for CI loops) and stop.
if (process.argv.includes('--list')) {
  console.log(existing.join(' '));
  process.exit(0);
}

function changedFiles() {
  const before = process.env.BEFORE ?? '';
  const sha = process.env.SHA || 'HEAD';
  if (!before || /^0+$/.test(before)) return null;
  try {
    return execFileSync('git', ['diff', '--name-only', `${before}...${sha}`], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .split('\n')
      .filter(Boolean);
  } catch {
    return null;
  }
}

let selected;
if (process.env.FORCE_ALL === 'true') {
  selected = existing;
} else {
  const files = changedFiles();
  if (files === null) {
    console.log('No usable base commit; deploying every module worker.');
    selected = existing;
  } else {
    const shared = files.some((f) => SHARED_PATHS.some((p) => f.startsWith(p)));
    selected = existing.filter(
      (w) => shared || files.some((f) => f.startsWith(`apps/workers/${w}/`)),
    );
  }
}

const base = JSON.parse(process.env.WORKERS || '[]');
const merged = [...new Set([...base, ...selected])];

console.log(`Module workers present: ${existing.length ? existing.join(', ') : '(none yet)'}`);
console.log(`Module workers selected: ${selected.length ? selected.join(', ') : '(none)'}`);
console.log(`Deploying workers: ${JSON.stringify(merged)}`);

if (process.env.GITHUB_OUTPUT) {
  appendFileSync(process.env.GITHUB_OUTPUT, `workers=${JSON.stringify(merged)}\n`);
}
