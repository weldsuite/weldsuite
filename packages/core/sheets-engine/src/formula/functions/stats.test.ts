import { describe, expect, it } from 'vitest';
import { parseA1 } from '../../address';
import type { Matrix, Scalar } from '../../values';
import { evaluate, resolveResult } from '../evaluator';
import { parseFormula } from '../parser';
import { testHost } from '../test-host';
import type { EvalContext, EvalHost } from '../types';

/** Column of values starting at `col`1: col('A', [1, 2]) → { A1: 1, A2: 2 }. */
function col(letter: string, values: Scalar[]): Record<string, Scalar> {
  return Object.fromEntries(values.map((v, i) => [`${letter}${i + 1}`, v]));
}

function data(m: Scalar | Matrix): Scalar[][] {
  if (typeof m === 'object' && m !== null && m.kind === 'matrix') return m.data;
  throw new Error(`expected an array, got ${JSON.stringify(m)}`);
}

function close(v: Scalar | Matrix, expected: number, digits = 6): void {
  expect(typeof v).toBe('number');
  expect(v as number).toBeCloseTo(expected, digits);
}

describe('averages and counts', () => {
  const run = testHost({ ...col('A', [1, 2, 'x', true, null, 6]), B1: '3', C1: { kind: 'error', code: '#N/A' } });

  it('AVERAGE ignores text and booleans in ranges, coerces typed values', () => {
    expect(run('AVERAGE(A1:A6)')).toBe(3);
    expect(run('AVERAGE(A1:A6,TRUE,"4")')).toBe(2.8);
    expect(run('AVERAGE(1,)')).toBe(0.5);
    expect(run('AVERAGE("x")')).toMatchObject({ code: '#VALUE!' });
    expect(run('AVERAGE(D1:D5)')).toMatchObject({ code: '#DIV/0!' });
    expect(run('AVERAGE(A1:A6,C1)')).toMatchObject({ code: '#N/A' });
  });

  it('AVERAGEA counts text as 0 and TRUE as 1', () => {
    expect(run('AVERAGEA(A1:A6)')).toBe(2);
  });

  it('COUNT, COUNTA, COUNTBLANK', () => {
    expect(run('COUNT(A1:A6)')).toBe(3);
    expect(run('COUNT(A1:A6,TRUE,"7","x",C1)')).toBe(5);
    expect(run('COUNT(1/0,2)')).toBe(1);
    expect(run('COUNTA(A1:A6)')).toBe(5);
    expect(run('COUNTA(A1:A6,C1,B1)')).toBe(7);
    expect(run('COUNTBLANK(A1:A6)')).toBe(1);
    expect(run('COUNTBLANK(A:A)')).toBe(1_048_576 - 5);
  });

  it('COUNTBLANK counts empty text as blank', () => {
    const r = testHost({ A1: 1, A2: '=""', A3: null });
    expect(r('COUNTBLANK(A1:A3)')).toBe(2);
  });
});

describe('criteria functions', () => {
  const run = testHost({
    ...col('A', ['apple', 'banana', 'apple', 'cherry', null, 'Apple pie']),
    ...col('B', [10, 20, 30, 40, 50, 60]),
    ...col('C', [1, 2, 3, 4, 5, 6]),
    E1: 'apple',
    E2: 'banana',
  });

  it('COUNTIF matches case-insensitively, with operators and wildcards', () => {
    expect(run('COUNTIF(A1:A6,"apple")')).toBe(2);
    expect(run('COUNTIF(A1:A6,"app*")')).toBe(3);
    expect(run('COUNTIF(B1:B6,">=30")')).toBe(4);
    expect(run('COUNTIF(B1:B6,30)')).toBe(1);
    expect(run('COUNTIF(A1:A6,"")')).toBe(1);
    expect(run('COUNTIF(A1:A6,"<>apple")')).toBe(4);
  });

  it('COUNTIF over a whole column accounts for the clipped blanks', () => {
    expect(run('COUNTIF(A:A,"apple")')).toBe(2);
    expect(run('COUNTIF(B:B,">25")')).toBe(4);
    expect(run('COUNTIF(A:A,"")')).toBe(1_048_576 - 5);
    expect(run('COUNTIF(A:A,"<>apple")')).toBe(1_048_576 - 2);
  });

  it('COUNTIF lifts an array of criteria', () => {
    expect(data(run('COUNTIF(A1:A6,E1:E2)'))).toEqual([[2], [1]]);
  });

  it('COUNTIFS needs every criterion and same-shaped ranges', () => {
    expect(run('COUNTIFS(A1:A6,"apple",B1:B6,">15")')).toBe(1);
    expect(run('COUNTIFS(A:A,"apple",B:B,">5")')).toBe(2);
    expect(run('COUNTIFS(A1:A6,"apple",B1:B5,">15")')).toMatchObject({ code: '#VALUE!' });
    expect(run('COUNTIFS(A1:A6,"apple",B1:B6)')).toMatchObject({ code: '#N/A' });
  });

  it('AVERAGEIF and AVERAGEIFS', () => {
    expect(run('AVERAGEIF(A1:A6,"apple",B1:B6)')).toBe(20);
    expect(run('AVERAGEIF(B1:B6,">25")')).toBe(45);
    expect(run('AVERAGEIF(A1:A6,"kiwi",B1:B6)')).toMatchObject({ code: '#DIV/0!' });
    // The average range is resized to the criteria range from its top-left cell.
    expect(run('AVERAGEIF(A1:A6,"apple",B1)')).toBe(20);
    expect(run('AVERAGEIFS(B:B,A:A,"apple",C:C,">1")')).toBe(30);
  });

  it('reads only the used rows of whole-column references', () => {
    const values = new Map<string, Scalar>();
    for (const [a1, v] of Object.entries({ A1: 'x', A2: 'y', A3: 'x', B1: 1, B2: 2, B3: 4 })) {
      const { row, col } = parseA1(a1)!;
      values.set(`${row}:${col}`, v);
    }
    let reads = 0;
    const host: EvalHost = {
      cellValue: (_s, r, c) => {
        reads++;
        return values.get(`${r}:${c}`) ?? null;
      },
      forEachValue: (_s, range, fn) => {
        for (const [k, v] of values) {
          const [r, c] = k.split(':').map(Number) as [number, number];
          if (r >= range.r1 && r <= range.r2 && c >= range.c1 && c <= range.c2) fn(r, c, v);
        }
      },
      usedRange: () => ({ r1: 0, c1: 0, r2: 2, c2: 1 }),
      sheetIdByName: () => 'S',
      sheetName: () => 'S',
      sheetIds: () => ['S'],
      definedName: () => undefined,
      now: () => 0,
      random: () => 0.5,
      timezoneOffset: () => 0,
      isRowHidden: () => false,
      cellFormula: () => undefined,
    };
    const ctx: EvalContext = { host, sheetId: 'S', row: 50, col: 5 };
    const calc = (f: string) => resolveResult(evaluate(parseFormula(f), ctx), ctx);
    expect(calc('SUMIFS(B:B,A:A,"x")')).toBe(5);
    expect(calc('COUNTIFS(A:A,"x",B:B,">1")')).toBe(1);
    expect(calc('AVERAGEIF(A:A,"x",B:B)')).toBe(2.5);
    expect(calc('SUMPRODUCT((A:A="x")*B:B)')).toBe(5);
    expect(calc('COUNTIF(B:B,"<>2")')).toBe(1_048_575);
    expect(reads).toBeLessThan(100);
  });

  it('MAXIFS and MINIFS', () => {
    expect(run('MAXIFS(B1:B6,A1:A6,"apple")')).toBe(30);
    expect(run('MINIFS(B1:B6,A1:A6,"apple*")')).toBe(10);
    expect(run('MAXIFS(B1:B6,A1:A6,"kiwi")')).toBe(0);
    expect(run('MINIFS(B:B,C:C,">3")')).toBe(40);
  });
});

describe('extremes and order statistics', () => {
  const run = testHost({ ...col('A', [3, 'x', true, 7, -2]), B1: { kind: 'error', code: '#DIV/0!' } });

  it('MAX/MIN ignore text and booleans in ranges; the A variants count them', () => {
    expect(run('MAX(A1:A5)')).toBe(7);
    expect(run('MIN(A1:A5)')).toBe(-2);
    expect(run('MAX(D1:D3)')).toBe(0);
    expect(run('MAX(A1:A5,B1)')).toMatchObject({ code: '#DIV/0!' });
    expect(run('MAXA(A1:A5)')).toBe(7);
    expect(run('MINA({1,2},A2)')).toBe(0);
    expect(run('MAXA(-3,FALSE)')).toBe(0);
  });

  it('MEDIAN', () => {
    expect(run('MEDIAN(1,2,3,4,5)')).toBe(3);
    expect(run('MEDIAN(1,2,3,4,5,6)')).toBe(3.5);
    expect(run('MEDIAN(D1:D3)')).toMatchObject({ code: '#NUM!' });
  });

  it('MODE, MODE.SNGL and MODE.MULT', () => {
    expect(run('MODE(5.6,4,4,3,2,4)')).toBe(4);
    expect(run('MODE.SNGL({1,2,2,1})')).toBe(1);
    expect(run('MODE(1,2,3)')).toMatchObject({ code: '#N/A' });
    expect(data(run('MODE.MULT({1,2,3,4,3,2,1,2,3,5,6,1})'))).toEqual([[1], [2], [3]]);
  });

  it('LARGE and SMALL, k lifts', () => {
    expect(run('LARGE({3,5,3,5,4},3)')).toBe(4);
    expect(run('SMALL({3,5,3,5,4},1)')).toBe(3);
    expect(run('LARGE({1,2},3)')).toMatchObject({ code: '#NUM!' });
    expect(data(run('LARGE({10,30,20},{1,2})'))).toEqual([[30, 20]]);
  });

  it('RANK, RANK.EQ and RANK.AVG', () => {
    expect(run('RANK.EQ(7,{7,3.5,3.5,1,2},1)')).toBe(5);
    expect(run('RANK(2,{7,3.5,3.5,1,2})')).toBe(4);
    expect(run('RANK.AVG(94,{89,88,92,101,94,97,95})')).toBe(4);
    expect(run('RANK.AVG(3.5,{7,3.5,3.5,1,2},1)')).toBe(3.5);
    expect(run('RANK.EQ(9,{1,2})')).toMatchObject({ code: '#N/A' });
  });

  it('PERCENTILE and QUARTILE, inclusive and exclusive', () => {
    close(run('PERCENTILE.INC({1,3,2,4},0.3)'), 1.9);
    close(run('PERCENTILE({1,3,2,4},0.3)'), 1.9);
    expect(run('PERCENTILE.EXC({1,2,3,6,6,6,7,8,9},0.25)')).toBe(2.5);
    expect(run('PERCENTILE.EXC({1,2,3},0.1)')).toMatchObject({ code: '#NUM!' });
    expect(run('PERCENTILE.INC({1,2},1.5)')).toMatchObject({ code: '#NUM!' });
    expect(run('QUARTILE.INC({1,2,4,7,8,9,10,12},1)')).toBe(3.5);
    expect(run('QUARTILE({1,2,4,7,8,9,10,12},4)')).toBe(12);
    expect(run('QUARTILE.EXC({6,7,15,36,39,40,41,42,43,47,49},1)')).toBe(15);
    expect(run('QUARTILE.EXC({6,7,15,36,39,40,41,42,43,47,49},3)')).toBe(43);
    expect(run('QUARTILE.EXC({1,2,3},4)')).toMatchObject({ code: '#NUM!' });
  });

  it('PERCENTRANK, inclusive and exclusive, truncated to the significance', () => {
    const d = '{13,12,11,8,4,3,2,1,1,1}';
    expect(run(`PERCENTRANK.INC(${d},2)`)).toBe(0.333);
    expect(run(`PERCENTRANK(${d},4)`)).toBe(0.555);
    expect(run(`PERCENTRANK.INC(${d},8)`)).toBe(0.666);
    expect(run(`PERCENTRANK.INC(${d},5)`)).toBe(0.583);
    expect(run(`PERCENTRANK.INC(${d},20)`)).toMatchObject({ code: '#N/A' });
    expect(run('PERCENTRANK.EXC({1,2,3,6,6,6,7,8,9},7)')).toBe(0.7);
    expect(run('PERCENTRANK.EXC({1,2,3,6,6,6,7,8,9},5.43)')).toBe(0.381);
    expect(run('PERCENTRANK.EXC({1,2,3,6,6,6,7,8,9},5.43,1)')).toBe(0.3);
  });

  it('TRIMMEAN and FREQUENCY', () => {
    close(run('TRIMMEAN({4,5,6,7,2,3,4,5,1,2,3},0.2)'), 3.777778);
    expect(run('TRIMMEAN({1,2},1)')).toMatchObject({ code: '#NUM!' });
    expect(data(run('FREQUENCY({79,85,78,85,50,81,95,88,97},{70,79,89})'))).toEqual([[1], [2], [4], [2]]);
    // Unsorted bins keep their positions.
    expect(data(run('FREQUENCY({1,2,3,4,5},{4,2})'))).toEqual([[2], [2], [1]]);
  });
});

describe('dispersion', () => {
  const sample = '{1345,1301,1368,1322,1310,1370,1318,1350,1303,1299}';
  const run = testHost({ ...col('A', [2, 4, 'x', true]) });

  it('STDEV and VAR, sample and population', () => {
    close(run(`STDEV.S(${sample})`), 27.46391572);
    close(run(`STDEV(${sample})`), 27.46391572);
    close(run(`STDEV.P(${sample})`), 26.05455814);
    close(run(`STDEVP(${sample})`), 26.05455814);
    close(run(`VAR.S(${sample})`), 754.2666667);
    close(run(`VAR(${sample})`), 754.2666667);
    close(run(`VAR.P(${sample})`), 678.84);
    close(run(`VARP(${sample})`), 678.84);
    expect(run('STDEV(1)')).toMatchObject({ code: '#DIV/0!' });
  });

  it('the A variants count text as 0 and TRUE as 1', () => {
    close(run('VARA(A1:A4)'), 2.916666667);
    close(run('VARPA(A1:A4)'), 2.1875);
    close(run('STDEVA(A1:A4)'), 1.707825128);
    close(run('STDEVPA(A1:A4)'), 1.479019946);
    expect(run('VAR(A1:A4)')).toBe(2);
  });

  it('AVEDEV, DEVSQ, GEOMEAN, HARMEAN', () => {
    close(run('AVEDEV(4,5,6,7,5,4,3)'), 1.020408163);
    expect(run('DEVSQ(4,5,8,7,11,4,3)')).toBe(48);
    close(run('GEOMEAN(4,5,8,7,11,4,3)'), 5.476986969);
    close(run('HARMEAN(4,5,8,7,11,4,3)'), 5.028375962);
    expect(run('GEOMEAN(1,-1)')).toMatchObject({ code: '#NUM!' });
  });

  it('SKEW and KURT', () => {
    close(run('SKEW(3,4,5,2,3,4,5,6,4,7)'), 0.359543071);
    close(run('KURT(3,4,5,2,3,4,5,6,4,7)'), -0.151799637);
    expect(run('SKEW(1,2)')).toMatchObject({ code: '#DIV/0!' });
    expect(run('KURT(1,1,1,1)')).toMatchObject({ code: '#DIV/0!' });
  });

  it('STANDARDIZE, FISHER, FISHERINV', () => {
    close(run('STANDARDIZE(42,40,1.5)'), 1.333333333);
    expect(run('STANDARDIZE(42,40,0)')).toMatchObject({ code: '#NUM!' });
    close(run('FISHER(0.75)'), 0.972955075);
    close(run('FISHERINV(0.972955)'), 0.75);
    expect(run('FISHER(1)')).toMatchObject({ code: '#NUM!' });
  });
});

describe('correlation and regression', () => {
  const run = testHost({
    ...col('A', [2, 3, 9, 1, 8, 7, 5]),
    ...col('B', [6, 5, 11, 7, 5, 4, 4]),
  });

  it('CORREL, PEARSON, RSQ', () => {
    close(run('CORREL({3,2,4,5,6},{9,7,12,15,17})'), 0.997054486);
    close(run('PEARSON({9,7,5,3,1},{10,6,1,5,3})'), 0.699379);
    close(run('RSQ(A1:A7,B1:B7)'), 0.05795);
    expect(run('CORREL({1,2},{1,2,3})')).toMatchObject({ code: '#N/A' });
    expect(run('CORREL({1,1},{2,3})')).toMatchObject({ code: '#DIV/0!' });
  });

  it('COVAR, COVARIANCE.P, COVARIANCE.S', () => {
    close(run('COVAR({3,2,4,5,6},{9,7,12,15,17})'), 5.2);
    close(run('COVARIANCE.P({3,2,4,5,6},{9,7,12,15,17})'), 5.2);
    close(run('COVARIANCE.S({2,4,8},{5,11,12})'), 9.666666667);
  });

  it('SLOPE, INTERCEPT, STEYX, FORECAST', () => {
    close(run('SLOPE(A1:A7,B1:B7)'), 0.305555556);
    close(run('INTERCEPT({2,3,9,1,8},{6,5,11,7,5})'), 0.0483871);
    close(run('INTERCEPT(A1:A7,B1:B7)'), 3.166666667);
    close(run('STEYX(A1:A7,B1:B7)'), 3.305718950);
    close(run('FORECAST(30,{6,7,9,15,21},{20,28,31,38,40})'), 10.607253);
    close(run('FORECAST.LINEAR(30,{6,7,9,15,21},{20,28,31,38,40})'), 10.607253);
    expect(run('SLOPE({1,2},{3,3})')).toMatchObject({ code: '#DIV/0!' });
  });

  it('pairs whole columns over the used rows', () => {
    close(run('SLOPE(A:A,B:B)'), 0.305555556);
  });

  it('TREND, GROWTH, LINEST', () => {
    expect(data(run('LINEST({1,9,5,7},{0,4,2,3})')).map((r) => r.map((v) => Number((v as number).toFixed(9))))).toEqual([[2, 1]]);
    const t = data(run('TREND({1,9,5,7},{0,4,2,3},{5,6})'));
    expect(t[0]![0]).toBeCloseTo(11, 9);
    expect(t[0]![1]).toBeCloseTo(13, 9);
    const g = data(run('GROWTH({33100,47300,69000,102000,150000,220000},{11,12,13,14,15,16},{17;18})'));
    expect(g[0]![0]).toBeCloseTo(320196.7184, 3);
    expect(g[1]![0]).toBeCloseTo(468536.0539, 3);
    // Defaults: known_x is 1..n, new_x is known_x.
    const d = data(run('TREND({2,4,6})'));
    expect(d[0]!.map((v) => Math.round((v as number) * 1e9) / 1e9)).toEqual([2, 4, 6]);
  });

  it('LINEST with statistics', () => {
    const s = data(run('LINEST({1,9,5,7},{0,4,2,3},TRUE,TRUE)'));
    expect(s).toHaveLength(5);
    expect(s[0]![0]).toBeCloseTo(2, 9);
    expect(s[2]![0]).toBeCloseTo(1, 9); // r² of a perfect fit
    expect(s[3]![1]).toBe(2); // degrees of freedom
    const noConst = data(run('LINEST({2,4,6},{1,2,3},FALSE,TRUE)'));
    expect(noConst[0]![0]).toBeCloseTo(2, 9);
    expect(noConst[0]![1]).toBe(0);
    expect(noConst[1]![1]).toMatchObject({ code: '#N/A' });
  });

  it('PROB', () => {
    close(run('PROB({0,1,2,3},{0.2,0.3,0.1,0.4},2)'), 0.1);
    close(run('PROB({0,1,2,3},{0.2,0.3,0.1,0.4},1,3)'), 0.8);
    expect(run('PROB({0,1},{0.2,0.3},1)')).toMatchObject({ code: '#NUM!' });
  });
});

describe('distributions', () => {
  const run = testHost({ A1: 0.5, A2: 1, A3: 1.5 });

  it('normal', () => {
    close(run('NORM.DIST(42,40,1.5,TRUE)'), 0.908788780, 8);
    close(run('NORM.DIST(42,40,1.5,FALSE)'), 0.109340050, 8);
    close(run('NORMDIST(42,40,1.5,TRUE)'), 0.908788780, 8);
    close(run('NORM.INV(0.908789,40,1.5)'), 42.000002, 5);
    close(run('NORMINV(0.908789,40,1.5)'), 42.000002, 5);
    close(run('NORM.S.DIST(1.333333,TRUE)'), 0.908788726, 8);
    close(run('NORM.S.DIST(1.333333,FALSE)'), 0.164010148, 8);
    close(run('NORMSDIST(1)'), 0.841344746068543, 12);
    close(run('NORMSDIST(-6)'), 9.86587645037698e-10, 18);
    close(run('NORM.S.INV(0.908789)'), 1.333335, 5);
    close(run('NORMSINV(0.975)'), 1.959963984540054, 12);
    close(run('NORM.S.INV(1E-10)'), -6.361340902404056, 9);
    expect(run('NORM.INV(0,0,1)')).toMatchObject({ code: '#NUM!' });
    expect(run('NORM.DIST(1,0,0,TRUE)')).toMatchObject({ code: '#NUM!' });
  });

  it('lifts over arrays', () => {
    const r = data(run('NORM.S.DIST(A1:A3,TRUE)'));
    expect(r).toHaveLength(3);
    expect(r[1]![0]).toBeCloseTo(0.841344746, 8);
  });

  it('binomial, Poisson, exponential', () => {
    expect(run('BINOM.DIST(6,10,0.5,FALSE)')).toBeCloseTo(0.205078125, 12);
    expect(run('BINOMDIST(6,10,0.5,TRUE)')).toBeCloseTo(0.828125, 12);
    expect(run('BINOM.DIST(11,10,0.5,TRUE)')).toMatchObject({ code: '#NUM!' });
    close(run('POISSON.DIST(2,5,TRUE)'), 0.124652019, 9);
    close(run('POISSON(2,5,FALSE)'), 0.084224337, 9);
    close(run('EXPON.DIST(0.2,10,TRUE)'), 0.864664717, 9);
    close(run('EXPONDIST(0.2,10,FALSE)'), 1.353352832, 9);
  });

  it('gamma', () => {
    close(run('GAMMA(2.5)'), 1.329340388, 9);
    close(run('GAMMA(-3.75)'), 0.267866129, 9);
    expect(run('GAMMA(5)')).toBe(24);
    expect(run('GAMMA(0)')).toMatchObject({ code: '#NUM!' });
    expect(run('GAMMA(-2)')).toMatchObject({ code: '#NUM!' });
    close(run('GAMMALN(4)'), 1.791759469, 9);
    expect(run('GAMMALN(1)')).toBe(0);
    close(run('GAMMALN(0.5)'), 0.572364943, 9);
    close(run('GAMMALN.PRECISE(4)'), 1.791759469, 9);
    expect(run('GAMMALN(0)')).toMatchObject({ code: '#NUM!' });
  });

  it('Student t', () => {
    close(run('T.DIST(60,1,TRUE)'), 0.994695326, 9);
    close(run('T.DIST(8,3,FALSE)'), 0.00073691, 8);
    close(run('T.DIST.2T(1.959999998,60)'), 0.054644930, 8);
    close(run('T.DIST.RT(1.959999998,60)'), 0.027322465, 8);
    close(run('T.INV(0.75,2)'), 0.816496581, 8);
    close(run('T.INV(0.25,2)'), -0.816496581, 8);
    close(run('T.INV.2T(0.546449,60)'), 0.606533, 6);
    expect(run('T.INV.2T(1,10)')).toBe(0);
    expect(run('T.DIST(1,0,TRUE)')).toMatchObject({ code: '#NUM!' });
  });

  it('chi-squared', () => {
    close(run('CHISQ.DIST(0.5,1,TRUE)'), 0.520499878, 9);
    close(run('CHISQ.DIST(2,3,FALSE)'), 0.207553749, 9);
    close(run('CHISQ.INV(0.93,1)'), 3.283020287, 8);
    close(run('CHISQ.INV(0.6,2)'), 1.832581464, 8);
    expect(run('CHISQ.DIST(-1,2,TRUE)')).toMatchObject({ code: '#NUM!' });
  });

  it('confidence intervals', () => {
    close(run('CONFIDENCE.NORM(0.05,2.5,50)'), 0.692951912, 8);
    close(run('CONFIDENCE(0.05,2.5,50)'), 0.692951912, 8);
    close(run('CONFIDENCE.T(0.05,1,50)'), 0.284196855, 8);
    expect(run('CONFIDENCE.T(0.05,1,1)')).toMatchObject({ code: '#DIV/0!' });
  });
});
