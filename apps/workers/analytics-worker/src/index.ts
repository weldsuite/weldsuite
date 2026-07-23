import { Hono } from 'hono';
import type { Env } from './env';
import type { EntityEventMessage } from './lib/entity-events';
import { transformEvent } from './services/event-processor';
import { writeAnalyticsRecord } from './services/analytics-writer';

const app = new Hono<{ Bindings: Env }>();

app.get('/health', (c) => {
  return c.json({
    status: 'pass',
    service: 'analytics-worker',
    environment: c.env.ENVIRONMENT,
    timestamp: new Date().toISOString(),
  });
});

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return app.fetch(request, env, ctx);
  },

  async queue(batch: MessageBatch<EntityEventMessage>, env: Env): Promise<void> {
    console.log(`[Analytics] Processing batch of ${batch.messages.length} events`);

    let written = 0;
    let failed = 0;

    for (const message of batch.messages) {
      try {
        const record = transformEvent(message.body);
        await writeAnalyticsRecord(env, record);
        written++;
        message.ack();
      } catch (err) {
        console.error(`[Analytics] Failed to process event ${message.body.id}:`, err);
        failed++;
        message.retry();
      }
    }

    console.log(`[Analytics] Batch complete: ${written} written, ${failed} failed`);
  },
};
