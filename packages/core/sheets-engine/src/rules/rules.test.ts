import { describe, expect, it } from 'vitest';
import { Engine } from '../calc/engine';
import { NL_LOCALE, type FormatLocale } from '../format/number-format';
import { Sheet, Workbook } from '../model/workbook';
import type { ConditionalFormat, DataValidation, SheetFilter } from '../model/rules';
import { applyOp } from '../ops/apply';
import { sortRangeOp } from '../ops/sort';
import { transform } from '../ops/transform';
import { isWellFormedOp } from '../ops/shape';
import { validateOp } from '../ops/validate';
import type { CellPatch, Op } from '../ops/types';
import { conditionalStyleAt, listOptions, passesValidation, validationAt, type FormatCache } from './evaluate';

const S = 's1';

function engineWith(cells: Record<string, CellPatch[2]> = {}): Engine {
  const wb = new Workbook();
  wb.sheets.push(new Sheet(S, 'Sheet1'), new Sheet('s2', 'Lists'));
  const engine = new Engine(wb, { now: () => 0, random: () => 0.5, timezoneOffset: () => 0 });
  const patch: CellPatch[] = Object.entries(cells).map(([a1, content]) => {
    const col = a1.charCodeAt(0) - 65;
    return [Number(a1.slice(1)) - 1, col, content];
  });
  if (patch.length) applyOp(engine, { type: 'setCells', sheetId: S, cells: patch });
  return engine;
}

/** A1:B6 with a header row: Fruit / Qty. */
function fruit(): Engine {
  return engineWith({
    A1: { v: 'Fruit' },
    B1: { v: 'Qty' },
    A2: { v: 'Apple' },
    B2: { v: 5 },
    A3: { v: 'Pear' },
    B3: { v: 12 },
    A4: { v: 'Plum' },
    B4: { v: 3 },
    A5: { v: 'Kiwi' },
    B5: { v: 20 },
    A6: { v: 'Fig' },
    B6: { v: 8 },
  });
}

const filtered = (e: Engine, sheetId = S) => {
  const sheet = e.workbook.getSheet(sheetId)!;
  return Array.from({ length: 10 }, (_, r) => r).filter((r) => sheet.rows.isFiltered(r));
};
const snapshot = (e: Engine) => JSON.stringify(e.toSnapshot());

describe('basic filter', () => {
  const filter: SheetFilter = {
    range: { r1: 0, c1: 0, r2: 5, c2: 1 },
    columns: [
      { col: 0, hiddenValues: ['s:Plum'] },
      { col: 1, condition: { type: 'greater', value: 4 } },
    ],
  };

  it('hides the rows that fail, and follows the values', () => {
    const e = fruit();
    const undo = applyOp(e, { type: 'setFilter', sheetId: S, filter });
    expect(filtered(e)).toEqual([3]);
    // Plum is hidden by value; Apple drops below the threshold.
    applyOp(e, { type: 'setCells', sheetId: S, cells: [[1, 1, { v: 2 }]] });
    expect(filtered(e)).toEqual([1, 3]);
    applyOp(e, undo);
    expect(filtered(e)).toEqual([]);
    expect(e.workbook.getSheet(S)!.filter).toBeNull();
  });

  it('feeds SUBTOTAL, which skips the hidden rows', () => {
    const e = fruit();
    applyOp(e, { type: 'setCells', sheetId: S, cells: [[7, 1, { f: 'SUBTOTAL(9,B2:B6)' }], [8, 1, { f: 'SUM(B2:B6)' }]] });
    expect(e.getValue(S, 7, 1)).toBe(48);
    applyOp(e, { type: 'setFilter', sheetId: S, filter });
    expect(e.getValue(S, 7, 1)).toBe(45);
    expect(e.getValue(S, 8, 1)).toBe(48);
    applyOp(e, { type: 'setCells', sheetId: S, cells: [[4, 1, { v: 1 }]] });
    expect(e.getValue(S, 7, 1)).toBe(25);
    // Hiding a row by hand counts for 109, not for 9.
    applyOp(e, { type: 'setCells', sheetId: S, cells: [[9, 1, { f: 'SUBTOTAL(109,B2:B6)' }]] });
    applyOp(e, { type: 'hideDims', sheetId: S, axis: 'row', indices: [1], hidden: true });
    expect(e.getValue(S, 9, 1)).toBe(20);
    expect(e.getValue(S, 7, 1)).toBe(25);
  });

  it('applies formula conditions written for the first data row', () => {
    const e = fruit();
    applyOp(e, { type: 'setFilter', sheetId: S, filter: { range: { r1: 0, c1: 0, r2: 5, c2: 1 }, columns: [{ col: 0, condition: { type: 'formula', formula: 'B2>=10' } }] } });
    expect(filtered(e)).toEqual([1, 3, 5]);
  });

  it('moves with rows and columns, and undo puts it back', () => {
    const e = fruit();
    applyOp(e, { type: 'setFilter', sheetId: S, filter });
    const before = snapshot(e);
    const undoInsert = applyOp(e, { type: 'insertDims', sheetId: S, sheetName: 'Sheet1', axis: 'col', at: 0, count: 1 });
    expect(e.workbook.getSheet(S)!.filter).toMatchObject({ range: { c1: 1, c2: 2 }, columns: [{ col: 1 }, { col: 2 }] });
    expect(filtered(e)).toEqual([3]);
    applyOp(e, undoInsert);
    expect(snapshot(e)).toBe(before);

    const undoDelete = applyOp(e, { type: 'deleteDims', sheetId: S, sheetName: 'Sheet1', axis: 'col', at: 1, count: 1 });
    expect(e.workbook.getSheet(S)!.filter).toMatchObject({ range: { c1: 0, c2: 0 }, columns: [{ col: 0 }] });
    expect(filtered(e)).toEqual([3]);
    applyOp(e, undoDelete);
    expect(snapshot(e)).toBe(before);
    expect(filtered(e)).toEqual([3]);
  });

  it('survives a snapshot and is re-applied on load', () => {
    const e = fruit();
    applyOp(e, { type: 'setFilter', sheetId: S, filter });
    const loaded = Engine.fromSnapshot(e.toSnapshot());
    expect(filtered(loaded)).toEqual([3]);
    expect(loaded.toSnapshot()).toEqual(e.toSnapshot());
  });
});

describe('conditional formats', () => {
  const bigQty: ConditionalFormat = {
    id: 'cf1',
    order: 1,
    ranges: [{ r1: 1, c1: 1, r2: 5, c2: 1 }],
    rule: { type: 'condition', condition: { type: 'greater', value: 10 }, style: { bold: true, fill: '#ffcccc' } },
  };
  const wholeRow: ConditionalFormat = {
    id: 'cf2',
    order: 2,
    ranges: [{ r1: 1, c1: 0, r2: 5, c2: 1 }],
    rule: { type: 'condition', condition: { type: 'formula', formula: '$B2<5' }, style: { italic: true } },
  };
  const scale: ConditionalFormat = {
    id: 'cf3',
    order: 3,
    ranges: [{ r1: 1, c1: 1, r2: 5, c2: 1 }],
    rule: { type: 'colorScale', points: [{ kind: 'min', color: '#ffffff' }, { kind: 'max', color: '#00ff00' }] },
  };

  it('styles cells with the first matching rule', () => {
    const e = fruit();
    applyOp(e, { type: 'patchConditionalFormats', sheetId: S, set: [scale, wholeRow, bigQty] });
    const sheet = e.workbook.getSheet(S)!;
    expect(sheet.conditionalFormats.map((cf) => cf.id)).toEqual(['cf1', 'cf2', 'cf3']);
    const cache: FormatCache = new Map();
    const at = (row: number, col: number) => conditionalStyleAt(e, sheet, row, col, cache);
    expect(at(2, 1)).toEqual({ bold: true, fill: '#ffcccc' }); // Pear 12
    expect(at(3, 0)).toEqual({ italic: true }); // Plum's name, through $B4<5
    expect(at(3, 1)).toEqual({ italic: true });
    expect(at(1, 1)).toEqual({ fill: '#e1ffe1' }); // Apple 5 on the 3..20 scale: 12% of the way to green
    expect(at(1, 0)).toBeUndefined();
    expect(at(0, 1)).toBeUndefined();
  });

  it('patches by id, and undo restores', () => {
    const e = fruit();
    applyOp(e, { type: 'patchConditionalFormats', sheetId: S, set: [bigQty, wholeRow] });
    const before = snapshot(e);
    const undo = applyOp(e, { type: 'patchConditionalFormats', sheetId: S, set: [{ ...bigQty, order: 5 }], remove: ['cf2'] });
    expect(e.workbook.getSheet(S)!.conditionalFormats.map((cf) => [cf.id, cf.order])).toEqual([['cf1', 5]]);
    applyOp(e, undo);
    expect(snapshot(e)).toBe(before);
  });

  it('follow deleted rows and come back on undo', () => {
    const e = fruit();
    applyOp(e, { type: 'patchConditionalFormats', sheetId: S, set: [wholeRow] });
    const before = snapshot(e);
    const undo = applyOp(e, { type: 'deleteDims', sheetId: S, sheetName: 'Sheet1', axis: 'row', at: 0, count: 2 });
    expect(e.workbook.getSheet(S)!.conditionalFormats[0]).toMatchObject({
      ranges: [{ r1: 0, r2: 3 }],
      rule: { condition: { formula: '#REF!<5' } },
    });
    applyOp(e, undo);
    expect(snapshot(e)).toBe(before);
  });
});

describe('data validation', () => {
  const list: DataValidation = { id: 'dv1', ranges: [{ r1: 1, c1: 2, r2: 5, c2: 2 }], criteria: { type: 'list', values: ['Yes', 'No'] }, strict: true, dropdown: true };
  const fromRange: DataValidation = { id: 'dv2', ranges: [{ r1: 1, c1: 3, r2: 5, c2: 3 }], criteria: { type: 'listRange', source: 'Lists!$A$1:$A$3' }, strict: false };
  const qty: DataValidation = { id: 'dv3', ranges: [{ r1: 1, c1: 1, r2: 5, c2: 1 }], criteria: { type: 'condition', condition: { type: 'between', min: 0, max: 100 } }, strict: true };
  const check: DataValidation = { id: 'dv4', ranges: [{ r1: 3, c1: 2, r2: 3, c2: 2 }], criteria: { type: 'checkbox' }, strict: true };

  it('checks values against lists, ranges, conditions and checkboxes', () => {
    const e = fruit();
    applyOp(e, { type: 'setCells', sheetId: 's2', cells: [[0, 0, { v: 'Red' }], [1, 0, { v: 'Green' }], [2, 0, { v: 'Red' }]] });
    applyOp(e, { type: 'patchValidations', sheetId: S, set: [list, fromRange, qty, check] });
    const sheet = e.workbook.getSheet(S)!;
    const ok = (row: number, col: number, v: string | number | boolean | null) => passesValidation(e, { sheetId: S, row, col }, validationAt(sheet, row, col)!, v);
    expect(ok(1, 2, 'yes')).toBe(true);
    expect(ok(1, 2, 'Maybe')).toBe(false);
    expect(ok(1, 2, null)).toBe(true);
    expect(listOptions(e, S, fromRange)).toEqual(['Red', 'Green']);
    expect(ok(2, 3, 'Green')).toBe(true);
    expect(ok(2, 3, 'Blue')).toBe(false);
    expect(ok(2, 1, 50)).toBe(true);
    expect(ok(2, 1, 500)).toBe(false);
    expect(ok(2, 1, 'many')).toBe(false);
    // The checkbox rule comes later, so it wins on C4.
    expect(validationAt(sheet, 3, 2)?.id).toBe('dv4');
    expect(ok(3, 2, true)).toBe(true);
    expect(ok(3, 2, 'Yes')).toBe(false);
  });

  it('matches list items that read as numbers when typed', () => {
    const e = fruit();
    const rates: DataValidation = { id: 'r', ranges: [{ r1: 0, c1: 5, r2: 9, c2: 5 }], criteria: { type: 'list', values: ['10%', '1,000', '007'] }, strict: true };
    const ok = (v: string | number, locale?: FormatLocale) => passesValidation(e, { sheetId: S, row: 1, col: 5 }, rates, v, locale);
    expect(ok(0.1)).toBe(true);
    expect(ok(1000)).toBe(true);
    expect(ok(7)).toBe(true);
    expect(ok('10%')).toBe(true);
    expect(ok(0.2)).toBe(false);
    // In nl "1,000" is one, with a decimal comma.
    expect(ok(1, NL_LOCALE)).toBe(true);
    expect(ok(1000, NL_LOCALE)).toBe(false);
  });
});

describe('rule ops in co-editing', () => {
  const cf = (id: string, r1: number, style: { bold?: boolean; italic?: boolean } = { bold: true }): ConditionalFormat => ({
    id,
    order: 1,
    ranges: [{ r1, c1: 0, r2: r1 + 2, c2: 1 }],
    rule: { type: 'condition', condition: { type: 'formula', formula: `A${r1 + 1}>1` }, style },
  });

  /** Both orders of two concurrent ops end the same, with `b` as the later op. */
  function converge(a: Op, b: Op): [string, string] {
    const one = fruit();
    applyOp(one, a);
    applyOp(one, transform(b, a, true));
    const two = fruit();
    applyOp(two, b);
    applyOp(two, transform(a, b, false));
    return [snapshot(one), snapshot(two)];
  }

  it('lets the later patch win a rule both change', () => {
    const [x, y] = converge(
      { type: 'patchConditionalFormats', sheetId: S, set: [cf('r', 1, { italic: true })] },
      { type: 'patchConditionalFormats', sheetId: S, set: [cf('r', 1, { bold: true })] },
    );
    expect(x).toBe(y);
    expect(JSON.parse(x).sheets[0].conditionalFormats[0].rule.style).toEqual({ bold: true });
  });

  it('moves a concurrent rule past a row insert, formula and all', () => {
    const insert: Op = { type: 'insertDims', sheetId: S, sheetName: 'Sheet1', axis: 'row', at: 0, count: 2 };
    for (const [a, b] of [
      [insert, { type: 'patchConditionalFormats', sheetId: S, set: [cf('r', 2)] }],
      [{ type: 'patchValidations', sheetId: S, set: [{ id: 'v', ranges: [{ r1: 3, c1: 1, r2: 4, c2: 1 }], criteria: { type: 'checkbox' }, strict: true }] }, insert],
      [{ type: 'setFilter', sheetId: S, filter: { range: { r1: 0, c1: 0, r2: 5, c2: 1 }, columns: [{ col: 1, condition: { type: 'less', value: 10 } }] } }, { type: 'deleteDims', sheetId: S, sheetName: 'Sheet1', axis: 'col', at: 0, count: 1 }],
    ] as [Op, Op][]) {
      const [x, y] = converge(a, b);
      expect(x, `${JSON.stringify(a)} / ${JSON.stringify(b)}`).toBe(y);
    }
    const [moved] = converge(insert, { type: 'patchConditionalFormats', sheetId: S, set: [cf('r', 2)] });
    expect(JSON.parse(moved).sheets[0].conditionalFormats[0]).toMatchObject({ ranges: [{ r1: 4, r2: 6 }], rule: { condition: { formula: 'A5>1' } } });
  });

  it('accepts well-formed rule ops and checks their ranges', () => {
    const wb = fruit().workbook;
    const ops: Op[] = [
      { type: 'setFilter', sheetId: S, filter: { range: { r1: 0, c1: 0, r2: 5, c2: 1 }, columns: [{ col: 0, hiddenValues: ['s:Plum', 'n:3', ''] }] } },
      { type: 'setFilter', sheetId: S, filter: null },
      { type: 'patchConditionalFormats', sheetId: S, set: [cf('a', 0)], remove: ['b'] },
      { type: 'patchValidations', sheetId: S, set: [{ id: 'v', ranges: [{ r1: 0, c1: 0, r2: 0, c2: 0 }], criteria: { type: 'list', values: ['x'] }, strict: false, dropdown: true, help: 'Pick one' }] },
    ];
    for (const op of ops) {
      expect(isWellFormedOp(JSON.parse(JSON.stringify(op))), JSON.stringify(op)).toBe(true);
      expect(validateOp(wb, op)).toBeNull();
    }
    expect(isWellFormedOp({ type: 'setFilter', sheetId: S, filter: { range: { r1: 0, c1: 0, r2: 1, c2: 1 }, columns: [{ col: 0, condition: { type: 'greater', value: 'x' } }] } })).toBe(false);
    expect(validateOp(wb, { type: 'patchValidations', sheetId: S, set: [{ id: 'v', ranges: [], criteria: { type: 'checkbox' }, strict: true }] })).not.toBeNull();
  });
});

describe('sorting a range', () => {
  it('reorders rows below the header, blanks last, formulas and formats moving along', () => {
    const e = fruit();
    applyOp(e, { type: 'setCells', sheetId: S, cells: [[1, 2, { f: 'B2*2' }], [6, 0, { v: 'Date' }]] });
    applyOp(e, { type: 'formatRanges', sheetId: S, ranges: [{ r1: 4, c1: 0, r2: 4, c2: 0 }], patch: { bold: true } });
    const before = snapshot(e);
    const result = sortRangeOp(e, S, { r1: 0, c1: 0, r2: 6, c2: 2 }, [{ col: 1, descending: true }], { header: true });
    if ('error' in result) throw new Error(result.error);
    const undo = applyOp(e, result.op);
    const col = (c: number) => [0, 1, 2, 3, 4, 5, 6].map((r) => e.getValue(S, r, c));
    expect(col(0)).toEqual(['Fruit', 'Kiwi', 'Pear', 'Fig', 'Apple', 'Plum', 'Date']);
    expect(col(1)).toEqual(['Qty', 20, 12, 8, 5, 3, null]);
    expect(e.getCell(S, 4, 2)?.f).toBe('B5*2');
    expect(e.getValue(S, 4, 2)).toBe(10);
    expect(e.workbook.style(e.workbook.getSheet(S)!, 1, 0)?.bold).toBe(true);
    applyOp(e, undo);
    expect(snapshot(e)).toBe(before);
  });

  it('sorts text without case, numbers before text', () => {
    const e = engineWith({ A1: { v: 'banana' }, A2: { v: 10 }, A3: { v: 'Apple' }, A4: { v: 2 }, A5: { v: true } });
    const result = sortRangeOp(e, S, { r1: 0, c1: 0, r2: 4, c2: 0 }, [{ col: 0 }]);
    if ('error' in result) throw new Error(result.error);
    applyOp(e, result.op);
    expect([0, 1, 2, 3, 4].map((r) => e.getValue(S, r, 0))).toEqual([2, 10, 'Apple', 'banana', true]);
  });

  it('leaves ranges with merged cells alone', () => {
    const e = fruit();
    applyOp(e, { type: 'merge', sheetId: S, ranges: [{ r1: 2, c1: 0, r2: 3, c2: 0 }] });
    expect(sortRangeOp(e, S, { r1: 0, c1: 0, r2: 5, c2: 1 }, [{ col: 1 }], { header: true })).toEqual({ error: 'merged' });
  });
});
