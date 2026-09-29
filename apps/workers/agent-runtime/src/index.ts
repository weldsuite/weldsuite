/**
 * WeldAgent agent-runtime — Cloudflare Sandbox (Linux computer) + Browser Run.
 * Internal-only API for agent-api and chat-api: over the `AgentRuntimeInternal`
 * entrypoint (service binding, no secret) or the public bearer path (fallback).
 */

import { WorkerEntrypoint } from 'cloudflare:workers';
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

// Internal entrypoint — bound as `AGENT_RUNTIME` (entrypoint = "AgentRuntimeInternal")
// by agent-api and chat-api (WeldAgent computer/browser tools). A named entrypoint
// is only reachable over a service binding, so it is trusted by topology: the
// /v1 routes accept `internalTrusted` instead of the INTERNAL_API_SECRET bearer.
// The public bearer-guarded app above stays until every caller uses the
// entrypoint (docs/plans/app-api-module-split.md, rollout item 7).
const internalApp = new Hono<{ Bindings: Env; Variables: { internalTrusted?: boolean } }>();
internalApp.use('*', async (c, next) => {
  c.set('internalTrusted', true);
  await next();
});
internalApp.use('/v1/*', requireInternalAuth);
internalApp.route('/v1/computer', computerRoutes);
internalApp.route('/v1/browser', browserRoutes);
internalApp.notFound((c) => c.json({ error: 'Not Found', path: c.req.path }, 404));
internalApp.onError((err, c) => {
  console.error('[agent-runtime]', err);
  return c.json({ error: err instanceof Error ? err.message : 'Internal Server Error' }, 500);
});

export class AgentRuntimeInternal extends WorkerEntrypoint<Env> {
  fetch(request: Request): Promise<Response> | Response {
    return internalApp.fetch(request, this.env, this.ctx);
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    try {
      const proxied = await proxyToSandbox(request, env as never);
      if (proxied) return proxied;
    } catch {
      // not a sandbox proxy request
    }
    return app.fetch(request, env, ctx);
  },
};
