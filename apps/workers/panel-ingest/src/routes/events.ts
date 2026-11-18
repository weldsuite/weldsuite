/**
 * `POST /e`: a batch of events from the browser SDK (`wire.ts` has the
 * format). Everything that can be decided from the request is decided before
 * the answer: malformed or unknown gets an error, and anything we choose not
 * to count (paused project, bot, filtered IP) is accepted with 204 and
 * dropped, so a tracked site never retries or shows an error for it. The
 * enrichment and the writes run in `waitUntil` after the 204; events on
 * excluded URLs are left out there, one by one, while the rows are built.
 */

import { Hono, type Context } from 'hono';
import { isAllowedOrigin } from '@weldsuite/panel-domain/registry';
import { MAX_BATCH_BYTES, parseEventBatch } from '@weldsuite/panel-domain/wire';
import type { Env } from '../env';
import { requestAddresses, requestGeo } from '../lib/address';
import { readTextLimited } from '../lib/body';
import { collectInBackground } from '../lib/collect';
import { matchesIpFilter } from '../lib/ip-filter';
import { loadProject } from '../lib/project';
import { quotaState } from '../lib/quota';
import { rateLimited } from '../lib/rate-limit';
import { isBotUserAgent } from '../lib/user-agent';

type EventsContext = Context<{ Bindings: Env }>;

type ErrorStatus = 400 | 403 | 404 | 413 | 415 | 429;

function reject(c: EventsContext, status: ErrorStatus, code: string, message: string): Response {
  return c.json({ error: { code, message } }, status);
}

/** `events.2.url: Invalid url`: the first problem, short enough for a browser console. */
function firstIssue(issues: { path: (string | number)[]; message: string }[]): string {
  const issue = issues[0];
  if (!issue) return 'Invalid batch';
  return issue.path.length > 0 ? `${issue.path.join('.')}: ${issue.message}` : issue.message;
}

export const eventRoutes = new Hono<{ Bindings: Env }>();

eventRoutes.post('/e', async (c) => {
  // The per-IP limits come first, before the body is read and KV is asked, so a
  // flood costs as little as possible. Behind a proxy (or with a forged
  // X-Forwarded-For) the client IP is not the connecting one: that one gets a
  // second, 50 times higher ceiling.
  const addresses = requestAddresses(c.req.raw.headers);
  const limited =
    (await rateLimited(c.env.EVENTS_RATE_LIMIT, addresses.client)) ||
    (addresses.connecting !== addresses.client && (await rateLimited(c.env.EVENTS_PROXY_RATE_LIMIT, addresses.connecting)));
  if (limited) {
    c.header('Retry-After', '10');
    return reject(c, 429, 'rate_limited', 'Too many requests');
  }


  // text/plain is what the SDK sends (a simple request, so no preflight).
  const contentType = (c.req.header('Content-Type') ?? '').split(';')[0]!.trim().toLowerCase();
  if (contentType && contentType !== 'text/plain' && contentType !== 'application/json') {
    return reject(c, 415, 'unsupported_media_type', 'Send the batch as text/plain or application/json');
  }

  const text = await readTextLimited(c.req.raw, MAX_BATCH_BYTES);
  if (text === null) return reject(c, 413, 'payload_too_large', `A batch is at most ${MAX_BATCH_BYTES} bytes`);

  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return reject(c, 400, 'invalid_body', 'The body is not valid JSON');
  }
  // The envelope must be right; an event that isn't is dropped on its own, so
  // an SDK a version ahead of or behind this schema loses events, not batches.
  const parsed = parseEventBatch(body);
  if (!parsed.ok) return reject(c, 400, 'invalid_batch', firstIssue(parsed.issues));
  const batch = parsed.batch;

  const project = await loadProject(c.env, batch.token);
  if (!project) return reject(c, 404, 'unknown_project', 'Unknown project token');

  if (!isAllowedOrigin(c.req.header('Origin') ?? null, project.allowedDomains)) {
    return reject(c, 403, 'origin_not_allowed', 'This site is not an allowed domain of the project');
  }

  const cf = c.req.raw.cf as IncomingRequestCfProperties | undefined;
  const ip = addresses.client;
  const userAgent = c.req.header('User-Agent') ?? '';

  const dropped =
    project.status === 'paused' ||
    isBotUserAgent(userAgent) ||
    cf?.botManagement?.verifiedBot === true ||
    matchesIpFilter(ip, project.settings.ipFilters);
  if (dropped) return c.body(null, 204);

  // Past the plan's allowance with no wallet to pay for more: accepted, not counted.
  const receivedAt = Date.now();
  if ((await quotaState(c.env.WORKSPACE_CACHE, project.workspaceId, receivedAt)) === 'events_blocked') return c.body(null, 204);

  c.executionCtx.waitUntil(
    collectInBackground(c.env, {
      project,
      batch,
      receivedAt,
      ip,
      userAgent,
      geo: requestGeo(c.req.raw.headers, cf),
    }),
  );
  return c.body(null, 204);
});
