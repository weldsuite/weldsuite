/**
 * The password manager's trail — `weldpass_vault_events`.
 *
 * Same contract as `audit.ts`, for the same reasons: it stays off the shared
 * entity-event bus, a reveal is recorded like a write, and only titles and
 * member ids are stored. A failed write is logged loudly and swallowed, because
 * the request that caused it has usually already committed.
 */

import { and, desc, eq, lt } from 'drizzle-orm';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';
import type { WeldPassAuditContext } from './audit';

export type VaultEventAction =
  | 'vault.created'
  | 'vault.updated'
  | 'vault.deleted'
  | 'member.added'
  | 'member.role_changed'
  | 'member.removed'
  | 'item.created'
  | 'item.updated'
  | 'item.deleted'
  | 'item.restored'
  | 'item.revealed'
  | 'item.totp_generated'
  | 'item.moved_in'
  | 'item.moved_out'
  | 'items.imported';

export interface VaultEventEntry {
  vaultId: string;
  itemId?: string | null;
  actorId: string;
  action: VaultEventAction;
  /** Item title or the affected member's user id. Never a value. */
  targetLabel?: string | null;
  metadata?: Record<string, unknown>;
}

export async function recordVaultEvent(
  db: Database,
  context: WeldPassAuditContext,
  entry: VaultEventEntry,
): Promise<void> {
  try {
    await db.insert(schema.weldpassVaultEvents).values({
      id: generateId('wpx'),
      vaultId: entry.vaultId,
      itemId: entry.itemId ?? null,
      actorId: entry.actorId,
      action: entry.action,
      targetLabel: entry.targetLabel?.slice(0, 255) ?? null,
      metadata: entry.metadata ?? {},
      ip: context.ip,
      userAgent: context.userAgent,
    });
  } catch (err) {
    console.error('[weldpass] vault event write failed', {
      action: entry.action,
      vaultId: entry.vaultId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export interface VaultEventRow {
  id: string;
  itemId: string | null;
  actorId: string;
  actorName: string | null;
  action: string;
  targetLabel: string | null;
  metadata: Record<string, unknown>;
  createdAt: Date;
}

/**
 * One page of a vault's trail, newest first. Asks for one row more than the
 * page so the caller can tell whether there is another page without a count —
 * the table is append-only and unbounded.
 */
export async function listVaultEvents(
  db: Database,
  vaultId: string,
  options: { limit: number; before?: Date | null },
): Promise<VaultEventRow[]> {
  const t = schema.weldpassVaultEvents;
  const people = schema.workspaceMembers;

  return db
    .select({
      id: t.id,
      itemId: t.itemId,
      actorId: t.actorId,
      actorName: people.name,
      action: t.action,
      targetLabel: t.targetLabel,
      metadata: t.metadata,
      createdAt: t.createdAt,
    })
    .from(t)
    .leftJoin(people, eq(people.userId, t.actorId))
    .where(
      options.before
        ? and(eq(t.vaultId, vaultId), lt(t.createdAt, options.before))
        : eq(t.vaultId, vaultId),
    )
    .orderBy(desc(t.createdAt))
    .limit(options.limit + 1);
}
