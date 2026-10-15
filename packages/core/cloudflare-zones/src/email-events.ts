/**
 * Cloudflare Email Sending events → a Queue, one Queues event subscription per
 * sending domain (Cloudflare scopes these per domain). WeldMail's outbound
 * guard consumes them for bounce and complaint rates and suppressions
 * (docs/plans/weldmail-outbound-abuse.md).
 *
 * Official SDK, tree-shakable client with only the subscriptions resource.
 * SDK 7.0.0 predates the Email Sending event source, so its `source` union
 * doesn't list it yet: the one cast below is the only deviation from the typed
 * API. Remove it once the SDK knows `email.sending`.
 */

import { createClient } from 'cloudflare/tree-shakable';
import { BaseSubscriptions } from 'cloudflare/resources/queues/subscriptions';
import type { SubscriptionCreateParams } from 'cloudflare/resources/queues/subscriptions';

/** Every lifecycle event Email Sending publishes; the consumer decides what it uses. */
export const EMAIL_SENDING_EVENTS = [
  'message.delivered',
  'message.deferred',
  'message.bounced',
  'message.failed',
  'message.rejected',
  'message.complained',
] as const;

export interface EmailEventsSubscriptionInput {
  apiToken: string;
  accountId: string;
  /** Destination queue id (not its name). */
  queueId: string;
  zoneId: string;
  /** The sending domain: the zone apex or a verified sending subdomain. */
  domain: string;
}

function client(apiToken: string) {
  return createClient({ apiToken, maxRetries: 2, timeout: 15_000, resources: [BaseSubscriptions] });
}

/** Stable subscription name per domain, so a retry finds the existing one. */
export function emailEventsSubscriptionName(domain: string): string {
  return `weldmail-sending-${domain.toLowerCase()}`.slice(0, 120);
}

/**
 * Create the domain's subscription unless one with its name already exists.
 * Returns the subscription id.
 */
export async function ensureEmailSendingEventsSubscription(input: EmailEventsSubscriptionInput): Promise<string | null> {
  const cf = client(input.apiToken);
  const name = emailEventsSubscriptionName(input.domain);
  for await (const existing of cf.queues.subscriptions.list({ account_id: input.accountId })) {
    if (existing.name === name) return existing.id ?? null;
  }
  const source = {
    type: 'email.sending',
    zone_id: input.zoneId,
    domain: input.domain.toLowerCase(),
  } as unknown as SubscriptionCreateParams['source'];
  const created = await cf.queues.subscriptions.create({
    account_id: input.accountId,
    name,
    enabled: true,
    events: [...EMAIL_SENDING_EVENTS],
    destination: { type: 'queues.queue', queue_id: input.queueId },
    source,
  });
  return created.id ?? null;
}

/** Remove the domain's subscription, if any. */
export async function removeEmailSendingEventsSubscription(input: {
  apiToken: string;
  accountId: string;
  domain: string;
}): Promise<void> {
  const cf = client(input.apiToken);
  const name = emailEventsSubscriptionName(input.domain);
  for await (const existing of cf.queues.subscriptions.list({ account_id: input.accountId })) {
    if (existing.name === name && existing.id) {
      await cf.queues.subscriptions.delete(existing.id, { account_id: input.accountId });
    }
  }
}
