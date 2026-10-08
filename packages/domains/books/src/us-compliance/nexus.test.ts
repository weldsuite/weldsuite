import { describe, it, expect } from 'vitest';
import { getNexusRule } from '../jurisdictions/us/nexus-thresholds';
import { addDays } from './dates';
import { applyCollectionStart, measureNexus, nexusMonitor, type NexusSale } from './nexus';

const TODAY = '2026-10-08';

function rule(code: string, asOf = TODAY) {
  const found = getNexusRule(code, asOf);
  if (!found) throw new Error(`no rule for ${code}`);
  return found;
}

function sale(date: string, amount: number, stateCode: string, over: Partial<NexusSale> = {}): NexusSale {
  return { date, amount, stateCode, marketplaceFacilitated: false, taxable: true, retail: true, ...over };
}

/** `count` sales of `amount`, one a day from `from`. */
function daily(from: string, count: number, amount: number, stateCode: string, over: Partial<NexusSale> = {}): NexusSale[] {
  return Array.from({ length: count }, (_, i) => sale(addDays(from, i), amount, stateCode, over));
}

describe('previous or current calendar year', () => {
  it('stays below with sales under the threshold and counts the first crossing day', () => {
    const below = measureNexus(rule('CA'), [sale('2026-03-01', 100_000, 'CA')], TODAY);
    expect(below.status).toBe('below');
    expect(below.percentOfThreshold).toBe(20);
    expect(below.salesTotal).toBe(100_000);
    expect(below.exceededOn).toBeUndefined();
    expect(below.collectFrom).toBeUndefined();
  });

  it('is exceeded as soon as this year reaches the threshold', () => {
    const result = measureNexus(
      rule('CO'),
      [sale('2026-01-15', 60_000, 'CO'), sale('2026-03-10', 40_000, 'CO'), sale('2026-04-01', 5_000, 'CO')],
      TODAY,
    );
    expect(result.status).toBe('exceeded');
    expect(result.exceededOn).toBe('2026-03-10');
    expect(result.collectFrom).toBe('2026-03-11');
    expect(result.collectFromVerified).toBe(false);
    expect(result.window).toEqual({ from: '2026-01-01', to: TODAY });
    expect(result.salesTotal).toBe(105_000);
    expect(result.percentOfThreshold).toBe(105);
  });

  it('is exceeded when only last year crossed', () => {
    const result = measureNexus(rule('CO'), [sale('2025-06-01', 120_000, 'CO')], '2026-02-01');
    expect(result.status).toBe('exceeded');
    expect(result.exceededOn).toBe('2025-06-01');
    expect(result.window).toEqual({ from: '2025-01-01', to: '2025-12-31' });
    expect(result.periods.map((p) => p.exceeded)).toEqual([true, false]);
  });

  it('keeps the earlier crossing when both years crossed', () => {
    const result = measureNexus(
      rule('CO'),
      [sale('2025-09-01', 100_000, 'CO'), sale('2026-02-01', 100_000, 'CO')],
      TODAY,
    );
    expect(result.exceededOn).toBe('2025-09-01');
  });

  it('forgets a year that is no longer the previous one', () => {
    const result = measureNexus(rule('CO'), [sale('2024-06-01', 900_000, 'CO')], TODAY);
    expect(result.status).toBe('below');
    expect(result.salesTotal).toBe(0);
  });

  it('flags approaching from 80% and not at 79.99%', () => {
    expect(measureNexus(rule('CO'), [sale('2026-02-01', 80_000, 'CO')], TODAY).status).toBe('approaching');
    const just = measureNexus(rule('CO'), [sale('2026-02-01', 79_999, 'CO')], TODAY);
    expect(just.status).toBe('below');
    expect(just.percentOfThreshold).toBe(79.99);
  });

  it('applies the transaction count in an "or" state', () => {
    const only200 = daily('2026-01-01', 200, 10, 'GA');
    const result = measureNexus(rule('GA'), only200, TODAY);
    expect(result.status).toBe('exceeded');
    expect(result.salesTotal).toBe(2_000);
    expect(result.transactionCount).toBe(200);
    expect(result.exceededOn).toBe('2026-07-19');
    const short = measureNexus(rule('GA'), daily('2026-01-01', 199, 10, 'GA'), TODAY);
    expect(short.status).toBe('approaching');
    expect(short.percentOfThreshold).toBe(99.5);
  });
});

describe('previous calendar year only', () => {
  it('ignores this year until it ends, but warns and says when collecting would start', () => {
    const sales = [sale('2026-05-01', 150_000, 'AL'), sale('2026-08-20', 100_000, 'AL')];
    const result = measureNexus(rule('AL'), sales, TODAY);
    expect(result.status).toBe('approaching');
    expect(result.percentOfThreshold).toBe(100);
    expect(result.exceededOn).toBeUndefined();
    expect(result.pending).toEqual({ exceededOn: '2026-08-20', testDate: '2026-12-31', collectFrom: '2027-01-01' });
    expect(result.periods.find((p) => p.role === 'look_ahead')?.label).toBe('2026 to date');
  });

  it('is exceeded once the year that crossed is the previous year', () => {
    const sales = [sale('2026-05-01', 150_000, 'AL'), sale('2026-08-20', 100_000, 'AL')];
    const result = measureNexus(rule('AL', '2027-01-05'), sales, '2027-01-05');
    expect(result.status).toBe('exceeded');
    expect(result.exceededOn).toBe('2026-08-20');
    expect(result.collectFrom).toBe('2027-01-01');
    expect(result.pending).toBeUndefined();
    expect(result.window).toEqual({ from: '2026-01-01', to: '2026-12-31' });
  });

  it('counts only retail sales in Alabama', () => {
    const sales = [sale('2025-03-01', 300_000, 'AL', { retail: false })];
    expect(measureNexus(rule('AL'), sales, TODAY).salesTotal).toBe(0);
  });
});

describe('thresholds that must be exceeded', () => {
  it('needs more than $250,000 in Mississippi', () => {
    const exactly = measureNexus(rule('MS'), [sale('2026-03-01', 250_000, 'MS')], TODAY);
    expect(exactly.status).toBe('approaching');
    expect(exactly.percentOfThreshold).toBe(100);
    const over = measureNexus(rule('MS'), [sale('2026-03-01', 250_000.01, 'MS')], TODAY);
    expect(over.status).toBe('exceeded');
  });
});

describe('rolling 12 months', () => {
  it('includes the day 12 months back minus one and excludes the one before', () => {
    const edge = measureNexus(rule('TX'), [sale('2025-10-09', 500_000, 'TX')], TODAY);
    expect(edge.status).toBe('exceeded');
    expect(edge.window).toEqual({ from: '2025-10-09', to: TODAY });
    const outside = measureNexus(rule('TX'), [sale('2025-10-08', 500_000, 'TX')], TODAY);
    expect(outside.status).toBe('below');
    expect(outside.salesTotal).toBe(0);
  });

  it('dates the crossing and lets old sales roll off', () => {
    const sales = [sale('2025-11-01', 400_000, 'TX'), sale('2026-02-01', 150_000, 'TX')];
    const crossed = measureNexus(rule('TX'), sales, '2026-06-01');
    expect(crossed.status).toBe('exceeded');
    expect(crossed.exceededOn).toBe('2026-02-01');
    const rolledOff = measureNexus(rule('TX'), sales, '2026-12-01');
    expect(rolledOff.status).toBe('below');
    expect(rolledOff.salesTotal).toBe(150_000);
  });

  it('starts the stretch again after a dip below the threshold', () => {
    const sales = [
      sale('2025-01-01', 300_000, 'TX'),
      sale('2025-03-01', 250_000, 'TX'),
      sale('2026-02-01', 300_000, 'TX'),
    ];
    expect(measureNexus(rule('TX'), sales, '2025-06-01').exceededOn).toBe('2025-03-01');
    // The January 2025 sale left the window on 2026-01-01, so the stretch broke and began again.
    expect(measureNexus(rule('TX'), sales, '2026-02-15').exceededOn).toBe('2026-02-01');
    // By March the March 2025 sale has left as well.
    expect(measureNexus(rule('TX'), sales, '2026-03-01').status).toBe('below');
  });

  it('tests at the end of each quarter when the state does so (Illinois)', () => {
    const sales = [sale('2026-09-30', 60_000, 'IL'), sale('2026-10-05', 50_000, 'IL')];
    const result = measureNexus(rule('IL'), sales, TODAY);
    // Last completed quarter ended 2026-09-30 with $60,000; October's sale only warns.
    expect(result.status).toBe('approaching');
    expect(result.periods[0]).toMatchObject({ role: 'binding', from: '2025-10-01', to: '2026-09-30', salesTotal: 60_000 });
    expect(result.periods[1]).toMatchObject({ role: 'look_ahead', salesTotal: 110_000, exceeded: true });
    expect(result.percentOfThreshold).toBe(110);
    expect(result.pending).toEqual({ exceededOn: '2026-10-05', testDate: '2026-12-31', collectFrom: '2027-01-01' });
  });

  it('is exceeded at the quarter end when the quarter-end window passes', () => {
    const sales = [sale('2026-09-30', 100_000, 'IL')];
    const result = measureNexus(rule('IL'), sales, TODAY);
    expect(result.status).toBe('exceeded');
    expect(result.exceededOn).toBe('2026-09-30');
    expect(result.collectFrom).toBe('2026-10-01');
  });

  it('dates a quarter-tested crossing from the start of the passing stretch', () => {
    const sales = [sale('2026-02-10', 100_000, 'IL')];
    // The Q1 test (2026-03-31) is the first to see it, and every later test still does.
    const result = measureNexus(rule('IL'), sales, TODAY);
    expect(result.status).toBe('exceeded');
    expect(result.exceededOn).toBe('2026-03-31');
  });
});

describe('four quarters (New York and Vermont)', () => {
  it('uses New York sales tax quarters (Mar-May, Jun-Aug, Sep-Nov, Dec-Feb)', () => {
    const sales = [
      ...daily('2025-09-01', 101, 5_000, 'NY'), // $505,000 and 101 sales in Sep-Dec 2025
      sale('2026-09-15', 1, 'NY'),
    ];
    const result = measureNexus(rule('NY'), sales, TODAY);
    expect(result.status).toBe('exceeded');
    // Last completed quarter ended 2026-08-31; the window is the four quarters from 2025-09-01.
    expect(result.window).toEqual({ from: '2025-09-01', to: '2026-08-31' });
    expect(result.salesTotal).toBe(505_000);
    expect(result.transactionCount).toBe(101);
    // Tests run at each quarter end: the 2025-11-30 window holds 91 sales ($455,000), the 2026-02-28 window all 101.
    expect(result.exceededOn).toBe('2026-02-28');
    expect(result.collectFrom).toBe('2026-03-01');
  });

  it('needs both tests, and more than each threshold', () => {
    // 101 sales and $500,001: more than both thresholds.
    const both = measureNexus(rule('NY'), [...daily('2025-09-01', 100, 5_000, 'NY'), sale('2025-12-20', 1, 'NY')], TODAY);
    expect(both.status).toBe('exceeded');
    // 101 sales but $494,900: the dollar test is not met.
    const notMoreSales = measureNexus(rule('NY'), daily('2025-09-01', 101, 4_900, 'NY'), TODAY);
    expect(notMoreSales.salesTotal).toBe(494_900);
    expect(notMoreSales.status).toBe('approaching');
    expect(notMoreSales.percentOfThreshold).toBe(98.98);
    // $500,100 but exactly 100 sales: "more than 100" is not met.
    const fewSales = measureNexus(rule('NY'), daily('2025-09-01', 100, 5_001, 'NY'), TODAY);
    expect(fewSales.transactionCount).toBe(100);
    expect(fewSales.status).toBe('approaching');
    // "And" progress follows the test that is further away: 100 of 100 sales is 100%, $500,100 is 100.02%.
    expect(fewSales.percentOfThreshold).toBe(100);
  });

  it('uses calendar quarters in Vermont', () => {
    const result = measureNexus(rule('VT'), [sale('2026-07-01', 100_000, 'VT')], TODAY);
    // Last completed calendar quarter ended 2026-09-30.
    expect(result.status).toBe('exceeded');
    expect(result.window).toEqual({ from: '2025-10-01', to: '2026-09-30' });
    expect(result.exceededOn).toBe('2026-09-30');
  });
});

describe('Connecticut October to September', () => {
  it('needs $100,000 and 200 transactions in the 12 months ending 30 September', () => {
    const sales = daily('2025-10-01', 200, 500, 'CT');
    const result = measureNexus(rule('CT'), sales, TODAY);
    expect(result.status).toBe('exceeded');
    expect(result.window).toEqual({ from: '2025-10-01', to: '2026-09-30' });
    expect(result.exceededOn).toBe('2026-09-30');
    expect(result.collectFrom).toBe('2026-10-01');
  });

  it('is not exceeded with the sales but too few transactions', () => {
    const result = measureNexus(rule('CT'), daily('2025-10-01', 50, 3_000, 'CT'), TODAY);
    expect(result.salesTotal).toBe(150_000);
    expect(result.transactionCount).toBe(50);
    expect(result.status).toBe('below');
    // 150% of the sales test but 25% of the count test: the "and" progress is the lower one.
    expect(result.percentOfThreshold).toBe(25);
  });

  it('leaves out sales before the October start and warns about the year in progress', () => {
    const sales = [...daily('2025-09-01', 30, 2_000, 'CT'), ...daily('2026-10-01', 7, 100, 'CT')];
    const result = measureNexus(rule('CT'), sales, TODAY);
    // 30 sales from 2025-09-01 reach 2025-09-30; only 2025-10-01 onwards count in the binding year.
    expect(result.periods[0]).toMatchObject({ role: 'binding', from: '2025-10-01', to: '2026-09-30', salesTotal: 0 });
    expect(result.periods[1]).toMatchObject({ role: 'look_ahead', from: '2026-10-01', to: TODAY, transactionCount: 7 });
  });

  it('looks back to the previous 30 September before this year\'s test date', () => {
    const result = measureNexus(rule('CT'), daily('2024-10-01', 200, 500, 'CT'), '2025-08-10');
    expect(result.window).toEqual({ from: '2024-10-01', to: '2025-08-10' });
    expect(result.periods[0]).toMatchObject({ role: 'binding', from: '2023-10-01', to: '2024-09-30', salesTotal: 0 });
    expect(result.periods[1]).toMatchObject({ role: 'look_ahead', salesTotal: 100_000 });
    expect(result.status).toBe('approaching');
    expect(result.pending?.testDate).toBe('2025-09-30');
  });
});

describe('what counts', () => {
  it('leaves out marketplace sales in states that exclude them and counts them where they count', () => {
    const marketplace = sale('2026-03-01', 150_000, 'GA', { marketplaceFacilitated: true });
    expect(measureNexus(rule('GA'), [marketplace], TODAY).salesTotal).toBe(0);
    const njSale = { ...marketplace, stateCode: 'NJ' };
    expect(measureNexus(rule('NJ'), [njSale], TODAY).status).toBe('exceeded');
  });

  it('counts only taxable sales in Arkansas and only retail sales in Georgia', () => {
    const sales = [
      sale('2026-03-01', 90_000, 'AR', { taxable: false }),
      sale('2026-03-02', 30_000, 'AR', { taxable: true }),
    ];
    expect(measureNexus(rule('AR'), sales, TODAY).salesTotal).toBe(30_000);
    const resale = sale('2026-03-01', 200_000, 'GA', { retail: false });
    expect(measureNexus(rule('GA'), [resale], TODAY).salesTotal).toBe(0);
  });

  it('counts exempt and resale sales in a gross state', () => {
    const sales = [sale('2026-03-01', 70_000, 'ID', { taxable: false, retail: false })];
    expect(measureNexus(rule('ID'), sales, TODAY).salesTotal).toBe(70_000);
  });

  it('ignores other states and subtracts credit memos without counting them as transactions', () => {
    const sales = [
      sale('2026-03-01', 60_000, 'MD'),
      sale('2026-03-02', 999_999, 'VA'),
      sale('2026-03-05', -10_000, 'MD'),
    ];
    const result = measureNexus(rule('MD'), sales, TODAY);
    expect(result.salesTotal).toBe(50_000);
    expect(result.transactionCount).toBe(1);
    expect(result.percentOfThreshold).toBe(50);
  });

  it('sums cents without floating point drift', () => {
    const sales = Array.from({ length: 10 }, (_, i) => sale(`2026-03-${String(i + 1).padStart(2, '0')}`, 0.1, 'KS'));
    expect(measureNexus(rule('KS'), sales, TODAY).salesTotal).toBe(1);
  });

  it('takes the date part of a timestamp', () => {
    const result = measureNexus(rule('CO'), [sale('2026-03-01T23:59:59.000Z', 100_000, 'CO')], TODAY);
    expect(result.exceededOn).toBe('2026-03-01');
  });

  it('rejects an invalid date or amount', () => {
    expect(() => measureNexus(rule('CO'), [sale('03/01/2026', 1, 'CO')], TODAY)).toThrow(RangeError);
    expect(() => measureNexus(rule('CO'), [sale('2026-03-01', Number.NaN, 'CO')], TODAY)).toThrow(RangeError);
    expect(() => measureNexus(rule('CO'), [], 'soon')).toThrow(RangeError);
  });
});

describe('collection start', () => {
  it('applies the start rules', () => {
    expect(applyCollectionStart({ kind: 'next_transaction' }, '2026-03-10')).toBe('2026-03-11');
    expect(applyCollectionStart({ kind: 'first_day_of_next_month' }, '2026-03-10')).toBe('2026-04-01');
    expect(applyCollectionStart({ kind: 'first_day_of_next_month' }, '2026-12-31')).toBe('2027-01-01');
    expect(applyCollectionStart({ kind: 'days_after', days: 60 }, '2026-10-08')).toBe('2026-12-07');
  });

  it('uses North Carolina\'s 60 days from July 2026', () => {
    const result = measureNexus(rule('NC'), [sale('2026-08-01', 100_000, 'NC')], TODAY);
    expect(result.exceededOn).toBe('2026-08-01');
    expect(result.collectFrom).toBe('2026-09-30');
    expect(result.collectFromVerified).toBe(false);
    expect(result.unverified).toContain('collection_start');
  });
});

describe('states without a sales tax', () => {
  it('measures nothing', () => {
    const result = measureNexus(rule('DE'), [sale('2026-03-01', 5_000_000, 'DE')], TODAY);
    expect(result).toMatchObject({ applicable: false, status: 'below', salesTotal: 0, thresholdSales: null });
  });
});

describe('nexus monitor', () => {
  const sales = [
    sale('2026-03-01', 90_000, 'CO'),
    sale('2026-03-01', 120_000, 'WA'),
    sale('2026-03-01', 150_000, 'MN'),
    sale('2026-03-01', 10_000, 'ID'),
    sale('2026-03-01', 999_999, 'DE'),
  ];

  it('sorts states by how close they are to their threshold', () => {
    const rows = nexusMonitor(['CO', 'WA', 'ID', 'MN', 'DE'], sales, TODAY);
    expect(rows.map((r) => r.stateCode)).toEqual(['MN', 'WA', 'CO', 'ID']);
    expect(rows.map((r) => r.percentOfThreshold)).toEqual([150, 120, 90, 10]);
    expect(rows.find((r) => r.stateCode === 'DE')).toBeUndefined();
  });

  it('says what to do about each state', () => {
    const rows = nexusMonitor(['CO', 'WA', 'ID', 'MN'], sales, TODAY, ['mn']);
    const alert = Object.fromEntries(rows.map((r) => [r.stateCode, r.alert]));
    expect(alert).toEqual({ MN: 'registered', WA: 'register', CO: 'watch', ID: 'ok' });
    expect(rows.find((r) => r.stateCode === 'WA')).toMatchObject({ stateName: 'Washington', registered: false });
    expect(rows.find((r) => r.stateCode === 'MN')?.registered).toBe(true);
  });

  it('measures every monitored state with "all"', () => {
    const rows = nexusMonitor('all', sales, TODAY);
    expect(rows).toHaveLength(48);
    expect(rows.find((r) => r.stateCode === 'PR')?.stateName).toBe('Puerto Rico');
    expect(rows.every((r) => r.applicable)).toBe(true);
  });

  it('uses the rule in force on the date', () => {
    // Illinois had a transaction test until the end of 2025.
    const illinois = daily('2025-01-01', 200, 10, 'IL');
    const before = nexusMonitor(['IL'], illinois, '2025-12-31');
    expect(before[0]).toMatchObject({ status: 'exceeded', thresholdTransactions: 200, transactionCount: 200 });
    const after = nexusMonitor(['IL'], illinois, '2026-01-01');
    expect(after[0]?.thresholdTransactions).toBeNull();
    expect(after[0]?.status).toBe('below');
  });

  it('skips states that have no rule yet on the date', () => {
    // Missouri's rule starts on 1 January 2023.
    expect(nexusMonitor(['IL', 'MO'], [], '2022-12-31').map((r) => r.stateCode)).toEqual(['IL']);
    expect(nexusMonitor(['MO'], [], '2023-01-01').map((r) => r.stateCode)).toEqual(['MO']);
  });

  it('returns nothing without sales states and tolerates duplicates and case', () => {
    expect(nexusMonitor([], sales, TODAY)).toEqual([]);
    const rows = nexusMonitor(['co', 'CO'], sales, TODAY);
    expect(rows).toHaveLength(1);
  });
});
