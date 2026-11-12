/**
 * Parametrised auth-gate sweep across every route that uses the standard
 * `requirePermission(<entity>:<action>)` shape. Each route is verified
 * for the bare minimum:
 *
 *   - GET /        returns 403 without `<entity>:read`
 *   - POST /       returns 403 without `<entity>:create`
 *   - PATCH /:id   returns 403 without `<entity>:update`
 *   - DELETE /:id  returns 403 without `<entity>:delete`
 *
 * These don't replace the per-route happy-path tests (those still live
 * in `routes/<entity>/index.test.ts`) — they're a safety net so the
 * permission contract is impossible to drop accidentally.
 */

import { describe, it, expect } from 'vitest';
import { authGateStatuses, type AuthGateCase } from '@weldsuite/worker-kit/testing/sweeps';

import { auditLogStreamsRoutes } from './audit-log-streams';
import { customFieldsRoutes } from './custom-fields';
import { legalEntitiesRoutes } from './legal-entities';
import type { Env, Variables } from '../types';

type RouteCase = AuthGateCase<Env, Variables>;

const cases: RouteCase[] = [
  // (projects, tasks and milestones moved to flow-api, mail-messages to
  // mail-api, chat-dm to chat-api; their cases live in those workers'
  // _sweeps.test.ts.)
  // custom-fields updates via PUT /:id (not PATCH), gated on settings:manage.
  { mount: '/api/custom-fields', router: customFieldsRoutes, prefix: 'settings', skipPatch: true },
  { mount: '/api/legal-entities', router: legalEntitiesRoutes, prefix: 'legal_entities' },
  // Audit log streams: read is general:read; create / update / delete (and the test) all take general:update.
  { mount: '/api/audit-log-streams', router: auditLogStreamsRoutes, prefix: 'general' },
];

describe.each(cases)('$mount · auth gates', (c) => {
  it('refuses every standard CRUD call without its permission', async () => {
    for (const r of await authGateStatuses(c)) expect(r.status, r.label).toBe(403);
  });
});
