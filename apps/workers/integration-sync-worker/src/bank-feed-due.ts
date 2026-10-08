/**
 * WeldBooks bank feed due sweep: master `bank_feed_connection_index` rows whose
 * `next_sync_at` has passed (and are active) get a sync in books-api over the
 * `BOOKS_INTERNAL` binding, one connection (one tenant) at a time.
 *
 * It is the polling path for providers without webhooks (Ponto, Enable
 * Banking, within PSD2's four unattended pulls a day) and the daily safety net
 * for the ones with them (Plaid, Stripe FC). The index only holds ids, so a
 * quiet tick never opens a tenant database. books-api owns the sync and
 * deactivates the index row itself when a connection needs the user (re-login,
 * revoked); the sweep only moves the schedule.
 */

import { and, asc, eq, inArray, isNull, lte, or } from 'drizzle-orm';
import type { NeonHttpDatabase } from 'drizzle-orm/neon-http';
import * as masterSchema from '@weldsuite/db/schema/master';

export interface BankFeedDueEnv {
  /** books-api `BooksInternal` entrypoint (weldsuite-books-api[-test]). */
  BOOKS_INTERNAL?: Fetcher;
}

export type BankFeedMasterDb = Pick<NeonHttpDatabase<typeof masterSchema>, 'select' | 'update'>;

export interface BankFeedDueRow {
  id: string;
  provider: string;
  providerConnectionId: string;
  clerkOrgId: string;
  connectionId: string;
  syncIntervalHours: number;
}

export interface BankFeedDueStore {
  listDue(now: Date, limit: number): Promise<BankFeedDueRow[]>;
  schedule(ids: string[], patch: { nextSyncAt: Date; lastTriggeredAt: Date; lastError: string | null }): Promise<void>;
  deactivate(ids: string[], reason: string): Promise<void>;
}

export interface BankFeedSweepResult {
  due: number;
  synced: number;
  failed: number;
  skipped: number;
  deactivated: number;
}

/** Connections synced per tick; the rest wait for the next one. */
export const BANK_FEED_SWEEP_LIMIT = 25;
const HOUR_MS = 3_600_000;
/** After a failed or retryable run the connection is tried again within the hour. */
export const BANK_FEED_RETRY_MS = HOUR_MS;

const t = masterSchema.bankFeedConnectionIndex;

export function masterDueStore(masterDb: BankFeedMasterDb): BankFeedDueStore {
  return {
    async listDue(now, limit) {
      return masterDb
        .select({
          id: t.id,
          provider: t.provider,
          providerConnectionId: t.providerConnectionId,
          clerkOrgId: t.clerkOrgId,
          connectionId: t.connectionId,
          syncIntervalHours: t.syncIntervalHours,
        })
        .from(t)
        .where(and(eq(t.isActive, true), or(isNull(t.nextSyncAt), lte(t.nextSyncAt, now))))
        .orderBy(asc(t.nextSyncAt))
        .limit(limit);
    },
    async schedule(ids, patch) {
      if (ids.length === 0) return;
      await masterDb.update(t).set({ ...patch, updatedAt: new Date() }).where(inArray(t.id, ids));
    },
    async deactivate(ids, reason) {
      if (ids.length === 0) return;
      await masterDb.update(t).set({ isActive: false, lastError: reason, updatedAt: new Date() }).where(inArray(t.id, ids));
    },
  };
}

interface SyncOutcomeBody {
  data?: { skipped?: string; error?: string; retryable?: boolean };
}

/** Sync every due connection and move its schedule. Pass the master DB, or a store in tests. */
export async function runBankFeedDueSweep(
  masterDb: BankFeedMasterDb | BankFeedDueStore,
  env: BankFeedDueEnv,
  now: Date = new Date(),
  limit: number = BANK_FEED_SWEEP_LIMIT,
): Promise<BankFeedSweepResult> {
  const result: BankFeedSweepResult = { due: 0, synced: 0, failed: 0, skipped: 0, deactivated: 0 };
  if (!env.BOOKS_INTERNAL) {
    console.warn('[BankFeedDue] BOOKS_INTERNAL binding not configured, skipping');
    return result;
  }
  const store = 'listDue' in masterDb ? masterDb : masterDueStore(masterDb);

  // Stripe FC indexes one row per account, so group the rows of one connection.
  const rows = await store.listDue(now, limit * 4);
  result.due = rows.length;
  const groups = new Map<string, BankFeedDueRow[]>();
  for (const row of rows) {
    const key = `${row.clerkOrgId}|${row.connectionId}`;
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }

  let processed = 0;
  for (const group of groups.values()) {
    if (processed >= limit) break;
    processed += 1;
    const [first] = group;
    if (!first) continue;
    const ids = group.map((r) => r.id);
    const intervalMs = Math.max(1, Math.min(...group.map((r) => r.syncIntervalHours))) * HOUR_MS;

    let nextAfter = intervalMs;
    let lastError: string | null = null;
    try {
      const response = await env.BOOKS_INTERNAL.fetch(`https://internal/internal/bank-connections/${encodeURIComponent(first.connectionId)}/sync`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Workspace-Id': first.clerkOrgId },
      });

      if (response.status === 404) {
        // The connection is gone from the tenant; the index row is stale.
        await store.deactivate(ids, 'Connection not found in the workspace');
        result.deactivated += 1;
        continue;
      }
      if (!response.ok) {
        result.failed += 1;
        lastError = `books-api answered ${response.status}`;
        nextAfter = BANK_FEED_RETRY_MS;
      } else {
        const body = (await response.json().catch(() => ({}))) as SyncOutcomeBody;
        const outcome = body.data ?? {};
        if (outcome.skipped === 'not_active') {
          await store.deactivate(ids, 'Connection is no longer active');
          result.deactivated += 1;
          continue;
        }
        if (outcome.skipped) {
          result.skipped += 1;
        } else if (outcome.error) {
          result.failed += 1;
          lastError = outcome.error.slice(0, 500);
          // A retryable error (rate limit, outage) is worth another go soon; one that needs the
          // user was already recorded and deactivated by books-api.
          nextAfter = outcome.retryable ? BANK_FEED_RETRY_MS : intervalMs;
        } else {
          result.synced += 1;
        }
      }
    } catch (err) {
      result.failed += 1;
      lastError = err instanceof Error ? err.message.slice(0, 500) : 'sync call failed';
      nextAfter = BANK_FEED_RETRY_MS;
      console.error(`[BankFeedDue] sync error for ${first.connectionId}:`, err instanceof Error ? err.message : err);
    }

    await store.schedule(ids, { nextSyncAt: new Date(now.getTime() + nextAfter), lastTriggeredAt: now, lastError });
  }

  return result;
}
