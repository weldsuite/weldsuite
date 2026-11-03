import { z } from 'zod';

// ============================================================================
// The integration workers' public webhook receivers
// (apps/workers/integration-webhook-worker): what each answers a provider.
// The conformance suite validates both backends' answers against them. Zod v3.
// ============================================================================

/** `POST /webhooks/bank-feeds/:provider`: a verified delivery. */
export const bankFeedWebhookAckSchema = z.object({
  received: z.literal(true),
  events: z.number().int().nonnegative(),
});

/** `POST /webhooks/github`: a delivery taken (handled in the background) or ignored. */
export const githubWebhookAckSchema = z.object({
  received: z.literal(true),
});

/** `POST /webhook/:connectionId` (Attio and the other CRM providers): the events of a verified delivery, processed. */
export const crmWebhookAckSchema = z.object({
  status: z.literal('ok'),
  processed: z.number().int().nonnegative(),
});

/** `POST /webhook/hubspot`: the events of a verified HubSpot delivery that were applied. */
export const hubspotWebhookAckSchema = z.object({
  received: z.literal(true),
  processed: z.number().int().nonnegative(),
});

/** `POST /webhook/gcal/:connectionId`: a Google Calendar push notification, acknowledged. */
export const googleCalendarWebhookAckSchema = z.object({
  status: z.literal('ok'),
  type: z.enum(['sync_handshake', 'sync_triggered']),
});
