/**
 * From an engine result to what a posted document stores
 * (docs/plans/weldbooks-us.md §4):
 *
 * - `salesTaxResultToBreakdown`: the document's `tax_breakdown`, one row per
 *   line per jurisdiction (`DocumentTaxBreakdownRow`);
 * - `breakdownToTaxLineFields`: the `tax_lines` columns of those rows, which
 *   the posting service completes with ids, dates and currency;
 * - `reverseResultForCreditMemo`: a credit memo's breakdown from the original
 *   invoice's rows, so it never recalculates at today's rates.
 *
 * Breakdown rows of a credit memo hold positive amounts like any credit note;
 * `breakdownToTaxLineFields({ sign: -1 })` writes them as negative tax lines.
 */

import type { DocumentTaxBreakdownRow, NewTaxLine } from '@weldsuite/db/schema';
import { getUsState } from '../jurisdictions/us/states';
import { activeRegistrations } from './common';
import { isoDay } from './dates';
import { fromCents, roundHalfUp, roundingFor, roundTaxCells, snap6, toCents, type TaxCell } from './rounding';
import type { SalesTaxRegistration, SalesTaxResult } from './types';

export interface TaxLineContext {
  /** The tax code of each document line, for the ledger's `tax_code`. */
  lines: Array<{ lineId: string; taxCode?: string | null }>;
  /** `use` for a bill's use tax accrual. Default `sales`. */
  direction?: 'sales' | 'use';
  /** The sale went through a marketplace facilitator. */
  marketplaceFacilitated?: boolean;
  /** Lets a line without jurisdiction detail (marketplace sale) carry its ship-to state's agency. */
  registrations?: SalesTaxRegistration[];
  /** Tax point for the registration lookup; default the day of the calculation. */
  documentDate?: string;
}

/**
 * A line the engine charged no tax on (not registered, marketplace-facilitated,
 * provider returned nothing) still becomes one zero-tax row in its ship-to
 * state, so the sale counts toward gross sales and nexus.
 */
export function salesTaxResultToBreakdown(
  result: SalesTaxResult,
  ctx: TaxLineContext,
): DocumentTaxBreakdownRow[] {
  const kind: 'tax' | 'use' = ctx.direction === 'use' ? 'use' : 'tax';
  const taxCodeOf = new Map(ctx.lines.map((l) => [l.lineId, l.taxCode ?? undefined]));
  const state = result.shipToState;
  const stateName = state ? (getUsState(state)?.name ?? state) : undefined;
  const syntheticAgency = state
    ? activeRegistrations(
        ctx.registrations ?? [],
        state,
        ctx.documentDate ?? isoDay(result.calculatedAt),
      ).sort((a, b) => Number(a.level === 'local') - Number(b.level === 'local'))[0]?.agencyId
    : undefined;

  const rows: DocumentTaxBreakdownRow[] = [];
  for (const line of result.lines) {
    const taxCode = taxCodeOf.get(line.lineId);
    if (line.details.length === 0) {
      if (!state || !stateName) continue;
      rows.push({
        taxRateId: '',
        taxRateName: stateName,
        taxRate: 0,
        taxableAmount: 0,
        taxAmount: 0,
        ...(kind === 'use' ? { selfAssessed: true } : {}),
        lineId: line.lineId,
        jurisdictionCode: state,
        jurisdictionName: stateName,
        jurisdictionLevel: 'state',
        stateCode: state,
        ...(syntheticAgency ? { agencyId: syntheticAgency } : {}),
        exemptAmount: line.exemptAmount,
        nonTaxableAmount: fromCents(toCents(line.grossAmount) - toCents(line.exemptAmount)),
        unroundedTaxAmount: 0,
        ...(taxCode ? { taxCode } : {}),
        kind,
      });
      continue;
    }
    for (const d of line.details) {
      rows.push({
        taxRateId: '',
        taxRateName: d.jurisdictionName,
        taxRate: d.rate,
        taxableAmount: d.taxableAmount,
        taxAmount: d.tax,
        ...(kind === 'use' ? { selfAssessed: true } : {}),
        lineId: line.lineId,
        jurisdictionCode: d.jurisdictionCode,
        jurisdictionName: d.jurisdictionName,
        jurisdictionLevel: d.level,
        stateCode: d.stateCode,
        ...(d.agencyId ? { agencyId: d.agencyId } : {}),
        ...(d.reportingCode ? { reportingCode: d.reportingCode } : {}),
        exemptAmount: d.exemptAmount,
        nonTaxableAmount: d.nonTaxableAmount,
        ...(d.exemptReason ? { exemptReason: String(d.exemptReason) } : {}),
        ...(d.certificateId ? { certificateId: d.certificateId } : {}),
        unroundedTaxAmount: d.unroundedTax,
        ...(taxCode ? { taxCode } : {}),
        kind,
      });
    }
  }
  return rows;
}

/** The `tax_lines` columns the sales tax engines fill; the posting service adds the rest. */
export type SalesTaxLineFields = Pick<
  NewTaxLine,
  | 'direction'
  | 'sourceLineId'
  | 'taxRateName'
  | 'rate'
  | 'jurisdictionCode'
  | 'jurisdictionName'
  | 'jurisdictionLevel'
  | 'reportingCode'
  | 'stateCode'
  | 'agencyId'
  | 'grossAmount'
  | 'taxableAmount'
  | 'exemptAmount'
  | 'nonTaxableAmount'
  | 'exemptReason'
  | 'certificateId'
  | 'shipToState'
  | 'shipToPostalCode'
  | 'taxCode'
  | 'marketplaceFacilitated'
  | 'unroundedTaxAmount'
  | 'engine'
  | 'engineRef'
  | 'taxAmount'
>;

export interface TaxLineFieldsContext {
  /** -1 writes a credit memo's rows as negative amounts. Default 1. */
  sign?: 1 | -1;
  direction?: 'sales' | 'use';
  marketplaceFacilitated?: boolean;
  shipToState?: string | null;
  shipToPostalCode?: string | null;
  engine?: string | null;
  engineRef?: string | null;
}

function amount(value: number, sign: 1 | -1): string {
  const signed = value * sign;
  return (Math.abs(signed) < 0.005 ? 0 : signed).toFixed(2);
}

function clip(value: string | undefined | null, length: number): string | null {
  if (!value) return null;
  return value.length > length ? value.slice(0, length) : value;
}

export function breakdownToTaxLineFields(
  rows: DocumentTaxBreakdownRow[],
  ctx: TaxLineFieldsContext = {},
): SalesTaxLineFields[] {
  const sign = ctx.sign ?? 1;
  return rows.map((row) => {
    const taxable = row.taxableAmount;
    const exempt = row.exemptAmount ?? 0;
    const nonTaxable = row.nonTaxableAmount ?? 0;
    const unrounded = row.unroundedTaxAmount ?? row.taxAmount;
    const use = (ctx.direction === 'use') || row.kind === 'use';
    return {
      direction: use ? 'use' : 'sales',
      sourceLineId: clip(row.lineId, 30),
      taxRateName: clip(row.taxRateName, 100),
      rate: row.taxRate.toFixed(4),
      jurisdictionCode: clip(row.jurisdictionCode, 30),
      jurisdictionName: clip(row.jurisdictionName, 255),
      jurisdictionLevel: row.jurisdictionLevel ?? null,
      reportingCode: clip(row.reportingCode, 30),
      stateCode: clip(row.stateCode, 10),
      agencyId: row.agencyId ?? null,
      grossAmount: amount(taxable + exempt + nonTaxable, sign),
      taxableAmount: amount(taxable, sign),
      exemptAmount: amount(exempt, sign),
      nonTaxableAmount: amount(nonTaxable, sign),
      exemptReason: clip(row.exemptReason, 30),
      certificateId: clip(row.certificateId, 30),
      shipToState: clip(ctx.shipToState ?? row.stateCode, 10),
      shipToPostalCode: clip(ctx.shipToPostalCode, 10),
      taxCode: clip(row.taxCode, 30),
      marketplaceFacilitated: Boolean(ctx.marketplaceFacilitated),
      unroundedTaxAmount: (Math.abs(unrounded * sign) < 0.0000005 ? 0 : unrounded * sign).toFixed(6),
      engine: clip(ctx.engine, 30),
      engineRef: clip(ctx.engineRef, 255),
      taxAmount: amount(row.taxAmount, sign),
    };
  });
}

/** Breakdown rows and ledger columns of one engine result. */
export function salesTaxResultToTaxLines(
  result: SalesTaxResult,
  ctx: TaxLineContext,
): { breakdown: DocumentTaxBreakdownRow[]; taxLines: SalesTaxLineFields[] } {
  const breakdown = salesTaxResultToBreakdown(result, ctx);
  const taxLines = breakdownToTaxLineFields(breakdown, {
    direction: ctx.direction,
    marketplaceFacilitated: ctx.marketplaceFacilitated,
    shipToState: result.shipToState,
    shipToPostalCode: result.shipToPostalCode,
    engine: result.engine,
    engineRef: result.engineRef,
  });
  return { breakdown, taxLines };
}

export function breakdownTaxTotal(rows: DocumentTaxBreakdownRow[]): number {
  return fromCents(rows.reduce((sum, r) => sum + toCents(r.taxAmount), 0));
}

function lineGross(row: DocumentTaxBreakdownRow): number {
  return row.taxableAmount + (row.exemptAmount ?? 0) + (row.nonTaxableAmount ?? 0);
}

/**
 * A credit memo's breakdown from the original invoice's rows: the same
 * jurisdictions and rates, for the credited share of each line. A full credit
 * of a line copies its rows; a partial credit scales the bases and recomputes
 * the tax at the original rates, rounded per the state's rule over the memo.
 */
export function reverseResultForCreditMemo(
  original: DocumentTaxBreakdownRow[],
  creditLines: Array<{ lineId: string; amount: number }>,
): DocumentTaxBreakdownRow[] {
  const byLine = new Map<string, DocumentTaxBreakdownRow[]>();
  for (const row of original) {
    if (!row.lineId) continue;
    const list = byLine.get(row.lineId);
    if (list) list.push(row);
    else byLine.set(row.lineId, [row]);
  }

  const out: DocumentTaxBreakdownRow[] = [];
  const partial: Array<{ index: number; unrounded: number }> = [];
  const cells: TaxCell[] = [];

  for (const credit of creditLines) {
    const rows = byLine.get(credit.lineId);
    if (!rows || rows.length === 0) continue;
    const gross = lineGross(rows[0]);
    const ratio = gross === 0 ? 0 : credit.amount / gross;
    const full = Math.abs(ratio - 1) < 1e-9;

    for (const row of rows) {
      if (full) {
        out.push({ ...row });
        continue;
      }
      const taxable = roundHalfUp(row.taxableAmount * ratio);
      const exempt = roundHalfUp((row.exemptAmount ?? 0) * ratio);
      const unrounded = snap6((taxable * row.taxRate) / 100);
      out.push({
        ...row,
        taxableAmount: taxable,
        exemptAmount: exempt,
        nonTaxableAmount: fromCents(toCents(credit.amount) - toCents(taxable) - toCents(exempt)),
        taxAmount: 0,
        unroundedTaxAmount: unrounded,
      });
      partial.push({ index: out.length - 1, unrounded });
      cells.push({
        lineId: credit.lineId,
        jurisdictionKey: `${row.agencyId ?? ''}|${row.jurisdictionCode ?? ''}`,
        unrounded,
      });
    }
  }

  if (cells.length > 0) {
    const state = out[partial[0].index].stateCode;
    const rounded = roundTaxCells(cells, roundingFor(state));
    partial.forEach((p, k) => {
      out[p.index].taxAmount = fromCents(rounded[k]);
    });
  }
  return out;
}
