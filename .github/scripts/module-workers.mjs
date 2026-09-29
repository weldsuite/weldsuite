#!/usr/bin/env node
/**
 * Picks the per-module API workers (apps/workers/<module>-api, see
 * docs/plans/app-api-module-split.md) to deploy.
 *
 * The module list comes from @weldsuite/api-modules, so a new module worker
 * deploys without editing deploy.yml. A module worker is selected when:
 *   - FORCE_ALL is "true" (manual dispatch, lockfile / workspace / db change), or
 *   - the push changed its folder or any workspace package it depends on
 *     (transitively, e.g. @weldsuite/worker-kit), or the api-modules manifest, or
 *   - BEFORE is missing / unreachable (first push, force push): deploy all, to be safe.
 *
 * Env: FORCE_ALL, BEFORE (push `before` SHA), SHA. Writes
 * `module_workers=<JSON array>` to GITHUB_OUTPUT; deploy.yml deploys them in
 * their own job BEFORE the other workers, because app-api's forwarder binds
 * to them.
 * With `--list` it only prints the module workers that exist (ci.yml loops).
 * Needs Node 22.18+ (imports the TypeScript manifest with native type stripping).
 */

import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const { MODULE_WORKERS } = await import(
  pathToFileURL(path.join(repoRoot, 'packages/core/api-modules/src/index.ts')).href
);

// Workspace package name → folder (apps/*/* and packages/*/*), so a worker's
// transitive workspace dependencies can be watched too: a change in, say,
// @weldsuite/crm-domain redeploys every worker that depends on it.
const workspaceDirs = new Map();
for (const group of ['apps', 'packages']) {
  const groupDir = path.join(repoRoot, group);
  for (const category of readdirSync(groupDir, { withFileTypes: true })) {
    if (!category.isDirectory()) continue;
    for (const pkg of readdirSync(path.join(groupDir, category.name), { withFileTypes: true })) {
      const manifest = path.join(groupDir, category.name, pkg.name, 'package.json');
      if (!pkg.isDirectory() || !existsSync(manifest)) continue;
      const { name } = JSON.parse(readFileSync(manifest, 'utf8'));
      if (name) workspaceDirs.set(name, `${group}/${category.name}/${pkg.name}/`);
    }
  }
}

/** Folders a worker's deploy depends on: its own + every transitive workspace dependency. */
function watchedPaths(worker) {
  const out = new Set([`apps/workers/${worker}/`]);
  const queue = [path.join(repoRoot, 'apps/workers', worker, 'package.json')];
  const seen = new Set();
  while (queue.length) {
    const manifest = queue.pop();
    if (seen.has(manifest) || !existsSync(manifest)) continue;
    seen.add(manifest);
    const { dependencies = {} } = JSON.parse(readFileSync(manifest, 'utf8'));
    for (const [dep, range] of Object.entries(dependencies)) {
      const dir = workspaceDirs.get(dep);
      if (!dir || !String(range).startsWith('workspace:')) continue;
      out.add(dir);
      queue.push(path.join(repoRoot, dir, 'package.json'));
    }
  }
  return [...out];
}

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
    // The manifest decides routing for every worker, so it redeploys them all.
    const manifestChanged = files.some((f) => f.startsWith('packages/core/api-modules/'));
    selected = existing.filter((w) => {
      if (manifestChanged) return true;
      const watched = watchedPaths(w);
      return files.some((f) => watched.some((p) => f.startsWith(p)));
    });
  }
}

console.log(`Module workers present: ${existing.length ? existing.join(', ') : '(none yet)'}`);
console.log(`Module workers selected: ${selected.length ? selected.join(', ') : '(none)'}`);

if (process.env.GITHUB_OUTPUT) {
  appendFileSync(process.env.GITHUB_OUTPUT, `module_workers=${JSON.stringify(selected)}\n`);
}
