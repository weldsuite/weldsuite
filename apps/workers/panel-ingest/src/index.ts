/**
 * WeldSuite panel-ingest — WeldPanel's public collector (docs/plans/weldpanel.md).
 *
 * Tracked websites and apps send here, not to panel-api: there is no Clerk
 * session, the project token in the request names the project. Like
 * helpdesk-widget-api (ADR DESK-003) it is its own worker, and unlike it, it
 * never opens a tenant database: a busy site would keep the workspace's Neon
 * compute awake all day (ADR DATA-008). Everything it needs per request comes
 * from KV and its Durable Objects.
 *
 * Routes, by phase:
 *   GET  /s.js            browser SDK bundle                  phase 1
 *   GET  /c/:token        client config                       phase 1
 *   POST /e               event batch → Basin stream          phase 1
 *   POST /v1/track        server-side events (secret key)     phase 3
 *   POST /v1/import       historical events (secret key)      phase 3
 *   POST /r               recording chunk → EU R2 bucket      phase 4
 */

import { Hono } from 'hono';
import type { Env } from './env';
import { cors } from './lib/cors';
import { configRoutes } from './routes/config';
import { eventRoutes } from './routes/events';
import { scriptRoutes } from './routes/script';

export const app = new Hono<{ Bindings: Env }>();

app.use('*', cors);

app.get('/health', (c) => c.json({ ok: true, service: 'panel-ingest', environment: c.env.ENVIRONMENT }));
app.route('/', scriptRoutes);
app.route('/', configRoutes);
app.route('/', eventRoutes);

app.onError((error, c) => {
  console.error(`[panel-ingest] ${c.req.method} ${new URL(c.req.url).pathname} failed: ${error.message}`);
  return c.json({ error: { code: 'internal_error', message: 'Something went wrong' } }, 500);
});

export { PanelSalt } from './durable-objects/panel-salt';
export { PanelUsage } from './durable-objects/panel-usage';

export default {
  fetch: app.fetch,
};
