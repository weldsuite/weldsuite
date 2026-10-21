/**
 * Audit Log Worker
 *
 * Dedicated Cloudflare Worker that consumes the AUDIT_EVENTS queue.
 * Writes an audit log to the tenant database for every entity mutation.
 */

import { Hono } from 'hono';
import type { Env } from './env';
import { processAuditBatch, type AuditQueueMessage } from './services/batch-processor';

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
  fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return Promise.resolve(app.fetch(request, env, ctx));
  },

  async queue(batch: MessageBatch<AuditQueueMessage>, env: Env): Promise<void> {
    await processAuditBatch(batch, env);
  },
};
