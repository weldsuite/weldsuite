import { describe, expect, it } from 'vitest';
import type { Matrix, Scalar } from '../../values';
import { testHost } from '../test-host';

function data(m: Scalar | Matrix): Scalar[][] {
  if (typeof m === 'object' && m !== null && m.kind === 'matrix') return m.data;
  throw new Error(`expected an array, got ${JSON.stringify(m)}`);
}

function close(v: Scalar | Matrix, expected: number, digits = 6): void {
  expect(typeof v).toBe('number');
  expect(v as number).toBeCloseTo(expected, digits);
}

const NA = { kind: 'error', code: '#N/A' } as const;

describe('sums and products', () => {
  const run = testHost({
    A1: 1,
    A2: 2,
    A3: 'x',
    A4: true,
    A5: '4',
    B1: NA,
    C1: 'apple',
    C2: 'banana',
    C3: 'apple',
    C4: null,
    D1: 10,
    D2: 20,
    D3: 30,
    D4: 40,
  });

  it('SUM ignores text and booleans in ranges but coerces typed values', () => {
    expect(run('SUM(A1:A5)')).toBe(3);
    expect(run('SUM(A1:A5,TRUE,"4")')).toBe(8);
    expect(run('SUM("x")')).toMatchObject({ code: '#VALUE!' });
    expect(run('SUM(A1:A5,B1)')).toMatchObject({ code: '#N/A' });
    expect(run('SUM(A:A)')).toBe(3);
    expect(run('SUM({1,"2",TRUE})')).toBe(1);
    expect(run('SUM(A1:A2*2)')).toBe(6);
  });

  it('SUMSQ and PRODUCT', () => {
    expect(run('SUMSQ(3,4)')).toBe(25);
    expect(run('SUMSQ(A1:A5)')).toBe(5);
    expect(run('PRODUCT(A1:A5,5)')).toBe(10);
    expect(run('PRODUCT(E1:E3)')).toBe(0);
  });

  it('SUMPRODUCT multiplies same-shaped arrays, non-numbers count as 0', () => {
    expect(run('SUMPRODUCT({3,4;8,6;1,9},{2,7;6,7;5,3})')).toBe(156);
    expect(run('SUMPRODUCT(A1:A5,D1:D5)')).toBe(50);
    expect(run('SUMPRODUCT((C1:C4="apple")*D1:D4)')).toBe(40);
    expect(run('SUMPRODUCT(--(C:C="apple"),D:D)')).toBe(40);
    expect(run('SUMPRODUCT({1,2},{1,2,3})')).toMatchObject({ code: '#VALUE!' });
    expect(run('SUMPRODUCT(A1:B1)')).toMatchObject({ code: '#N/A' });
  });

  it('SUMIF with and without a sum range, resized from its top-left cell', () => {
    expect(run('SUMIF(C1:C4,"apple",D1:D4)')).toBe(40);
    expect(run('SUMIF(C1:C4,"apple",D1)')).toBe(40);
    expect(run('SUMIF(D1:D4,">15")')).toBe(90);
    expect(run('SUMIF(C1:C4,"<>apple",D1:D4)')).toBe(60);
    expect(run('SUMIF(C:C,"a*",D:D)')).toBe(40);
    expect(data(run('SUMIF(C1:C4,{"apple","banana"},D1:D4)'))).toEqual([[40, 20]]);
  });

  it('SUMIF propagates errors only at matching cells', () => {
    const r = testHost({ A1: 'a', A2: 'b', B1: 1, B2: NA });
    expect(r('SUMIF(A1:A2,"a",B1:B2)')).toBe(1);
    expect(r('SUMIF(A1:A2,"b",B1:B2)')).toMatchObject({ code: '#N/A' });
  });

  it('SUMIFS over whole columns and with mismatched shapes', () => {
    expect(run('SUMIFS(D1:D4,C1:C4,"apple",D1:D4,">15")')).toBe(30);
    expect(run('SUMIFS(D:D,C:C,"apple")')).toBe(40);
    expect(run('SUMIFS(D1:D4,C1:C3,"apple")')).toMatchObject({ code: '#VALUE!' });
    expect(run('SUMIFS(D1:D4,C1:C4)')).toMatchObject({ code: '#N/A' });
  });

  it('SUMIFS across sheets with whole columns', () => {
    const r = testHost(
      { A1: 'x', A2: 'y', A3: 'x' },
      { sheets: { Data: { A1: 1, A2: 2, A3: 4, A9: 100 } } },
    );
    expect(r('SUMIFS(Data!A:A,A:A,"x")')).toBe(5);
    expect(r('SUMIFS(Data!A:A,A:A,"")')).toBe(100);
  });

  it('SUMX2MY2, SUMX2PY2, SUMXMY2', () => {
    const x = '{2,3,9,1,8,7,5}';
    const y = '{6,5,11,7,5,4,4}';
    expect(run(`SUMX2MY2(${x},${y})`)).toBe(-55);
    expect(run(`SUMX2PY2(${x},${y})`)).toBe(521);
    expect(run(`SUMXMY2(${x},${y})`)).toBe(79);
    expect(run('SUMXMY2({1,2},{1,2,3})')).toMatchObject({ code: '#N/A' });
  });

  it('SERIESSUM', () => {
    close(run('SERIESSUM(PI()/4,0,2,{1,-0.5,0.041666667,-0.001388889})'), 0.707103);
  });
});

describe('rounding', () => {
  const run = testHost({ A1: 1.25, A2: -2.5, A3: 'x' });

  it('ROUND rounds half away from zero, without binary noise', () => {
    expect(run('ROUND(2.15,1)')).toBe(2.2);
    expect(run('ROUND(2.149,1)')).toBe(2.1);
    expect(run('ROUND(-1.475,2)')).toBe(-1.48);
    expect(run('ROUND(2.675,2)')).toBe(2.68);
    expect(run('ROUND(1.005,2)')).toBe(1.01);
    expect(run('ROUND(21.5,-1)')).toBe(20);
    expect(run('ROUND(626.3,-3)')).toBe(1000);
    expect(run('ROUND(1.98,-1)')).toBe(0);
    expect(run('ROUND(-50.55,-2)')).toBe(-100);
    expect(run('ROUND(-0.4,0)')).toBe(0);
    expect(run('ROUND("x",1)')).toMatchObject({ code: '#VALUE!' });
  });

  it('ROUND lifts over a range', () => {
    expect(data(run('ROUND(A1:A2,0)'))).toEqual([[1], [-3]]);
    expect(data(run('ROUND(A1:A3,0)'))[2]).toEqual([{ kind: 'error', code: '#VALUE!' }]);
  });

  it('ROUNDUP, ROUNDDOWN, TRUNC, INT', () => {
    expect(run('ROUNDUP(3.2,0)')).toBe(4);
    expect(run('ROUNDUP(3.14159,3)')).toBe(3.142);
    expect(run('ROUNDUP(-3.14159,1)')).toBe(-3.2);
    expect(run('ROUNDUP(31415.92654,-2)')).toBe(31500);
    expect(run('ROUNDUP(0.1+0.2,1)')).toBe(0.3);
    expect(run('ROUNDDOWN(3.2,0)')).toBe(3);
    expect(run('ROUNDDOWN(-3.14159,1)')).toBe(-3.1);
    expect(run('ROUNDDOWN(31415.92654,-2)')).toBe(31400);
    expect(run('TRUNC(8.9)')).toBe(8);
    expect(run('TRUNC(-8.9)')).toBe(-8);
    expect(run('TRUNC(3.14159,2)')).toBe(3.14);
    expect(run('INT(8.9)')).toBe(8);
    expect(run('INT(-8.9)')).toBe(-9);
  });

  it('MROUND, CEILING, FLOOR', () => {
    expect(run('MROUND(10,3)')).toBe(9);
    expect(run('MROUND(-10,-3)')).toBe(-9);
    expect(run('MROUND(1.3,0.2)')).toBe(1.4);
    expect(run('MROUND(5,-2)')).toMatchObject({ code: '#NUM!' });
    expect(run('CEILING(2.5,1)')).toBe(3);
    expect(run('CEILING(-2.5,-2)')).toBe(-4);
    expect(run('CEILING(-2.5,2)')).toBe(-2);
    expect(run('CEILING(1.5,0.1)')).toBe(1.5);
    expect(run('CEILING(0.234,0.01)')).toBe(0.24);
    expect(run('CEILING(2.5,-1)')).toMatchObject({ code: '#NUM!' });
    expect(run('FLOOR(3.7,2)')).toBe(2);
    expect(run('FLOOR(-2.5,-2)')).toBe(-2);
    expect(run('FLOOR(-2.5,2)')).toBe(-4);
    expect(run('FLOOR(1.58,0.1)')).toBe(1.5);
    expect(run('FLOOR(0.234,0.01)')).toBe(0.23);
    expect(run('FLOOR(2.5,-2)')).toMatchObject({ code: '#NUM!' });
    expect(run('FLOOR(2.5,0)')).toMatchObject({ code: '#DIV/0!' });
  });

  it('CEILING.MATH, CEILING.PRECISE, FLOOR.MATH, FLOOR.PRECISE', () => {
    expect(run('CEILING.MATH(24.3,5)')).toBe(25);
    expect(run('CEILING.MATH(6.7)')).toBe(7);
    expect(run('CEILING.MATH(-8.1,2)')).toBe(-8);
    expect(run('CEILING.MATH(-5.5,2,-1)')).toBe(-6);
    expect(run('CEILING.PRECISE(4.3)')).toBe(5);
    expect(run('CEILING.PRECISE(-4.3)')).toBe(-4);
    expect(run('CEILING.PRECISE(-4.3,-2)')).toBe(-4);
    expect(run('FLOOR.MATH(24.3,5)')).toBe(20);
    expect(run('FLOOR.MATH(6.7)')).toBe(6);
    expect(run('FLOOR.MATH(-8.1,2)')).toBe(-10);
    expect(run('FLOOR.MATH(-5.5,2,-1)')).toBe(-4);
    expect(run('FLOOR.PRECISE(-3.2,-1)')).toBe(-4);
    expect(run('FLOOR.PRECISE(3.2)')).toBe(3);
  });

  it('EVEN and ODD round away from zero', () => {
    expect(run('EVEN(1.5)')).toBe(2);
    expect(run('EVEN(3)')).toBe(4);
    expect(run('EVEN(-1)')).toBe(-2);
    expect(run('EVEN(0)')).toBe(0);
    expect(run('ODD(1.5)')).toBe(3);
    expect(run('ODD(3)')).toBe(3);
    expect(run('ODD(2)')).toBe(3);
    expect(run('ODD(-1)')).toBe(-1);
    expect(run('ODD(-2)')).toBe(-3);
    expect(run('ODD(0)')).toBe(1);
  });
});

describe('arithmetic', () => {
  const run = testHost({ A1: -4, A2: 9, A3: '16' });

  it('ABS, SIGN, SQRT lift over ranges and coerce numeric text', () => {
    expect(run('ABS(-3)')).toBe(3);
    expect(run('ABS("-3")')).toBe(3);
    expect(run('ABS(TRUE)')).toBe(1);
    expect(data(run('ABS(A1:A3)'))).toEqual([[4], [9], [16]]);
    expect(run('SIGN(-0.5)')).toBe(-1);
    expect(run('SIGN(0)')).toBe(0);
    expect(run('SQRT(16)')).toBe(4);
    expect(run('SQRT(-1)')).toMatchObject({ code: '#NUM!' });
    expect(data(run('SQRT(A1:A3)'))).toEqual([[{ kind: 'error', code: '#NUM!' }], [3], [4]]);
    close(run('SQRTPI(2)'), 2.506628275);
  });

  it('MOD takes the divisor sign, QUOTIENT truncates', () => {
    expect(run('MOD(3,2)')).toBe(1);
    expect(run('MOD(-3,2)')).toBe(1);
    expect(run('MOD(3,-2)')).toBe(-1);
    expect(run('MOD(-3,-2)')).toBe(-1);
    expect(run('MOD(5.5,1)')).toBe(0.5);
    expect(run('MOD(1,0)')).toMatchObject({ code: '#DIV/0!' });
    expect(run('QUOTIENT(5,2)')).toBe(2);
    expect(run('QUOTIENT(-10,3)')).toBe(-3);
    expect(run('QUOTIENT(1,0)')).toMatchObject({ code: '#DIV/0!' });
  });

  it('POWER, EXP, LN, LOG, LOG10', () => {
    expect(run('POWER(5,2)')).toBe(25);
    close(run('POWER(98.6,3.2)'), 2401077.222, 2);
    expect(run('POWER(0,0)')).toMatchObject({ code: '#NUM!' });
    expect(run('POWER(0,-1)')).toMatchObject({ code: '#DIV/0!' });
    expect(run('POWER(-8,1/3)')).toMatchObject({ code: '#NUM!' });
    close(run('EXP(1)'), Math.E, 12);
    expect(run('EXP(1000)')).toMatchObject({ code: '#NUM!' });
    expect(run('LN(1)')).toBe(0);
    expect(run('LN(0)')).toMatchObject({ code: '#NUM!' });
    expect(run('LOG(1000)')).toBe(3);
    expect(run('LOG(8,2)')).toBe(3);
    expect(run('LOG(125,5)')).toBe(3);
    close(run('LOG(86,2.7182818)'), 4.4543473625);
    expect(run('LOG(10,1)')).toMatchObject({ code: '#DIV/0!' });
    expect(run('LOG10(100000)')).toBe(5);
    expect(run('PI()')).toBe(Math.PI);
  });
});

describe('random', () => {
  it('uses the host random source', () => {
    const run = testHost({}, { random: () => 0.25 });
    expect(run('RAND()')).toBe(0.25);
    expect(run('RANDBETWEEN(1,8)')).toBe(3);
    expect(run('RANDBETWEEN(5,1)')).toMatchObject({ code: '#NUM!' });
    expect(data(run('RANDARRAY(2,3)'))).toEqual([
      [0.25, 0.25, 0.25],
      [0.25, 0.25, 0.25],
    ]);
    expect(data(run('RANDARRAY(1,2,10,20,TRUE)'))).toEqual([[12, 12]]);
    expect(run('RANDARRAY(2,2,5,1)')).toMatchObject({ code: '#VALUE!' });
    expect(run('RANDARRAY(0)')).toMatchObject({ code: '#CALC!' });
    expect(run('RANDARRAY(1,1,1.5,3,TRUE)')).toMatchObject({ code: '#VALUE!' });
  });
});

describe('number theory and combinatorics', () => {
  const run = testHost({ A1: 24, A2: 36 });

  it('GCD and LCM', () => {
    expect(run('GCD(5,2)')).toBe(1);
    expect(run('GCD(A1:A2)')).toBe(12);
    expect(run('GCD(24.9,36)')).toBe(12);
    expect(run('GCD(0,0)')).toBe(0);
    expect(run('GCD(-1,2)')).toMatchObject({ code: '#NUM!' });
    expect(run('LCM(A1:A2)')).toBe(72);
    expect(run('LCM(5,0)')).toBe(0);
  });

  it('FACT, FACTDOUBLE', () => {
    expect(run('FACT(5)')).toBe(120);
    expect(run('FACT(1.9)')).toBe(1);
    expect(run('FACT(0)')).toBe(1);
    expect(run('FACT(-1)')).toMatchObject({ code: '#NUM!' });
    expect(run('FACT(171)')).toMatchObject({ code: '#NUM!' });
    expect(run('FACTDOUBLE(6)')).toBe(48);
    expect(run('FACTDOUBLE(7)')).toBe(105);
    expect(run('FACTDOUBLE(-1)')).toBe(1);
    expect(run('FACTDOUBLE(-2)')).toMatchObject({ code: '#NUM!' });
  });

  it('COMBIN, COMBINA, PERMUT, PERMUTATIONA, MULTINOMIAL', () => {
    expect(run('COMBIN(8,2)')).toBe(28);
    expect(run('COMBIN(2,8)')).toMatchObject({ code: '#NUM!' });
    expect(run('COMBINA(4,3)')).toBe(20);
    expect(run('COMBINA(10,3)')).toBe(220);
    expect(run('PERMUT(100,3)')).toBe(970200);
    expect(run('PERMUT(3,2)')).toBe(6);
    expect(run('PERMUTATIONA(3,2)')).toBe(9);
    expect(run('PERMUTATIONA(2,2)')).toBe(4);
    expect(run('MULTINOMIAL(2,3,4)')).toBe(1260);
    expect(run('MULTINOMIAL(-1)')).toMatchObject({ code: '#NUM!' });
  });
});

describe('trigonometry', () => {
  const run = testHost();

  it('basic and inverse functions', () => {
    close(run('SIN(PI()/2)'), 1, 12);
    close(run('COS(PI())'), -1, 12);
    close(run('TAN(PI()/4)'), 1, 12);
    close(run('ASIN(-0.5)'), -0.523598776);
    close(run('ACOS(-0.5)'), 2.094395102);
    expect(run('ASIN(2)')).toMatchObject({ code: '#NUM!' });
    close(run('ATAN(1)'), 0.785398163);
    close(run('ATAN2(1,1)'), 0.785398163);
    close(run('ATAN2(-1,-1)'), -2.35619449);
    expect(run('ATAN2(0,0)')).toMatchObject({ code: '#DIV/0!' });
    expect(run('DEGREES(PI())')).toBe(180);
    close(run('RADIANS(270)'), 4.712389, 6);
  });

  it('hyperbolic functions', () => {
    close(run('SINH(1)'), 1.175201194);
    close(run('COSH(4)'), 27.30823284);
    close(run('TANH(0.5)'), 0.462117157);
    close(run('ASINH(-2.5)'), -1.647231146);
    close(run('ACOSH(10)'), 2.993222846);
    expect(run('ACOSH(0.5)')).toMatchObject({ code: '#NUM!' });
    close(run('ATANH(0.76159416)'), 1.00000001, 7);
    expect(run('ATANH(1)')).toMatchObject({ code: '#NUM!' });
  });

  it('reciprocal functions', () => {
    close(run('COT(30)'), -0.156119952);
    expect(run('COT(0)')).toMatchObject({ code: '#DIV/0!' });
    close(run('COTH(2)'), 1.037314721);
    close(run('CSC(15)'), 1.537780562);
    expect(run('CSC(0)')).toMatchObject({ code: '#DIV/0!' });
    close(run('CSCH(1.5)'), 0.469642441);
    close(run('SEC(45)'), 1.903594407);
    close(run('SECH(1)'), 0.648054274);
    close(run('ACOT(2)'), 0.463647609);
    close(run('ACOTH(6)'), 0.168236118);
    expect(run('ACOTH(0.5)')).toMatchObject({ code: '#NUM!' });
    expect(run('COT(2^27)')).toMatchObject({ code: '#NUM!' });
  });
});

describe('SUBTOTAL and AGGREGATE', () => {
  const run = testHost({ A1: 120, A2: 10, A3: 150, A4: 23, A5: 'x', B1: 1, B2: NA, B3: 3 });

  it('SUBTOTAL dispatches on the function number', () => {
    expect(run('SUBTOTAL(9,A1:A5)')).toBe(303);
    expect(run('SUBTOTAL(109,A1:A5)')).toBe(303);
    expect(run('SUBTOTAL(1,A1:A5)')).toBe(75.75);
    expect(run('SUBTOTAL(2,A1:A5)')).toBe(4);
    expect(run('SUBTOTAL(3,A1:A5)')).toBe(5);
    expect(run('SUBTOTAL(4,A1:A5)')).toBe(150);
    expect(run('SUBTOTAL(5,A1:A5)')).toBe(10);
    expect(run('SUBTOTAL(6,A2,A4)')).toBe(230);
    close(run('SUBTOTAL(7,A1:A5)'), 69.70592992);
    close(run('SUBTOTAL(8,A1:A5)'), 60.36710611);
    close(run('SUBTOTAL(10,A1:A5)'), 4858.916667);
    close(run('SUBTOTAL(11,A1:A5)'), 3644.1875);
    expect(run('SUBTOTAL(12,A1:A5)')).toMatchObject({ code: '#VALUE!' });
    expect(run('SUBTOTAL(9,B1:B3)')).toMatchObject({ code: '#N/A' });
  });

  it('AGGREGATE can ignore errors', () => {
    expect(run('AGGREGATE(9,6,B1:B3)')).toBe(4);
    expect(run('AGGREGATE(9,4,B1:B3)')).toMatchObject({ code: '#N/A' });
    expect(run('AGGREGATE(4,6,A1:A5,B1:B3)')).toBe(150);
    expect(run('AGGREGATE(14,6,B1:B3,1)')).toBe(3);
    expect(run('AGGREGATE(15,6,A1:A4/(A1:A4>20),1)')).toBe(23);
    expect(run('AGGREGATE(12,6,A1:A4)')).toBe(71.5);
    expect(run('AGGREGATE(16,0,A1:A4,0.5)')).toBe(71.5);
    expect(run('AGGREGATE(14,6,B1:B3)')).toMatchObject({ code: '#VALUE!' });
    expect(run('AGGREGATE(20,6,B1:B3)')).toMatchObject({ code: '#VALUE!' });
    expect(run('AGGREGATE(9,8,B1:B3)')).toMatchObject({ code: '#VALUE!' });
  });

  it('skip rows hidden by a filter, and by hand where asked', () => {
    // Row 2 (A2 = 10) filtered out, row 4 (A4 = 23) hidden by hand.
    const hidden = testHost({ A1: 120, A2: 10, A3: 150, A4: 23 }, { filteredRows: [1], hiddenRows: [3] });
    expect(hidden('SUBTOTAL(9,A1:A4)')).toBe(293);
    expect(hidden('SUBTOTAL(109,A1:A4)')).toBe(270);
    expect(hidden('SUBTOTAL(2,A1:A4)')).toBe(3);
    expect(hidden('AGGREGATE(9,5,A1:A4)')).toBe(270);
    expect(hidden('AGGREGATE(9,4,A1:A4)')).toBe(303);
    expect(hidden('SUM(A1:A4)')).toBe(303);
  });

  it('skip cells that hold a SUBTOTAL themselves', () => {
    const nested = testHost({ A1: 5, A2: 7, A3: '=SUBTOTAL(9,A1:A2)', A4: 1 });
    expect(nested('SUBTOTAL(9,A1:A4)')).toBe(13);
    expect(nested('AGGREGATE(9,4,A1:A4)')).toBe(25);
  });
});

describe('matrices', () => {
  const run = testHost({ A1: 1, B1: 3, A2: 7, B2: 2, C1: 'x' });

  it('MMULT', () => {
    expect(data(run('MMULT({1,3;7,2},{2,0;0,2})'))).toEqual([
      [2, 6],
      [14, 4],
    ]);
    expect(data(run('MMULT(A1:B2,{2,0;0,2})'))).toEqual([
      [2, 6],
      [14, 4],
    ]);
    expect(run('MMULT({1,2},{1,2})')).toMatchObject({ code: '#VALUE!' });
    expect(run('MMULT(A1:C1,{1;2;3})')).toMatchObject({ code: '#VALUE!' });
    expect(run('MMULT({1,2},{3;4})')).toBe(11);
  });

  it('MDETERM', () => {
    close(run('MDETERM({3,6,1;1,1,0;3,10,2})'), 1, 10);
    close(run('MDETERM({1,3,8,5;1,3,6,1;1,1,1,0;7,3,10,2})'), 88, 9);
    close(run('MDETERM({3,6;1,1})'), -3, 12);
    expect(run('MDETERM({1,2,3})')).toMatchObject({ code: '#VALUE!' });
  });

  it('MINVERSE and MUNIT', () => {
    const inv = data(run('MINVERSE({4,-1;2,0})'));
    expect(inv[0]![0]).toBeCloseTo(0, 12);
    expect(inv[0]![1]).toBeCloseTo(0.5, 12);
    expect(inv[1]![0]).toBeCloseTo(-1, 12);
    expect(inv[1]![1]).toBeCloseTo(2, 12);
    expect(run('MINVERSE({1,2;2,4})')).toMatchObject({ code: '#NUM!' });
    expect(data(run('MUNIT(3)'))).toEqual([
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    ]);
    expect(run('MUNIT(0)')).toMatchObject({ code: '#VALUE!' });
  });
});

describe('numeral systems', () => {
  const run = testHost();

  it('ROMAN in all five forms', () => {
    expect(run('ROMAN(499)')).toBe('CDXCIX');
    expect(run('ROMAN(499,0)')).toBe('CDXCIX');
    expect(run('ROMAN(499,1)')).toBe('LDVLIV');
    expect(run('ROMAN(499,2)')).toBe('XDIX');
    expect(run('ROMAN(499,3)')).toBe('VDIV');
    expect(run('ROMAN(499,4)')).toBe('ID');
    expect(run('ROMAN(499,FALSE)')).toBe('ID');
    expect(run('ROMAN(1994)')).toBe('MCMXCIV');
    expect(run('ROMAN(3999)')).toBe('MMMCMXCIX');
    expect(run('ROMAN(0)')).toBe('');
    expect(run('ROMAN(4000)')).toMatchObject({ code: '#VALUE!' });
    expect(run('ROMAN(-1)')).toMatchObject({ code: '#VALUE!' });
  });

  it('ARABIC', () => {
    expect(run('ARABIC("LVII")')).toBe(57);
    expect(run('ARABIC("mcmxii")')).toBe(1912);
    expect(run('ARABIC("-MMXI")')).toBe(-2011);
    expect(run('ARABIC("")')).toBe(0);
    expect(run('ARABIC("ABC")')).toMatchObject({ code: '#VALUE!' });
  });

  it('BASE and DECIMAL', () => {
    expect(run('BASE(7,2)')).toBe('111');
    expect(run('BASE(100,16)')).toBe('64');
    expect(run('BASE(15,2,10)')).toBe('0000001111');
    expect(run('BASE(-1,2)')).toMatchObject({ code: '#NUM!' });
    expect(run('BASE(5,37)')).toMatchObject({ code: '#NUM!' });
    expect(run('DECIMAL("FF",16)')).toBe(255);
    expect(run('DECIMAL(111,2)')).toBe(7);
    expect(run('DECIMAL("zap",36)')).toBe(45745);
    expect(run('DECIMAL("12",2)')).toMatchObject({ code: '#NUM!' });
    expect(run('DECIMAL("1",40)')).toMatchObject({ code: '#NUM!' });
  });
});
