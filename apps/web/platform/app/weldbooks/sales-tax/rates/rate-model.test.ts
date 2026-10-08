import { describe, expect, it } from 'vitest';
import { en } from '@weldsuite/i18n/locales/en';
import type { JurisdictionRate } from '@/lib/api/domains/weldbooks-sales-tax-setup';
import {
  dayBefore,
  emptyJurisdictionForm,
  emptyRateForm,
  makeJurisdictionSchema,
  makeRateSchema,
  openEndedRateBefore,
  parsePercent,
  rateOn,
  rateToForm,
  sortJurisdictions,
  toCreateJurisdictionInput,
  toCreateRateInput,
  toUpdateJurisdictionInput,
  toUpdateRateInput,
} from './rate-model';

const texts = en.weldbooksUs.salesTax.setup.validation;

function rate(overrides: Partial<JurisdictionRate>): JurisdictionRate {
  return { id: 'r', jurisdictionId: 'stj_1', rate: '6.2500', effectiveFrom: '2020-01-01', effectiveTo: null, ...overrides };
}

describe('parsePercent', () => {
  it('reads percentages with a dot or a comma and up to four decimals', () => {
    expect(parsePercent('6.25')).toBe(6.25);
    expect(parsePercent('6,25')).toBe(6.25);
    expect(parsePercent(' 8.25 % ')).toBe(8.25);
    expect(parsePercent('0')).toBe(0);
    expect(parsePercent('100')).toBe(100);
    expect(parsePercent('0.0625')).toBe(0.0625);
  });

  it('refuses everything else', () => {
    for (const bad of ['', 'abc', '-1', '100.5', '101', '6.12345', '6..5', '1e2']) {
      expect(parsePercent(bad), bad).toBeNull();
    }
  });
});

describe('dayBefore', () => {
  it('steps back one day across month and year ends', () => {
    expect(dayBefore('2027-01-01')).toBe('2026-12-31');
    expect(dayBefore('2026-03-01')).toBe('2026-02-28');
    expect(dayBefore('2028-03-01')).toBe('2028-02-29');
  });
});

describe('close previous', () => {
  const rates = [
    rate({ id: 'new', rate: '6.5000', effectiveFrom: '2026-07-01' }),
    rate({ id: 'old', rate: '6.2500', effectiveFrom: '2020-01-01', effectiveTo: null }),
    rate({ id: 'older', rate: '6.0000', effectiveFrom: '2010-01-01', effectiveTo: '2019-12-31' }),
  ];

  it('finds the open-ended rate that started before the new one', () => {
    expect(openEndedRateBefore(rates.slice(1), '2026-07-01')?.id).toBe('old');
    expect(openEndedRateBefore(rates, '2026-07-01')?.id).toBe('old');
  });

  it('finds nothing when every rate has ended or starts later', () => {
    expect(openEndedRateBefore([rate({ effectiveTo: '2025-12-31' })], '2026-07-01')).toBeUndefined();
    expect(openEndedRateBefore([rate({ effectiveFrom: '2026-07-01' })], '2026-07-01')).toBeUndefined();
    expect(openEndedRateBefore(rates, 'soon')).toBeUndefined();
  });

  it('sends closePrevious only when it was chosen', () => {
    const form = { ...emptyRateForm('2026-07-01'), rate: '6.5' };
    expect(toCreateRateInput({ ...form, closePrevious: true })).toEqual({
      rate: 6.5,
      effectiveFrom: '2026-07-01',
      closePrevious: true,
    });
    expect(toCreateRateInput({ ...form, closePrevious: false })).toEqual({ rate: 6.5, effectiveFrom: '2026-07-01' });
  });

  it('sends the end date when there is one', () => {
    expect(toCreateRateInput({ ...emptyRateForm('2026-07-01'), rate: '7', effectiveTo: '2026-12-31', closePrevious: true })).toEqual({
      rate: 7,
      effectiveFrom: '2026-07-01',
      effectiveTo: '2026-12-31',
      closePrevious: true,
    });
  });

  it('clears an end date with null when a rate is edited', () => {
    const edited = toUpdateRateInput({ ...rateToForm(rate({ effectiveTo: '2026-12-31' })), effectiveTo: '' });
    expect(edited).toEqual({ rate: 6.25, effectiveFrom: '2020-01-01', effectiveTo: null });
  });
});

describe('rate schema', () => {
  const schema = makeRateSchema(texts);
  const valid = { rate: '6.25', effectiveFrom: '2026-01-01', effectiveTo: '', closePrevious: false };

  it('accepts a rate and a start date', () => {
    expect(schema.safeParse(valid).success).toBe(true);
  });

  it('needs a rate that is a percentage', () => {
    expect(schema.safeParse({ ...valid, rate: '' }).success).toBe(false);
    const bad = schema.safeParse({ ...valid, rate: '120' });
    expect(bad.success ? '' : bad.error.issues[0].message).toBe(texts.percent);
  });

  it('needs a start date, and an end date that is not before it', () => {
    expect(schema.safeParse({ ...valid, effectiveFrom: '' }).success).toBe(false);
    const bad = schema.safeParse({ ...valid, effectiveTo: '2025-12-31' });
    expect(bad.success ? '' : bad.error.issues[0].message).toBe(texts.endBeforeStart);
  });
});

describe('rateOn', () => {
  it('picks the rate in force on a day', () => {
    const rates = [
      rate({ id: 'a', effectiveFrom: '2020-01-01', effectiveTo: '2026-06-30' }),
      rate({ id: 'b', rate: '6.5000', effectiveFrom: '2026-07-01' }),
    ];
    expect(rateOn(rates, '2026-06-30')?.id).toBe('a');
    expect(rateOn(rates, '2026-07-01')?.id).toBe('b');
    expect(rateOn(rates, '2019-12-31')).toBeUndefined();
  });
});

describe('jurisdiction form', () => {
  const create = makeJurisdictionSchema(texts, 'create');
  const edit = makeJurisdictionSchema(texts, 'edit');

  it('needs a first rate and its start date when adding', () => {
    const values = { ...emptyJurisdictionForm(), name: 'Texas' };
    expect(create.safeParse(values).success).toBe(false);
    expect(create.safeParse({ ...values, rate: '6.25', effectiveFrom: '2026-01-01' }).success).toBe(true);
    expect(create.safeParse({ ...values, rate: '6.25.1', effectiveFrom: '2026-01-01' }).success).toBe(false);
  });

  it('does not ask for a rate when editing', () => {
    expect(edit.safeParse({ ...emptyJurisdictionForm(), name: 'Texas' }).success).toBe(true);
    expect(edit.safeParse({ ...emptyJurisdictionForm(), name: '  ' }).success).toBe(false);
  });

  it('sends the first rate with the jurisdiction', () => {
    const values = {
      ...emptyJurisdictionForm('2026-01-01'),
      level: 'county' as const,
      name: ' Travis County ',
      rate: '0.5',
      code: '48453',
    };
    expect(toCreateJurisdictionInput('sta_1', values)).toEqual({
      agencyId: 'sta_1',
      level: 'county',
      name: 'Travis County',
      isActive: true,
      code: '48453',
      rate: { rate: 0.5, effectiveFrom: '2026-01-01' },
    });
  });

  it('clears a code with null when editing', () => {
    expect(toUpdateJurisdictionInput({ ...emptyJurisdictionForm(), name: 'Texas', code: '' })).toEqual({
      level: 'state',
      name: 'Texas',
      code: null,
      reportingCode: null,
      isActive: true,
    });
  });

  it('lists state, county, city, then district', () => {
    const sorted = sortJurisdictions([
      { level: 'district' as const, name: 'A' },
      { level: 'city' as const, name: 'B' },
      { level: 'state' as const, name: 'Z' },
      { level: 'county' as const, name: 'C' },
      { level: 'county' as const, name: 'A' },
    ]);
    expect(sorted.map((j) => `${j.level}:${j.name}`)).toEqual(['state:Z', 'county:A', 'county:C', 'city:B', 'district:A']);
  });
});
