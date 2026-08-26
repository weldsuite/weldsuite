/**
 * Helpdesk Widget API Worker
 *
 * Public-facing webchat API. Authenticated via widgetId (x-widget-id header).
 */

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { widgetAuthMiddleware } from './middleware/widget-auth';
import { rateLimitMiddleware } from './middleware/rate-limit';
import { configRoutes } from './routes/config';
import { conversationsRoutes } from './routes/conversations';
import { realtimeRoutes } from './routes/realtime';
import { attachmentsRoutes } from './routes/attachments';
import type { DeskWidgetSettings } from '@weldsuite/db/schema/desk-widget-settings';
import type { Database } from './db';

export interface Env {
  HYPERDRIVE_MASTER: Hyperdrive;
  DATABASE_URL_MASTER?: string;
  WORKSPACE_CACHE: KVNamespace;
  ENVIRONMENT: string;
  NEON_API_KEY: string;
  REALTIME?: Fetcher;
  STORAGE: R2Bucket;
  R2_PUBLIC_URL?: string;
  DATABASE_ENCRYPTION_KEY?: string;
  DATABASE_ENCRYPTION_KEY_V2?: string;
  ENTITY_EVENTS: Queue<import('./lib/entity-events').EntityEventMessage>;
  ANALYTICS_EVENTS?: Queue<import('./lib/entity-events').EntityEventMessage>;
  WIDGET_TOKEN_SECRET?: string;
}

export type Variables = {
  widgetId: string;
  workspaceId: string;
  widgetConfig: DeskWidgetSettings;
  tenantDb: Database;
  removeBranding: boolean;
  internalWorkspaceId: string;
};

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

app.use('*', logger());

app.use(
  '*',
  cors({
    origin: '*',
    allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'x-widget-id'],
    credentials: false,
  }),
);

app.get('/robots.txt', (c) => c.text('User-agent: *\nDisallow: /\n'));

app.get('/health', (c) =>
  c.json({
    status: 'ok',
    environment: c.env.ENVIRONMENT,
    timestamp: new Date().toISOString(),
  }),
);

app.use('/api/*', rateLimitMiddleware());
app.use('/api/*', widgetAuthMiddleware());

app.route('/api/config', configRoutes);
app.route('/api/conversations', conversationsRoutes);
app.route('/api/realtime', realtimeRoutes);
app.route('/api/attachments', attachmentsRoutes);

app.notFound((c) => c.json({ error: 'Not Found', path: c.req.path }, 404));

app.onError((err, c) => {
  console.error('Widget API Error:', err);
  return c.json(
    {
      error: 'Internal Server Error',
      message: c.env.ENVIRONMENT === 'production' ? undefined : err.message,
    },
    500,
  );
});

export default app;
