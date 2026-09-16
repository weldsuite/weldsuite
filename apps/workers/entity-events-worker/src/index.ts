/**
 * Entity Events Hub Worker
 *
 * Consumes the ENTITY_EVENTS hub queue and enqueues copies to matching
 * first-party subscriber queues. Orchestrator only — no business logic.
 *
 * Ack policy (Phase 1 / v1):
 * - Ack only when every matching subscriber enqueue succeeds.
 * - On any enqueue failure, retry the hub message (CF Queue retries / DLQ).
 * - Hub retries re-fan out to all matches → subscribers must be idempotent
 *   on `message.id` (Phase 2).
 */

import { Hono } from 'hono';
import type { EntityEventMessage } from '@weldsuite/entity-events/types';
import type { Env } from './env';
import { fanOutHubMessage } from './hub';

const app = new Hono<{ Bindings: Env }>();

app.get('/robots.txt', (c) => {
  return c.text('User-agent: *\nDisallow: /\n');
});

app.get('/health', (c) => {
  return c.json({
    status: 'pass',
    service: 'entity-events-worker',
    environment: c.env.ENVIRONMENT,
    timestamp: new Date().toISOString(),
  });
});

app.notFound((c) => c.json({ error: 'Not Found', path: c.req.path }, 404));

app.onError((err, c) => {
  console.error('Worker Error:', err);
  return c.json({ error: 'Internal Server Error' }, 500);
});

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return app.fetch(request, env, ctx);
  },

  async queue(batch: MessageBatch<EntityEventMessage>, env: Env): Promise<void> {
    console.log(`[Hub] Processing batch of ${batch.messages.length} entity events`);

    for (const message of batch.messages) {
      try {
        const result = await fanOutHubMessage(message.body, env);
        if (result.failed.length > 0) {
          for (const f of result.failed) {
            console.error(`[Hub] Enqueue failed for subscriber ${f.id}:`, f.error);
          }
          // Do not ack — CF Queue retries; after max_retries → entity-events-dlq.
          message.retry();
          continue;
        }
        console.log(
          `[Hub] Fanned out ${message.body.eventType} (${message.body.id}) → ${result.succeeded.join(', ') || '(no subscribers)'}`,
        );
        message.ack();
      } catch (err) {
        console.error(`[Hub] Failed to process event ${message.body.id}:`, err);
        message.retry();
      }
    }
  },
};
