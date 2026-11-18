import { describe, expect, it } from 'vitest';
import { en } from '@weldsuite/i18n/locales/en';
import { funnelDropOffRecordingsSearch, recordingsSearchSchema } from '@weldsuite/app-api-client/schemas/weldpanel-query';
import { cohortFilterFromDraft, draftFromCohortFilter, emptyCohortDraft, emptyCondition, summariseCohortFilter } from './cohort-draft';
import { DEFAULT_RANGE, daysInRange, defaultInterval, parseRange, rangesEqual } from './date-range';
import { formatDuration, formatSignedPercent, relativeChange } from './format';
import { recordingsHref, reportBuilderHref } from './links';

describe('date range', () => {
  it('parses what was stored and falls back to 30 days', () => {
    expect(parseRange({ preset: '7d' })).toEqual({ preset: '7d' });
    expect(parseRange({ from: '2026-11-01', to: '2026-11-05' })).toEqual({ from: '2026-11-01', to: '2026-11-05' });
    expect(parseRange({ from: '2026-11-06', to: '2026-11-05' })).toEqual(DEFAULT_RANGE);
    expect(parseRange({ preset: 'forever' })).toEqual(DEFAULT_RANGE);
    expect(parseRange(null)).toEqual(DEFAULT_RANGE);
  });

  it('compares presets and custom ranges', () => {
    expect(rangesEqual({ preset: '7d' }, { preset: '7d' })).toBe(true);
    expect(rangesEqual({ preset: '7d' }, { from: '2026-11-01', to: '2026-11-07' })).toBe(false);
  });

  it('counts days inclusively and picks a chart interval by length', () => {
    expect(daysInRange('2026-11-01', '2026-11-07')).toBe(7);
    expect(defaultInterval({ preset: 'today' })).toBe('hour');
    expect(defaultInterval({ preset: '30d' })).toBe('day');
    expect(defaultInterval({ preset: '90d' })).toBe('week');
    expect(defaultInterval({ preset: '12m' })).toBe('month');
    expect(defaultInterval({ from: '2026-11-01', to: '2026-11-02' })).toBe('hour');
    expect(defaultInterval({ from: '2026-01-01', to: '2026-11-02' })).toBe('month');
  });
});

describe('formatting', () => {
  it('formats durations', () => {
    expect(formatDuration(45)).toBe('45s');
    expect(formatDuration(83)).toBe('1m 23s');
    expect(formatDuration(3720)).toBe('1h 02m');
  });

  it('computes relative change, null when there is nothing to compare', () => {
    expect(relativeChange(120, 100)).toBeCloseTo(0.2);
    expect(relativeChange(5, 0)).toBeNull();
    expect(relativeChange(0, 0)).toBe(0);
    expect(relativeChange(5, null)).toBeNull();
    expect(formatSignedPercent(0.2, 'en')).toBe('+20%');
  });
});

describe('links', () => {
  it('encodes a recordings search the way the router reads it back', () => {
    const search = funnelDropOffRecordingsSearch(
      { kind: 'funnel', projectId: 'wpp_1', dateRange: { preset: '30d' }, steps: [{ event: 'Viewed' }, { event: 'Signed up' }] },
      1,
      'wpp_1',
    );
    const href = recordingsHref(search);
    expect(href.startsWith('/weldpanel/recordings?')).toBe(true);
    const params = new URLSearchParams(href.split('?')[1]);
    expect(JSON.parse(params.get('did') ?? '')).toEqual(['Viewed']);
    expect(JSON.parse(params.get('didNot') ?? '')).toEqual(['Signed up']);
    expect(params.get('range')).toBe('30d');
    expect(recordingsSearchSchema.safeParse({ project: params.get('project'), did: JSON.parse(params.get('did') ?? '[]') }).success).toBe(true);
  });

  it('quotes a string that would read as JSON', () => {
    expect(recordingsHref({ user: '123' })).toBe('/weldpanel/recordings?user=%22123%22');
  });

  it('points a report at its builder', () => {
    expect(reportBuilderHref('funnel', 'wpr_1')).toBe('/weldpanel/funnels?report=wpr_1');
    expect(reportBuilderHref('trends')).toBe('/weldpanel/insights');
  });
});

describe('cohort draft', () => {
  it('is incomplete until every condition is filled in', () => {
    expect(cohortFilterFromDraft(emptyCohortDraft())).toBeNull();
  });

  it('builds a filter from a person property and an event condition', () => {
    const draft = emptyCohortDraft();
    draft.conditions = [
      { type: 'person_property', key: 'plan', operator: 'in', text: 'pro, team' },
      { ...emptyCondition('performed'), event: 'Signed up', withinDays: 14, negate: true } as never,
    ];
    const filter = cohortFilterFromDraft(draft);
    expect(filter?.conditions[0]).toEqual({ type: 'person_property', key: 'plan', operator: 'in', value: ['pro', 'team'] });
    expect(filter?.conditions[1]).toMatchObject({ type: 'performed', event: 'Signed up', withinDays: 14, negate: true });
  });

  it('round-trips through a stored filter', () => {
    const stored = { match: 'any', conditions: [{ type: 'person_property', key: 'plan', operator: 'eq', value: 'pro' }] };
    const draft = draftFromCohortFilter(stored);
    expect(draft).toEqual({ match: 'any', conditions: [{ type: 'person_property', key: 'plan', operator: 'eq', text: 'pro' }] });
    expect(draftFromCohortFilter({ match: 'all', conditions: [] })).toBeNull();
  });

  it('summarises a stored filter', () => {
    const stored = {
      match: 'all',
      conditions: [
        { type: 'person_property', key: 'plan', operator: 'eq', value: 'pro' },
        { type: 'performed', event: 'Upgraded', withinDays: 30, minCount: 1, negate: true, filters: [] },
      ],
    };
    expect(summariseCohortFilter(stored, en.weldpanel.analytics.cohorts.summary, en.weldpanel.analytics.filters)).toBe(
      'All of: plan is pro; did not do Upgraded in 30 days',
    );
  });
});
