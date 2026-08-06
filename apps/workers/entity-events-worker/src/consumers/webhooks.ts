/**
 * Outbound customer webhooks (`external_webhooks` subscriptions).
 *
 * Was inline sink 5 in the publisher: a tenant-DB read on the write path of
 * every single mutation, whether or not any webhook was subscribed. Here it
 * costs one read per matched batch instead, off the request path entirely.
 *
 * `dispatchWebhookDeliveries` already swallows per-webhook delivery errors and
 * records them for the retry sweep, so a throw out of here means the lookup
 * itself failed — which is worth a queue retry.
 */

import { defineConsumer } from '@weldsuite/entity-events/consumers';
import { dispatchWebhookDeliveries } from '@weldsuite/entity-events';
import type { Env } from '../env';

export const webhooksConsumer = defineConsumer<Env>({
  name: 'webhooks',
  subscribes: '*',
  needsTenantDb: true,

  async handle(events, { db, workspaceId }) {
    if (!db) throw new Error('webhooks consumer requires a tenant db');

    for (const event of events) {
      await dispatchWebhookDeliveries({
        db,
        workspaceId,
        entityType: event.entityType,
        action: event.action,
        // Doubles as the delivery idempotency key, so a retried batch does not
        // re-deliver anything that already went out.
        eventId: event.id,
        data: event.data as Record<string, unknown>,
      });
    }
  },
});
