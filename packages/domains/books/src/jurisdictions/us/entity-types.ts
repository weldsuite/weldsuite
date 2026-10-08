/**
 * US business entity types, their federal tax classification and the return
 * each files (docs/plans/weldbooks-us-research/federal.md §3).
 *
 * `entities.entity_type` holds a `UsEntityType`; `entities.tax_classification`
 * holds a `UsTaxClassification`. The classification is how the IRS taxes the
 * business, and for an LLC it is a choice: a single-member LLC is disregarded
 * (reported on the owner's Schedule C) unless it elects corporate status (Form
 * 8832) or S corporation status (Form 2553); a multi-member LLC is a
 * partnership unless it elects the same.
 *
 * Income-tax due dates per return belong to the tax calendar, not here.
 */

import type { TaxReturnForm } from './tax-lines';

export type UsEntityType =
  | 'sole_proprietorship'
  | 'single_member_llc'
  | 'multi_member_llc'
  | 'partnership'
  | 's_corp'
  | 'c_corp'
  | 'nonprofit';

export type UsTaxClassification =
  | 'sole_proprietor'
  | 'disregarded'
  | 'partnership'
  | 's_corp'
  | 'c_corp'
  | 'exempt';

/**
 * Which equity section of the chart an entity gets (`chart-of-accounts.ts`).
 * It follows the tax classification, not the legal form: an LLC that elected
 * S corporation status keeps its books like an S corporation.
 */
export type UsEquityModel = 'sole_proprietor' | 'partnership' | 's_corp' | 'c_corp' | 'nonprofit';

export const US_ENTITY_TYPES: readonly UsEntityType[] = [
  'sole_proprietorship',
  'single_member_llc',
  'multi_member_llc',
  'partnership',
  's_corp',
  'c_corp',
  'nonprofit',
];

export const US_TAX_CLASSIFICATIONS: readonly UsTaxClassification[] = [
  'sole_proprietor',
  'disregarded',
  'partnership',
  's_corp',
  'c_corp',
  'exempt',
];

export interface UsEntityTypeInfo {
  type: UsEntityType;
  label: string;
  description: string;
  /** Classifications the entity may have; the first is the default. */
  classifications: readonly UsTaxClassification[];
  /** Minimum number of owners the form of entity needs. */
  minOwners: 1 | 2;
}

export const US_ENTITY_TYPE_INFO: Readonly<Record<UsEntityType, UsEntityTypeInfo>> = {
  sole_proprietorship: {
    type: 'sole_proprietorship',
    label: 'Sole proprietorship',
    description: 'One owner, no separate legal entity. Profit is reported on the owner\'s Form 1040 (Schedule C).',
    classifications: ['sole_proprietor'],
    minOwners: 1,
  },
  single_member_llc: {
    type: 'single_member_llc',
    label: 'LLC with one member',
    description:
      'Disregarded by default (Schedule C). Can elect to be taxed as an S corporation (Form 2553) or a C corporation (Form 8832).',
    classifications: ['disregarded', 's_corp', 'c_corp'],
    minOwners: 1,
  },
  multi_member_llc: {
    type: 'multi_member_llc',
    label: 'LLC with two or more members',
    description:
      'Taxed as a partnership by default (Form 1065). Can elect to be taxed as an S corporation (Form 2553) or a C corporation (Form 8832).',
    classifications: ['partnership', 's_corp', 'c_corp'],
    minOwners: 2,
  },
  partnership: {
    type: 'partnership',
    label: 'Partnership',
    description: 'General or limited partnership with two or more partners. Files Form 1065 and a K-1 per partner.',
    classifications: ['partnership'],
    minOwners: 2,
  },
  s_corp: {
    type: 's_corp',
    label: 'S corporation',
    description: 'A corporation that elected pass-through taxation. Files Form 1120-S and a K-1 per shareholder.',
    classifications: ['s_corp'],
    minOwners: 1,
  },
  c_corp: {
    type: 'c_corp',
    label: 'C corporation',
    description: 'A corporation taxed on its own income (21% federal rate). Files Form 1120.',
    classifications: ['c_corp'],
    minOwners: 1,
  },
  nonprofit: {
    type: 'nonprofit',
    label: 'Nonprofit organization',
    description: 'Tax-exempt organization. Files Form 990, 990-EZ or 990-N depending on size.',
    classifications: ['exempt'],
    minOwners: 1,
  },
};

export const US_TAX_CLASSIFICATION_LABELS: Readonly<Record<UsTaxClassification, string>> = {
  sole_proprietor: 'Sole proprietor',
  disregarded: 'Disregarded entity',
  partnership: 'Partnership',
  s_corp: 'S corporation',
  c_corp: 'C corporation',
  exempt: 'Tax-exempt organization',
};

export function isUsEntityType(value: unknown): value is UsEntityType {
  return typeof value === 'string' && (US_ENTITY_TYPES as readonly string[]).includes(value);
}

export function isUsTaxClassification(value: unknown): value is UsTaxClassification {
  return typeof value === 'string' && (US_TAX_CLASSIFICATIONS as readonly string[]).includes(value);
}

export function getUsEntityTypeInfo(entityType: string | null | undefined): UsEntityTypeInfo | undefined {
  return isUsEntityType(entityType) ? US_ENTITY_TYPE_INFO[entityType] : undefined;
}

/** Classifications an entity type may have, default first. Empty for an unknown type. */
export function allowedTaxClassifications(entityType: string | null | undefined): readonly UsTaxClassification[] {
  return getUsEntityTypeInfo(entityType)?.classifications ?? [];
}

/** True when the entity type can choose between several classifications (an LLC electing corporate status). */
export function canElectTaxClassification(entityType: string | null | undefined): boolean {
  return allowedTaxClassifications(entityType).length > 1;
}

/** The classification a new entity of this type starts with; sole proprietor for an unknown type. */
export function defaultTaxClassification(entityType: string | null | undefined): UsTaxClassification {
  return allowedTaxClassifications(entityType)[0] ?? 'sole_proprietor';
}

export function isValidTaxClassification(
  entityType: string | null | undefined,
  taxClassification: string | null | undefined,
): boolean {
  return (
    isUsTaxClassification(taxClassification) &&
    (allowedTaxClassifications(entityType) as readonly string[]).includes(taxClassification)
  );
}

/**
 * The classification that counts: the entity's own when it is allowed for its
 * type, else the type's default. Rows saved before the classification existed
 * (or with a stale combination) still resolve to a sensible return.
 */
export function effectiveTaxClassification(
  entityType: string | null | undefined,
  taxClassification: string | null | undefined,
): UsTaxClassification {
  if (isValidTaxClassification(entityType, taxClassification)) return taxClassification as UsTaxClassification;
  // An unknown entity type with a recognised classification: trust the classification.
  if (!isUsEntityType(entityType) && isUsTaxClassification(taxClassification)) return taxClassification;
  return defaultTaxClassification(entityType);
}

const FORM_BY_CLASSIFICATION: Readonly<Record<UsTaxClassification, TaxReturnForm>> = {
  sole_proprietor: 'sch_c',
  disregarded: 'sch_c',
  partnership: 'f1065',
  s_corp: 'f1120s',
  c_corp: 'f1120',
  exempt: 'f990',
};

/** The federal return a tax classification files. */
export function taxFormForClassification(taxClassification: UsTaxClassification): TaxReturnForm {
  return FORM_BY_CLASSIFICATION[taxClassification];
}

/**
 * The income-tax return the entity files: a single-member LLC (disregarded)
 * Schedule C, a multi-member LLC (default) Form 1065, an LLC that elected S
 * status Form 1120-S, a C corporation Form 1120, a nonprofit Form 990. A
 * missing or unknown entity type files Schedule C.
 *
 * Note a disregarded LLC owned by a business entity files no Schedule C of its
 * own (its income is on the owner's return); WeldBooks still keeps its books
 * with the Schedule C catalog.
 */
export function taxFormForEntity(
  entityType: string | null | undefined,
  taxClassification?: string | null,
): TaxReturnForm {
  return taxFormForClassification(effectiveTaxClassification(entityType, taxClassification));
}

/** The chart's equity section for the entity. */
export function equityModelFor(
  entityType: string | null | undefined,
  taxClassification?: string | null,
): UsEquityModel {
  switch (effectiveTaxClassification(entityType, taxClassification)) {
    case 'sole_proprietor':
    case 'disregarded':
      return 'sole_proprietor';
    case 'partnership':
      return 'partnership';
    case 's_corp':
      return 's_corp';
    case 'c_corp':
      return 'c_corp';
    case 'exempt':
      return 'nonprofit';
  }
}
