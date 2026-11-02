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
