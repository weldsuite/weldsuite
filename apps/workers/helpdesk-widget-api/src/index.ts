/**
 * Helpdesk Widget API Worker
 *
 * Hono-based API worker that serves the embeddable helpdesk chat widget
 * with public-facing endpoints authenticated via widget API keys (widgetId).
 */

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { widgetAuthMiddleware } from './middleware/widget-auth';
import { rateLimitMiddleware } from './middleware/rate-limit';
import { configRoutes } from './routes/config';
import { conversationsRoutes } from './routes/conversations';
import { messagesRoutes } from './routes/messages';
import { articlesRoutes } from './routes/articles';
import { foldersRoutes } from './routes/folders';
import { reviewsRoutes } from './routes/reviews';
import { realtimeRoutes } from './routes/realtime';
import { agentsRoutes } from './routes/agents';
import { attachmentsRoutes } from './routes/attachments';
import { widgetTicketsRoutes } from './routes/tickets';
import { discordRoutes } from './routes/discord';
import { slackRoutes } from './routes/slack';
import { openRoutes } from './routes/open';
import { workflowStreamRoutes } from './routes/workflow-stream';
import type { HelpdeskWidgetSettings } from '@weldsuite/db/schema';
import type { Database } from './db';

// Environment bindings type
export interface Env {
  // Hyperdrive binding for master database (widget registry, workspace lookup)
  HYPERDRIVE_MASTER: Hyperdrive;
  // Direct database URL for local development
  DATABASE_URL_MASTER?: string;
  // KV namespace for workspace URL caching
  WORKSPACE_CACHE: KVNamespace;
  // General config
  ENVIRONMENT: string;
  // Neon API key for on-demand connection resolution
  NEON_API_KEY: string;
  // Real-time event system (service binding to realtime-worker)
  REALTIME?: Fetcher;
  // R2 Storage binding for file uploads
  STORAGE: R2Bucket;
  R2_PUBLIC_URL?: string;
  // Encryption key for stored database connection strings
  DATABASE_ENCRYPTION_KEY?: string;
  DATABASE_ENCRYPTION_KEY_V2?: string;
  // Firebase service account JSON for FCM v1 push (set via wrangler secret put)
  FIREBASE_SERVICE_ACCOUNT?: string;
  // Cloudflare Queues for entity mutation events
  ENTITY_EVENTS: Queue<import('./lib/entity-events').EntityEventMessage>;
  ANALYTICS_EVENTS?: Queue<import('./lib/entity-events').EntityEventMessage>;
  // Cloudflare AI Gateway
  CF_ACCOUNT_ID?: string;
  CF_AIG_TOKEN?: string;
  // Widget token secret for realtime-worker authentication
  WIDGET_TOKEN_SECRET?: string;
  // Discord integration — shared secret for bot webhook auth
  DISCORD_PUBLIC_KEY?: string;
  DISCORD_BOT_TOKEN?: string;
  // Slack integration — signing secret for Events API verification
  SLACK_SIGNING_SECRET?: string;
  // API Worker URL for cross-worker communication
  API_WORKER_URL?: string;
  // Service binding to workflow worker (CF Workflows + assignment routing)
  WORKFLOW_WORKER?: Fetcher;
}

// Extend Hono context with widget variables
export type Variables = {
  widgetId: string;
  workspaceId: string;
  widgetConfig: HelpdeskWidgetSettings;
  tenantDb: Database;
  removeBranding: boolean;
  internalWorkspaceId: string;
};

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

// AI is currently unavailable — the Anthropic provider bootstrap has been
// removed. AI-backed routes (ai_auto_reply workflow step) short-circuit
// and escalate to a human at the handler level instead.

// Global middleware
app.use('*', logger());

// CORS: Allow embedding from any origin (widget is embedded in customer sites)
app.use('*', cors({
  origin: '*',
  allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'x-widget-id'],
  credentials: false,
}));

// Robots.txt — disallow all indexing
app.get('/robots.txt', (c) => {
  return c.text('User-agent: *\nDisallow: /\n');
});

// Health check (no auth required)
app.get('/health', (c) => {
  return c.json({
    status: 'ok',
    environment: c.env.ENVIRONMENT,
    timestamp: new Date().toISOString(),
  });
});

// Discord webhook routes — uses its own auth (X-Bot-Secret), mounted before widget auth
app.route('/webhook/discord', discordRoutes);

// Slack Events API — uses Slack signature verification, mounted before widget auth
app.route('/webhook/slack', slackRoutes);

// Rate limiting — before auth to protect against brute-force
app.use('/api/*', rateLimitMiddleware());

// Protected routes - require widget authentication
app.use('/api/*', widgetAuthMiddleware());

// Mount route modules under /api/ prefix
app.route('/api/open', openRoutes);
app.route('/api/config', configRoutes);
app.route('/api/conversations', conversationsRoutes);
app.route('/api/messages', messagesRoutes);
app.route('/api/articles', articlesRoutes);
app.route('/api/folders', foldersRoutes);
app.route('/api/reviews', reviewsRoutes);
app.route('/api/realtime', realtimeRoutes);
app.route('/api/agents', agentsRoutes);
app.route('/api/attachments', attachmentsRoutes);
app.route('/api/tickets', widgetTicketsRoutes);

// SSE workflow streaming — mounted under /api/conversations/:id/workflow-stream
app.route('/api/conversations', workflowStreamRoutes);

// 404 handler
app.notFound((c) => {
  return c.json({ error: 'Not Found', path: c.req.path }, 404);
});

// Error handler
app.onError((err, c) => {
  console.error('Widget API Error:', err);
  return c.json({
    error: 'Internal Server Error',
    message: c.env.ENVIRONMENT === 'production' ? undefined : err.message,
  }, 500);
});

export default app;
