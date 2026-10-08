/**
 * Depreciation books of an asset: the defaults for a new asset, and the checks
 * and normalisation a requested book goes through before it is stored.
 *
 * A US entity gets two books by default: `book` (straight line over a useful
 * life, full-month convention, posts to the ledger) and `federal` (MACRS GDS
 * for the property class, with the bonus percentage the acquisition and
 * placed-in-service dates give). Entities outside the US get `book` only.
 * State books are always explicit: states differ on bonus and section 179.
 *
 * What the stored books cannot hold, because the schema has no column for it:
 * the declining-balance factor (always 200%), the straight-line election for
 * GDS property, and a separate ADS life (listed property used 50% or less for
 * business is converted to an ADS book with the recovery period it was given).
 */

import {
  bonusDepreciationPercent,
  bonusEligible,
} from '@weldsuite/books-domain/us-compliance/depreciation';
import { isUsAddressStateCode } from '@weldsuite/books-domain/jurisdictions/us/states';
import {
  FixedAssetError,
  MACRS_METHODS,
  asNumber,
  defaultConvention,
  isMacrsClass,
  type BookKind,
  type EntityRow,
} from './shared';

export const DEPRECIATION_METHODS = ['straight_line', 'declining_balance', 'macrs_gds', 'macrs_ads', 'expensed', 'none'] as const;
export const CONVENTIONS = ['half_year', 'mid_quarter', 'mid_month', 'full_month'] as const;

export type BookMethod = (typeof DEPRECIATION_METHODS)[number];
export type BookConvention = (typeof CONVENTIONS)[number];

export interface BookInput {
  book: BookKind;
  stateCode?: string | null;
  method: BookMethod;
  convention?: BookConvention;
  recoveryYears: number;
  section179Amount?: number;
  /** 0 to 100. */
  bonusPercent?: number;
  postsToLedger?: boolean;
}

/** A book after the defaults and rules are applied, ready to store. */
export interface NormalizedBook {
  book: BookKind;
  stateCode: string | null;
  method: BookMethod;
  convention: BookConvention;
  recoveryYears: number;
  section179Amount: number;
  bonusPercent: number;
  postsToLedger: boolean;
}

export interface BookIssue {
  book: BookKind;
  stateCode: string | null;
  severity: 'error' | 'warning';
  code: string;
  message: string;
}

/** The asset facts the defaults and the rules depend on. */
export interface BookAssetFacts {
  assetClass: string | null;
  acquisitionDate: string;
  placedInServiceDate: string;
  cost: number;
  businessUsePercent: number;
  listedProperty: boolean;
  usefulLifeYears?: number;
  section179Amount?: number;
  bonusPercent?: number;
  bonusReducedElection?: boolean;
}

/** Listed property used 50% or less for business must use ADS and gets no section 179 or bonus. */
export const mustUseAds = (facts: Pick<BookAssetFacts, 'listedProperty' | 'businessUsePercent'>): boolean =>
  facts.listedProperty && facts.businessUsePercent <= 50;

export function defaultBooks(entity: Pick<EntityRow, 'jurisdictionCode'>, facts: BookAssetFacts): BookInput[] {
  const macrsClass = isMacrsClass(facts.assetClass) ? Number(facts.assetClass) : null;
  const life = facts.usefulLifeYears ?? macrsClass ?? 5;
  const books: BookInput[] = [
    { book: 'book', method: 'straight_line', convention: 'full_month', recoveryYears: life, postsToLedger: true },
  ];
  if (entity.jurisdictionCode.toUpperCase() === 'US' && macrsClass !== null) {
    books.push({
      book: 'federal',
      method: 'macrs_gds',
      recoveryYears: macrsClass,
      section179Amount: facts.section179Amount ?? 0,
      bonusPercent: facts.bonusPercent,
    });
  }
  return books;
}

/** The bonus depreciation percentage of a new federal MACRS book when none was asked for. */
export function defaultBonusPercent(facts: BookAssetFacts, recoveryYears: number): number {
  if (!bonusEligible(recoveryYears)) return 0;
  return bonusDepreciationPercent({
    acquisitionDate: facts.acquisitionDate,
    placedInServiceDate: facts.placedInServiceDate,
    reducedElection: facts.bonusReducedElection,
  }).percent;
}

/**
 * Apply the defaults and rules to the requested books. Throws a
 * `FixedAssetError` for a request that can't be stored; returns the books and
 * the changes made on the way (an ADS conversion, say).
 */
export function normalizeBooks(inputs: readonly BookInput[], facts: BookAssetFacts): { books: NormalizedBook[]; issues: BookIssue[] } {
  const issues: BookIssue[] = [];
  const books: NormalizedBook[] = [];
  const seen = new Set<string>();
  const baseCost = Math.round(facts.cost * facts.businessUsePercent) / 100;

  for (const input of inputs) {
    const stateCode = input.book === 'state' ? (input.stateCode ?? '').toUpperCase() : '';
    if (input.book === 'state' && !isUsAddressStateCode(stateCode)) {
      throw new FixedAssetError('A state book needs a stateCode (two letters, e.g. CA)');
    }
    const key = `${input.book}:${stateCode}`;
    if (seen.has(key)) {
      throw new FixedAssetError(input.book === 'state' ? `There is already a ${stateCode} state book` : `There is already a ${input.book} book`);
    }
    seen.add(key);

    const postsToLedger = input.postsToLedger ?? input.book === 'book';
    if (postsToLedger && input.book !== 'book') {
      throw new FixedAssetError('Only the book (GAAP) depreciation book can post to the ledger');
    }

    let method: BookMethod = input.method;
    let section179 = input.section179Amount ?? 0;
    let bonusPercent = input.bonusPercent;
    const warn = (code: string, message: string) =>
      issues.push({ book: input.book, stateCode: stateCode || null, severity: 'warning', code, message });

    const macrs = MACRS_METHODS.includes(method);
    if (!macrs && (section179 > 0 || (bonusPercent ?? 0) > 0)) {
      throw new FixedAssetError('Section 179 and bonus depreciation only apply to MACRS books');
    }
    if (macrs && input.book === 'book') {
      throw new FixedAssetError('The book (GAAP) depreciation book uses a book method (straight line, declining balance, expensed or none)');
    }
    if (!macrs && input.book !== 'book' && method !== 'expensed' && method !== 'none') {
      warn('non_macrs_tax_book', 'A tax book normally uses MACRS; this one uses a book method');
    }

    if (macrs && mustUseAds(facts)) {
      if (method === 'macrs_gds') {
        method = 'macrs_ads';
        warn('ads_required', 'Listed property used 50% or less for business must use ADS; the book was converted to ADS');
      }
      if (section179 > 0) {
        section179 = 0;
        warn('section_179_not_allowed', 'Section 179 is not allowed on property used 50% or less for business');
      }
      if ((bonusPercent ?? 0) > 0) {
        warn('bonus_not_allowed', 'Bonus depreciation is not allowed on property that must use ADS');
      }
      bonusPercent = 0;
    }
    if (section179 > baseCost + 0.005) {
      throw new FixedAssetError(`Section 179 (${section179.toFixed(2)}) cannot exceed the business cost of the asset (${baseCost.toFixed(2)})`);
    }
    if (bonusPercent !== undefined && (bonusPercent < 0 || bonusPercent > 100)) {
      throw new FixedAssetError('bonusPercent is 0 to 100');
    }

    const recoveryYears = input.recoveryYears;
    if (method !== 'expensed' && method !== 'none' && !(recoveryYears > 0)) {
      throw new FixedAssetError('recoveryYears must be greater than zero');
    }
    if (macrs && input.book === 'federal' && bonusPercent === undefined) {
      bonusPercent = method === 'macrs_gds' ? defaultBonusPercent(facts, recoveryYears) : 0;
    }

    const probe = { method, recoveryYears };
    books.push({
      book: input.book,
      stateCode: stateCode || null,
      method,
      convention: input.convention ?? defaultConvention(probe),
      recoveryYears: recoveryYears > 0 ? recoveryYears : 1,
      section179Amount: section179,
      bonusPercent: bonusPercent ?? 0,
      postsToLedger,
    });
  }

  if (books.filter((b) => b.postsToLedger).length > 1) {
    throw new FixedAssetError('Only one book can post to the ledger');
  }
  return { books, issues };
}

export function ledgerBookOf<T extends { postsToLedger: boolean }>(books: readonly T[]): T | undefined {
  return books.find((book) => book.postsToLedger);
}

/** The recovery period shown with a book: whole years without the trailing `.0`. */
export const recoveryLabel = (years: string | number): string => String(asNumber(years));
