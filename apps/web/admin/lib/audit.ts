import '@tanstack/react-start/server-only';

import { getMasterDb, masterSchema } from './db';
import { generateId } from './id';
import type { AdminIdentity } from './auth';
import type { AdminAuditTargetType } from '@weldsuite/db/schema/master';

/**
 * One console audit entry. The target is the workspace; an entry about
 * something without one (a personal WeldMail account's outbound case, the
 * platform breaker) passes `workspaceId: null` and names the target itself.
 */
export type ConsoleAuditEntry = {
  identity: AdminIdentity;
  action: string;
  /** What targetId names; a workspace unless said otherwise. */
  targetType?: AdminAuditTargetType;
  outcome: 'success' | 'failure';
  reason?: string | null;
  details?: Record<string, unknown>;
  error?: string | null;
} & ({ workspaceId: string; targetId?: string } | { workspaceId: null; targetId: string });

/** The admin_audit_events row for an entry, for writing it inside a transaction too. */
export function consoleAuditRow(entry: ConsoleAuditEntry): typeof masterSchema.adminAuditEvents.$inferInsert {
  const targetId = entry.workspaceId === null ? entry.targetId : (entry.targetId ?? entry.workspaceId);
  return {
    id: generateId('aae'),
    workspaceId: entry.workspaceId,
    targetType: entry.targetType ?? 'workspace',
    targetId,
    action: entry.action,
    outcome: entry.outcome,
    actorEmail: entry.identity.email,
    actorUserId: entry.identity.userId,
    reason: entry.reason ?? null,
    details: entry.details ?? null,
    error: entry.error ?? null,
  };
}

async function insertConsoleAudit(entry: ConsoleAuditEntry): Promise<void> {
  await getMasterDb().insert(masterSchema.adminAuditEvents).values(consoleAuditRow(entry));
}

/**
 * Audit rows for changes this console makes directly in the master DB
 * (workspace deletion). Billing changes are audited by the billing worker,
 * which performs them. Never throws: the change itself already happened.
 */
export async function recordConsoleAudit(entry: ConsoleAuditEntry): Promise<void> {
  try {
    await insertConsoleAudit(entry);
  } catch (err) {
    console.error(`[Admin Audit] Failed to record ${entry.action} on ${entry.targetId ?? entry.workspaceId}:`, err);
  }
}

/**
 * For reads that must not happen unrecorded (customer mail content): record
 * first, and only go ahead when this returns true. Never throws.
 */
export async function recordConsoleAuditOrRefuse(entry: ConsoleAuditEntry): Promise<boolean> {
  try {
    await insertConsoleAudit(entry);
    return true;
  } catch (err) {
    console.error(`[Admin Audit] Failed to record ${entry.action} on ${entry.targetId ?? entry.workspaceId}:`, err);
    return false;
  }
}
