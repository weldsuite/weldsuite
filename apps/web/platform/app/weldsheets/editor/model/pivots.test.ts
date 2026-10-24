import { describe, expect, it } from 'vitest';
import { EN_LOCALE } from '@weldsuite/sheets-engine';
import { parseDataRange } from './charts';
import { createPivotTable, fieldValues, MAX_FILTER_VALUES, parseTargetCell, pivotFields, savePivot, suggestedLayout } from './pivots';
import { cellSelection } from './selection';
import { SheetController } from './sheet-controller';

/** Orders in A1:C6: region, product, amount (in euros). */
function make() {
  const ctl = new SheetController(null, { locale: EN_LOCALE, formulaLocale: { decimal: '.' } });
  const rows = [
    ['Region', 'Product', 'Amount'],
    ['North', 'Tea', '10'],
    ['South', 'Tea', '5'],
    ['North', 'Coffee', '20'],
    ['South', 'Coffee', '8'],
    ['', 'Tea', '1'],
  ];
  rows.forEach((cells, r) => cells.forEach((text, c) => text && ctl.setInput(r, c, text)));
  ctl.select({ ranges: [{ r1: 1, c1: 2, r2: 5, c2: 2 }], active: { row: 1, col: 2 }, anchor: { row: 1, col: 2 } });
  ctl.format({ numFmt: '€#,##0.00' });
  ctl.select(cellSelection(0, 0));
  return ctl;
}

const value = (ctl: SheetController, row: number, col: number) => ctl.engine.getValue(ctl.activeSheetId, row, col);

describe('pivot table commands', () => {
  it('suggests rows of the first text field and the sum of the first number field', () => {
    expect(
      suggestedLayout([
        ['Id', 'Name', 'Qty', 'Note'],
        [1, 'a', 3, null],
        [2, 'b', 4, null],
      ]),
    ).toEqual({ rows: [{ field: 'Name' }], columns: [], values: [{ field: 'Id', fn: 'SUM' }], filters: [], totals: true });
    expect(suggestedLayout([['Only']])).toEqual({ rows: [], columns: [], values: [], filters: [], totals: true });
  });

  it('creates a pivot table on a new sheet, selected with its editor open, in one undo step', () => {
    const ctl = make();
    const dataSheet = ctl.activeSheetId;
    const source = parseDataRange(ctl, 'A1:C6');
    expect(createPivotTable(ctl, source, null, 'Pivot table')).toBeNull();
    expect(ctl.sheet.name).toBe('Pivot table 1');
    expect(ctl.engine.getCell(ctl.activeSheetId, 0, 0)?.f).toBe('PIVOT(Sheet1!$A$1:$C$6,"Region","","SUM:Amount")');
    expect([0, 1, 2, 3, 4].map((r) => [value(ctl, r, 0), value(ctl, r, 1)])).toEqual([
      ['Region', 'SUM of Amount'],
      ['North', 30],
      ['South', 13],
      [null, 1],
      ['Grand Total', 44],
    ]);
    expect(ctl.panel).toBe('pivot');
    expect(ctl.pivot).toMatchObject({ row: 0, col: 0, source: { sheetId: dataSheet } });

    ctl.undo();
    expect(ctl.engine.workbook.sheets).toHaveLength(1);
  });

  it('styles the output: bold headings and totals, the number format of the summed field', () => {
    const ctl = make();
    createPivotTable(ctl, parseDataRange(ctl, 'A1:C6'), null, 'Pivot table');
    expect(ctl.cellStyle(0, 0)?.bold).toBe(true);
    expect(ctl.cellStyle(2, 0)?.bold).toBeUndefined();
    expect(ctl.cellStyle(4, 1)).toMatchObject({ bold: true, numFmt: '€#,##0.00' });
    expect(ctl.displayText(1, 1).text).toBe('€30.00');
    expect(ctl.cellStyle(6, 6)).toBeUndefined();

    // A count is not in euros; the cell's own format wins over the table's.
    const table = ctl.pivot!;
    savePivot(ctl, table, { ...table.spec, values: [{ field: 'Amount', fn: 'COUNT' }] });
    expect(ctl.displayText(1, 1).text).toBe('2');
    ctl.select(cellSelection(4, 1));
    ctl.format({ numFmt: '0.0' });
    expect(ctl.displayText(4, 1).text).toBe('5.0');
  });

  it('places a pivot table at a cell, and its editor follows the selection', () => {
    const ctl = make();
    const target = parseTargetCell(ctl, 'F2')!;
    expect(target).toEqual({ sheetId: ctl.activeSheetId, row: 1, col: 5 });
    expect(createPivotTable(ctl, parseDataRange(ctl, 'A1:C6'), target, 'Pivot table')).toBeNull();
    expect(value(ctl, 1, 5)).toBe('Region');
    expect(ctl.panel).toBe('pivot');
    ctl.select(cellSelection(3, 6));
    expect(ctl.panel).toBe('pivot');
    expect(ctl.pivot).toMatchObject({ row: 1, col: 5 });
    ctl.select(cellSelection(0, 0));
    expect(ctl.panel).toBeNull();
    expect(ctl.pivot).toBeNull();
    // Another panel stays open over a pivot table.
    ctl.openPanel('formats');
    ctl.select(cellSelection(1, 5));
    expect(ctl.panel).toBe('formats');
  });

  it('rewrites the formula as the editor changes it', () => {
    const ctl = make();
    createPivotTable(ctl, parseDataRange(ctl, 'A1:C6'), parseTargetCell(ctl, 'F1'), 'Pivot table');
    const table = ctl.pivot!;
    savePivot(ctl, table, {
      ...table.spec,
      rows: [{ field: 'Product', descending: true }],
      filters: [{ field: 'Region', values: ['North'] }],
      totals: false,
    });
    expect(ctl.engine.getCell(ctl.activeSheetId, 0, 5)?.f).toBe('PIVOT(Sheet1!$A$1:$C$6,"-Product","","SUM:Amount",{"Region","North"},FALSE)');
    expect([1, 2].map((r) => [value(ctl, r, 5), value(ctl, r, 6)])).toEqual([
      ['Tea', 10],
      ['Coffee', 20],
    ]);
  });

  it('lists the fields of a source and the values a filter can show', () => {
    const ctl = make();
    const source = parseDataRange(ctl, 'A1:C6')!;
    expect(pivotFields(ctl, source)).toEqual(['Region', 'Product', 'Amount']);
    expect(fieldValues(ctl, source, 'region')).toEqual({ values: ['', 'North', 'South'], complete: true });
    expect(fieldValues(ctl, source, 'Colour')).toEqual({ values: [], complete: true });
  });

  it('says when a field has more values than a filter lists', () => {
    const ctl = new SheetController(null, { locale: EN_LOCALE, formulaLocale: { decimal: '.' } });
    ctl.setInput(0, 0, 'Id');
    for (let r = 1; r <= MAX_FILTER_VALUES + 1; r++) ctl.setInput(r, 0, `id${r}`);
    const ids = fieldValues(ctl, parseDataRange(ctl, `A1:A${MAX_FILTER_VALUES + 2}`)!, 'Id');
    expect(ids.complete).toBe(false);
    expect(ids.values).toHaveLength(MAX_FILTER_VALUES);
    expect(fieldValues(ctl, parseDataRange(ctl, `A1:A${MAX_FILTER_VALUES + 1}`)!, 'Id')).toMatchObject({ complete: true });
  });

  it('says what stops it', () => {
    const ctl = make();
    expect(createPivotTable(ctl, null, null, 'Pivot table')).toBe('noSource');
    expect(createPivotTable(ctl, parseDataRange(ctl, 'H1:H3'), null, 'Pivot table')).toBe('noFields');
    expect(ctl.engine.workbook.sheets).toHaveLength(1);
  });
});
