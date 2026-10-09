/**
 * Internal bank-feed endpoints, mounted only on the `BooksInternal` entrypoint
 * (service binding; trusted by topology, no Clerk JWT). integration-webhook-worker
 * and integration-sync-worker call them with `X-Workspace-Id` (Clerk org id)
 * to sync one connection of one tenant.
 *
 * POST /internal/bank-connections/:connectionId/sync   run one sync (due sweep)
 * POST /internal/bank-connections/events               verified provider events (webhook worker)
 */

import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { publishEntityEvent } from '@weldsuite/entity-events';
import { error, success } from '@weldsuite/worker-kit/response';
import type { Env, Variables } from '../../types';
import { applyFeedEvent } from '../../services/bank-feeds/events';
import { createInternalFeedContext } from '../../services/bank-feeds/runtime';
import { syncConnection, type SyncOutcome } from '../../services/bank-feeds/sync';

type AppContext = Context<{ Bindings: Env; Variables: Variables }>;

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

const eventsSchema = z.object({
  /** `bank_connections.id`, from the master index row the webhook worker matched. */
  connectionId: z.string().min(1).max(30),
  provider: z.string().min(1).max(30),
  providerConnectionId: z.string().min(1).max(255),
  events: z
    .array(
      z.object({
        type: z.enum(['sync_available', 'reauth_required', 'expiring', 'revoked', 'disconnected', 'error']),
        providerConnectionId: z.string().min(1).max(255),
        accountIds: z.array(z.string()).optional(),
        expiresAt: z.string().nullable().optional(),
        message: z.string().nullable().optional(),
      }),
    )
    .min(1)
    .max(50),
});

app.use('*', async (c, next) => {
  if (c.get('internalTrusted') !== true) return error.unauthorized(c, 'Internal endpoint');
  await next();
});

function publishSynced(c: AppContext, connectionId: string, outcome: SyncOutcome): void {
  if (outcome.skipped || outcome.error) return;
  publishEntityEvent({
    c,
    entityType: 'bank_connection',
    entityId: connectionId,
    action: 'synced',
    source: 'system',
    data: { id: connectionId, status: outcome.status, added: outcome.added, updated: outcome.updated, removed: outcome.removed },
  });
}

app.post('/events', async (c) => {
  const parsed = eventsSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return error.badRequest(c, 'Invalid events payload', parsed.error.flatten());
  const body = parsed.data;

  const ctx = await createInternalFeedContext(c);
  if (!ctx) return error.badRequest(c, 'X-Workspace-Id is missing or does not match an active workspace');

  try {
    let needsSync = false;
    let missing = false;
    for (const event of body.events) {
      const result = await applyFeedEvent(ctx, body.connectionId, event);
      needsSync ||= result.needsSync;
      missing ||= result.missing === true;
    }
    if (missing) {
      // The connection was deleted: the index row is stale.
      await ctx.index.remove(body.connectionId).catch(() => undefined);
      return success(c, { applied: 0, synced: false, missing: true });
    }

    let outcome: SyncOutcome | null = null;
    if (needsSync) {
      outcome = await syncConnection(ctx, body.connectionId);
      publishSynced(c, body.connectionId, outcome);
    }
    return success(c, { applied: body.events.length, synced: outcome !== null && !outcome.skipped && !outcome.error, outcome });
  } catch (err) {
    console.error('[books-api/bank-connections/internal] events failed:', err);
    return error.internal(c, 'Failed to apply bank feed events');
  }
});

app.post('/:connectionId/sync', async (c) => {
  const ctx = await createInternalFeedContext(c);
  if (!ctx) return error.badRequest(c, 'X-Workspace-Id is missing or does not match an active workspace');
  const connectionId = c.req.param('connectionId');

  try {
    const outcome = await syncConnection(ctx, connectionId);
    if (outcome.skipped === 'not_found') return c.json({ error: { code: 'NOT_FOUND', message: `Bank connection '${connectionId}' not found` } }, 404);
    publishSynced(c, connectionId, outcome);
    return success(c, outcome);
  } catch (err) {
    console.error('[books-api/bank-connections/internal] sync failed:', err);
    return error.internal(c, 'Failed to sync the bank connection');
  }
});

export const bankConnectionsInternalRoutes = app;
