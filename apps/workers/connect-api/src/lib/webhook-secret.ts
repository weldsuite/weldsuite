/** Shared inbound-HMAC secret generator for `workflow_webhooks` rows. */

import { ALPHANUMERIC, randomString } from '@weldsuite/worker-kit/random';

export function generateWebhookSecret(): string {
  return randomString(32, ALPHANUMERIC);
}
