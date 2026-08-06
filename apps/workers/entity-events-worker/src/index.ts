/**
 * Entity Events Worker — the dispatcher.
 *
 * Consumes the single `entity-events` queue and fans each batch out to every
 * registered consumer that subscribes to it. All the logic lives in
 * `@weldsuite/entity-events/consumers`; this worker is the deployment shell
 * plus the registry in `./consumers`.
 *
 * Adding a consumer is a file plus a line in that registry. It needs no queue,
 * no wrangler change, no producer change and no new worker — which is the whole
 * point of the exercise.
 */

import { Hono } from 'hono';
import { dispatch } from '@weldsuite/entity-events/consumers';
import type { EntityEventMessage } from '@weldsuite/entity-events/types';
import { CONSUMERS } from './consumers';
import { getTenantDbForWorkspace } from './db';
import type { Env } from './env';

const app = new Hono<{ Bindings: Env }>();

app.get('/robots.txt', (c) => c.text('User-agent: *\nDisallow: /\n'));

app.get('/health', (c) =>
  c.json({
    status: 'pass',
    service: 'entity-events-worker',
    environment: c.env.ENVIRONMENT,
    consumers: CONSUMERS.map((consumer) => consumer.name),
    timestamp: new Date().toISOString(),
  }),
);

app.notFound((c) => c.json({ error: 'Not Found', path: c.req.path }, 404));

app.onError((err, c) => {
  console.error('Worker Error:', err);
  return c.json({ error: 'Internal Server Error' }, 500);
});

export default {
  fetch: app.fetch,

  async queue(batch: MessageBatch<EntityEventMessage>, env: Env): Promise<void> {
    await dispatch(batch, {
      env,
      consumers: CONSUMERS,
      resolveTenantDb: getTenantDbForWorkspace,
    });
  },
};
