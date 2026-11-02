/** The integration workers' webhook receivers (integration-webhook-worker). Spread into ROUTES by conformance-schemas.ts. */
import { bankFeedWebhookAckSchema } from '@weldsuite/app-api-client/schemas/integration-webhooks';
import type { RouteSchema } from './conformance-schemas';

export const INTEGRATION_WEBHOOK_ROUTES: RouteSchema[] = [
  { method: 'POST', route: '/webhooks/bank-feeds/:provider', envelope: 'body', data: bankFeedWebhookAckSchema },
];
