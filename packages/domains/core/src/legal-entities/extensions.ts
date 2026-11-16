/**
 * Apps that extend a legal entity (contract item 4 in
 * weldsuite-documentation/plans/legal-entities.md). Each says whether it is enabled for an
 * entity and whether it holds data there; together they power "Used by" and
 * block deleting an entity that still has data.
 *
 * Reading another module's tables through `@weldsuite/db` for these probes
 * is allowed by the module-split rules.
 */

import { and, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import type { LegalEntityApp } from '@weldsuite/app-api-client/schemas/legal-entities';

export interface LegalEntityExtension {
  app: LegalEntityApp;
  /** Ids (of `entityIds`) the app is enabled for. */
  enabledFor(db: Database, entityIds: readonly string[]): Promise<Set<string>>;
  /** Whether the app holds data for the entity (blocks deletion). */
  hasData(db: Database, entityId: string): Promise<boolean>;
  /**
   * Why the app forbids changing core fields its data rests on, or null when
   * the change is allowed. Only asked when the app is enabled for the entity.
   */
  lockedChange?(db: Database, entityId: string, change: LegalEntityCoreChange): Promise<string | null>;
}

/** Which of the fields that history depends on a core update changes. */
export interface LegalEntityCoreChange {
  jurisdictionCode: boolean;
  baseCurrency: boolean;
  fiscalYear: boolean;
}

function changedFields(change: LegalEntityCoreChange): string {
  return [change.baseCurrency && 'base currency', change.jurisdictionCode && 'country'].filter(Boolean).join(' and ');
}

const firstRow = { n: sql<number>`1` };

async function exists(query: PromiseLike<unknown[]>): Promise<boolean> {
  return (await query).length > 0;
}

/**
 * Finalized WeldBooks records: the same definition as books-api's
 * `entityHasPostings` (services/accounting-entity-lock.ts), which guards
 * WeldBooks' own PATCH. Keep the two in step.
 */
async function booksHasPostings(db: Database, entityId: string): Promise<boolean> {
  const checks = await Promise.all([
    exists(
      db
        .select(firstRow)
        .from(schema.journalEntries)
        .where(
          and(
            eq(schema.journalEntries.entityId, entityId),
            ne(schema.journalEntries.status, 'draft'),
            isNull(schema.journalEntries.deletedAt),
          ),
        )
        .limit(1),
    ),
    exists(
      db
        .select(firstRow)
        .from(schema.invoices)
        .where(and(eq(schema.invoices.entityId, entityId), ne(schema.invoices.status, 'draft'), isNull(schema.invoices.deletedAt)))
        .limit(1),
    ),
    exists(
      db
        .select(firstRow)
        .from(schema.bills)
        .where(and(eq(schema.bills.entityId, entityId), ne(schema.bills.status, 'draft'), isNull(schema.bills.deletedAt)))
        .limit(1),
    ),
    exists(
      db
        .select(firstRow)
        .from(schema.payments)
        .where(and(eq(schema.payments.entityId, entityId), isNull(schema.payments.deletedAt)))
        .limit(1),
    ),
    exists(
      db
        .select(firstRow)
        .from(schema.vatReturns)
        .where(
          and(eq(schema.vatReturns.entityId, entityId), ne(schema.vatReturns.status, 'draft'), isNull(schema.vatReturns.deletedAt)),
        )
        .limit(1),
    ),
  ]);
  return checks.some(Boolean);
}

async function anyRow(db: Database, query: ReturnType<typeof sql>): Promise<boolean> {
  const result = (await db.execute(query)) as unknown as { rows?: unknown[] } | unknown[];
  const rows = Array.isArray(result) ? result : (result.rows ?? []);
  return rows.length > 0;
}

export const LEGAL_ENTITY_EXTENSIONS: readonly LegalEntityExtension[] = [
  {
    app: 'weldbooks',
    // A WeldBooks extension row means WeldBooks is enabled for the entity.
    async enabledFor(db, entityIds) {
      if (entityIds.length === 0) return new Set();
      const rows = await db
        .select({ id: schema.accountingEntitySettings.entityId })
        .from(schema.accountingEntitySettings)
        .where(inArray(schema.accountingEntitySettings.entityId, [...entityIds]));
      return new Set(rows.map((r) => r.id));
    },
    async hasData(db, entityId) {
      return anyRow(
        db,
        sql`select 1 from invoices where entity_id = ${entityId}
            union all select 1 from bills where entity_id = ${entityId}
            union all select 1 from journal_entries where entity_id = ${entityId}
            limit 1`,
      );
    },
    // Base currency, country and fiscal year decide how posted amounts, tax
    // lines and periods were computed; changing them would re-read history.
    async lockedChange(db, entityId, change) {
      if (!change.jurisdictionCode && !change.baseCurrency && !change.fiscalYear) return null;
      const postings = await booksHasPostings(db, entityId);
      if (postings && (change.jurisdictionCode || change.baseCurrency)) {
        return `The ${changedFields(change)} of this legal entity can no longer be changed because WeldBooks has posted transactions for it. Create a new legal entity instead.`;
      }
      if (!change.fiscalYear) return null;
      if (postings) return 'The fiscal year of this legal entity can no longer be changed because WeldBooks has posted transactions for it.';
      const periods = await exists(
        db
          .select(firstRow)
          .from(schema.fiscalPeriods)
          .where(and(eq(schema.fiscalPeriods.entityId, entityId), isNull(schema.fiscalPeriods.deletedAt)))
          .limit(1),
      );
      return periods
        ? 'The fiscal year of this legal entity can no longer be changed because WeldBooks has generated fiscal periods for it.'
        : null;
    },
  },
  {
    app: 'weldhr',
    // WeldHR works with any legal entity: employees and payroll registrations
    // attach to it without an extension row.
    async enabledFor(_db, entityIds) {
      return new Set(entityIds);
    },
    async hasData(db, entityId) {
      const [employee] = await db
        .select({ id: schema.hrEmployees.id })
        .from(schema.hrEmployees)
        .where(and(eq(schema.hrEmployees.legalEntityId, entityId), isNull(schema.hrEmployees.deletedAt)))
        .limit(1);
      if (employee) return true;
      const [employer] = await db
        .select({ id: schema.hrPayrollEmployers.id })
        .from(schema.hrPayrollEmployers)
        .where(and(eq(schema.hrPayrollEmployers.legalEntityId, entityId), isNull(schema.hrPayrollEmployers.deletedAt)))
        .limit(1);
      return Boolean(employer);
    },
    // Payroll is computed under the entity's country and in its currency.
    async lockedChange(db, entityId, change) {
      if (!change.jurisdictionCode && !change.baseCurrency) return null;
      const [run] = await db
        .select({ id: schema.hrPayRuns.id })
        .from(schema.hrPayRuns)
        .innerJoin(schema.hrPayrollEmployers, eq(schema.hrPayrollEmployers.id, schema.hrPayRuns.employerId))
        .where(eq(schema.hrPayrollEmployers.legalEntityId, entityId))
        .limit(1);
      return run
        ? `The ${changedFields(change)} of this legal entity can no longer be changed because WeldHR has pay runs for it. Create a new legal entity instead.`
        : null;
    },
  },
];

export function getLegalEntityExtension(app: LegalEntityApp): LegalEntityExtension {
  const extension = LEGAL_ENTITY_EXTENSIONS.find((e) => e.app === app);
  if (!extension) throw new Error(`No legal entity extension for app ${app}`);
  return extension;
}

/** Per entity id, the apps enabled for it. */
export async function enabledAppsByEntity(
  db: Database,
  entityIds: readonly string[],
): Promise<Map<string, LegalEntityApp[]>> {
  const result = new Map<string, LegalEntityApp[]>(entityIds.map((id) => [id, []]));
  for (const extension of LEGAL_ENTITY_EXTENSIONS) {
    const enabled = await extension.enabledFor(db, entityIds);
    for (const id of enabled) result.get(id)?.push(extension.app);
  }
  return result;
}

/** The reason an enabled app forbids the change, or null. */
export async function lockedCoreChange(
  db: Database,
  entityId: string,
  change: LegalEntityCoreChange,
): Promise<string | null> {
  if (!change.jurisdictionCode && !change.baseCurrency && !change.fiscalYear) return null;
  for (const extension of LEGAL_ENTITY_EXTENSIONS) {
    if (!extension.lockedChange) continue;
    const enabled = await extension.enabledFor(db, [entityId]);
    if (!enabled.has(entityId)) continue;
    const reason = await extension.lockedChange(db, entityId, change);
    if (reason) return reason;
  }
  return null;
}
