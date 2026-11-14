#!/usr/bin/env node
/**
 * Turns the change detection of the deploy-prepare action into a deploy plan:
 * the flags and matrices the deploy jobs gate on.
 *
 * Every deploy target is listed here (core workers, mobile apps, Pages apps,
 * TanStack Start Workers), so the deploy workflows only consume JSON lists and
 * never name a target. That is what lets the private deploy repo
 * (weldsuite-documentation/plans/main-only-private-deploys.md) run this repo's deploy logic
 * without changing when a worker or an app is added here. Module API workers
 * come from module-workers.mjs, Vercel apps from vercel-apps.mjs.
 *
 * Env:
 *   FULL               "true": deploy everything (manual dispatch)
 *   CHANGES            JSON array of the filters.yml keys the diff touched
 *                      (dorny/paths-filter `changes`); unset when FULL
 *   MODULE_WORKERS     JSON array from module-workers.mjs
 *   ENVIRONMENT        test | production
 *   ADMIN_WORKER_ENVS  repository variable: the environments whose admin
 *                      console runs as a Worker ("test", "test,production")
 *   PLAN_SUMMARY       "true": also write the plan to GITHUB_STEP_SUMMARY
 *   VERCEL_APPS        JSON from vercel-apps.mjs, only for that summary
 *
 * Writes to GITHUB_OUTPUT: migrations, d1_connector_migrations,
 * d1_schedule_migrations, hosted_apps, run_d1_migrations, d1_connector, d1_schedule,
 * workers, mobile_apps, pages_apps, start_apps.
 */

import { appendFileSync } from 'node:fs';

/** apps/workers/<name> deployed by the `workers` job, in matrix order. Each has a filters.yml key. */
const CORE_WORKERS = [
  'app-api',
  'billing-worker',
  'audit-log-worker',
  'entity-events-worker',
  'analytics-worker',
  'external-api',
  'integration-webhook-worker',
  'integration-sync-worker',
  'mail-inbound-worker',
  'personal-api',
  'realtime-worker',
  'workspace-worker',
  'workflow-worker',
  'mcp-server',
  'agent-runtime',
  'discord-bot-worker',
  'helpdesk-widget-api',
  'helpdesk-workflow-worker',
  'reach-warmup-worker',
  'panel-ingest',
  'panel-maintenance',
];

/**
 * Expo apps (apps/mobile/<app>-app) released as an OTA update by the
 * deploy-mobile action. `filter` is the filters.yml key that releases it.
 */
const MOBILE_APPS = [
  { app: 'weldmail', name: 'WeldMail', filter: 'weldmail' },
  { app: 'weldchat', name: 'WeldChat', filter: 'weldchat' },
  { app: 'weldbooks', name: 'WeldBooks', filter: 'weldbooks' },
  { app: 'weldflow', name: 'WeldFlow', filter: 'weldflow' },
  { app: 'weldagent', name: 'WeldAgent', filter: 'weldagent' },
  { app: 'weldcalendar', name: 'WeldCalendar', filter: 'weldcalendar' },
  { app: 'weldhr', name: 'WeldHR', filter: 'weldhr' },
];

/**
 * Vite SPAs (apps/web/<app>) on Cloudflare Pages, deployed by the
 * deploy-pages action. The platform has no filter: it deploys on every run.
 */
const PAGES_APPS = [
  { app: 'platform', name: 'platform', filter: null },
  { app: 'weldmail', name: 'WeldMail web', filter: 'weldmail-web' },
  { app: 'weldcalendar', name: 'WeldCalendar web', filter: 'weldcalendar-web' },
  { app: 'developer', name: 'Developer portal', filter: 'developer-web' },
];

/** TanStack Start apps (apps/web/<app>) on Cloudflare Workers, deployed by the deploy-start-worker action. */
const START_APPS = [
  { app: 'helpcenter', name: 'Help center', filter: 'helpcenter' },
  // The portal runs sign-api's domain code, so it also ships whenever sign-api
  // does: module-workers.mjs picks sign-api from its transitive workspace deps
  // and the lockfile, which the path filter cannot follow.
  { app: 'sign-portal', name: 'Sign portal', filter: 'sign-portal', alsoWithModule: 'sign-api' },
  { app: 'project-portal', name: 'Project portal', filter: 'project-portal' },
  // Calls forms-api over the FORMS_API service binding; bundles the embed SDK as /embed.js.
  { app: 'forms-portal', name: 'Forms portal', filter: 'forms-portal' },
  // Switched on per environment by ADMIN_WORKER_ENVS. Until it names an
  // environment, that environment's console stays on Vercel (apps/web/admin/README.md).
  { app: 'admin', name: 'Admin console', filter: 'admin', adminWorkerEnvsOnly: true },
];

/** filters.yml keys passed through as plain "true"/"false" outputs. */
const FLAGS = ['migrations', 'd1_connector_migrations', 'd1_schedule_migrations', 'hosted_apps'];

function parseList(name) {
  const raw = process.env[name];
  if (!raw) return [];
  const value = JSON.parse(raw);
  if (!Array.isArray(value)) throw new Error(`${name} is not a JSON array: ${raw}`);
  return value;
}

const full = process.env.FULL === 'true';
const environment = process.env.ENVIRONMENT ?? '';
const moduleWorkers = parseList('MODULE_WORKERS');

let changed;
if (full) {
  console.log('Manual workflow_dispatch: forcing full deploy (all selectors true)');
  changed = () => true;
} else {
  const changes = new Set(parseList('CHANGES'));
  changed = (key) => changes.has(key);
}

// --- Core workers ---------------------------------------------------------
let workers;
if (changed('all_workers')) {
  workers = [...CORE_WORKERS];
  console.log(
    `Deploying all ${CORE_WORKERS.length} workers (lockfile, workspace graph, @weldsuite/db graph changed, or manual dispatch)`,
  );
} else {
  workers = CORE_WORKERS.filter((w) => changed(w));
  console.log(
    workers.length
      ? `Deploying workers: ${JSON.stringify(workers)}`
      : 'No workers changed; skipping worker deploy',
  );
}

// --- D1 migrations --------------------------------------------------------
// The gates below match the substring `contains()` checks on the JSON strings
// that the old public deploy.yml used, so "workflow-worker" also
// matches helpdesk-workflow-worker. The D1 migrations are idempotent, so an
// extra run costs nothing.
const workersJson = JSON.stringify(workers).toLowerCase();
const moduleWorkersJson = JSON.stringify(moduleWorkers).toLowerCase();
const d1Connector =
  changed('d1_connector_migrations') ||
  ['integration-sync-worker', 'integration-webhook-worker', 'app-api'].some((w) =>
    workersJson.includes(w),
  ) ||
  ['connect-api', 'commerce-api'].some((w) => moduleWorkersJson.includes(w));
const d1Schedule =
  changed('d1_schedule_migrations') ||
  workersJson.includes('workflow-worker') ||
  moduleWorkersJson.includes('connect-api');
const runD1 =
  changed('d1_connector_migrations') ||
  changed('d1_schedule_migrations') ||
  workers.length > 0 ||
  moduleWorkers.length > 0;

// --- Apps -----------------------------------------------------------------
const pick = ({ app, name }) => ({ app, name });

const mobileApps = MOBILE_APPS.filter((a) => changed(a.filter)).map(pick);
const pagesApps = PAGES_APPS.filter((a) => a.filter === null || changed(a.filter)).map(pick);
// GitHub's contains() is case-insensitive; keep that for ADMIN_WORKER_ENVS.
const adminWorkerEnvs = (process.env.ADMIN_WORKER_ENVS ?? '').toLowerCase();
const startApps = START_APPS.filter((a) => {
  const selected = changed(a.filter) || (a.alsoWithModule && moduleWorkers.includes(a.alsoWithModule));
  if (!selected) return false;
  return !a.adminWorkerEnvsOnly || adminWorkerEnvs.includes(environment.toLowerCase());
}).map(pick);

const output = {
  ...Object.fromEntries(FLAGS.map((f) => [f, String(changed(f))])),
  run_d1_migrations: String(runD1),
  d1_connector: String(d1Connector),
  d1_schedule: String(d1Schedule),
  workers: JSON.stringify(workers),
  mobile_apps: JSON.stringify(mobileApps),
  pages_apps: JSON.stringify(pagesApps),
  start_apps: JSON.stringify(startApps),
};

for (const [key, value] of Object.entries(output)) console.log(`${key}=${value}`);

if (process.env.GITHUB_OUTPUT) {
  appendFileSync(
    process.env.GITHUB_OUTPUT,
    Object.entries(output)
      .map(([key, value]) => `${key}=${value}\n`)
      .join(''),
  );
}

if (process.env.PLAN_SUMMARY === 'true' && process.env.GITHUB_STEP_SUMMARY) {
  const names = (list) => (list.length ? list.map((a) => a.name ?? a).join(', ') : 'none');
  const rows = [
    ['Environment', environment || '?'],
    ['Database migrations', output.migrations],
    ['D1 migrations', runD1 ? `connector ${d1Connector}, schedule ${d1Schedule}` : 'none'],
    ['Module API workers', names(moduleWorkers)],
    ['Core workers', names(workers)],
    ['Mobile OTA', names(mobileApps)],
    ['Pages', names(pagesApps)],
    ['TanStack Start Workers', names(startApps)],
    ['Vercel', names(parseList('VERCEL_APPS').map((a) => a.app))],
    ['Hosted apps', output.hosted_apps === 'true' ? 'changed' : 'none'],
  ];
  appendFileSync(
    process.env.GITHUB_STEP_SUMMARY,
    ['### Deploy plan', '', '| | |', '|---|---|', ...rows.map(([k, v]) => `| ${k} | ${v} |`), ''].join(
      '\n',
    ),
  );
}
