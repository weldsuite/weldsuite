/**
 * A minimal in-memory EvalHost for unit tests of the parser, evaluator and
 * function library. No dependency tracking: formulas in `cells` are evaluated
 * on read.
 *
 *   const run = testHost({ A1: 1, A2: 2, B1: '=A1*10' });
 *   run('SUM(A1:A2)') // → 3
 */

import { parseA1, type Range } from '../address';
import { isMatrix, type Matrix, type Scalar } from '../values';
import { evaluate, resolveResult } from './evaluator';
import './functions';
import { parseFormula } from './parser';
import type { EvalContext, EvalHost } from './types';

export type TestCells = Record<string, Scalar>;

export interface TestHostOptions {
  /** Extra sheets: { Sheet2: { A1: 5 } }. The default sheet is "Sheet1". */
  sheets?: Record<string, TestCells>;
  names?: Record<string, string>;
  /** Fixed clock (epoch ms) for NOW/TODAY. Defaults to 2026-01-15T10:30:00Z. */
  now?: number;
  timezoneOffset?: number;
  random?: () => number;
  /** 0-based rows of Sheet1 hidden by hand, and hidden by a filter. */
  hiddenRows?: number[];
  filteredRows?: number[];
}

export function testHost(
  cells: TestCells = {},
  options: TestHostOptions = {},
): (formula: string, at?: string) => Scalar | Matrix {
  const sheets = new Map<string, Map<string, Scalar>>();
  const add = (name: string, data: TestCells) => {
    const m = new Map<string, Scalar>();
    for (const [a1, v] of Object.entries(data)) {
      const addr = parseA1(a1);
      if (!addr) throw new Error(`Bad address ${a1}`);
      m.set(`${addr.row}:${addr.col}`, v);
    }
    sheets.set(name, m);
  };
  add('Sheet1', cells);
  for (const [name, data] of Object.entries(options.sheets ?? {})) add(name, data);

  const evaluating = new Set<string>();

  const host: EvalHost = {
    cellValue(sheetId, row, col) {
      const raw = sheets.get(sheetId)?.get(`${row}:${col}`) ?? null;
      if (typeof raw === 'string' && raw.startsWith('=')) {
        const key = `${sheetId}!${row}:${col}`;
        if (evaluating.has(key)) return { kind: 'error', code: '#REF!', message: 'Circular reference' };
        evaluating.add(key);
        try {
          const ctx: EvalContext = { host, sheetId, row, col };
          const res = resolveResult(evaluate(parseFormula(raw.slice(1)), ctx), ctx);
          return isMatrix(res) ? (res.data[0]?.[0] ?? null) : res;
        } finally {
          evaluating.delete(key);
        }
      }
      return raw;
    },
    forEachValue(sheetId, range, fn) {
      const m = sheets.get(sheetId);
      if (!m) return;
      for (const key of m.keys()) {
        const [r, c] = key.split(':').map(Number) as [number, number];
        if (r >= range.r1 && r <= range.r2 && c >= range.c1 && c <= range.c2) {
          const v = host.cellValue(sheetId, r, c);
          if (v !== null) fn(r, c, v);
        }
      }
    },
    usedRange(sheetId): Range | null {
      const m = sheets.get(sheetId);
      if (!m || m.size === 0) return null;
      let r2 = 0;
      let c2 = 0;
      for (const key of m.keys()) {
        const [r, c] = key.split(':').map(Number) as [number, number];
        r2 = Math.max(r2, r);
        c2 = Math.max(c2, c);
      }
      return { r1: 0, c1: 0, r2, c2 };
    },
    sheetIdByName(name) {
      for (const id of sheets.keys()) if (id.toLowerCase() === name.toLowerCase()) return id;
      return undefined;
    },
    sheetName: (id) => (sheets.has(id) ? id : undefined),
    sheetIds: () => [...sheets.keys()],
    definedName: (name) => {
      for (const [k, v] of Object.entries(options.names ?? {})) if (k.toLowerCase() === name.toLowerCase()) return v;
      return undefined;
    },
    now: () => options.now ?? Date.UTC(2026, 0, 15, 10, 30, 0),
    random: options.random ?? (() => 0.5),
    timezoneOffset: () => options.timezoneOffset ?? 0,
    isRowHidden: (sheetId, row, manual) =>
      sheetId === 'Sheet1' && (!!options.filteredRows?.includes(row) || (manual && !!options.hiddenRows?.includes(row))),
    cellFormula(sheetId, row, col) {
      const raw = sheets.get(sheetId)?.get(`${row}:${col}`);
      return typeof raw === 'string' && raw.startsWith('=') ? raw.slice(1) : undefined;
    },
  };

  return (formula, at = 'Z100') => {
    const addr = parseA1(at)!;
    const ctx: EvalContext = { host, sheetId: 'Sheet1', row: addr.row, col: addr.col };
    return resolveResult(evaluate(parseFormula(formula), ctx), ctx);
  };
}
