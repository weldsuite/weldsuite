/**
 * Reading the tax ledger (`tax_lines`) for returns and tax reports.
 *
 * Amounts are taken in the entity's base currency. Rows are selected by tax
 * date, so a correction (credit note, reversal) counts in the period it was
 * made, which is how both the Dutch return and US sales tax returns want it.
 */

import { and, eq, gte, isNull, lte } from 'drizzle-orm';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import type { VatRubrieken } from '@weldsuite/db/schema';
import { computeNlRubrieken } from '@weldsuite/books-domain/jurisdictions/nl';
import type { TaxReturnLine } from '@weldsuite/books-domain/jurisdictions/types';

export function isoDate(date: Date | string): string {
  return typeof date === 'string' ? date.slice(0, 10) : date.toISOString().slice(0, 10);
}

export interface PeriodTaxLine extends TaxReturnLine {
  contactId: string | null;
  taxReturnId: string | null;
}

/** All tax-ledger rows of an entity with a tax date inside the period (inclusive). */
export async function loadTaxLinesForPeriod(
  db: Database,
  entityId: string,
  periodStart: Date | string,
  periodEnd: Date | string,
): Promise<PeriodTaxLine[]> {
  const rows = await db
    .select({
      taxRateId: schema.taxLines.taxRateId,
      taxCategoryCode: schema.taxLines.taxCategoryCode,
      direction: schema.taxLines.direction,
      selfAssessed: schema.taxLines.selfAssessed,
      baseTaxableAmount: schema.taxLines.baseTaxableAmount,
      baseTaxAmount: schema.taxLines.baseTaxAmount,
      contactId: schema.taxLines.contactId,
      taxReturnId: schema.taxLines.taxReturnId,
      jurisdictionMetadata: schema.taxRates.jurisdictionMetadata,
    })
    .from(schema.taxLines)
    .leftJoin(schema.taxRates, eq(schema.taxLines.taxRateId, schema.taxRates.id))
    .where(
      and(
        eq(schema.taxLines.entityId, entityId),
        gte(schema.taxLines.taxDate, isoDate(periodStart)),
        lte(schema.taxLines.taxDate, isoDate(periodEnd)),
      ),
    );

  return rows.map((r) => ({
    taxRateId: r.taxRateId ?? '',
    taxCategoryCode: r.taxCategoryCode ?? '',
    direction: r.direction === 'purchase' ? 'purchase' : 'sales',
    selfAssessed: r.selfAssessed,
    taxableAmount: Number(r.baseTaxableAmount),
    taxAmount: Number(r.baseTaxAmount),
    contactId: r.contactId,
    taxReturnId: r.taxReturnId,
    jurisdictionMetadata: (r.jurisdictionMetadata as Record<string, unknown> | null) ?? undefined,
  }));
}

/** The Dutch BTW rubrieken for a period, from the tax ledger. */
export async function nlRubriekenForPeriod(
  db: Database,
  entityId: string,
  periodStart: Date | string,
  periodEnd: Date | string,
): Promise<VatRubrieken> {
  return computeNlRubrieken(await loadTaxLinesForPeriod(db, entityId, periodStart, periodEnd));
}

/**
 * Statements that stamp a filed return onto the period's unfiled tax-ledger
 * rows and move the entity's tax lock date up to the period end, so nothing
 * can be posted into a filed period afterwards (only a logged exception can).
 */
export function fileTaxPeriodStatements(
  h: Database,
  args: { entityId: string; periodStart: Date | string; periodEnd: Date | string; taxReturnId: string; currentTaxLockDate: string | null },
): unknown[] {
  const end = isoDate(args.periodEnd);
  const statements: unknown[] = [
    h
      .update(schema.taxLines)
      .set({ taxReturnId: args.taxReturnId })
      .where(
        and(
          eq(schema.taxLines.entityId, args.entityId),
          gte(schema.taxLines.taxDate, isoDate(args.periodStart)),
          lte(schema.taxLines.taxDate, end),
          isNull(schema.taxLines.taxReturnId),
        ),
      ),
  ];
  if (!args.currentTaxLockDate || args.currentTaxLockDate < end) {
    statements.push(
      h.update(schema.entities).set({ taxLockDate: end, updatedAt: new Date() }).where(eq(schema.entities.id, args.entityId)),
    );
  }
  return statements;
}
