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

import { customFieldsRoutes } from './custom-fields';
import { chatDmRoutes } from './chat-dm';
import type { Env, Variables } from '../types';

type RouteCase = AuthGateCase<Env, Variables>;

const cases: RouteCase[] = [
  // (projects, tasks and milestones moved to flow-api, mail-messages to
  // mail-api; their cases live in those workers' _sweeps.test.ts.)
  // custom-fields updates via PUT /:id (not PATCH), gated on settings:manage.
  { mount: '/api/custom-fields', router: customFieldsRoutes, prefix: 'settings', skipPatch: true },
  // WeldChat DM: GET / + POST / under messages:*; no PATCH/DELETE /:id
  // (the only /:id route is a read-only get-or-create resolver).
  { mount: '/api/chat-dm', router: chatDmRoutes, prefix: 'messages', skipPatch: true, skipDelete: true },
];

describe.each(cases)('$mount · auth gates', (c) => {
  it('refuses every standard CRUD call without its permission', async () => {
    for (const r of await authGateStatuses(c)) expect(r.status, r.label).toBe(403);
  });
});
