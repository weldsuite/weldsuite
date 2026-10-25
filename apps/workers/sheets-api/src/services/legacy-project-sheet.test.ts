import { describe, expect, it } from 'vitest';
import { Engine, Sheet, Workbook, writeXlsx } from '@weldsuite/sheets-engine';
import { META_SHEET, convertLegacyModel, isPlainNumber, readLegacyModel, type LegacyModel } from './legacy-project-sheet';

const DAY = 86_400_000;

const MODEL: LegacyModel = {
  sheets: [
    { id: 'b', name: 'Costs', position: 1 },
    { id: 'a', name: 'Plan', position: 0 },
  ],
  columnsBySheet: {
    a: [
      { id: 'c2', name: 'Hours', position: 1, width: 80 },
      { id: 'c1', name: 'Task', position: 0, width: 160 },
      { id: 'c3', name: 'Status', position: 2, fieldType: 'select', options: ['Open', 'Done'] },
      { id: 'c4', name: 'Due', position: 3 },
    ],
    b: [],
  },
  rowsBySheet: {
    a: [
      {
        id: 'r2',
        position: 1,
        data: { c1: 'Test', c2: '8', c3: 'Open', c4: Date.UTC(2026, 0, 2), __fmt__c4: { numberFormat: 'date' } },
      },
      {
        id: 'r1',
        position: 0,
        data: {
          c1: 'Design',
          c2: 12.5,
          c3: 'Done',
          __fmt__c1: { bold: true, fillColor: '#ff0000', fontSize: 16, border: 'all', textWrap: 'wrap' },
          __fmt__c2: { numberFormat: 'currency', currencySymbol: '€', decimalPlaces: 2 },
          __note__c1: 'Ask Bo',
          __link__c3: 'https://weldsuite.org',
        },
      },
      { id: 'r3', position: 2, data: { c1: 'Total', c2: '=SUM(B1:B2)', __rt__c1: [{ text: 'To', bold: true }, { text: 'tal' }] } },
    ],
  },
};

let tabs = 0;
const convert = (model: LegacyModel) =>
  convertLegacyModel(model, { newTabId: () => `sh_${++tabs}`, owner: { id: 'u_ann', name: 'Ann' }, now: 1_000, firstTabName: 'Sheet1' });

describe('old WeldFlow project sheets', () => {
  it('becomes tabs in order, with the column names as a bold, frozen first row', () => {
    const snapshot = convert(MODEL);
    const engine = Engine.fromSnapshot(snapshot);
    engine.recalcAll();
    const [plan, costs] = engine.workbook.sheets;
    expect([plan!.name, costs!.name]).toEqual(['Plan', 'Costs']);
    const v = (r: number, c: number) => engine.getValue(plan!.id, r, c);
    expect([v(0, 0), v(0, 1), v(0, 2), v(0, 3)]).toEqual(['Task', 'Hours', 'Status', 'Due']);
    expect(engine.workbook.style(plan!, 0, 1)?.bold).toBe(true);
    expect(plan!.freeze).toEqual({ rows: 1, cols: 0 });
    expect([v(1, 0), v(2, 0), v(3, 0)]).toEqual(['Design', 'Test', 'Total']);
    // Typed numbers saved as text are numbers again; the formula moved down with its rows.
    expect(v(2, 1)).toBe(8);
    expect(engine.getCell(plan!.id, 3, 1)?.f).toBe('SUM(B2:B3)');
    expect(v(3, 1)).toBe(20.5);
    expect(plan!.cols.sizeOf(0)).toBe(160);
  });

  it('keeps formats, dates, links, dropdowns and notes', () => {
    const engine = Engine.fromSnapshot(convert(MODEL));
    engine.recalcAll();
    const plan = engine.workbook.sheets[0]!;
    expect(engine.workbook.style(plan, 1, 0)).toMatchObject({ bold: true, fill: '#ff0000', fontSize: 12, wrap: 'wrap', borderTop: { style: 'thin' } });
    expect(engine.workbook.style(plan, 1, 1)?.numFmt).toBe('"€"#,##0.00');
    // A date cell held epoch milliseconds.
    expect(engine.getValue(plan.id, 2, 3)).toBe(Date.UTC(2026, 0, 2) / DAY + 25_569);
    expect(engine.workbook.style(plan, 2, 3)?.numFmt).toBe('yyyy-mm-dd');
    expect(engine.getCell(plan.id, 1, 2)?.f).toBe('HYPERLINK("https://weldsuite.org","Done")');
    expect(plan.validations[0]).toMatchObject({ criteria: { type: 'list', values: ['Open', 'Done'] }, ranges: [{ r1: 1, c1: 2 }], dropdown: true });
    expect(plan.comments).toEqual([expect.objectContaining({ body: 'Ask Bo', author: { id: 'u_ann', name: 'Ann' }, cell: { row: 1, col: 0 } })]);
  });

  it('gives a sheet that was never saved one empty tab', () => {
    const engine = Engine.fromSnapshot(convert({ sheets: [], columnsBySheet: {}, rowsBySheet: {} }));
    expect(engine.workbook.sheets.map((s) => s.name)).toEqual(['Sheet1']);
  });

  it('reads the model from the hidden sheet of the old .xlsx', async () => {
    const wb = new Workbook();
    wb.sheets.push(new Sheet('s1', 'Plan'), new Sheet('s2', META_SHEET));
    const engine = new Engine(wb);
    engine.setContent('s2', 0, 0, { v: JSON.stringify({ v: 1, model: MODEL }) });
    engine.recalc();
    const bytes = await writeXlsx(engine);
    expect(await readLegacyModel('Plan.xlsx', bytes)).toEqual(MODEL);
    const plain = new Workbook();
    plain.sheets.push(new Sheet('s1', 'Plan'));
    expect(await readLegacyModel('Plan.xlsx', await writeXlsx(new Engine(plain)))).toBeNull();
  });

  it('tells plain numbers from other text', () => {
    for (const yes of ['8', '-12.5', '+.5', '1e3', '2.50']) expect(isPlainNumber(yes)).toBe(true);
    for (const no of ['', '0x10', 'Infinity', '1.2.3', '12a', '1e', '.', '1,000']) expect(isPlainNumber(no)).toBe(false);
  });
});
