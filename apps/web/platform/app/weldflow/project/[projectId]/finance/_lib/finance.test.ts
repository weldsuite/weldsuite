import { describe, expect, it } from 'vitest';
import type { FinanceSnapshot, ProjectFinance } from '@weldsuite/app-api-client/domains/project-finance';
import { buildCurve, formatMoney, formatPercent, formatRatio, formatSigned, weekStartMs } from './finance';

const NOW = Date.parse('2026-11-04T10:00:00Z');
const END = Date.parse('2026-12-31T00:00:00Z');

const percent = { spent: 32, committed: 6, planned: 40, earned: 25, forecast: 128 };

function finance(canSeeAmounts: boolean): ProjectFinance {
  return {
    projectId: 'prj_1',
    currency: 'EUR',
    canSeeAmounts,
    asOf: new Date(NOW).toISOString(),
    baseline: null,
    figures: {
      budget: canSeeAmounts ? '1000.00' : null,
      actual: canSeeAmounts ? '320.00' : null,
      committed: canSeeAmounts ? '60.00' : null,
      plannedValue: canSeeAmounts ? '400.00' : null,
      earnedValue: canSeeAmounts ? '250.00' : null,
      forecast: canSeeAmounts ? '1280.00' : null,
      variance: canSeeAmounts ? '280.00' : null,
      cpi: 0.78,
      spi: 0.63,
      forecastSource: 'cpi',
    },
    percent,
    manualForecast: null,
    bySource: { time: null, bill: null, journal: null, purchase_order: null, declaration: null },
    excludedLines: 0,
    rows: [],
  };
}

const snapshot = (week: string): FinanceSnapshot => ({
  week,
  budget: '1000.00',
  plannedValue: '100.00',
  earnedValue: '80.00',
  actualCost: '90.00',
  committed: '0.00',
  forecast: '1100.00',
  percent: { spent: 9, committed: 0, planned: 10, earned: 8, forecast: 110 },
  createdAt: '2026-10-05T03:45:00.000Z',
});

describe('weekStartMs', () => {
  it('finds the Monday of an ISO week', () => {
    expect(new Date(weekStartMs('2026-W45') ?? 0).toISOString()).toBe('2026-11-02T00:00:00.000Z');
    expect(new Date(weekStartMs('2026-W01') ?? 0).toISOString()).toBe('2025-12-29T00:00:00.000Z');
    expect(weekStartMs('nope')).toBeNull();
  });
});

describe('buildCurve', () => {
  it('adds the current figures and a forecast to the end date', () => {
    const curve = buildCurve([snapshot('2026-W40'), snapshot('2026-W44')], finance(true), END, NOW);
    expect(curve.percent).toBe(false);
    expect(curve.budget).toBe(1000);
    expect(curve.points.map((p) => [new Date(p.t).toISOString().slice(0, 10), p.actual ?? null, p.forecast ?? null])).toEqual([
      ['2026-09-28', 90, null],
      ['2026-10-26', 90, null],
      ['2026-11-04', 320, 320],
      ['2026-12-31', null, 1280],
    ]);
  });

  it('skips snapshots that are not past and ends at today without an end date', () => {
    const curve = buildCurve([snapshot('2026-W46')], finance(true), null, NOW);
    expect(curve.points).toHaveLength(1);
    expect(curve.points[0].earned).toBe(250);
  });

  it('draws percentages for a caller without finance rights', () => {
    const curve = buildCurve([snapshot('2026-W40')], finance(false), END, NOW);
    expect(curve.percent).toBe(true);
    expect(curve.budget).toBe(100);
    expect(curve.points[0]).toMatchObject({ planned: 10, earned: 8, actual: 9 });
    expect(curve.points[curve.points.length - 1]).toMatchObject({ t: END, forecast: 128 });
  });
});

describe('formatting', () => {
  it('formats money, signs, ratios and percentages', () => {
    expect(formatMoney('186400.00', 'EUR', 'nl-NL')).toContain('186.400');
    expect(formatMoney(null, 'EUR', 'en-US')).toBe('–');
    expect(formatMoney('12.5', 'not-a-currency', 'en-US', 2)).toBe('12.50');
    expect(formatSigned('10500.00', 'EUR', 'en-US')).toBe('+€10,500');
    expect(formatSigned('0.00', 'EUR', 'en-US')).toBe('€0');
    expect(formatRatio(0.94, 'nl-NL')).toBe('0,94');
    expect(formatRatio(null, 'nl-NL')).toBe('–');
    expect(formatPercent(5.6, 'nl-NL')).toBe('5,6');
  });
});
