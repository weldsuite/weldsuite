/**
 * Event Processor — Writes audit logs for entity mutations
 */

import type { Env } from '../env';
import type { EntityEventMessage } from '../lib/entity-events';
import { getTenantDbForWorkspace } from '../db';
import { writeAuditLogFromEvent } from './audit-log-writer';

/**
 * Process a single entity event: resolve tenant DB and write audit log.
 */
export async function processEntityEvent(
  event: EntityEventMessage,
  env: Env,
): Promise<void> {
  const { workspaceId } = event.metadata;
  if (!workspaceId) {
    console.warn('[EventProcessor] Event missing workspaceId, skipping');
    return;
  }

  const db = await getTenantDbForWorkspace(env, workspaceId);
  await writeAuditLogFromEvent(db, event);
}
