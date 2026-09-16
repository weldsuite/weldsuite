/**
 * Pure hub fan-out — match registry subscribers and enqueue.
 * Kept free of Hono / Workers entry wiring so unit tests can drive it.
 */

import type { EntityEventMessage } from '@weldsuite/entity-events/types';
import {
  ENTITY_EVENT_SUBSCRIBERS,
  matchEntityEventSubscribers,
  type EntityEventSubscriber,
  type EntityEventSubscriberQueueBinding,
} from '@weldsuite/entity-events';

export type QueueSender = {
  send: (message: EntityEventMessage) => Promise<void>;
};

export type HubQueueEnv = Partial<Record<EntityEventSubscriberQueueBinding, QueueSender>>;

export interface FanOutHubMessageResult {
  matched: EntityEventSubscriber[];
  /** Subscriber ids that successfully enqueued. */
  succeeded: string[];
  /** Subscriber ids that failed to enqueue (missing binding or send error). */
  failed: Array<{ id: string; error: unknown }>;
}

/**
 * Enqueue `message` to every matching subscriber queue.
 * Preserves `message.id`. Does not ack — caller decides based on `failed`.
 */
export async function fanOutHubMessage(
  message: EntityEventMessage,
  env: HubQueueEnv,
  subscribers: readonly EntityEventSubscriber[] = ENTITY_EVENT_SUBSCRIBERS,
): Promise<FanOutHubMessageResult> {
  const matched = matchEntityEventSubscribers(message.eventType, subscribers);
  const succeeded: string[] = [];
  const failed: Array<{ id: string; error: unknown }> = [];

  const results = await Promise.allSettled(
    matched.map(async (sub) => {
      const queue = env[sub.queueBinding];
      if (!queue) {
        throw new Error(`Missing queue binding ${sub.queueBinding} for subscriber ${sub.id}`);
      }
      await queue.send(message);
      return sub.id;
    }),
  );

  for (let i = 0; i < results.length; i++) {
    const result = results[i]!;
    const sub = matched[i]!;
    if (result.status === 'fulfilled') {
      succeeded.push(sub.id);
    } else {
      failed.push({ id: sub.id, error: result.reason });
    }
  }

  return { matched, succeeded, failed };
}
