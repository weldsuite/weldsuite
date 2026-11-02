/** WeldDesk (desk-api) response schemas: agents, departments, contacts, WeldAgent conversations, workflows. Spread into ROUTES by conformance-schemas.ts. */
import { deskIdRefSchema } from '@weldsuite/core-api-client/schemas/desk-common';
import { helpdeskAgentSchema } from '@weldsuite/core-api-client/schemas/helpdesk-agents';
import {
  helpdeskDepartmentInboxCountSchema,
  helpdeskDepartmentListItemSchema,
  helpdeskDepartmentSchema,
} from '@weldsuite/core-api-client/schemas/helpdesk-departments';
import {
  helpdeskContactListItemSchema,
  helpdeskContactSchema,
  helpdeskContactSearchResultSchema,
} from '@weldsuite/core-api-client/schemas/helpdesk-contacts';
import {
  weldagentAcceptedSchema,
  weldagentConversationCreatedSchema,
  weldagentConversationDetailSchema,
  weldagentConversationPageSchema,
  weldagentConversationRowSchema,
  weldagentConvertedTicketSchema,
  weldagentMessageCreatedSchema,
  weldagentTransferredSchema,
} from '@weldsuite/core-api-client/schemas/helpdesk-weldagent';
import {
  helpdeskWorkflowChainTargetSchema,
  helpdeskWorkflowResetResultSchema,
  helpdeskWorkflowResumeResultSchema,
  helpdeskWorkflowSchema,
  helpdeskWorkflowSeedResultSchema,
  helpdeskWorkflowStatsSchema,
  helpdeskWorkflowStatusResultSchema,
} from '@weldsuite/core-api-client/schemas/helpdesk-workflows';
import type { RouteSchema } from './conformance-schemas';

const AGENTS = '/api/helpdesk-agents';
const DEPARTMENTS = '/api/helpdesk-departments';
const CONTACTS = '/api/helpdesk-contacts';
const WELDAGENT = '/api/helpdesk-weldagent/conversations';
const WORKFLOWS = '/api/helpdesk-workflows';

// Deletes answer 204; GET/POST /api/helpdesk-weldagent/config answer 503 with no data.
export const DESK_TEAM_ROUTES: RouteSchema[] = [
  // agents
  { method: 'GET', route: AGENTS, envelope: 'list', data: helpdeskAgentSchema },
  { method: 'GET', route: `${AGENTS}/:id`, envelope: 'single', data: helpdeskAgentSchema },
  { method: 'POST', route: AGENTS, envelope: 'single', data: deskIdRefSchema },
  { method: 'PATCH', route: `${AGENTS}/:id`, envelope: 'single', data: deskIdRefSchema },

  // departments
  { method: 'GET', route: DEPARTMENTS, envelope: 'list', data: helpdeskDepartmentListItemSchema },
  { method: 'GET', route: `${DEPARTMENTS}/inbox-counts`, envelope: 'array', data: helpdeskDepartmentInboxCountSchema },
  { method: 'GET', route: `${DEPARTMENTS}/:id`, envelope: 'single', data: helpdeskDepartmentSchema },
  { method: 'POST', route: DEPARTMENTS, envelope: 'single', data: deskIdRefSchema },
  { method: 'PATCH', route: `${DEPARTMENTS}/:id`, envelope: 'single', data: deskIdRefSchema },

  // contacts (the `people` table)
  { method: 'GET', route: CONTACTS, envelope: 'list', data: helpdeskContactListItemSchema },
  { method: 'GET', route: `${CONTACTS}/search`, envelope: 'array', data: helpdeskContactSearchResultSchema },
  { method: 'GET', route: `${CONTACTS}/:id`, envelope: 'single', data: helpdeskContactSchema },
  { method: 'POST', route: CONTACTS, envelope: 'single', data: deskIdRefSchema },
  { method: 'PATCH', route: `${CONTACTS}/:id`, envelope: 'single', data: deskIdRefSchema },

  // WeldAgent conversation records
  { method: 'POST', route: WELDAGENT, envelope: 'single', data: weldagentConversationCreatedSchema },
  { method: 'GET', route: `${WELDAGENT}/ai-active`, envelope: 'single', data: weldagentConversationPageSchema },
  { method: 'GET', route: `${WELDAGENT}/ai-resolved`, envelope: 'single', data: weldagentConversationPageSchema },
  { method: 'GET', route: `${WELDAGENT}/pending`, envelope: 'array', data: weldagentConversationRowSchema },
  { method: 'GET', route: `${WELDAGENT}/:id`, envelope: 'single', data: weldagentConversationDetailSchema },
  { method: 'POST', route: `${WELDAGENT}/:id/messages`, envelope: 'single', data: weldagentMessageCreatedSchema },
  { method: 'POST', route: `${WELDAGENT}/:id/transfer-to-human`, envelope: 'single', data: weldagentTransferredSchema },
  { method: 'POST', route: `${WELDAGENT}/:id/accept`, envelope: 'single', data: weldagentAcceptedSchema },
  { method: 'POST', route: `${WELDAGENT}/:id/convert-to-ticket`, envelope: 'single', data: weldagentConvertedTicketSchema },

  // workflows
  { method: 'GET', route: WORKFLOWS, envelope: 'list', data: helpdeskWorkflowSchema },
  { method: 'GET', route: `${WORKFLOWS}/stats`, envelope: 'single', data: helpdeskWorkflowStatsSchema },
  { method: 'GET', route: `${WORKFLOWS}/for-chaining`, envelope: 'array', data: helpdeskWorkflowChainTargetSchema },
  { method: 'GET', route: `${WORKFLOWS}/:id`, envelope: 'single', data: helpdeskWorkflowSchema },
  { method: 'POST', route: WORKFLOWS, envelope: 'single', data: deskIdRefSchema },
  { method: 'PATCH', route: `${WORKFLOWS}/:id`, envelope: 'single', data: deskIdRefSchema },
  { method: 'PATCH', route: `${WORKFLOWS}/:id/status`, envelope: 'single', data: helpdeskWorkflowStatusResultSchema },
  { method: 'POST', route: `${WORKFLOWS}/:id/duplicate`, envelope: 'single', data: helpdeskWorkflowSchema },
  { method: 'POST', route: `${WORKFLOWS}/seed-defaults`, envelope: 'single', data: helpdeskWorkflowSeedResultSchema },
  { method: 'POST', route: `${WORKFLOWS}/reset-defaults`, envelope: 'single', data: helpdeskWorkflowResetResultSchema },
  {
    method: 'POST',
    route: `${WORKFLOWS}/executions/:executionId/resume`,
    envelope: 'single',
    data: helpdeskWorkflowResumeResultSchema,
  },
];
