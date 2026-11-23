/**
 * Deletes records a pressure test left behind (a run aborted mid-iteration,
 * or a delete that failed under load). Only touches records carrying the
 * `loadtest` marker: people named `loadtest …` / emailed `loadtest+…`, and
 * companies, tickets and tasks whose name/subject/title starts with `loadtest `.
 *
 * Uses the first-party API when there is a member session (Clerk on Global,
 * WeldID on EU), otherwise the public API key. `pnpm load-test cleanup`
 * (add `--target eu` for the EU install).
 */

import http from 'k6/http';
import {
  assertSafeTarget,
  IS_EU,
  listOf,
  MARKER,
  platformHost,
  publicApiHost,
  TARGET_LABEL,
  workspaceHeaders,
  WORKSPACES,
} from '../lib/config.js';
import { bearerToken, hasPlatformCredentials, initialToken } from '../lib/auth.js';

export const options = { vus: 1, iterations: 1, setupTimeout: '2m', summaryTrendStats: ['count'] };

const usePlatform = __ENV.CLEANUP_API ? __ENV.CLEANUP_API === 'platform' : hasPlatformCredentials();

const prefixed = (value) => typeof value === 'string' && value.startsWith(`${MARKER} `);
const TARGETS = [
  {
    label: 'people',
    module: 'crm',
    platformPath: '/api/people',
    publicPath: '/v1/people',
    match: (row) => row.firstName === MARKER || String(row.email || '').startsWith(`${MARKER}+`),
  },
  { label: 'companies', module: 'crm', platformPath: '/api/companies', publicPath: '/v1/companies', match: (row) => prefixed(row.name) },
  { label: 'tickets', module: 'desk', platformPath: '/api/tickets', publicPath: '/v1/tickets', match: (row) => prefixed(row.subject) },
  { label: 'tasks', module: 'flow', platformPath: '/api/tasks', publicPath: '/v1/tasks', match: (row) => prefixed(row.title) },
];

export function setup() {
  assertSafeTarget();
  console.log(`Cleanup on ${TARGET_LABEL} through the ${usePlatform ? 'first-party' : 'public'} API`);
  if (usePlatform) return { platform: true, token: initialToken() };
  if (!__ENV.WELD_API_KEY) throw new Error('Set a member session (Clerk, or WeldID with --target eu) or WELD_API_KEY in scripts/load-test/.env');
  return { platform: false };
}

/** A member session's passes: each of WELD_WORKSPACE on EU, the Clerk session's one workspace on Global. */
function platformPasses(token) {
  const workspaces = IS_EU ? WORKSPACES : [undefined];
  return workspaces.map((workspace) => ({
    label: workspace ? ` (${workspace})` : '',
    headers: () => ({ Authorization: `Bearer ${bearerToken(token)}`, Accept: 'application/json', ...workspaceHeaders(workspace) }),
  }));
}

/** The public API's passes: one per key of WELD_API_KEY. */
function publicPasses() {
  return listOf(__ENV.WELD_API_KEY).map((key, i, keys) => ({
    label: keys.length > 1 ? ` (key ${i + 1})` : '',
    headers: () => ({ Authorization: `Bearer ${key}`, Accept: 'application/json' }),
  }));
}

export default function (shared) {
  // One pass per test workspace.
  const passes = shared.platform ? platformPasses(shared.token) : publicPasses();
  const base = (target) => (shared.platform ? `${platformHost(target.module)}${target.platformPath}` : `${publicApiHost()}${target.publicPath}`);

  for (const pass of passes) {
    for (const target of TARGETS) {
      const deleted = sweep(target, base(target), pass.headers);
      console.log(`${target.label}${pass.label}: deleted ${deleted} leftover record(s)`);
    }
  }
}

/**
 * Deleted rows drop out of the list, so keep re-reading page one until
 * nothing new matches. `seen` stops a loop on rows that won't go away.
 */
function sweep(target, url, headers) {
  const seen = {};
  let deleted = 0;
  for (let round = 0; round < 200; round++) {
    const res = http.get(`${url}?limit=100&search=${MARKER}`, { headers: headers() });
    if (res.status !== 200) {
      console.error(`${target.label}: list returned ${res.status} ${String(res.body).slice(0, 200)}`);
      return deleted;
    }
    const rows = (res.json('data') || []).filter((row) => target.match(row) && !seen[row.id]);
    if (rows.length === 0) return deleted;
    for (const row of rows) {
      seen[row.id] = true;
      const del = http.del(`${url}/${row.id}`, null, { headers: headers() });
      if ([200, 204, 404].includes(del.status)) deleted++;
      else console.error(`${target.label}: delete ${row.id} returned ${del.status}`);
    }
  }
  return deleted;
}
