import { describe, expect, it } from 'vitest';
import type { Matrix, Scalar } from '../../values';
import { testHost } from '../test-host';

function data(m: Scalar | Matrix): Scalar[][] {
  if (typeof m === 'object' && m !== null && m.kind === 'matrix') return m.data;
  throw new Error(`expected an array, got ${JSON.stringify(m)}`);
}

/** A host whose RAND() counts its calls, to prove branches are not evaluated. */
function counting(cells: Record<string, Scalar> = {}) {
  const calls = { n: 0 };
  const run = testHost(cells, {
    random: () => {
      calls.n++;
      return 0.5;
    },
  });
  return { run, calls };
}

const cells = { A1: 1, A2: 2, A3: 3, C1: { kind: 'error', code: '#N/A' } as const, C2: 4, D1: 'x', D2: true };

describe('IF', () => {
  const run = testHost(cells);

  it('picks a branch and coerces the condition', () => {
    expect(run('IF(TRUE,1,2)')).toBe(1);
    expect(run('IF(A2>1,"y","n")')).toBe('y');
    expect(run('IF(0,1,2)')).toBe(2);
    expect(run('IF("TRUE",1,2)')).toBe(1);
    expect(run('IF(A9,1,2)')).toBe(2);
    expect(run('IF("abc",1,2)')).toMatchObject({ code: '#VALUE!' });
    expect(run('IF(1/0,1,2)')).toMatchObject({ code: '#DIV/0!' });
  });

  it('handles omitted and empty branches like Excel', () => {
    expect(run('IF(FALSE,1)')).toBe(false);
    expect(run('IF(TRUE,,2)')).toBe(0);
    expect(run('IF(FALSE,1,)')).toBe(0);
  });

  it('returns references, so aggregates can consume a branch', () => {
    expect(run('SUM(IF(TRUE,A1:A3,C1:C2))')).toBe(6);
  });

  it('only evaluates the chosen branch', () => {
    const { run: r, calls } = counting();
    expect(r('IF(TRUE,1,RAND())')).toBe(1);
    expect(r('IF(FALSE,RAND(),2)')).toBe(2);
    expect(calls.n).toBe(0);
  });

  it('works element-wise on an array condition', () => {
    expect(data(run('IF(A1:A3>1,"y","n")'))).toEqual([['n'], ['y'], ['y']]);
    expect(data(run('IF({TRUE,FALSE},{1;2},3)'))).toEqual([
      [1, 3],
      [2, 3],
    ]);
    expect(data(run('IF(A1:A3>1,A1:A3*10)'))).toEqual([[false], [20], [30]]);
    expect(data(run('IF({1,"x"},1,2)'))).toEqual([[1, { kind: 'error', code: '#VALUE!' }]]);
    expect(run('SUM(IF(A1:A3>1,A1:A3))')).toBe(5);
  });

  it('skips a branch no element needs in array mode', () => {
    const { run: r, calls } = counting({ A1: 1, A2: 2 });
    expect(data(r('IF(A1:A2>0,"y",RAND())'))).toEqual([['y'], ['y']]);
    expect(calls.n).toBe(0);
  });
});

describe('IFS', () => {
  const run = testHost(cells);

  it('returns the value of the first true condition', () => {
    expect(run('IFS(A1>2,"a",A1>0,"b")')).toBe('b');
    expect(run('IFS(A1>2,"a",TRUE,"c")')).toBe('c');
    expect(run('IFS(A1>2,"a")')).toMatchObject({ code: '#N/A' });
    expect(run('IFS("abc",1)')).toMatchObject({ code: '#VALUE!' });
    expect(run('IFS(TRUE,1,FALSE)')).toMatchObject({ code: '#N/A' });
  });

  it('short-circuits', () => {
    const { run: r, calls } = counting();
    expect(r('IFS(TRUE,1,RAND()>0,RAND())')).toBe(1);
    expect(calls.n).toBe(0);
  });

  it('works element-wise', () => {
    expect(data(run('IFS(A1:A3>2,"big",A1:A3>1,"mid",TRUE,"small")'))).toEqual([['small'], ['mid'], ['big']]);
    expect(data(run('IFS(A1:A3>2,"big")'))).toEqual([[{ kind: 'error', code: '#N/A' }], [{ kind: 'error', code: '#N/A' }], ['big']]);
  });
});

describe('IFERROR and IFNA', () => {
  const run = testHost(cells);

  it('IFERROR catches every error', () => {
    expect(run('IFERROR(1/0,"err")')).toBe('err');
    expect(run('IFERROR(NA(),0)')).toBe(0);
    expect(run('IFERROR(5,"err")')).toBe(5);
    expect(run('IFERROR(1/0,)')).toBe(0);
    expect(run('IFERROR(C1,-1)')).toBe(-1);
  });

  it('IFNA catches #N/A only', () => {
    expect(run('IFNA(NA(),"x")')).toBe('x');
    expect(run('IFNA(C1,"x")')).toBe('x');
    expect(run('IFNA(1/0,"x")')).toMatchObject({ code: '#DIV/0!' });
  });

  it('works element-wise', () => {
    expect(data(run('IFERROR(1/{1,0,2},"x")'))).toEqual([[1, 'x', 0.5]]);
    expect(data(run('IFERROR(C1:C2,-1)'))).toEqual([[-1], [4]]);
    expect(data(run('IFNA(C1:C2/{1;0},"na")'))).toEqual([['na'], [{ kind: 'error', code: '#DIV/0!' }]]);
    expect(data(run('IFERROR({1,0}/{0,1},{7,8})'))).toEqual([[7, 0]]);
  });

  it('does not evaluate the fallback when nothing fails', () => {
    const { run: r, calls } = counting();
    expect(r('IFERROR(1,RAND())')).toBe(1);
    expect(data(r('IFERROR({1,2},RAND())'))).toEqual([[1, 2]]);
    expect(calls.n).toBe(0);
  });
});

describe('SWITCH', () => {
  const run = testHost(cells);

  it('matches exactly, case-insensitively for text, with an optional default', () => {
    expect(run('SWITCH(2,1,"a",2,"b","c")')).toBe('b');
    expect(run('SWITCH(9,1,"a",2,"b","c")')).toBe('c');
    expect(run('SWITCH(9,1,"a",2,"b")')).toMatchObject({ code: '#N/A' });
    expect(run('SWITCH("B","a",1,"b",2)')).toBe(2);
    expect(run('SWITCH(1,"1","text",1,"num")')).toBe('num');
    expect(run('SWITCH(1/0,1,"a")')).toMatchObject({ code: '#DIV/0!' });
  });

  it('short-circuits and works element-wise', () => {
    const { run: r, calls } = counting();
    expect(r('SWITCH(1,1,"a",2,RAND())')).toBe('a');
    expect(calls.n).toBe(0);
    expect(data(run('SWITCH(A1:A3,1,"one",2,"two","many")'))).toEqual([['one'], ['two'], ['many']]);
  });
});

describe('AND, OR, XOR, NOT', () => {
  const run = testHost(cells);

  it('AND', () => {
    expect(run('AND(TRUE,TRUE)')).toBe(true);
    expect(run('AND(TRUE,FALSE)')).toBe(false);
    expect(run('AND(A1:A3)')).toBe(true);
    expect(run('AND(A1:A3,D1:D2)')).toBe(true);
    expect(run('AND("TRUE",1)')).toBe(true);
    expect(run('AND("abc")')).toMatchObject({ code: '#VALUE!' });
    expect(run('AND(E1:E3)')).toMatchObject({ code: '#VALUE!' });
    expect(run('AND(D1)')).toMatchObject({ code: '#VALUE!' });
    expect(run('AND(1/0,TRUE)')).toMatchObject({ code: '#DIV/0!' });
    expect(run('AND({1,0})')).toBe(false);
    expect(run('AND(A1:A3>0)')).toBe(true);
    expect(run('AND(TRUE,)')).toBe(false);
  });

  it('OR and XOR', () => {
    expect(run('OR(FALSE,0)')).toBe(false);
    expect(run('OR(D1:D2)')).toBe(true);
    expect(run('OR(A1:A3>2)')).toBe(true);
    expect(run('OR("x")')).toMatchObject({ code: '#VALUE!' });
    expect(run('XOR(TRUE,TRUE)')).toBe(false);
    expect(run('XOR(TRUE,FALSE,TRUE,TRUE)')).toBe(true);
    expect(run('XOR(A1:A3>1)')).toBe(false);
  });

  it('NOT lifts over arrays', () => {
    expect(run('NOT(TRUE)')).toBe(false);
    expect(run('NOT(0)')).toBe(true);
    expect(run('NOT(A9)')).toBe(true);
    expect(run('NOT("x")')).toMatchObject({ code: '#VALUE!' });
    expect(data(run('NOT(A1:A3>1)'))).toEqual([[true], [false], [false]]);
  });

  it('TRUE() and FALSE()', () => {
    expect(run('TRUE()')).toBe(true);
    expect(run('FALSE()')).toBe(false);
  });
});
