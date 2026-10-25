import { describe, expect, it } from 'vitest';
import { Engine } from '../calc/engine';
import type { Chart } from '../model/charts';
import { Sheet, Workbook } from '../model/workbook';
import { applyOp } from '../ops/apply';
import { isWellFormedOp } from '../ops/shape';
import { transform } from '../ops/transform';
import type { CellPatch, Op } from '../ops/types';
import { validateOp } from '../ops/validate';
import { chartData, chartSourceOf, guessChartSource, seriesFromRange } from './data';

const S = 's1';

/** Sales: Month / Revenue / Costs in A1:C4, and a second sheet. */
function engine(): Engine {
  const wb = new Workbook();
  wb.sheets.push(new Sheet(S, 'Sales'), new Sheet('s2', 'Other'));
  const e = new Engine(wb, { now: () => 0, random: () => 0.5, timezoneOffset: () => 0 });
  const rows: CellPatch[] = [
    [0, 0, { v: 'Month' }],
    [0, 1, { v: 'Revenue' }],
    [0, 2, { v: 'Costs' }],
    [1, 0, { v: 'Jan' }],
    [1, 1, { v: 10 }],
    [1, 2, { v: 4 }],
    [2, 0, { v: 'Feb' }],
    [2, 1, { v: 12 }],
    [2, 2, { v: 'n/a' }],
    [3, 0, { v: 'Mar' }],
    [3, 1, { v: 15 }],
    [3, 2, { v: 6 }],
  ];
  applyOp(e, { type: 'setCells', sheetId: S, cells: rows });
  return e;
}

const chart = (over: Partial<Chart> = {}): Chart => ({
  id: 'c1',
  type: 'column',
  categories: 'Sales!$A$2:$A$4',
  series: [
    { name: 'Sales!$B$1', values: 'Sales!$B$2:$B$4' },
    { name: 'Sales!$C$1', values: 'Sales!$C$2:$C$4' },
  ],
  title: 'Q1',
  anchor: { row: 5, col: 1, dx: 4, dy: 8 },
  width: 400,
  height: 250,
  ...over,
});

const charts = (e: Engine, sheetId = S) => e.workbook.getSheet(sheetId)!.charts;

describe('chart ops', () => {
  it('adds, changes and removes charts, and undoes each', () => {
    const e = engine();
    const added = applyOp(e, { type: 'patchCharts', sheetId: S, set: [chart()] });
    expect(charts(e)).toEqual([chart()]);
    const moved = applyOp(e, { type: 'patchCharts', sheetId: S, set: [chart({ anchor: { row: 9, col: 0, dx: 0, dy: 0 } })] });
    expect(charts(e)[0]!.anchor.row).toBe(9);
    applyOp(e, moved);
    expect(charts(e)).toEqual([chart()]);
    applyOp(e, added);
    expect(charts(e)).toEqual([]);
  });

  it('travels in snapshots and checks its shape and bounds', () => {
    const e = engine();
    applyOp(e, { type: 'patchCharts', sheetId: S, set: [chart()] });
    expect(Engine.fromSnapshot(e.toSnapshot()).workbook.getSheet(S)!.charts).toEqual([chart()]);
    const ok: Op = { type: 'patchCharts', sheetId: S, set: [chart()] };
    expect(isWellFormedOp(ok)).toBe(true);
    expect(validateOp(e.workbook, ok)).toBeNull();
    expect(isWellFormedOp({ ...ok, set: [{ ...chart(), type: 'radar' }] })).toBe(false);
    expect(validateOp(e.workbook, { type: 'patchCharts', sheetId: S, set: [chart({ width: 2 })] })).not.toBeNull();
    expect(validateOp(e.workbook, { type: 'patchCharts', sheetId: S, set: [chart({ anchor: { row: -1, col: 0, dx: 0, dy: 0 } })] })).not.toBeNull();
  });

  it('follows row and column changes, and gets its place back on undo', () => {
    const e = engine();
    applyOp(e, { type: 'patchCharts', sheetId: S, set: [chart()] });
    const insert = applyOp(e, { type: 'insertDims', sheetId: S, sheetName: 'Sales', axis: 'row', at: 0, count: 2 });
    expect(charts(e)[0]).toMatchObject({ anchor: { row: 7 }, categories: 'Sales!$A$4:$A$6' });
    expect(charts(e)[0]!.series[0]).toEqual({ name: 'Sales!$B$3', values: 'Sales!$B$4:$B$6' });
    applyOp(e, insert);
    expect(charts(e)).toEqual([chart()]);
    // Its anchor row deleted: it stays where the rows were.
    const del = applyOp(e, { type: 'deleteDims', sheetId: S, sheetName: 'Sales', axis: 'row', at: 4, count: 3 });
    expect(charts(e)[0]!.anchor).toEqual({ row: 4, col: 1, dx: 4, dy: 0 });
    applyOp(e, del);
    expect(charts(e)).toEqual([chart()]);
  });

  it('follows a renamed sheet', () => {
    const e = engine();
    applyOp(e, { type: 'patchCharts', sheetId: 's2', set: [chart()] });
    applyOp(e, { type: 'renameSheet', sheetId: S, oldName: 'Sales', name: 'Q1 sales' });
    expect(charts(e, 's2')[0]!.series[1]!.values).toBe("'Q1 sales'!$C$2:$C$4");
  });

  it('transforms against row changes and against another patch of the same chart', () => {
    const a: Op = { type: 'patchCharts', sheetId: S, set: [chart()] };
    const insert: Op = { type: 'insertDims', sheetId: S, sheetName: 'Sales', axis: 'col', at: 0, count: 1 };
    const moved = transform(a, insert, false) as Extract<Op, { type: 'patchCharts' }>;
    expect(moved.set![0]).toMatchObject({ anchor: { col: 2 }, categories: 'Sales!$B$2:$B$4' });
    const other: Op = { type: 'patchCharts', sheetId: S, set: [chart({ title: 'Theirs' })] };
    expect(transform(a, other, false)).toEqual({ type: 'batch', ops: [] });
    expect(transform(a, other, true)).toEqual(a);
  });
});

describe('chart data', () => {
  it('reads categories, series names and numbers (text points are gaps)', () => {
    const e = engine();
    expect(chartData(e, S, chart())).toMatchObject({
      categories: ['Jan', 'Feb', 'Mar'],
      series: [
        { name: 'Revenue', values: [10, 12, 15], color: '#4285f4' },
        { name: 'Costs', values: [4, null, 6], color: '#ea4335' },
      ],
    });
    expect(chartData(e, S, chart({ series: [{ name: '"Plan"', values: '$B$2:$B$4', color: '#000000' }] })).series[0]).toMatchObject({ name: 'Plan', color: '#000000' });
    expect(chartData(e, S, chart({ series: [{ values: 'Nowhere!A1:A3' }] })).series[0]!.values).toEqual([]);
  });

  it('reads a block as series, and gives the block back', () => {
    const e = engine();
    const range = { r1: 0, c1: 0, r2: 3, c2: 2 };
    const source = guessChartSource(e, S, range);
    expect(source).toEqual({ seriesIn: 'columns', headers: true, labels: true });
    const made = seriesFromRange(e, S, range, source);
    expect(made).toEqual({ categories: chart().categories, series: chart().series });
    expect(chartSourceOf(e, S, chart())).toEqual({ sheetId: S, range, ...source });
    const byRows = seriesFromRange(e, S, range, { seriesIn: 'rows', headers: false, labels: false });
    expect(byRows.series.map((s) => s.values)).toEqual(['Sales!$A$1:$C$1', 'Sales!$A$2:$C$2', 'Sales!$A$3:$C$3', 'Sales!$A$4:$C$4']);
    expect(chartSourceOf(e, S, { ...chart({ categories: undefined }), ...byRows })).toEqual({ sheetId: S, range, seriesIn: 'rows', headers: false, labels: false });
    // Series scattered over the sheet are not one block.
    expect(chartSourceOf(e, S, chart({ series: [{ values: 'Sales!$B$2:$B$4' }, { values: 'Sales!$D$2:$D$4' }] }))).toBeNull();
  });
});
