/**
 * Keeps `workflow_webhooks` (+ the master `workflow_webhook_registry`) in
 * step with the `webhook` triggers embedded in `workflows.triggers` — the
 * webhook-trigger twin of `workflow-schedule-sync.ts`.
 *
 * The editor only shows a webhook URL once a `workflow_webhooks` row exists,
 * but nothing created one when a workflow with a webhook trigger was saved
 * (the user-facing "A unique webhook URL will be generated when you save
 * this workflow" copy was aspirational). This bridges that: saving a workflow
 * whose triggers include an enabled `webhook` trigger provisions the row (and
 * registers its id in the master registry) if it doesn't exist yet; removing
 * or disabling the trigger retires it.
 *
 * One row per (workflow, webhook trigger id):
 *   - an enabled webhook trigger on the workflow → active row, registered in
 *     the master registry
 *   - trigger present but disabled → row kept but disabled (preserving its
 *     secret and call stats), not created if it doesn't exist yet — same
 *     "present but off" handling as `workflow-schedule-sync.ts`
 *   - trigger removed or workflow deleted → row AND registry entry
 *     soft-deleted
 *
 * Only rows whose `triggerId` belongs to the workflow's embedded triggers (now
 * or before the change) are touched; webhooks created through
 * POST /api/workflow-webhooks or /create-trigger directly (no embedded
 * trigger id yet, or a trigger id the editor manages itself) are left alone.
 */

import { and, eq, inArray, isNull } from 'drizzle-orm';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';
import { webhookTriggers, webhookTriggerIds } from './weldconnect-mvp';
import { registerWebhookOwner, deregisterWebhookOwner, type WebhookRegistryDeps } from './workflow-webhook-registry';
import { generateWebhookSecret } from '../lib/webhook-secret';

const { workflowWebhooks } = schema;

export interface WebhookSyncContext {
  /**
   * Builds the registry dependency bag on demand. A thunk, not a value: it
   * builds a master-DB client (`getMasterDb`), which is wasted work — and, on
   * a malformed `DATABASE_URL_MASTER`, throws — on EVERY workflow save, most
   * of which have no webhook trigger at all and return before this is ever
   * called (see the `managedIds.length === 0` guard below).
   */
  registry: () => WebhookRegistryDeps;
  /** Clerk org id — stored on the registry row and used to cache ownership. */
  workspaceId: string;
  /** This worker's own public origin (see lib/public-api-base.ts). */
  publicApiBase: string;
}

export interface SyncWorkflowWebhooksParams {
  workflowId: string;
  /** The workflow's triggers before this change (`[]` on create). */
  previousTriggers: unknown;
  /** The workflow's triggers after this change (`[]` on delete). */
  nextTriggers: unknown;
}

export async function syncWorkflowWebhooks(
  db: Database,
  ctx: WebhookSyncContext | undefined,
  params: SyncWorkflowWebhooksParams,
): Promise<void> {
  if (!ctx) return;
  const { workflowId } = params;
  const desired = webhookTriggers(params.nextTriggers);
  const managedIds = [
    ...new Set([...webhookTriggerIds(params.previousTriggers), ...webhookTriggerIds(params.nextTriggers)]),
  ];
  if (managedIds.length === 0) return;
  const registry = ctx.registry();

  const existing = await db
    .select()
    .from(workflowWebhooks)
    .where(
      and(
        eq(workflowWebhooks.workflowId, workflowId),
        inArray(workflowWebhooks.triggerId, managedIds),
        isNull(workflowWebhooks.deletedAt),
      ),
    );
  const existingByTrigger = new Map(existing.map((row) => [row.triggerId, row]));
  const now = new Date();

  for (const trigger of desired) {
    const row = existingByTrigger.get(trigger.triggerId);
    existingByTrigger.delete(trigger.triggerId);

    if (row) {
      if (row.isEnabled !== trigger.isEnabled) {
        await db
          .update(workflowWebhooks)
          .set({ isEnabled: trigger.isEnabled, updatedAt: now })
          .where(eq(workflowWebhooks.id, row.id));
      }
      // Registered regardless of enabled state: a disabled webhook still
      // resolves to its workspace (the receiver's own isEnabled check is what
      // rejects the call), same as a disabled schedule stays indexed.
      await registerWebhookOwner(registry, row.id, ctx.workspaceId);
      continue;
    }

    // Nothing to disable — only materialize a webhook once it should be live.
    if (!trigger.isEnabled) continue;

    const id = generateId('wh');
    const url = `/api/workflows/webhook/${id}`;
    await db.insert(workflowWebhooks).values({
      id,
      workflowId,
      triggerId: trigger.triggerId,
      name: trigger.name ?? 'Webhook',
      url,
      externalUrl: `${ctx.publicApiBase}${url}`,
      secret: generateWebhookSecret(),
      // Off by default — the unguessable URL is the credential; signing is an
      // opt-in the user enables from the editor (rotate-secret + reveal-once).
      validateSignature: false,
      signatureHeader: 'x-webhook-signature',
      allowedMethods: ['POST'],
      isEnabled: true,
      createdAt: now,
      updatedAt: now,
    });
    await registerWebhookOwner(registry, id, ctx.workspaceId);
  }

  // Whatever is left belonged to a webhook trigger that's gone entirely: retire it.
  for (const row of existingByTrigger.values()) {
    await db
      .update(workflowWebhooks)
      .set({ deletedAt: now, isEnabled: false, updatedAt: now })
      .where(eq(workflowWebhooks.id, row.id));
    await deregisterWebhookOwner(registry, row.id);
  }
}
