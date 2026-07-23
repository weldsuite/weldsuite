/**
 * Audit Log Worker
 *
 * Dedicated Cloudflare Worker that consumes the AUDIT_EVENTS queue.
 * Writes an audit log to the tenant database for every entity mutation.
 */

import { Hono } from 'hono';
import type { Env } from './env';
import type { EntityEventMessage } from './lib/entity-events';
import { processEntityEvent } from './services/event-processor';

const app = new Hono<{ Bindings: Env }>();

// Robots.txt — disallow all indexing
app.get('/robots.txt', (c) => {
  return c.text('User-agent: *\nDisallow: /\n');
});

// Health check
app.get('/health', (c) => {
  return c.json({
    status: 'pass',
    service: 'audit-log-worker',
    environment: c.env.ENVIRONMENT,
    timestamp: new Date().toISOString(),
  });
});

// 404
app.notFound((c) => c.json({ error: 'Not Found', path: c.req.path }, 404));

// Error handler
app.onError((err, c) => {
  console.error('Worker Error:', err);
  return c.json({ error: 'Internal Server Error' }, 500);
});

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return app.fetch(request, env, ctx);
  },

  async queue(batch: MessageBatch<EntityEventMessage>, env: Env): Promise<void> {
    console.log(`[Queue] Processing batch of ${batch.messages.length} audit events`);

    for (const message of batch.messages) {
      try {
        await processEntityEvent(message.body, env);
        message.ack();
      } catch (err) {
        console.error(`[Queue] Failed to process event ${message.body.id}:`, err);
        message.retry();
      }
    }
  },
};
