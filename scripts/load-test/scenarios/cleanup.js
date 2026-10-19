/**
 * Deletes records a pressure test left behind (a run aborted mid-iteration,
 * or a delete that failed under load). Only touches records carrying the
 * `loadtest` marker: people named `loadtest …` / emailed `loadtest+…`, and
 * companies, tickets and tasks whose name/subject/title starts with `loadtest `.
 *
 * Uses the first-party API when Clerk credentials are set, otherwise the
 * public API key. `pnpm load-test cleanup`.
 */

import http from 'k6/http';
import { assertSafeTarget, MARKER, platformHost, publicApiHost } from '../lib/config.js';
import { bearerToken, initialToken } from '../lib/auth.js';

export const options = { vus: 1, iterations: 1, setupTimeout: '2m', summaryTrendStats: ['count'] };

const hasClerk = Boolean(__ENV.WELD_TOKEN || (__ENV.CLERK_SESSION_ID && __ENV.CLERK_SECRET_KEY));
const usePlatform = __ENV.CLEANUP_API ? __ENV.CLEANUP_API === 'platform' : hasClerk;

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
  if (usePlatform) return { platform: true, token: initialToken() };
  if (!__ENV.WELD_API_KEY) throw new Error('Set Clerk credentials or WELD_API_KEY in scripts/load-test/.env');
  return { platform: false };
}

export default function (shared) {
  const headers = () => ({
    Authorization: `Bearer ${shared.platform ? bearerToken(shared.token) : __ENV.WELD_API_KEY}`,
    Accept: 'application/json',
  });
  const base = (target) => (shared.platform ? `${platformHost(target.module)}${target.platformPath}` : `${publicApiHost()}${target.publicPath}`);

  for (const target of TARGETS) {
    const deleted = sweep(target, base(target), headers);
    console.log(`${target.label}: deleted ${deleted} leftover record(s)`);
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
