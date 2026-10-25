import { describe, expect, it } from 'vitest';
import { parseA1 } from '../address';
import { applyOp } from '../ops/apply';
import { Sheet, Workbook, type WorkbookSnapshot } from '../model/workbook';
import { Engine, type EngineOptions } from './engine';

const OPTIONS: EngineOptions = { now: () => Date.UTC(2026, 0, 15), random: () => 0.25, timezoneOffset: () => 0 };

function engineWith(cells: Record<string, string | number>): Engine {
  const wb = new Workbook();
  wb.sheets.push(new Sheet('s1', 'Sheet1'));
  const engine = new Engine(wb, OPTIONS);
  applyOp(engine, {
    type: 'setCells',
    sheetId: 's1',
    cells: Object.entries(cells).map(([a1, input]) => {
      const { row, col } = parseA1(a1)!;
      return [row, col, typeof input === 'string' && input.startsWith('=') ? { f: input.slice(1) } : { v: input }];
    }),
  });
  return engine;
}

const at = (engine: Engine, a1: string) => {
  const { row, col } = parseA1(a1)!;
  return engine.getValue('s1', row, col);
};

/** Through JSON, as a checkpoint is stored and sent. */
const reload = (snapshot: WorkbookSnapshot) => Engine.fromSnapshot(JSON.parse(JSON.stringify(snapshot)) as WorkbookSnapshot, OPTIONS);

/** The snapshot with one cell's stored value replaced (to tell a value that was kept from one that was recalculated). */
function withStoredValue(snapshot: WorkbookSnapshot, row: number, col: number, v: number): WorkbookSnapshot {
  const copy = JSON.parse(JSON.stringify(snapshot)) as WorkbookSnapshot;
  const cell = copy.sheets[0]!.cells.find(([r, c]) => r === row && c === col)!;
  cell[2].v = v;
  return copy;
}

describe('loading a calculated snapshot', () => {
  it('stores spilled arrays and keeps formula results instead of evaluating them again', () => {
    const engine = engineWith({ A1: 1, A2: 2, A3: 3, B1: '=A1:A3*10', C1: '=SUM(B1:B3)' });
    const snapshot = engine.toSnapshot();
    expect(snapshot.calculated).toBe(true);
    expect(snapshot.sheets[0]!.spills).toEqual([[0, 1, [[10], [20], [30]]]]);

    // C1's stored 60 replaced by 999: a load that evaluated C1 would put 60 back.
    const loaded = reload(withStoredValue(snapshot, 0, 2, 999));
    expect(at(loaded, 'C1')).toBe(999);
    expect(at(loaded, 'B2')).toBe(20);
    expect(loaded.spillArea('s1', 0, 1)).toEqual({ r1: 0, c1: 1, r2: 2, c2: 1 });

    // Edits recalculate from there as usual.
    applyOp(loaded, { type: 'setCells', sheetId: 's1', cells: [[1, 0, { v: 5 }]] });
    expect(at(loaded, 'B2')).toBe(50);
    expect(at(loaded, 'C1')).toBe(90);
  });

  it('evaluates every formula when the snapshot is not marked calculated', () => {
    const engine = engineWith({ A1: 2, B1: '=A1*3' });
    const snapshot = withStoredValue(engine.toSnapshot(), 0, 1, 999);
    delete snapshot.calculated;
    expect(at(reload(snapshot), 'B1')).toBe(6);
  });

  it('round-trips to the same snapshot', () => {
    const engine = engineWith({ A1: 3, A2: 1, A3: 2, B1: '=SORT(A1:A3)', C1: '=SEQUENCE(2,2)', D5: '=B1+C2' });
    const snapshot = engine.toSnapshot();
    expect(reload(snapshot).toSnapshot()).toEqual(snapshot);
  });

  it('recalculates volatile formulas on load', () => {
    let now = Date.UTC(2026, 0, 15);
    const wb = new Workbook();
    wb.sheets.push(new Sheet('s1', 'Sheet1'));
    const engine = new Engine(wb, { ...OPTIONS, now: () => now });
    applyOp(engine, { type: 'setCells', sheetId: 's1', cells: [[0, 0, { f: 'TODAY()' }], [0, 1, { f: 'A1+1' }]] });
    const snapshot = engine.toSnapshot();
    now += 86_400_000;
    const loaded = Engine.fromSnapshot(JSON.parse(JSON.stringify(snapshot)) as WorkbookSnapshot, { ...OPTIONS, now: () => now });
    expect(loaded.getValue('s1', 0, 0)).toBe((engine.getValue('s1', 0, 0) as number) + 1);
    expect(loaded.getValue('s1', 0, 1)).toBe((engine.getValue('s1', 0, 1) as number) + 1);
  });

  it('wakes a blocked spill when its way clears', () => {
    const engine = engineWith({ A1: 1, A2: 2, B1: '=A1:A2', B2: 'in the way' });
    expect(engine.getValue('s1', 0, 1)).toMatchObject({ kind: 'error', code: '#SPILL!' });
    const loaded = reload(engine.toSnapshot());
    applyOp(loaded, { type: 'setCells', sheetId: 's1', cells: [[1, 1, null]] });
    expect(at(loaded, 'B1')).toBe(1);
    expect(at(loaded, 'B2')).toBe(2);
  });

  it('still recalculates SUBTOTAL when rows are hidden after a load that evaluated nothing', () => {
    const engine = engineWith({ A1: 1, A2: 2, A3: 3, B1: '=SUBTOTAL(109,A1:A3)' });
    const loaded = reload(engine.toSnapshot());
    applyOp(loaded, { type: 'hideDims', sheetId: 's1', axis: 'row', indices: [1], hidden: true });
    expect(at(loaded, 'B1')).toBe(4);
  });

  it('evaluates a stored spill that no longer sits on a formula instead of trusting it', () => {
    const engine = engineWith({ A1: 1, A2: 2, B1: '=A1:A2*2' });
    const snapshot = JSON.parse(JSON.stringify(engine.toSnapshot())) as WorkbookSnapshot;
    snapshot.sheets[0]!.spills = [[0, 3, [[7], [8]]]];
    const loaded = reload(snapshot);
    expect(at(loaded, 'D2')).toBeNull();
  });
});

describe('a spilling formula caught in a cycle', () => {
  it('stops showing its last array', () => {
    const engine = engineWith({ A1: 1, A2: 2, A3: 3, B1: '=A1:A3*2' });
    expect(at(engine, 'B3')).toBe(6);
    applyOp(engine, { type: 'setCells', sheetId: 's1', cells: [[0, 0, { f: 'B3+1' }]] });
    expect(at(engine, 'B1')).toMatchObject({ kind: 'error', code: '#REF!' });
    expect(at(engine, 'B3')).toBeNull();
  });
});
