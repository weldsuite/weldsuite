/** WeldConnect's internal action routes (connect-api). Spread into ROUTES by conformance-schemas.ts. */
import {
  workflowActionActivitySchema,
  workflowActionChatMessageSchema,
  workflowActionContactSchema,
  workflowActionCustomerSchema,
  workflowActionDealSchema,
  workflowActionDealStageSchema,
  workflowActionLeadSchema,
  workflowActionTaskSchema,
} from '@weldsuite/app-api-client/schemas/weldconnect-workflow-actions';
import type { RouteSchema } from './conformance-schemas';

const WA = '/api/internal/workflow-actions';

export const CONNECT_ACTION_ROUTES: RouteSchema[] = [
  { method: 'POST', route: `${WA}/create-customer`, envelope: 'body', data: workflowActionCustomerSchema },
  { method: 'POST', route: `${WA}/create-contact`, envelope: 'body', data: workflowActionContactSchema },
  { method: 'POST', route: `${WA}/update-contact`, envelope: 'body', data: workflowActionContactSchema },
  { method: 'POST', route: `${WA}/create-lead`, envelope: 'body', data: workflowActionLeadSchema },
  { method: 'POST', route: `${WA}/create-deal`, envelope: 'body', data: workflowActionDealSchema },
  { method: 'POST', route: `${WA}/move-deal-stage`, envelope: 'body', data: workflowActionDealStageSchema },
  { method: 'POST', route: `${WA}/log-activity`, envelope: 'body', data: workflowActionActivitySchema },
  { method: 'POST', route: `${WA}/post-chat-message`, envelope: 'body', data: workflowActionChatMessageSchema },
  { method: 'POST', route: `${WA}/create-task`, envelope: 'body', data: workflowActionTaskSchema },
];
