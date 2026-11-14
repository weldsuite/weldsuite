import { describe, expect, it } from 'vitest';
import type { PanelUsageDto } from '@weldsuite/app-api-client/schemas/weldpanel-objects';
import { bannerKey, meterTone, usageBanner, usageRatio } from './usage';

const meter = (used: number, allowance: number) => ({ used, allowance, blocksCharged: 0, creditsCharged: 0 });
const usage = (overrides: Partial<PanelUsageDto> = {}): PanelUsageDto => ({
  month: '2026-11',
  planSlug: 'business',
  events: meter(100, 1000),
  recordings: meter(10, 100),
  quota: 'ok',
  retention: { eventsMonths: 25, recordingsDays: 30, favoritesMonths: 13 },
  projects: [],
  ...overrides,
});

describe('usage', () => {
  it('reads how full a meter is', () => {
    expect(usageRatio(meter(500, 1000))).toBe(0.5);
    expect(usageRatio(meter(5, 0))).toBe(0);
    expect(meterTone(0.79)).toBe('ok');
    expect(meterTone(0.8)).toBe('warning');
    expect(meterTone(1)).toBe('over');
  });

  it('shows no banner while all is well', () => {
    expect(usageBanner(usage())).toBeNull();
  });

  it('warns at 80% and says which meter', () => {
    expect(usageBanner(usage({ events: meter(850, 1000) }))).toEqual({ kind: 'warning', what: 'events', ratio: 0.85 });
    expect(usageBanner(usage({ events: meter(850, 1000), recordings: meter(90, 100) }))).toMatchObject({ kind: 'warning', what: 'both' });
  });

  it('says the allowance is reached at 100%', () => {
    expect(usageBanner(usage({ recordings: meter(100, 100) }))).toEqual({ kind: 'reached', what: 'recordings' });
  });

  it('puts dropped data before everything else', () => {
    expect(usageBanner(usage({ quota: 'events_blocked', events: meter(2000, 1000) }))).toEqual({ kind: 'events_blocked' });
    expect(usageBanner(usage({ quota: 'replay_blocked' }))).toEqual({ kind: 'replay_blocked' });
  });

  it('keys a dismissal to the month and the message', () => {
    expect(bannerKey({ kind: 'reached', what: 'events' }, '2026-11')).not.toBe(bannerKey({ kind: 'reached', what: 'both' }, '2026-11'));
    expect(bannerKey({ kind: 'events_blocked' }, '2026-11')).not.toBe(bannerKey({ kind: 'events_blocked' }, '2026-12'));
  });
});
