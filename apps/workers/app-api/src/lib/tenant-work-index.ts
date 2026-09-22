/**
 * D1 tenant_work_index (app-api side).
 *
 * integration-webhook-worker polls due rows instead of opening every tenant
 * Neon. We own the write side for workflow_poll (active Sheets/Gmail/Calendar/
 * Airtable triggers) and webhook_retry (failed outbound deliveries).
 *
 * Best-effort — a D1 hiccup logs and returns rather than failing the request.
 */

import {
  setTenantWorkIndexEnabled,
  triggersIncludeWorkflowPoll,
  upsertTenantWorkIndex,
  type TenantWorkKind,
} from '@weldsuite/connectors';
import { and, eq, isNull } from 'drizzle-orm';
import type { Env } from '../types';
import { getWorkspaceForOrg, schema, type Database } from '../db';

async function withInternalIds(
  env: Env,
  clerkOrgId: string,
): Promise<{ workspaceId: string; clerkOrgId: string } | null> {
  try {
    const { id: workspaceId } = await getWorkspaceForOrg(env, clerkOrgId);
    return { workspaceId, clerkOrgId };
  } catch (err) {
    console.warn(`[tenant-work-index] resolve workspace failed for ${clerkOrgId}:`, err);
    return null;
  }
}

export async function upsertTenantWork(
  env: Env,
  args: {
    clerkOrgId: string;
    kind: TenantWorkKind;
    enabled?: boolean;
    dueNow?: boolean;
  },
): Promise<void> {
  const d1 = env.CONNECTOR_SYNC_INDEX;
  if (!d1) return;
  const ids = await withInternalIds(env, args.clerkOrgId);
  if (!ids) return;
  try {
    if (args.enabled === false) {
      await setTenantWorkIndexEnabled(d1, ids.workspaceId, args.kind, false);
      return;
    }
    await upsertTenantWorkIndex(d1, {
      workspaceId: ids.workspaceId,
      clerkOrgId: ids.clerkOrgId,
      kind: args.kind,
      enabled: true,
      nextDueAt: args.dueNow === false ? undefined : Date.now(),
    });
  } catch (err) {
    console.warn(`[tenant-work-index] upsert ${args.kind} failed for ${ids.workspaceId}:`, err);
  }
}

/**
 * Sync workflow_poll index for a workspace after workflow CRUD/status changes.
 * Enables when any active workflow still has a poll trigger; disables otherwise.
 */
export async function syncWorkflowPollIndex(
  env: Env,
  db: Database,
  clerkOrgId: string,
): Promise<void> {
  const d1 = env.CONNECTOR_SYNC_INDEX;
  if (!d1) return;

  let hasPoll = false;
  try {
    const rows = await db
      .select({ triggers: schema.workflows.triggers })
      .from(schema.workflows)
      .where(and(eq(schema.workflows.status, 'active'), isNull(schema.workflows.deletedAt)));
    hasPoll = rows.some((row) => triggersIncludeWorkflowPoll(row.triggers));
  } catch (err) {
    console.warn(`[tenant-work-index] workflow poll scan failed for ${clerkOrgId}:`, err);
    return;
  }

  await upsertTenantWork(env, {
    clerkOrgId,
    kind: 'workflow_poll',
    enabled: hasPoll,
    dueNow: true,
  });
}

/** Schedule webhook_retry after a failed outbound delivery (e.g. test send). */
export async function scheduleWebhookRetryIndex(env: Env, clerkOrgId: string): Promise<void> {
  await upsertTenantWork(env, {
    clerkOrgId,
    kind: 'webhook_retry',
    enabled: true,
    dueNow: true,
  });
}
