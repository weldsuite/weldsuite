/**
 * Accounting integrity guards.
 *
 * The Belastingdienst's administratieplicht requires a controllable,
 * reconstructable administration: bookings in closed periods must be
 * impossible, and every financial mutation must leave an audit trail.
 * These helpers are called from every posting/mutation path in the
 * accounting routes — do not bypass them.
 */

import type { Context } from 'hono';
import { and, eq, gt, gte, isNull, lte } from 'drizzle-orm';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';
import { scrubSensitiveKeys } from '@weldsuite/db/lib/sensitive-columns';

export class ClosedPeriodError extends Error {
  readonly periodName: string;
  constructor(periodName: string, date: string) {
    super(
      `Fiscal period '${periodName}' is closed — bookings dated ${date} are not allowed. Reopen the period or use a date in an open period.`,
    );
    this.name = 'ClosedPeriodError';
    this.periodName = periodName;
  }
}

/**
 * Reject a booking when its date falls inside a CLOSED fiscal period.
 * Dates with no fiscal period at all are allowed (periods are optional
 * until year-end bookkeeping starts); only an explicit closed period blocks.
 */
export async function assertPeriodOpen(
  db: Database,
  entityId: string,
  date: string | Date,
): Promise<void> {
  const iso =
    typeof date === 'string' ? date.slice(0, 10) : date.toISOString().slice(0, 10);

  const [closed] = await db
    .select({
      id: schema.fiscalPeriods.id,
      name: schema.fiscalPeriods.name,
    })
    .from(schema.fiscalPeriods)
    .where(
      and(
        eq(schema.fiscalPeriods.entityId, entityId),
        eq(schema.fiscalPeriods.status, 'closed'),
        lte(schema.fiscalPeriods.startDate, iso),
        gte(schema.fiscalPeriods.endDate, iso),
        isNull(schema.fiscalPeriods.deletedAt),
      ),
    )
    .limit(1);

  if (closed) {
    throw new ClosedPeriodError(closed.name, iso);
  }
}

/** Which lock dates apply to a posting besides the period and hard locks. */
export type PostingLockKind = 'sales' | 'purchase' | 'general';

type LockType = 'sales' | 'purchase' | 'tax' | 'period' | 'hard';

const LOCK_LABELS: Record<LockType, string> = {
  sales: 'Sales',
  purchase: 'Purchases',
  tax: 'Tax',
  period: 'The books',
  hard: 'The books (hard lock)',
};

export class LockedPeriodError extends Error {
  readonly lockType: LockType;
  readonly lockDate: string;
  constructor(lockType: LockType, lockDate: string, date: string) {
    const remedy =
      lockType === 'hard'
        ? 'The hard lock cannot be lifted; use a later date.'
        : 'Use a later date or ask an admin for a lock exception.';
    super(
      `${LOCK_LABELS[lockType]} are locked up to and including ${lockDate} — a booking dated ${date} is not allowed. ${remedy}`,
    );
    this.name = 'LockedPeriodError';
    this.lockType = lockType;
    this.lockDate = lockDate;
  }
}

function toIsoDate(date: string | Date): string {
  return typeof date === 'string' ? date.slice(0, 10) : date.toISOString().slice(0, 10);
}

/**
 * Refuse a posting that falls inside a closed fiscal period or on/before one
 * of the entity's lock dates.
 *
 * - hard lock: everything, no exceptions;
 * - period lock: everything;
 * - sales / purchase lock: postings of that kind (invoices and credit notes /
 *   bills);
 * - tax lock: postings that carry tax, so a filed return can't change.
 *
 * Every lock except the hard lock can be bypassed by an active, unrevoked
 * `lock_date_exceptions` row for the user (or for everyone).
 */
export async function assertPostingAllowed(
  db: Database,
  args: {
    entityId: string;
    date: string | Date;
    kind: PostingLockKind;
    affectsTax: boolean;
    userId?: string | null;
    now?: Date;
  },
): Promise<void> {
  await assertPeriodOpen(db, args.entityId, args.date);

  const iso = toIsoDate(args.date);
  const [entity] = await db
    .select({
      salesLockDate: schema.entities.salesLockDate,
      purchaseLockDate: schema.entities.purchaseLockDate,
      taxLockDate: schema.entities.taxLockDate,
      periodLockDate: schema.entities.periodLockDate,
      hardLockDate: schema.entities.hardLockDate,
    })
    .from(schema.entities)
    .where(eq(schema.entities.id, args.entityId))
    .limit(1);
  if (!entity) return;

  if (entity.hardLockDate && iso <= entity.hardLockDate) {
    throw new LockedPeriodError('hard', entity.hardLockDate, iso);
  }

  const candidates: Array<{ type: Exclude<LockType, 'hard'>; lockDate: string | null }> = [
    { type: 'period', lockDate: entity.periodLockDate },
  ];
  if (args.kind === 'sales') candidates.push({ type: 'sales', lockDate: entity.salesLockDate });
  if (args.kind === 'purchase') candidates.push({ type: 'purchase', lockDate: entity.purchaseLockDate });
  if (args.affectsTax) candidates.push({ type: 'tax', lockDate: entity.taxLockDate });

  const hits = candidates.filter((c): c is { type: Exclude<LockType, 'hard'>; lockDate: string } =>
    Boolean(c.lockDate && iso <= c.lockDate),
  );
  if (hits.length === 0) return;

  const now = args.now ?? new Date();
  const exceptions = await db
    .select({
      lockType: schema.lockDateExceptions.lockType,
      userId: schema.lockDateExceptions.userId,
    })
    .from(schema.lockDateExceptions)
    .where(
      and(
        eq(schema.lockDateExceptions.entityId, args.entityId),
        isNull(schema.lockDateExceptions.revokedAt),
        gt(schema.lockDateExceptions.endsAt, now),
      ),
    );

  for (const hit of hits) {
    const excepted = exceptions.some(
      (e) =>
        e.lockType === hit.type &&
        (e.userId === null || (args.userId != null && e.userId === args.userId)),
    );
    if (!excepted) throw new LockedPeriodError(hit.type, hit.lockDate, iso);
  }
}

interface KorSettings {
  enabled?: boolean;
  startDate?: string;
}

/**
 * Whether the entity is currently opted into the Dutch KOR
 * (kleineondernemersregeling). Stored under `jurisdictionSettings.kor`.
 * While active: no VAT on sales, no input-VAT deduction, no BTW-aangifte.
 * Modelled WITHOUT a 3-year lock-in (abolished 2025) — opt-out is a plain
 * settings change.
 */
export function isKorActive(
  entity: { jurisdictionCode: string; jurisdictionSettings?: Record<string, unknown> | null },
  atDate: Date = new Date(),
): boolean {
  if (entity.jurisdictionCode !== 'NL') return false;
  const kor = (entity.jurisdictionSettings?.kor ?? null) as KorSettings | null;
  if (!kor?.enabled) return false;
  if (kor.startDate && new Date(kor.startDate) > atDate) return false;
  return true;
}

export interface AccountingAuditInput {
  accountingEntityId?: string | null;
  entityType: string;
  entityId: string;
  action: string;
  changes?: Record<string, { old: unknown; new: unknown }>;
}

/** Plain-text identifiers that may be in a request body but never belong in the audit trail. */
const PLAIN_SECRET_KEYS = new Set(['tin', 'ssn', 'accountNumber', 'achAccountNumber']);

function auditSafeChanges(
  changes: AccountingAuditInput['changes'],
): AccountingAuditInput['changes'] {
  if (!changes) return changes;
  const scrubbed = scrubSensitiveKeys(changes);
  return Object.fromEntries(Object.entries(scrubbed).filter(([key]) => !PLAIN_SECRET_KEYS.has(key)));
}

/**
 * Append a row to the accounting audit log. Fire-and-forget from the
 * caller's perspective (failures are logged, never block the mutation) —
 * but note this is the tax-facing trail, distinct from publishEntityEvent's
 * platform event fan-out. Call it on every financial mutation.
 */
export async function writeAccountingAudit(
  c: Context,
  db: Database,
  input: AccountingAuditInput,
): Promise<void> {
  try {
    await db.insert(schema.auditLog).values({
      id: generateId('aud'),
      accountingEntityId: input.accountingEntityId ?? null,
      entityType: input.entityType,
      entityId: input.entityId,
      action: input.action,
      changes: auditSafeChanges(input.changes),
      userId: c.get('userId') ?? null,
      userEmail: null,
      ipAddress:
        c.req.header('cf-connecting-ip') ?? c.req.header('x-forwarded-for') ?? null,
    });
  } catch (err) {
    // Message only: a driver error can echo the bound parameters.
    console.error('[accounting-audit] failed to write audit row:', err instanceof Error ? err.message : err);
  }
}
