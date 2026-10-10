/**
 * Correction runs store the DIFFERENCE.
 *
 * A correction payslip (`correctsPayslipId` → the original) holds, as lines,
 * totals, filing data and year-to-date, what the recalculated payslip has
 * more or less than the payslip as it stands today (the original plus the
 * corrections already approved for it). That way
 *
 *  - the payable amount is the net difference (the payment file, the
 *    journal and the employee's payment all read the correction payslip),
 *  - summing every final payslip of an employee, originals and corrections,
 *    gives the right year totals for the jaaropgaaf, the W-2, the filings and
 *    the journal, and
 *  - the original stays what it was: nothing is voided or edited.
 *
 * Totals can be negative (an employee was overpaid).
 */

import { fromCents, toCents } from '@weldsuite/payroll-domain/money';
import type { PayslipLine, PayslipResult } from '@weldsuite/payroll-domain/types';
import type { PayslipRow } from './common';

export interface TotalsCents {
  grossCents: number;
  taxableWageCents: number;
  employeeTaxesCents: number;
  employeeDeductionsCents: number;
  reimbursementsCents: number;
  netCents: number;
  employerTaxesCents: number;
  employerCostCents: number;
}

export const zeroTotals = (): TotalsCents => ({
  grossCents: 0,
  taxableWageCents: 0,
  employeeTaxesCents: 0,
  employeeDeductionsCents: 0,
  reimbursementsCents: 0,
  netCents: 0,
  employerTaxesCents: 0,
  employerCostCents: 0,
});

export function rowTotals(row: Pick<PayslipRow, 'grossPay' | 'taxableWage' | 'employeeTaxes' | 'employeeDeductions' | 'reimbursements' | 'netPay' | 'employerTaxes' | 'employerCost'>): TotalsCents {
  return {
    grossCents: toCents(row.grossPay),
    taxableWageCents: toCents(row.taxableWage),
    employeeTaxesCents: toCents(row.employeeTaxes),
    employeeDeductionsCents: toCents(row.employeeDeductions),
    reimbursementsCents: toCents(row.reimbursements),
    netCents: toCents(row.netPay),
    employerTaxesCents: toCents(row.employerTaxes),
    employerCostCents: toCents(row.employerCost),
  };
}

export function resultTotals(result: PayslipResult): TotalsCents {
  return {
    grossCents: result.grossCents,
    taxableWageCents: result.taxableWageCents,
    employeeTaxesCents: result.employeeTaxesCents,
    employeeDeductionsCents: result.employeeDeductionsCents,
    reimbursementsCents: result.reimbursementsCents,
    netCents: result.netCents,
    employerTaxesCents: result.employerTaxesCents,
    employerCostCents: result.employerCostCents,
  };
}

export function addTotals(a: TotalsCents, b: TotalsCents, sign: 1 | -1 = 1): TotalsCents {
  const out = zeroTotals();
  for (const key of Object.keys(out) as Array<keyof TotalsCents>) out[key] = a[key] + sign * b[key];
  return out;
}

/** Numeric columns of a payslip row, from totals in cents. */
export function totalsToColumns(t: TotalsCents) {
  return {
    grossPay: fromCents(t.grossCents),
    taxableWage: fromCents(t.taxableWageCents),
    employeeTaxes: fromCents(t.employeeTaxesCents),
    employeeDeductions: fromCents(t.employeeDeductionsCents),
    reimbursements: fromCents(t.reimbursementsCents),
    netPay: fromCents(t.netCents),
    employerTaxes: fromCents(t.employerTaxesCents),
    employerCost: fromCents(t.employerCostCents),
  };
}

// ---------------------------------------------------------------------------
// Lines
// ---------------------------------------------------------------------------

function lineKey(line: PayslipLine): string {
  return `${line.section}|${line.code}|${line.jurisdiction ?? ''}|${line.label ?? ''}`;
}

/** Add line sets by (section, code, jurisdiction, label). Zero lines drop out. */
export function sumLines(sets: PayslipLine[][]): PayslipLine[] {
  const byKey = new Map<string, PayslipLine>();
  for (const set of sets) {
    for (const line of set) {
      const key = lineKey(line);
      const current = byKey.get(key);
      if (current) byKey.set(key, { ...line, amountCents: current.amountCents + line.amountCents });
      else byKey.set(key, { ...line });
    }
  }
  return [...byKey.values()].filter((l) => l.amountCents !== 0);
}

/** `after` minus `before`, per line. Quantity and rate are the recalculated ones. */
export function diffLines(after: PayslipLine[], before: PayslipLine[]): PayslipLine[] {
  const afterByKey = new Map(sumLines([after]).map((l) => [lineKey(l), l]));
  const beforeByKey = new Map(sumLines([before]).map((l) => [lineKey(l), l]));
  const out: PayslipLine[] = [];
  for (const key of new Set([...afterByKey.keys(), ...beforeByKey.keys()])) {
    const a = afterByKey.get(key);
    const b = beforeByKey.get(key);
    const amount = (a?.amountCents ?? 0) - (b?.amountCents ?? 0);
    if (amount === 0) continue;
    const base = (a ?? b)!;
    out.push({ ...base, amountCents: amount, quantity: a?.quantity ?? null, rate: a?.rate ?? null });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Numbers nested in JSON (filing data, accumulators)
// ---------------------------------------------------------------------------

type Json = unknown;

function isRecord(value: Json): value is Record<string, Json> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * `a` plus `sign` × `b` on every number leaf; objects are merged key by key,
 * anything else (strings, booleans, arrays) is taken from `a`, falling back
 * to `b`. Used for filing data and accumulators.
 */
export function combineNumeric(a: Json, b: Json, sign: 1 | -1 = 1): Json {
  if (typeof a === 'number' || typeof b === 'number') {
    return (typeof a === 'number' ? a : 0) + sign * (typeof b === 'number' ? b : 0);
  }
  if (isRecord(a) || isRecord(b)) {
    const left = isRecord(a) ? a : {};
    const right = isRecord(b) ? b : {};
    const out: Record<string, Json> = {};
    for (const key of new Set([...Object.keys(left), ...Object.keys(right)])) {
      out[key] = combineNumeric(left[key], right[key], sign);
    }
    return out;
  }
  return a !== undefined ? a : b;
}

/** `after` minus `before` on numbers; non-numbers come from `after`. */
export function diffNumeric(after: Json, before: Json): Json {
  return combineNumeric(after, before, -1);
}

export function addNumeric(a: Json, b: Json): Json {
  return combineNumeric(a, b, 1);
}

/** Key-wise sum of two accumulator maps. */
export function addYtd(a: Record<string, number>, b: Record<string, number>, sign: 1 | -1 = 1): Record<string, number> {
  const out: Record<string, number> = { ...a };
  for (const [key, value] of Object.entries(b)) out[key] = (out[key] ?? 0) + sign * value;
  return out;
}

// ---------------------------------------------------------------------------
// The correction payslip
// ---------------------------------------------------------------------------

export interface CorrectionBase {
  /** The original payslip. */
  original: PayslipRow;
  /** Final corrections approved for it so far, oldest first. */
  corrections: PayslipRow[];
}

/** What the original payslip plus its corrections add up to today. */
export function effectiveOf(base: CorrectionBase) {
  const rows = [base.original, ...base.corrections];
  let totals = zeroTotals();
  for (const row of rows) totals = addTotals(totals, rowTotals(row));
  const lines = sumLines(rows.map((r) => r.lines));
  const filingData = rows.slice(1).reduce<Json>((acc, row) => addNumeric(acc, row.filingData), base.original.filingData);
  // Accumulators: the original's contribution is its own `ytd` minus the chain before it, so keep
  // contributions in the snapshot: original = ytd - input.ytd; corrections store their deltas.
  const snapshot = base.original.snapshot as { input?: { ytd?: Record<string, number> } };
  const before = snapshot.input?.ytd ?? {};
  let contribution = addYtd(base.original.ytd, before, -1);
  for (const row of base.corrections) {
    const delta = (row.snapshot as { ytdDelta?: Record<string, number> }).ytdDelta ?? {};
    contribution = addYtd(contribution, delta);
  }
  return { totals, lines, filingData: filingData as Record<string, unknown>, contribution };
}

export interface CorrectionResult {
  totals: TotalsCents;
  lines: PayslipLine[];
  filingData: Record<string, unknown>;
  /** The change in the year's accumulators. */
  ytdDelta: Record<string, number>;
}

/** The difference between the recalculated payslip and the payslip as it stands. */
export function correctionFrom(result: PayslipResult, ytdBefore: Record<string, number>, base: CorrectionBase): CorrectionResult {
  const effective = effectiveOf(base);
  const recalculatedContribution = addYtd(result.ytd, ytdBefore, -1);
  return {
    totals: addTotals(resultTotals(result), effective.totals, -1),
    lines: diffLines(result.lines, effective.lines),
    filingData: diffNumeric(result.filingData, effective.filingData) as Record<string, unknown>,
    ytdDelta: addYtd(recalculatedContribution, effective.contribution, -1),
  };
}
