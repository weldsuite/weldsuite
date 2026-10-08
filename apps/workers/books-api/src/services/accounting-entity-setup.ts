/**
 * US entity setup: entity type and tax classification, the seeded chart with
 * its tax-line and 1099 mappings, address checks, time zones, the SSN of a sole
 * proprietor, and re-mapping tax lines when the classification changes.
 *
 * The chart template and the line catalogs live in `@weldsuite/books-domain`
 * (jurisdictions/us); this file is the part that touches the tenant database.
 */

import { and, eq, isNull } from 'drizzle-orm';
import { atomically } from '@weldsuite/worker-kit/atomically';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';
import type { ChartOfAccountsTemplateOptions, JurisdictionAdapter } from '@weldsuite/books-domain/jurisdictions/types';
import {
  US_ENTITY_TYPES,
  allowedTaxClassifications,
  defaultTaxClassification,
  isUsEntityType,
  isUsTaxClassification,
  isValidTaxClassification,
  taxFormForEntity,
} from '@weldsuite/books-domain/jurisdictions/us/entity-types';
import { FORM_1099_OMIT, isForm1099BoxCode } from '@weldsuite/books-domain/jurisdictions/us/form-1099';
import { validateSsn, validateZip } from '@weldsuite/books-domain/jurisdictions/us/identifiers';
import { isUsAddressStateCode } from '@weldsuite/books-domain/jurisdictions/us/states';
import {
  TAX_FORM_LABELS,
  TAX_LINE_CATEGORY_KEYS,
  getTaxLine,
  resolveTaxLine,
  type TaxReturnForm,
} from '@weldsuite/books-domain/jurisdictions/us/tax-lines';

type EntityRow = typeof schema.entities.$inferSelect;

/** Primary time zone of each state, for the default of a new US entity. */
const US_STATE_TIME_ZONES: Record<string, string> = {
  AL: 'America/Chicago', AK: 'America/Anchorage', AZ: 'America/Phoenix', AR: 'America/Chicago',
  CA: 'America/Los_Angeles', CO: 'America/Denver', CT: 'America/New_York', DE: 'America/New_York',
  DC: 'America/New_York', FL: 'America/New_York', GA: 'America/New_York', HI: 'Pacific/Honolulu',
  ID: 'America/Boise', IL: 'America/Chicago', IN: 'America/Indiana/Indianapolis', IA: 'America/Chicago',
  KS: 'America/Chicago', KY: 'America/New_York', LA: 'America/Chicago', ME: 'America/New_York',
  MD: 'America/New_York', MA: 'America/New_York', MI: 'America/Detroit', MN: 'America/Chicago',
  MS: 'America/Chicago', MO: 'America/Chicago', MT: 'America/Denver', NE: 'America/Chicago',
  NV: 'America/Los_Angeles', NH: 'America/New_York', NJ: 'America/New_York', NM: 'America/Denver',
  NY: 'America/New_York', NC: 'America/New_York', ND: 'America/Chicago', OH: 'America/New_York',
  OK: 'America/Chicago', OR: 'America/Los_Angeles', PA: 'America/New_York', RI: 'America/New_York',
  SC: 'America/New_York', SD: 'America/Chicago', TN: 'America/Chicago', TX: 'America/Chicago',
  UT: 'America/Denver', VT: 'America/New_York', VA: 'America/New_York', WA: 'America/Los_Angeles',
  WV: 'America/New_York', WI: 'America/Chicago', WY: 'America/Denver',
  PR: 'America/Puerto_Rico', VI: 'America/St_Thomas', GU: 'Pacific/Guam', AS: 'Pacific/Pago_Pago', MP: 'Pacific/Saipan',
};

export function defaultUsTimeZone(state: string | null | undefined): string {
  return (state && US_STATE_TIME_ZONES[state.toUpperCase()]) || 'America/New_York';
}

export class EntitySetupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EntitySetupError';
  }
}

// ---------------------------------------------------------------------------
// Entity type and tax classification
// ---------------------------------------------------------------------------

/**
 * The entity type and tax classification an entity ends up with. For a US
 * entity both are checked against each other (an LLC may elect S or C
 * corporation status, a sole proprietorship may not); a type without a
 * classification gets the type's default. Other jurisdictions keep whatever
 * free-form `entityType` they have and take no classification.
 */
export function resolveEntityKind(
  jurisdictionCode: string,
  input: { entityType?: string | null; taxClassification?: string | null },
  existing?: { entityType: string | null; taxClassification: string | null },
): { entityType: string | null; taxClassification: string | null } {
  const entityType = input.entityType !== undefined ? input.entityType : (existing?.entityType ?? null);
  const requestedClassification = input.taxClassification;

  if (jurisdictionCode.toUpperCase() !== 'US') {
    if (requestedClassification) throw new EntitySetupError('taxClassification applies to US entities only');
    return { entityType, taxClassification: null };
  }

  if (entityType && !isUsEntityType(entityType)) {
    throw new EntitySetupError(`entityType must be one of: ${US_ENTITY_TYPES.join(', ')}`);
  }
  if (requestedClassification && !isUsTaxClassification(requestedClassification)) {
    throw new EntitySetupError('taxClassification must be one of: sole_proprietor, disregarded, partnership, s_corp, c_corp, exempt');
  }

  let classification = requestedClassification !== undefined ? requestedClassification : (existing?.taxClassification ?? null);
  if (entityType) {
    if (classification && !isValidTaxClassification(entityType, classification)) {
      // A type change that leaves the old classification invalid falls back to the type's default; an explicit request doesn't.
      if (requestedClassification) {
        throw new EntitySetupError(
          `A ${entityType.replace(/_/g, ' ')} can't be taxed as ${classification.replace(/_/g, ' ')}. Allowed: ${allowedTaxClassifications(entityType).join(', ')}`,
        );
      }
      classification = null;
    }
    classification ??= defaultTaxClassification(entityType);
  }
  return { entityType: entityType ?? null, taxClassification: classification };
}

// ---------------------------------------------------------------------------
// Address
// ---------------------------------------------------------------------------

/** A US entity's address needs a real state code and a ZIP; returns the ZIP in canonical form. */
export function checkUsAddress<T extends { state?: string; postalCode?: string; country?: string }>(address: T | null): T | null {
  if (!address) return address;
  const next = { ...address };
  const country = next.country?.toUpperCase();
  if (country && country !== 'US' && country !== 'USA') return address;
  if (next.state) {
    const state = next.state.trim().toUpperCase();
    if (!isUsAddressStateCode(state)) throw new EntitySetupError(`'${next.state}' is not a US state or territory code`);
    next.state = state;
  }
  if (next.postalCode) {
    const zip = validateZip(next.postalCode);
    if (!zip.valid) throw new EntitySetupError(zip.error ?? 'Invalid ZIP code');
    next.postalCode = zip.formatted;
  }
  if (!next.country) next.country = 'US';
  return next;
}

// ---------------------------------------------------------------------------
// SSN
// ---------------------------------------------------------------------------

/** Validated, formatted SSN; throws for an invalid one. */
export function checkSsn(value: string): string {
  const check = validateSsn(value);
  if (!check.valid || !check.formatted) throw new EntitySetupError(check.error ?? 'Invalid SSN');
  return check.formatted;
}

/** A value of the EIN field that is really an SSN has to go to the encrypted field. */
export function looksLikeSsn(value: string): boolean {
  return /^\d{3}-?\d{2}-?\d{4}$/.test(value.trim());
}

// ---------------------------------------------------------------------------
// Tax lines and 1099 boxes
// ---------------------------------------------------------------------------

export function taxYearOf(timeZone: string | null | undefined, now = new Date()): number {
  try {
    const year = new Intl.DateTimeFormat('en-US', { timeZone: timeZone || 'UTC', year: 'numeric' }).format(now);
    return Number.parseInt(year, 10);
  } catch {
    return now.getUTCFullYear();
  }
}

export function formOfEntity(entity: Pick<EntityRow, 'entityType' | 'taxClassification'>): TaxReturnForm {
  return taxFormForEntity(entity.entityType, entity.taxClassification);
}

/** Error message when `code` isn't a line of the entity's return for the tax year; null when it is. */
export function taxLineError(entity: Pick<EntityRow, 'jurisdictionCode' | 'entityType' | 'taxClassification'>, code: string, taxYear: number): string | null {
  if (entity.jurisdictionCode !== 'US') return 'Tax lines are only available for US entities';
  const form = formOfEntity(entity);
  const line = getTaxLine(code, taxYear);
  if (!line || line.form !== form) return `'${code}' is not a line of ${TAX_FORM_LABELS[form]}`;
  return null;
}

export function form1099BoxError(code: string): string | null {
  return code === FORM_1099_OMIT || isForm1099BoxCode(code) ? null : `'${code}' is not a 1099 box code (use nec_1, misc_1, ... or omit)`;
}

// ---------------------------------------------------------------------------
// Seeding the chart
// ---------------------------------------------------------------------------

export function buildSeedAccounts(args: {
  adapter: JurisdictionAdapter;
  entityId: string;
  jurisdictionCode: string;
  baseCurrency: string;
  entityType: string | null;
  taxClassification: string | null;
  taxYear: number;
  now: Date;
}) {
  const opts: ChartOfAccountsTemplateOptions = { entityType: args.entityType, taxClassification: args.taxClassification };
  const template = args.adapter.getChartOfAccountsTemplate(opts);
  const idByCode = new Map(template.map((row) => [row.code, generateId('acc')]));
  const isUs = args.jurisdictionCode.toUpperCase() === 'US';
  const form = isUs ? taxFormForEntity(args.entityType, args.taxClassification) : null;

  return template.map((row) => ({
    id: idByCode.get(row.code)!,
    entityId: args.entityId,
    code: row.code,
    name: row.name,
    type: row.type,
    subtype: row.subtype,
    normalSide: row.normalSide,
    parentAccountId: row.parentCode ? (idByCode.get(row.parentCode) ?? null) : null,
    currency: args.baseCurrency,
    isActive: true,
    isSystemAccount: row.isSystemAccount ?? false,
    openingBalance: '0',
    currentBalance: '0',
    taxLine: form && row.taxLine ? (resolveTaxLine(row.taxLine, form, args.taxYear)?.code ?? null) : null,
    form1099Box: isUs ? (row.form1099Box ?? null) : null,
    metadata: row.systemRole ? { systemRole: row.systemRole } : undefined,
    createdAt: args.now,
    updatedAt: args.now,
  }));
}

// ---------------------------------------------------------------------------
// Re-mapping tax lines
// ---------------------------------------------------------------------------

export interface TaxLineRemapResult {
  form: TaxReturnForm;
  formLabel: string;
  taxYear: number;
  updated: number;
  unchanged: number;
  /** Accounts mapped by hand to a line of the current return, left alone. */
  keptOverrides: number;
  changes: Array<{ accountId: string; code: string; name: string; from: string | null; to: string | null }>;
  /** Accounts that still have no line (no default exists for them). */
  unmapped: Array<{ accountId: string; code: string; name: string }>;
}

/** The category of a stored line code: the first category that resolves to it on the form it was set for. */
function categoryOfLine(code: string, taxYear: number): string | null {
  const line = getTaxLine(code, taxYear);
  if (!line) return null;
  for (const category of TAX_LINE_CATEGORY_KEYS) {
    if (resolveTaxLine(category, line.form, taxYear)?.code === code) return category;
  }
  return null;
}

/**
 * Point every account at the line of the entity's current return. Seeded
 * accounts follow the chart template's category; accounts added later keep
 * their line when it is on this return, and are translated through the
 * category of their old line when it is not. A line set by hand on the
 * current return stays unless `overwrite`.
 */
export async function applyTaxLines(
  db: Database,
  entity: EntityRow,
  adapter: JurisdictionAdapter,
  opts: { overwrite: boolean; taxYear: number },
): Promise<TaxLineRemapResult> {
  const form = formOfEntity(entity);
  const { taxYear } = opts;
  const template = adapter.getChartOfAccountsTemplate({ entityType: entity.entityType, taxClassification: entity.taxClassification });
  const categoryByCode = new Map(template.filter((r) => r.taxLine).map((r) => [r.code, r.taxLine!]));

  const accounts = await db
    .select()
    .from(schema.accounts)
    .where(and(eq(schema.accounts.entityId, entity.id), isNull(schema.accounts.deletedAt)));

  const result: TaxLineRemapResult = {
    form,
    formLabel: TAX_FORM_LABELS[form],
    taxYear,
    updated: 0,
    unchanged: 0,
    keptOverrides: 0,
    changes: [],
    unmapped: [],
  };

  const updates: Array<{ id: string; taxLine: string | null }> = [];
  for (const account of accounts) {
    const current = account.taxLine;
    const currentLine = current ? getTaxLine(current, taxYear) : undefined;
    const onThisForm = currentLine?.form === form;

    const templateCategory = categoryByCode.get(account.code) ?? null;
    const category = templateCategory ?? (current ? categoryOfLine(current, taxYear) : null);
    const defaultLine = category ? (resolveTaxLine(category, form, taxYear)?.code ?? null) : null;

    let next: string | null = current;
    if (onThisForm) {
      if (defaultLine && current !== defaultLine) {
        if (opts.overwrite && templateCategory) next = defaultLine;
        else result.keptOverrides += 1;
      }
    } else {
      next = defaultLine;
    }

    if (next === current) {
      result.unchanged += 1;
      if (!next && account.type !== 'asset' && account.type !== 'liability' && account.type !== 'equity') {
        result.unmapped.push({ accountId: account.id, code: account.code, name: account.name });
      }
      continue;
    }
    updates.push({ id: account.id, taxLine: next });
    result.updated += 1;
    result.changes.push({ accountId: account.id, code: account.code, name: account.name, from: current, to: next });
    if (!next) result.unmapped.push({ accountId: account.id, code: account.code, name: account.name });
  }

  const now = new Date();
  for (let i = 0; i < updates.length; i += 100) {
    const batch = updates.slice(i, i + 100);
    await atomically(db, (h) =>
      batch.map((u) => h.update(schema.accounts).set({ taxLine: u.taxLine, updatedAt: now }).where(eq(schema.accounts.id, u.id))),
    );
  }
  return result;
}
