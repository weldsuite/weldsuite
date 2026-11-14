#!/usr/bin/env node
/**
 * Test coverage for the SonarQube Cloud scan of the files a branch changes
 * (.github/workflows/sonarqube.yml), so the quality gate's "Coverage on New
 * Code" measures what the tests cover instead of reading 0%.
 *
 *   pnpm sonar:changed [<base-ref>] && pnpm sonar:coverage
 *
 * Reads .sonar-changed/coverage-sources.json (scripts/sonar-changed.mjs): the
 * changed source files outside sonar.coverage.exclusions. For each workspace
 * that has some and runs Vitest with @vitest/coverage-v8, it runs the tests
 * related to them (`vitest related`: every test that imports one, directly or
 * through other modules) with coverage of those files only. The lcov reports,
 * their paths made repo-relative, go to .sonar-changed/lcov/ and into the scan
 * settings as sonar.javascript.lcov.reportPaths.
 *
 * Only related tests run, not whole suites, to keep the scan short (ADR
 * OPS-010); a change to a module most of a workspace imports still runs most
 * of its tests. A changed file no test reaches is reported at 0%, as Sonar
 * counts it anyway. A workspace without Vitest coverage is skipped with a
 * warning (Sonar then counts its changed lines as uncovered). Failing tests
 * don't stop the scan: the run keeps what it covered, and the unit test jobs
 * report the failures.
 */
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = '.sonar-changed';
const SETTINGS = `${OUT_DIR}/sonar-project.properties`;
const SOURCES = `${OUT_DIR}/coverage-sources.json`;
const LCOV_DIR = `${OUT_DIR}/lcov`;
// Inside the workspace; `coverage/` is ignored by git and by the scan.
const REPORTS_DIR = 'coverage/sonar';
const VITEST_CONFIGS = ['vitest.config.ts', 'vitest.config.mts', 'vitest.config.js', 'vitest.config.mjs'];
// All workspaces together, inside the job's 30 minutes with the scan after.
const BUDGET_MS = 20 * 60 * 1000;
// Coverage instrumentation slows tests down; don't let it fail them on time.
const TEST_TIMEOUT_MS = 30_000;

if (!existsSync(path.join(repo, SOURCES)) || !existsSync(path.join(repo, SETTINGS))) {
  console.error(`Run scripts/sonar-changed.mjs first: ${SOURCES} or ${SETTINGS} is missing.`);
  process.exit(2);
}
const sources = JSON.parse(readFileSync(path.join(repo, SOURCES), 'utf8'));
const toPosix = file => file.split(path.sep).join('/');

/** The nearest directory above a file with a package.json: its workspace. */
function workspaceOf(file) {
  for (let dir = path.posix.dirname(file); dir !== '.' && dir !== ''; dir = path.posix.dirname(dir)) {
    if (existsSync(path.join(repo, dir, 'package.json'))) return dir;
  }
  return null;
}

/** Why a workspace can't report coverage, or null when it can. */
function whyNoCoverage(dir) {
  const pkg = JSON.parse(readFileSync(path.join(repo, dir, 'package.json'), 'utf8'));
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  if (!deps['@vitest/coverage-v8']) return 'no @vitest/coverage-v8';
  if (!VITEST_CONFIGS.some(name => existsSync(path.join(repo, dir, name)))) return 'no Vitest config';
  return null;
}

/** Vitest's CLI as the workspace resolves it, run with node: no shell, no pnpm. */
function vitestCli(dir) {
  const require = createRequire(path.join(repo, dir, 'package.json'));
  const pkgPath = require.resolve('vitest/package.json');
  return path.join(path.dirname(pkgPath), JSON.parse(readFileSync(pkgPath, 'utf8')).bin.vitest);
}

// A literal path as a coverage.include glob: `[id]` or `(group)` folders
// would otherwise be read as patterns.
const globLiteral = file => file.replace(/[*?[\]{}()!+@]/g, String.raw`\$&`);

const byWorkspace = new Map();
const skipped = [];
for (const file of sources) {
  const dir = workspaceOf(file);
  const why = dir ? whyNoCoverage(dir) : 'not in a workspace';
  if (why) {
    skipped.push(`${file} (${why})`);
    continue;
  }
  if (!byWorkspace.has(dir)) byWorkspace.set(dir, []);
  byWorkspace.get(dir).push(path.posix.relative(dir, file));
}

mkdirSync(path.join(repo, LCOV_DIR), { recursive: true });
const deadline = Date.now() + BUDGET_MS;
const reports = [];
const notes = [];
for (const [dir, files] of byWorkspace) {
  const timeout = deadline - Date.now();
  if (timeout < 60_000) {
    notes.push(`${dir}: skipped, the coverage budget is used up`);
    continue;
  }
  const args = [
    vitestCli(dir),
    'related',
    '--run',
    '--passWithNoTests',
    '--reporter=dot',
    `--testTimeout=${TEST_TIMEOUT_MS}`,
    '--coverage.enabled=true',
    '--coverage.provider=v8',
    '--coverage.reporter=lcov',
    `--coverage.reportsDirectory=${REPORTS_DIR}`,
    '--coverage.reportOnFailure=true',
    ...files.map(file => `--coverage.include=${globLiteral(file)}`),
    ...files,
  ];
  console.log(`\n── ${dir}: tests related to ${files.length} changed file(s) ──`);
  const started = Date.now();
  const run = spawnSync(process.execPath, args, { cwd: path.join(repo, dir), stdio: 'inherit', timeout });
  const took = `${Math.round((Date.now() - started) / 1000)}s`;
  if (run.error) notes.push(`${dir}: ${run.error.code === 'ETIMEDOUT' ? 'timed out' : run.error.message} after ${took}`);
  else if (run.status !== 0) notes.push(`${dir}: Vitest exited with ${run.status} after ${took} (failing tests?)`);
  else notes.push(`${dir}: ${took}`);

  const lcovPath = path.join(repo, dir, REPORTS_DIR, 'lcov.info');
  if (!existsSync(lcovPath)) {
    notes.push(`${dir}: no coverage report`);
    continue;
  }
  // Vitest writes paths relative to the workspace; the scan resolves them
  // from the repo root.
  const lcov = readFileSync(lcovPath, 'utf8').replace(
    /^SF:(.+)$/gm,
    (_, file) => `SF:${toPosix(path.relative(repo, path.resolve(repo, dir, file.trim())))}`,
  );
  const report = `${LCOV_DIR}/${dir.replaceAll('/', '_')}.info`;
  writeFileSync(path.join(repo, report), lcov);
  reports.push(report);
}

if (reports.length) {
  appendFileSync(
    path.join(repo, SETTINGS),
    `sonar.javascript.lcov.reportPaths=\\\n  ${reports.join(',\\\n  ')}\n`,
  );
}

const summary = [
  `${reports.length} coverage report(s) for ${sources.length - skipped.length} of ${sources.length} changed source file(s).`,
  ...notes,
  ...skipped.map(file => `no coverage: ${file}`),
];
console.log(`\n${summary.join('\n')}`);
if (process.env.GITHUB_STEP_SUMMARY) {
  appendFileSync(
    process.env.GITHUB_STEP_SUMMARY,
    `### SonarQube coverage\n\n${summary[0]}\n${summary
      .slice(1)
      .map(line => `\n- ${line}`)
      .join('')}\n`,
  );
}
