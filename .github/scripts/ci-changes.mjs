#!/usr/bin/env node
/**
 * Decides which ci.yml jobs a pull request needs, from the files it changes.
 *
 * Every changed file is mapped to the workspace package it lives in. A package
 * is affected when it changed or depends, transitively and through any
 * dependency field, on a package that did. The areas, one per group of jobs:
 *
 *   api          an API package is affected (API_PACKAGES): Type Check · app-api,
 *                the Unit jobs of the workers and their packages
 *   platform     apps/web/platform is affected: Type Check, Unit and Build · platform
 *   desktop      apps/desktop is affected
 *   packages     any package but the platform is affected: Build · packages
 *   rust         rust/ or another input of the Rust jobs changed (RUST_PATHS,
 *                RUST_PACKAGES): Rust · checks, image and chart, deploy config.
 *                The image also bundles the platform SPA and the sign portal,
 *                but those are built by Build on their own PRs; the image
 *                catches a Docker-only break on develop.
 *   conformance  rust, api, or a file a conformance suite covers (CONFORMANCE_SUITES):
 *                Rust · conformance (the suites narrow it further)
 *   workers      a file under apps/workers/ changed: Rust · conformance coverage
 *
 * A change to locale files only reaches the packages that read them (see
 * I18N_DIR). Files every job reads (the lockfile, workspace and turbo config,
 * patches, the shared configs, ci.yml and its helpers) turn every area on, and
 * so does any other file outside a package unless it is known to be inert
 * (INERT). On a push, a manual run, or without a usable base, every area is on.
 *
 * Usage:
 *   node .github/scripts/ci-changes.mjs --base origin/develop [--head HEAD]
 *   node .github/scripts/ci-changes.mjs --all
 * Prints the areas and why; writes `<area>=true|false` to GITHUB_OUTPUT and a
 * table to GITHUB_STEP_SUMMARY when those are set. Plain Node, no install.
 */

import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const AREAS = ['api', 'platform', 'desktop', 'packages', 'rust', 'conformance', 'workers'];

/** Read by every job: a change here runs everything. */
const GLOBAL = [
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'turbo.json',
  'tsconfig.json',
  '.npmrc',
  '.eslintrc.js',
  'patches/',
  'packages/config/',
  '.github/workflows/ci.yml',
  '.github/actions/setup-monorepo/',
  '.github/scripts/ci-changes.mjs',
  '.github/scripts/typecheck-targets.mjs',
  '.github/scripts/module-workers.mjs',
];

/**
 * Outside every package and read by no job but Lint, which always runs.
 * A path ending in "/" is a folder.
 */
const INERT = [
  'docs/',
  '.claude/',
  '.agents/',
  '.cursor/',
  '.cursor-plugin/',
  '.design-sync/',
  '.vscode/',
  '.github/',
  'scripts/',
  '.gitignore',
  '.gitleaks.toml',
  'eslint.sonar.config.mjs',
  'skills-lock.json',
  'LICENSE',
];
/** Inert wherever they are, inside a package too. */
const INERT_NAMES = new Set(['README.md', 'CLAUDE.md', 'AGENTS.md', 'CHANGELOG.md']);

const isInert = (file) =>
  INERT_NAMES.has(path.posix.basename(file)) ||
  (!file.includes('/') && file.endsWith('.md')) ||
  startsWithAny(file, INERT);

/** What the api jobs type-check and test. Keep in step with ci.yml. */
const API_PACKAGES = [
  'apps/workers/*-api',
  'apps/workers/mcp-server',
  'apps/workers/workspace-worker',
  'apps/workers/audit-log-worker',
  'packages/core/api-modules',
  'packages/core/worker-*',
  'packages/core/neon-provisioning',
  'packages/domains/*',
];

/**
 * What the Rust jobs read besides rust/: the migrations, the realtime parity
 * test, and the collab-rooms image, which bundles the docs and sheets rooms
 * by relative path (so those folders are listed here, not found in the graph).
 */
const RUST_PATHS = [
  'rust/',
  'scripts/rust-',
  'packages/core/db/drizzle/',
  'apps/workers/docs-api/src/room/',
  'apps/workers/docs-api/src/engine-ops',
  'apps/workers/sheets-api/src/room/',
  'apps/workers/sheets-api/src/engine-ops',
];
const RUST_PACKAGES = ['packages/core/realtime', 'apps/tools/collab-rooms'];

/**
 * Each conformance suite names the paths it covers, and
 * `rust:conformance --changed` runs a suite when one of them or one of its
 * tests changed. Some suites cover workers outside API_PACKAGES
 * (integration-webhook-worker, panel-ingest), so match them the same way.
 */
const CONFORMANCE_SUITES = 'rust/conformance/suites.json';

function touchedSuites(files) {
  const { suites } = JSON.parse(readFileSync(path.join(repoRoot, CONFORMANCE_SUITES), 'utf8'));
  return suites.filter((suite) =>
    files.some(
      (f) =>
        suite.paths.some((p) => f.startsWith(p)) ||
        suite.tests.some((t) => f.startsWith(`${suite.workspace}/${t}`)),
    ),
  );
}

/**
 * Locale files are mostly imported one at a time
 * (`@weldsuite/i18n/locales/en/emails`), and nearly every UI change adds
 * strings to one. A change confined to locale files reaches only the packages
 * that import the package root, another entry, or that very locale file, not
 * every package that lists @weldsuite/i18n (@weldsuite/emails, and through it
 * most workers).
 */
const I18N_DIR = 'packages/core/i18n';
const LOCALE_FILE = /^packages\/core\/i18n\/src\/locales\/([^/]+\/[^/]+)\.ts$/;

/** Whether `dir` reads none of the changed locale files, judged by its import specifiers. */
function sparedByLocales(dir, locales) {
  let specifiers;
  try {
    // Quoted, so a path in a comment doesn't count.
    specifiers = git(['grep', '-h', '-o', '-E', `['"]@weldsuite/i18n[A-Za-z0-9_./-]*['"]`, '--', dir, ':!*package.json']);
  } catch (err) {
    if (err.status === 1) return true; // no match: the package never imports it
    throw err;
  }
  return specifiers
    .split('\n')
    .filter(Boolean)
    .every((s) => {
      const locale = /^.@weldsuite\/i18n\/locales\/([^/]+\/[^/]+).$/.exec(s);
      return locale !== null && !locales.has(locale[1]);
    });
}

/** `*` matches within one path segment. */
function globToRegExp(glob) {
  const body = glob
    .split('*')
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('[^/]*');
  return new RegExp(`^${body}$`);
}

const matchesAny = (dir, globs) => globs.some((glob) => globToRegExp(glob).test(dir));
const startsWithAny = (file, prefixes) =>
  prefixes.some((prefix) => (prefix.endsWith('/') || prefix.endsWith('-') ? file.startsWith(prefix) : file === prefix));

function git(args) {
  return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

/** The `packages:` globs of pnpm-workspace.yaml, `!` exclusions included. */
function workspaceGlobs() {
  const yaml = readFileSync(path.join(repoRoot, 'pnpm-workspace.yaml'), 'utf8');
  const globs = [];
  let inPackages = false;
  for (const line of yaml.split('\n')) {
    if (/^packages:\s*$/.test(line)) {
      inPackages = true;
      continue;
    }
    if (!inPackages) continue;
    const item = /^\s+-\s+["']?([^"'#]+?)["']?\s*(#.*)?$/.exec(line);
    if (item) globs.push(item[1]);
    else if (line.trim() && !line.trim().startsWith('#')) break;
  }
  return globs;
}

/** Workspace packages: folder → { name, deps }. */
function workspacePackages() {
  const globs = workspaceGlobs();
  const include = globs.filter((g) => !g.startsWith('!'));
  const exclude = globs.filter((g) => g.startsWith('!')).map((g) => g.slice(1));
  const manifests = git(['ls-files', '--', 'package.json', '*/package.json']).split('\n').filter(Boolean);
  const packages = new Map();
  for (const manifest of manifests) {
    const dir = path.posix.dirname(manifest);
    if (!matchesAny(dir, include) || matchesAny(dir, exclude)) continue;
    const json = JSON.parse(readFileSync(path.join(repoRoot, manifest), 'utf8'));
    const deps = new Set();
    for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
      for (const dep of Object.keys(json[field] ?? {})) deps.add(dep);
    }
    packages.set(dir, { name: json.name, deps });
  }
  return packages;
}

/** The deepest package folder holding `file`, or undefined. */
function packageOf(file, dirs) {
  let best;
  for (const dir of dirs) {
    if (file.startsWith(`${dir}/`) && (!best || dir.length > best.length)) best = dir;
  }
  return best;
}

/** Changed packages plus everything that depends on them, except along edges `spared` cuts. */
function affectedPackages(changed, packages, spared) {
  const dirByName = new Map([...packages].map(([dir, pkg]) => [pkg.name, dir]));
  const dependents = new Map();
  for (const [dir, pkg] of packages) {
    for (const dep of pkg.deps) {
      const depDir = dirByName.get(dep);
      if (!depDir) continue;
      if (!dependents.has(depDir)) dependents.set(depDir, new Set());
      dependents.get(depDir).add(dir);
    }
  }
  const affected = new Set(changed);
  const queue = [...changed];
  while (queue.length) {
    const from = queue.pop();
    for (const dir of dependents.get(from) ?? []) {
      if (affected.has(dir) || spared(from, dir)) continue;
      affected.add(dir);
      queue.push(dir);
    }
  }
  return affected;
}

function allAreas(reason) {
  return Object.fromEntries(AREAS.map((area) => [area, [reason]]));
}

/** area → the reasons it is on (an empty list means off). */
function decide(files) {
  const reasons = Object.fromEntries(AREAS.map((area) => [area, []]));
  const on = (area, why) => reasons[area].push(why);

  const global = files.filter((f) => startsWithAny(f, GLOBAL));
  if (global.length) return allAreas(`${global[0]} is read by every job`);

  const packages = workspacePackages();
  const dirs = [...packages.keys()];
  const changed = new Set();
  for (const file of files) {
    if (INERT_NAMES.has(path.posix.basename(file))) continue;
    const rust = startsWithAny(file, RUST_PATHS);
    if (rust) on('rust', file);
    else if (isInert(file)) continue;
    if (file.startsWith('apps/workers/')) on('workers', file);
    const dir = packageOf(file, dirs);
    if (dir) changed.add(dir);
    else if (!rust) return allAreas(`${file} is outside every package and not known to be inert`);
  }

  const i18nFiles = files.filter((f) => f.startsWith(`${I18N_DIR}/`) && !INERT_NAMES.has(path.posix.basename(f)));
  const locales = i18nFiles.length > 0 && i18nFiles.every((f) => LOCALE_FILE.test(f))
    ? new Set(i18nFiles.map((f) => LOCALE_FILE.exec(f)[1]))
    : null;
  const spared = (from, to) => from === I18N_DIR && locales !== null && sparedByLocales(to, locales);

  for (const dir of [...affectedPackages(changed, packages, spared)].sort()) {
    const why = changed.has(dir) ? `${dir} changed` : `${dir} depends on a changed package`;
    if (matchesAny(dir, API_PACKAGES)) on('api', why);
    if (dir === 'apps/web/platform') on('platform', why);
    else on('packages', why);
    if (dir === 'apps/desktop') on('desktop', why);
    if (matchesAny(dir, RUST_PACKAGES)) on('rust', why);
  }
  for (const why of [...reasons.rust, ...reasons.api]) on('conformance', why);
  for (const suite of touchedSuites(files)) on('conformance', `the "${suite.name}" conformance suite covers a changed file`);
  return reasons;
}

function changedFiles(base, head) {
  try {
    // --no-renames lists both sides of a move, and needs no file contents
    // (the CI checkout is blobless).
    return git(['diff', '--name-only', '--no-renames', `${base}...${head}`]).split('\n').filter(Boolean);
  } catch {
    return null;
  }
}

const flag = (name) => {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
};
const base = flag('--base');
const head = flag('--head') ?? 'HEAD';

let reasons;
if (process.argv.includes('--all') || !base) {
  reasons = allAreas('not a pull request');
} else {
  const files = changedFiles(base, head);
  reasons = files === null ? allAreas(`no usable base (${base})`) : decide(files);
  if (files !== null) console.log(`${files.length} files changed since ${base}.`);
}

for (const area of AREAS) {
  const list = reasons[area];
  const more = list.length > 1 ? ` (+${list.length - 1} more)` : '';
  console.log(`${area.padEnd(12)} ${list.length ? 'run ' : 'skip'}  ${list[0] ?? ''}${more}`);
}

if (process.env.GITHUB_OUTPUT) {
  appendFileSync(
    process.env.GITHUB_OUTPUT,
    AREAS.map((area) => `${area}=${reasons[area].length > 0}\n`).join(''),
  );
}
if (process.env.GITHUB_STEP_SUMMARY) {
  const rows = AREAS.map((area) => {
    const list = reasons[area];
    return `| ${area} | ${list.length ? 'run' : 'skip'} | ${list.slice(0, 3).join('<br>')}${list.length > 3 ? `<br>+${list.length - 3} more` : ''} |`;
  });
  appendFileSync(
    process.env.GITHUB_STEP_SUMMARY,
    ['### CI areas', '', '| Area | | Why |', '| --- | --- | --- |', ...rows, ''].join('\n'),
  );
}
