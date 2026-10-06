/**
 * Workflow-webhook registry — maps a public webhook id to the workspace
 * (tenant DB) that owns it, via the master-DB `workflow_webhook_registry`
 * table (same pattern as `api_key_registry`).
 *
 * Replaces the previous `resolveWebhookWorkspace` behaviour of scanning every
 * active workspace's tenant DB on a KV cache miss: that made any anonymous
 * request with a random/guessed id trigger a full tenant-DB fan-out, a DoS
 * vector. An id that has never been registered (or was soft-deleted) now
 * resolves to "unknown" in one master-DB lookup, no fan-out.
 *
 * Functions take their dependencies (`masterDb`, `kv`) directly rather than
 * the worker `Env`, so they can run against a real pglite-backed master DB in
 * tests without a Neon connection (see workflow-webhook-registry.test.ts).
 * Production call sites build the dependency bag once with `registryDeps()`.
 */

import { eq } from 'drizzle-orm';
import { getMasterDb, masterSchema, type MasterDatabase } from '@weldsuite/worker-kit/db';
import type { Env } from '../types';

export interface WebhookRegistryDeps {
  masterDb: MasterDatabase;
  /** Front-line cache; a worker without a WORKSPACE_CACHE binding just always hits the DB. */
  kv?: KVNamespace;
}

/** Build the dependency bag for a request's `Env` — the production call-site shape. */
export function registryDeps(env: Env): WebhookRegistryDeps {
  return { masterDb: getMasterDb(env), kv: env.WORKSPACE_CACHE };
}

const REGISTRY_CACHE_TTL_SECONDS = 300;

function cacheKey(webhookId: string): string {
  return `webhook:${webhookId}`;
}

/** Sentinel cached for a known-unknown id, so repeated probes of the same bad id also skip the DB. */
const NOT_FOUND_SENTINEL = '__not_found__';

/**
 * Resolve which workspace (Clerk org id) owns a webhook id. KV-cached (both
 * hits and "not found", so a hammered bad id costs one DB round trip, not
 * one per request); on a cache miss, a single indexed lookup against the
 * master registry — never a tenant-DB scan.
 */
export async function resolveWebhookWorkspace(deps: WebhookRegistryDeps, webhookId: string): Promise<string | null> {
  const key = cacheKey(webhookId);
  const cached = await deps.kv?.get?.(key);
  if (cached === NOT_FOUND_SENTINEL) return null;
  if (cached) return cached;

  const [row] = await deps.masterDb
    .select({
      workspaceId: masterSchema.workflowWebhookRegistry.workspaceId,
      deletedAt: masterSchema.workflowWebhookRegistry.deletedAt,
    })
    .from(masterSchema.workflowWebhookRegistry)
    .where(eq(masterSchema.workflowWebhookRegistry.id, webhookId))
    .limit(1);

  if (!row || row.deletedAt) {
    await deps.kv?.put?.(key, NOT_FOUND_SENTINEL, { expirationTtl: REGISTRY_CACHE_TTL_SECONDS });
    return null;
  }

  await deps.kv?.put?.(key, row.workspaceId, { expirationTtl: REGISTRY_CACHE_TTL_SECONDS });
  return row.workspaceId;
}

/**
 * Register (or re-activate) a webhook id's owning workspace. Upserts so a
 * soft-deleted id (e.g. a previously removed trigger whose id is reused by a
 * rename-then-recreate sequence) resolves again immediately.
 */
export async function registerWebhookOwner(
  deps: WebhookRegistryDeps,
  webhookId: string,
  workspaceId: string,
): Promise<void> {
  await deps.masterDb
    .insert(masterSchema.workflowWebhookRegistry)
    .values({ id: webhookId, workspaceId, createdAt: new Date(), deletedAt: null })
    .onConflictDoUpdate({
      target: masterSchema.workflowWebhookRegistry.id,
      set: { workspaceId, deletedAt: null },
    });
  await deps.kv?.put?.(cacheKey(webhookId), workspaceId, { expirationTtl: REGISTRY_CACHE_TTL_SECONDS });
}

/** Soft-delete a webhook id's registry entry (webhook deleted, trigger removed, or workflow deleted). */
export async function deregisterWebhookOwner(deps: WebhookRegistryDeps, webhookId: string): Promise<void> {
  await deps.masterDb
    .update(masterSchema.workflowWebhookRegistry)
    .set({ deletedAt: new Date() })
    .where(eq(masterSchema.workflowWebhookRegistry.id, webhookId));
  // Re-cache the negative result rather than just deleting the key: a request
  // racing the delete would otherwise fall straight back to a DB read.
  await deps.kv?.put?.(cacheKey(webhookId), NOT_FOUND_SENTINEL, { expirationTtl: REGISTRY_CACHE_TTL_SECONDS });
}
