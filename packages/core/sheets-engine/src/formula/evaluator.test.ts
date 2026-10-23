import { describe, expect, it } from 'vitest';
import { testHost } from './test-host';
import { parseFormula } from './parser';

describe('parser', () => {
  it('follows Excel precedence', () => {
    const run = testHost();
    expect(run('-2^2')).toBe(4);
    expect(run('2^3^2')).toBe(64);
    expect(run('1+2*3')).toBe(7);
    expect(run('(1+2)*3')).toBe(9);
    expect(run('50%')).toBe(0.5);
    expect(run('"a"&1+1')).toBe('a2');
    expect(run('1+1=2')).toBe(true);
  });

  it('parses references, names, arrays and empty args', () => {
    expect(parseFormula("'My Sheet'!$A$1:B2")).toMatchObject({ type: 'ref', ref: { sheet: 'My Sheet', kind: 'range', r2: 1, c2: 1, absR1: true } });
    expect(parseFormula('A:C')).toMatchObject({ type: 'ref', ref: { kind: 'cols', c1: 0, c2: 2 } });
    expect(parseFormula('3:5')).toMatchObject({ type: 'ref', ref: { kind: 'rows', r1: 2, r2: 4 } });
    expect(parseFormula('LOG10(A1)')).toMatchObject({ type: 'call', name: 'LOG10' });
    expect(parseFormula('IF(A1,,2)')).toMatchObject({ type: 'call', args: [{ type: 'ref' }, { type: 'empty' }, { type: 'number' }] });
    expect(parseFormula('{1,2;3,4}')).toMatchObject({ type: 'array', rows: [[{ value: 1 }, { value: 2 }], [{ value: 3 }, { value: 4 }]] });
    expect(parseFormula('_xlfn.XLOOKUP(1,A:A,B:B)')).toMatchObject({ type: 'call', name: 'XLOOKUP' });
    expect(() => parseFormula('1+')).toThrow();
    expect(() => parseFormula('SUM(1')).toThrow();
  });
});

describe('evaluator', () => {
  it('reads cells, coerces and propagates errors', () => {
    const run = testHost({ A1: 2, A2: '3', A3: true, B1: '=A1*10' });
    expect(run('A1+A2')).toBe(5);
    expect(run('A1+A3')).toBe(3);
    expect(run('B1')).toBe(20);
    expect(run('A9')).toBeNull();
    expect(run('1/0')).toMatchObject({ code: '#DIV/0!' });
    expect(run('"x"+1')).toMatchObject({ code: '#VALUE!' });
    expect(run('NOPE(1)')).toMatchObject({ code: '#NAME?' });
    expect(run('Missing!A1')).toMatchObject({ code: '#REF!' });
  });

  it('lifts operators over ranges into arrays', () => {
    const run = testHost({ A1: 1, A2: 2, A3: 3 });
    expect(run('A1:A3*2')).toEqual({ kind: 'matrix', rows: 3, cols: 1, data: [[2], [4], [6]] });
    expect(run('{1,2}+{10;20}')).toEqual({ kind: 'matrix', rows: 2, cols: 2, data: [[11, 12], [21, 22]] });
  });

  it('compares like Excel', () => {
    const run = testHost();
    expect(run('"a"="A"')).toBe(true);
    expect(run('1<"a"')).toBe(true);
    expect(run('"a"<TRUE')).toBe(true);
    expect(run('A1=0')).toBe(true);
    expect(run('A1=""')).toBe(true);
  });

  it('resolves defined names and other sheets', () => {
    const run = testHost({}, { sheets: { 'Q1 Sales': { A1: 7 } }, names: { rate: '0.21' } });
    expect(run("'Q1 Sales'!A1*2")).toBe(14);
    expect(run('rate*100')).toBe(21);
  });
});
