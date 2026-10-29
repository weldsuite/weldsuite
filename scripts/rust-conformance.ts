/**
 * Run the worker tests listed in rust/conformance/suites.json against the Rust
 * backend (phase P2, ADR API-014) and write the coverage report.
 *
 *   pnpm rust:conformance                 build, run every suite, report
 *   pnpm rust:conformance --no-build      reuse rust/target/debug/weldsuite
 *   pnpm rust:conformance --changed BASE  only suites whose paths (or rust/) changed since BASE
 *   pnpm rust:conformance --coverage apps/workers/know-api [...]
 *       run those workers' whole test suites on the Hono app in record-only
 *       mode and report which of their routes the tests reach (playbook step 1)
 *   pnpm rust:conformance --coverage-changed BASE
 *       the same for every worker changed since BASE
 *
 * 1. Builds `weldsuite` with the `conformance` Cargo feature and starts it.
 * 2. Runs each suite's test files with CONFORMANCE_TARGET=rust: every
 *    `createTestApp().request()` goes to Rust and is compared with the Hono app
 *    (packages/core/worker-kit/src/testing/conformance.ts).
 * 3. Writes rust/target/conformance/report.md and report.json: per suite, each
 *    route with the tests that hit it, the status codes seen, whether every
 *    answer matched and validated, and the routes no test reaches.
 *
 * Exits non-zero when a test fails, an answer differs, or a schema check fails.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

interface Suite {
  name: string;
  module: string;
  workspace: string;
  tests: string[];
  paths: string[];
}

interface RequestLine {
  kind: 'request';
  file?: string;
  test?: string;
  method: string;
  path: string;
  route: string | null;
  tsStatus: number;
  /** null in record-only mode. */
  rustStatus: number | null;
  match: boolean;
  difference: string | null;
  schema: 'ok' | 'fail' | 'none';
  schemaError: string | null;
}

interface InventoryLine {
  kind: 'inventory';
  file?: string;
  method: string;
  route: string;
}

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rustDir = path.join(repo, 'rust');
const reportDir = path.join(rustDir, 'target', 'conformance');
const port = Number(process.env.CONFORMANCE_PORT ?? 18089);
const rustUrl = `http://127.0.0.1:${port}`;

const args = process.argv.slice(2);
const noBuild = args.includes('--no-build');
const changedIndex = args.indexOf('--changed');
const changedBase = changedIndex >= 0 ? args[changedIndex + 1] : undefined;
const coverageIndex = args.indexOf('--coverage');
const coverageChangedIndex = args.indexOf('--coverage-changed');

const { suites } = JSON.parse(readFileSync(path.join(rustDir, 'conformance', 'suites.json'), 'utf8')) as {
  suites: Suite[];
};

function changedFiles(base: string): string[] {
  const result = spawnSync('git', ['diff', '--name-only', `${base}...HEAD`], { cwd: repo, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git diff against ${base} failed: ${result.stderr}`);
  return result.stdout.split('\n').filter(Boolean);
}

function selectSuites(): Suite[] {
  if (!changedBase) return suites;
  const changed = changedFiles(changedBase);
  const touches = (prefix: string) => changed.some((file) => file.startsWith(prefix));
  if (touches('rust/') || touches('packages/core/worker-kit/') || touches('scripts/rust-conformance.ts')) return suites;
  return suites.filter(
    (suite) => suite.paths.some(touches) || suite.tests.some((t) => touches(`${suite.workspace}/${t}`)),
  );
}

function run(command: string, commandArgs: string[], cwd: string, env: NodeJS.ProcessEnv = {}): number {
  const result = spawnSync(command, commandArgs, {
    cwd,
    env: { ...process.env, ...env },
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  return result.status ?? 1;
}

/** The throwaway key of the Rust auth tests: conformance builds never verify a token, but the server wants a key. */
function testClerkKey(): string {
  const fixture = JSON.parse(
    readFileSync(path.join(rustDir, 'crates', 'auth', 'tests', 'fixtures', 'clerk-tokens.json'), 'utf8'),
  ) as { publicKeyPem: string };
  return fixture.publicKeyPem;
}

async function waitForServer(server: ChildProcess): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (server.exitCode !== null) throw new Error(`weldsuite exited with ${server.exitCode}`);
    try {
      const response = await fetch(`${rustUrl}/livez`);
      if (response.ok) return;
    } catch {
      // not listening yet
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error('weldsuite did not start listening');
}

function startServer(): ChildProcess {
  const binary = path.join(rustDir, 'target', 'debug', process.platform === 'win32' ? 'weldsuite.exe' : 'weldsuite');
  if (!existsSync(binary)) throw new Error(`${binary} is missing; run without --no-build`);
  const version = spawnSync(binary, ['version'], { encoding: 'utf8' }).stdout.trim();
  if (!version.includes('(conformance)')) {
    throw new Error(`${binary} is "${version}", not a conformance build; run without --no-build`);
  }
  return spawn(binary, ['serve'], {
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      LOG_FORMAT: 'text',
      RUST_LOG: process.env.RUST_LOG ?? 'warn',
      ENVIRONMENT: 'conformance',
      // Never queried in conformance mode: each test brings its own database.
      DATABASE_URL_MASTER: 'postgres://conformance:unused@127.0.0.1:1/unused',
      CLERK_JWT_KEY: testClerkKey(),
      SHUTDOWN_DELAY_SECONDS: '0',
    },
    stdio: ['ignore', 'inherit', 'inherit'],
  });
}

function readLines(dir = reportDir): Array<RequestLine | InventoryLine> {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith('.jsonl'))
    .flatMap((name) =>
      readFileSync(path.join(dir, name), 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as RequestLine | InventoryLine),
    );
}

interface RouteReport {
  method: string;
  route: string;
  tests: string[];
  statuses: number[];
  requests: number;
  mismatches: string[];
  schema: 'ok' | 'fail' | 'none';
}

interface SuiteReport {
  name: string;
  module: string;
  passed: boolean;
  routes: RouteReport[];
  uncovered: Array<{ method: string; route: string }>;
}

function buildReport(selected: Suite[], results: Map<string, boolean>): SuiteReport[] {
  const lines = readLines();
  return selected.map((suite) => {
    const inSuite = (file: string | undefined) =>
      Boolean(file) && suite.tests.some((t) => file!.replaceAll('\\', '/').endsWith(`${suite.workspace}/${t}`));
    const requests = lines.filter((l): l is RequestLine => l.kind === 'request' && inSuite(l.file));
    const inventory = lines.filter((l): l is InventoryLine => l.kind === 'inventory' && inSuite(l.file));

    const routes = new Map<string, RouteReport>();
    for (const line of requests) {
      const key = `${line.method} ${line.route ?? line.path}`;
      const route = routes.get(key) ?? {
        method: line.method,
        route: line.route ?? line.path,
        tests: [],
        statuses: [],
        requests: 0,
        mismatches: [],
        schema: 'none' as const,
      };
      route.requests++;
      if (line.test && !route.tests.includes(line.test)) route.tests.push(line.test);
      const status = line.rustStatus ?? line.tsStatus;
      if (!route.statuses.includes(status)) route.statuses.push(status);
      if (!line.match && line.difference) route.mismatches.push(`${line.test ?? line.path}: ${line.difference}`);
      if (line.schema === 'fail') {
        route.schema = 'fail';
        route.mismatches.push(`${line.test ?? line.path}: schema: ${line.schemaError}`);
      } else if (line.schema === 'ok' && route.schema === 'none') {
        route.schema = 'ok';
      }
      routes.set(key, route);
    }
    const covered = new Set(routes.keys());
    const uncovered = [
      ...new Map(
        inventory
          .filter((r) => !covered.has(`${r.method} ${r.route}`))
          .map((r) => [`${r.method} ${r.route}`, { method: r.method, route: r.route }]),
      ).values(),
    ];
    const sorted = [...routes.values()].sort((a, b) => `${a.route} ${a.method}`.localeCompare(`${b.route} ${b.method}`));
    for (const route of sorted) route.statuses.sort();
    const passed = (results.get(suite.name) ?? false) && sorted.every((r) => r.mismatches.length === 0);
    return { name: suite.name, module: suite.module, passed, routes: sorted, uncovered };
  });
}

function markdown(reports: SuiteReport[]): string {
  const out = ['# Conformance report', '', 'TypeScript worker tests run against the Rust backend (`pnpm rust:conformance`).', ''];
  for (const report of reports) {
    out.push(`## ${report.name} (${report.passed ? 'pass' : 'FAIL'})`, '');
    out.push('| Route | Tests | Requests | Statuses | Schema | Result |', '|---|---|---|---|---|---|');
    for (const r of report.routes) {
      out.push(
        `| \`${r.method} ${r.route}\` | ${r.tests.length} | ${r.requests} | ${r.statuses.join(', ')} | ${r.schema} | ${
          r.mismatches.length === 0 ? 'match' : `${r.mismatches.length} difference(s)`
        } |`,
      );
    }
    if (report.routes.length === 0) out.push('| _no requests recorded_ | | | | | |');
    out.push('');
    if (report.uncovered.length > 0) {
      out.push('Routes of the routers under test that no test reached:', '');
      for (const r of report.uncovered) out.push(`- \`${r.method} ${r.route}\``);
      out.push('');
    }
    const differences = report.routes.flatMap((r) => r.mismatches.map((m) => `- \`${r.method} ${r.route}\`: ${m}`));
    if (differences.length > 0) out.push('Differences:', '', ...differences, '');
  }
  return `${out.join('\n')}\n`;
}

// ── coverage of the workers' own tests (record-only, no Rust) ──────────────

function changedWorkers(base: string): string[] {
  const workers = new Set<string>();
  for (const file of changedFiles(base)) {
    const match = /^apps\/workers\/([^/]+)\//.exec(file);
    if (match && existsSync(path.join(repo, 'apps', 'workers', match[1]!, 'vitest.config.ts'))) {
      workers.add(`apps/workers/${match[1]}`);
    }
  }
  return [...workers].sort();
}

function coverage(workspaces: string[]): void {
  const coverageDir = path.join(reportDir, 'coverage');
  rmSync(coverageDir, { recursive: true, force: true });
  const out = [
    '# Route coverage of the worker tests',
    '',
    "Which routes each worker's own tests reach (record-only mode, no Rust). A module is ported only when every route is covered (playbook steps 1 and 2).",
    '',
  ];
  const summary: Array<{ workspace: string; routes: number; covered: number; testsPassed: boolean }> = [];
  let failed = false;
  for (const workspace of workspaces) {
    const dir = path.join(coverageDir, workspace.replaceAll('/', '_'));
    console.log(`\n== coverage: ${workspace}`);
    const status = run('pnpm', ['test'], path.join(repo, workspace), {
      CONFORMANCE_TARGET: 'record',
      CONFORMANCE_REPORT_DIR: dir,
    });
    failed ||= status !== 0;
    const lines = readLines(dir);
    const keys = new Set<string>();
    const hits = new Map<string, { tests: Set<string>; statuses: Set<number> }>();
    for (const line of lines) {
      if (line.kind === 'inventory') keys.add(`${line.method} ${line.route}`);
      if (line.kind !== 'request' || !line.route) continue;
      const key = `${line.method} ${line.route}`;
      keys.add(key);
      const hit = hits.get(key) ?? { tests: new Set<string>(), statuses: new Set<number>() };
      if (line.test) hit.tests.add(line.test);
      hit.statuses.add(line.tsStatus);
      hits.set(key, hit);
    }
    const routeOf = (key: string) => key.slice(key.indexOf(' ') + 1);
    const all = [...keys].sort((a, b) => routeOf(a).localeCompare(routeOf(b)) || a.localeCompare(b));
    const covered = all.filter((key) => hits.has(key)).length;
    summary.push({ workspace, routes: all.length, covered, testsPassed: status === 0 });
    out.push(`## ${workspace}: ${covered} of ${all.length} routes reached${status === 0 ? '' : ' (tests FAILED)'}`, '');
    out.push('| Route | Tests | Statuses seen |', '|---|---|---|');
    for (const key of all) {
      const hit = hits.get(key);
      const statuses = hit ? [...hit.statuses].sort().join(', ') : '**not reached**';
      out.push(`| \`${key}\` | ${hit ? hit.tests.size : 0} | ${statuses} |`);
    }
    out.push('', 'A router that no test file mounts does not appear here at all.', '');
  }
  mkdirSync(coverageDir, { recursive: true });
  const text = `${out.join('\n')}\n`;
  writeFileSync(path.join(coverageDir, 'coverage.md'), text);
  writeFileSync(path.join(coverageDir, 'coverage.json'), `${JSON.stringify(summary, null, 2)}\n`);
  console.log(`\n${text}`);
  if (process.env.GITHUB_STEP_SUMMARY) writeFileSync(process.env.GITHUB_STEP_SUMMARY, text, { flag: 'a' });
  if (failed) process.exit(1);
}

async function main(): Promise<void> {
  if (coverageIndex >= 0 || coverageChangedIndex >= 0) {
    const workspaces =
      coverageIndex >= 0
        ? args.slice(coverageIndex + 1).filter((a) => !a.startsWith('--'))
        : changedWorkers(args[coverageChangedIndex + 1] ?? 'origin/develop');
    if (workspaces.length === 0) {
      console.log('No worker changed: no coverage report.');
      return;
    }
    coverage(workspaces);
    return;
  }

  const selected = selectSuites();
  if (selected.length === 0) {
    console.log('No conformance suite is affected by this change.');
    mkdirSync(reportDir, { recursive: true });
    writeFileSync(path.join(reportDir, 'report.md'), '# Conformance report\n\nNo suite affected by this change.\n');
    return;
  }

  if (!noBuild) {
    const status = run('cargo', ['build', '-p', 'weldsuite', '--features', 'conformance', '--locked'], rustDir);
    if (status !== 0) process.exit(status);
  }

  rmSync(reportDir, { recursive: true, force: true });
  mkdirSync(reportDir, { recursive: true });

  const server = startServer();
  const results = new Map<string, boolean>();
  try {
    await waitForServer(server);
    for (const suite of selected) {
      console.log(`\n== ${suite.name}: ${suite.tests.length} test file(s) against ${rustUrl}`);
      // One file at a time: Rust's side-effect recordings belong to one request.
      const status = run('pnpm', ['exec', 'vitest', 'run', '--no-file-parallelism', ...suite.tests], path.join(repo, suite.workspace), {
        CONFORMANCE_TARGET: 'rust',
        CONFORMANCE_RUST_URL: rustUrl,
        CONFORMANCE_REPORT_DIR: reportDir,
        CONFORMANCE_STRICT: '0',
      });
      results.set(suite.name, status === 0);
    }
  } finally {
    server.kill();
  }

  const reports = buildReport(selected, results);
  writeFileSync(path.join(reportDir, 'report.json'), `${JSON.stringify(reports, null, 2)}\n`);
  const text = markdown(reports);
  writeFileSync(path.join(reportDir, 'report.md'), text);
  console.log(`\n${text}`);
  if (process.env.GITHUB_STEP_SUMMARY) writeFileSync(process.env.GITHUB_STEP_SUMMARY, text, { flag: 'a' });

  if (!reports.every((r) => r.passed)) process.exit(1);
}

void main();
