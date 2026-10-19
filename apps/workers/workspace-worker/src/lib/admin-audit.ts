/**
 * Writes the admin console's audit trail (`admin_audit_events`) for database
 * moves: the admin routes (who asked for what) and the move Workflow (how it
 * ended, attributed to the admin who started it).
 *
 * Recording never fails the action it describes: by the time the row is
 * written the move has usually been started or undone, so a lost audit row is
 * logged instead of turning a completed change into an error the admin would
 * retry. Details carry coordinates and ids only: never a connection string, a
 * password or row contents.
 */

import type { AdminAuditOutcome, AdminAuditTargetType } from '@weldsuite/db/schema/master';
import { masterSchema, type MasterDatabase } from '../db';
import { generateId } from './id';

const { adminAuditEvents } = masterSchema;

export interface AdminAuditEntry {
  /** The admin the action is attributed to (`email` is what the console shows). */
  actor: { email: string; userId: string | null };
  workspaceId: string | null;
  targetType: AdminAuditTargetType;
  targetId: string;
  /** Dotted verb, e.g. `database.move_start`. */
  action: string;
  outcome: AdminAuditOutcome;
  reason?: string | null;
  details?: Record<string, unknown>;
  error?: string | null;
  /**
   * A fixed row id. With one, a second write of the same entry does nothing
   * (the id is the primary key), which is how a retried Workflow step or a
   * repeated recovery records an event once.
   */
  id?: string;
}

export async function recordAdminAudit(masterDb: MasterDatabase, entry: AdminAuditEntry): Promise<void> {
  try {
    await masterDb
      .insert(adminAuditEvents)
      .values({
        id: entry.id ?? generateId('aae'),
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
      })
      .onConflictDoNothing({ target: adminAuditEvents.id });
  } catch (err) {
    // The driver's error can quote the statement; only the kind of failure is logged.
    const kind = err instanceof Error ? err.name : 'unknown error';
    console.error(
      `[Admin Audit] Failed to record ${entry.action} (${entry.outcome}) on ${entry.targetType} ${entry.targetId} by ${entry.actor.email}: ${kind}`,
    );
  }
}
