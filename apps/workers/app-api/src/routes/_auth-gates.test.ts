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

import { projectsRoutes } from './projects';
import { tasksRoutes } from './tasks';
import { mailMessagesRoutes } from './mail-messages';
import { customFieldsRoutes } from './custom-fields';
import { milestonesRoutes } from './milestones';
import { chatDmRoutes } from './chat-dm';
import type { Env, Variables } from '../types';

type RouteCase = AuthGateCase<Env, Variables>;

const cases: RouteCase[] = [
  // projects GET / is deliberately membership-filtered (scope-based), not
  // hard-blocked by requirePermission — see the note at the top of projects/index.ts.
  { mount: '/api/projects', router: projectsRoutes, prefix: 'projects', skipGet: true },
  { mount: '/api/tasks', router: tasksRoutes, prefix: 'tasks' },
  // mail-messages has no POST / create — messages arrive via the inbound worker,
  // not a create endpoint. PATCH/DELETE /:id are gated normally.
  { mount: '/api/mail-messages', router: mailMessagesRoutes, prefix: 'messages', skipPost: true },
  // custom-fields updates via PUT /:id (not PATCH), gated on settings:manage.
  { mount: '/api/custom-fields', router: customFieldsRoutes, prefix: 'settings', skipPatch: true },
  { mount: '/api/milestones', router: milestonesRoutes, prefix: 'milestones' },
  // WeldChat DM: GET / + POST / under messages:*; no PATCH/DELETE /:id
  // (the only /:id route is a read-only get-or-create resolver).
  { mount: '/api/chat-dm', router: chatDmRoutes, prefix: 'messages', skipPatch: true, skipDelete: true },
];

describe.each(cases)('$mount · auth gates', (c) => {
  it('refuses every standard CRUD call without its permission', async () => {
    for (const r of await authGateStatuses(c)) expect(r.status, r.label).toBe(403);
  });
});
