/**
 * Writes the admin console's audit trail (`admin_audit_events`).
 *
 * Recording never fails the action it describes: by the time we write the row
 * Stripe has usually already been called, so a lost audit row is logged loudly
 * instead of turning a completed change into an error the admin would retry.
 */

import type { AdminAuditOutcome, AdminAuditTargetType } from '@weldsuite/db/schema/master';
import { type getMasterDb, masterSchema } from './db';
import { generateId } from './id';

const { adminAuditEvents } = masterSchema;

/** Actor for changes the billing worker makes on its own (the comp sweep). */
export const SYSTEM_ACTOR = { email: 'system', userId: null } as const;

export interface AdminAuditEntry {
  actor: { email: string; userId: string | null };
  workspaceId: string | null;
  targetType: AdminAuditTargetType;
  targetId: string;
  action: string;
  outcome: AdminAuditOutcome;
  reason?: string | null;
  details?: Record<string, unknown>;
  error?: string | null;
}

export async function recordAdminAudit(
  masterDb: ReturnType<typeof getMasterDb>,
  entry: AdminAuditEntry,
): Promise<void> {
  try {
    await masterDb.insert(adminAuditEvents).values({
      id: generateId('aae'),
      workspaceId: entry.workspaceId,
      targetType: entry.targetType,
      targetId: entry.targetId,
      action: entry.action,
      outcome: entry.outcome,
      actorEmail: entry.actor.email,
      actorUserId: entry.actor.userId,
      reason: entry.reason ?? null,
      details: entry.details ?? null,
      error: entry.error ?? null,
    });
  } catch (err) {
    console.error(
      `[Admin Audit] Failed to record ${entry.action} (${entry.outcome}) on ${entry.targetType} ${entry.targetId} by ${entry.actor.email}:`,
      err,
    );
  }
}
