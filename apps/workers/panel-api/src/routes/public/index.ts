/**
 * Public routes: /public/panel/*, no session (mounted before `apiAuth()`).
 * The token in the path is the only credential.
 *
 *   GET  /share/:token          → PanelPublicShareDto: names, the project's name, report kinds and
 *                                 specs (filter values, cohort ids and the project id taken out),
 *                                 the dashboard's layout and text tiles, allowEmbed, allowDateChange
 *   POST /share/:token/results  → `{ tileId?, dateRange? }`: one report's (or dashboard tile's) result,
 *                                 through the same cache and scope as `POST /api/panel/query`
 *
 * Anything wrong (a malformed, unknown, revoked or expired token, a suspended
 * workspace, a deleted target, a report that may no longer be shared, a tile
 * the link does not show) is the same 404. Rate limited per address
 * (`PANEL_SHARE_RATE_LIMIT`; a missing binding does not limit). A date preset
 * is honoured only when the link allows date changes; custom dates never.
 */

import { Hono, type Context } from 'hono';
import { createMiddleware } from 'hono/factory';
import { zValidator } from '@hono/zod-validator';
import { getMasterDb } from '@weldsuite/worker-kit/db';
import { error, success } from '@weldsuite/worker-kit/response';
import { panelPublicResultsSchema } from '@weldsuite/app-api-client/schemas/weldpanel-collab';
import type { PanelQueryResponse } from '@weldsuite/app-api-client/schemas/weldpanel-query';
import type { Env, Variables } from '../../types';
import { queryFailure } from '../../http';
import { runCachedQuery, queryRunDeps, type CachedQuery } from '../../services/query-run';
import { openShare, publicResultSpec, publicShareDto, recordView } from '../../services/share-links';

type Ctx = Context<{ Bindings: Env; Variables: Variables }>;

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

/** A short hash of the address: the rate limiter's key, so the address itself is never passed on. */
async function addressKey(ip: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(ip));
  return Array.from(new Uint8Array(digest).subarray(0, 8), (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Per-address limit. A missing binding or address (local dev) is not limited,
 * and a failing limiter lets the request through.
 */
const rateLimit = createMiddleware<{ Bindings: Env; Variables: Variables }>(async (c, next) => {
  const limiter = c.env.PANEL_SHARE_RATE_LIMIT;
  const ip = c.req.header('cf-connecting-ip');
  if (limiter && ip) {
    let allowed = true;
    try {
      allowed = (await limiter.limit({ key: await addressKey(ip) })).success;
    } catch (err) {
      console.warn('[panel-api] share rate limiter failed, not limiting', err);
    }
    if (!allowed) return c.json({ error: { code: 'RATE_LIMITED', message: 'Too many requests. Try again in a minute.' } }, 429);
  }
  await next();
  // Never cached by browsers or proxies, never indexed.
  c.res.headers.set('Cache-Control', 'no-store');
  c.res.headers.set('X-Robots-Tag', 'noindex, nofollow');
});

app.use('*', rateLimit);

const notFound = (c: Ctx) => error.notFound(c, 'Share link');

app.get('/share/:token', async (c) => {
  const opened = await openShare(c.env, getMasterDb(c.env), c.req.param('token'));
  if (!opened) return notFound(c);
  const body = await publicShareDto(opened);
  c.executionCtx.waitUntil(
    recordView(opened.db, opened.link).catch((err: unknown) => {
      console.warn('[panel-api] share view count failed', err);
    }),
  );
  return success(c, body);
});

app.post('/share/:token/results', zValidator('json', panelPublicResultsSchema), async (c) => {
  const opened = await openShare(c.env, getMasterDb(c.env), c.req.param('token'));
  if (!opened) return notFound(c);
  const spec = await publicResultSpec(opened, c.req.valid('json'));
  if (!spec) return notFound(c);

  let entry: CachedQuery;
  try {
    entry = await runCachedQuery(queryRunDeps(c.env, opened.db, opened.workspaceId), spec);
  } catch (err) {
    return queryFailure(c, err);
  }
  const response: PanelQueryResponse = { ...entry.result, dataAsOf: entry.dataAsOf, cached: entry.cached };
  return success(c, response);
});

export default app;
