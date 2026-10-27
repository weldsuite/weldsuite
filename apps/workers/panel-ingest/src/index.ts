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
 *   GET  /s.js            loader script                       phase 1
 *   GET  /c/:token        client config                       phase 1
 *   POST /e               event batch → Basin stream          phase 1
 *   POST /v1/track        server-side events (secret key)     phase 3
 *   POST /v1/import       historical events (secret key)      phase 3
 *   POST /r               recording chunk → EU R2 bucket      phase 4
 */

import { Hono } from 'hono';
import type { Env } from './env';

export const app = new Hono<{ Bindings: Env }>();

app.get('/health', (c) => c.json({ ok: true, service: 'panel-ingest', environment: c.env.ENVIRONMENT }));

export default {
  fetch: app.fetch,
};
