/** The integration workers' webhook receivers (integration-webhook-worker). Spread into ROUTES by conformance-schemas.ts. */
import {
  bankFeedWebhookAckSchema,
  crmWebhookAckSchema,
  githubWebhookAckSchema,
  googleCalendarWebhookAckSchema,
  hubspotWebhookAckSchema,
  metaAdsWebhookAckSchema,
  slackWebhookAckSchema,
  workflowGithubWebhookAckSchema,
} from '@weldsuite/app-api-client/schemas/integration-webhooks';
import type { RouteSchema } from './conformance-schemas';

export const INTEGRATION_WEBHOOK_ROUTES: RouteSchema[] = [
  { method: 'POST', route: '/webhooks/bank-feeds/:provider', envelope: 'body', data: bankFeedWebhookAckSchema },
  { method: 'POST', route: '/webhooks/github', envelope: 'body', data: githubWebhookAckSchema },
  { method: 'POST', route: '/webhook/hubspot', envelope: 'body', data: hubspotWebhookAckSchema },
  { method: 'POST', route: '/webhook/gcal/:connectionId', envelope: 'body', data: googleCalendarWebhookAckSchema },
  { method: 'POST', route: '/webhook/:connectionId', envelope: 'body', data: crmWebhookAckSchema },
  { method: 'POST', route: '/webhooks/meta/ads', envelope: 'body', data: metaAdsWebhookAckSchema },
  { method: 'POST', route: '/integration-webhook/slack', envelope: 'body', data: slackWebhookAckSchema },
  { method: 'POST', route: '/integration-webhook/github/:connectionId', envelope: 'body', data: workflowGithubWebhookAckSchema },
];
