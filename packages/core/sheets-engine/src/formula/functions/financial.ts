/**
 * Financial functions: annuities (PMT, FV, PV, NPER, RATE, …), cash-flow
 * analysis (NPV, IRR, XIRR, MIRR, …) and depreciation (SLN, DB, DDB, VDB,
 * SYD), following Excel's formulas, sign conventions (money paid out is
 * negative) and argument checks. NaN and infinite results are #NUM!.
 */

import { ERR, isError, isMatrix, isRange, toNumber, type CellError, type EvalValue } from '../../values';
import type { EvalContext, FunctionSpec } from '../types';
import { bool, finite, num, values2d } from './helpers';

// ---------------------------------------------------------------------------
// Annuity math
// ---------------------------------------------------------------------------

/** (1+r)^n - 1, accurate for small r. */
function growthMinusOne(rate: number, nper: number): number {
  return Math.expm1(nper * Math.log1p(rate));
}

function fvOf(rate: number, nper: number, pmt: number, pv: number, type: number): number {
  if (rate === 0) return -(pv + pmt * nper);
  const g = growthMinusOne(rate, nper);
  return -(pv * (1 + g) + (pmt * (1 + rate * type) * g) / rate);
}

function pvOf(rate: number, nper: number, pmt: number, fv: number, type: number): number {
  if (rate === 0) return -(fv + pmt * nper);
  const g = growthMinusOne(rate, nper);
  return -(fv + (pmt * (1 + rate * type) * g) / rate) / (1 + g);
}

function pmtOf(rate: number, nper: number, pv: number, fv: number, type: number): number {
  if (rate === 0) return -(pv + fv) / nper;
  const g = growthMinusOne(rate, nper);
  return -(rate * (fv + pv * (1 + g))) / ((1 + rate * type) * g);
}

/** Interest part of payment `per` (Excel's IPMT). */
function ipmtOf(rate: number, per: number, nper: number, pv: number, fv: number, type: number): number {
  const pmt = pmtOf(rate, nper, pv, fv, type);
  let interest: number;
  if (per === 1) interest = type === 1 ? 0 : -pv;
  else interest = type === 1 ? fvOf(rate, per - 2, pmt, pv, 1) - pmt : fvOf(rate, per - 1, pmt, pv, 0);
  return interest * rate;
}

/** Excel's payment-type argument: anything non-zero means "at the beginning of the period". */
function typeFlag(n: number): number {
  return n !== 0 ? 1 : 0;
}

/**
 * Newton–Raphson on f from `guess`; NaN when it leaves the domain (rate <= -1)
 * or does not converge.
 */
function newton(f: (x: number) => [number, number], guess: number, maxIter = 100): number {
  let x = guess;
  for (let i = 0; i < maxIter; i++) {
    const [y, dy] = f(x);
    if (!Number.isFinite(y) || !Number.isFinite(dy) || dy === 0) return NaN;
    const next = x - y / dy;
    if (!Number.isFinite(next) || next <= -1) return NaN;
    if (Math.abs(next - x) <= 1e-12 * Math.max(1, Math.abs(next))) return next;
    x = next;
  }
  return NaN;
}

/** RATE: the r where pv·(1+r)^n + pmt·(1+r·type)·((1+r)^n − 1)/r + fv = 0. */
function rateOf(nper: number, pmt: number, pv: number, fv: number, type: number, guess: number): number {
  return newton((r) => {
    if (r === 0) {
      return [pv + pmt * nper + fv, pv * nper + pmt * (type * nper + (nper * (nper - 1)) / 2)];
    }
    const g = growthMinusOne(r, nper);
    const a = 1 + g;
    const da = (nper * a) / (1 + r);
    const b = g / r;
    const db = (da * r - g) / (r * r);
    const c = 1 + r * type;
    return [pv * a + pmt * c * b + fv, pv * da + pmt * (type * b + c * db)];
  }, guess);
}

// ---------------------------------------------------------------------------
// Argument helpers
// ---------------------------------------------------------------------------

/**
 * Reads numeric arguments. An omitted or empty argument takes its default;
 * a required one (NaN default) left empty is 0, as in Excel.
 */
function numbers(args: EvalValue[], ctx: EvalContext, defaults: readonly number[]): number[] | CellError {
  const out: number[] = [];
  for (let i = 0; i < defaults.length; i++) {
    const v = args[i];
    const fallback = defaults[i]!;
    if (v === undefined || v === null) {
      out.push(Number.isNaN(fallback) ? 0 : fallback);
      continue;
    }
    const n = num(v, ctx);
    if (isError(n)) return n;
    out.push(n);
  }
  return out;
}

/**
 * A scalar function of numeric arguments. `defaults` lists every argument:
 * NaN marks a required one, a number the default of an optional one.
 */
function numeric(
  name: string,
  defaults: readonly number[],
  fn: (...a: number[]) => number | CellError,
): FunctionSpec {
  const required = defaults.filter((d) => Number.isNaN(d)).length;
  return {
    name,
    minArgs: required,
    maxArgs: defaults.length,
    scalarArgs: 'all',
    impl: (args, ctx) => {
      const n = numbers(args, ctx, defaults);
      if (isError(n)) return n;
      const r = fn(...n);
      return isError(r) ? r : finite(r);
    },
  };
}

const REQ = NaN;

/**
 * Cash flows in row-major order: numbers inside ranges and arrays (text,
 * logicals and blanks there are skipped), direct arguments coerced. Errors
 * propagate.
 */
function cashFlows(args: EvalValue[], ctx: EvalContext): number[] | CellError {
  const out: number[] = [];
  for (const a of args) {
    if (isRange(a) || isMatrix(a)) {
      const data = values2d(a, ctx);
      if (isError(data)) return data;
      for (const row of data) {
        for (const v of row) {
          if (isError(v)) return v;
          if (typeof v === 'number') out.push(v);
        }
      }
    } else {
      const n = toNumber(a);
      if (isError(n)) return n;
      out.push(n);
    }
  }
  return out;
}

/** XNPV/XIRR value or date lists: every entry must be a number. */
function strictNumbers(v: EvalValue, ctx: EvalContext): number[] | CellError {
  const data = values2d(v, ctx);
  if (isError(data)) return data;
  const out: number[] = [];
  for (const row of data) {
    for (const x of row) {
      if (isError(x)) return x;
      if (typeof x !== 'number') return ERR.value;
      out.push(x);
    }
  }
  return out;
}

/** Values and dates for XNPV/XIRR, with Excel's checks. */
function datedFlows(
  valuesArg: EvalValue,
  datesArg: EvalValue,
  ctx: EvalContext,
): { values: number[]; years: number[] } | CellError {
  const values = strictNumbers(valuesArg, ctx);
  if (isError(values)) return values;
  const dates = strictNumbers(datesArg, ctx);
  if (isError(dates)) return dates;
  if (values.length !== dates.length || values.length === 0) return ERR.num;
  const first = Math.floor(dates[0]!);
  const years: number[] = [];
  for (const d of dates) {
    const day = Math.floor(d);
    if (day < 0 || day < first) return ERR.num;
    years.push((day - first) / 365);
  }
  return { values, years };
}

function hasBothSigns(values: number[]): boolean {
  return values.some((v) => v > 0) && values.some((v) => v < 0);
}

// ---------------------------------------------------------------------------
// Depreciation
// ---------------------------------------------------------------------------

function ddbOf(cost: number, salvage: number, life: number, period: number, factor: number): number {
  let rate = factor / life;
  let oldValue: number;
  if (rate >= 1) {
    rate = 1;
    oldValue = period === 1 ? cost : 0;
  } else {
    oldValue = cost * Math.pow(1 - rate, period - 1);
  }
  const newValue = cost * Math.pow(1 - rate, period);
  const dep = newValue < salvage ? oldValue - salvage : oldValue - newValue;
  return dep < 0 ? 0 : dep;
}

/** Depreciation over the first `period` periods, switching to straight-line when that is larger. */
function interVdb(cost: number, salvage: number, life: number, life1: number, period: number, factor: number): number {
  const end = Math.ceil(period);
  let remaining = cost - salvage;
  let switched = false;
  let sln = 0;
  let total = 0;
  for (let i = 1; i <= end; i++) {
    let term: number;
    if (!switched) {
      const ddb = ddbOf(cost, salvage, life, i, factor);
      sln = remaining / (life1 - (i - 1));
      if (sln > ddb) {
        term = sln;
        switched = true;
      } else {
        term = ddb;
        remaining -= ddb;
      }
    } else {
      term = sln;
    }
    if (i === end) term *= period + 1 - end;
    total += term;
  }
  return total;
}

/** VDB, as Excel (and LibreOffice) compute it, partial periods included. */
function vdbOf(
  cost: number,
  salvage: number,
  life: number,
  start: number,
  end: number,
  factor: number,
  noSwitch: boolean,
): number {
  const intStart = Math.floor(start);
  const intEnd = Math.ceil(end);
  if (noSwitch) {
    let total = 0;
    for (let i = intStart + 1; i <= intEnd; i++) {
      let term = ddbOf(cost, salvage, life, i, factor);
      if (i === intStart + 1) term *= Math.min(end, intStart + 1) - start;
      else if (i === intEnd) term *= end + 1 - intEnd;
      total += term;
    }
    return total;
  }
  let part = 0;
  if (start !== intStart) {
    const value = cost - interVdb(cost, salvage, life, life, intStart, factor);
    part += (start - intStart) * interVdb(value, salvage, life, life - intStart, 1, factor);
  }
  if (end !== intEnd) {
    const tempStart = intEnd - 1;
    const value = cost - interVdb(cost, salvage, life, life, tempStart, factor);
    part += (intEnd - end) * interVdb(value, salvage, life, life - tempStart, intEnd - tempStart, factor);
  }
  const remaining = cost - interVdb(cost, salvage, life, life, intStart, factor);
  return interVdb(remaining, salvage, life, life - intStart, intEnd - intStart, factor) - part;
}

function dbOf(cost: number, salvage: number, life: number, period: number, month: number): number | CellError {
  if (cost < 0 || salvage < 0 || life <= 0 || period <= 0 || month < 1 || month > 12) return ERR.num;
  const p = Math.trunc(period);
  const m = Math.trunc(month);
  if (p > life + 1 || (m === 12 && p > life)) return ERR.num;
  if (cost === 0) return 0;
  // Excel rounds the rate to three decimals.
  const rate = Math.round((1 - Math.pow(salvage / cost, 1 / life)) * 1000) / 1000;
  let total = (cost * rate * m) / 12;
  if (p === 1) return total;
  for (let i = 2; i <= p; i++) {
    const dep = i === life + 1 ? ((cost - total) * rate * (12 - m)) / 12 : (cost - total) * rate;
    if (i === p) return dep;
    total += dep;
  }
  return ERR.num;
}

// ---------------------------------------------------------------------------
// Registry entries
// ---------------------------------------------------------------------------

function cumulative(principal: boolean) {
  return (rate: number, nper: number, pv: number, start: number, end: number, type: number): number | CellError => {
    const s = Math.trunc(start);
    const e = Math.trunc(end);
    if (rate <= 0 || nper <= 0 || pv <= 0 || s < 1 || e < 1 || s > e || e > nper || (type !== 0 && type !== 1)) {
      return ERR.num;
    }
    const pmt = pmtOf(rate, nper, pv, 0, type);
    let total = 0;
    for (let per = s; per <= e; per++) {
      const interest = ipmtOf(rate, per, nper, pv, 0, type);
      total += principal ? pmt - interest : interest;
    }
    return total;
  };
}

export const financialFunctions: FunctionSpec[] = [
  numeric('PMT', [REQ, REQ, REQ, 0, 0], (rate, nper, pv, fv, type) => pmtOf(rate, nper, pv, fv, typeFlag(type))),
  numeric('FV', [REQ, REQ, REQ, 0, 0], (rate, nper, pmt, pv, type) => fvOf(rate, nper, pmt, pv, typeFlag(type))),
  numeric('PV', [REQ, REQ, REQ, 0, 0], (rate, nper, pmt, fv, type) => pvOf(rate, nper, pmt, fv, typeFlag(type))),
  numeric('NPER', [REQ, REQ, REQ, 0, 0], (rate, pmt, pv, fv, type) => {
    const t = typeFlag(type);
    if (rate === 0) return -(pv + fv) / pmt;
    const a = pmt * (1 + rate * t);
    return Math.log((a - fv * rate) / (pv * rate + a)) / Math.log1p(rate);
  }),
  numeric('RATE', [REQ, REQ, REQ, 0, 0, 0.1], (nper, pmt, pv, fv, type, guess) => {
    if (nper <= 0) return ERR.num;
    return rateOf(nper, pmt, pv, fv, typeFlag(type), guess);
  }),
  numeric('IPMT', [REQ, REQ, REQ, REQ, 0, 0], (rate, per, nper, pv, fv, type) => {
    if (per < 1 || per > nper) return ERR.num;
    return ipmtOf(rate, per, nper, pv, fv, typeFlag(type));
  }),
  numeric('PPMT', [REQ, REQ, REQ, REQ, 0, 0], (rate, per, nper, pv, fv, type) => {
    if (per < 1 || per > nper) return ERR.num;
    const t = typeFlag(type);
    return pmtOf(rate, nper, pv, fv, t) - ipmtOf(rate, per, nper, pv, fv, t);
  }),
  numeric('CUMIPMT', [REQ, REQ, REQ, REQ, REQ, REQ], cumulative(false)),
  numeric('CUMPRINC', [REQ, REQ, REQ, REQ, REQ, REQ], cumulative(true)),
  numeric('ISPMT', [REQ, REQ, REQ, REQ], (rate, per, nper, pv) => (nper === 0 ? ERR.div0 : pv * rate * (per / nper - 1))),
  numeric('EFFECT', [REQ, REQ], (rate, npery) => {
    const n = Math.trunc(npery);
    if (rate <= 0 || n < 1) return ERR.num;
    return Math.pow(1 + rate / n, n) - 1;
  }),
  numeric('NOMINAL', [REQ, REQ], (rate, npery) => {
    const n = Math.trunc(npery);
    if (rate <= 0 || n < 1) return ERR.num;
    return n * (Math.pow(1 + rate, 1 / n) - 1);
  }),
  numeric('PDURATION', [REQ, REQ, REQ], (rate, pv, fv) => {
    if (rate <= 0 || pv <= 0 || fv <= 0) return ERR.num;
    return (Math.log(fv) - Math.log(pv)) / Math.log1p(rate);
  }),
  numeric('RRI', [REQ, REQ, REQ], (nper, pv, fv) => {
    if (nper <= 0 || pv === 0) return ERR.num;
    return Math.pow(fv / pv, 1 / nper) - 1;
  }),
  numeric('SLN', [REQ, REQ, REQ], (cost, salvage, life) => (life === 0 ? ERR.div0 : (cost - salvage) / life)),
  numeric('SYD', [REQ, REQ, REQ, REQ], (cost, salvage, life, per) => {
    if (life <= 0 || per <= 0 || per > life) return ERR.num;
    return ((cost - salvage) * (life - per + 1) * 2) / (life * (life + 1));
  }),
  numeric('DB', [REQ, REQ, REQ, REQ, 12], (cost, salvage, life, period, month) => dbOf(cost, salvage, life, period, month)),
  numeric('DDB', [REQ, REQ, REQ, REQ, 2], (cost, salvage, life, period, factor) => {
    if (cost < 0 || salvage < 0 || life <= 0 || period <= 0 || factor <= 0 || period > life) return ERR.num;
    return ddbOf(cost, salvage, life, period, factor);
  }),
  {
    name: 'VDB',
    minArgs: 5,
    maxArgs: 7,
    scalarArgs: 'all',
    impl: (args, ctx) => {
      const n = numbers(args, ctx, [REQ, REQ, REQ, REQ, REQ, 2]);
      if (isError(n)) return n;
      const [cost, salvage, life, start, end, factor] = n as [number, number, number, number, number, number];
      const noSwitch = args[6] === undefined || args[6] === null ? false : bool(args[6], ctx);
      if (isError(noSwitch)) return noSwitch;
      if (cost < 0 || salvage < 0 || life <= 0 || start < 0 || end < start || end > life || factor <= 0 || salvage > cost) {
        return ERR.num;
      }
      return finite(vdbOf(cost, salvage, life, start, end, factor, noSwitch));
    },
  },
  {
    name: 'NPV',
    minArgs: 2,
    maxArgs: 255,
    scalarArgs: [0],
    impl: (args, ctx) => {
      const rate = num(args[0]!, ctx);
      if (isError(rate)) return rate;
      const flows = cashFlows(args.slice(1), ctx);
      if (isError(flows)) return flows;
      if (rate === -1) return ERR.div0;
      let npv = 0;
      flows.forEach((v, i) => {
        npv += v / Math.pow(1 + rate, i + 1);
      });
      return finite(npv);
    },
  },
  {
    name: 'XNPV',
    minArgs: 3,
    maxArgs: 3,
    scalarArgs: [0],
    impl: (args, ctx) => {
      const rate = num(args[0]!, ctx);
      if (isError(rate)) return rate;
      const flows = datedFlows(args[1]!, args[2]!, ctx);
      if (isError(flows)) return flows;
      if (rate <= -1) return ERR.num;
      let npv = 0;
      flows.values.forEach((v, i) => {
        npv += v / Math.pow(1 + rate, flows.years[i]!);
      });
      return finite(npv);
    },
  },
  {
    name: 'IRR',
    minArgs: 1,
    maxArgs: 2,
    scalarArgs: [1],
    impl: (args, ctx) => {
      const flows = cashFlows([args[0]!], ctx);
      if (isError(flows)) return flows;
      const guess = args[1] === undefined || args[1] === null ? 0.1 : num(args[1], ctx);
      if (isError(guess)) return guess;
      if (!hasBothSigns(flows)) return ERR.num;
      return finite(
        newton((r) => {
          let y = 0;
          let dy = 0;
          flows.forEach((v, i) => {
            const d = Math.pow(1 + r, i);
            y += v / d;
            dy -= (i * v) / (d * (1 + r));
          });
          return [y, dy];
        }, guess),
      );
    },
  },
  {
    name: 'XIRR',
    minArgs: 2,
    maxArgs: 3,
    scalarArgs: [2],
    impl: (args, ctx) => {
      const flows = datedFlows(args[0]!, args[1]!, ctx);
      if (isError(flows)) return flows;
      const guess = args[2] === undefined || args[2] === null ? 0.1 : num(args[2], ctx);
      if (isError(guess)) return guess;
      if (!hasBothSigns(flows.values)) return ERR.num;
      return finite(
        newton((r) => {
          let y = 0;
          let dy = 0;
          flows.values.forEach((v, i) => {
            const t = flows.years[i]!;
            const d = Math.pow(1 + r, t);
            y += v / d;
            dy -= (t * v) / (d * (1 + r));
          });
          return [y, dy];
        }, guess),
      );
    },
  },
  {
    name: 'MIRR',
    minArgs: 3,
    maxArgs: 3,
    scalarArgs: [1, 2],
    impl: (args, ctx) => {
      const flows = cashFlows([args[0]!], ctx);
      if (isError(flows)) return flows;
      const financeRate = num(args[1]!, ctx);
      if (isError(financeRate)) return financeRate;
      const reinvestRate = num(args[2]!, ctx);
      if (isError(reinvestRate)) return reinvestRate;
      const n = flows.length;
      let positive = 0;
      let negative = 0;
      flows.forEach((v, i) => {
        if (v > 0) positive += v / Math.pow(1 + reinvestRate, i + 1);
        else if (v < 0) negative += v / Math.pow(1 + financeRate, i + 1);
      });
      if (positive === 0 || negative === 0 || n < 2) return ERR.div0;
      const ratio = (-positive * Math.pow(1 + reinvestRate, n)) / (negative * (1 + financeRate));
      return finite(Math.pow(ratio, 1 / (n - 1)) - 1);
    },
  },
  {
    name: 'FVSCHEDULE',
    minArgs: 2,
    maxArgs: 2,
    scalarArgs: [0],
    impl: (args, ctx) => {
      const principal = num(args[0]!, ctx);
      if (isError(principal)) return principal;
      const data = values2d(args[1]!, ctx);
      if (isError(data)) return data;
      let fv = principal;
      for (const row of data) {
        for (const v of row) {
          if (isError(v)) return v;
          // Blank cells are a 0% period; anything but a number is #VALUE!.
          if (v === null) continue;
          if (typeof v !== 'number') return ERR.value;
          fv *= 1 + v;
        }
      }
      return finite(fv);
    },
  },
];
