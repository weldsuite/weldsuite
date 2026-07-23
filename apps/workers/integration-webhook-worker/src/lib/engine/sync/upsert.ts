/**
 * Shared upsert-by-mapping — the single canonical "external record → internal
 * record" write path, used by BOTH the webhook ingress (already-mapped records)
 * and the full-sync orchestrator (adapter-fetched records). Previously this
 * logic was duplicated in `lib/sync.ts` (ingress) and `sync/orchestrator.ts`
 * (full sync), which risked drift in dedup/checksum behaviour.
 *
 * Flow:
 *   1. Existing integration mapping?  checksum match → skip;  else → update.
 *   2. No mapping → dedup by a natural key (email) → link + update.
 *   3. No match → create + write mapping.
 */

import { eq, and, isNull } from 'drizzle-orm';
import type { PgTable } from 'drizzle-orm/pg-core';
import * as schema from '@weldsuite/db/schema';
import type { Database } from '../../../db';
import { generateId } from '../../id';

export interface UpsertByMappingArgs {
  db: Database;
  connectionId: string;
  /** Mapping key — the external object type, e.g. 'company' | 'person' | 'customer'. */
  externalEntityType: string;
  externalEntityId: string;
  /** Mapping internal type, e.g. 'company' | 'person'. */
  internalEntityType: string;
  /** Target Drizzle table (must have `id`, `updatedAt`, and the dedup column). */
  table: PgTable;
  /** ID prefix for newly created rows, e.g. 'company'. */
  idPrefix: string;
  /** Final field values for insert/update — already mapped, with required defaults applied. */
  values: Record<string, unknown>;
  /** SHA-256 of the raw external record for change detection. */
  checksum: string;
  /** Natural-key column to dedup on when no mapping exists. Pass null to skip. Defaults to 'email'. */
  dedupColumn?: string | null;
}

export interface UpsertByMappingResult {
  action: 'created' | 'updated' | 'skipped';
  internalId: string;
}

export async function upsertByMapping(args: UpsertByMappingArgs): Promise<UpsertByMappingResult> {
  const {
    db, connectionId, externalEntityType, externalEntityId,
    internalEntityType, table, idPrefix, values, checksum,
  } = args;
  const dedupColumn = args.dedupColumn === undefined ? 'email' : args.dedupColumn;
  // Dynamic table column access — the engine works generically across tables
  // (companies, people, …), so column refs are resolved at runtime.
  const cols = table as unknown as Record<string, any>;

  // 1. Existing mapping?
  const [mapping] = await db
    .select()
    .from(schema.integrationEntityMappings)
    .where(
      and(
        eq(schema.integrationEntityMappings.connectionId, connectionId),
        eq(schema.integrationEntityMappings.externalEntityType, externalEntityType),
        eq(schema.integrationEntityMappings.externalEntityId, externalEntityId),
      ),
    )
    .limit(1);

  if (mapping) {
    if (mapping.syncChecksum === checksum) {
      return { action: 'skipped', internalId: mapping.internalEntityId };
    }
    await db.update(table).set({ ...values, updatedAt: new Date() } as any).where(eq(cols.id, mapping.internalEntityId));
    await db
      .update(schema.integrationEntityMappings)
      .set({ syncChecksum: checksum, lastSyncedAt: new Date(), updatedAt: new Date() })
      .where(eq(schema.integrationEntityMappings.id, mapping.id));
    return { action: 'updated', internalId: mapping.internalEntityId };
  }

  // 2. Dedup by natural key (e.g. email)
  const dedupValue = dedupColumn ? (values[dedupColumn] as string | undefined) : undefined;
  if (dedupColumn && dedupValue && cols[dedupColumn]) {
    const [match] = await db
      .select({ id: cols.id })
      .from(table)
      .where(and(eq(cols[dedupColumn], dedupValue), isNull(cols.deletedAt)))
      .limit(1);

    if (match) {
      await db.insert(schema.integrationEntityMappings).values({
        id: generateId('iem'),
        connectionId,
        externalEntityType,
        externalEntityId,
        internalEntityType,
        internalEntityId: match.id,
        lastSyncedAt: new Date(),
        syncChecksum: checksum,
      });
      await db.update(table).set({ ...values, updatedAt: new Date() } as any).where(eq(cols.id, match.id));
      return { action: 'updated', internalId: match.id };
    }
  }

  // 3. Create new
  const newId = generateId(idPrefix);
  await db.insert(table).values({ id: newId, ...values } as any);
  await db.insert(schema.integrationEntityMappings).values({
    id: generateId('iem'),
    connectionId,
    externalEntityType,
    externalEntityId,
    internalEntityType,
    internalEntityId: newId,
    lastSyncedAt: new Date(),
    syncChecksum: checksum,
  });
  return { action: 'created', internalId: newId };
}
