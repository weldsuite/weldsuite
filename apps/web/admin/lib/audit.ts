import 'server-only';

import { getMasterDb, masterSchema } from './db';
import { generateId } from './id';
import type { AdminIdentity } from './auth';

/**
 * Audit rows for changes this console makes directly in the master DB
 * (workspace deletion). Billing changes are audited by the billing worker,
 * which performs them. Never throws: the change itself already happened.
 */
export async function recordConsoleAudit(entry: {
  identity: AdminIdentity;
  workspaceId: string;
  action: string;
  outcome: 'success' | 'failure';
  reason?: string | null;
  details?: Record<string, unknown>;
  error?: string | null;
}): Promise<void> {
  try {
    await getMasterDb()
      .insert(masterSchema.adminAuditEvents)
      .values({
        id: generateId('aae'),
        workspaceId: entry.workspaceId,
        targetType: 'workspace',
        targetId: entry.workspaceId,
        action: entry.action,
        outcome: entry.outcome,
        actorEmail: entry.identity.email,
        actorUserId: entry.identity.userId,
        reason: entry.reason ?? null,
        details: entry.details ?? null,
        error: entry.error ?? null,
      });
  } catch (err) {
    console.error(`[Admin Audit] Failed to record ${entry.action} on ${entry.workspaceId}:`, err);
  }
}
