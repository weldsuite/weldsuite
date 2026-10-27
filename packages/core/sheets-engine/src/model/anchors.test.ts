import { describe, expect, it } from 'vitest';
import { Engine } from '../calc/engine';
import { applyOp } from '../ops/apply';
import { dataTableOp, readValues, valuesOp } from '../ops/tables';
import { transform } from '../ops/transform';
import type { Op } from '../ops/types';
import { validateOp } from '../ops/validate';
import { isWellFormedOp } from '../ops/shape';
import { Sheet, Workbook } from './workbook';
import type { SheetComment } from './anchors';

const S = 's1';

function engine(): Engine {
  const wb = new Workbook();
  wb.sheets.push(new Sheet(S, 'Sheet1'));
  return new Engine(wb, { now: () => 0, random: () => 0.5, timezoneOffset: () => 0 });
}

const comment = (over: Partial<SheetComment> = {}): SheetComment => ({
  id: 'c1',
  authorId: 'u1',
  createdAt: 1,
  cell: { row: 4, col: 2 },
  ...over,
});

const commentsOf = (e: Engine) => e.workbook.requireSheet(S).comments;

describe('comments', () => {
  it('adds and resolves threads by id, and undoes exactly', () => {
    const e = engine();
    const undo1 = applyOp(e, { type: 'patchComments', sheetId: S, set: [comment()] });
    applyOp(e, { type: 'patchComments', sheetId: S, set: [comment({ id: 'c2', cell: { row: 0, col: 0 } })] });
    expect(commentsOf(e).map((c) => c.id)).toEqual(['c1', 'c2']);
    const undoResolve = applyOp(e, { type: 'patchComments', sheetId: S, set: [comment({ resolved: true })] });
    expect(commentsOf(e)[0]!.resolved).toBe(true);
    applyOp(e, undoResolve);
    expect(commentsOf(e)[0]!.resolved).toBeUndefined();
    applyOp(e, { type: 'patchComments', sheetId: S, remove: ['c2'] });
    applyOp(e, undo1);
    expect(commentsOf(e)).toEqual([]);
    // In the snapshot and back.
    applyOp(e, { type: 'patchComments', sheetId: S, set: [comment()] });
    expect(Engine.fromSnapshot(e.toSnapshot()).workbook.requireSheet(S).comments).toEqual([comment()]);
  });

  it('loads without comments from before they moved to WeldChat', () => {
    const e = engine();
    applyOp(e, { type: 'patchComments', sheetId: S, set: [comment()] });
    const snapshot = e.toSnapshot();
    const old = { id: 'o1', thread: 'o1', author: { id: 'u1', name: 'Ann' }, createdAt: 1, body: 'Old', cell: { row: 0, col: 0 } };
    snapshot.sheets[0]!.comments!.push(old as unknown as SheetComment);
    expect(Engine.fromSnapshot(snapshot).workbook.requireSheet(S).comments).toEqual([comment()]);
  });

  it('follows its cell, loses it when the cell is deleted, and gets it back on undo', () => {
    const e = engine();
    applyOp(e, { type: 'patchComments', sheetId: S, set: [comment()] });
    applyOp(e, { type: 'insertDims', sheetId: S, sheetName: 'Sheet1', axis: 'row', at: 0, count: 2 });
    expect(commentsOf(e)[0]!.cell).toEqual({ row: 6, col: 2 });
    const undo = applyOp(e, { type: 'deleteDims', sheetId: S, sheetName: 'Sheet1', axis: 'col', at: 1, count: 3 });
    expect(commentsOf(e)[0]!.cell).toBeUndefined();
    expect(commentsOf(e)[0]!.id).toBe('c1');
    applyOp(e, undo);
    expect(commentsOf(e)[0]!.cell).toEqual({ row: 6, col: 2 });
  });

  it('moves a concurrent comment past a row change, and keeps two threads started at once', () => {
    const a: Op = { type: 'patchComments', sheetId: S, set: [comment()] };
    const insert: Op = { type: 'insertDims', sheetId: S, sheetName: 'Sheet1', axis: 'row', at: 2, count: 3 };
    expect(transform(a, insert, false)).toMatchObject({ set: [{ cell: { row: 7, col: 2 } }] });
    const del: Op = { type: 'deleteDims', sheetId: S, sheetName: 'Sheet1', axis: 'row', at: 4, count: 1 };
    expect((transform(a, del, false) as Extract<Op, { type: 'patchComments' }>).set![0]!.cell).toBeUndefined();
    const r1: Op = { type: 'patchComments', sheetId: S, set: [comment({ id: 'r1' })] };
    const r2: Op = { type: 'patchComments', sheetId: S, set: [comment({ id: 'r2' })] };
    expect(transform(r1, r2, false)).toEqual(r1);
  });

  it('checks shape and bounds', () => {
    const e = engine();
    const ok: Op = { type: 'patchComments', sheetId: S, set: [comment({ resolved: true })] };
    expect(isWellFormedOp(ok)).toBe(true);
    expect(validateOp(e.workbook, ok)).toBeNull();
    expect(validateOp(e.workbook, { type: 'patchComments', sheetId: S, set: [comment({ cell: { row: -1, col: 0 } })] })).not.toBeNull();
    expect(isWellFormedOp({ type: 'patchComments', sheetId: S, set: [{ id: 'c1' }] })).toBe(false);
    // The old shape, with the text in the workbook, is refused.
    expect(isWellFormedOp({ type: 'patchComments', sheetId: S, set: [{ id: 'c1', thread: 'c1', author: { id: 'u1', name: 'A' }, createdAt: 1, body: 'x' }] })).toBe(false);
  });
});

describe('connected tables', () => {
  it('writes a header and records, clears what a smaller refresh no longer covers, and records its block', () => {
    const e = engine();
    const first = dataTableOp(e, {
      id: 'ds1',
      at: { sheetId: S, row: 1, col: 1 },
      header: ['Name', 'Amount', 'Date'],
      rows: [
        ['Acme', 10, 46000],
        ['Bolt', 20, 46001],
        ['Coda', null, 46002],
      ],
      formats: [undefined, undefined, 'yyyy-mm-dd'],
    });
    if (typeof first === 'string') throw new Error(first);
    expect(validateOp(e.workbook, first)).toBeNull();
    applyOp(e, first);
    const sheet = e.workbook.requireSheet(S);
    expect(sheet.dataTables).toEqual([{ id: 'ds1', range: { r1: 1, c1: 1, r2: 4, c2: 3 } }]);
    expect(e.getValue(S, 1, 1)).toBe('Name');
    expect(e.workbook.style(sheet, 1, 2)?.bold).toBe(true);
    expect(e.getValue(S, 3, 2)).toBe(20);
    expect(e.workbook.style(sheet, 4, 3)?.numFmt).toBe('yyyy-mm-dd');

    // Rows were inserted above it: the next refresh writes where it now is.
    applyOp(e, { type: 'insertDims', sheetId: S, sheetName: 'Sheet1', axis: 'row', at: 0, count: 1 });
    const second = dataTableOp(e, { id: 'ds1', header: ['Name'], rows: [['Zed']] });
    if (typeof second === 'string') throw new Error(second);
    applyOp(e, second);
    expect(sheet.dataTables).toEqual([{ id: 'ds1', range: { r1: 2, c1: 1, r2: 3, c2: 1 } }]);
    expect(e.getValue(S, 3, 1)).toBe('Zed');
    expect(e.getValue(S, 4, 1)).toBeNull();
    expect(e.getValue(S, 2, 2)).toBeNull();
    expect(dataTableOp(e, { id: 'nowhere', header: ['x'], rows: [] })).toBe('The table has no place in the workbook');
  });

  it('gets a tab of its own: named after its object, header frozen and filtered, undone as one', () => {
    const e = engine();
    e.workbook.sheets.push(new Sheet('s2', 'Companies'));
    const op = dataTableOp(e, { id: 'ds1', at: { newSheet: { id: 'tab', name: 'Companies' } }, header: ['Name', 'Email'], rows: [['Acme', 'a@x.org']] });
    if (typeof op === 'string') throw new Error(op);
    expect(validateOp(e.workbook, op)).toBeNull();
    expect(isWellFormedOp(op)).toBe(true);
    const undo = applyOp(e, op);
    const tab = e.workbook.requireSheet('tab');
    expect(tab.name).toBe('Companies 2');
    expect(e.workbook.sheets.at(-1)).toBe(tab);
    expect(tab.freeze).toEqual({ rows: 1, cols: 0 });
    expect(tab.filter).toEqual({ range: { r1: 0, c1: 0, r2: 1, c2: 1 }, columns: [] });
    expect(tab.dataTables).toEqual([{ id: 'ds1', range: { r1: 0, c1: 0, r2: 1, c2: 1 } }]);
    expect(e.getValue('tab', 1, 1)).toBe('a@x.org');
    applyOp(e, undo);
    expect(e.workbook.getSheet('tab')).toBeUndefined();
    // Once placed, a refresh writes where the table is: no second tab.
    applyOp(e, op);
    const again = dataTableOp(e, { id: 'ds1', at: { newSheet: { id: 'other', name: 'Companies' } }, header: ['Name'], rows: [['Acme'], ['Bolt']] });
    if (typeof again === 'string') throw new Error(again);
    applyOp(e, again);
    expect(e.workbook.getSheet('other')).toBeUndefined();
    expect(e.getValue('tab', 2, 0)).toBe('Bolt');
  });

  it('grows the sheet to hold more records than it has rows', () => {
    const e = engine();
    const sheet = e.workbook.requireSheet(S);
    const rows = Array.from({ length: sheet.rowCount + 5 }, (_, i) => [i]);
    const op = dataTableOp(e, { id: 'ds1', at: { sheetId: S, row: 0, col: 0 }, header: ['N'], rows });
    if (typeof op === 'string') throw new Error(op);
    applyOp(e, op);
    expect(sheet.rowCount).toBe(rows.length + 1);
    expect(e.getValue(S, rows.length, 0)).toBe(rows.length - 1);
  });

  it('moves a filter on its header with its block, keeping the filter columns that still fit', () => {
    const e = engine();
    const first = dataTableOp(e, { id: 'ds1', at: { sheetId: S, row: 0, col: 0 }, header: ['A', 'B'], rows: [[1, 2]] });
    if (typeof first === 'string') throw new Error(first);
    applyOp(e, first);
    const columns = [{ col: 0, hiddenValues: ['n:1'] }, { col: 1, hiddenValues: ['n:2'] }];
    applyOp(e, { type: 'setFilter', sheetId: S, filter: { range: { r1: 0, c1: 0, r2: 1, c2: 1 }, columns } });
    const second = dataTableOp(e, { id: 'ds1', header: ['A'], rows: [[1], [3], [4]] });
    if (typeof second === 'string') throw new Error(second);
    applyOp(e, second);
    expect(e.workbook.requireSheet(S).filter).toEqual({ range: { r1: 0, c1: 0, r2: 3, c2: 0 }, columns: [columns[0]] });
  });

  it('loses its block when all its rows are deleted', () => {
    const e = engine();
    applyOp(e, { type: 'patchDataTables', sheetId: S, set: [{ id: 'ds1', range: { r1: 2, c1: 0, r2: 3, c2: 1 } }] });
    const undo = applyOp(e, { type: 'deleteDims', sheetId: S, sheetName: 'Sheet1', axis: 'row', at: 1, count: 4 });
    expect(e.workbook.requireSheet(S).dataTables).toEqual([]);
    applyOp(e, undo);
    expect(e.workbook.requireSheet(S).dataTables).toEqual([{ id: 'ds1', range: { r1: 2, c1: 0, r2: 3, c2: 1 } }]);
  });
});

describe('values in and out', () => {
  it('writes literals and formulas, and reads values and formulas back', () => {
    const e = engine();
    applyOp(e, valuesOp(S, { row: 0, col: 0 }, [
      [1, 2, '=A1+B1'],
      ['x', true, null],
      ['=1/0', '', 'y'],
    ]));
    const read = readValues(e, S, { r1: 0, c1: 0, r2: 2, c2: 2 }, 100);
    expect(read.values).toEqual([
      [1, 2, 3],
      ['x', true, null],
      ['#DIV/0!', null, 'y'],
    ]);
    expect(read.formulas[0]![2]).toBe('=A1+B1');
    expect(read.truncated).toBe(false);
    expect(readValues(e, S, { r1: 0, c1: 0, r2: 2, c2: 2 }, 4)).toMatchObject({ range: { r2: 0 }, truncated: true });
  });
});
