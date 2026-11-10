/**
 * Cross-route safety sweeps for this worker (the same checks app-api runs, from
 * @weldsuite/worker-kit/testing/sweeps):
 *
 * - entity-event coverage: every core-CRUD mutation (`post('/')`,
 *   `patch|put('/:id')`, `delete('/:id')`) publishes an entity event;
 * - auth gates: standard CRUD calls answer 403 without their permission;
 * - list endpoints: GET / answers 200 with the list envelope on an empty tenant.
 *
 * Add a route to AUTH_CASES / LIST_CASES when it follows the standard shape,
 * and to EXEMPT_ROUTES (with a one-line reason) when it has nothing to publish.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  authGateStatuses,
  findMissingEntityEvents,
  listEndpointResult,
  type AuthGateCase,
  type ListSweepCase,
} from '@weldsuite/worker-kit/testing/sweeps';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import type { Env, Variables } from '../types';
import foldersRoutes from './folders';
import formsRoutes from './forms';
import themesRoutes from './themes';

const ROUTES_DIR = __dirname;

/** Route dirs intentionally excluded from entity-event coverage. */
const EXEMPT_ROUTES = new Set<string>([
  // Stores an image in the public bucket and answers its URL: a file, not an entity.
  'media',
]);

/**
 * Mutation routes that publish no entity event on purpose, each with the reason
 * (the sweep above only reads core-CRUD shapes, so these are listed here and
 * checked below: the route must exist and must still publish nothing, so an
 * entry goes stale the day someone adds an event).
 */
const NO_EVENT_ROUTES: Array<{ file: string; method: 'post' | 'put' | 'patch'; path: string; reason: string }> = [
  { file: 'settings/index.ts', method: 'patch', path: '/settings', reason: 'Workspace-wide defaults (sender name, reminder cadence, badge): one settings row, not an entity in the catalog.' },
  { file: 'forms/index.ts', method: 'put', path: '/:id/subscription', reason: "A member's own notification setting for a form: personal preference, not shared state." },
  { file: 'media/index.ts', method: 'post', path: '/', reason: 'Stores an image in the public bucket and answers its URL: a file, not an entity.' },
  { file: 'fill/index.ts', method: 'post', path: '/:publicId/uploads', reason: "Keeps a member's file with their unfinished response; the submit publishes form_response:submitted." },
];

const AUTH_CASES: AuthGateCase<Env, Variables>[] = [
  { mount: '/api/forms/forms', router: formsRoutes, prefix: 'forms' },
  { mount: '/api/forms/folders', router: foldersRoutes, prefix: 'forms' },
  // Writes need `forms:manage`; with only `forms:read` every one of them is refused too.
  { mount: '/api/forms/themes', router: themesRoutes, prefix: 'forms' },
];

const LIST_CASES: ListSweepCase<Env, Variables>[] = [
  { mount: '/api/forms/forms', router: formsRoutes, permission: 'forms:read' },
  { mount: '/api/forms/folders', router: foldersRoutes, permission: 'forms:read' },
  { mount: '/api/forms/themes', router: themesRoutes, permission: 'forms:read' },
];

describe('mutations without an entity event', () => {
  it.each(NO_EVENT_ROUTES)('$method $file $path: $reason', ({ file, method, path }) => {
    const source = readFileSync(join(ROUTES_DIR, file), 'utf8');
    const start = source.indexOf(`app.${method}('${path}'`);
    expect(start, `app.${method}('${path}') not found in ${file}: remove the entry`).toBeGreaterThanOrEqual(0);
    const next = source.indexOf('\napp.', start + 1);
    expect(source.slice(start, next === -1 ? undefined : next), `${file} ${path} publishes an entity event now: remove the entry`).not.toContain('publishEntityEvent');
  });
});

describe('entity-event coverage', () => {
  const report = findMissingEntityEvents(ROUTES_DIR, EXEMPT_ROUTES);

  it('every core-CRUD mutation handler publishes an entity event', () => {
    expect(report.failures, `\n${report.failures.join('\n')}\n`).toEqual([]);
  });

  it('exemptions all reference real route directories', () => {
    expect(report.staleExemptions).toEqual([]);
  });
});

describe.skipIf(AUTH_CASES.length === 0).each(AUTH_CASES)('$mount · auth gates', (c) => {
  // A pglite tenant, so conformance mode can replay the calls against Rust.
  it('refuses every standard CRUD call without its permission', async () => {
    const { db } = await createPgliteDb();
    for (const r of await authGateStatuses(c, db)) expect(r.status, r.label).toBe(403);
  }, 60_000);
});

describe.skipIf(LIST_CASES.length === 0).each(LIST_CASES)('$mount · GET / (list endpoint sweep)', (c) => {
  // 60 s: the first case boots pglite (WASM Postgres) for this test process.
  it('returns 200 with the list envelope against an empty tenant', async () => {
    const { db } = await createPgliteDb();
    const r = await listEndpointResult(c, db);
    expect(r.status).toBe(200);
    expect(r.envelopeOk).toBe(true);
  }, 60_000);
});
