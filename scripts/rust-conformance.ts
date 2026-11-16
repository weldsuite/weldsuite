/**
 * Run the worker tests listed in rust/conformance/suites.json against the Rust
 * backend (phase P2, ADR API-014) and write the coverage report.
 *
 *   pnpm rust:conformance                 build, run every suite, report
 *   pnpm rust:conformance --no-build      reuse rust/target/debug/weldsuite (or CONFORMANCE_BIN)
 *   pnpm rust:conformance --list          print the suites the other flags select, and stop
 *                                         (with --changed BASE: what this branch would run)
 *   pnpm rust:conformance --changed BASE  only suites whose paths, tests or Rust module changed since
 *                                         BASE (any other Rust change: every suite; see rustReach)
 *   pnpm rust:conformance --shard 2/4     the second of four even shares of the selected suites (CI)
 *   pnpm rust:conformance --suite merge   only the suites named (repeatable; a name or a `prefix:` like `connect:`)
 *   pnpm rust:conformance --module board  only the suites of these modules (repeatable)
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
  /**
   * Routes (`METHOD /api/path/:param`) the suite leaves out on purpose, each
   * with the reason (e.g. WeldMail's domain provisioning, which differs by
   * edition, ADR MAIL-010). They are not required to be reached, and are
   * tested on the Rust side instead.
   */
  excludedRoutes?: Array<{ route: string; reason: string }>;
  /**
   * The route prefixes the suite owns, when its files mount other route
   * groups' routers only to set up their data: only routes under them are
   * recorded in its inventory (the test side filters,
   * worker-kit/src/testing/conformance-coverage.ts). Absent: every route its
   * files mount. Empty: none (a cross-area suite).
   */
  coverage?: string[];
}

/** TypeScript's answer against the route's registered response schema. */
type SchemaCheck = 'ok' | 'fail' | 'none';

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
  schema: SchemaCheck;
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
// CONFORMANCE_REPORT_DIR and CONFORMANCE_BIN let parallel runs (one per worktree
// session or agent) keep their own report and their own copy of the server:
// Windows locks a running .exe, so a shared one blocks the next cargo build.
const reportDir = process.env.CONFORMANCE_REPORT_DIR ?? path.join(rustDir, 'target', 'conformance');
const port = Number(process.env.CONFORMANCE_PORT ?? 18089);
const rustUrl = `http://127.0.0.1:${port}`;

const args = process.argv.slice(2);
const noBuild = args.includes('--no-build');
const listOnly = args.includes('--list');
const changedIndex = args.indexOf('--changed');
const changedBase = changedIndex >= 0 ? args[changedIndex + 1] : undefined;
const coverageIndex = args.indexOf('--coverage');
const coverageChangedIndex = args.indexOf('--coverage-changed');
const shardIndex = args.indexOf('--shard');
const shard = shardIndex >= 0 ? parseShard(args[shardIndex + 1]) : undefined;
/** `--suite <name>`, repeatable: an exact suite name, or a prefix ending in `:`. */
const suiteNames = args.flatMap((arg, i) => (arg === '--suite' && args[i + 1] ? [args[i + 1]!] : []));
const namedSuite = (name: string) =>
  suiteNames.length === 0 || suiteNames.some((wanted) => name === wanted || (wanted.endsWith(':') && name.startsWith(wanted)));
/** `--module id`, repeatable: only those modules' suites. */
const onlyModules = new Set(args.flatMap((arg, i) => (arg === '--module' && args[i + 1] ? [args[i + 1]!] : [])));

/** `--shard i/n`: the i-th of n slices of the selected suites, 1-based. */
function parseShard(value: string | undefined): { index: number; count: number } {
  const match = /^(\d+)\/(\d+)$/.exec(value ?? '');
  const index = Number(match?.[1]);
  const count = Number(match?.[2]);
  if (!match || count < 1 || index < 1 || index > count) {
    throw new Error(`--shard wants i/n with 1 <= i <= n, not ${value ?? 'nothing'}`);
  }
  return { index, count };
}

const { suites } = JSON.parse(readFileSync(path.join(rustDir, 'conformance', 'suites.json'), 'utf8')) as {
  suites: Suite[];
};

/** Modules marked ported (`RUST_PORTED_MODULES`, exported by `pnpm rust:catalogs`). */
const portedModules = new Set(
  (JSON.parse(readFileSync(path.join(rustDir, 'catalogs', 'api-modules.json'), 'utf8')) as Array<{ id: string; rust: boolean }>)
    .filter((m) => m.rust)
    .map((m) => m.id),
);

function changedFiles(base: string): string[] {
  const result = spawnSync('git', ['diff', '--name-only', `${base}...HEAD`], { cwd: repo, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git diff against ${base} failed: ${result.stderr}`);
  return result.stdout.split('\n').filter(Boolean);
}

function selectSuites(): Suite[] {
  if (onlyModules.size > 0) return suites.filter((suite) => onlyModules.has(suite.module) && namedSuite(suite.name));
  const named = suites.filter((suite) => namedSuite(suite.name));
  if (!changedBase) return named;
  const changed = changedFiles(changedBase);
  const touches = (prefix: string) => changed.some((file) => file.startsWith(prefix));
  if (touches('packages/core/worker-kit/') || touches('scripts/rust-conformance.ts')) return named;
  const reached = rustReach(changed);
  if (reached === 'all') return named;
  return named.filter(
    (suite) =>
      reached.has(suite.module) || suite.paths.some(touches) || suite.tests.some((t) => touches(`${suite.workspace}/${t}`)),
  );
}

/**
 * Under rust/, but read by no build of the server: the deploy configuration,
 * the image's Dockerfile, the docs, the lint and format settings. Markdown
 * anywhere under rust/ counts too. (.github/scripts/ci-changes.mjs keeps the
 * same list as RUST_NOT_CODE, less the lint settings Rust · checks reads.)
 */
const RUST_NOT_SERVER = [
  'rust/deploy/',
  'rust/docs/',
  'rust/Dockerfile',
  'rust/docker/',
  'rust/clippy.toml',
  'rust/rustfmt.toml',
  'rust/deny.toml',
];

/** The module crate a suite-less name serves under: `mcp` serves mcp-server. */
const CRATE_SUITE_MODULE: Record<string, string> = { mcp: 'mcp-server' };

/**
 * The suite module a crate in rust/modules serves: its own name, else the
 * longest suite module it is named after (`books-sales` → books, `core-team`
 * → core, `desk-widget` → desk). Undefined for a crate no suite covers (a
 * Rust-only module has nothing to compare with).
 */
function suiteModuleOf(crate: string, modules: Set<string>): string | undefined {
  const mapped = CRATE_SUITE_MODULE[crate];
  if (mapped) return mapped;
  if (modules.has(crate)) return crate;
  return [...modules].filter((m) => crate.startsWith(`${m}-`)).sort((a, b) => b.length - a.length)[0];
}

/**
 * The workspace crates (`weldsuite-<name>`, as <name>) a Cargo.toml names in
 * its [dependencies], [build-dependencies] or target-specific dependencies.
 * Not [dev-dependencies]: they reach the crate's tests, not the server.
 */
function workspaceDependencies(cargoToml: string): string[] {
  const names: string[] = [];
  let section = '';
  for (const line of cargoToml.split('\n')) {
    const header = /^\s*\[([^\]]+)\]/.exec(line);
    if (header) section = header[1]!;
    else if (/(^|\.)(build-)?dependencies$/.test(section)) {
      const name = /^\s*weldsuite-([a-z0-9-]+)\s*=/.exec(line)?.[1];
      if (name) names.push(name);
    }
  }
  return names;
}

/** Module crate → the module crates that depend on it. */
function moduleCrateDependents(): Map<string, Set<string>> {
  const modulesDir = path.join(rustDir, 'modules');
  const crates = readdirSync(modulesDir).filter((dir) => existsSync(path.join(modulesDir, dir, 'Cargo.toml')));
  const dependents = new Map<string, Set<string>>();
  for (const crate of crates) {
    const deps = workspaceDependencies(readFileSync(path.join(modulesDir, crate, 'Cargo.toml'), 'utf8'));
    for (const dep of deps.filter((name) => name !== crate && crates.includes(name))) {
      dependents.set(dep, (dependents.get(dep) ?? new Set()).add(crate));
    }
  }
  return dependents;
}

/**
 * The suite modules the change's Rust files reach. Rust-first work mostly
 * changes one module crate, and running all 159 suites for it took every
 * shard 20 minutes. A file in rust/modules/<crate>/ reaches the suites of the
 * module that crate serves and of the module crates that depend on it; any
 * other Rust file (the shared crates, which the binary also links directly,
 * the binary, the catalogs, the Cargo files, conformance/) reaches them all.
 * Files no build of the server reads reach none. Pushes to main run every
 * suite whatever changed.
 */
function rustReach(changed: string[]): Set<string> | 'all' {
  const crates = new Set<string>();
  for (const file of changed) {
    if (!file.startsWith('rust/') || file.endsWith('.md') || RUST_NOT_SERVER.some((p) => file.startsWith(p))) continue;
    const crate = /^rust\/modules\/([^/]+)\//.exec(file)?.[1];
    if (!crate) return 'all';
    crates.add(crate);
  }
  if (crates.size === 0) return new Set();
  const dependents = moduleCrateDependents();
  const queue = [...crates];
  while (queue.length > 0) {
    for (const dependent of dependents.get(queue.pop()!) ?? []) {
      if (crates.has(dependent)) continue;
      crates.add(dependent);
      queue.push(dependent);
    }
  }
  const modules = new Set(suites.map((suite) => suite.module));
  const reached = new Set([...crates].flatMap((crate) => suiteModuleOf(crate, modules) ?? []));
  const sorted = (names: Iterable<string>) => [...names].sort((a, b) => a.localeCompare(b)).join(', ');
  console.log(`Rust module crates reached: ${sorted(crates)}; their suites' modules: ${sorted(reached) || 'none'}`);
  return reached;
}

/** Seconds a suite takes on CI: per suite, and per test file (fitted on main, November 2026, R² 0.88). */
const SUITE_SECONDS = 2;
const FILE_SECONDS = 8.4;

/**
 * `--shard i/n`: the suites dealt to shard i. Biggest first, each to the
 * shard with the least work so far, weighed by test files, so the shards
 * finish together (dealt round-robin by count, one shard drew 114 test files
 * and another 50: 18 minutes against 7). Every shard computes the same deal.
 */
function dealt(selected: Suite[]): Suite[] {
  if (!shard) return selected;
  const load: number[] = Array.from({ length: shard.count }, () => 0);
  const mine = new Set<Suite>();
  const biggestFirst = selected
    .map((suite, index) => ({ suite, index }))
    .sort((a, b) => b.suite.tests.length - a.suite.tests.length || a.index - b.index);
  for (const { suite } of biggestFirst) {
    let least = 0;
    for (let i = 1; i < shard.count; i++) if (load[i]! < load[least]!) least = i;
    load[least] = load[least]! + SUITE_SECONDS + FILE_SECONDS * suite.tests.length;
    if (least === shard.index - 1) mine.add(suite);
  }
  return selected.filter((suite) => mine.has(suite));
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
  const binary =
    process.env.CONFORMANCE_BIN ?? path.join(rustDir, 'target', 'debug', process.platform === 'win32' ? 'weldsuite.exe' : 'weldsuite');
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
  schema: SchemaCheck;
}

interface SuiteReport {
  name: string;
  module: string;
  passed: boolean;
  routes: RouteReport[];
  uncovered: Array<{ method: string; route: string }>;
  excluded: Array<{ route: string; reason: string }>;
}

/** Fold one recorded request into its route's report. */
function addRequest(route: RouteReport, line: RequestLine): void {
  const label = line.test ?? line.path;
  route.requests++;
  if (line.test && !route.tests.includes(line.test)) route.tests.push(line.test);
  const status = line.rustStatus ?? line.tsStatus;
  if (!route.statuses.includes(status)) route.statuses.push(status);
  if (!line.match && line.difference) route.mismatches.push(`${label}: ${line.difference}`);
  if (line.schema === 'fail') {
    route.schema = 'fail';
    route.mismatches.push(`${label}: schema: ${line.schemaError}`);
  } else if (line.schema === 'ok' && route.schema === 'none') {
    route.schema = 'ok';
  }
}

/** Per route, sorted by path: the tests, statuses and differences seen. */
function routeReports(requests: RequestLine[]): RouteReport[] {
  const routes = new Map<string, RouteReport>();
  for (const line of requests) {
    const path = line.route ?? line.path;
    const key = `${line.method} ${path}`;
    const route = routes.get(key) ?? {
      method: line.method,
      route: path,
      tests: [],
      statuses: [],
      requests: 0,
      mismatches: [],
      schema: 'none' as const,
    };
    addRequest(route, line);
    routes.set(key, route);
  }
  const sorted = [...routes.values()].sort((a, b) => `${a.route} ${a.method}`.localeCompare(`${b.route} ${b.method}`));
  for (const route of sorted) route.statuses.sort((a, b) => a - b);
  return sorted;
}

/** Inventory routes no request reached, once each. */
function uncoveredRoutes(inventory: InventoryLine[], routes: RouteReport[]): Array<{ method: string; route: string }> {
  const covered = new Set(routes.map((r) => `${r.method} ${r.route}`));
  const missing = new Map<string, { method: string; route: string }>();
  for (const r of inventory) {
    const key = `${r.method} ${r.route}`;
    if (!covered.has(key)) missing.set(key, { method: r.method, route: r.route });
  }
  return [...missing.values()];
}

function buildReport(selected: Suite[], results: Map<string, boolean>): SuiteReport[] {
  const lines = readLines();
  return selected.map((suite) => {
    const inSuite = (file: string | undefined) =>
      Boolean(file) && suite.tests.some((t) => file!.replaceAll('\\', '/').endsWith(`${suite.workspace}/${t}`));
    const routes = routeReports(lines.filter((l): l is RequestLine => l.kind === 'request' && inSuite(l.file)));
    const inventory = lines.filter((l): l is InventoryLine => l.kind === 'inventory' && inSuite(l.file));
    const excluded = suite.excludedRoutes ?? [];
    const excludedKeys = new Set(excluded.map((e) => e.route));
    const uncovered = uncoveredRoutes(inventory, routes).filter((r) => !excludedKeys.has(`${r.method} ${r.route}`));
    // A ported module needs every route covered (playbook steps 2 and 6).
    const covered = !portedModules.has(suite.module) || uncovered.length === 0;
    const passed = (results.get(suite.name) ?? false) && covered && routes.every((r) => r.mismatches.length === 0);
    return { name: suite.name, module: suite.module, passed, routes, uncovered, excluded };
  });
}

/** One suite's section of the conformance report. */
function suiteSection(report: SuiteReport): string[] {
  const out = [
    `## ${report.name} (${report.passed ? 'pass' : 'FAIL'})`,
    '',
    '| Route | Tests | Requests | Statuses | Schema | Result |',
    '|---|---|---|---|---|---|',
  ];
  for (const r of report.routes) {
    const result = r.mismatches.length === 0 ? 'match' : `${r.mismatches.length} difference(s)`;
    out.push(
      `| \`${r.method} ${r.route}\` | ${r.tests.length} | ${r.requests} | ${r.statuses.join(', ')} | ${r.schema} | ${result} |`,
    );
  }
  if (report.routes.length === 0) out.push('| _no requests recorded_ | | | | | |');
  out.push('');
  if (report.uncovered.length > 0) {
    out.push(
      portedModules.has(report.module)
        ? 'Routes no test reached (a ported module must reach them all):'
        : 'Routes of the routers under test that no test reached:',
      '',
    );
    out.push(...report.uncovered.map((r) => `- \`${r.method} ${r.route}\``), '');
  }
  if (report.excluded.length > 0) {
    out.push('Routes left out of this suite on purpose:', '');
    out.push(...report.excluded.map((e) => `- \`${e.route}\`: ${e.reason}`), '');
  }
  const differences = report.routes.flatMap((r) => r.mismatches.map((m) => `- \`${r.method} ${r.route}\`: ${m}`));
  if (differences.length > 0) out.push('Differences:', '', ...differences, '');
  return out;
}

function markdown(reports: SuiteReport[]): string {
  const out = ['# Conformance report', '', 'TypeScript worker tests run against the Rust backend (`pnpm rust:conformance`).', ''];
  for (const report of reports) out.push(...suiteSection(report));
  return `${out.join('\n')}\n`;
}

// ── coverage of the workers' own tests (record-only, no Rust) ──────────────

/**
 * Workers whose own files changed since `base`. A change to a worker's
 * package.json alone (a dependency bump) does not count: it cannot change
 * which routes the tests reach, and a bump across the monorepo would otherwise
 * run every worker's whole suite and outlast the CI job.
 */
function changedWorkers(base: string): string[] {
  const workers = new Set<string>();
  for (const file of changedFiles(base)) {
    const match = /^apps\/workers\/([^/]+)\/(.+)$/.exec(file);
    if (match?.[2] === 'package.json') continue;
    if (match && existsSync(path.join(repo, 'apps', 'workers', match[1]!, 'vitest.config.ts'))) {
      workers.add(`apps/workers/${match[1]}`);
    }
  }
  return [...workers].sort();
}

interface RouteHits {
  tests: Set<string>;
  statuses: Set<number>;
  /** TypeScript's answers against the route's registered schema: 'none' until one is checked. */
  schema: SchemaCheck;
  schemaErrors: string[];
}

/** Every route the inventory or a request names, and what reached each. */
function routeHits(lines: Array<RequestLine | InventoryLine>): { keys: string[]; hits: Map<string, RouteHits> } {
  const keys = new Set<string>();
  const hits = new Map<string, RouteHits>();
  for (const line of lines) {
    if (line.kind === 'inventory') keys.add(`${line.method} ${line.route}`);
    if (line.kind !== 'request' || !line.route) continue;
    const key = `${line.method} ${line.route}`;
    keys.add(key);
    const hit: RouteHits = hits.get(key) ?? { tests: new Set<string>(), statuses: new Set<number>(), schema: 'none', schemaErrors: [] };
    if (line.test) hit.tests.add(line.test);
    hit.statuses.add(line.tsStatus);
    if (line.schema === 'fail') {
      hit.schema = 'fail';
      if (hit.schemaErrors.length < 3) hit.schemaErrors.push(`${line.test ?? line.path}: ${line.schemaError}`);
    } else if (line.schema === 'ok' && hit.schema === 'none') {
      hit.schema = 'ok';
    }
    hits.set(key, hit);
  }
  const routeOf = (key: string) => key.slice(key.indexOf(' ') + 1);
  return { keys: [...keys].sort((a, b) => routeOf(a).localeCompare(routeOf(b)) || a.localeCompare(b)), hits };
}

/** One worker's section of the coverage report. */
function coverageSection(workspace: string, keys: string[], hits: Map<string, RouteHits>, passed: boolean): string[] {
  const covered = keys.filter((key) => hits.has(key)).length;
  const out = [
    `## ${workspace}: ${covered} of ${keys.length} routes reached${passed ? '' : ' (tests FAILED)'}`,
    '',
    '| Route | Tests | Statuses seen | Schema |',
    '|---|---|---|---|',
  ];
  for (const key of keys) {
    const hit = hits.get(key);
    const statuses = hit ? [...hit.statuses].sort((a, b) => a - b).join(', ') : '**not reached**';
    out.push(`| \`${key}\` | ${hit ? hit.tests.size : 0} | ${statuses} | ${hit?.schema ?? 'none'} |`);
  }
  out.push('', 'A router that no test file mounts does not appear here at all.', '');
  const schemaErrors = keys.flatMap((key) => (hits.get(key)?.schemaErrors ?? []).map((e) => `- \`${key}\`: ${e}`));
  if (schemaErrors.length > 0) out.push("TypeScript's answers that fail the route's registered schema:", '', ...schemaErrors, '');
  return out;
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
  for (const workspace of workspaces) {
    const dir = path.join(coverageDir, workspace.replaceAll('/', '_'));
    console.log(`\n== coverage: ${workspace}`);
    const passed =
      run('pnpm', ['test'], path.join(repo, workspace), { CONFORMANCE_TARGET: 'record', CONFORMANCE_REPORT_DIR: dir }) === 0;
    const { keys, hits } = routeHits(readLines(dir));
    summary.push({ workspace, routes: keys.length, covered: keys.filter((key) => hits.has(key)).length, testsPassed: passed });
    out.push(...coverageSection(workspace, keys, hits, passed));
  }
  mkdirSync(coverageDir, { recursive: true });
  const text = `${out.join('\n')}\n`;
  writeFileSync(path.join(coverageDir, 'coverage.md'), text);
  writeFileSync(path.join(coverageDir, 'coverage.json'), `${JSON.stringify(summary, null, 2)}\n`);
  console.log(`\n${text}`);
  if (process.env.GITHUB_STEP_SUMMARY) writeFileSync(process.env.GITHUB_STEP_SUMMARY, text, { flag: 'a' });
  if (!summary.every((s) => s.testsPassed)) process.exit(1);
}

async function main(): Promise<void> {
  if (coverageIndex >= 0 || coverageChangedIndex >= 0) {
    const workspaces =
      coverageIndex >= 0
        ? args.slice(coverageIndex + 1).filter((a) => !a.startsWith('--'))
        : changedWorkers(args[coverageChangedIndex + 1] ?? 'origin/main');
    if (workspaces.length === 0) {
      console.log('No worker changed: no coverage report.');
      return;
    }
    coverage(workspaces);
    return;
  }

  const selected = dealt(selectSuites());
  if (listOnly) {
    for (const suite of selected) console.log(`${suite.name} (${suite.tests.length} test files)`);
    const files = selected.reduce((sum, suite) => sum + suite.tests.length, 0);
    console.log(`${selected.length} suites, ${files} test files, about ${Math.round((files * FILE_SECONDS + selected.length * SUITE_SECONDS) / 60)} minutes`);
    return;
  }
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
      // Every request runs twice and a write copies the database first, so a
      // test takes several times as long; at vitest's 5 s default a test that
      // times out leaves requests running into the next test's recordings.
      const vitest = ['exec', 'vitest', 'run', '--no-file-parallelism', '--testTimeout=120000', ...suite.tests];
      const status = run('pnpm', vitest, path.join(repo, suite.workspace), {
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
