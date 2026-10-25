import { describe, expect, it } from 'vitest';
import { MAX_COLS } from '../address';
import { Engine } from '../calc/engine';
import { styleKey } from '../model/styles';
import { Sheet, Workbook } from '../model/workbook';
import { applyOp } from './apply';
import { isWellFormedOp } from './shape';
import { transform } from './transform';
import type { Op } from './types';

/** What the room sees: the op after a trip through JSON. */
const wire = (op: unknown): unknown => JSON.parse(JSON.stringify(op));

describe('isWellFormedOp', () => {
  it('accepts the ops the editor sends', () => {
    const ops: Op[] = [
      { type: 'setCells', sheetId: 's1', cells: [[0, 0, { v: 1 }], [1, 0, { f: 'A1*2' }], [2, 0, null], [3, 0, { v: { kind: 'error', code: '#N/A' } }]] },
      { type: 'formatRanges', sheetId: 's1', ranges: [{ r1: 0, c1: 0, r2: 2, c2: 2 }], patch: { bold: true, fill: null, borderTop: { style: 'thin', color: '#000000' } } },
      { type: 'setStyles', sheetId: 's1', cells: [[0, 0, styleKey({ bold: true })!], [1, 1, null]], rows: [[2, null]], cols: [[0, styleKey({ italic: true })!]] },
      { type: 'moveDims', sheetId: 's1', sheetName: 'Sheet1', axis: 'row', from: 1, count: 2, to: 6 },
      { type: 'setSheetProps', sheetId: 's1', props: { tabColor: '#ff0000', hidden: null } },
      { type: 'patchNames', set: [{ name: 'rate', formula: 'Sheet1!$A$1' }], remove: [{ name: 'old', sheetId: 's1' }] },
      { type: 'batch', ops: [{ type: 'setFreeze', sheetId: 's1', rows: 1, cols: 0 }, { type: 'merge', sheetId: 's1', ranges: [{ r1: 0, c1: 0, r2: 1, c2: 1 }] }] },
    ];
    for (const op of ops) expect(isWellFormedOp(wire(op)), JSON.stringify(op)).toBe(true);
  });

  it('refuses ops that would throw while being applied', () => {
    const bad: unknown[] = [
      // The review case: a good op, then a broken one in the same batch.
      { type: 'batch', ops: [{ type: 'setCells', sheetId: 's1', cells: [[0, 0, { v: 1 }]] }, { type: 'setNames', names: null }] },
      { type: 'setCells', sheetId: 's1', cells: null },
      { type: 'setCells', sheetId: 's1', cells: [[0, '1', { v: 1 }]] },
      { type: 'setCells', sheetId: 's1', cells: [[0, 1, { v: { kind: 'error', code: '#BOGUS' } }]] },
      { type: 'setCells', sheetId: 's1', cells: [[0, 1, { v: 1, s: '{"bold":true}' }]] },
      { type: 'formatRanges', sheetId: 's1', ranges: [{ r1: 0, c1: 0, r2: 1 }], patch: {} },
      { type: 'formatRanges', sheetId: 's1', ranges: [], patch: { bold: 'yes' } },
      { type: 'formatRanges', sheetId: 's1', ranges: [], patch: { margin: 3 } },
      { type: 'setStyles', sheetId: 's1', cells: [[0, 0, 'not json']] },
      { type: 'setStyles', sheetId: 's1', cells: [[0, 0, '{"italic":true,"bold":true}']] },
      { type: 'insertDims', sheetId: 's1', sheetName: 'Sheet1', axis: 'diagonal', at: 0, count: 1 },
      { type: 'resizeDims', sheetId: 's1', axis: 'row', entries: [[0, Number.NaN]] },
      { type: 'renameSheet', sheetId: 's1', name: 'x' },
      { type: 'setNames', names: [{ name: 'a' }] },
      { type: 'nonsense', sheetId: 's1' },
      { type: 'setCells', sheetId: 's1', cells: [], extra: true },
      { type: 'batch', ops: [{ type: 'batch', ops: [{ type: 'batch', ops: [{ type: 'batch', ops: [{ type: 'batch', ops: [] }] }] }] }] },
      null,
      'setCells',
    ];
    for (const op of bad) expect(isWellFormedOp(op), JSON.stringify(op)).toBe(false);
  });

  it('accepts every op an edit, its undo or a transform produces', () => {
    let seed = 3;
    const rand = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % n;
    };
    const workbook = new Workbook();
    workbook.sheets.push(new Sheet('s1', 'Sheet1'), new Sheet('s2', 'Data'));
    const engine = new Engine(workbook);
    const randomOp = (): Op => {
      const axis = rand(2) ? 'row' : 'col';
      const r = rand(8);
      const c = rand(5);
      switch (rand(14)) {
        case 0:
          return { type: 'insertDims', sheetId: 's1', sheetName: 'Sheet1', axis, at: rand(6), count: 1 + rand(2) };
        case 1:
          return { type: 'deleteDims', sheetId: 's1', sheetName: 'Sheet1', axis, at: rand(6), count: 1 };
        case 2:
          return { type: 'moveDims', sheetId: 's1', sheetName: 'Sheet1', axis, from: rand(3), count: 1, to: 5 };
        case 3:
          return { type: 'formatRanges', sheetId: 's1', ranges: [{ r1: r, c1: 0, r2: r, c2: MAX_COLS - 1 }], patch: { bold: rand(2) ? true : null, numFmt: '0.00' } };
        case 4:
          return { type: 'merge', sheetId: 's1', ranges: [{ r1: r, c1: c, r2: r + 1, c2: c + 1 }] };
        case 5:
          return { type: 'resizeDims', sheetId: 's1', axis, entries: [[rand(6), rand(2) ? 40 : null]] };
        case 6:
          return { type: 'hideDims', sheetId: 's1', axis, indices: [rand(6)], hidden: !!rand(2) };
        case 7:
          return { type: 'setSheetProps', sheetId: 's1', props: { tabColor: rand(2) ? '#00ff00' : null, gridlines: !!rand(2) } };
        case 8:
          return { type: 'setGridSize', sheetId: 's1', rowCount: 1200 + rand(10) };
        case 9:
          return { type: 'patchNames', set: [{ name: 'n', formula: `Sheet1!A${1 + rand(6)}` }] };
        case 10:
          return { type: 'setCells', sheetId: 's1', cells: [[r, c, rand(3) ? { v: rand(2) ? rand(100) : 'text' } : { f: `SUM(A1:A${1 + rand(6)})` }]] };
        case 11:
          return { type: 'setCells', sheetId: 's1', cells: [[r, c, { f: '1/0' }], [r + 1, c, null]] };
        case 12:
          return { type: 'renameSheet', sheetId: 's2', oldName: engine.workbook.getSheet('s2')!.name, name: rand(2) ? 'Data' : 'Cijfers' };
        default:
          return { type: 'setFreeze', sheetId: 's1', rows: rand(3), cols: rand(2) };
      }
    };
    for (let i = 0; i < 600; i++) {
      const op = randomOp();
      const other = randomOp();
      expect(isWellFormedOp(wire(op)), JSON.stringify(op)).toBe(true);
      expect(isWellFormedOp(wire(transform(op, other, true))), `${JSON.stringify(op)} past ${JSON.stringify(other)}`).toBe(true);
      const inverse = applyOp(engine, op);
      expect(isWellFormedOp(wire(inverse)), `undo of ${JSON.stringify(op)}: ${JSON.stringify(inverse)}`).toBe(true);
    }
    // Duplicating a sheet sends its whole snapshot.
    const snapshot = engine.workbook.toJSON().sheets.find((s) => s.id === 's1')!;
    expect(isWellFormedOp(wire({ type: 'addSheet', sheetId: 's3', name: 'Copy', index: 2, snapshot }))).toBe(true);
  });
});
