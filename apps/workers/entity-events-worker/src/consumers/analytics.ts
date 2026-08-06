/**
 * Analytics consumer — every event becomes one row on the Cloudflare Pipeline
 * (→ R2 Iceberg).
 *
 * Replaces analytics-worker, which did the same work one message at a time.
 * Here the whole matched slice goes out in a single `send()`, so a batch of 25
 * costs one pipeline call rather than 25.
 */

import { defineConsumer } from '@weldsuite/entity-events/consumers';
import type { Env } from '../env';
import { transformEvent } from '../analytics/transform';

export const analyticsConsumer = defineConsumer<Env>({
  name: 'analytics',
  subscribes: '*',

  async handle(events, { env }) {
    if (!env.ANALYTICS_STREAM) {
      throw new Error('ANALYTICS_STREAM pipeline binding is not configured');
    }

    const records = events.map(transformEvent);
    await env.ANALYTICS_STREAM.send(records);

    console.log(`[analytics] wrote ${records.length} record(s)`);
  },
});
