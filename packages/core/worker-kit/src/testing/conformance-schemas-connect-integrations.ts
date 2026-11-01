/**
 * connect-api's integration routes (outbound external webhooks, integration
 * connections, store and accounting connectors) response schemas. Spread
 * into ROUTES by conformance-schemas.ts.
 */
import {
  externalWebhookEventSchema,
  externalWebhookSchema,
  externalWebhookWithSecretSchema,
  webhookDeliverySchema,
  webhookTestResultSchema,
} from '@weldsuite/app-api-client/schemas/connect-integrations-responses';
import type { RouteSchema } from './conformance-schemas';

const EW = '/api/external-webhooks';

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
];
