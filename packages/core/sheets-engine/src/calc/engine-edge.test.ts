import { describe, expect, it } from 'vitest';
import { parseA1 } from '../address';
import { Sheet, Workbook } from '../model/workbook';
import { Engine } from './engine';

function setup() {
  const wb = new Workbook();
  wb.sheets.push(new Sheet('s1', 'Sheet1'));
  const engine = new Engine(wb, { now: () => 0, random: () => 0.5, timezoneOffset: () => 0 });
  const set = (a1: string, input: string | number | null) => {
    const { row, col } = parseA1(a1)!;
    if (input === null) engine.setContent('s1', row, col, null);
    else if (typeof input === 'string' && input.startsWith('=')) engine.setContent('s1', row, col, { f: input.slice(1) });
    else engine.setContent('s1', row, col, { v: input });
  };
  const get = (a1: string) => {
    const { row, col } = parseA1(a1)!;
    return engine.getValue('s1', row, col);
  };
  return { engine, set, get };
}

describe('Engine edge cases', () => {
  it('does not treat readers of a blocked spill area as its dependents', () => {
    const { engine, set, get } = setup();
    set('A2', 5);
    set('B1', '=A2');
    set('A1', '=SEQUENCE(B1)');
    engine.recalc();
    expect(get('A1')).toMatchObject({ code: '#SPILL!' });
    set('A2', 6);
    engine.recalc();
    expect(get('B1')).toBe(6);
    expect(get('A1')).toMatchObject({ code: '#SPILL!' });
  });

  it('lets a spilled value show through a cell that only holds a style', () => {
    const { engine, set, get } = setup();
    set('A1', '={1;2;3}');
    set('B1', '=A2*10');
    engine.recalc();
    engine.setStyleKey('s1', 1, 0, '{"bold":true}');
    engine.recalc();
    expect(get('A2')).toBe(2);
    expect(get('B1')).toBe(20);
  });

  it('wakes a blocked spill when the spill blocking it goes away', () => {
    const { engine, set, get } = setup();
    set('C1', '=SEQUENCE(3)');
    set('A3', '=SEQUENCE(1,5)');
    engine.recalc();
    expect(get('A3')).toMatchObject({ code: '#SPILL!' });
    set('C1', 1);
    engine.recalc();
    expect(get('A3')).toBe(1);
    expect(get('E3')).toBe(5);
  });

  it('resolves INDIRECT chains deeper than one pull can reach', () => {
    const { engine, set, get } = setup();
    set('A1', 1);
    for (let r = 2; r <= 600; r++) set(`A${r}`, '=INDIRECT("A"&(ROW()-1))+1');
    engine.recalc();
    expect(get('A600')).toBe(600);
    set('A1', 10);
    engine.recalc();
    expect(get('A600')).toBe(609);
  });

  it('marks whole cycles the same way whatever order cells are entered in', () => {
    const results = [false, true].map((reverse) => {
      const { engine, set, get } = setup();
      const cells: [string, string][] = [
        ['A1', '=C1'],
        ['B1', '=A1+D1'],
        ['C1', '=B1'],
        ['D1', '=IFERROR(A1,5)'],
      ];
      for (const [a1, f] of reverse ? [...cells].reverse() : cells) set(a1, f);
      engine.recalc();
      return ['A1', 'B1', 'C1', 'D1'].map((a1) => JSON.stringify(get(a1)));
    });
    expect(results[0]).toEqual(results[1]);
    expect(results[0]![3]).toContain('#REF!');
  });

  it('marks a formula reading itself as circular', () => {
    const { engine, set, get } = setup();
    set('A1', '=A1+1');
    engine.recalc();
    expect(get('A1')).toMatchObject({ code: '#REF!', message: 'Circular dependency' });
  });
});
