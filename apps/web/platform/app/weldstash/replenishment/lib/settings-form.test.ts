import { describe, expect, it } from 'vitest';
import type { ReplenishmentSettings } from '@weldsuite/app-api-client/schemas/replenishment';
import { formToSettingsInput, makeSettingsFormSchema, settingsToForm } from './settings-form';

const settings: ReplenishmentSettings = {
  id: 'default',
  replenishmentEnabled: true,
  defaultServiceLevel: '0.950',
  defaultReviewPeriodDays: 7,
  lookbackDays: 365,
  defaultLeadTimeDays: 14,
  demandWarehouseId: null,
  historyCutoverDate: null,
  runHourUtc: 2,
};

describe('settingsToForm / formToSettingsInput', () => {
  it('round-trips the defaults', () => {
    const form = settingsToForm(settings);
    expect(form).toMatchObject({ serviceLevelPct: '95', reviewPeriodDays: '7', runHourUtc: '2', demandWarehouseId: '' });
    expect(formToSettingsInput(form)).toEqual({
      ok: true,
      input: {
        replenishmentEnabled: true,
        defaultServiceLevel: 0.95,
        defaultReviewPeriodDays: 7,
        lookbackDays: 365,
        defaultLeadTimeDays: 14,
        demandWarehouseId: null,
        historyCutoverDate: null,
        runHourUtc: 2,
      },
    });
  });

  it('sends the warehouse and the cut-over date when set', () => {
    const result = formToSettingsInput({ ...settingsToForm(settings), demandWarehouseId: 'wh_1', historyCutoverDate: '2026-03-01', serviceLevelPct: '99,5' });
    expect(result.ok && result.input).toMatchObject({ demandWarehouseId: 'wh_1', historyCutoverDate: '2026-03-01', defaultServiceLevel: 0.995 });
  });

  it('refuses values outside the contract ranges', () => {
    const base = settingsToForm(settings);
    expect(formToSettingsInput({ ...base, serviceLevelPct: '40' })).toEqual({ ok: false, errors: { serviceLevelPct: 'invalid' } });
    expect(formToSettingsInput({ ...base, reviewPeriodDays: '0' })).toEqual({ ok: false, errors: { reviewPeriodDays: 'invalid' } });
    expect(formToSettingsInput({ ...base, lookbackDays: '10' })).toEqual({ ok: false, errors: { lookbackDays: 'invalid' } });
    expect(formToSettingsInput({ ...base, defaultLeadTimeDays: '400' })).toEqual({ ok: false, errors: { defaultLeadTimeDays: 'invalid' } });
    expect(formToSettingsInput({ ...base, runHourUtc: '24' })).toEqual({ ok: false, errors: { runHourUtc: 'invalid' } });
    expect(formToSettingsInput({ ...base, historyCutoverDate: '01-03-2026' })).toEqual({ ok: false, errors: { historyCutoverDate: 'invalid' } });
  });

  it('refuses text and empty numbers', () => {
    const base = settingsToForm(settings);
    expect(formToSettingsInput({ ...base, lookbackDays: 'x', serviceLevelPct: '' })).toEqual({
      ok: false,
      errors: { lookbackDays: 'invalid', serviceLevelPct: 'invalid' },
    });
  });
});

describe('makeSettingsFormSchema', () => {
  it('reports each invalid field with the given message', () => {
    const schema = makeSettingsFormSchema('Check this value');
    const result = schema.safeParse({ ...settingsToForm(settings), runHourUtc: '30' });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues).toEqual([expect.objectContaining({ path: ['runHourUtc'], message: 'Check this value' })]);
    expect(schema.safeParse(settingsToForm(settings)).success).toBe(true);
  });
});

describe('formToSettingsInput against the API schema', () => {
  it('maps each value the API schema rejects back to its form field', () => {
    const base = settingsToForm(settings);
    const result = formToSettingsInput({
      ...base,
      serviceLevelPct: '150',
      reviewPeriodDays: '0',
      lookbackDays: '100000',
      defaultLeadTimeDays: '100000',
      historyCutoverDate: 'not-a-date',
      runHourUtc: '30',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(Object.keys(result.errors).sort()).toEqual(
        ['defaultLeadTimeDays', 'historyCutoverDate', 'lookbackDays', 'reviewPeriodDays', 'runHourUtc', 'serviceLevelPct'],
      );
    }
  });
});
