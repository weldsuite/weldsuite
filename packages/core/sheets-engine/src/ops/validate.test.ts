import { describe, expect, it } from 'vitest';
import { MAX_ROWS } from '../address';
import { Sheet, Workbook } from '../model/workbook';
import { validateOp } from './validate';

function workbook(): Workbook {
  const wb = new Workbook();
  wb.sheets.push(new Sheet('s1', 'Sheet1'));
  return wb;
}

describe('validateOp', () => {
  it('accepts ordinary edits', () => {
    expect(validateOp(workbook(), { type: 'setCells', sheetId: 's1', cells: [[0, 0, { v: 1 }]] })).toBeNull();
    expect(validateOp(workbook(), { type: 'insertDims', sheetId: 's1', sheetName: 'Sheet1', axis: 'row', at: 3, count: 2 })).toBeNull();
  });

  it('rejects unknown sheets and out-of-range cells', () => {
    expect(validateOp(workbook(), { type: 'setCells', sheetId: 'nope', cells: [] })).toMatch(/unknown sheet/);
    expect(validateOp(workbook(), { type: 'setCells', sheetId: 's1', cells: [[MAX_ROWS, 0, null]] })).toBe('cell out of range');
    expect(validateOp(workbook(), { type: 'setCells', sheetId: 's1', cells: [[-1, 0, null]] })).toBe('cell out of range');
    expect(validateOp(workbook(), { type: 'merge', sheetId: 's1', ranges: [{ r1: 2, c1: 0, r2: 1, c2: 0 }] })).toBe('range out of bounds');
    expect(validateOp(workbook(), { type: 'deleteDims', sheetId: 's1', sheetName: 'Sheet1', axis: 'row', at: MAX_ROWS - 1, count: 2 })).toBe('out of range');
  });

  it('follows sheet adds and deletes through a batch', () => {
    const add = { type: 'addSheet', sheetId: 's2', name: 'Two', index: 1 } as const;
    expect(validateOp(workbook(), { type: 'batch', ops: [add, { type: 'setCells', sheetId: 's2', cells: [[0, 0, { v: 1 }]] }] })).toBeNull();
    expect(validateOp(workbook(), { type: 'batch', ops: [add, add] })).toMatch(/exists/);
    expect(
      validateOp(workbook(), {
        type: 'batch',
        ops: [add, { type: 'deleteSheet', sheetId: 's1', sheetName: 'Sheet1' }, { type: 'setCells', sheetId: 's1', cells: [] }],
      }),
    ).toMatch(/unknown sheet/);
  });

  it('never deletes the last sheet', () => {
    expect(validateOp(workbook(), { type: 'deleteSheet', sheetId: 's1', sheetName: 'Sheet1' })).toBe('cannot delete the last sheet');
  });

  it('rejects sheet names Excel would not allow', () => {
    expect(validateOp(workbook(), { type: 'renameSheet', sheetId: 's1', oldName: 'Sheet1', name: 'a/b' })).toBe('invalid sheet name');
    expect(validateOp(workbook(), { type: 'renameSheet', sheetId: 's1', oldName: 'Sheet1', name: '  ' })).toBe('invalid sheet name');
  });
});
