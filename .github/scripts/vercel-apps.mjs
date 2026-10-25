#!/usr/bin/env node
/**
 * Picks the Vercel-hosted web apps to deploy.
 *
 * deploy.yml builds these with the Vercel CLI and uploads the prebuilt output;
 * Vercel's own Git integration is switched off for `develop` and `main`
 * (`git.deploymentEnabled` in each app's vercel.json) so GitHub Actions is the
 * only releaser. An app is selected when:
 *   - FORCE_ALL is "true" (manual dispatch), or
 *   - the push changed a root workspace file (lockfile, pnpm-workspace, …), or
 *   - the push changed its folder or any workspace package it depends on
 *     (transitively, e.g. @weldsuite/ui or @weldsuite/db), or
 *   - BEFORE is missing / unreachable (first push, force push): deploy all, to be safe.
 *
 * Env: FORCE_ALL, BEFORE (diff base SHA), SHA. Writes
 * `vercel_apps=<JSON array of { app, project }>` to GITHUB_OUTPUT.
 */

import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

// apps/web/<app> → Vercel project (team weldsuite). Env vars, domains and the
// project's Root Directory stay configured on the Vercel project itself.
const VERCEL_APPS = {
  admin: 'weldsuite-admin',
  'api-docs': 'weldsuite-api-docs',
  'booking-portal': 'booking-portal',
  docs: 'weldsuite-docs',
  'helpdesk-widget': 'weldsuite-helpdesk-widget',
  'hr-portal': 'weldsuite-hr-portal',
  'meeting-portal': 'meeting-portal',
  partner: 'weldsuite-partner',
  'sign-portal': 'weldsuite-sign-portal',
};

// Files outside any workspace package that change how every app installs or builds.
const ROOT_FILES = ['pnpm-lock.yaml', 'pnpm-workspace.yaml', 'package.json', 'turbo.json', '.npmrc'];

// Workspace package name → folder (apps/*/* and packages/*/*).
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

/**
 * Folders an app's build depends on: its own + every transitive workspace
 * dependency. devDependencies count too: the whole app is bundled at build time.
 */
function watchedPaths(app) {
  const out = new Set([`apps/web/${app}/`]);
  const queue = [path.join(repoRoot, 'apps/web', app, 'package.json')];
  const seen = new Set();
  while (queue.length) {
    const manifest = queue.pop();
    if (seen.has(manifest) || !existsSync(manifest)) continue;
    seen.add(manifest);
    const { dependencies = {}, devDependencies = {} } = JSON.parse(readFileSync(manifest, 'utf8'));
    for (const [dep, range] of Object.entries({ ...dependencies, ...devDependencies })) {
      const dir = workspaceDirs.get(dep);
      if (!dir || !String(range).startsWith('workspace:')) continue;
      out.add(dir);
      queue.push(path.join(repoRoot, dir, 'package.json'));
    }
  }
  return [...out];
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

const existing = Object.keys(VERCEL_APPS).filter((app) =>
  existsSync(path.join(repoRoot, 'apps/web', app, 'package.json')),
);

let selected;
if (process.env.FORCE_ALL === 'true') {
  selected = existing;
} else {
  const files = changedFiles();
  if (files === null) {
    console.log('No usable base commit; deploying every Vercel app.');
    selected = existing;
  } else if (files.some((f) => ROOT_FILES.includes(f))) {
    console.log('Root workspace file changed; deploying every Vercel app.');
    selected = existing;
  } else {
    selected = existing.filter((app) => {
      const watched = watchedPaths(app);
      return files.some((f) => watched.some((p) => f.startsWith(p)));
    });
  }
}

console.log(`Vercel apps selected: ${selected.length ? selected.join(', ') : '(none)'}`);

if (process.env.GITHUB_OUTPUT) {
  const matrix = selected.map((app) => ({ app, project: VERCEL_APPS[app] }));
  appendFileSync(process.env.GITHUB_OUTPUT, `vercel_apps=${JSON.stringify(matrix)}\n`);
}
