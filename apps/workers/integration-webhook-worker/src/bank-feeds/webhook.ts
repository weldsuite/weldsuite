/**
 * Bank feed webhook receiver: POST /webhooks/bank-feeds/:provider
 *
 * Public route (no Clerk). Each provider signs its deliveries differently
 * (Stripe Financial Connections: HMAC `Stripe-Signature`; Plaid: an ES256 JWT in
 * `Plaid-Verification` whose key is fetched and cached in KV), so verification
 * lives in `@weldsuite/bank-feeds` and a bad signature is a 401. A verified
 * delivery is answered 200 straight away; the work (master index lookup by
 * provider connection id, then books-api over the `BOOKS_INTERNAL` binding)
 * runs in `waitUntil`. Syncs are idempotent and the due sweep is the safety
 * net, so a lost forward costs a delay, not data.
 */

import { Hono } from 'hono';
import { and, eq } from 'drizzle-orm';
import {
  WebhookVerificationError,
  bankFeedConfigFromEnv,
  createWebhookProvider,
  normalizeProviderId,
  type FeedEvent,
} from '@weldsuite/bank-feeds';
import type { Env } from '../index';
import { getMasterDb, masterSchema } from '../db';

export interface BankFeedIndexHit {
  connectionId: string;
  clerkOrgId: string;
}

export interface BankFeedWebhookDeps {
  /** Master `bank_feed_connection_index` row for the id the provider's webhook carries. */
  lookup(provider: string, providerConnectionId: string): Promise<BankFeedIndexHit | null>;
  /** books-api `BooksInternal`: apply the events (and sync) for one connection. */
  forward(
    hit: BankFeedIndexHit,
    body: { connectionId: string; provider: string; providerConnectionId: string; events: FeedEvent[] },
  ): Promise<void>;
}

export function defaultDeps(env: Env): BankFeedWebhookDeps {
  return {
    async lookup(provider, providerConnectionId) {
      const t = masterSchema.bankFeedConnectionIndex;
      const [row] = await getMasterDb(env)
        .select({ connectionId: t.connectionId, clerkOrgId: t.clerkOrgId })
        .from(t)
        .where(and(eq(t.provider, provider), eq(t.providerConnectionId, providerConnectionId)))
        .limit(1);
      return row ?? null;
    },
    async forward(hit, body) {
      if (!env.BOOKS_INTERNAL) throw new Error('BOOKS_INTERNAL service binding is not configured');
      const response = await env.BOOKS_INTERNAL.fetch('https://internal/internal/bank-connections/events', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Workspace-Id': hit.clerkOrgId },
        body: JSON.stringify(body),
      });
      if (!response.ok) throw new Error(`books-api answered ${response.status}`);
    },
  };
}

/** Group events by the connection id the provider used and hand each group to books-api. */
export async function dispatchBankFeedEvents(
  provider: string,
  events: FeedEvent[],
  deps: BankFeedWebhookDeps,
): Promise<{ forwarded: number; unknown: number; failed: number }> {
  const byConnection = new Map<string, FeedEvent[]>();
  for (const event of events) {
    byConnection.set(event.providerConnectionId, [...(byConnection.get(event.providerConnectionId) ?? []), event]);
  }

  let forwarded = 0;
  let unknown = 0;
  let failed = 0;
  for (const [providerConnectionId, group] of byConnection) {
    try {
      const hit = await deps.lookup(provider, providerConnectionId);
      if (!hit) {
        unknown += 1;
        console.warn(`[BankFeedWebhook] no connection for ${provider}:${providerConnectionId}`);
        continue;
      }
      await deps.forward(hit, { connectionId: hit.connectionId, provider, providerConnectionId, events: group });
      forwarded += 1;
    } catch (err) {
      failed += 1;
      console.error(`[BankFeedWebhook] forward failed for ${provider}:${providerConnectionId}:`, err instanceof Error ? err.message : err);
    }
  }
  return { forwarded, unknown, failed };
}

export function bankFeedWebhookRoutes(depsFor: (env: Env) => BankFeedWebhookDeps = defaultDeps) {
  const app = new Hono<{ Bindings: Env }>();

  app.post('/bank-feeds/:provider', async (c) => {
    const providerId = normalizeProviderId(c.req.param('provider'));
    const config = bankFeedConfigFromEnv(c.env, { keyCache: c.env.WORKSPACE_CACHE });

    let provider;
    try {
      provider = createWebhookProvider(providerId, config);
    } catch {
      // Unknown provider, or its credentials are not configured on this worker.
      return c.json({ error: { code: 'NOT_FOUND', message: 'Unknown bank feed provider' } }, 404);
    }

    let events: FeedEvent[];
    try {
      events = await provider.parseWebhook(c.req.raw, {
        webhookSecret: providerId === 'stripe_fc' ? c.env.STRIPE_FC_WEBHOOK_SECRET : undefined,
        keyCache: c.env.WORKSPACE_CACHE,
      });
    } catch (err) {
      if (err instanceof WebhookVerificationError) {
        console.warn(`[BankFeedWebhook] rejected ${providerId} delivery: ${err.message}`);
        return c.json({ error: { code: 'UNAUTHORIZED', message: 'Invalid signature' } }, 401);
      }
      console.error(`[BankFeedWebhook] ${providerId} parse failed:`, err instanceof Error ? err.message : err);
      return c.json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to process the webhook' } }, 500);
    }

    if (events.length > 0) {
      c.executionCtx.waitUntil(
        dispatchBankFeedEvents(provider.id, events, depsFor(c.env)).then((result) =>
          console.log(`[BankFeedWebhook] ${provider.id}: ${events.length} events, forwarded ${result.forwarded}, unknown ${result.unknown}, failed ${result.failed}`),
        ),
      );
    }
    return c.json({ received: true, events: events.length }, 200);
  });

  return app;
}
