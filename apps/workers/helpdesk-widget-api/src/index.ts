/**
 * Helpdesk Widget API Worker
 *
 * The public API for WeldDesk's customers (ADR DESK-003):
 *  - the chat widget: tenant from `x-widget-id`, the visitor from the visitor
 *    token `POST /api/visitor` issues (`Authorization: Bearer`);
 *  - the signed-in help center (`/api/portal`): tenant from `?domain=`, the
 *    reader from the session `/api/portal/auth/verify` issues.
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
import { discordWebhookRoutes } from './routes/webhook-discord';
import { visitorRoutes } from './routes/visitor';
import { portalRoutes } from './routes/portal';
import { visitorAuthMiddleware } from './middleware/visitor-auth';
import type { DeskWidgetSettings } from '@weldsuite/db/schema/desk-widget-settings';
import type { DeskVisitor } from '@weldsuite/db/schema/desk-visitors';
import type { DeskPrincipal } from '@weldsuite/db/lib/desk-portal';
import type { RateLimitNamespace } from '@weldsuite/commerce-domain/portal-tokens';
import type { SystemEmailEnv } from '@weldsuite/emails/transports/binding';
import type { Database } from './db';

export { PortalRateLimiter } from './durable-objects/portal-rate-limiter';

export interface Env extends SystemEmailEnv {
  HYPERDRIVE_MASTER: Hyperdrive;
  DATABASE_URL_MASTER?: string;
  WORKSPACE_CACHE: KVNamespace;
  ENVIRONMENT: string;
  NEON_API_KEY: string;
  REALTIME?: Fetcher;
  /** Secret the realtime-worker requires on every /publish/* request (service-binding callers included). */
  REALTIME_INTERNAL_SECRET?: string;
  WORKFLOW_WORKER?: Fetcher;
  STORAGE: R2Bucket;
  R2_PUBLIC_URL?: string;
  DATABASE_ENCRYPTION_KEY?: string;
  DATABASE_ENCRYPTION_KEY_V2?: string;
  ANALYTICS_EVENTS?: Queue<import('./lib/entity-events').EntityEventMessage>;
  /** Hub queue consumed by entity-events-worker (audit, webhooks, workflows, realtime). */
  ENTITY_EVENTS?: Queue<import('@weldsuite/entity-events').EntityEventMessage>;
  WIDGET_TOKEN_SECRET?: string;
  /** Shared with discord-bot-worker DISCORD_PUBLIC_KEY — validates X-Bot-Secret. */
  DISCORD_BOT_SECRET?: string;
  /** Public realtime-worker origin (wss://…) handed to the widget via /api/config. */
  REALTIME_PUBLIC_URL?: string;
  /** Platform origin used for absolute links in push notifications. */
  PUBLIC_APP_URL?: string;
  /** Atomic counters behind the help-center sign-in limits (PortalRateLimiter). */
  PORTAL_RATE_LIMITER?: RateLimitNamespace;
  /** Schedule-index D1 (`workspace_due_index`, kind `desk_sla`): visitor messages
   *  mark when the conversation's SLA clock next comes due (lib/sla-due.ts). */
  SCHEDULE_INDEX?: D1Database;
}

export type Variables = {
  widgetId: string;
  /** `workspaces.id` of the widget's workspace (ADR SEC-011). */
  workspaceId: string;
  /** The workspace's Clerk org id: events, attachment keys and realtime still use it. */
  clerkOrgId: string;
  widgetConfig: DeskWidgetSettings;
  tenantDb: Database;
  removeBranding: boolean;
  /** The caller: from the visitor token (widget) or the portal session (help center). */
  visitor: DeskVisitor;
  principal: DeskPrincipal;
};

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

app.use('*', logger());

app.use(
  '*',
  cors({
    origin: '*',
    allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'x-widget-id', 'Authorization'],
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

// Discord bot ingest — authenticated via X-Bot-Secret (not widget auth)
app.route('/webhook/discord', discordWebhookRoutes);

// The help center's server calls these, so every request comes from its address: the
// per-IP limit below would put all readers on one budget. Sign-in has its own
// atomic limits. Mounted before the widget middleware, which never runs here.
app.route('/api/portal', portalRoutes);

app.use('/api/*', rateLimitMiddleware());
app.use('/api/*', widgetAuthMiddleware());
for (const path of ['/api/conversations', '/api/conversations/*', '/api/realtime/*', '/api/attachments/*']) {
  app.use(path, visitorAuthMiddleware());
}

app.route('/api/config', configRoutes);
app.route('/api/visitor', visitorRoutes);
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
