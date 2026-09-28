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

import { companiesRoutes } from './companies';
import { peopleRoutes } from './people';
import { activitiesRoutes } from './activities';
import { leadsRoutes } from './leads';
import { tasksRoutes } from './tasks';
import { ticketsRoutes } from './tickets';
import { invoicesRoutes } from './invoices';
import { pipelinesRoutes } from './pipelines';
import { pipelineStagesRoutes } from './pipeline-stages';
import { customFieldsRoutes } from './custom-fields';
import { enrichFieldsRoutes } from './enrich-fields';
import { myTasksRoutes } from './my-tasks';
import { conversationsRoutes } from './conversations';
import { meetingsRoutes } from './meetings';
import { workflowsRoutes } from './workflows';
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
import { deskConversationsRoutes } from './desk-conversations';
import { deskWidgetRoutes } from './desk-widget';

type SweepCase = ListSweepCase<Env, Variables>;

const cases: SweepCase[] = [
  { mount: '/api/companies', router: companiesRoutes, permission: 'companies:read' },
  { mount: '/api/people', router: peopleRoutes, permission: 'people:read' },
  { mount: '/api/activities', router: activitiesRoutes, permission: 'activities:read' },
  { mount: '/api/leads', router: leadsRoutes, permission: 'leads:read' },
  { mount: '/api/tasks', router: tasksRoutes, permission: 'tasks:read' },
  { mount: '/api/tickets', router: ticketsRoutes, permission: 'tickets:read' },
  { mount: '/api/invoices', router: invoicesRoutes, permission: 'invoices:read' },
  { mount: '/api/pipelines', router: pipelinesRoutes, permission: 'pipelines:read' },
  { mount: '/api/pipeline-stages', router: pipelineStagesRoutes, permission: 'pipelines:read' },
  { mount: '/api/custom-fields', router: customFieldsRoutes, permission: 'settings:read' },
  { mount: '/api/enrich-fields', router: enrichFieldsRoutes, permission: 'settings:read' },
  { mount: '/api/my-tasks', router: myTasksRoutes, permission: 'tasks:read' },
  { mount: '/api/conversations', router: conversationsRoutes, permission: 'conversations:read' },
  { mount: '/api/meetings', router: meetingsRoutes, permission: 'meetings:read' },
  { mount: '/api/workflows', router: workflowsRoutes, permission: 'workflows:read' },
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
  { mount: '/api/desk/conversations', router: deskConversationsRoutes, permission: 'conversations:read' },
  { mount: '/api/desk/widget', router: deskWidgetRoutes, permission: 'settings:read' },
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
