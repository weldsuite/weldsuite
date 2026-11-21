/**
 * Event Processor — Writes audit logs for entity mutations
 */

import type { Env } from '../env';
import type { EntityEventMessage } from '../lib/entity-events';
import { getTenantDbForWorkspace, type Database } from '../db';
import { writeAuditLogFromEvent } from './audit-log-writer';

/** Opens the tenant database of a workspace (Clerk org id or `ws_` id). */
export type TenantDbResolver = (workspaceId: string) => Promise<Database>;

/**
 * One resolver per batch: the first event of a workspace opens its tenant
 * database, the other events of the batch and the audit stream flush after
 * them reuse the handle. A failed open is not remembered, so the next event
 * tries again.
 */
export function createTenantDbResolver(env: Env): TenantDbResolver {
  const opened = new Map<string, Promise<Database>>();
  return (workspaceId) => {
    const existing = opened.get(workspaceId);
    if (existing) return existing;
    const pending = getTenantDbForWorkspace(env, workspaceId);
    opened.set(workspaceId, pending);
    pending.catch(() => opened.delete(workspaceId));
    return pending;
  };
}

/**
 * Process a single entity event: resolve tenant DB and write audit log.
 */
export async function processEntityEvent(
  event: EntityEventMessage,
  env: Env,
  tenantDb: TenantDbResolver = createTenantDbResolver(env),
): Promise<void> {
  const { workspaceId } = event.metadata;
  if (!workspaceId) {
    console.warn('[EventProcessor] Event missing workspaceId, skipping');
    return;
  }

  const db = await tenantDb(workspaceId);
  await writeAuditLogFromEvent(db, event);
}
