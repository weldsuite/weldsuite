/**
 * Fixed asset reports: the register (cost, accumulated depreciation, net book
 * value), the mid-quarter test, a Form 4562-style tax depreciation summary and
 * the de minimis safe harbor check.
 *
 * Everything is computed from the stored assets and books on request; the only
 * stored depreciation is the ledger book's posting rows, which the register
 * shows next to the schedule so it can be reconciled with the ledger.
 */

import { and, inArray, isNotNull, sql } from 'drizzle-orm';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { diffDays, parseIso } from '@weldsuite/books-domain/us-compliance/dates';
import {
  deMinimisApplies,
  deMinimisThreshold,
  midQuarterTest,
  section179Allowance,
  type DepreciationRow,
  type FiscalPeriod as DepreciationPeriod,
  type MidQuarterTestResult,
} from '@weldsuite/books-domain/us-compliance/depreciation';
import { fiscalYearFor, fiscalYearRange, type FiscalYearConfig } from '@weldsuite/books-domain/us-compliance/fiscal-year';
import {
  annualSchedule,
  ledgerRows,
  macrsConventionMap,
  midQuarterBasisOf,
  type AssetWithBook,
  type ScheduleContext,
} from './schedules';
import { loadEntity, loadEntityBookRows } from './assets';
import {
  FixedAssetError,
  asNumber,
  effectiveConvention,
  entityFiscalConfig,
  fiscalYearLabel,
  fromCents,
  isMacrsBook,
  isRealPropertyBook,
  toCents,
  type AssetRow,
  type BookRow,
} from './shared';

const depTable = schema.fixedAssetDepreciation;

/** Listed property is not stored on the asset; a book converted to ADS for business use of 50% or less is the trace it leaves. */
export const looksLikeListedProperty = (asset: Pick<AssetRow, 'businessUsePercent'>, book: Pick<BookRow, 'method'>): boolean =>
  book.method === 'macrs_ads' && asNumber(asset.businessUsePercent, 100) <= 50;

// ---------------------------------------------------------------------------
// De minimis

export interface DeMinimisAdvice {
  amount: number;
  date: string;
  hasAfs: boolean;
  /** Per invoice or item; null when the date is before the rule. */
  threshold: number | null;
  applies: boolean;
  advice: 'expense' | 'capitalize';
  explanation: string;
}

/** Expense or capitalize: the de minimis safe harbor (Treas. Reg. 1.263(a)-1(f)) per invoice or item. */
export function deMinimisCheck(input: { amount: number; hasAfs: boolean; date: string }): DeMinimisAdvice {
  const threshold = deMinimisThreshold(input.date, input.hasAfs) ?? null;
  const applies = deMinimisApplies(input.amount, input.date, input.hasAfs);
  const money = (value: number) => `$${value.toLocaleString('en-US')}`;
  const explanation = applies
    ? `At ${money(input.amount)} the item is within the ${money(threshold ?? 0)} per invoice or item safe harbor${input.hasAfs ? ' (business with an applicable financial statement)' : ''}, so it can be expensed instead of capitalized. The election is made for the whole year with a statement on the tax return and covers every qualifying purchase; with an applicable financial statement the books must expense it too.`
    : threshold === null
      ? 'The de minimis safe harbor does not cover this date; capitalize the item and depreciate it.'
      : `At ${money(input.amount)} the item is over the ${money(threshold)} per invoice or item safe harbor${input.hasAfs ? '' : ' (without an applicable financial statement)'}, so capitalize it and depreciate it. Section 179 or bonus depreciation can still bring the deduction into the first year.`;
  return { amount: input.amount, date: input.date, hasAfs: input.hasAfs, threshold, applies, advice: applies ? 'expense' : 'capitalize', explanation };
}

// ---------------------------------------------------------------------------
// Mid-quarter test

function quarterOf(config: FiscalYearConfig, period: DepreciationPeriod, date: string): number {
  let month: number;
  if (config.type === 'month') {
    const start = parseIso(period.start);
    const day = parseIso(date);
    month = day.y * 12 + day.m - (start.y * 12 + start.m);
  } else {
    const total = diffDays(period.start, period.end) + 1;
    month = Math.min(11, Math.floor((diffDays(period.start, date) / total) * 12));
  }
  return Math.floor(month / 3) + 1;
}

export interface MidQuarterAssetLine {
  assetId: string;
  assetNumber: string | null;
  name: string;
  placedInServiceDate: string;
  quarter: number;
  /** Cost times business use, less section 179. */
  basis: number;
  counted: boolean;
  excludedReason: 'real_property' | 'disposed_in_same_year' | null;
  /** What the year's verdict gives this asset. */
  convention: string;
}

export interface MidQuarterReport extends MidQuarterTestResult {
  taxYear: number;
  start: string;
  end: string;
  /** The share of the year's basis in the last quarter above which the mid-quarter convention applies. */
  threshold: number;
  assets: MidQuarterAssetLine[];
}

export function midQuarterReport(config: FiscalYearConfig, rows: readonly AssetWithBook[], taxYear: number): MidQuarterReport {
  const year = fiscalYearFor(config, taxYear);
  const period: DepreciationPeriod = { label: fiscalYearLabel(config, year.year), start: year.start, end: year.end };
  const conventions = macrsConventionMap(config, rows);
  const federal = rows.filter(({ asset, book }) => book.book === 'federal' && isMacrsBook(book) && asset.placedInServiceDate >= year.start && asset.placedInServiceDate <= year.end);

  const lines: MidQuarterAssetLine[] = federal.map(({ asset, book }) => {
    const realProperty = isRealPropertyBook(book);
    const disposedInSameYear = Boolean(asset.disposalDate && asset.disposalDate >= year.start && asset.disposalDate <= year.end);
    return {
      assetId: asset.id,
      assetNumber: asset.assetNumber,
      name: asset.name,
      placedInServiceDate: asset.placedInServiceDate,
      quarter: quarterOf(config, period, asset.placedInServiceDate),
      basis: midQuarterBasisOf(asset, book),
      counted: !realProperty && !disposedInSameYear,
      excludedReason: realProperty ? 'real_property' : disposedInSameYear ? 'disposed_in_same_year' : null,
      convention: effectiveConvention(book, asset.id, conventions),
    };
  });

  const result = midQuarterTest(
    federal.map(({ asset, book }) => ({
      id: asset.id,
      placedInServiceDate: asset.placedInServiceDate,
      basis: midQuarterBasisOf(asset, book),
      realProperty: isRealPropertyBook(book),
      disposedInSameYear: Boolean(asset.disposalDate && asset.disposalDate >= year.start && asset.disposalDate <= year.end),
    })),
    period,
  );
  return { ...result, taxYear, start: year.start, end: year.end, threshold: 0.4, assets: lines };
}

export async function midQuarterTestFor(db: Database, entityId: string, taxYear: number): Promise<MidQuarterReport> {
  const entity = await loadEntity(db, entityId);
  return midQuarterReport(entityFiscalConfig(entity), await loadEntityBookRows(db, entityId), taxYear);
}

// ---------------------------------------------------------------------------
// Register

export interface RegisterLine {
  assetId: string;
  assetNumber: string | null;
  name: string;
  assetClass: string | null;
  status: string;
  placedInServiceDate: string;
  disposalDate: string | null;
  /** Disposed on or before the date: listed for reference, left out of the totals. */
  disposed: boolean;
  cost: number;
  method: string;
  convention: string;
  recoveryYears: number;
  accumulatedDepreciation: number;
  netBookValue: number;
  /** Ledger book only: what is actually posted to the ledger through the date. */
  accumulatedPosted?: number;
}

export interface RegisterReport {
  asOf: string;
  book: string;
  stateCode: string | null;
  /** `monthly` for the ledger book (through the last month ended on or before the date), `fiscal_year` for tax books (through the last fiscal year ended on or before it). */
  accumulatedThrough: 'month_end' | 'fiscal_year_end';
  lines: RegisterLine[];
  totals: { cost: number; accumulatedDepreciation: number; netBookValue: number; accumulatedPosted?: number };
}

export interface RegisterArgs {
  entityId: string;
  asOf: string;
  book: 'book' | 'federal' | 'state';
  stateCode?: string | null;
  includeDisposed?: boolean;
}

export async function fixedAssetRegister(db: Database, args: RegisterArgs): Promise<RegisterReport> {
  const entity = await loadEntity(db, args.entityId);
  const config = entityFiscalConfig(entity);
  const rows = await loadEntityBookRows(db, args.entityId);
  const context: ScheduleContext = { config, conventions: macrsConventionMap(config, rows) };
  const stateCode = args.book === 'state' ? (args.stateCode ?? '').toUpperCase() : '';
  const wanted = rows.filter(
    ({ asset, book }) =>
      book.book === args.book && (book.stateCode ?? '') === stateCode && asset.placedInServiceDate <= args.asOf,
  );

  const posted = new Map<string, number>();
  const ledgerAssetIds = wanted.filter(({ book }) => book.postsToLedger).map(({ asset }) => asset.id);
  if (ledgerAssetIds.length > 0) {
    const sums = await db
      .select({ assetId: depTable.assetId, total: sql<string>`coalesce(sum(${depTable.amount}), 0)` })
      .from(depTable)
      .where(and(inArray(depTable.assetId, ledgerAssetIds), isNotNull(depTable.journalEntryId), sql`${depTable.periodEnd} <= ${args.asOf}`))
      .groupBy(depTable.assetId);
    for (const sum of sums) posted.set(sum.assetId, toCents(asNumber(sum.total)));
  }

  const lines: RegisterLine[] = [];
  const totals = { cost: 0, accumulated: 0, posted: 0 };
  let anyLedger = false;
  for (const { asset, book } of wanted.sort((a, b) => (a.asset.assetNumber ?? a.asset.name).localeCompare(b.asset.assetNumber ?? b.asset.name))) {
    const disposed = Boolean(asset.disposalDate && asset.disposalDate <= args.asOf);
    if (disposed && !args.includeDisposed) continue;

    let accumulatedCents = 0;
    if (book.postsToLedger) {
      for (const row of ledgerRows(asset, book, config).rows) {
        if (row.periodEnd <= args.asOf) accumulatedCents = toCents(row.accumulated);
      }
    } else {
      let last: DepreciationRow | undefined;
      for (const row of annualSchedule(asset, book, context).rows) {
        if (row.periodEnd <= args.asOf) last = row;
      }
      accumulatedCents = last ? toCents(last.accumulated) : 0;
    }
    const costCents = toCents(asNumber(asset.cost));
    const line: RegisterLine = {
      assetId: asset.id,
      assetNumber: asset.assetNumber,
      name: asset.name,
      assetClass: asset.assetClass,
      status: asset.status,
      placedInServiceDate: asset.placedInServiceDate,
      disposalDate: asset.disposalDate,
      disposed,
      cost: fromCents(costCents),
      method: book.method,
      convention: effectiveConvention(book, asset.id, context.conventions),
      recoveryYears: asNumber(book.recoveryYears),
      accumulatedDepreciation: fromCents(accumulatedCents),
      netBookValue: fromCents(costCents - accumulatedCents),
    };
    if (book.postsToLedger) {
      anyLedger = true;
      line.accumulatedPosted = fromCents(posted.get(asset.id) ?? 0);
    }
    lines.push(line);
    if (!disposed) {
      totals.cost += costCents;
      totals.accumulated += accumulatedCents;
      totals.posted += posted.get(asset.id) ?? 0;
    }
  }

  return {
    asOf: args.asOf,
    book: args.book,
    stateCode: stateCode || null,
    accumulatedThrough: args.book === 'book' ? 'month_end' : 'fiscal_year_end',
    lines,
    totals: {
      cost: fromCents(totals.cost),
      accumulatedDepreciation: fromCents(totals.accumulated),
      netBookValue: fromCents(totals.cost - totals.accumulated),
      ...(anyLedger ? { accumulatedPosted: fromCents(totals.posted) } : {}),
    },
  };
}

// ---------------------------------------------------------------------------
// Tax depreciation (Form 4562 style)

export interface TaxDepreciationLine {
  assetId: string;
  assetNumber: string | null;
  name: string;
  assetClass: string | null;
  acquisitionDate: string;
  placedInServiceDate: string;
  disposalDate: string | null;
  placedInServiceThisYear: boolean;
  cost: number;
  businessUsePercent: number;
  method: string;
  convention: string;
  recoveryYears: number;
  /** Basis the yearly MACRS amounts are figured on (cost times business use, less section 179 and bonus). */
  depreciableBasis: number;
  section179: number;
  bonus: number;
  /** The regular MACRS deduction of the year. */
  macrs: number;
  total: number;
  accumulated: number;
  listedProperty: boolean;
  issues: string[];
}

export interface TaxDepreciationReport {
  taxYear: number;
  start: string;
  end: string;
  book: string;
  stateCode: string | null;
  lines: TaxDepreciationLine[];
  form4562: {
    /** Part I: election to expense certain property under section 179. */
    part1: {
      totalCostOfSection179Property: number;
      limit: number | null;
      phaseOutThreshold: number | null;
      reduction: number;
      dollarLimit: number | null;
      elected: number;
      deduction: number;
    };
    /** Part II: special depreciation allowance (bonus) on property placed in service this year. */
    part2: { bonus: number };
    /** Part III: MACRS. Line 17 is assets placed in service in earlier years; line 19 is this year's, by class and convention. */
    part3: {
      priorYearAssets: number;
      currentYearAssets: Array<{ recoveryYears: number; convention: string; method: string; count: number; basis: number; depreciation: number }>;
      currentYearTotal: number;
    };
    /** Part V: listed property (see `looksLikeListedProperty`). */
    listedProperty: Array<{ assetId: string; name: string; businessUsePercent: number; total: number }>;
    /** Line 22: total depreciation of the year. */
    total: number;
  };
  midQuarter: MidQuarterReport;
}

export interface TaxDepreciationArgs {
  entityId: string;
  taxYear: number;
  book: 'federal' | 'state';
  stateCode?: string | null;
}

export async function taxDepreciationReport(db: Database, args: TaxDepreciationArgs): Promise<TaxDepreciationReport> {
  const entity = await loadEntity(db, args.entityId);
  const config = entityFiscalConfig(entity);
  const rows = await loadEntityBookRows(db, args.entityId);
  const context: ScheduleContext = { config, conventions: macrsConventionMap(config, rows) };
  const year = fiscalYearFor(config, args.taxYear);
  const label = fiscalYearLabel(config, year.year);
  const stateCode = args.book === 'state' ? (args.stateCode ?? '').toUpperCase() : '';
  if (args.book === 'state' && !stateCode) throw new FixedAssetError('A state tax depreciation report needs a stateCode');

  const lines: TaxDepreciationLine[] = [];
  for (const { asset, book } of rows) {
    if (book.book !== args.book || (book.stateCode ?? '') !== stateCode) continue;
    if (asset.placedInServiceDate > year.end) continue;
    const schedule = annualSchedule(asset, book, context);
    const row = schedule.rows.find((candidate) => candidate.label === label);
    const placedThisYear = asset.placedInServiceDate >= year.start && asset.placedInServiceDate <= year.end;
    if (!row && !placedThisYear) continue;
    const section179 = row?.section179 ?? 0;
    const bonus = row?.bonus ?? 0;
    const macrs = row?.regular ?? 0;
    lines.push({
      assetId: asset.id,
      assetNumber: asset.assetNumber,
      name: asset.name,
      assetClass: asset.assetClass,
      acquisitionDate: asset.acquisitionDate,
      placedInServiceDate: asset.placedInServiceDate,
      disposalDate: asset.disposalDate,
      placedInServiceThisYear: placedThisYear,
      cost: asNumber(asset.cost),
      businessUsePercent: asNumber(asset.businessUsePercent, 100),
      method: schedule.method,
      convention: schedule.convention,
      recoveryYears: schedule.recoveryYears,
      depreciableBasis: schedule.basis.depreciableBasis,
      section179,
      bonus,
      macrs,
      total: row?.amount ?? 0,
      accumulated: row?.accumulated ?? 0,
      listedProperty: looksLikeListedProperty(asset, book),
      issues: schedule.issues.map((issue) => issue.message),
    });
  }
  lines.sort((a, b) => a.placedInServiceDate.localeCompare(b.placedInServiceDate) || a.name.localeCompare(b.name));

  const cents = (pick: (line: TaxDepreciationLine) => number, filter: (line: TaxDepreciationLine) => boolean = () => true) =>
    lines.filter(filter).reduce((sum, line) => sum + toCents(pick(line)), 0);

  const section179Property = cents(
    (line) => (line.cost * line.businessUsePercent) / 100,
    (line) => line.placedInServiceThisYear && line.method === 'macrs_gds' && line.recoveryYears <= 20,
  );
  const allowance = section179Allowance(args.taxYear, fromCents(section179Property));
  const section179Total = cents((line) => line.section179);

  const classes = new Map<string, { recoveryYears: number; convention: string; method: string; count: number; basis: number; depreciation: number }>();
  for (const line of lines.filter((candidate) => candidate.placedInServiceThisYear)) {
    const key = `${line.recoveryYears}|${line.convention}|${line.method}`;
    const entry = classes.get(key) ?? { recoveryYears: line.recoveryYears, convention: line.convention, method: line.method, count: 0, basis: 0, depreciation: 0 };
    entry.count += 1;
    entry.basis += toCents(line.depreciableBasis);
    entry.depreciation += toCents(line.macrs);
    classes.set(key, entry);
  }
  const currentYearAssets = [...classes.values()]
    .map((entry) => ({ ...entry, basis: fromCents(entry.basis), depreciation: fromCents(entry.depreciation) }))
    .sort((a, b) => a.recoveryYears - b.recoveryYears || a.convention.localeCompare(b.convention));
  const priorYearAssets = cents((line) => line.macrs, (line) => !line.placedInServiceThisYear);
  const currentYearTotal = cents((line) => line.macrs, (line) => line.placedInServiceThisYear);
  const bonusTotal = cents((line) => line.bonus);

  return {
    taxYear: args.taxYear,
    start: year.start,
    end: year.end,
    book: args.book,
    stateCode: stateCode || null,
    lines,
    form4562: {
      part1: {
        totalCostOfSection179Property: fromCents(section179Property),
        limit: allowance?.parameters.limit ?? null,
        phaseOutThreshold: allowance?.parameters.phaseOutThreshold ?? null,
        reduction: allowance?.phaseOutReduction ?? 0,
        dollarLimit: allowance?.dollarLimit ?? null,
        elected: fromCents(section179Total),
        deduction: fromCents(section179Total),
      },
      part2: { bonus: fromCents(bonusTotal) },
      part3: { priorYearAssets: fromCents(priorYearAssets), currentYearAssets, currentYearTotal: fromCents(currentYearTotal) },
      listedProperty: lines
        .filter((line) => line.listedProperty)
        .map((line) => ({ assetId: line.assetId, name: line.name, businessUsePercent: line.businessUsePercent, total: line.total })),
      total: fromCents(section179Total + bonusTotal + priorYearAssets + currentYearTotal),
    },
    midQuarter: midQuarterReport(config, rows, args.taxYear),
  };
}

/** The fiscal year (named for the year it ends in) that a date falls in. */
export function taxYearOf(config: FiscalYearConfig, date: string): number {
  return fiscalYearRange(config, date).year;
}
