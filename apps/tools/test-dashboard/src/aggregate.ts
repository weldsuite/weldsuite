import { readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname, basename, sep, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import { parseJUnit } from './junit.js';
import { renderDashboard } from './render.js';

/**
 * Build step for the test dashboard. Discovers every `*-junit.xml` report
 * left behind by the test suites, rolls them into one model, and writes a
 * self-contained `public/index.html` (+ `data.json`) for the Worker to serve.
 *
 *   tsx src/aggregate.ts                 # scans <repo>/apps
 *   REPORTS_DIRS=./_reports tsx ...      # scans CI artifact staging dirs
 */

export type Framework = 'vitest' | 'playwright' | 'jest' | 'unknown';

export interface SuiteResult {
  app: string;
  framework: Framework;
  tests: number;
  passed: number;
  failed: number;
  skipped: number;
  durationMs: number;
  timestamp: string | null;
  failures: { name: string; message: string }[];
  reportPath: string;
}

export interface Dashboard {
  generatedAt: string;
  commit: string | null;
  branch: string | null;
  totals: {
    suites: number;
    tests: number;
    passed: number;
    failed: number;
    skipped: number;
    durationMs: number;
  };
  suites: SuiteResult[];
}

const __dirname = dirname(fileURLToPath(import.meta.url));
// apps/tools/test-dashboard/src -> repo root
const repoRoot = join(__dirname, '..', '..', '..');

const PRUNE = new Set(['node_modules', 'dist', '.next', '.expo', '.git', '.turbo', 'coverage', '.wrangler']);

/** Recursively collect `*-junit.xml` paths, pruning heavy/irrelevant dirs. */
function findReports(root: string): string[] {
  const out: string[] = [];
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return out; // root may not exist (e.g. an app never ran) — that's fine
  }
  for (const entry of entries) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) {
      if (!PRUNE.has(entry.name)) out.push(...findReports(full));
    } else if (/-junit\.xml$/i.test(entry.name) || entry.name === 'junit.xml') {
      out.push(full);
    }
  }
  return out;
}

/** Derive `{ app, framework }` from a report path, local or CI layout. */
function deriveMeta(path: string): { app: string; framework: Framework } {
  const parts = path.split(sep);
  const file = basename(path);

  const fwMatch = file.match(/^(vitest|playwright|jest)-junit\.xml$/i);
  const framework = (fwMatch ? fwMatch[1].toLowerCase() : 'unknown') as Framework;

  // Local layout: apps/<app>/test-results/<fw>-junit.xml
  const trIdx = parts.lastIndexOf('test-results');
  if (trIdx > 0) return { app: parts[trIdx - 1], framework };

  // CI layout: _reports/<app>/<fw>-junit.xml
  return { app: parts[parts.length - 2] ?? 'unknown', framework };
}

function gitInfo(): { commit: string | null; branch: string | null } {
  const read = (cmd: string) => {
    try {
      return execSync(cmd, { cwd: repoRoot, stdio: ['ignore', 'pipe', 'ignore'] })
        .toString()
        .trim();
    } catch {
      return null;
    }
  };
  return {
    commit: process.env.GITHUB_SHA ?? read('git rev-parse --short HEAD'),
    branch:
      process.env.GITHUB_REF_NAME ?? read('git rev-parse --abbrev-ref HEAD'),
  };
}

function build(): Dashboard {
  const roots = (process.env.REPORTS_DIRS ?? join(repoRoot, 'apps'))
    .split(',')
    .map((r) => r.trim())
    .filter(Boolean);

  const reportFiles = roots.flatMap((r) => findReports(r));
  const suites: SuiteResult[] = [];

  for (const file of reportFiles) {
    let summary;
    try {
      summary = parseJUnit(readFileSync(file, 'utf8'));
    } catch (err) {
      console.warn(`⚠ skipping unparseable report ${file}: ${(err as Error).message}`);
      continue;
    }
    const { app, framework } = deriveMeta(file);
    const failed = summary.failures + summary.errors;
    suites.push({
      app,
      framework,
      tests: summary.tests,
      passed: Math.max(summary.tests - failed - summary.skipped, 0),
      failed,
      skipped: summary.skipped,
      durationMs: Math.round(summary.durationMs),
      timestamp: summary.timestamp,
      failures: summary.failureDetails,
      reportPath: relative(repoRoot, resolve(file)).split(sep).join('/'),
    });
  }

  // Stable, readable order: framework, then app.
  suites.sort((a, b) =>
    a.framework === b.framework
      ? a.app.localeCompare(b.app)
      : a.framework.localeCompare(b.framework),
  );

  const totals = suites.reduce(
    (acc, s) => {
      acc.tests += s.tests;
      acc.passed += s.passed;
      acc.failed += s.failed;
      acc.skipped += s.skipped;
      acc.durationMs += s.durationMs;
      return acc;
    },
    { suites: suites.length, tests: 0, passed: 0, failed: 0, skipped: 0, durationMs: 0 },
  );

  return { generatedAt: new Date().toISOString(), ...gitInfo(), totals, suites };
}

function main(): void {
  const dashboard = build();
  const publicDir = join(__dirname, '..', 'public');
  mkdirSync(publicDir, { recursive: true });

  writeFileSync(join(publicDir, 'data.json'), JSON.stringify(dashboard, null, 2));
  writeFileSync(join(publicDir, 'index.html'), renderDashboard(dashboard));

  const { totals } = dashboard;
  console.log(
    `✓ dashboard built — ${totals.suites} suites, ${totals.tests} tests, ` +
      `${totals.passed} passed, ${totals.failed} failed, ${totals.skipped} skipped`,
  );
  if (totals.suites === 0) {
    console.warn('⚠ no JUnit reports found — did the suites run with the junit reporter?');
  }
}

main();
