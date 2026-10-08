/**
 * Pure helpers behind the fixed asset screens: whole-cent arithmetic, the
 * gain or loss shown while a disposal is filled in, and the preview of the
 * depreciation books the server builds when a new asset names none.
 *
 * The server is authoritative. Both previews mirror its rules
 * (`apps/workers/books-api/src/services/fixed-assets/{books,disposal}.ts` and
 * `@weldsuite/books-domain/us-compliance/depreciation-tables`) closely enough
 * to show what to expect; the asset that comes back is what is stored.
 */
import type { BookInput, DepreciationConvention, DepreciationMethod } from '@/lib/api/domains/weldbooks-assets';
import { addDaysToIsoDate } from '@/lib/weldbooks/format';

// ---------------------------------------------------------------------------
// Money

/** A number or numeric string as whole cents; anything unreadable counts as zero. */
export function toCents(value: number | string | null | undefined): number {
  if (value === null || value === undefined || value === '') return 0;
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) return 0;
  return Math.round(parsed * 100 + (parsed >= 0 ? 1e-9 : -1e-9));
}

export function fromCents(cents: number): number {
  return cents / 100;
}

/** Reads a form field: `null` for a blank or unreadable value. */
export function parseAmount(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const text = value.trim();
  if (text === '') return null;
  const parsed = Number(text.replace(/,/g, ''));
  return Number.isFinite(parsed) ? parsed : null;
}

/** The last day of the month before the one `today` (a `YYYY-MM-DD` date) is in: where the depreciation run stops by default. */
export function endOfLastMonth(today: string): string {
  return addDaysToIsoDate(`${today.slice(0, 7)}-01`, -1);
}

/** A share (0 to 1) as a percentage with one decimal: `0.425` is "42.5%". */
export function formatShare(share: number): string {
  return `${(Math.round(share * 1000) / 10).toFixed(1)}%`;
}

// ---------------------------------------------------------------------------
// Disposal preview

export interface ScheduleRowLike {
  periodStart: string;
  periodEnd: string;
  amount: string | number;
}

export interface DisposalPreview {
  /** Depreciation of the periods that ended before the disposal date. */
  accumulatedDepreciation: number;
  netBookValue: number;
  /** Proceeds less net book value; negative for a loss. */
  gainOrLoss: number;
  result: 'gain' | 'loss' | 'none';
}

/**
 * What a disposal comes to: net book value is the cost less the ledger book's
 * depreciation for every period that ended before the disposal date (the
 * month of disposal carries none under the usual full-month convention),
 * gain or loss is the proceeds less that. All arithmetic in whole cents.
 */
export function previewDisposal(input: {
  cost: number | string;
  rows: readonly ScheduleRowLike[];
  date: string;
  proceeds: number | string | null | undefined;
}): DisposalPreview {
  const costCents = toCents(input.cost);
  const accumulatedCents = input.rows
    .filter((row) => row.periodEnd < input.date)
    .reduce((sum, row) => sum + toCents(row.amount), 0);
  const nbvCents = costCents - accumulatedCents;
  const gainCents = toCents(input.proceeds) - nbvCents;
  return {
    accumulatedDepreciation: fromCents(accumulatedCents),
    netBookValue: fromCents(nbvCents),
    gainOrLoss: fromCents(gainCents),
    result: gainCents > 0 ? 'gain' : gainCents < 0 ? 'loss' : 'none',
  };
}

// ---------------------------------------------------------------------------
// Default books preview

export const OBBBA_BONUS_CUTOFF = '2025-01-19';
export const TCJA_BONUS_START = '2017-09-27';

export type BonusRule =
  | 'obbba_100'
  | 'obbba_reduced_election'
  | 'tcja_100'
  | 'tcja_80'
  | 'tcja_60'
  | 'tcja_40'
  | 'tcja_20'
  | 'tcja_0'
  | 'not_modeled'
  | 'not_eligible'
  | 'not_allowed'
  /** A percentage typed on the form. */
  | 'entered';

export interface BonusPreview {
  percent: number;
  rule: BonusRule;
}

/** Section 168(k): the bonus percentage the acquisition and placed-in-service dates give. */
export function previewBonus(input: {
  acquisitionDate: string;
  placedInServiceDate: string;
  reducedElection?: boolean;
}): BonusPreview {
  const { acquisitionDate, placedInServiceDate } = input;
  if (acquisitionDate > OBBBA_BONUS_CUTOFF && placedInServiceDate > OBBBA_BONUS_CUTOFF) {
    return input.reducedElection ? { percent: 40, rule: 'obbba_reduced_election' } : { percent: 100, rule: 'obbba_100' };
  }
  if (acquisitionDate <= TCJA_BONUS_START || placedInServiceDate <= TCJA_BONUS_START) {
    return { percent: 0, rule: 'not_modeled' };
  }
  const year = Number(placedInServiceDate.slice(0, 4));
  if (year <= 2022) return { percent: 100, rule: 'tcja_100' };
  if (year === 2023) return { percent: 80, rule: 'tcja_80' };
  if (year === 2024) return { percent: 60, rule: 'tcja_60' };
  if (year === 2025) return { percent: 40, rule: 'tcja_40' };
  if (year === 2026) return { percent: 20, rule: 'tcja_20' };
  return { percent: 0, rule: 'tcja_0' };
}

/** Property with a GDS recovery period of 20 years or less (or 25-year water utility property) can take bonus depreciation. */
export function bonusEligible(recoveryYears: number): boolean {
  return recoveryYears <= 20 || recoveryYears === 25;
}

const REAL_PROPERTY_YEARS: readonly number[] = [27.5, 30, 31.5, 39, 40];

export const isRealProperty = (recoveryYears: number): boolean => REAL_PROPERTY_YEARS.includes(recoveryYears);

/** Listed property used 50% or less for business must use ADS and gets no section 179 or bonus. */
export const mustUseAds = (listedProperty: boolean, businessUsePercent: number): boolean =>
  listedProperty && businessUsePercent <= 50;

export interface DefaultBooksFacts {
  isUs: boolean;
  assetClass: string | null;
  usefulLifeYears: number | null;
  acquisitionDate: string;
  placedInServiceDate: string;
  businessUsePercent: number;
  listedProperty: boolean;
  /** Typed on the form, or null to leave it to the server. */
  section179Amount: number | null;
  bonusPercent: number | null;
  bonusReducedElection: boolean;
}

export interface PreviewBook {
  book: 'book' | 'federal';
  method: DepreciationMethod;
  convention: DepreciationConvention;
  recoveryYears: number;
  postsToLedger: boolean;
  section179Amount: number;
  bonusPercent: number;
  /** Where the bonus percentage comes from: the dates (a rule), the form, or a rule that ruled it out. */
  bonusRule: BonusRule | null;
  /** The listed-property rule turned the GDS book into ADS. */
  convertedToAds: boolean;
}

const MACRS_CLASS_NUMBERS: readonly number[] = [3, 5, 7, 10, 15, 20, 25, 27.5, 39];

/** The MACRS class of an asset class value, or null when it is not one (a free-text category, or none). */
export function macrsClassOf(assetClass: string | null | undefined): number | null {
  if (!assetClass) return null;
  const value = Number(assetClass);
  return MACRS_CLASS_NUMBERS.includes(value) ? value : null;
}

/** The books the server creates when none are named: the ledger book, and for a US asset with a MACRS class the federal book. */
export function previewDefaultBooks(facts: DefaultBooksFacts): PreviewBook[] {
  const macrsClass = macrsClassOf(facts.assetClass);
  const life = facts.usefulLifeYears ?? macrsClass ?? 5;
  const books: PreviewBook[] = [
    {
      book: 'book',
      method: 'straight_line',
      convention: 'full_month',
      recoveryYears: life,
      postsToLedger: true,
      section179Amount: 0,
      bonusPercent: 0,
      bonusRule: null,
      convertedToAds: false,
    },
  ];
  if (facts.isUs && macrsClass !== null) {
    const ads = mustUseAds(facts.listedProperty, facts.businessUsePercent);
    let bonus: BonusPreview;
    if (ads) bonus = { percent: 0, rule: 'not_allowed' };
    else if (facts.bonusPercent !== null) bonus = { percent: facts.bonusPercent, rule: 'entered' };
    else if (!bonusEligible(macrsClass)) bonus = { percent: 0, rule: 'not_eligible' };
    else {
      bonus = previewBonus({
        acquisitionDate: facts.acquisitionDate,
        placedInServiceDate: facts.placedInServiceDate,
        reducedElection: facts.bonusReducedElection,
      });
    }
    books.push({
      book: 'federal',
      method: ads ? 'macrs_ads' : 'macrs_gds',
      convention: isRealProperty(macrsClass) ? 'mid_month' : 'half_year',
      recoveryYears: macrsClass,
      postsToLedger: false,
      section179Amount: ads ? 0 : (facts.section179Amount ?? 0),
      bonusPercent: bonus.percent,
      bonusRule: bonus.rule,
      convertedToAds: ads,
    });
  }
  return books;
}

// ---------------------------------------------------------------------------
// Books as the form edits them

export const MACRS_METHODS: readonly DepreciationMethod[] = ['macrs_gds', 'macrs_ads'];

export const isMacrsMethod = (method: string): boolean => (MACRS_METHODS as readonly string[]).includes(method);

/** The methods a book can use: the ledger book uses a book method, tax books mostly MACRS. */
export function methodsFor(book: BookInput['book']): readonly DepreciationMethod[] {
  return book === 'book'
    ? ['straight_line', 'declining_balance', 'expensed', 'none']
    : ['macrs_gds', 'macrs_ads', 'straight_line', 'declining_balance', 'expensed', 'none'];
}
