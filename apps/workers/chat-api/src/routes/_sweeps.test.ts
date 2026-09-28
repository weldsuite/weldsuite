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
import { chatActivityRoutes } from './chat-activity';
import { chatDmRoutes } from './chat-dm';
import { chatStatusRoutes } from './chat-status';

const ROUTES_DIR = __dirname;

/** Route dirs intentionally excluded from entity-event coverage. */
const EXEMPT_ROUTES = new Set<string>([
  // WeldChat — streams over its own ChatRoom DO, not the entity-event bus
  // (moved here from app-api's _event-coverage.test.ts).
  'channels',
  'channel-members',
  'chat-messages',
  'chat-bookmarks',
  'chat-drafts',
  'chat-sections',
  'chat-activity', // WeldChat — streams over its own ChatRoom DO, not the entity-event bus.
  'chat-directories', // WeldChat — streams over its own ChatRoom DO, not the entity-event bus.
  'chat-dm', // WeldChat — streams over its own ChatRoom DO, not the entity-event bus.
  'chat-entity-channels', // WeldChat — streams over its own ChatRoom DO, not the entity-event bus.
  'chat-search', // WeldChat — streams over its own ChatRoom DO, not the entity-event bus.
  'chat-status', // WeldChat — streams over its own ChatRoom DO, not the entity-event bus.
  // chat-calls — WeldChat call records, stream over the ChatRoom DO, not the entity-event bus.
  'chat-calls',
]);

const AUTH_CASES: AuthGateCase<Env, Variables>[] = [
  // WeldChat DM: GET / + POST / under messages:*; no PATCH/DELETE /:id
  // (the only /:id route is a read-only get-or-create resolver).
  { mount: '/api/chat-dm', router: chatDmRoutes, prefix: 'messages', skipPatch: true, skipDelete: true },
];

const LIST_CASES: ListSweepCase<Env, Variables>[] = [
  // WeldChat — GET / returns a plain list (no cursor pagination) against an empty tenant.
  { mount: '/api/chat-dm', router: chatDmRoutes, permission: 'messages:read' },
  { mount: '/api/chat-status', router: chatStatusRoutes, permission: 'settings:read' },
  { mount: '/api/chat-activity', router: chatActivityRoutes, permission: 'messages:read' },
];

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
  it('refuses every standard CRUD call without its permission', async () => {
    for (const r of await authGateStatuses(c)) expect(r.status, r.label).toBe(403);
  });
});

describe.skipIf(LIST_CASES.length === 0).each(LIST_CASES)('$mount · GET / (list endpoint sweep)', (c) => {
  it('returns 200 with the list envelope against an empty tenant', async () => {
    const { db } = await createPgliteDb();
    const r = await listEndpointResult(c, db);
    expect(r.status).toBe(200);
    expect(r.envelopeOk).toBe(true);
    // A cold pglite boot can pass vitest's 5 s default while the route
    // integration tests boot theirs in parallel (app-api gave its shared
    // boot 60 s).
  }, 60_000);
});
