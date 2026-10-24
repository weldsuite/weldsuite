import { describe, expect, it } from 'vitest';
import { Engine } from '../calc/engine';
import { Sheet, Workbook } from '../model/workbook';
import { applyOp } from '../ops/apply';
import type { CellPatch } from '../ops/types';
import { err, type Scalar } from '../values';
import { computePivot, parsePivotFormula, pivotFormula, type PivotLayoutSpec, type PivotSpec } from './pivot';

const DATA: Scalar[][] = [
  ['Region', 'Product', 'Year', 'Amount', 'Status'],
  ['North', 'Tea', 2025, 10, 'Paid'],
  ['North', 'Coffee', 2025, 20, 'Paid'],
  ['South', 'Tea', 2025, 5, 'Open'],
  ['North', 'Tea', 2026, 7, 'Paid'],
  ['South', 'Coffee', 2026, 8, 'Paid'],
  [null, null, null, null, null],
  ['south', 'Tea', 2026, 'n/a', 'Paid'],
];

const spec = (over: Partial<PivotLayoutSpec> = {}): PivotLayoutSpec => ({ rows: [], columns: [], values: [], filters: [], totals: true, ...over });
const cells = (s: PivotLayoutSpec) => {
  const r = computePivot(DATA, s);
  if ('kind' in r) throw new Error(r.code);
  return r;
};

describe('computePivot', () => {
  it('groups rows (text ignoring case), with values and a grand total', () => {
    const r = cells(spec({ rows: [{ field: 'region' }], values: [{ field: 'Amount', fn: 'SUM' }, { field: 'Amount', fn: 'COUNTA' }] }));
    expect(r.cells).toEqual([
      ['Region', 'SUM of Amount', 'COUNTA of Amount'],
      ['North', 37, 3],
      ['South', 13, 3],
      ['Grand Total', 50, 6],
    ]);
    expect(r).toMatchObject({ headerRows: 1, labelCols: 1, valueOf: [-1, 0, 1], totalRows: [3], totalCols: [] });
  });

  it('lays out column groups with grand total columns, and sorts descending', () => {
    const r = cells(spec({ rows: [{ field: 'Region', descending: true }], columns: [{ field: 'Year' }], values: [{ field: 'Amount', fn: 'SUM' }] }));
    expect(r.cells).toEqual([
      ['SUM of Amount', 'Year', null, null],
      ['Region', 2025, 2026, 'Grand Total'],
      ['South', 5, 8, 13],
      ['North', 30, 7, 37],
      ['Grand Total', 35, 15, 50],
    ]);
    expect(r).toMatchObject({ headerRows: 2, valueOf: [-1, 0, 0, 0], totalCols: [3], totalRows: [4] });
  });

  it('adds subtotals for outer row groups, and labels each group once', () => {
    const r = cells(spec({ rows: [{ field: 'Region' }, { field: 'Product' }], values: [{ field: 'Amount', fn: 'SUM' }] }));
    expect(r.cells).toEqual([
      ['Region', 'Product', 'SUM of Amount'],
      ['North', 'Coffee', 20],
      [null, 'Tea', 17],
      ['North Total', null, 37],
      ['South', 'Coffee', 8],
      [null, 'Tea', 5],
      ['South Total', null, 13],
      ['Grand Total', null, 50],
    ]);
    expect(r.totalRows).toEqual([3, 6, 7]);
    const plain = cells(spec({ rows: [{ field: 'Region' }, { field: 'Product' }], values: [{ field: 'Amount', fn: 'SUM' }], totals: false }));
    expect(plain.cells).toHaveLength(5);
  });

  it('filters, aggregates in every way, and names fields it cannot find', () => {
    const r = cells(
      spec({
        rows: [{ field: 'Product' }],
        values: ['AVERAGE', 'MIN', 'MAX', 'COUNT', 'COUNTUNIQUE', 'MEDIAN'].map((fn) => ({ field: 'Amount', fn: fn as 'SUM' })),
        filters: [{ field: 'Status', values: ['paid'] }],
      }),
    );
    expect(r.cells.slice(1)).toEqual([
      ['Coffee', 14, 8, 20, 2, 2, 14],
      ['Tea', 8.5, 7, 10, 2, 3, 8.5],
      ['Grand Total', 11.25, 7, 20, 4, 5, 9],
    ]);
    expect(computePivot(DATA, spec({ rows: [{ field: 'Colour' }] }))).toEqual(err('#REF!', 'The source has no field "Colour"'));
    expect(cells(spec({ values: [{ field: 'Amount', fn: 'SUM' }] })).cells).toEqual([['', 'SUM of Amount'], ['Grand Total', 50]].map((row, i) => (i === 0 ? [null, 'SUM of Amount'] : row)));
  });
});

describe('PIVOT formulas', () => {
  const full: PivotSpec = {
    source: 'Data!$A$1:$E$8',
    rows: [{ field: 'Region' }, { field: 'Product', descending: true }],
    columns: [{ field: 'Year' }],
    values: [{ field: 'Amount', fn: 'SUM' }],
    filters: [{ field: 'Status', values: ['Paid', ''] }],
    totals: false,
  };

  it('writes a spec as a formula and reads it back', () => {
    const text = pivotFormula(full);
    expect(text).toBe('PIVOT(Data!$A$1:$E$8,{"Region","-Product"},"Year","SUM:Amount",{"Status","Paid";"Status",""},FALSE)');
    expect(parsePivotFormula(text)).toEqual(full);
    const simple = { ...full, rows: [{ field: 'Say "hi"' }], columns: [], filters: [], totals: true };
    expect(pivotFormula(simple)).toBe('PIVOT(Data!$A$1:$E$8,"Say ""hi""","","SUM:Amount")');
    expect(parsePivotFormula(pivotFormula(simple))).toEqual(simple);
    expect(parsePivotFormula('SUM(A1:A3)')).toBeNull();
  });

  it('spills, and follows its source as it changes and moves', () => {
    const wb = new Workbook();
    wb.sheets.push(new Sheet('d', 'Data'), new Sheet('p', 'Pivot'));
    const e = new Engine(wb, { now: () => 0, random: () => 0.5, timezoneOffset: () => 0 });
    const data: CellPatch[] = DATA.flatMap((row, r) => row.map((v, c): CellPatch => [r, c, v === null ? null : { v }]));
    applyOp(e, { type: 'setCells', sheetId: 'd', cells: data });
    applyOp(e, { type: 'setCells', sheetId: 'p', cells: [[0, 0, { v: null, f: 'PIVOT(Data!A:E,"Region","","SUM:Amount")' }]] });
    const grid = () => [0, 1, 2, 3].map((r) => [e.getValue('p', r, 0), e.getValue('p', r, 1)]);
    expect(grid()).toEqual([
      ['Region', 'SUM of Amount'],
      ['North', 37],
      ['South', 13],
      ['Grand Total', 50],
    ]);
    applyOp(e, { type: 'setCells', sheetId: 'd', cells: [[1, 3, { v: 100 }]] });
    expect(e.getValue('p', 1, 1)).toBe(127);
    applyOp(e, { type: 'insertDims', sheetId: 'd', sheetName: 'Data', axis: 'col', at: 0, count: 1 });
    expect(e.getCell('p', 0, 0)?.f).toBe('PIVOT(Data!B:F,"Region","","SUM:Amount")');
    expect(e.getValue('p', 3, 1)).toBe(140);
  });
});
