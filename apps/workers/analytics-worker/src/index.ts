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

/**
 * Drop duplicate event ids within a single queue batch (hub retries can
 * re-deliver the same evt_ id). Cross-batch duplicates are best-effort only
 * without a durable store — Iceberg ingest may still see rare duplicates.
 */
export function shouldProcessEventId(seen: Set<string>, eventId: string): boolean {
  if (seen.has(eventId)) return false;
  seen.add(eventId);
  return true;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return app.fetch(request, env, ctx);
  },

  async queue(batch: MessageBatch<EntityEventMessage>, env: Env): Promise<void> {
    console.log(`[Analytics] Processing batch of ${batch.messages.length} events`);

    const seen = new Set<string>();
    let written = 0;
    let failed = 0;
    let duplicates = 0;

    for (const message of batch.messages) {
      if (!shouldProcessEventId(seen, message.body.id)) {
        duplicates++;
        message.ack();
        continue;
      }

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

    console.log(
      `[Analytics] Batch complete: ${written} written, ${failed} failed, ${duplicates} duplicates`,
    );
  },
};
