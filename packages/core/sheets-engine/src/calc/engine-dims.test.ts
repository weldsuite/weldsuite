import { describe, expect, it } from 'vitest';
import { applyOp } from '../ops/apply';
import type { Op } from '../ops/types';
import { Sheet, Workbook, type WorkbookSnapshot } from '../model/workbook';
import { isError, type Scalar } from '../values';
import { Engine, type EngineOptions } from './engine';

const OPTIONS: EngineOptions = { now: () => Date.UTC(2026, 0, 15), random: () => 0.25, timezoneOffset: () => 0 };
const SHEETS = [
  { id: 's1', name: 'Sheet1' },
  { id: 's2', name: 'Data' },
];
const ROWS = 14;
const COLS = 7;

/** Values as compared: an error by its code (messages may differ). */
const shown = (v: Scalar) => (isError(v) ? `#${v.code}` : v);

function values(engine: Engine): Scalar[] {
  const out: Scalar[] = [];
  for (const { id } of SHEETS) {
    for (let r = 0; r < ROWS + 4; r++) for (let c = 0; c < COLS + 3; c++) out.push(shown(engine.getValue(id, r, c)));
  }
  return out;
}

/** The same workbook, every formula evaluated from scratch. */
function recalculated(engine: Engine): Engine {
  const snapshot = JSON.parse(JSON.stringify(engine.toSnapshot())) as WorkbookSnapshot;
  delete snapshot.calculated;
  for (const sheet of snapshot.sheets) delete sheet.spills;
  return Engine.fromSnapshot(snapshot, OPTIONS);
}

function random(seed: number) {
  let s = seed;
  return (n: number) => {
    s = (s * 1103515245 + 12345) % 2147483648;
    return s % n;
  };
}

const col = (i: number) => String.fromCharCode(65 + i);

function formula(rand: (n: number) => number): string {
  const r = () => 1 + rand(ROWS);
  const c = () => col(rand(COLS - 1));
  const range = () => {
    const r1 = r();
    const c1 = rand(COLS - 1);
    return `${col(c1)}${r1}:${col(c1 + rand(2))}${r1 + rand(5)}`;
  };
  switch (rand(16)) {
    case 0:
      return `${c()}${r()}+${c()}${r()}`;
    case 1:
      return `SUM(${range()})`;
    case 2:
      return `SUM(${c()}:${c()})`;
    case 3:
      return `COUNTA(${r()}:${r()})`;
    case 4:
      return rand(2) ? 'ROW()' : `COLUMN(${c()}${r()})`;
    case 5:
      return `ROWS(${range()})*10+COLUMNS(${range()})`;
    case 6:
      return `Data!${c()}${r()}*2`;
    case 7:
      return rand(2) ? 'SEQUENCE(2,2)' : `${col(rand(3))}${r()}:${col(rand(3))}${r()}*2`;
    case 8:
      return `SUBTOTAL(109,${range()})`;
    case 9:
      return `INDEX(${range()},2)`;
    case 10:
      return `MATCH(3,${range()},0)`;
    case 11:
      return `COUNTBLANK(${range()})`;
    case 12:
      return 'SUM(Total)';
    case 13:
      return `Sheet1!${c()}${r()}&"x"`;
    case 14:
      return `IFERROR(${c()}${r()}/${c()}${r()},-1)`;
    default:
      return `${c()}${r()}*3`;
  }
}

function randomOp(rand: (n: number) => number): Op {
  const sheet = SHEETS[rand(2)]!;
  const axis = rand(2) ? 'row' : 'col';
  const size = axis === 'row' ? ROWS : COLS;
  switch (rand(7)) {
    case 0:
      return { type: 'insertDims', sheetId: sheet.id, sheetName: sheet.name, axis, at: rand(size), count: 1 + rand(2) };
    case 1:
      return { type: 'deleteDims', sheetId: sheet.id, sheetName: sheet.name, axis, at: rand(size), count: 1 + rand(2) };
    case 2: {
      const from = rand(size - 2);
      const count = 1 + rand(2);
      const to = rand(2) ? from + count + 1 + rand(3) : rand(Math.max(1, from));
      return { type: 'moveDims', sheetId: sheet.id, sheetName: sheet.name, axis, from, count, to };
    }
    case 3:
      return { type: 'hideDims', sheetId: sheet.id, axis: 'row', indices: [rand(ROWS)], hidden: rand(2) === 0 };
    case 4:
      return { type: 'setCells', sheetId: sheet.id, cells: [[rand(ROWS), rand(COLS), { f: formula(rand) }]] };
    case 5:
      return { type: 'setCells', sheetId: sheet.id, cells: [[rand(ROWS), rand(COLS), null]] };
    default:
      return { type: 'setCells', sheetId: sheet.id, cells: [[rand(ROWS), rand(COLS), { v: rand(10) }]] };
  }
}

function workbook(rand: (n: number) => number): Engine {
  const wb = new Workbook();
  for (const s of SHEETS) wb.sheets.push(new Sheet(s.id, s.name));
  wb.names.push({ name: 'Total', formula: 'Sheet1!$A$1:$A$5' });
  const engine = new Engine(wb, OPTIONS);
  for (const { id } of SHEETS) {
    const cells: [number, number, { v: number } | { f: string }][] = [];
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        const pick = rand(10);
        if (pick < 4) cells.push([r, c, { v: rand(10) }]);
        else if (pick < 7) cells.push([r, c, { f: formula(rand) }]);
      }
    }
    applyOp(engine, { type: 'setCells', sheetId: id, cells });
  }
  return engine;
}

describe('row and column changes, recalculated incrementally', () => {
  it('give the same values as evaluating every formula again', () => {
    for (let seed = 1; seed <= 150; seed++) {
      const rand = random(seed);
      const engine = workbook(rand);
      for (let step = 0; step < 8; step++) {
        const op = randomOp(rand);
        applyOp(engine, op);
        expect(values(engine), `seed ${seed}, step ${step}: ${JSON.stringify(op)}`).toEqual(values(recalculated(engine)));
      }
    }
  });

  it('re-reads cells a spill covered: the spill stays with its formula, not with the cells', () => {
    const at = (engine: Engine, row: number, col: number) => engine.getValue('s1', row, col);
    const make = () => {
      const wb = new Workbook();
      wb.sheets.push(new Sheet('s1', 'Sheet1'));
      const engine = new Engine(wb, OPTIONS);
      applyOp(engine, { type: 'setCells', sheetId: 's1', cells: [[0, 1, { f: 'SEQUENCE(3)' }], [1, 2, { f: 'B2*10' }], [2, 3, { f: 'B3' }]] });
      return engine;
    };
    // Deleting the formula's row takes the spill away: what read it now reads a blank cell.
    const deleted = make();
    applyOp(deleted, { type: 'deleteDims', sheetId: 's1', sheetName: 'Sheet1', axis: 'row', at: 0, count: 1 });
    expect(at(deleted, 0, 2)).toBe(0);
    expect(values(deleted)).toEqual(values(recalculated(deleted)));
    // A row inserted inside the spill pushes a reader below it, out of the spill.
    const inserted = make();
    applyOp(inserted, { type: 'insertDims', sheetId: 's1', sheetName: 'Sheet1', axis: 'row', at: 1, count: 1 });
    expect(at(inserted, 3, 3)).toBe(0);
    // =B2*10 moved down with its row and now reads B3, still inside the spill.
    expect(at(inserted, 2, 2)).toBe(30);
    expect(values(inserted)).toEqual(values(recalculated(inserted)));
  });

  it('evaluates only formulas whose result can change', () => {
    const wb = new Workbook();
    wb.sheets.push(new Sheet('s1', 'Sheet1'));
    const engine = new Engine(wb, OPTIONS);
    const cells: [number, number, { v: number } | { f: string }][] = [];
    for (let r = 0; r < 200; r++) {
      cells.push([r, 0, { v: r }], [r, 1, { f: `A${r + 1}*2` }]);
    }
    cells.push([0, 3, { f: 'SUM(B:B)' }], [1, 3, { f: 'ROW()' }]);
    applyOp(engine, { type: 'setCells', sheetId: 's1', cells });
    let evaluated = 0;
    const recalc = engine.recalc.bind(engine);
    engine.recalc = () => {
      const n = recalc();
      evaluated += n;
      return n;
    };
    applyOp(engine, { type: 'insertDims', sheetId: 's1', sheetName: 'Sheet1', axis: 'row', at: 10, count: 1 });
    // SUM(B:B) (a whole column, cut by the new row) and ROW(), not the 200 =A*2 formulas.
    expect(evaluated).toBe(2);
    expect(engine.getValue('s1', 0, 3)).toBe(199 * 200);
    expect(engine.getValue('s1', 1, 3)).toBe(2);
  });
});
