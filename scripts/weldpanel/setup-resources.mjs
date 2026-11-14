#!/usr/bin/env node
/**
 * Creates WeldPanel's Cloudflare resources for one environment
 * (docs/plans/weldpanel.md, "Basin tables" and "Recordings"):
 *
 *   streams    one Basin stream per table (events_v1, identities_v1,
 *              people_v1, replay_chunks_v1), with the schema files in
 *              packages/domains/panel/src/
 *   bucket     the private EU-jurisdiction replays bucket and its lifecycle
 *              rules (30d/, 90d/, keep/, snapshots/)
 *   sinks      one Basin Catalog sink per table into `panel.<table>` on the
 *              catalog bucket, plus catalog compaction and snapshot expiry
 *   queue      the erasure queue (panel-api → panel-maintenance)
 *   pipelines  one pipeline per table, stream → sink
 *
 * Idempotent: anything that already exists (by name) is skipped. It prints
 * the stream ids to put into apps/workers/panel-ingest/wrangler.toml.
 *
 * Usage, from the repo root:
 *   node scripts/weldpanel/setup-resources.mjs <test|production> [--step streams|bucket|queue|sinks|pipelines|all] [--dry-run]
 *
 * The sinks and the catalog maintenance need a Cloudflare API token with R2
 * and Basin Catalog access in PANEL_CATALOG_TOKEN; it is passed to wrangler
 * and never printed:
 *   doppler run --project weldsuite --config prd -- node scripts/weldpanel/setup-resources.mjs production
 *
 * Wrangler must be logged in to the WeldSuite account (CLOUDFLARE_ACCOUNT_ID
 * defaults to it).
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const domainSrc = path.join(repoRoot, 'packages', 'domains', 'panel', 'src');
const WELDSUITE_ACCOUNT_ID = 'cfcf560df8dc675d15337abcfbf6d9bd';

const TABLES = [
  { key: 'events', table: 'events_v1', schema: 'events-v1-schema.json' },
  { key: 'identities', table: 'identities_v1', schema: 'identities-v1-schema.json' },
  { key: 'people', table: 'people_v1', schema: 'people-v1-schema.json' },
  { key: 'replay_chunks', table: 'replay_chunks_v1', schema: 'replay-chunks-v1-schema.json' },
];

/** Lifecycle rules of the replays bucket, by key prefix (packages/domains/panel/src/replays.ts). */
const REPLAY_RULES = [
  { name: 'tier-30d', prefix: '30d/', days: 30 },
  { name: 'tier-90d', prefix: '90d/', days: 90 },
  { name: 'tier-keep', prefix: 'keep/', days: 396 },
  { name: 'heatmap-snapshots', prefix: 'snapshots/', days: 90 },
];

const ROLL_INTERVAL_SECONDS = 60;

function parseArgs(argv) {
  const env = argv[0];
  if (env !== 'test' && env !== 'production') {
    console.error('Usage: node scripts/weldpanel/setup-resources.mjs <test|production> [--step streams|bucket|queue|sinks|pipelines|all] [--dry-run]');
    process.exit(2);
  }
  const stepIndex = argv.indexOf('--step');
  const step = stepIndex === -1 ? 'all' : argv[stepIndex + 1];
  if (!['streams', 'bucket', 'queue', 'sinks', 'pipelines', 'all'].includes(step)) {
    console.error(`Unknown step: ${step}`);
    process.exit(2);
  }
  return { env, step, dryRun: argv.includes('--dry-run') };
}

function names(env) {
  const suffix = env === 'test' ? '_test' : '';
  return {
    catalogBucket: env === 'test' ? 'weldsuite-panel-test' : 'weldsuite-panel',
    replaysBucket: env === 'test' ? 'weldsuite-panel-replays-test' : 'weldsuite-panel-replays',
    maintenanceQueue: env === 'test' ? 'panel-maintenance-test' : 'panel-maintenance',
    stream: (key) => `weldpanel_${key}${suffix}`,
    sink: (key) => `weldpanel_${key}_sink${suffix}`,
    pipeline: (key) => `weldpanel_${key}_pipeline${suffix}`,
  };
}

function wranglerBin() {
  const local = path.join(repoRoot, 'apps', 'workers', 'panel-ingest', 'node_modules', '.bin', process.platform === 'win32' ? 'wrangler.cmd' : 'wrangler');
  return existsSync(local) ? local : 'wrangler';
}

/** Runs wrangler outside any worker folder, so no wrangler.toml is parsed. `secret` values are masked in the echo. */
function wrangler(args, { dryRun, secret, allowFail = false } = {}) {
  const shown = args.map((a) => (secret && a === secret ? '***' : a)).join(' ');
  console.log(`$ wrangler ${shown}`);
  if (dryRun) return { ok: true, stdout: '' };
  const result = spawnSync(wranglerBin(), args, {
    cwd: repoRoot,
    encoding: 'utf8',
    shell: process.platform === 'win32',
    env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: process.env.CLOUDFLARE_ACCOUNT_ID || WELDSUITE_ACCOUNT_ID },
  });
  const ok = result.status === 0;
  if (!ok && !allowFail) {
    console.error(result.stdout);
    console.error(result.stderr);
    throw new Error(`wrangler ${args[0]} ${args[1] ?? ''} failed`);
  }
  return { ok, stdout: result.stdout ?? '' };
}

/** Names in a wrangler table listing (first column). */
function listedNames(stdout) {
  const found = new Set();
  for (const line of stdout.split(/\r?\n/)) {
    const match = /^│ ([a-z0-9_-]+)\s+│/i.exec(line);
    if (match) found.add(match[1]);
  }
  return found;
}

/** `name → id` from a streams listing. */
function listedIds(stdout) {
  const ids = new Map();
  for (const line of stdout.split(/\r?\n/)) {
    const match = /^│ ([a-z0-9_]+)\s+│ ([0-9a-f]{32}) /i.exec(line);
    if (match) ids.set(match[1], match[2]);
  }
  return ids;
}

function createStreams(env, n, dryRun) {
  const existing = listedNames(wrangler(['pipelines', 'streams', 'list'], {}).stdout);
  for (const t of TABLES) {
    const name = n.stream(t.key);
    if (existing.has(name)) {
      console.log(`  stream ${name} exists`);
      continue;
    }
    wrangler(['pipelines', 'streams', 'create', name, '--schema-file', path.join(domainSrc, t.schema), '--http-enabled', 'false'], { dryRun });
  }
  const ids = listedIds(wrangler(['pipelines', 'streams', 'list'], {}).stdout);
  console.log(`\nStream ids for apps/workers/panel-ingest/wrangler.toml [env.${env}]:`);
  for (const t of TABLES) console.log(`  ${t.key.padEnd(14)} ${n.stream(t.key).padEnd(32)} ${ids.get(n.stream(t.key)) ?? '(not created)'}`);
}

function createBucket(n, dryRun) {
  const listing = wrangler(['r2', 'bucket', 'list', '--jurisdiction', 'eu'], {}).stdout;
  if (listing.split(/\s+/).includes(n.replaysBucket)) {
    console.log(`  bucket ${n.replaysBucket} (eu) exists`);
  } else {
    wrangler(['r2', 'bucket', 'create', n.replaysBucket, '--jurisdiction', 'eu'], { dryRun });
  }
  const rules = wrangler(['r2', 'bucket', 'lifecycle', 'list', n.replaysBucket, '--jurisdiction', 'eu'], { allowFail: true }).stdout;
  for (const rule of REPLAY_RULES) {
    if (rules.includes(rule.name)) {
      console.log(`  lifecycle rule ${rule.name} exists`);
      continue;
    }
    wrangler(
      ['r2', 'bucket', 'lifecycle', 'add', n.replaysBucket, rule.name, rule.prefix, '--expire-days', String(rule.days), '--abort-multipart-days', '1', '--jurisdiction', 'eu', '--force'],
      { dryRun },
    );
  }
}

/** The erasure queue panel-api produces to and apps/workers/panel-maintenance consumes. */
function createQueue(n, dryRun) {
  const existing = wrangler(['queues', 'list'], {}).stdout;
  // Whole names only: `panel-maintenance` must not match `panel-maintenance-test`.
  if (existing.split(/[\s│]+/).includes(n.maintenanceQueue)) {
    console.log(`  queue ${n.maintenanceQueue} exists`);
    return;
  }
  wrangler(['queues', 'create', n.maintenanceQueue], { dryRun });
}

function catalogToken() {
  const token = process.env.PANEL_CATALOG_TOKEN;
  if (!token) {
    console.error('PANEL_CATALOG_TOKEN is not set. Run through Doppler, e.g.\n  doppler run --project weldsuite --config prd -- node scripts/weldpanel/setup-resources.mjs production --step sinks');
    process.exit(1);
  }
  return token;
}

function createSinks(n, dryRun) {
  const token = catalogToken();
  const existing = listedNames(wrangler(['pipelines', 'sinks', 'list'], {}).stdout);
  for (const t of TABLES) {
    const name = n.sink(t.key);
    if (existing.has(name)) {
      console.log(`  sink ${name} exists`);
      continue;
    }
    wrangler(
      ['pipelines', 'sinks', 'create', name, '--type', 'r2-data-catalog', '--bucket', n.catalogBucket, '--namespace', 'panel', '--table', t.table, '--roll-interval', String(ROLL_INTERVAL_SECONDS), '--catalog-token', token],
      { dryRun, secret: token },
    );
  }
  wrangler(['r2', 'bucket', 'catalog', 'compaction', 'enable', n.catalogBucket, '--token', token], { dryRun, secret: token, allowFail: true });
  wrangler(['r2', 'bucket', 'catalog', 'snapshot-expiration', 'enable', n.catalogBucket, '--token', token], { dryRun, secret: token, allowFail: true });
}

function createPipelines(n, dryRun) {
  const existing = listedNames(wrangler(['pipelines', 'list'], {}).stdout);
  for (const t of TABLES) {
    const name = n.pipeline(t.key);
    if (existing.has(name)) {
      console.log(`  pipeline ${name} exists`);
      continue;
    }
    wrangler(['pipelines', 'create', name, '--sql', `INSERT INTO ${n.sink(t.key)} SELECT * FROM ${n.stream(t.key)}`], { dryRun });
  }
}

const { env, step, dryRun } = parseArgs(process.argv.slice(2));
const n = names(env);
console.log(`WeldPanel resources, ${env}${dryRun ? ' (dry run)' : ''}\n`);
if (step === 'streams' || step === 'all') createStreams(env, n, dryRun);
if (step === 'bucket' || step === 'all') createBucket(n, dryRun);
if (step === 'queue' || step === 'all') createQueue(n, dryRun);
if (step === 'sinks' || step === 'all') createSinks(n, dryRun);
if (step === 'pipelines' || step === 'all') createPipelines(n, dryRun);
console.log('\nDone. Add the replays bucket binding (PANEL_REPLAYS, jurisdiction = "eu") and the stream ids to the collector and panel-api wrangler.toml for this environment.');
