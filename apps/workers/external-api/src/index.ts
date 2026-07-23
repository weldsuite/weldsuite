import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { authMiddleware } from './middleware/auth';
import { tenantDbMiddleware } from './middleware/tenant-db';
import { rateLimitMiddleware } from './middleware/rate-limit';
import { errorHandler } from './middleware/error-handler';
import { v1 } from './routes/v1';
import oauth from './routes/oauth';
import type { HonoEnv } from './types';

const app = new Hono<HonoEnv>();

app.onError(errorHandler);

app.notFound((c) =>
  c.json(
    { error: { code: 'NOT_FOUND', message: 'The requested endpoint does not exist' } },
    404,
  ),
);

app.use('*', logger());
app.use('*', cors());

app.get('/robots.txt', (c) => c.text('User-agent: *\nDisallow: /\n'));
app.get('/health', (c) =>
  c.json({ status: 'ok', timestamp: new Date().toISOString() }),
);

// OAuth token endpoint for user apps — mounted BEFORE the /v1 auth middleware
// (like /health): the client credentials in the request body ARE the auth.
app.route('/v1/oauth', oauth);

app.use('/v1/*', authMiddleware);
app.use('/v1/*', tenantDbMiddleware);
app.use('/v1/*', rateLimitMiddleware);

app.route('/v1', v1);

export default app;
