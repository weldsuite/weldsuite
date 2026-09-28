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

import { ordersRoutes } from './orders';
import { projectsRoutes } from './projects';
import { tasksRoutes } from './tasks';
import { opportunitiesRoutes } from './opportunities';
import { leadsRoutes } from './leads';
import { conversationsRoutes } from './conversations';
import { mailMessagesRoutes } from './mail-messages';
import { billsRoutes } from './bills';
import { meetingsRoutes } from './meetings';
import { activitiesRoutes } from './activities';
import { pipelinesRoutes } from './pipelines';
import { categoriesRoutes } from './categories';
import { slasRoutes } from './slas';
import { customFieldsRoutes } from './custom-fields';
import { enrichFieldsRoutes } from './enrich-fields';
import { milestonesRoutes } from './milestones';
import { parcelsRoutes } from './parcels';
import { pickupsRoutes } from './pickups';
import { returnsRoutes } from './returns';
import { carriersRoutes } from './carriers';
import { meetingBotSessionsRoutes } from './meeting-bot-sessions';
import { customerStatusesRoutes } from './customer-statuses';
import { crmAnalyticsRoutes } from './crm-analytics';
import { helpdeskContactsRoutes } from './helpdesk-contacts';
import { helpdeskAnalyticsRoutes } from './helpdesk-analytics';
import { chatDmRoutes } from './chat-dm';
import type { Env, Variables } from '../types';

type RouteCase = AuthGateCase<Env, Variables>;

const cases: RouteCase[] = [
  { mount: '/api/orders', router: ordersRoutes, prefix: 'orders' },
  // projects GET / is deliberately membership-filtered (scope-based), not
  // hard-blocked by requirePermission — see the note at the top of projects/index.ts.
  { mount: '/api/projects', router: projectsRoutes, prefix: 'projects', skipGet: true },
  { mount: '/api/tasks', router: tasksRoutes, prefix: 'tasks' },
  { mount: '/api/opportunities', router: opportunitiesRoutes, prefix: 'opportunities' },
  { mount: '/api/leads', router: leadsRoutes, prefix: 'leads' },
  { mount: '/api/conversations', router: conversationsRoutes, prefix: 'conversations' },
  // mail-messages has no POST / create — messages arrive via the inbound worker,
  // not a create endpoint. PATCH/DELETE /:id are gated normally.
  { mount: '/api/mail-messages', router: mailMessagesRoutes, prefix: 'messages', skipPost: true },
  { mount: '/api/bills', router: billsRoutes, prefix: 'bills' },
  { mount: '/api/meetings', router: meetingsRoutes, prefix: 'meetings' },
  { mount: '/api/activities', router: activitiesRoutes, prefix: 'activities' },
  { mount: '/api/pipelines', router: pipelinesRoutes, prefix: 'pipelines' },
  { mount: '/api/categories', router: categoriesRoutes, prefix: 'categories' },
  { mount: '/api/slas', router: slasRoutes, prefix: 'slas' },
  // custom-fields / enrich-fields update via PUT /:id (not PATCH), gated on settings:manage.
  { mount: '/api/custom-fields', router: customFieldsRoutes, prefix: 'settings', skipPatch: true },
  { mount: '/api/enrich-fields', router: enrichFieldsRoutes, prefix: 'settings', skipPatch: true },
  { mount: '/api/milestones', router: milestonesRoutes, prefix: 'milestones' },
  { mount: '/api/parcels', router: parcelsRoutes, prefix: 'parcels' },
  { mount: '/api/pickups', router: pickupsRoutes, prefix: 'pickups' },
  { mount: '/api/returns', router: returnsRoutes, prefix: 'returns' },
  { mount: '/api/carriers', router: carriersRoutes, prefix: 'carriers' },
  { mount: '/api/meeting-bot-sessions', router: meetingBotSessionsRoutes, prefix: 'activities' },
  // customer-statuses uses customers:read for read, settings:manage for create/update/delete
  { mount: '/api/customer-statuses', router: customerStatusesRoutes, prefix: 'settings' },
  // crm-analytics (saved reports/charts) uses contacts:read for ALL operations,
  // so only the GET-without-read gate fits this standard sweep; the mutations
  // don't gate on create/update/delete.
  { mount: '/api/crm-analytics', router: crmAnalyticsRoutes, prefix: 'contacts', skipPost: true, skipPatch: true, skipDelete: true },
  // helpdesk-contacts uses conversations:* permissions; no DELETE (contacts owned by CRM)
  { mount: '/api/helpdesk-contacts', router: helpdeskContactsRoutes, prefix: 'conversations', skipDelete: true },
  // helpdesk-analytics uses settings:* permissions; full CRUD at top level
  { mount: '/api/helpdesk-analytics', router: helpdeskAnalyticsRoutes, prefix: 'settings' },
  // pipeline-field-visibility is intentionally omitted: it is nested under
  // /:id with no standard top-level GET / / POST / or /:id PATCH/DELETE, so no
  // assertion in this standard CRUD sweep applies to it.
  // WeldChat DM: GET / + POST / under messages:*; no PATCH/DELETE /:id
  // (the only /:id route is a read-only get-or-create resolver).
  { mount: '/api/chat-dm', router: chatDmRoutes, prefix: 'messages', skipPatch: true, skipDelete: true },
];

describe.each(cases)('$mount · auth gates', (c) => {
  it('refuses every standard CRUD call without its permission', async () => {
    for (const r of await authGateStatuses(c)) expect(r.status, r.label).toBe(403);
  });
});
