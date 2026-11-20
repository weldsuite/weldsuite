#!/usr/bin/env node
/**
 * Run a WeldSuite pressure test with k6.
 *
 *   pnpm load-test <platform|public|all|cleanup> [profile] [options]
 *   pnpm load-test login  --target eu      sign the EU test member in (once)
 *   pnpm load-test logout --target eu      revoke and forget that sign-in
 *
 *   profile          smoke (default) | load | stress | spike | soak | breakpoint
 *   --target T       global (default): Cloudflare Workers + Clerk
 *                    eu: the Rust server on Kubernetes + WeldID
 *   --env NAME       test (default) | production (also needs ALLOW_PRODUCTION=yes)
 *   --workspace W    EU: the test workspace (ws_… id or slug), sent as X-Weld-Workspace
 *   --scale N        multiply users / request rate (0.2 = gentle, 2 = double)
 *   --writes R       share of iterations that create/update/delete (default 0.2)
 *   --duration D     hold time for load/soak, ramp time for breakpoint (e.g. 10m)
 *   --via-app-api    Global: send first-party calls through app-api's forwarder
 *   --no-dashboard   skip the live dashboard + HTML report
 *   --no-cleanup     don't sweep leftover `loadtest` records afterwards
 *   --no-browser     login: print the sign-in link without opening a browser
 *
 * Settings and credentials come from scripts/load-test/.env (see
 * .env.example). Reports land in scripts/load-test/results/. On EU the
 * runner also holds the WeldID session and hands the VUs access tokens
 * (lib/weldid.mjs), so k6 runs as its child, not on its own.
 */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { platformBase, productionRefusal, targetName, targetOf, truthy } from './lib/targets.mjs';
import { describeFailure, login, logout, printable, sessionFile, startTokenBroker } from './lib/weldid.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const SCENARIOS = { platform: 'scenarios/platform.js', public: 'scenarios/public-api.js', cleanup: 'scenarios/cleanup.js' };
const PROFILES = new Set(['smoke', 'load', 'stress', 'spike', 'soak', 'breakpoint']);
const COMMANDS = new Set(['platform', 'public', 'all', 'cleanup', 'login', 'logout']);

function usage(message) {
  if (message) console.error(`\n${message}\n`);
  console.error(
    'Usage: pnpm load-test <platform|public|all|cleanup> [smoke|load|stress|spike|soak|breakpoint] [--target global|eu] [--env test] [--workspace ws_…] [--scale N] [--writes R] [--duration D] [--via-app-api] [--no-dashboard] [--no-cleanup]\n' +
      '       pnpm load-test <login|logout> --target eu [--env test] [--no-browser]',
  );
  process.exit(2);
}

/** Options that take a value, and the setting each one sets. */
const VALUE_OPTIONS = {
  '--scale': 'SCALE',
  '--writes': 'WRITE_RATIO',
  '--duration': 'DURATION',
  '--env': 'WELD_ENV',
  '--target': 'WELD_TARGET',
  '--workspace': 'WELD_WORKSPACE',
};
/** Switches. */
const FLAGS = {
  '--via-app-api': (opts) => (opts.env.VIA_APP_API = '1'),
  '--no-dashboard': (opts) => (opts.dashboard = false),
  '--no-cleanup': (opts) => (opts.cleanup = false),
  '--no-browser': (opts) => (opts.browser = false),
};

function parseArgs(argv) {
  const opts = { command: undefined, profile: 'smoke', dashboard: true, cleanup: true, browser: true, env: {} };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') usage();
    if (Object.hasOwn(VALUE_OPTIONS, arg)) {
      i++;
      if (argv[i] === undefined) usage(`${arg} needs a value`);
      opts.env[VALUE_OPTIONS[arg]] = argv[i];
    } else if (Object.hasOwn(FLAGS, arg)) FLAGS[arg](opts);
    else if (arg.startsWith('--')) usage(`Unknown option ${arg}`);
    else positional.push(arg);
  }
  [opts.command, opts.profile = 'smoke'] = positional;
  if (!COMMANDS.has(opts.command)) usage('Pick what to test: platform, public, all or cleanup (or login / logout for EU).');
  if (!PROFILES.has(opts.profile)) usage(`Unknown profile "${opts.profile}".`);
  return opts;
}

/** Minimal .env reader; real environment variables win. */
function loadDotEnv(file) {
  if (!existsSync(file)) return {};
  const vars = {};
  for (const raw of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    const eq = line.indexOf('=');
    if (!line || line.startsWith('#') || eq < 1) continue;
    let value = line.slice(eq + 1).trim();
    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.endsWith(quote) && value.length > 1) value = value.slice(1, -1);
    vars[line.slice(0, eq).trim()] = value;
  }
  return vars;
}

function findK6() {
  const candidates = ['k6'];
  if (process.platform === 'win32') candidates.push(path.join(process.env.ProgramFiles || 'C:\\Program Files', 'k6', 'k6.exe'));
  for (const bin of candidates) {
    if (spawnSync(bin, ['version'], { stdio: 'ignore' }).status === 0) return bin;
  }
  console.error('k6 is not installed. Install it once with:\n  winget install GrafanaLabs.k6   (Windows)\n  brew install k6                 (macOS)\nthen open a new terminal.');
  process.exit(2);
}

/**
 * k6 as a child process, without blocking: on EU the token broker in this
 * process must keep answering while k6 runs.
 */
function runK6(k6, scenario, label, env, opts) {
  const childEnv = { ...env };
  if (opts.dashboard && scenario !== 'cleanup') {
    Object.assign(childEnv, {
      K6_WEB_DASHBOARD: 'true',
      K6_WEB_DASHBOARD_OPEN: 'false',
      K6_WEB_DASHBOARD_EXPORT: `results/${env.RUN_ID}-${label}-${env.PROFILE}.html`,
    });
    console.log(`\n▶ ${label} / ${opts.profile} — live dashboard at http://localhost:5665\n`);
  }
  return new Promise((resolve) => {
    const child = spawn(k6, ['run', SCENARIOS[scenario]], { cwd: here, env: childEnv, stdio: 'inherit' });
    child.on('error', (error) => {
      console.error(`Could not start k6 (${describeFailure(error)})`);
      resolve(1);
    });
    child.on('exit', (code, signal) => resolve(code ?? (signal ? 1 : 0)));
  });
}

// Ctrl+C reaches k6 too, which stops gracefully and writes its report. This
// process stays up meanwhile (the broker must keep answering), skips the
// targets still to come, and still sweeps. A second Ctrl+C quits at once.
let interrupted = 0;
process.on('SIGINT', () => {
  interrupted++;
  if (interrupted > 1) process.exit(130);
  console.log('\nStopping after this run (the sweep still runs). Ctrl+C again to quit at once.');
});

/** After `login`: the member's workspaces, and whether WELD_WORKSPACE names them. */
function reportWorkspaces(workspaces, env) {
  console.log('Workspaces this member can use:');
  for (const w of workspaces) {
    const slug = w.slug ? ` (${w.slug})` : '';
    console.log(printable(`  ${w.id}  ${w.name}${slug}  ${w.role || ''}`));
  }
  const chosen = String(env.WELD_WORKSPACE || '')
    .split(',')
    .map((w) => w.trim())
    .filter(Boolean);
  if (chosen.length === 0) {
    console.log('\nSet WELD_WORKSPACE=<the test workspace id> in scripts/load-test/.env (or pass --workspace); several, comma separated, spread the load.');
    return;
  }
  // Only what the server sent and the entry's position are printed, never
  // the setting itself: the environment the runner reads also holds secrets.
  console.log('');
  let ready = true;
  for (const [index, ref] of chosen.entries()) {
    const match = workspaces.find((w) => w.id === ref || w.workspaceId === ref || w.slug === ref);
    const entry = `WELD_WORKSPACE entry ${index + 1} of ${chosen.length}`;
    if (match) console.log(printable(`${entry} is ${match.id}, ${match.name}.`));
    else console.log(`${entry} is not one of them: the run would get 403s there. Fix it in .env.`);
    ready &&= Boolean(match);
  }
  if (ready) console.log('Ready.');
}

async function runLogin(env, opts) {
  const apiBase = platformBase(env, 'app');
  const file = sessionFile(here, apiBase);
  if (opts.command === 'logout') {
    await logout({ file });
    return;
  }
  const result = await login({ apiBase, file, openBrowser: opts.browser });
  console.log('');
  console.log(printable(`Signed in as ${result.email || result.subject}. The refresh token is in scripts/load-test/.weldid/ (git-ignored).`));
  console.log("Close that browser window, but don't sign out there: that ends the test's session too.\n");
  if (!result.workspaces) {
    console.log(`Could not list the workspaces (GET /api/workspaces answered ${result.workspacesStatus}).`);
  } else if (result.workspaces.length === 0) {
    console.log('This member belongs to no workspace yet. Invite them to the test workspace, then set WELD_WORKSPACE.');
  } else {
    reportWorkspaces(result.workspaces, env);
  }
}

/** The settings for this run (.env, then the environment, then the options), checked. */
function settingsFor(opts) {
  const env = { ...loadDotEnv(path.join(here, '.env')), ...process.env, ...opts.env };
  env.PROFILE = opts.profile;
  env.RUN_ID = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  env.RESULTS_DIR = 'results';
  let target;
  try {
    target = targetOf(env);
  } catch {
    usage('Unknown target (WELD_TARGET / --target): use global or eu.');
  }
  const refusal = productionRefusal(env);
  if (refusal) usage(refusal);
  if (target === 'eu' && truthy(env.VIA_APP_API)) usage('--via-app-api is for Global: the EU install serves every module from one server.');
  return { env, target };
}

/**
 * EU: one WeldID refresher for every VU (lib/weldid.mjs), started on first
 * need. `session({ required })` gives the k6 settings that reach it; without
 * `required`, no stored sign-in just means none (cleanup then uses WELD_API_KEY).
 */
function memberSessions(env, target) {
  let broker = null;
  const file = sessionFile(here, platformBase(env, 'app'));
  return {
    async session({ required }) {
      if (target !== 'eu' || env.WELD_TOKEN) return {};
      if (!required && !existsSync(file)) return {};
      broker ??= await startTokenBroker({ file });
      return { TOKEN_BROKER_URL: broker.url, TOKEN_BROKER_KEY: broker.key };
    },
    close: () => broker?.close(),
  };
}

/** platform, public or both, each followed by its sweep. Returns the first failing exit code. */
async function runSuites(k6, env, opts, sessions) {
  let exitCode = 0;
  const suites = opts.command === 'all' ? ['platform', 'public'] : [opts.command];
  for (const suite of suites) {
    if (interrupted) break;
    const session = suite === 'platform' ? await sessions.session({ required: true }) : {};
    const code = await runK6(k6, suite, suite, { ...env, ...session }, opts);
    // 99 = thresholds crossed: the run finished, the system just didn't meet the bar.
    if (code !== 0) exitCode = exitCode || code;
    if (opts.cleanup && env.WRITE_RATIO !== '0') {
      console.log('\nSweeping leftover loadtest records…');
      await runK6(k6, 'cleanup', 'cleanup', { ...env, ...session, CLEANUP_API: suite }, opts);
    }
  }
  return exitCode;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const { env, target } = settingsFor(opts);

  if (opts.command === 'login' || opts.command === 'logout') {
    if (target !== 'eu') usage(`${opts.command} is for the EU install (WeldID): add --target eu. Global uses a Clerk session id (README).`);
    await runLogin(env, opts);
    return 0;
  }

  console.log(`Target: ${targetName(env)}`);
  mkdirSync(path.join(here, 'results'), { recursive: true });
  const k6 = findK6();
  const sessions = memberSessions(env, target);
  let exitCode;
  try {
    exitCode =
      opts.command === 'cleanup'
        ? await runK6(k6, 'cleanup', 'cleanup', { ...env, ...(await sessions.session({ required: false })) }, opts)
        : await runSuites(k6, env, opts, sessions);
  } finally {
    await sessions.close();
  }

  if (exitCode === 99) console.log('\nThe run finished but at least one threshold failed (see Verdict above).');
  return exitCode;
}

try {
  process.exit(await main());
} catch (error) {
  // Fixed text per failure (lib/weldid.mjs), never the error's own message.
  console.error(`\n${describeFailure(error)}\n`);
  process.exit(2);
}
