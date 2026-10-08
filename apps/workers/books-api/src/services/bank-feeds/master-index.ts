/**
 * The master-DB `bank_feed_connection_index`: provider webhooks identify a
 * connection by the provider's id, so the webhook worker looks the workspace up
 * here, and the integration-sync-worker sweeps `next_sync_at`. books-api owns
 * the writes (link, relink, disconnect).
 */

import { eq, sql } from 'drizzle-orm';
import { generateId } from '@weldsuite/worker-kit/id';
import { masterSchema, type MasterDatabase } from '@weldsuite/worker-kit/db';
import type { BankFeedIndex, BankFeedIndexRow } from './types';

const t = masterSchema.bankFeedConnectionIndex;

export function masterBankFeedIndex(masterDb: MasterDatabase): BankFeedIndex {
  return {
    async upsert(rows: BankFeedIndexRow[]): Promise<void> {
      if (rows.length === 0) return;
      const now = new Date();
      await masterDb
        .insert(t)
        .values(
          rows.map((row) => ({
            id: generateId('bfi'),
            provider: row.provider,
            providerConnectionId: row.providerConnectionId,
            clerkOrgId: row.clerkOrgId,
            connectionId: row.connectionId,
            entityId: row.entityId,
            isActive: true,
            syncIntervalHours: row.syncIntervalHours,
            nextSyncAt: row.nextSyncAt,
            createdAt: now,
            updatedAt: now,
          })),
        )
        .onConflictDoUpdate({
          target: [t.provider, t.providerConnectionId],
          set: {
            clerkOrgId: sql`excluded.clerk_org_id`,
            connectionId: sql`excluded.connection_id`,
            entityId: sql`excluded.entity_id`,
            isActive: true,
            syncIntervalHours: sql`excluded.sync_interval_hours`,
            nextSyncAt: sql`excluded.next_sync_at`,
            lastError: null,
            updatedAt: now,
          },
        });
    },

    async setActive(connectionId, active, lastError = null): Promise<void> {
      await masterDb
        .update(t)
        .set({ isActive: active, lastError, updatedAt: new Date() })
        .where(eq(t.connectionId, connectionId));
    },

    async remove(connectionId): Promise<void> {
      await masterDb.delete(t).where(eq(t.connectionId, connectionId));
    },
  };
}
