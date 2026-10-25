import { describe, expect, it } from 'vitest';
import type { Matrix, Scalar } from '../../values';
import { testHost } from '../test-host';

function data(m: Scalar | Matrix): Scalar[][] {
  if (typeof m === 'object' && m !== null && m.kind === 'matrix') return m.data;
  throw new Error(`expected an array, got ${JSON.stringify(m)}`);
}

const run = testHost(
  { A1: 1, A2: 'text', A3: true, A4: { kind: 'error', code: '#N/A' }, A5: { kind: 'error', code: '#DIV/0!' }, B1: '=""' },
  { sheets: { Sheet2: { A1: 5 } } },
);

describe('IS functions', () => {
  it('ISBLANK only accepts truly empty cells', () => {
    expect(run('ISBLANK(A9)')).toBe(true);
    expect(run('ISBLANK(B1)')).toBe(false);
    expect(run('ISBLANK("")')).toBe(false);
    expect(run('ISBLANK(A1)')).toBe(false);
  });

  it('type tests', () => {
    expect(run('ISNUMBER(A1)')).toBe(true);
    expect(run('ISNUMBER("1")')).toBe(false);
    expect(run('ISTEXT(A2)')).toBe(true);
    expect(run('ISTEXT(A1)')).toBe(false);
    expect(run('ISNONTEXT(A1)')).toBe(true);
    expect(run('ISNONTEXT(A9)')).toBe(true);
    expect(run('ISNONTEXT(A2)')).toBe(false);
    expect(run('ISLOGICAL(A3)')).toBe(true);
    expect(run('ISLOGICAL("TRUE")')).toBe(false);
  });

  it('error tests do not propagate the error', () => {
    expect(run('ISERROR(A4)')).toBe(true);
    expect(run('ISERROR(1/0)')).toBe(true);
    expect(run('ISERROR(A1)')).toBe(false);
    expect(run('ISERR(A4)')).toBe(false);
    expect(run('ISERR(A5)')).toBe(true);
    expect(run('ISNA(A4)')).toBe(true);
    expect(run('ISNA(NA())')).toBe(true);
    expect(run('ISNA(A5)')).toBe(false);
  });

  it('lift over ranges', () => {
    expect(data(run('ISNUMBER(A1:A3)'))).toEqual([[true], [false], [false]]);
    expect(data(run('ISERROR(A3:A5)'))).toEqual([[false], [true], [true]]);
    expect(data(run('ISBLANK(A5:A6)'))).toEqual([[false], [true]]);
  });

  it('ISREF looks at the unevaluated argument', () => {
    expect(run('ISREF(A1)')).toBe(true);
    expect(run('ISREF(A1:B2)')).toBe(true);
    expect(run('ISREF(Sheet2!A1)')).toBe(true);
    expect(run('ISREF(1)')).toBe(false);
    expect(run('ISREF("A1")')).toBe(false);
    expect(run('ISREF(Missing!A1)')).toBe(false);
  });

  it('ISEVEN and ISODD truncate and reject booleans', () => {
    expect(run('ISEVEN(2)')).toBe(true);
    expect(run('ISEVEN(-1)')).toBe(false);
    expect(run('ISEVEN(2.5)')).toBe(true);
    expect(run('ISEVEN(A9)')).toBe(true);
    expect(run('ISODD(3)')).toBe(true);
    expect(run('ISODD(-3.9)')).toBe(true);
    expect(run('ISODD("5")')).toBe(true);
    expect(run('ISEVEN(TRUE)')).toMatchObject({ code: '#VALUE!' });
    expect(run('ISODD("x")')).toMatchObject({ code: '#VALUE!' });
    expect(run('ISODD(A5)')).toMatchObject({ code: '#DIV/0!' });
  });
});

describe('N, NA, TYPE, ERROR.TYPE', () => {
  it('N converts to a number', () => {
    expect(run('N(7)')).toBe(7);
    expect(run('N("7")')).toBe(0);
    expect(run('N(TRUE)')).toBe(1);
    expect(run('N(A9)')).toBe(0);
    expect(run('N(A2)')).toBe(0);
    expect(run('N(A1:A3)')).toBe(1);
    expect(run('N(A5)')).toMatchObject({ code: '#DIV/0!' });
    expect(data(run('N({1,"a",TRUE})'))).toEqual([[1, 0, 1]]);
  });

  it('NA', () => {
    expect(run('NA()')).toMatchObject({ code: '#N/A' });
  });

  it('TYPE', () => {
    expect(run('TYPE(1)')).toBe(1);
    expect(run('TYPE(A9)')).toBe(1);
    expect(run('TYPE("a")')).toBe(2);
    expect(run('TYPE(A3)')).toBe(4);
    expect(run('TYPE(1/0)')).toBe(16);
    expect(run('TYPE({1,2})')).toBe(64);
    expect(run('TYPE(A1:A3)')).toBe(64);
  });

  it('ERROR.TYPE', () => {
    expect(run('ERROR.TYPE(#NULL!)')).toBe(1);
    expect(run('ERROR.TYPE(1/0)')).toBe(2);
    expect(run('ERROR.TYPE("a"+1)')).toBe(3);
    expect(run('ERROR.TYPE(Missing!A1)')).toBe(4);
    expect(run('ERROR.TYPE(NOPE())')).toBe(5);
    expect(run('ERROR.TYPE(SQRT(-1))')).toBe(6);
    expect(run('ERROR.TYPE(NA())')).toBe(7);
    expect(run('ERROR.TYPE(1)')).toMatchObject({ code: '#N/A' });
    expect(data(run('ERROR.TYPE(A4:A5)'))).toEqual([[7], [2]]);
  });
});

describe('SHEET and SHEETS', () => {
  it('SHEET gives tab positions', () => {
    expect(run('SHEET()')).toBe(1);
    expect(run('SHEET(A1)')).toBe(1);
    expect(run('SHEET(Sheet2!A1)')).toBe(2);
    expect(run('SHEET("sheet2")')).toBe(2);
    expect(run('SHEET("Nope")')).toMatchObject({ code: '#N/A' });
  });

  it('SHEETS counts sheets', () => {
    expect(run('SHEETS()')).toBe(2);
    expect(run('SHEETS(A1:B2)')).toBe(1);
  });
});
