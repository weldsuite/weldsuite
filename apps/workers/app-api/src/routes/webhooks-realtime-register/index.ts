/**
 * Realtime Register notifications webhook — PUBLIC.
 *
 * POST /public/webhooks/realtime-register?token=…
 *
 * Auth: shared `?token=` (REALTIME_REGISTER_WEBHOOK_SECRET).
 * When a registration is left in `pending_workflow`, billing-worker stores
 * `rtr:process:{id}` → `{ workspaceId, domainId, kind }` in WORKSPACE_CACHE.
 * This receiver looks that up, polls the process, and marks the domain row.
 */

import { Hono } from 'hono';
import type { Env, Variables } from '../../types';
import { verifyWebhookToken } from '../../lib/webhook-token';
import { RealtimeRegistrar } from '@weldsuite/realtime-registrar';
import { getTenantDbForWorkspace } from '../../db';
import * as domainsService from '../../services/domains';
import * as transfersService from '../../services/domain-transfers';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

export type RtrProcessCache = {
  /** Clerk org id / workspace key accepted by getTenantDbForWorkspace. */
  workspaceId: string;
  domainId?: string;
  transferId?: string;
  kind: 'registration' | 'transfer';
};

export function rtrProcessCacheKey(processId: number | string): string {
  return `rtr:process:${processId}`;
}

function getRealtimeRegistrar(env: Env): RealtimeRegistrar | null {
  const apiKey = env.REALTIME_REGISTER_API_KEY;
  const customer = env.REALTIME_REGISTER_CUSTOMER;
  if (!apiKey || !customer) return null;
  return new RealtimeRegistrar({
    apiKey,
    customer,
    ote: env.REALTIME_REGISTER_OTE === 'true',
  });
}

app.get('/', (c) => c.json({ ok: true, service: 'realtime-register-webhook' }));

app.post('/', async (c) => {
  if (!verifyWebhookToken(c, c.env.REALTIME_REGISTER_WEBHOOK_SECRET)) {
    console.warn('[RTR Webhook] Rejected: missing/invalid token');
    return c.json({ error: 'unauthorized' }, 401);
  }

  let payload: Record<string, unknown>;
  try {
    payload = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON' }, 400);
  }

  const processIdRaw =
    payload.processId ??
    payload.process_id ??
    (payload.data as Record<string, unknown> | undefined)?.processId ??
    (payload.data as Record<string, unknown> | undefined)?.id;
  const processId =
    typeof processIdRaw === 'number'
      ? processIdRaw
      : typeof processIdRaw === 'string'
        ? Number.parseInt(processIdRaw, 10)
        : NaN;

  if (!Number.isFinite(processId)) {
    console.log('[RTR Webhook] no processId — ack only', JSON.stringify({ keys: Object.keys(payload) }));
    return c.json({ received: true });
  }

  const rtr = getRealtimeRegistrar(c.env);
  if (!rtr) {
    console.warn('[RTR Webhook] Realtime Register not configured — ack only');
    return c.json({ received: true, processId });
  }

  const cacheRaw = await c.env.WORKSPACE_CACHE?.get(rtrProcessCacheKey(processId));
  if (!cacheRaw) {
    try {
      const outcome = await rtr.pollProcess(processId);
      console.log(`[RTR Webhook] process ${processId} → ${outcome} (no cache mapping)`);
    } catch (err) {
      console.error('[RTR Webhook] process poll failed:', err);
    }
    return c.json({ received: true, processId, mapped: false });
  }

  let mapping: RtrProcessCache;
  try {
    mapping = JSON.parse(cacheRaw) as RtrProcessCache;
  } catch {
    return c.json({ received: true, processId, mapped: false });
  }

  try {
    const tenantDb = await getTenantDbForWorkspace(c.env, mapping.workspaceId);

    if (mapping.kind === 'registration' && mapping.domainId) {
      await domainsService.pollRegistrationProcess(tenantDb, rtr, mapping.domainId);
      console.log(`[RTR Webhook] polled registration ${mapping.domainId} for process ${processId}`);
    } else if (mapping.kind === 'transfer' && mapping.transferId) {
      await transfersService.syncTransferFromRegistrar(tenantDb, rtr, mapping.transferId);
      console.log(`[RTR Webhook] synced transfer ${mapping.transferId} for process ${processId}`);
    }

    const outcome = await rtr.pollProcess(processId);
    if (outcome !== 'pending' && c.env.WORKSPACE_CACHE) {
      await c.env.WORKSPACE_CACHE.delete(rtrProcessCacheKey(processId));
    }
  } catch (err) {
    console.error('[RTR Webhook] tenant update failed:', err);
  }

  return c.json({ received: true, processId, mapped: true });
});

export const realtimeRegisterWebhookRoutes = app;
