/**
 * Parametrised integration sweep: every list route's GET / endpoint
 * must return 200 (with an empty `data: []`) against an empty pglite
 * tenant. Catches SQL bugs in the list query — wrong table reference,
 * missing column, busted index hint — that would 500 in production.
 *
 * Routes here are the ones whose list-query is straightforward enough
 * to test against an empty DB without seed data. Entities that branch
 * on related rows (counts joined onto activities/orders/etc.) live in
 * their own dedicated integration files.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { listEndpointResult, type ListSweepCase } from '@weldsuite/worker-kit/testing/sweeps';
import { createPgliteDb } from '../test/pglite';
import type { Database, } from '../db';
import type { Env, Variables } from '../types';

import { customFieldsRoutes } from './custom-fields';
import { chatDmRoutes } from './chat-dm';
import { chatStatusRoutes } from './chat-status';
import { chatActivityRoutes } from './chat-activity';

type SweepCase = ListSweepCase<Env, Variables>;

const cases: SweepCase[] = [
  // (tasks and my-tasks moved to flow-api, workflows to connect-api; their
  // cases live in those workers' _sweeps.test.ts.)
  { mount: '/api/custom-fields', router: customFieldsRoutes, permission: 'settings:read' },
  // WeldChat — GET / returns a plain list (no cursor pagination) against an empty tenant.
  { mount: '/api/chat-dm', router: chatDmRoutes, permission: 'messages:read' },
  { mount: '/api/chat-status', router: chatStatusRoutes, permission: 'settings:read' },
  { mount: '/api/chat-activity', router: chatActivityRoutes, permission: 'messages:read' },
];

let db: Database;

beforeAll(async () => {
  const handle = await createPgliteDb();
  db = handle.db;
}, 60_000);

describe.each(cases)('$mount · GET / (list endpoint sweep)', (c) => {
  it('returns 200 with the list envelope against an empty tenant', async () => {
    const r = await listEndpointResult(c, db);
    expect(r.status).toBe(200);
    expect(r.envelopeOk).toBe(true);
  });
});
