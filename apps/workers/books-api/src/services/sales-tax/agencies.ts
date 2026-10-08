/**
 * Sales tax agencies (docs/plans/weldbooks-us.md §5): one row per state, plus
 * self-administered local agencies (Colorado home-rule cities and the like).
 *
 * Registering an agency creates its two child liability accounts, "Sales Tax
 * Payable - <agency>" under the Sales Tax Payable role account and "Use Tax
 * Payable - <agency>" under Use Tax Payable, so the balance sheet shows what
 * is owed per agency. It also seeds the taxability rules for shipping and
 * handling from what the state is known to do, which the manual engine reads.
 */

import { and, eq, isNull, sql } from 'drizzle-orm';
import { atomically } from '@weldsuite/worker-kit/atomically';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';
import { getUsState, shippingTaxability } from '@weldsuite/books-domain/jurisdictions/us/states';
import { SalesTaxSetupError } from './errors';

type AgencyRow = typeof schema.salesTaxAgencies.$inferSelect;
type AccountRow = typeof schema.accounts.$inferSelect;

export type AgencyStatus = 'registered' | 'pending' | 'monitoring' | 'closed';
export type FilingFrequency = 'monthly' | 'quarterly' | 'semiannual' | 'annual';

export interface AgencyInput {
  stateCode: string;
  level?: 'state' | 'local';
  localJurisdictionCode?: string | null;
  name?: string;
  registrationNumber?: string | null;
  registeredFrom?: string | null;
  registeredUntil?: string | null;
  status?: AgencyStatus;
  filingFrequency?: FilingFrequency;
  firstPeriodStart?: string | null;
  dueDay?: number;
  reportingBasis?: 'accrual' | 'cash';
  sstMember?: boolean;
  portalUrl?: string | null;
  notes?: string | null;
}

/** The date a rule seeded for a new agency takes effect: before any invoice a user would write. */
export const SEEDED_RULE_START = '2000-01-01';

const EN_DASH = '–';

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function monthStart(day: string): string {
  return `${day.slice(0, 7)}-01`;
}

/** The state of an agency, validated against the US states (DC included). */
function requireState(code: string) {
  const info = getUsState(code);
  if (!info) throw new SalesTaxSetupError(`"${code}" is not a US state code (use the two-letter USPS code, e.g. TX)`);
  if (!info.hasStateSalesTax && !info.hasLocalSalesTax) {
    throw new SalesTaxSetupError(`${info.name} has no state or local sales tax, so there is nothing to register for`);
  }
  return info;
}

/** Defaults and checks shared by create and update; the filled-in agency fields. */
export function resolveAgencyFields(input: AgencyInput) {
  const info = requireState(input.stateCode);
  const level = input.level ?? 'state';

  if (level === 'local') {
    if (!info.specialPrograms?.includes('home_rule_local_agencies')) {
      throw new SalesTaxSetupError(`${info.name} has no self-administered local agencies; local tax is reported to the state`);
    }
    if (!input.name?.trim()) throw new SalesTaxSetupError('A local agency needs a name (the city or district that administers its own tax)');
    if (!input.localJurisdictionCode?.trim()) throw new SalesTaxSetupError('A local agency needs its jurisdiction code');
  }

  const reportingBasis = input.reportingBasis ?? 'accrual';
  if (reportingBasis === 'cash' && level === 'state' && !info.cashBasisAllowed) {
    throw new SalesTaxSetupError(`${info.name} requires sales tax to be reported on the accrual basis`);
  }

  const dueDay = input.dueDay ?? (info.defaultDueDay === 'last' ? 31 : info.defaultDueDay);
  if (!Number.isInteger(dueDay) || dueDay < 1 || dueDay > 31) throw new SalesTaxSetupError('The due day is a day of the month, 1 to 31');

  const registeredFrom = input.registeredFrom ?? null;
  const registeredUntil = input.registeredUntil ?? null;
  if (registeredFrom && registeredUntil && registeredUntil < registeredFrom) {
    throw new SalesTaxSetupError('The registration end date is before its start date');
  }

  return {
    stateCode: info.code,
    stateName: info.name,
    level,
    localJurisdictionCode: level === 'local' ? (input.localJurisdictionCode?.trim() ?? null) : null,
    name: input.name?.trim() || info.agencyName || `${info.name} Department of Revenue`,
    registrationNumber: input.registrationNumber?.trim() || null,
    registeredFrom,
    registeredUntil,
    status: input.status ?? 'registered',
    filingFrequency: input.filingFrequency ?? 'quarterly',
    firstPeriodStart: input.firstPeriodStart ?? monthStart(registeredFrom ?? today()),
    dueDay,
    reportingBasis,
    sstMember: input.sstMember ?? info.sst !== 'none',
    portalUrl: input.portalUrl ?? info.portalUrl ?? null,
    notes: input.notes?.trim() || null,
  };
}

interface AccountPlan {
  id: string;
  /** The account exists already (an agency re-registered after being deleted). */
  reused: boolean;
  row?: typeof schema.accounts.$inferInsert;
}

function numericCode(code: string): number | null {
  return /^\d+$/.test(code) ? Number(code) : null;
}

/**
 * The child account for an agency under `parent`: the first free code after the
 * parent's (2200 → 2201 … 2209), then `<parent>-<n>`.
 */
function planChild(
  parent: AccountRow,
  name: string,
  existing: AccountRow[],
  usedCodes: Set<string>,
  now: Date,
  entityId: string,
): AccountPlan {
  const reusable = existing.find((a) => a.parentAccountId === parent.id && a.name === name);
  if (reusable) return { id: reusable.id, reused: true };

  const base = numericCode(parent.code);
  let code: string | undefined;
  if (base !== null) {
    for (let i = 1; i <= 9 && !code; i += 1) {
      const candidate = String(base + i);
      if (!usedCodes.has(candidate)) code = candidate;
    }
  }
  for (let n = 1; !code; n += 1) {
    const candidate = `${parent.code}-${n}`;
    if (!usedCodes.has(candidate)) code = candidate;
  }
  usedCodes.add(code);

  const id = generateId('acc');
  return {
    id,
    reused: false,
    row: {
      id,
      entityId,
      code,
      name,
      type: 'liability',
      subtype: parent.subtype ?? 'tax_payable',
      normalSide: 'credit',
      parentAccountId: parent.id,
      currency: parent.currency,
      isActive: true,
      isSystemAccount: false,
      openingBalance: '0',
      currentBalance: '0',
      taxLine: parent.taxLine,
      // Not a system role: the role lookup must keep finding the parent.
      metadata: { salesTaxAgencyAccount: true },
      createdAt: now,
      updatedAt: now,
    },
  };
}

async function loadAccounts(db: Database, entityId: string): Promise<AccountRow[]> {
  return db
    .select()
    .from(schema.accounts)
    .where(and(eq(schema.accounts.entityId, entityId), isNull(schema.accounts.deletedAt)));
}

function parentByRole(accounts: AccountRow[], role: string, fallbackCode: string): AccountRow | undefined {
  return (
    accounts.find((a) => (a.metadata as { systemRole?: string } | null)?.systemRole === role) ??
    accounts.find((a) => a.code === fallbackCode)
  );
}

/** The rules a new agency starts with: how the state treats separately stated shipping and handling. */
function shippingRules(entityId: string, agencyId: string, stateCode: string, now: Date) {
  const treatment = shippingTaxability(stateCode);
  const rules: Array<typeof schema.salesTaxTaxabilityRules.$inferInsert> = [];
  for (const taxCode of ['shipping', 'handling'] as const) {
    const how = treatment[taxCode];
    // Following the goods is the engines' default for an unlisted code, so it needs no rule.
    if (how === 'follows_goods') continue;
    const taxable = how === 'taxable';
    rules.push({
      id: generateId('str'),
      entityId,
      agencyId,
      taxCode,
      taxable,
      taxablePercent: '100',
      appliesToUse: 'any',
      effectiveFrom: SEEDED_RULE_START,
      notes: taxable
        ? `${taxCode} is taxable in ${stateCode} (seeded from the state's usual treatment; confirm before relying on it)`
        : `${taxCode} is not taxable in ${stateCode} when stated separately (seeded; confirm before relying on it)`,
      createdAt: now,
      updatedAt: now,
    });
  }
  return rules;
}

/**
 * Create an agency with its two child accounts and its seeded shipping and
 * handling rules, in one batch. A state has one state-level agency per entity
 * (a deleted one can be registered again; its accounts are reused).
 */
export async function createSalesTaxAgency(
  db: Database,
  entityId: string,
  input: AgencyInput,
): Promise<{ agency: AgencyRow; accountsCreated: number; rulesSeeded: number }> {
  const fields = resolveAgencyFields(input);

  const [duplicate] = await db
    .select({ id: schema.salesTaxAgencies.id })
    .from(schema.salesTaxAgencies)
    .where(
      and(
        eq(schema.salesTaxAgencies.entityId, entityId),
        eq(schema.salesTaxAgencies.stateCode, fields.stateCode),
        eq(schema.salesTaxAgencies.level, fields.level),
        fields.level === 'local'
          ? eq(schema.salesTaxAgencies.localJurisdictionCode, fields.localJurisdictionCode ?? '')
          : sql`true`,
        isNull(schema.salesTaxAgencies.deletedAt),
      ),
    )
    .limit(1);
  if (duplicate) {
    throw new SalesTaxSetupError(
      fields.level === 'local'
        ? `This entity already has an agency for ${fields.name}`
        : `This entity already has a ${fields.stateName} agency. Edit it instead of adding another.`,
      409,
    );
  }

  const accounts = await loadAccounts(db, entityId);
  const salesParent = parentByRole(accounts, 'sales_tax_payable', '2200');
  const useParent = parentByRole(accounts, 'use_tax_payable', '2210');
  if (!salesParent || !useParent) {
    throw new SalesTaxSetupError(
      'This accounting entity has no Sales Tax Payable and Use Tax Payable accounts. Create the entity from the US chart of accounts first.',
    );
  }

  const now = new Date();
  const usedCodes = new Set(accounts.map((a) => a.code));
  const liability = planChild(salesParent, `Sales Tax Payable ${EN_DASH} ${fields.name}`, accounts, usedCodes, now, entityId);
  const use = planChild(useParent, `Use Tax Payable ${EN_DASH} ${fields.name}`, accounts, usedCodes, now, entityId);

  const { stateName: _stateName, ...agencyFields } = fields;
  const agency = {
    id: generateId('sta'),
    entityId,
    ...agencyFields,
    liabilityAccountId: liability.id,
    useTaxAccountId: use.id,
    createdAt: now,
    updatedAt: now,
  };
  const rules = shippingRules(entityId, agency.id, fields.stateCode, now);
  const newAccounts = [liability.row, use.row].filter((row): row is NonNullable<typeof row> => Boolean(row));

  await atomically(db, (h) => [
    ...(newAccounts.length > 0 ? [h.insert(schema.accounts).values(newAccounts)] : []),
    h.insert(schema.salesTaxAgencies).values(agency),
    ...(rules.length > 0 ? [h.insert(schema.salesTaxTaxabilityRules).values(rules)] : []),
  ]);

  const [row] = await db.select().from(schema.salesTaxAgencies).where(eq(schema.salesTaxAgencies.id, agency.id)).limit(1);
  return { agency: row, accountsCreated: newAccounts.length, rulesSeeded: rules.length };
}

/** Tax-ledger rows that reference an agency: a registration that has been used can only be closed. */
export async function agencyHasTaxLines(db: Database, agencyId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: schema.taxLines.id })
    .from(schema.taxLines)
    .where(eq(schema.taxLines.agencyId, agencyId))
    .limit(1);
  return Boolean(row);
}

export { requireState as requireSalesTaxState };
