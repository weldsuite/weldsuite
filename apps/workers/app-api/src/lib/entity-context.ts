import type { Context } from 'hono';
import { sql } from 'drizzle-orm';
import { schema } from '../db';
import { generateId } from './id';

/**
 * Resolve the entity this request targets.
 * Precedence:
 *   1. `X-Accounting-Entity-Id` header (UI sends when user has switched entity)
 *   2. `?entityId=...` query param
 *   3. `settings.defaultEntityId` (workspace default)
 */
export async function resolveEntityId(c: Context, db: any): Promise<string | null> {
  const header = c.req.header('x-accounting-entity-id');
  if (header) return header;

  const queryParam = c.req.query('entityId');
  if (queryParam) return queryParam;

  const [settings] = await db.select().from(schema.settings).limit(1);
  return settings?.defaultEntityId ?? null;
}

/**
 * Allocate the next number in a per-entity sequence.
 *
 * Gapless sequential numbering is a legal requirement for Dutch invoices
 * (factuureisen), so allocation must be race-free: a single upsert increments
 * `next_value` atomically and RETURNING hands back the post-increment row.
 * Concurrent callers each get a distinct value — no select-then-update window.
 */
export async function nextEntityNumber(
  db: any,
  entityId: string,
  sequenceType: 'invoice' | 'bill' | 'creditNote' | 'journal',
): Promise<{ value: number; prefix: string; padding: number; formatted: string }> {
  const defaultPrefix =
    sequenceType === 'invoice' ? 'INV-'
    : sequenceType === 'bill' ? 'BILL-'
    : sequenceType === 'creditNote' ? 'CN-'
    : 'JE-';

  const [row] = await db
    .insert(schema.entityNumberSequences)
    .values({
      id: generateId('seq'),
      entityId,
      sequenceType,
      prefix: defaultPrefix,
      // First allocation hands out 1, so the stored next value is 2.
      nextValue: 2,
      padding: 4,
    })
    .onConflictDoUpdate({
      target: [
        schema.entityNumberSequences.entityId,
        schema.entityNumberSequences.sequenceType,
      ],
      set: {
        nextValue: sql`${schema.entityNumberSequences.nextValue} + 1`,
        updatedAt: new Date(),
      },
    })
    .returning();

  const value = row.nextValue - 1;
  const prefix = row.prefix ?? '';
  const padding = row.padding ?? 0;
  const formatted = `${prefix}${String(value).padStart(padding, '0')}`;

  return { value, prefix, padding, formatted };
}
