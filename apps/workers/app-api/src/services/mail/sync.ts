/**
 * Mail sync service — manages the `mail_accounts.syncStatus` column.
 *
 * The actual IMAP/Graph fetch loop runs out-of-band (legacy: Next.js
 * server action; planned: a Trigger.dev job per provider). This service
 * is purely the state machine that flips the row's status and stamps
 * `lastSyncAt` on completion. The route layer triggers the external
 * worker via its own binding (or a queue producer) — we just record
 * the intent here.
 *
 * Note: Cloudflare-routed inbound mail is push-driven by Email Routing,
 * so `sync` is meaningful only for pull providers (Gmail OAuth, IMAP,
 * Mailcow). Cloudflare-managed accounts will return idle immediately.
 */

import { and, eq, isNull } from 'drizzle-orm';
import { schema } from '../../db';
import type { Database } from '../../db';

const { mailAccounts } = schema;

export class MailSyncError extends Error {
  constructor(public readonly code: 'ACCOUNT_NOT_FOUND', message: string) {
    super(message);
    this.name = 'MailSyncError';
  }
}

async function findAccount(db: Database, accountId: string) {
  const [row] = await db
    .select()
    .from(mailAccounts)
    .where(and(eq(mailAccounts.id, accountId), isNull(mailAccounts.deletedAt)))
    .limit(1);
  return row ?? null;
}

/**
 * Mark an account as actively syncing. Idempotent — calling on a
 * row that's already `syncing` simply bumps `updatedAt`.
 */
export async function beginSync(db: Database, accountId: string) {
  const existing = await findAccount(db, accountId);
  if (!existing) throw new MailSyncError('ACCOUNT_NOT_FOUND', 'Mail account not found');
  await db
    .update(mailAccounts)
    .set({ syncStatus: 'syncing', updatedAt: new Date() })
    .where(eq(mailAccounts.id, accountId));
  return { accountId, status: 'syncing' as const };
}

export async function getSyncStatus(db: Database, accountId: string) {
  const existing = await findAccount(db, accountId);
  if (!existing) return null;
  return {
    status: existing.syncStatus ?? 'idle',
    lastSyncAt: existing.lastSyncAt?.toISOString() ?? null,
  };
}

export interface SyncStatusUpdate {
  status: 'idle' | 'syncing' | 'error';
  errorMessage?: string;
}

export async function setSyncStatus(
  db: Database,
  accountId: string,
  update: SyncStatusUpdate,
) {
  const existing = await findAccount(db, accountId);
  if (!existing) throw new MailSyncError('ACCOUNT_NOT_FOUND', 'Mail account not found');

  const now = new Date();
  const patch: Record<string, unknown> = {
    syncStatus: update.status,
    updatedAt: now,
  };
  // Reaching `idle` is the canonical "we just finished a sync" moment —
  // stamp lastSyncAt so the next read knows how recent the data is.
  if (update.status === 'idle') patch.lastSyncAt = now;
  // The `mail_accounts` schema doesn't have a syncError column today —
  // surface the message via the response only. When/if a column is added,
  // wire it here and skip the warning.
  if (update.errorMessage) {
    console.warn(
      `[mail-sync] error on ${accountId} (no errorMessage column yet): ${update.errorMessage}`,
    );
  }

  await db
    .update(mailAccounts)
    .set(patch)
    .where(eq(mailAccounts.id, accountId));
  return { id: accountId, status: update.status };
}
