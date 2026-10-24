import { describe, expect, it } from 'vitest';
import { EN_LOCALE, MIN_CHART_SIZE } from '@weldsuite/sheets-engine';
import { chartAt, chartClip, chartRect, draggedChart, handleCenter } from '../charts/chart-geometry';
import { niceScale } from '../charts/draw-chart';
import { computeLayout } from '../grid/geometry';
import { insertChart, parseDataRange, rangeLabel, removeChart, variantOf, withRange, withVariant } from './charts';
import { cellSelection } from './selection';
import { SheetController } from './sheet-controller';

/** Monthly sales in A1:C4 (header row, month labels), selected at B2. */
function make() {
  const ctl = new SheetController(null, { locale: EN_LOCALE, formulaLocale: { decimal: '.' } });
  const rows = [
    ['Month', 'North', 'South'],
    ['Jan', '10', '4'],
    ['Feb', '12', '6'],
    ['Mar', '9', '8'],
  ];
  rows.forEach((cells, r) => cells.forEach((text, c) => ctl.setInput(r, c, text)));
  ctl.select(cellSelection(1, 1));
  return ctl;
}

describe('chart commands', () => {
  it('inserts a chart of the block around the active cell, picked, with its editor open', () => {
    const ctl = make();
    const chart = insertChart(ctl)!;
    expect(chart).toMatchObject({
      type: 'column',
      categories: 'Sheet1!$A$2:$A$4',
      series: [
        { name: 'Sheet1!$B$1', values: 'Sheet1!$B$2:$B$4' },
        { name: 'Sheet1!$C$1', values: 'Sheet1!$C$2:$C$4' },
      ],
      anchor: { row: 0, col: 4, dx: 0, dy: 0 },
    });
    expect(ctl.selectedChart).toBe(chart.id);
    expect(ctl.panel).toBe('chart');
    expect(ctl.chartData(chart).series.map((s) => [s.name, s.values])).toEqual([
      ['North', [10, 12, 9]],
      ['South', [4, 6, 8]],
    ]);

    // Selecting cells puts it down; undo takes it away.
    ctl.select(cellSelection(0, 0));
    expect(ctl.selectedChart).toBeNull();
    expect(ctl.panel).toBeNull();
    ctl.undo();
    expect(ctl.sheet.charts).toEqual([]);
  });

  it('rereads its range the other way round, keeping series colours by position', () => {
    const ctl = make();
    const chart = { ...insertChart(ctl)!, series: [] as never[] };
    const coloured = { ...chart, series: [{ values: 'x', color: '#123456' }] };
    const at = parseDataRange(ctl, 'A1:C4')!;
    const byRows = withRange(ctl, coloured, at, { seriesIn: 'rows', headers: true, labels: true });
    expect(byRows.categories).toBe('Sheet1!$B$1:$C$1');
    expect(byRows.series.map((s) => s.name)).toEqual(['Sheet1!$A$2', 'Sheet1!$A$3', 'Sheet1!$A$4']);
    expect(byRows.series[0]!.color).toBe('#123456');
    const bare = withRange(ctl, chart, at, { seriesIn: 'columns', headers: false, labels: false });
    expect(bare.categories).toBeUndefined();
    expect(bare.series).toHaveLength(3);
  });

  it('shows ranges sheet-qualified only on another sheet, and reads them back', () => {
    const ctl = make();
    const at = parseDataRange(ctl, "='Sheet1'!B2:C4")!;
    expect(at).toEqual({ sheetId: ctl.activeSheetId, range: { r1: 1, c1: 1, r2: 3, c2: 2 } });
    expect(rangeLabel(ctl, at)).toBe('B2:C4');
    expect(parseDataRange(ctl, 'not a range')).toBeNull();
  });

  it('maps chart types with stacking to the variants the panel offers', () => {
    const ctl = make();
    const chart = insertChart(ctl)!;
    expect(variantOf(chart)).toBe('column');
    const stacked = withVariant(chart, 'percentBar');
    expect(stacked).toMatchObject({ type: 'bar', stacking: 'percent' });
    expect(variantOf(stacked)).toBe('percentBar');
    expect(withVariant(stacked, 'pie').stacking).toBeUndefined();
  });

  it('keeps chart data apart per sheet, where ids can repeat', () => {
    const ctl = make();
    const first = ctl.activeSheetId;
    const chart = insertChart(ctl)!;
    ctl.addSheet();
    const second = ctl.activeSheetId;
    ctl.setInput(1, 0, '99');
    const other = { ...chart, series: [{ values: 'Sheet2!$A$2' }] };
    delete other.categories;
    ctl.apply({ type: 'patchCharts', sheetId: second, set: [other] });
    // Same id on both sheets, no edit in between: each sheet shows its own.
    ctl.setActiveSheet(first);
    expect(ctl.chartData(ctl.sheet.charts[0]!).series[0]!.values).toEqual([10, 12, 9]);
    ctl.setActiveSheet(second);
    expect(ctl.chartData(ctl.sheet.charts[0]!).series[0]!.values).toEqual([99]);
  });

  it('removes a chart and lets go of it', () => {
    const ctl = make();
    const chart = insertChart(ctl)!;
    removeChart(ctl, chart.id);
    expect(ctl.sheet.charts).toEqual([]);
    expect(ctl.selectedChart).toBeNull();
  });
});

describe('charts on the grid', () => {
  it('finds the chart under the pointer, and the handles of the picked one', () => {
    const ctl = make();
    const chart = insertChart(ctl)!;
    const layout = computeLayout(ctl.sheet, 1200, 800, 0, 0);
    const rect = chartRect(layout, ctl.sheet, chart);
    expect(rect).toMatchObject({ x: layout.rowHeaderWidth + ctl.sheet.cols.offsetOf(4), y: layout.colHeaderHeight, w: 480, h: 300 });
    expect(chartAt(layout, ctl.sheet, rect.x + 50, rect.y + 50, null)).toEqual({ chart });
    const [hx, hy] = handleCenter(rect, 'se');
    expect(chartAt(layout, ctl.sheet, hx + 2, hy + 2, chart.id)).toEqual({ chart, handle: 'se' });
    expect(chartAt(layout, ctl.sheet, hx + 2, hy + 2, null)).toBeNull();
    expect(chartAt(layout, ctl.sheet, rect.x - 5, rect.y + 50, chart.id)).toBeNull();
  });

  it('keeps a chart anchored past frozen panes out of them', () => {
    const ctl = make();
    const chart = insertChart(ctl)!;
    ctl.setFreeze(1, 1);
    const layout = computeLayout(ctl.sheet, 1200, 800, 0, 0);
    expect(chartClip(layout, { ...chart, anchor: { ...chart.anchor, row: 2 } }).y).toBe(layout.colHeaderHeight + layout.frozenHeight);
    // Anchored in a frozen row: it may draw over the frozen rows too.
    expect(chartClip(layout, chart).y).toBe(layout.colHeaderHeight);
  });

  it('moves and resizes in sheet pixels, anchoring to the cell under the new corner', () => {
    const ctl = make();
    const sheet = ctl.sheet;
    const chart = insertChart(ctl)!;
    const colW = sheet.cols.sizeOf(4);
    const rowH = sheet.rows.sizeOf(0);
    const moved = draggedChart(sheet, chart, null, colW + 7, rowH * 2 + 3);
    expect(moved.anchor).toEqual({ row: 2, col: 5, dx: 7, dy: 3 });
    expect([moved.width, moved.height]).toEqual([480, 300]);
    // Dragged past the top-left corner: it stops there.
    expect(draggedChart(sheet, chart, null, -100_000, -100_000).anchor).toEqual({ row: 0, col: 0, dx: 0, dy: 0 });

    const wider = draggedChart(sheet, chart, 'se', 40, -20);
    expect(wider).toMatchObject({ anchor: chart.anchor, width: 520, height: 280 });
    // The top-left handle moves the corner and keeps the opposite one.
    const fromCorner = draggedChart(sheet, chart, 'nw', 10, 0);
    expect(fromCorner).toMatchObject({ anchor: { ...chart.anchor, dx: 10 }, width: 470 });
    expect(draggedChart(sheet, chart, 'e', -10_000, 0).width).toBe(MIN_CHART_SIZE);
  });
});

describe('chart scales', () => {
  it('picks round ticks that cover the values', () => {
    expect(niceScale(0, 37)).toEqual({ min: 0, max: 40, ticks: [0, 10, 20, 30, 40] });
    expect(niceScale(-3, 7).ticks).toEqual([-5, 0, 5, 10]);
    expect(niceScale(0.1, 0.35).ticks).toEqual([0.1, 0.2, 0.3, 0.4]);
    expect(niceScale(5, 5)).toMatchObject({ min: 0, max: 10 });
  });
});
