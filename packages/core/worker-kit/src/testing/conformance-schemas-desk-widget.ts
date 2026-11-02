/**
 * WeldDesk's public webchat API (helpdesk-widget-api) response schemas. The
 * Rust server serves that worker under `/public/helpdesk-widget`, so each route
 * is keyed by the prefixed route (`createTestApp`'s `rustBasePath`), which keeps
 * them apart from desk-api's own `/api/conversations`. Spread into ROUTES by
 * conformance-schemas.ts.
 *
 * The worker answers in its own envelope, `{ success: true, data }` (not
 * worker-kit's), so the whole body is the schema (`envelope: 'body'`).
 */
import {
  widgetConfigSchema,
  widgetConversationMessageSchema,
  widgetConversationListSchema,
  widgetConversationStartedSchema,
  widgetConversationThreadSchema,
  widgetIdentifiedSchema,
  widgetRealtimeTokenSchema,
  widgetResponseSchema,
  widgetUploadedAttachmentSchema,
} from '@weldsuite/core-api-client/schemas/helpdesk-widget';
import { deskVisitorSessionSchema } from '@weldsuite/app-api-client/schemas/desk-portal';
import type { RouteSchema } from './conformance-schemas';

const WIDGET = '/public/helpdesk-widget';

export const DESK_WIDGET_ROUTES: RouteSchema[] = [
  { method: 'GET', route: `${WIDGET}/api/config`, envelope: 'body', data: widgetResponseSchema(widgetConfigSchema) },
  {
    method: 'POST',
    route: `${WIDGET}/api/visitor`,
    envelope: 'body',
    data: widgetResponseSchema(deskVisitorSessionSchema),
  },
  {
    method: 'POST',
    route: `${WIDGET}/api/conversations/identify`,
    envelope: 'body',
    data: widgetResponseSchema(widgetIdentifiedSchema),
  },
  {
    method: 'GET',
    route: `${WIDGET}/api/conversations`,
    envelope: 'body',
    data: widgetResponseSchema(widgetConversationListSchema),
  },
  {
    method: 'POST',
    route: `${WIDGET}/api/conversations`,
    envelope: 'body',
    data: widgetResponseSchema(widgetConversationStartedSchema),
  },
  {
    method: 'GET',
    route: `${WIDGET}/api/conversations/:id`,
    envelope: 'body',
    data: widgetResponseSchema(widgetConversationThreadSchema),
  },
  {
    method: 'POST',
    route: `${WIDGET}/api/conversations/:id/messages`,
    envelope: 'body',
    data: widgetResponseSchema(widgetConversationMessageSchema),
  },
  {
    method: 'POST',
    route: `${WIDGET}/api/conversations/:id/rating`,
    envelope: 'body',
    data: widgetResponseSchema(widgetConversationMessageSchema),
  },
  {
    method: 'POST',
    route: `${WIDGET}/api/realtime/token`,
    envelope: 'body',
    data: widgetResponseSchema(widgetRealtimeTokenSchema),
  },
  {
    method: 'POST',
    route: `${WIDGET}/api/attachments/upload`,
    envelope: 'body',
    data: widgetResponseSchema(widgetUploadedAttachmentSchema),
  },
];
