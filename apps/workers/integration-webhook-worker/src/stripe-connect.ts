/**
 * Stripe connector ingress + Moneybird push sweep.
 *
 * `POST /webhooks/stripe-connect` is the platform's Connect webhook: one
 * endpoint for every connected Stripe account. We verify `Stripe-Signature`
 * with the platform secret, find the WeldSuite connections for `event.account`
 * (KV `stripeacct:`, no tenant DB), and forward the raw event to each through
 * connect-api's internal `connector-event` route, marked as verified.
 *
 * The `moneybird_push` sweep runs another push pass for workspaces whose last
 * pass stopped with work left (Moneybird's rate limit), until none is left.
 */

import {
  listDueTenantWorkIndex,
  markTenantWorkIndexRan,
  MONEYBIRD_PUSH_INTERVAL_MS,
  STRIPE_CONNECT_VERIFIED_HEADER,
  stripeAccountKvKey,
  verifyStripeWebhook,
  type StripeAccountKvEntry,
  type TenantWorkIndexDb,
} from '@weldsuite/connectors';
import { fetchConnectInternal, hasConnectInternal, type ConnectInternalEnv } from './lib/connect-internal';

export interface StripeConnectEnv extends ConnectInternalEnv {
  WORKSPACE_CACHE: KVNamespace;
  /** Signing secret of the platform's Connect webhook endpoint. */
  STRIPE_CONNECT_WEBHOOK_SECRET?: string;
  CONNECTOR_SYNC_INDEX?: D1Database;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

async function connectionsForAccount(env: StripeConnectEnv, accountId: string): Promise<StripeAccountKvEntry> {
  const raw = await env.WORKSPACE_CACHE.get(stripeAccountKvKey(accountId));
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as StripeAccountKvEntry) : [];
  } catch {
    return [];
  }
}

export async function handleStripeConnectWebhook(
  env: StripeConnectEnv,
  rawBody: string,
  signature: string | null,
): Promise<Response> {
  const secret = env.STRIPE_CONNECT_WEBHOOK_SECRET;
  if (!secret) {
    console.error('[Webhook/stripe-connect] STRIPE_CONNECT_WEBHOOK_SECRET is not set');
    return json({ error: 'Stripe Connect webhook not configured' }, 503);
  }
  if (!(await verifyStripeWebhook({ secret, body: rawBody, signature }))) {
    return json({ error: 'Invalid signature' }, 401);
  }

  let event: { account?: unknown };
  try {
    event = JSON.parse(rawBody) as { account?: unknown };
  } catch {
    return json({ error: 'Invalid JSON' }, 400);
  }
  const accountId = typeof event.account === 'string' ? event.account : null;
  // Events on the platform account itself (billing, WeldApps) aren't ours.
  if (!accountId) return json({ received: true, ignored: 'platform event' });

  const targets = await connectionsForAccount(env, accountId);
  if (targets.length === 0) return json({ received: true, ignored: 'unknown account' });
  if (!hasConnectInternal(env)) {
    console.error('[Webhook/stripe-connect] CONNECT_INTERNAL / APP_API binding missing');
    return json({ error: 'Connector ingest unavailable' }, 503);
  }

  let failed = 0;
  for (const target of targets) {
    try {
      const res = await fetchConnectInternal(env, `/api/integrations/connections/${target.connectionId}/connector-event`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Internal-Workspace-Id': target.workspaceId,
          [STRIPE_CONNECT_VERIFIED_HEADER]: 'verified',
        },
        body: rawBody,
      });
      if (res.status >= 500) failed += 1;
    } catch (err) {
      failed += 1;
      console.error(`[Webhook/stripe-connect] forward to ${target.connectionId} failed:`, err);
    }
  }
  // A 5xx makes Stripe retry; ingest is idempotent, so re-delivering to the others is harmless.
  return failed > 0 ? json({ error: 'Ingest failed', failed }, 502) : json({ received: true, delivered: targets.length });
}

export async function runMoneybirdPushSweep(env: StripeConnectEnv): Promise<void> {
  const d1 = env.CONNECTOR_SYNC_INDEX as unknown as TenantWorkIndexDb | undefined;
  if (!d1 || !hasConnectInternal(env)) return;
  const due = await listDueTenantWorkIndex(d1, 'moneybird_push');
  for (const row of due) {
    const now = Date.now();
    try {
      const res = await fetchConnectInternal(env, '/api/integrations/moneybird-push', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Workspace-Id': row.clerk_org_id },
      });
      const body = (await res.json().catch(() => null)) as { data?: { remaining?: boolean } } | null;
      if (!res.ok) throw new Error(`moneybird push HTTP ${res.status}`);
      await markTenantWorkIndexRan(d1, {
        workspaceId: row.workspace_id,
        kind: 'moneybird_push',
        // Nothing left: drop out so the workspace's Neon can autosuspend.
        nextDueAt: body?.data?.remaining ? now + MONEYBIRD_PUSH_INTERVAL_MS : null,
        now,
      });
    } catch (err) {
      console.error(`[MoneybirdPushSweep] workspace ${row.workspace_id}:`, err);
      await markTenantWorkIndexRan(d1, {
        workspaceId: row.workspace_id,
        kind: 'moneybird_push',
        nextDueAt: now + 2 * MONEYBIRD_PUSH_INTERVAL_MS,
        error: err instanceof Error ? err.message : 'push failed',
        now,
      });
    }
  }
}
