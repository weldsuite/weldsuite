/**
 * panel-api's internal surface: what other workers call over a service binding,
 * never a browser.
 *
 * `PanelApiInternal` is a named entrypoint, reachable only through a service
 * binding (`[[services]] … entrypoint = "PanelApiInternal"`), so it is trusted
 * by topology and needs no secret, like app-api's `AppApiInternal`. The routes
 * below are mounted on this app only: the worker's public `fetch` (the Clerk
 * routes under /api) does not serve them, so no URL on panel-api.weldsuite.org
 * reaches them.
 *
 *   POST /internal/panel/usage/settle   PanelUsage → counts in, quota state out
 */

import { WorkerEntrypoint } from 'cloudflare:workers';
import { Hono } from 'hono';
import { z } from 'zod';
import { getMasterDb } from '@weldsuite/worker-kit/db';
import type { Env } from './types';
import { MONTH, settleUsage } from './services/usage-settlement';
import { sendUsageNotice } from './services/usage-mail';

const settleSchema = z.object({
  workspaceId: z.string().min(1).max(255),
  month: z.string().regex(MONTH),
  events: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  recordings: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
});

export const internalApp = new Hono<{ Bindings: Env }>();

internalApp.post('/internal/panel/usage/settle', async (c) => {
  const body = settleSchema.safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid settlement' } }, 400);

  const result = await settleUsage(
    {
      masterDb: getMasterDb(c.env),
      kv: c.env.WORKSPACE_CACHE,
      notify: async (notice) => {
        await sendUsageNotice({ env: c.env }, notice);
      },
    },
    body.data,
  );
  if (!result) return c.json({ error: { code: 'NOT_FOUND', message: 'Unknown workspace' } }, 404);
  return c.json({ month: result.month, events: result.usage.events, recordings: result.usage.recordings, quota: result.quota });
});

internalApp.notFound((c) => c.json({ error: { code: 'NOT_FOUND', message: `${c.req.path} not found` } }, 404));
internalApp.onError((error, c) => {
  console.error(`[panel-api] internal ${c.req.method} ${new URL(c.req.url).pathname} failed: ${error.message}`);
  return c.json({ error: { code: 'INTERNAL_ERROR', message: 'Something went wrong' } }, 500);
});

export class PanelApiInternal extends WorkerEntrypoint<Env> {
  fetch(request: Request): Promise<Response> | Response {
    return internalApp.fetch(request, this.env, this.ctx);
  }
}
