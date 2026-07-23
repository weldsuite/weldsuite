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
import type { Hono } from 'hono';
import { createTestApp, permissions } from '../test/harness';

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
import { warehouseLocationsRoutes } from './warehouse-locations';
import { warehousesRoutes } from './warehouses';
import { warehouseZonesRoutes } from './warehouse-zones';
import { customFieldsRoutes } from './custom-fields';
import { enrichFieldsRoutes } from './enrich-fields';
import { wmsSuppliersRoutes } from './wms-suppliers';
import { pickersRoutes } from './pickers';
import { stockAdjustmentsRoutes } from './stock-adjustments';
import { milestonesRoutes } from './milestones';
import { boxesRoutes } from './boxes';
import { parcelsRoutes } from './parcels';
import { pickupsRoutes } from './pickups';
import { returnsRoutes } from './returns';
import { carriersRoutes } from './carriers';
import { meetingBotSessionsRoutes } from './meeting-bot-sessions';
import { customerStatusesRoutes } from './customer-statuses';
import { crmAnalyticsRoutes } from './crm-analytics';
import { helpdeskContactsRoutes } from './helpdesk-contacts';
import { helpdeskAnalyticsRoutes } from './helpdesk-analytics';
import { pipelineFieldVisibilityRoutes } from './pipeline-field-visibility';
import { chatDmRoutes } from './chat-dm';
import type { Env, Variables } from '../types';

interface RouteCase {
  /** Mount path, e.g. `/api/orders`. */
  mount: string;
  /** Router under test. */
  router: Hono<{ Bindings: Env; Variables: Variables }>;
  /**
   * Permission prefix. Most entities follow `<plural>:<action>` —
   * `orders:read`, `orders:create`, etc. Some use a different prefix
   * (mail-messages uses `messages:*`, bills uses `bills:*`).
   */
  prefix: string;
  /**
   * Some routes don't actually have a top-level GET / (e.g. they're
   * nested under another resource). Skip the GET assertion when set.
   */
  skipGet?: boolean;
  /** A few routes lack PATCH or DELETE — opt out per case. */
  skipPatch?: boolean;
  skipDelete?: boolean;
}

const cases: RouteCase[] = [
  { mount: '/api/orders', router: ordersRoutes, prefix: 'orders' },
  { mount: '/api/projects', router: projectsRoutes, prefix: 'projects' },
  { mount: '/api/tasks', router: tasksRoutes, prefix: 'tasks' },
  { mount: '/api/opportunities', router: opportunitiesRoutes, prefix: 'opportunities' },
  { mount: '/api/leads', router: leadsRoutes, prefix: 'leads' },
  { mount: '/api/conversations', router: conversationsRoutes, prefix: 'conversations' },
  { mount: '/api/mail-messages', router: mailMessagesRoutes, prefix: 'messages' },
  { mount: '/api/bills', router: billsRoutes, prefix: 'bills' },
  { mount: '/api/meetings', router: meetingsRoutes, prefix: 'meetings' },
  { mount: '/api/activities', router: activitiesRoutes, prefix: 'activities' },
  { mount: '/api/pipelines', router: pipelinesRoutes, prefix: 'pipelines' },
  { mount: '/api/categories', router: categoriesRoutes, prefix: 'categories' },
  { mount: '/api/slas', router: slasRoutes, prefix: 'slas' },
  { mount: '/api/warehouse-locations', router: warehouseLocationsRoutes, prefix: 'locations' },
  { mount: '/api/warehouses', router: warehousesRoutes, prefix: 'warehouses' },
  { mount: '/api/warehouse-zones', router: warehouseZonesRoutes, prefix: 'warehouses' },
  { mount: '/api/custom-fields', router: customFieldsRoutes, prefix: 'settings' },
  { mount: '/api/enrich-fields', router: enrichFieldsRoutes, prefix: 'settings' },
  { mount: '/api/wms-suppliers', router: wmsSuppliersRoutes, prefix: 'suppliers' },
  // stock-adjustments is append-only: no PATCH /:id or DELETE /:id
  { mount: '/api/stock-adjustments', router: stockAdjustmentsRoutes, prefix: 'inventory', skipPatch: true, skipDelete: true },
  { mount: '/api/milestones', router: milestonesRoutes, prefix: 'milestones' },
  { mount: '/api/boxes', router: boxesRoutes, prefix: 'boxes' },
  { mount: '/api/parcels', router: parcelsRoutes, prefix: 'parcels' },
  { mount: '/api/pickups', router: pickupsRoutes, prefix: 'pickups' },
  { mount: '/api/returns', router: returnsRoutes, prefix: 'returns' },
  { mount: '/api/carriers', router: carriersRoutes, prefix: 'carriers' },
  { mount: '/api/meeting-bot-sessions', router: meetingBotSessionsRoutes, prefix: 'activities' },
  // customer-statuses uses customers:read for read, settings:manage for create/update/delete
  { mount: '/api/customer-statuses', router: customerStatusesRoutes, prefix: 'settings' },
  // crm-analytics uses contacts:read for all operations
  { mount: '/api/crm-analytics', router: crmAnalyticsRoutes, prefix: 'contacts' },
  // helpdesk-contacts uses conversations:* permissions; no DELETE (contacts owned by CRM)
  { mount: '/api/helpdesk-contacts', router: helpdeskContactsRoutes, prefix: 'conversations', skipDelete: true },
  // helpdesk-analytics uses settings:* permissions; full CRUD at top level
  { mount: '/api/helpdesk-analytics', router: helpdeskAnalyticsRoutes, prefix: 'settings' },
  // pipeline-field-visibility has no top-level GET / (nested under /:id)
  {
    mount: '/api/pipeline-field-visibility',
    router: pipelineFieldVisibilityRoutes,
    prefix: 'pipelines',
    skipGet: true,
    skipPatch: true,
    skipDelete: true,
  },
  // WeldChat DM: GET / + POST / under messages:*; no PATCH/DELETE /:id
  // (the only /:id route is a read-only get-or-create resolver).
  { mount: '/api/chat-dm', router: chatDmRoutes, prefix: 'messages', skipPatch: true, skipDelete: true },
  // pickers: uses PUT /:id (full update) not PATCH /:id; PATCH /:id/status is a sub-action.
  { mount: '/api/pickers', router: pickersRoutes, prefix: 'warehouses', skipPatch: true },
];

describe.each(cases)('$mount · auth gates', (c) => {
  if (!c.skipGet) {
    it(`GET ${c.mount} returns 403 without ${c.prefix}:read`, async () => {
      const { request } = createTestApp(c.mount, c.router, {
        context: { permissions: permissions() },
      });
      const res = await request(c.mount);
      expect(res.status).toBe(403);
    });
  }

  it(`POST ${c.mount} returns 403 without ${c.prefix}:create`, async () => {
    const { request } = createTestApp(c.mount, c.router, {
      context: { permissions: permissions(`${c.prefix}:read`) },
    });
    const res = await request(c.mount, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(403);
  });

  if (!c.skipPatch) {
    it(`PATCH ${c.mount}/:id returns 403 without ${c.prefix}:update`, async () => {
      const { request } = createTestApp(c.mount, c.router, {
        context: { permissions: permissions(`${c.prefix}:read`) },
      });
      const res = await request(`${c.mount}/some_id`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(403);
    });
  }

  if (!c.skipDelete) {
    it(`DELETE ${c.mount}/:id returns 403 without ${c.prefix}:delete`, async () => {
      const { request } = createTestApp(c.mount, c.router, {
        context: { permissions: permissions(`${c.prefix}:read`) },
      });
      const res = await request(`${c.mount}/some_id`, { method: 'DELETE' });
      expect(res.status).toBe(403);
    });
  }
});
