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
import { and, eq, gte, isNull, lte } from 'drizzle-orm';
import { schema, type Database } from '../db';
import { generateId } from '../lib/id';

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
      changes: input.changes,
      userId: c.get('userId') ?? null,
      userEmail: null,
      ipAddress:
        c.req.header('cf-connecting-ip') ?? c.req.header('x-forwarded-for') ?? null,
    });
  } catch (err) {
    console.error('[accounting-audit] failed to write audit row:', err);
  }
}
