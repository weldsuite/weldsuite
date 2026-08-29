/**
 * Personal API Worker
 *
 * Auth: Clerk JWT. Personal accounts (consumer WeldMail) live in master +
 * shared personal Neon DB — distinct from workspace-scoped app-api.
 */

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { clerkMiddleware } from './middleware/clerk';
import { personalAccountMiddleware } from './middleware/personal-account';
import { onboardRoutes } from './routes/onboard';
import { meRoutes } from './routes/me';
import { mailWeldMailRoutes } from './routes/mail-weldmail';
import { mailAccountsRoutes } from './routes/mail-accounts';
import { mailMessagesRoutes } from './routes/mail-messages';
import { mailLabelsRoutes } from './routes/mail-labels';
import { mailDraftsRoutes } from './routes/mail-drafts';
import type { Env, Variables } from './types';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

app.use('*', logger());

app.use(
  '*',
  cors({
    origin: '*',
    allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization'],
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

// Clerk on all /api/* routes
app.use('/api/*', clerkMiddleware());

// Personal account lookup — allows missing on /api/onboard and /api/me;
// returns PERSONAL_ACCOUNT_REQUIRED elsewhere.
app.use('/api/*', personalAccountMiddleware());

app.route('/api/onboard', onboardRoutes);
app.route('/api/me', meRoutes);

app.route('/api/mail/weldmail', mailWeldMailRoutes);
app.route('/api/mail/accounts', mailAccountsRoutes);
app.route('/api/mail/messages', mailMessagesRoutes);
app.route('/api/mail/labels', mailLabelsRoutes);
app.route('/api/mail/drafts', mailDraftsRoutes);

app.notFound((c) =>
  c.json({ error: { code: 'NOT_FOUND', message: 'Not Found', details: { path: c.req.path } } }, 404),
);

app.onError((err, c) => {
  console.error('Personal API Error:', err);
  return c.json({ error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } }, 500);
});

export default app;
