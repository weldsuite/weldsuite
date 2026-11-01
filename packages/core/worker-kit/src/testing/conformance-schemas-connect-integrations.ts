/**
 * connect-api's integration routes (outbound external webhooks, integration
 * connections, store and accounting connectors) response schemas. Spread
 * into ROUTES by conformance-schemas.ts.
 */
import {
  adEventResultSchema,
  adSyncResultSchema,
  externalWebhookEventSchema,
  externalWebhookSchema,
  externalWebhookWithSecretSchema,
  integrationAuthorizeSchema,
  integrationConnectedSchema,
  integrationConnectionDetailSchema,
  integrationConnectionRowSchema,
  integrationConnectionSchema,
  integrationDefaultMappingSchema,
  integrationEntityMappingSchema,
  integrationFieldMappingSchema,
  integrationIdSchema,
  integrationMappingsReplacedSchema,
  integrationMessageSchema,
  integrationResolvedSchema,
  integrationSyncConflictSchema,
  integrationTestSchema,
  integrationUpdatedSchema,
  mcpToolsSchema,
  syncLogSchema,
  webhookDeliverySchema,
  webhookTestResultSchema,
} from '@weldsuite/app-api-client/schemas/connect-integrations-responses';
import type { RouteSchema } from './conformance-schemas';

const EW = '/api/external-webhooks';
const IN = '/api/integrations';
const CO = '/api/integrations/connections';

export const CONNECT_INTEGRATION_ROUTES: RouteSchema[] = [
  // outbound webhooks
  { method: 'GET', route: `${EW}/events`, envelope: 'array', data: externalWebhookEventSchema },
  { method: 'GET', route: EW, envelope: 'list', data: externalWebhookSchema },
  { method: 'POST', route: EW, envelope: 'single', data: externalWebhookWithSecretSchema },
  { method: 'GET', route: `${EW}/:id`, envelope: 'single', data: externalWebhookSchema },
  { method: 'PATCH', route: `${EW}/:id`, envelope: 'single', data: externalWebhookSchema },
  { method: 'GET', route: `${EW}/:id/deliveries`, envelope: 'list', data: webhookDeliverySchema },
  { method: 'POST', route: `${EW}/:id/rotate-secret`, envelope: 'single', data: externalWebhookWithSecretSchema },
  { method: 'POST', route: `${EW}/:id/test`, envelope: 'single', data: webhookTestResultSchema },
  // integration connections
  { method: 'GET', route: IN, envelope: 'list', data: integrationConnectionRowSchema },
  { method: 'POST', route: IN, envelope: 'single', data: integrationIdSchema },
  { method: 'GET', route: `${IN}/:id`, envelope: 'single', data: integrationConnectionRowSchema },
  { method: 'PATCH', route: `${IN}/:id`, envelope: 'single', data: integrationIdSchema },
  { method: 'GET', route: CO, envelope: 'array', data: integrationConnectionSchema },
  { method: 'POST', route: CO, envelope: 'single', data: integrationConnectedSchema },
  { method: 'POST', route: `${CO}/attio/authorize`, envelope: 'single', data: integrationAuthorizeSchema },
  { method: 'POST', route: `${CO}/attio/callback`, envelope: 'single', data: integrationConnectedSchema },
  { method: 'POST', route: `${CO}/:provider/authorize`, envelope: 'single', data: integrationAuthorizeSchema },
  { method: 'POST', route: `${CO}/:provider/callback`, envelope: 'single', data: integrationConnectedSchema },
  { method: 'GET', route: `${CO}/:id`, envelope: 'single', data: integrationConnectionDetailSchema },
  { method: 'PATCH', route: `${CO}/:id`, envelope: 'single', data: integrationUpdatedSchema },
  { method: 'POST', route: `${CO}/:id/discover-tools`, envelope: 'single', data: mcpToolsSchema },
  { method: 'POST', route: `${CO}/:id/test`, envelope: 'single', data: integrationTestSchema },
  { method: 'POST', route: `${CO}/:id/sync`, envelope: 'single', data: integrationMessageSchema },
  { method: 'POST', route: `${CO}/:id/renew-watch`, envelope: 'single', data: integrationMessageSchema },
  { method: 'GET', route: `${CO}/:id/logs`, envelope: 'array', data: syncLogSchema },
  { method: 'GET', route: `${CO}/:id/field-mappings`, envelope: 'array', data: integrationFieldMappingSchema },
  { method: 'PUT', route: `${CO}/:id/field-mappings`, envelope: 'single', data: integrationMappingsReplacedSchema },
  {
    method: 'GET',
    route: `${CO}/:id/field-mappings/defaults`,
    envelope: 'array',
    data: integrationDefaultMappingSchema,
  },
  { method: 'GET', route: `${CO}/:id/conflicts`, envelope: 'array', data: integrationSyncConflictSchema },
  {
    method: 'POST',
    route: `${CO}/:id/conflicts/:conflictId/resolve`,
    envelope: 'single',
    data: integrationResolvedSchema,
  },
  { method: 'POST', route: `${CO}/:id/conflicts/resolve-all`, envelope: 'single', data: integrationResolvedSchema },
  { method: 'GET', route: `${IN}/entity-mappings`, envelope: 'array', data: integrationEntityMappingSchema },
  // the internal (X-Internal-Secret) routes
  { method: 'POST', route: `${IN}/ad-connections/:id/sync`, envelope: 'single', data: adSyncResultSchema },
  { method: 'POST', route: `${IN}/ad-events`, envelope: 'single', data: adEventResultSchema },
];
