import { describe, expect, it } from 'vitest';
import { DEFAULT_PANEL_PRICING, isValidPanelRate, parsePanelPricing } from './pricing';
import { eventGraceLimit, overageBlocks, panelPlanLimits } from './plans';

describe('panelPlanLimits', () => {
  it('has the adopted numbers per plan', () => {
    expect(panelPlanLimits('free')).toEqual({ events: 50_000, recordings: 500, eventRetentionMonths: 12, recordingRetentionDays: 30, replayTier: '30d' });
    expect(panelPlanLimits('business')).toMatchObject({ events: 1_000_000, recordings: 5_000, eventRetentionMonths: 25, recordingRetentionDays: 30 });
    expect(panelPlanLimits('scale')).toMatchObject({ events: 5_000_000, recordings: 25_000, eventRetentionMonths: 25, recordingRetentionDays: 90, replayTier: '90d' });
    expect(panelPlanLimits('enterprise')).toMatchObject({ events: 20_000_000, recordings: 100_000, recordingRetentionDays: 90, replayTier: '90d' });
  });

  it('gives an unknown, missing or oddly written slug the Free numbers', () => {
    expect(panelPlanLimits('mystery')).toEqual(panelPlanLimits('free'));
    expect(panelPlanLimits(null)).toEqual(panelPlanLimits('free'));
    expect(panelPlanLimits(undefined)).toEqual(panelPlanLimits('free'));
    expect(panelPlanLimits(' Scale ')).toEqual(panelPlanLimits('scale'));
  });

  it('lets a plan override the allowances through its features, and ignores nonsense', () => {
    expect(panelPlanLimits('business', { panelEventsPerMonth: 2_500_000.9, panelRecordingsPerMonth: 0 })).toMatchObject({ events: 2_500_000, recordings: 0 });
    expect(panelPlanLimits('business', { panelEventsPerMonth: -1, panelRecordingsPerMonth: 'many' })).toMatchObject({ events: 1_000_000, recordings: 5_000 });
  });

  it('does not hand out a shared object that a caller could change', () => {
    panelPlanLimits('free').events = 1;
    expect(panelPlanLimits('free').events).toBe(50_000);
  });
});

describe('overage blocks', () => {
  it('is zero inside the allowance and one block for the first unit past it', () => {
    expect(overageBlocks(50_000, 50_000, 10_000)).toBe(0);
    expect(overageBlocks(50_001, 50_000, 10_000)).toBe(1);
    expect(overageBlocks(60_000, 50_000, 10_000)).toBe(1);
    expect(overageBlocks(60_001, 50_000, 10_000)).toBe(2);
    expect(overageBlocks(10, 500, 100)).toBe(0);
    expect(overageBlocks(701, 500, 100)).toBe(3);
  });

  it('counts the event grace from the allowance', () => {
    expect(eventGraceLimit(50_000)).toBe(55_000);
    expect(eventGraceLimit(1_000_000)).toBe(1_100_000);
  });
});

describe('weldpanel.pricing', () => {
  it('falls back to the defaults for a missing row or invalid fields, field by field', () => {
    expect(parsePanelPricing(undefined)).toEqual(DEFAULT_PANEL_PRICING);
    expect(parsePanelPricing('x')).toEqual(DEFAULT_PANEL_PRICING);
    expect(parsePanelPricing({ eventsCreditsPer10k: 7, recordingsCreditsPer100: -3 })).toEqual({ eventsCreditsPer10k: 7, recordingsCreditsPer100: DEFAULT_PANEL_PRICING.recordingsCreditsPer100 });
    expect(parsePanelPricing({ eventsCreditsPer10k: 1.5, recordingsCreditsPer100: 4 })).toEqual({ eventsCreditsPer10k: DEFAULT_PANEL_PRICING.eventsCreditsPer10k, recordingsCreditsPer100: 4 });
  });

  it('takes whole positive credits only', () => {
    expect(isValidPanelRate(1)).toBe(true);
    expect(isValidPanelRate(0)).toBe(false);
    expect(isValidPanelRate(2.5)).toBe(false);
    expect(isValidPanelRate(Number.NaN)).toBe(false);
    expect(isValidPanelRate(1_000_000)).toBe(false);
  });
});
