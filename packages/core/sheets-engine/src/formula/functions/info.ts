/**
 * Information functions: the IS* tests, N, NA, TYPE, ERROR.TYPE, SHEET and
 * SHEETS. The IS* tests lift over arrays (=ISNUMBER(A1:A3) spills) except
 * ISREF, which needs the unevaluated reference.
 */

import {
  ERR,
  isError,
  isMatrix,
  isRange,
  matrix,
  toNumber,
  type ErrorCode,
  type EvalValue,
  type Scalar,
} from '../../values';
import type { FunctionSpec } from '../types';
import { toScalar } from './helpers';

function is(name: string, test: (v: Scalar) => boolean): FunctionSpec {
  return {
    name,
    minArgs: 1,
    maxArgs: 1,
    scalarArgs: 'all',
    impl: (args, ctx) => test(toScalar(args[0]!, ctx)),
  };
}

/** ISEVEN/ISODD: numbers and numeric text, truncated; booleans are #VALUE! as in Excel. */
function parity(name: string, odd: boolean): FunctionSpec {
  return {
    name,
    minArgs: 1,
    maxArgs: 1,
    scalarArgs: 'all',
    impl(args, ctx) {
      const v = toScalar(args[0]!, ctx);
      if (typeof v === 'boolean') return ERR.value;
      const n = toNumber(v);
      if (isError(n)) return n;
      return (Math.abs(Math.trunc(n)) % 2 === 1) === odd;
    },
  };
}

const ERROR_TYPE: Record<ErrorCode, number> = {
  '#NULL!': 1,
  '#DIV/0!': 2,
  '#VALUE!': 3,
  '#REF!': 4,
  '#NAME?': 5,
  '#NUM!': 6,
  '#N/A': 7,
  '#SPILL!': 9,
  '#CALC!': 14,
};

function toN(v: Scalar): Scalar {
  if (typeof v === 'number' || isError(v)) return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  return 0;
}

function isMulti(v: EvalValue): boolean {
  if (isRange(v)) return v.r1 !== v.r2 || v.c1 !== v.c2;
  return isMatrix(v) && (v.rows > 1 || v.cols > 1);
}

export const infoFunctions: FunctionSpec[] = [
  is('ISBLANK', (v) => v === null),
  is('ISNUMBER', (v) => typeof v === 'number'),
  is('ISTEXT', (v) => typeof v === 'string'),
  is('ISNONTEXT', (v) => typeof v !== 'string'),
  is('ISLOGICAL', (v) => typeof v === 'boolean'),
  is('ISERROR', (v) => isError(v)),
  is('ISERR', (v) => isError(v) && v.code !== '#N/A'),
  is('ISNA', (v) => isError(v) && v.code === '#N/A'),
  { name: 'ISREF', minArgs: 1, maxArgs: 1, impl: (args) => isRange(args[0]) },
  parity('ISEVEN', false),
  parity('ISODD', true),
  {
    /** A reference reads its top-left cell (the classic N(OFFSET(…)) idiom); an array converts element-wise. */
    name: 'N',
    minArgs: 1,
    maxArgs: 1,
    impl(args, ctx) {
      const a = args[0]!;
      if (isRange(a)) return toN(ctx.host.cellValue(a.sheetId, a.r1, a.c1));
      if (isMatrix(a)) return matrix(a.data.map((row) => row.map(toN)));
      return toN(a);
    },
  },
  { name: 'NA', minArgs: 0, maxArgs: 0, impl: () => ERR.na },
  {
    /** 1 number (and blank), 2 text, 4 logical, 16 error, 64 array or multi-cell range. */
    name: 'TYPE',
    minArgs: 1,
    maxArgs: 1,
    impl(args, ctx) {
      const a = args[0]!;
      if (isMulti(a)) return 64;
      const v = toScalar(a, ctx);
      if (isError(v)) return 16;
      if (typeof v === 'string') return 2;
      if (typeof v === 'boolean') return 4;
      return 1;
    },
  },
  {
    name: 'ERROR.TYPE',
    minArgs: 1,
    maxArgs: 1,
    scalarArgs: 'all',
    impl(args, ctx) {
      const v = toScalar(args[0]!, ctx);
      return isError(v) ? ERROR_TYPE[v.code] : ERR.na;
    },
  },
  {
    /** Tab position (1-based) of the formula's sheet, a reference's sheet, or a sheet named by text. */
    name: 'SHEET',
    minArgs: 0,
    maxArgs: 1,
    impl(args, ctx) {
      const ids = ctx.host.sheetIds();
      const position = (id: string | undefined) => {
        const i = id === undefined ? -1 : ids.indexOf(id);
        return i < 0 ? ERR.na : i + 1;
      };
      const a = args[0];
      if (a === undefined || a === null) return position(ctx.sheetId);
      if (isRange(a)) return position(a.sheetId);
      if (isError(a)) return a;
      if (typeof a === 'string') return position(ctx.host.sheetIdByName(a));
      return ERR.na;
    },
  },
  {
    /** Sheets in the workbook, or in a reference (always 1: 3D references are not supported). */
    name: 'SHEETS',
    minArgs: 0,
    maxArgs: 1,
    impl(args, ctx) {
      const a = args[0];
      if (a === undefined || a === null) return ctx.host.sheetIds().length;
      if (isRange(a)) return 1;
      if (isError(a)) return a;
      return ERR.ref;
    },
  },
];
