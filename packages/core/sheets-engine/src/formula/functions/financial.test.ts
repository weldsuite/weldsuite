import { describe, expect, it } from 'vitest';
import { ERR, matrix } from '../../values';
import { testHost } from '../test-host';

/** Relative closeness; Excel's documentation prints about ten significant digits. */
function near(actual: unknown, expected: number, rel = 1e-9) {
  expect(typeof actual).toBe('number');
  const a = actual as number;
  const tol = Math.max(Math.abs(expected) * rel, 1e-12);
  if (Math.abs(a - expected) > tol) {
    throw new Error(`expected ${a} to be within ${rel} (relative) of ${expected}`);
  }
}

describe('annuities', () => {
  const run = testHost();

  it('PMT (Excel docs examples)', () => {
    near(run('PMT(0.08/12,10,10000)'), -1037.032089);
    near(run('PMT(0.08/12,10,10000,0,1)'), -1030.164327);
    near(run('PMT(0.06/12,18*12,0,50000)'), -129.0811609);
    near(run('PMT(0,10,1000)'), -100);
    expect(run('PMT(0.1,0,1000)')).toEqual(ERR.num);
    expect(run('PMT("x",10,1000)')).toEqual(ERR.value);
    expect(run('PMT({0.05,0.1},10,1000)')).toMatchObject({ kind: 'matrix', rows: 1, cols: 2 });
  });

  it('FV / PV (Excel docs examples)', () => {
    near(run('FV(0.06/12,10,-200,-500,1)'), 2581.403374);
    near(run('FV(0.12/12,12,-1000)'), 12682.50301);
    // Docs: $82,846.25; the reference value is the direct sum of the 35 compounded payments.
    near(run('FV(0.11/12,35,-2000,,1)'), 82846.2463718997, 1e-12);
    near(run('FV(0,12,-100,-1000)'), 2200);
    near(run('PV(0.08/12,12*20,500,,0)'), -59777.14585);
    near(run('PV(0,10,-100)'), 1000);
  });

  it('NPER (Excel docs examples)', () => {
    near(run('NPER(0.12/12,-100,-1000,10000,1)'), 59.67386567);
    near(run('NPER(0.12/12,-100,-1000,10000)'), 60.08212285);
    near(run('NPER(0.12/12,-100,-1000)'), -9.57859404);
    near(run('NPER(0,-100,1000)'), 10);
    near(run('NPER(0.1,100,1000)'), Math.log(0.5) / Math.log(1.1), 1e-12);
    // A payment smaller than the interest never pays the loan off.
    expect(run('NPER(0.1,-50,1000)')).toEqual(ERR.num);
    expect(run('NPER(0,0,1000)')).toEqual(ERR.num);
  });

  it('RATE by Newton–Raphson', () => {
    near(run('RATE(4*12,-200,8000)'), 0.00770147248820165);
    near(run('RATE(4*12,-200,8000)*12'), 0.0924176698584198);
    // Round trip: the rate that reproduces a PMT.
    near(run('RATE(360,PMT(0.005,360,200000),200000)'), 0.005, 1e-12);
    near(run('RATE(10,PMT(0.07,10,-1000,500,1),-1000,500,1)'), 0.07, 1e-12);
    expect(Math.abs(run('RATE(12,-100,1200)') as number)).toBeLessThan(1e-9);
    expect(run('RATE(10,100,1000)')).toEqual(ERR.num);
    expect(run('RATE(0,-100,1000)')).toEqual(ERR.num);
  });

  it('IPMT / PPMT (Excel docs examples)', () => {
    near(run('IPMT(0.1/12,1,3*12,8000)'), -66.66666667);
    near(run('IPMT(0.1,3,3,8000)'), -292.4471299);
    expect(run('IPMT(0.1,1,3,8000,0,1)')).toBe(0);
    near(run('PPMT(0.1/12,1,2*12,2000)'), -75.62318601);
    near(run('PPMT(0.08,10,10,200000)'), -27598.05346);
    // Interest plus principal is the payment, every period.
    near(run('IPMT(0.05,7,20,10000,0,1)+PPMT(0.05,7,20,10000,0,1)'), run('PMT(0.05,20,10000,0,1)') as number, 1e-12);
    expect(run('IPMT(0.1,0,3,8000)')).toEqual(ERR.num);
    expect(run('PPMT(0.1,4,3,8000)')).toEqual(ERR.num);
  });

  it('CUMIPMT / CUMPRINC (Excel docs examples)', () => {
    near(run('CUMIPMT(0.09/12,30*12,125000,13,24,0)'), -11135.23213);
    near(run('CUMIPMT(0.09/12,30*12,125000,1,1,0)'), -937.5);
    near(run('CUMPRINC(0.09/12,30*12,125000,13,24,0)'), -934.1071234);
    near(run('CUMPRINC(0.09/12,30*12,125000,1,1,0)'), -68.27827118);
    // All principal over the full term is the loan.
    near(run('CUMPRINC(0.09/12,360,125000,1,360,1)'), -125000, 1e-12);
    expect(run('CUMIPMT(0.09/12,360,125000,13,24,2)')).toEqual(ERR.num);
    expect(run('CUMIPMT(0.09/12,360,125000,24,13,0)')).toEqual(ERR.num);
    expect(run('CUMIPMT(0,360,125000,1,1,0)')).toEqual(ERR.num);
    expect(run('CUMIPMT(0.01,360,125000,1,361,0)')).toEqual(ERR.num);
  });

  it('ISPMT, EFFECT, NOMINAL, PDURATION, RRI, FVSCHEDULE (Excel docs examples)', () => {
    near(run('ISPMT(0.1/12,1,3*12,8000000)'), -64814.81481);
    near(run('ISPMT(0.1,1,3,8000000)'), -533333.3333);
    expect(run('ISPMT(0.1,1,0,8000000)')).toEqual(ERR.div0);
    near(run('EFFECT(0.0525,4)'), 0.0535426673707584);
    near(run('NOMINAL(0.053543,4)'), 0.052500319868356, 1e-12);
    near(run('NOMINAL(EFFECT(0.07,12),12)'), 0.07, 1e-12);
    expect(run('EFFECT(0,4)')).toEqual(ERR.num);
    expect(run('NOMINAL(0.05,0.5)')).toEqual(ERR.num);
    near(run('PDURATION(0.025,2000,2200)'), 3.859866163);
    near(run('PDURATION(0.025/12,1000,1200)'), 87.60547642);
    expect(run('PDURATION(0,1000,1200)')).toEqual(ERR.num);
    near(run('RRI(96,10000,11000)'), Math.expm1(Math.log(1.1) / 96), 1e-12);
    near(run('RRI(10,1000,FV(0.06,10,0,-1000))'), 0.06, 1e-12);
    expect(run('RRI(0,1000,1200)')).toEqual(ERR.num);
    near(run('FVSCHEDULE(1,{0.09,0.11,0.1})'), 1.33089);
    const h = testHost({ A1: 0.1, A2: null, A3: 0.1, B1: 'x' });
    near(h('FVSCHEDULE(100,A1:A3)'), 121, 1e-12);
    expect(h('FVSCHEDULE(100,B1)')).toEqual(ERR.value);
  });
});

describe('cash flows', () => {
  const run = testHost({
    A1: -10000,
    A2: 2750,
    A3: 4250,
    A4: 3250,
    A5: 2750,
    B1: '=DATE(2008,1,1)',
    B2: '=DATE(2008,3,1)',
    B3: '=DATE(2008,10,30)',
    B4: '=DATE(2009,2,15)',
    B5: '=DATE(2009,4,1)',
    C1: 8000,
    C2: 'skip me',
    C3: 9200,
    C4: 10000,
    C5: 12000,
    C6: 14500,
    D1: 1,
    D2: '=1/0',
  });

  it('NPV (Excel docs examples)', () => {
    near(run('NPV(0.1,-10000,3000,4200,6800)'), 1188.443412);
    near(run('NPV(0.08,C1:C6)'), 41922.06155);
    // Docs: -$3,749.47.
    near(run('NPV(0.08,C1:C6,-9000)-40000'), -3749.46508701557, 1e-12);
    expect(run('NPV(-1,1,2)')).toEqual(ERR.div0);
    expect(run('NPV(0.1,D1:D2)')).toEqual(ERR.div0);
    expect(run('NPV(0.1,"x")')).toEqual(ERR.value);
  });

  it('XNPV / XIRR (Excel docs examples)', () => {
    near(run('XNPV(0.09,A1:A5,B1:B5)'), 2086.647602);
    near(run('XIRR(A1:A5,B1:B5)'), 0.373362535, 1e-8);
    expect(Math.abs(run('XNPV(XIRR(A1:A5,B1:B5),A1:A5,B1:B5)') as number)).toBeLessThan(1e-6);
    expect(run('XNPV(0.09,A1:A5,B1:B4)')).toEqual(ERR.num);
    expect(run('XNPV(0.09,A1:A2,{39448,39400})')).toEqual(ERR.num);
    expect(run('XNPV(0.09,A1:A2,C1:C2)')).toEqual(ERR.value);
    expect(run('XIRR(A2:A5,B2:B5)')).toEqual(ERR.num);
  });

  it('IRR (Excel docs examples)', () => {
    near(run('IRR({-70000,12000,15000,18000,21000})'), -0.0212448482, 1e-8);
    near(run('IRR({-70000,12000,15000,18000,21000,26000})'), 0.0866309480, 1e-8);
    near(run('IRR({-70000,12000,15000},-0.1)'), -0.4435069413, 1e-8);
    expect(Math.abs(run('NPV(IRR({-100,30,40,50}),{30,40,50})-100') as number)).toBeLessThan(1e-9);
    expect(run('IRR({100,200})')).toEqual(ERR.num);
  });

  it('MIRR (Excel docs examples)', () => {
    near(run('MIRR({-120000,39000,30000,21000,37000,46000},0.1,0.12)'), 0.126094130, 1e-8);
    near(run('MIRR({-120000,39000,30000,21000},0.1,0.12)'), -0.048044655, 1e-8);
    near(run('MIRR({-120000,39000,30000,21000,37000,46000},0.1,0.14)'), 0.134759111, 1e-8);
    expect(run('MIRR({100,200},0.1,0.1)')).toEqual(ERR.div0);
  });
});

describe('depreciation', () => {
  const run = testHost();

  it('SLN and SYD (Excel docs examples)', () => {
    expect(run('SLN(30000,7500,10)')).toBe(2250);
    expect(run('SLN(30000,7500,0)')).toEqual(ERR.div0);
    near(run('SYD(30000,7500,10,1)'), 4090.909091);
    near(run('SYD(30000,7500,10,10)'), 409.0909091);
    expect(run('SYD(30000,7500,10,11)')).toEqual(ERR.num);
  });

  it('DB (Excel docs example, rate rounded to 3 decimals)', () => {
    const expected = [186083.33, 259639.42, 176814.44, 120410.64, 81999.64, 55841.76, 15845.1];
    expected.forEach((v, i) => near(run(`DB(1000000,100000,6,${i + 1},7)`), v, 1e-7));
    near(run('DB(10000,1000,5,1)'), 3690);
    expect(run('DB(1000000,100000,6,8,7)')).toEqual(ERR.num);
    expect(run('DB(1000000,100000,6,7)')).toEqual(ERR.num);
    expect(run('DB(1000000,100000,6,1,13)')).toEqual(ERR.num);
    expect(run('DB(0,0,6,1)')).toBe(0);
  });

  it('DDB (Excel docs examples)', () => {
    near(run('DDB(2400,300,10*365,1)'), 1.315068493);
    near(run('DDB(2400,300,10*12,1,2)'), 40);
    near(run('DDB(2400,300,10,1,2)'), 480);
    near(run('DDB(2400,300,10,2,1.5)'), 306);
    near(run('DDB(2400,300,10,10)'), 22.1225472, 1e-8);
    expect(run('DDB(2400,300,10,11)')).toEqual(ERR.num);
    expect(run('DDB(2400,300,10,1,0)')).toEqual(ERR.num);
  });

  it('VDB (Excel docs examples)', () => {
    near(run('VDB(2400,300,10*365,0,1)'), 1.315068493);
    near(run('VDB(2400,300,10*12,0,1)'), 40);
    near(run('VDB(2400,300,10,0,1)'), 480);
    near(run('VDB(2400,300,10*12,6,18)'), 396.3060533);
    near(run('VDB(2400,300,10*12,6,18,1.5)'), 311.8089367);
    near(run('VDB(2400,300,10,0,0.875,1.5)'), 315);
    // Over the whole life everything down to the salvage value is depreciated.
    near(run('VDB(2400,300,10,0,10)'), 2100, 1e-12);
    const ddbTotal = Array.from({ length: 10 }, (_, i) => `DDB(2400,300,10,${i + 1})`).join('+');
    near(run('VDB(2400,300,10,0,10,2,TRUE)'), run(ddbTotal) as number, 1e-12);
    expect(run('VDB(2400,300,10,5,4)')).toEqual(ERR.num);
    expect(run('VDB(2400,300,10,0,11)')).toEqual(ERR.num);
  });
});

describe('element-wise lifting', () => {
  it('lifts scalar financial functions over arrays', () => {
    const run = testHost();
    expect(run('SLN({100,200},0,10)')).toEqual(matrix([[10, 20]]));
  });
});
