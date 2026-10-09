/**
 * Webhook events from the providers, already verified and normalized by
 * integration-webhook-worker. Status events update the connection (and the
 * affected accounts); `sync_available` only says a sync is worth running.
 */

import { and, eq, isNull, sql } from 'drizzle-orm';
import { connectionStatus, type ConnectionStatus, type FeedEvent } from '@weldsuite/bank-feeds';
import { schema } from '@weldsuite/worker-kit/db';
import { loadConnection, storedFeedAccounts } from './connections';
import { INACTIVE_STATUSES, type FeedContext } from './types';

const connections = schema.bankConnections;
const bankAccounts = schema.bankAccounts;

export interface EventResult {
  /** The connection is unknown here (deleted); the index row is stale. */
  missing?: boolean;
  needsSync: boolean;
  status: ConnectionStatus;
  changed: boolean;
}

const DEFAULT_MESSAGES: Record<string, string> = {
  reauth_required: 'The bank needs you to sign in again.',
  revoked: 'Access was revoked at the bank.',
  disconnected: 'The account was disconnected at the bank.',
  expiring: 'The bank connection expires soon.',
  error: 'The provider reported an error.',
};

export async function applyFeedEvent(ctx: FeedContext, connectionId: string, event: FeedEvent): Promise<EventResult> {
  const row = await loadConnection(ctx.db, connectionId);
  if (!row) return { missing: true, needsSync: false, status: 'disconnected', changed: false };
  const current = row.status as ConnectionStatus;

  if (event.type === 'sync_available') {
    return { needsSync: current !== 'disconnected' && current !== 'revoked', status: current, changed: false };
  }

  const target: ConnectionStatus = event.type;
  const feedAccounts = storedFeedAccounts(row);
  const scopedIds = event.accountIds?.length ? new Set(event.accountIds) : null;
  const scoped = scopedIds ? feedAccounts.filter((fa) => scopedIds.has(fa.providerAccountId)) : feedAccounts;
  // Events for accounts a relink replaced are stale.
  if (scoped.length === 0 && feedAccounts.length > 0) return { needsSync: false, status: current, changed: false };

  const softStatus = target === 'expiring' || target === 'error';
  const updated = feedAccounts.map((fa) => {
    if (!scoped.some((s) => s.providerAccountId === fa.providerAccountId)) return fa;
    // "Expiring" and "error" never hide a harder state the account is already in.
    if (softStatus && fa.status !== 'active') return fa;
    return { ...fa, status: target };
  });

  const mappedIds = new Set(
    (
      await ctx.db
        .select({ feedAccountId: bankAccounts.feedAccountId })
        .from(bankAccounts)
        .where(and(eq(bankAccounts.feedConnectionId, row.id), isNull(bankAccounts.deletedAt)))
    )
      .map((a) => a.feedAccountId)
      .filter((id): id is string => id !== null),
  );
  const rollup = updated.filter((fa) => mappedIds.has(fa.providerAccountId));
  const nextStatus = connectionStatus((rollup.length > 0 ? rollup : updated).map((fa) => fa.status));

  const timestamp = ctx.now ? ctx.now() : new Date();
  const message = (event.message ?? DEFAULT_MESSAGES[event.type] ?? null)?.slice(0, 500) ?? null;
  const expiresAt = event.type === 'expiring' && event.expiresAt ? new Date(event.expiresAt) : null;

  await ctx.db
    .update(connections)
    .set({
      status: nextStatus,
      lastError: nextStatus === 'active' ? row.lastError : message,
      ...(expiresAt && !Number.isNaN(expiresAt.getTime()) ? { consentExpiresAt: expiresAt } : {}),
      metadata: sql`(coalesce(${connections.metadata}, '{}'::jsonb) || ${JSON.stringify({ feedAccounts: updated })}::jsonb)`,
      updatedAt: timestamp,
    })
    .where(eq(connections.id, row.id));

  const touchedFeedIds = updated.filter((fa, i) => fa.status !== feedAccounts[i]?.status).map((fa) => fa.providerAccountId);
  if (touchedFeedIds.length > 0) {
    for (const fa of updated.filter((u) => touchedFeedIds.includes(u.providerAccountId))) {
      await ctx.db
        .update(bankAccounts)
        .set({ feedStatus: fa.status, updatedAt: timestamp })
        .where(
          and(
            eq(bankAccounts.feedConnectionId, row.id),
            eq(bankAccounts.feedAccountId, fa.providerAccountId),
            isNull(bankAccounts.deletedAt),
          ),
        );
    }
  }

  if (INACTIVE_STATUSES.has(nextStatus) && !INACTIVE_STATUSES.has(current)) {
    await ctx.index.setActive(row.id, false, message);
  }

  return { needsSync: false, status: nextStatus, changed: nextStatus !== current || touchedFeedIds.length > 0 };
}
