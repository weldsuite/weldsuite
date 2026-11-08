import type { Context } from 'hono';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';
import { canSeeEntity, getEntityAccess, getRequestEntityId, recordInRequestEntity } from '@weldsuite/core-domain/legal-entities';

/** One resolution per request: routes and the services they call ask more than once. */
const resolvedEntityIds = new WeakMap<Context, Promise<string | null>>();

/**
 * Resolve the entity this request targets.
 *
 * Behind `legalEntityContext()` (every `/api/*` request of the worker) that
 * is the middleware's answer: `X-Legal-Entity-Id`, `X-Accounting-Entity-Id`,
 * `?entityId`, else the default entity, checked against the member's access
 * and WeldBooks being enabled for it. An entity that is unknown, deleted, not
 * visible or not in WeldBooks resolves to null, so the route refuses or lists
 * nothing instead of writing under an entity that isn't there.
 *
 * Without the middleware (cron, internal routes, unit tests that mount a
 * router alone) the old resolution applies: the `X-Accounting-Entity-Id`
 * header, `?entityId`, then `settings.defaultEntityId`.
 */
export function resolveEntityId(c: Context, db: any): Promise<string | null> {
  let resolved = resolvedEntityIds.get(c);
  if (!resolved) {
    resolved = resolveEntityIdUncached(c, db);
    resolvedEntityIds.set(c, resolved);
  }
  return resolved;
}

async function resolveEntityIdUncached(c: Context, db: any): Promise<string | null> {
  const fromMiddleware = getRequestEntityId(c);
  if (fromMiddleware) return fromMiddleware;
  const requested = c.req.header('x-accounting-entity-id') || c.req.query('entityId');
  if (requested) return (await entityExists(db, requested)) ? requested : null;

  const [settings] = await db.select().from(schema.settings).limit(1);
  const fallback: string | null = settings?.defaultEntityId ?? null;
  return fallback && (await entityExists(db, fallback)) ? fallback : null;
}

/**
 * The entity a write targets when the body may name one: that id only when it
 * is a live entity the member sees and may act in with the role this request
 * was checked with (`recordInRequestEntity`), else null; without a named
 * entity, what `resolveEntityId` resolves.
 */
export async function resolveRequestedEntityId(
  c: Context,
  db: any,
  requested: string | null | undefined,
): Promise<string | null> {
  if (!requested) return resolveEntityId(c, db);
  if (!(await entityExists(db, requested))) return null;
  // No member (a trusted internal caller): nobody's access to check.
  if (!c.get('userId')) return requested;
  const access = await getEntityAccess(c);
  if (!canSeeEntity(access, requested)) return null;
  return (await recordInRequestEntity(c, requested)) ? requested : null;
}

/** Whether an id names an accounting entity of this workspace that isn't deleted. */
export async function entityExists(db: any, entityId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: schema.entities.id })
    .from(schema.entities)
    .where(and(eq(schema.entities.id, entityId), isNull(schema.entities.deletedAt)))
    .limit(1);
  return Boolean(row);
}

/**
 * Base currency of an accounting entity. Used when a document omits
 * `currency` so INR (and other non-EUR) entities don't silently store Euro.
 */
export async function resolveEntityBaseCurrency(db: Database, entityId: string): Promise<string> {
  const [entity] = await db
    .select({ baseCurrency: schema.entities.baseCurrency })
    .from(schema.entities)
    .where(eq(schema.entities.id, entityId))
    .limit(1);
  return entity?.baseCurrency || 'EUR';
}

export const DEFAULT_SEQUENCE_PREFIX: Record<'invoice' | 'bill' | 'creditNote' | 'journal', string> = {
  invoice: 'INV-',
  bill: 'BILL-',
  creditNote: 'CN-',
  journal: 'JE-',
};

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
  const defaultPrefix = DEFAULT_SEQUENCE_PREFIX[sequenceType];

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
