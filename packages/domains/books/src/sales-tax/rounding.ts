/**
 * Sales tax rounding (docs/plans/weldbooks-us.md §3, research §7).
 *
 * Streamlined Sales Tax rule: carry the computation to at least three
 * decimals and round half-up to the cent (the cent goes up when the third
 * decimal is five or more). A seller rounds per line or once per invoice, and
 * per jurisdiction or on the combined rate; `us/states.ts` holds the choice
 * per state. Money here is dollars (numbers); everything that decides a cent is
 * computed on integers so binary floating point never moves a half-cent.
 */

import { getUsState, type SalesTaxRounding } from '../jurisdictions/us/states';

const MICRO = 1_000_000;

/** Default when a state has no entry: SST, once per invoice per jurisdiction. */
export const DEFAULT_ROUNDING: SalesTaxRounding = { level: 'invoice', scope: 'per_jurisdiction' };

/** Absorbs binary floating point error (0.285 is 0.28499999999999998) without moving a real half cent. */
const EPSILON = 1e-9;

/** The state's rounding rule (`us/states.ts`); SST invoice-level per jurisdiction when it has none. */
export function roundingFor(stateCode: string | null | undefined): SalesTaxRounding {
  return getUsState(stateCode)?.rounding ?? DEFAULT_ROUNDING;
}

/** Dollars to whole cents, half away from zero (credit memos mirror invoices). */
export function toCents(value: number): number {
  if (!Number.isFinite(value) || value === 0) return 0;
  const cents = Math.floor(Math.abs(value) * 100 + 0.5 + EPSILON);
  if (cents === 0) return 0;
  return value < 0 ? -cents : cents;
}

export function fromCents(cents: number): number {
  return cents === 0 ? 0 : cents / 100;
}

/** Round half-up (half away from zero) to `decimals` places. */
export function roundHalfUp(value: number, decimals = 2): number {
  if (!Number.isFinite(value) || value === 0) return 0;
  const factor = 10 ** Math.min(Math.max(decimals, 0), 8);
  const rounded = Math.floor(Math.abs(value) * factor + 0.5 + EPSILON) / factor;
  if (rounded === 0) return 0;
  return value < 0 ? -rounded : rounded;
}

/** Keep six decimals, the precision `tax_lines.unrounded_tax_amount` stores. */
export function snap6(value: number): number {
  if (!Number.isFinite(value)) return 0;
  const micro = Math.round(value * MICRO);
  return micro === 0 ? 0 : micro / MICRO;
}

/**
 * Split a whole-cent total over weights with the largest-remainder method, so
 * the parts add up to the total exactly. Equal shares when every weight is
 * zero. Ties go to the earlier entry.
 */
export function allocateCents(totalCents: number, weights: number[]): number[] {
  const n = weights.length;
  if (n === 0) return [];
  const sign = totalCents < 0 ? -1 : 1;
  const total = Math.abs(Math.round(totalCents));
  let w = weights.map((x) => Math.abs(x));
  let sum = w.reduce((a, b) => a + b, 0);
  if (sum <= 0) {
    w = weights.map(() => 1);
    sum = n;
  }
  const shares = w.map((x) => (total * x) / sum);
  const floors = shares.map((s) => Math.floor(s + 1e-9));
  let remainder = total - floors.reduce((a, b) => a + b, 0);
  const order = shares
    .map((s, index) => ({ index, frac: s - Math.floor(s + 1e-9) }))
    .sort((a, b) => b.frac - a.frac || a.index - b.index);
  for (let k = 0; remainder > 0 && k < order.length * 2; k += 1) {
    floors[order[k % order.length].index] += 1;
    remainder -= 1;
  }
  // Epsilon guard: never hand out more than the total.
  for (let k = order.length - 1; remainder < 0 && k >= 0; k -= 1) {
    const idx = order[k].index;
    if (floors[idx] > 0) {
      floors[idx] -= 1;
      remainder += 1;
    }
  }
  return floors.map((f) => (f === 0 ? 0 : sign * f));
}

export interface TaxCell {
  lineId: string;
  /** Groups the cells of one jurisdiction across the document. */
  jurisdictionKey: string;
  /** Tax before rounding, dollars, at least three decimals. */
  unrounded: number;
}

/**
 * Round the tax of a document's (line, jurisdiction) cells. Returns whole
 * cents aligned with `cells`, in cell order (lines in document order).
 *
 * - line + per_jurisdiction: each cell on its own;
 * - line + combined: one rounding per line, spread over its jurisdictions;
 * - invoice + per_jurisdiction: one rounding per jurisdiction over the whole
 *   document, the difference sitting on the jurisdiction's last line;
 * - invoice + combined: one rounding for the document, spread over the cells.
 */
export function roundTaxCells(cells: TaxCell[], rounding: SalesTaxRounding = DEFAULT_ROUNDING): number[] {
  const out = new Array<number>(cells.length).fill(0);
  if (cells.length === 0) return out;

  if (rounding.level === 'line' && rounding.scope === 'per_jurisdiction') {
    return cells.map((c) => toCents(c.unrounded));
  }

  if (rounding.scope === 'combined') {
    const groups = new Map<string, number[]>();
    cells.forEach((c, i) => {
      const key = rounding.level === 'line' ? c.lineId : '*';
      const list = groups.get(key);
      if (list) list.push(i);
      else groups.set(key, [i]);
    });
    for (const indexes of groups.values()) {
      const total = toCents(indexes.reduce((s, i) => s + cells[i].unrounded, 0));
      const parts = allocateCents(
        total,
        indexes.map((i) => cells[i].unrounded),
      );
      indexes.forEach((cellIndex, k) => {
        out[cellIndex] = parts[k];
      });
    }
    return out;
  }

  // invoice + per_jurisdiction
  const groups = new Map<string, number[]>();
  cells.forEach((c, i) => {
    const list = groups.get(c.jurisdictionKey);
    if (list) list.push(i);
    else groups.set(c.jurisdictionKey, [i]);
  });
  for (const indexes of groups.values()) {
    const total = toCents(indexes.reduce((s, i) => s + cells[i].unrounded, 0));
    let assigned = 0;
    indexes.forEach((cellIndex, k) => {
      if (k === indexes.length - 1) {
        out[cellIndex] = total - assigned;
      } else {
        out[cellIndex] = toCents(cells[cellIndex].unrounded);
        assigned += out[cellIndex];
      }
    });
  }
  return out;
}
