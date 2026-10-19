#!/usr/bin/env node
/**
 * Run a WeldSuite pressure test with k6.
 *
 *   pnpm load-test <platform|public|all|cleanup> [profile] [options]
 *
 *   profile        smoke (default) | load | stress | spike | soak | breakpoint
 *   --scale N      multiply users / request rate (0.2 = gentle, 2 = double)
 *   --writes R     share of iterations that create/update/delete (default 0.2)
 *   --duration D   hold time for load/soak, ramp time for breakpoint (e.g. 10m)
 *   --via-app-api  send first-party calls through app-api's forwarder
 *   --env NAME     test (default) | production (also needs ALLOW_PRODUCTION=yes)
 *   --no-dashboard skip the live dashboard + HTML report
 *   --no-cleanup   don't sweep leftover `loadtest` records afterwards
 *
 * Settings and credentials come from scripts/load-test/.env (see
 * .env.example). Reports land in scripts/load-test/results/.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const SCENARIOS = { platform: 'scenarios/platform.js', public: 'scenarios/public-api.js', cleanup: 'scenarios/cleanup.js' };
const PROFILES = ['smoke', 'load', 'stress', 'spike', 'soak', 'breakpoint'];

function usage(message) {
  if (message) console.error(`\n${message}\n`);
  console.error('Usage: pnpm load-test <platform|public|all|cleanup> [smoke|load|stress|spike|soak|breakpoint] [--scale N] [--writes R] [--duration D] [--via-app-api] [--env test] [--no-dashboard] [--no-cleanup]');
  process.exit(2);
}

function parseArgs(argv) {
  const opts = { target: undefined, profile: 'smoke', dashboard: true, cleanup: true, env: {} };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => argv[++i] ?? usage(`${arg} needs a value`);
    if (arg === '--scale') opts.env.SCALE = next();
    else if (arg === '--writes') opts.env.WRITE_RATIO = next();
    else if (arg === '--duration') opts.env.DURATION = next();
    else if (arg === '--env') opts.env.WELD_ENV = next();
    else if (arg === '--via-app-api') opts.env.VIA_APP_API = '1';
    else if (arg === '--no-dashboard') opts.dashboard = false;
    else if (arg === '--no-cleanup') opts.cleanup = false;
    else if (arg === '--help' || arg === '-h') usage();
    else if (arg.startsWith('--')) usage(`Unknown option ${arg}`);
    else positional.push(arg);
  }
  [opts.target, opts.profile = 'smoke'] = positional;
  if (!['platform', 'public', 'all', 'cleanup'].includes(opts.target)) usage('Pick what to test: platform, public, all or cleanup.');
  if (!PROFILES.includes(opts.profile)) usage(`Unknown profile "${opts.profile}".`);
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

function runK6(k6, scenario, label, env, opts) {
  const childEnv = { ...env };
  if (opts.dashboard && scenario !== 'cleanup') {
    Object.assign(childEnv, {
      K6_WEB_DASHBOARD: 'true',
      K6_WEB_DASHBOARD_OPEN: 'false',
      K6_WEB_DASHBOARD_EXPORT: `results/${env.RUN_ID}-${label}-${env.PROFILE}.html`,
    });
    console.log(`\n▶ ${label} / ${env.PROFILE} — live dashboard at http://localhost:5665\n`);
  }
  const result = spawnSync(k6, ['run', SCENARIOS[scenario]], { cwd: here, env: childEnv, stdio: 'inherit' });
  return result.status ?? 1;
}

const opts = parseArgs(process.argv.slice(2));
const env = { ...loadDotEnv(path.join(here, '.env')), ...process.env, ...opts.env };
env.PROFILE = opts.profile;
env.RUN_ID = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
env.RESULTS_DIR = 'results';

const weldEnv = (env.WELD_ENV || 'test').toLowerCase();
if (weldEnv === 'production' && env.ALLOW_PRODUCTION !== 'yes') {
  usage('Refusing to pressure-test production. Set ALLOW_PRODUCTION=yes if you really mean it.');
}

mkdirSync(path.join(here, 'results'), { recursive: true });
const k6 = findK6();

let exitCode = 0;
if (opts.target === 'cleanup') {
  exitCode = runK6(k6, 'cleanup', 'cleanup', env, opts);
} else {
  const targets = opts.target === 'all' ? ['platform', 'public'] : [opts.target];
  for (const target of targets) {
    const code = runK6(k6, target, target, env, opts);
    // 99 = thresholds crossed: the run finished, the system just didn't meet the bar.
    if (code !== 0) exitCode = exitCode || code;
    if (opts.cleanup && opts.env.WRITE_RATIO !== '0' && env.WRITE_RATIO !== '0') {
      console.log('\nSweeping leftover loadtest records…');
      runK6(k6, 'cleanup', 'cleanup', { ...env, CLEANUP_API: target }, opts);
    }
  }
}

if (exitCode === 99) console.log('\nThe run finished but at least one threshold failed (see Verdict above).');
process.exit(exitCode);
