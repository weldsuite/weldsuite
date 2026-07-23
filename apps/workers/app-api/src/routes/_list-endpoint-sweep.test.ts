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
import type { Hono } from 'hono';
import { createTestApp, permissions } from '../test/harness';
import { createPgliteDb } from '../test/pglite';
import type { Database, } from '../db';
import type { Env, Variables } from '../types';

import { companiesRoutes } from './companies';
import { peopleRoutes } from './people';
import { activitiesRoutes } from './activities';
import { leadsRoutes } from './leads';
import { tasksRoutes } from './tasks';
import { ticketsRoutes } from './tickets';
import { invoicesRoutes } from './invoices';
import { productsRoutes } from './products';
import { pipelinesRoutes } from './pipelines';
import { pipelineStagesRoutes } from './pipeline-stages';
import { warehouseLocationsRoutes } from './warehouse-locations';
import { warehousesRoutes } from './warehouses';
import { warehouseZonesRoutes } from './warehouse-zones';
import { customFieldsRoutes } from './custom-fields';
import { enrichFieldsRoutes } from './enrich-fields';
import { myTasksRoutes } from './my-tasks';
import { wmsSuppliersRoutes } from './wms-suppliers';
import { stockAdjustmentsRoutes } from './stock-adjustments';
import { conversationsRoutes } from './conversations';
import { meetingsRoutes } from './meetings';
import { workflowsRoutes } from './workflows';
import { ordersRoutes } from './orders';
import { categoriesRoutes } from './categories';
import { billsRoutes } from './bills';
import { listsRoutes } from './lists';
import { opportunitiesRoutes } from './opportunities';
import { meetingBotSessionsRoutes } from './meeting-bot-sessions';
import { customerStatusesRoutes } from './customer-statuses';
import { crmAnalyticsRoutes } from './crm-analytics';
import { helpdeskContactsRoutes } from './helpdesk-contacts';
import { helpdeskAnalyticsRoutes } from './helpdesk-analytics';
import { chatDmRoutes } from './chat-dm';
import { chatStatusRoutes } from './chat-status';
import { chatActivityRoutes } from './chat-activity';

interface SweepCase {
  mount: string;
  router: Hono<{ Bindings: Env; Variables: Variables }>;
  /** Permission to grant for the GET. Defaults to `<plural>:read`. */
  permission?: string;
}

const cases: SweepCase[] = [
  { mount: '/api/companies', router: companiesRoutes, permission: 'companies:read' },
  { mount: '/api/people', router: peopleRoutes, permission: 'people:read' },
  { mount: '/api/activities', router: activitiesRoutes, permission: 'activities:read' },
  { mount: '/api/leads', router: leadsRoutes, permission: 'leads:read' },
  { mount: '/api/tasks', router: tasksRoutes, permission: 'tasks:read' },
  { mount: '/api/tickets', router: ticketsRoutes, permission: 'tickets:read' },
  { mount: '/api/invoices', router: invoicesRoutes, permission: 'invoices:read' },
  { mount: '/api/products', router: productsRoutes, permission: 'products:read' },
  { mount: '/api/pipelines', router: pipelinesRoutes, permission: 'pipelines:read' },
  { mount: '/api/pipeline-stages', router: pipelineStagesRoutes, permission: 'pipelines:read' },
  { mount: '/api/warehouse-locations', router: warehouseLocationsRoutes, permission: 'locations:read' },
  { mount: '/api/warehouses', router: warehousesRoutes, permission: 'warehouses:read' },
  { mount: '/api/warehouse-zones', router: warehouseZonesRoutes, permission: 'warehouses:read' },
  { mount: '/api/custom-fields', router: customFieldsRoutes, permission: 'settings:read' },
  { mount: '/api/enrich-fields', router: enrichFieldsRoutes, permission: 'settings:read' },
  { mount: '/api/my-tasks', router: myTasksRoutes, permission: 'tasks:read' },
  { mount: '/api/wms-suppliers', router: wmsSuppliersRoutes, permission: 'suppliers:read' },
  { mount: '/api/stock-adjustments', router: stockAdjustmentsRoutes, permission: 'inventory:read' },
  { mount: '/api/conversations', router: conversationsRoutes, permission: 'conversations:read' },
  { mount: '/api/meetings', router: meetingsRoutes, permission: 'meetings:read' },
  { mount: '/api/workflows', router: workflowsRoutes, permission: 'tasks:read' },
  { mount: '/api/orders', router: ordersRoutes, permission: 'orders:read' },
  { mount: '/api/categories', router: categoriesRoutes, permission: 'categories:read' },
  { mount: '/api/bills', router: billsRoutes, permission: 'bills:read' },
  { mount: '/api/lists', router: listsRoutes, permission: 'companies:read' },
  { mount: '/api/opportunities', router: opportunitiesRoutes, permission: 'opportunities:read' },
  { mount: '/api/meeting-bot-sessions', router: meetingBotSessionsRoutes, permission: 'activities:read' },
  { mount: '/api/customer-statuses', router: customerStatusesRoutes, permission: 'customers:read' },
  { mount: '/api/crm-analytics', router: crmAnalyticsRoutes, permission: 'contacts:read' },
  { mount: '/api/helpdesk-contacts', router: helpdeskContactsRoutes, permission: 'conversations:read' },
  { mount: '/api/helpdesk-analytics', router: helpdeskAnalyticsRoutes, permission: 'settings:read' },
  // WeldChat — GET / returns a plain list (no cursor pagination) against an empty tenant.
  { mount: '/api/chat-dm', router: chatDmRoutes, permission: 'messages:read' },
  { mount: '/api/chat-status', router: chatStatusRoutes, permission: 'settings:read' },
  { mount: '/api/chat-activity', router: chatActivityRoutes, permission: 'messages:read' },
  // pickers: omitted from sweep until the warehouse_workers migration is generated + applied.
];

let db: Database;

beforeAll(async () => {
  const handle = await createPgliteDb();
  db = handle.db;
}, 60_000);

describe.each(cases)('$mount · GET / (list endpoint sweep)', (c) => {
  it('returns 200 against an empty tenant', async () => {
    const { request } = createTestApp(c.mount, c.router, {
      context: {
        permissions: permissions(c.permission!),
        tenantDb: db,
      },
    });
    const res = await request(c.mount);
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      data: unknown[];
      pagination?: { totalCount: number; hasMore: boolean; cursor: string | null };
    };
    expect(Array.isArray(body.data)).toBe(true);
    if (body.pagination) {
      expect(typeof body.pagination.totalCount).toBe('number');
      expect(typeof body.pagination.hasMore).toBe('boolean');
    }
  });
});
