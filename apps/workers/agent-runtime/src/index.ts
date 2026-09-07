/**
 * WeldAgent agent-runtime — Cloudflare Sandbox (Linux computer) + Browser Run.
 * Internal-only API for app-api.
 */

import { Hono } from 'hono';
import { proxyToSandbox } from '@cloudflare/sandbox';
import type { Env } from './env';
import { requireInternalAuth, computerEnabled } from './lib/auth';
import { computerRoutes } from './routes/computer';
import { browserRoutes } from './routes/browser';

export { Sandbox } from '@cloudflare/sandbox';

const app = new Hono<{ Bindings: Env }>();

app.get('/robots.txt', (c) => c.text('User-agent: *\nDisallow: /\n'));

app.get('/health', (c) =>
  c.json({
    status: 'pass',
    service: 'agent-runtime',
    environment: c.env.ENVIRONMENT,
    computerEnabled: computerEnabled(c.env),
    timestamp: new Date().toISOString(),
  }),
);

app.use('/v1/*', requireInternalAuth);
app.route('/v1/computer', computerRoutes);
app.route('/v1/browser', browserRoutes);

app.notFound((c) => c.json({ error: 'Not Found', path: c.req.path }, 404));
app.onError((err, c) => {
  console.error('[agent-runtime]', err);
  return c.json({ error: err instanceof Error ? err.message : 'Internal Server Error' }, 500);
});

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    void ctx;
    try {
      const proxied = await proxyToSandbox(request, env as never);
      if (proxied) return proxied;
    } catch {
      // not a sandbox proxy request
    }
    return app.fetch(request, env, ctx);
  },
};
