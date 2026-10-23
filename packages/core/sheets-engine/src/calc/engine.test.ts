import { describe, expect, it } from 'vitest';
import { parseA1 } from '../address';
import { Sheet, Workbook } from '../model/workbook';
import { Engine, type CellContent } from './engine';

function setup(cells: Record<string, string | number | boolean | null> = {}) {
  const wb = new Workbook();
  wb.sheets.push(new Sheet('s1', 'Sheet1'), new Sheet('s2', 'Data'));
  const engine = new Engine(wb, { now: () => Date.UTC(2026, 0, 15), random: () => 0.25, timezoneOffset: () => 0 });
  const set = (a1: string, input: string | number | boolean | null, sheetId = 's1') => {
    const { row, col } = parseA1(a1)!;
    const content: CellContent | null =
      input === null ? null : typeof input === 'string' && input.startsWith('=') ? { f: input.slice(1) } : { v: input };
    engine.setContent(sheetId, row, col, content);
  };
  const get = (a1: string, sheetId = 's1') => {
    const { row, col } = parseA1(a1)!;
    return engine.getValue(sheetId, row, col);
  };
  const formula = (a1: string, sheetId = 's1') => {
    const { row, col } = parseA1(a1)!;
    return engine.getCell(sheetId, row, col)?.f;
  };
  for (const [a1, v] of Object.entries(cells)) set(a1, v);
  engine.recalc();
  return { engine, set, get, formula };
}

describe('Engine recalculation', () => {
  it('evaluates formulas and propagates changes through dependents', () => {
    const { engine, set, get } = setup({ A1: 1, A2: '=A1+1', A3: '=A2*10', B1: '=A1+A2+A3' });
    expect(get('A3')).toBe(20);
    expect(get('B1')).toBe(23);
    set('A1', 5);
    engine.recalc();
    expect(get('A2')).toBe(6);
    expect(get('A3')).toBe(60);
    expect(get('B1')).toBe(71);
  });

  it('tracks range precedents, including whole columns', () => {
    const { engine, set, get } = setup({ A1: 1, A2: 2, B1: '=A1:A3*1', C1: '=A:A=2' });
    set('A3', 3);
    engine.recalc();
    expect(get('B3')).toBe(3);
    expect(get('C2')).toBe(true);
  });

  it('handles a long chain without recursion', () => {
    const { engine, set, get } = setup({ A1: 1 });
    for (let r = 2; r <= 20000; r++) set(`A${r}`, `=A${r - 1}+1`);
    engine.recalc();
    expect(get('A20000')).toBe(20000);
    set('A1', 100);
    engine.recalc();
    expect(get('A20000')).toBe(20099);
  });

  it('reports cycles as #REF!', () => {
    const { get } = setup({ A1: '=B1+1', B1: '=A1+1', C1: '=A1' });
    expect(get('A1')).toMatchObject({ code: '#REF!', message: 'Circular dependency' });
    expect(get('C1')).toMatchObject({ code: '#REF!' });
  });

  it('reads across sheets by name', () => {
    const { engine, set, get } = setup({ A1: "=Data!B2*2" });
    set('B2', 21, 's2');
    engine.recalc();
    expect(get('A1')).toBe(42);
  });

  it('shows an empty reference as 0', () => {
    const { get } = setup({ A1: '=B9' });
    expect(get('A1')).toBe(0);
  });
});

describe('Engine spills', () => {
  it('spills arrays and lets other formulas read the spilled cells', () => {
    const { get, engine } = setup({ A1: '={1;2;3}*10', B3: '=A3+1' });
    expect(get('A1')).toBe(10);
    expect(get('A2')).toBe(20);
    expect(get('A3')).toBe(30);
    expect(get('B3')).toBe(31);
    expect(engine.spillArea('s1', 0, 0)).toEqual({ r1: 0, c1: 0, r2: 2, c2: 0 });
  });

  it('blocks on content with #SPILL! and recovers when cleared', () => {
    const { engine, set, get } = setup({ A1: '={1;2;3}', A2: 'x' });
    expect(get('A1')).toMatchObject({ code: '#SPILL!' });
    set('A2', null);
    engine.recalc();
    expect(get('A1')).toBe(1);
    expect(get('A2')).toBe(2);
    set('A3', 'y');
    engine.recalc();
    expect(get('A1')).toMatchObject({ code: '#SPILL!' });
    expect(get('A2')).toBe(null);
  });

  it('updates readers when a spill shrinks', () => {
    const { engine, set, get } = setup({ C1: 3, B3: '=A3' });
    set('A1', '=C1:C3*1');
    set('C2', 1);
    set('C3', 2);
    engine.recalc();
    expect(get('B3')).toBe(2);
    set('A1', '=C1:C2*1');
    engine.recalc();
    expect(get('A3')).toBe(null);
    expect(get('B3')).toBe(0);
  });
});

describe('Engine structural changes', () => {
  it('moves references when rows are inserted', () => {
    const { engine, get, formula } = setup({ A1: 1, A2: 2, A3: '=A1+A2' });
    engine.insertDims('s1', 'row', 1, 2);
    expect(formula('A5')).toBe('A1+A4');
    expect(get('A5')).toBe(3);
  });

  it('turns references to deleted rows into #REF! and shrinks ranges', () => {
    const { engine, get, formula } = setup({ A1: 1, A2: 2, A3: 3, B1: '=A2', C1: '=A1:A3*1' });
    const rewritten = engine.deleteDims('s1', 'row', 1, 1);
    expect(formula('B1')).toBe('#REF!');
    expect(get('B1')).toMatchObject({ code: '#REF!' });
    expect(formula('C1')).toBe('A1:A2*1');
    expect(rewritten.map((r) => r.before).sort()).toEqual(['A1:A3*1', 'A2']);
  });

  it('rewrites references on sheet rename and removal', () => {
    const { engine, formula, get } = setup({ A1: '=Data!A1+1' });
    engine.renameSheet('s2', 'Q1 Sales');
    expect(formula('A1')).toBe("'Q1 Sales'!A1+1");
    engine.removeSheet('s2');
    expect(formula('A1')).toBe('#REF!+1');
    expect(get('A1')).toMatchObject({ code: '#REF!' });
  });

  it('moves rows and keeps references pointing at the moved data', () => {
    const { engine, formula, get } = setup({ A1: 'a', A2: 'b', A3: 'c', B1: '=A3' });
    engine.moveDims('s1', 'row', 2, 1, 0); // row 3 to the top
    expect(get('A1')).toBe('c');
    expect(formula('B2')).toBe('A1');
    expect(get('B2')).toBe('c');
  });
});
