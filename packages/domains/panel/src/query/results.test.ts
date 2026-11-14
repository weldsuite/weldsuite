/**
 * Basin rows in, result shapes out, per kind; plus the time helpers and the
 * checks that keep the contract copies (schema patterns, DTOs) in step with
 * the collector and the Durable Object.
 */

import { describe, expect, it } from 'vitest';
import {
  PANEL_CUSTOM_EVENT_NAME,
  PANEL_PROPERTY_KEY,
  panelQuerySpecSchema,
  recordingsSearchSchema,
  recordingsSearchToSpec,
  sessionsSpecToRecordingsSearch,
  funnelDropOffRecordingsSearch,
  type PanelQuerySpec,
  type PanelQueryResult,
} from '@weldsuite/app-api-client/schemas/weldpanel-query';
import type { PanelLiveSessionDto, PanelPersonDto } from '@weldsuite/app-api-client/schemas/weldpanel-objects';
import { CUSTOM_EVENT_NAME, PROPERTY_KEY } from '../wire';
import type { PanelLiveSession, PanelPerson } from '../project-object';
import {
  bucketLabels,
  lexiconFromRows,
  normalizeRows,
  requiredPanelPermissions,
  resolveRange,
  runPanelQuery,
  specCacheKey,
  stableStringify,
  type PanelQueryContext,
  type PanelSqlQuery,
  type RawRow,
} from './index';

const NOW = new Date('2026-11-14T12:00:00Z');
const ctx: PanelQueryContext = {
  workspaceId: 'ws_1',
  projectId: 'pnp_1',
  retentionDays: 365,
  hasIdentifiedUsers: false,
  erasedIds: [],
  now: NOW,
};

async function run(spec: PanelQuerySpec, canned: Record<string, RawRow[]>, context = ctx): Promise<PanelQueryResult> {
  const out = await runPanelQuery(panelQuerySpecSchema.parse(spec), context, async (q: PanelSqlQuery) => ({ rows: canned[q.name] ?? [], bytesScanned: 5 }));
  return out.result;
}

describe('web result', () => {
  it('turns the summary, series and lists into the result shape, zero-filling empty days', async () => {
    const out = await run(
      { kind: 'web', projectId: 'pnp_1', dateRange: { from: '2026-11-10', to: '2026-11-12' }, compare: true },
      {
        'web.summary': [{ visitors: 10, visits: 20, pageviews: 50, bounces: 5, duration_seconds: 1200 }],
        'web.summary.previous': [[8, 10, 30, 5, 300]],
        'web.series': [{ bucket: '2026-11-10T00:00:00', visitors: 4, pageviews: 9 }, { bucket: '2026-11-12 00:00:00', visitors: 6, pageviews: 12 }],
        'web.topPages': [{ value: '/', visitors: 7, events: 20 }],
        'web.entryExit': [{ path: '/', entries: 6, exits: 2 }],
      },
    );
    if (out.kind !== 'web') throw new Error('kind');
    expect(out.result.totals).toEqual({ visitors: 10, visits: 20, pageviews: 50, bounceRate: 0.25, avgVisitDurationSeconds: 60 });
    expect(out.result.previousTotals?.visitors).toBe(8);
    expect(out.result.series).toEqual([
      { bucket: '2026-11-10', visitors: 4, pageviews: 9 },
      { bucket: '2026-11-11', visitors: 0, pageviews: 0 },
      { bucket: '2026-11-12', visitors: 6, pageviews: 12 },
    ]);
    expect(out.result.previousSeries).toHaveLength(3);
    expect(out.result.topPages).toEqual([{ value: '/', visitors: 7, events: 20 }]);
    expect(out.result.entryExitPages).toEqual([{ value: '/', entries: 6, exits: 2 }]);
    expect(out.result.range.previousTo).toBe(out.result.range.from);
  });

  it('answers zeros, not NaN, for a project with no data', async () => {
    const out = await run({ kind: 'web', projectId: 'pnp_1' }, {});
    if (out.kind !== 'web') throw new Error('kind');
    expect(out.result.totals).toEqual({ visitors: 0, visits: 0, pageviews: 0, bounceRate: 0, avgVisitDurationSeconds: 0 });
    expect(out.result.previousTotals).toBeNull();
  });
});

describe('trends result', () => {
  it('splits a series by breakdown value, with Other last, and compares', async () => {
    const out = await run(
      {
        kind: 'trends',
        projectId: 'pnp_1',
        dateRange: { from: '2026-11-10', to: '2026-11-11' },
        series: [{ event: 'Purchase', math: 'avg_per_user' }],
        breakdown: { source: 'column', field: 'country', limit: 1 },
        compare: true,
      },
      {
        'trends.breakdownValues': [{ value: 'NL', n: 5 }],
        'trends.series': [
          { bucket: '2026-11-10', bd: 'NL', s0_v: 6, s0_u: 3 },
          { bucket: '2026-11-11', bd: 'Other', s0_v: 1, s0_u: 1 },
        ],
        'trends.totals': [{ bd: 'NL', s0_v: 6, s0_u: 3 }, { bd: 'Other', s0_v: 1, s0_u: 1 }],
        'trends.series.previous': [{ bucket: '2026-11-08', bd: 'NL', s0_v: 2, s0_u: 1 }],
        'trends.totals.previous': [{ bd: 'NL', s0_v: 2, s0_u: 1 }],
      },
    );
    if (out.kind !== 'trends') throw new Error('kind');
    expect(out.result.series.map((s) => [s.breakdownValue, s.total])).toEqual([['NL', 2], ['Other', 1]]);
    expect(out.result.series[0]?.points).toEqual([{ bucket: '2026-11-10', value: 2 }, { bucket: '2026-11-11', value: 0 }]);
    expect(out.result.series[0]?.previous?.total).toBe(2);
    expect(out.result.series[0]?.label).toBe('Purchase');
  });

  it('answers one empty line per series without data', async () => {
    const out = await run({ kind: 'trends', projectId: 'pnp_1', series: [{ event: 'A' }, { event: 'B' }] }, {});
    if (out.kind !== 'trends') throw new Error('kind');
    expect(out.result.series).toHaveLength(2);
    expect(out.result.series.every((s) => s.total === 0 && s.breakdownValue === null)).toBe(true);
  });

  it('coarsens hourly buckets on long ranges', async () => {
    const out = await run({ kind: 'trends', projectId: 'pnp_1', dateRange: { preset: '90d' }, interval: 'hour', series: [{ event: 'A' }] }, {});
    if (out.kind !== 'trends') throw new Error('kind');
    expect(out.result.interval).toBe('day');
  });
});

describe('funnel result', () => {
  const steps = [{ event: 'A' }, { event: 'B', label: 'Step B' }, { event: 'C' }, { event: 'D' }];

  it('computes conversion, drop-off and time to convert from the per-step counts', async () => {
    const out = await run(
      { kind: 'funnel', projectId: 'pnp_1', steps },
      {
        'funnel.steps': [
          { step: 1, bd: '', persons: 100, avg_secs: 0 },
          { step: 2, bd: '', persons: 50, avg_secs: 120.4 },
          { step: 3, bd: '', persons: 25, avg_secs: 30 },
          { step: 4, bd: '', persons: 5, avg_secs: 3600 },
        ],
      },
    );
    if (out.kind !== 'funnel') throw new Error('kind');
    expect(out.result.steps.map((s) => s.count)).toEqual([100, 50, 25, 5]);
    expect(out.result.steps[1]).toMatchObject({ label: 'Step B', conversionFromPrevious: 0.5, conversionFromFirst: 0.5, droppedOff: 50, avgSecondsFromPrevious: 120 });
    expect(out.result.steps[3]).toMatchObject({ conversionFromPrevious: 0.2, conversionFromFirst: 0.05, droppedOff: 20 });
    expect(out.result.steps[0]?.avgSecondsFromPrevious).toBeNull();
    expect(out.result.overallConversion).toBe(0.05);
    expect(out.result.breakdowns).toBeNull();
  });

  it('answers a result per breakdown value', async () => {
    const out = await run(
      { kind: 'funnel', projectId: 'pnp_1', steps: steps.slice(0, 2), breakdown: { source: 'event', key: 'plan' } },
      {
        'funnel.breakdownValues': [{ value: 'pro', n: 10 }],
        'funnel.steps': [
          { step: 1, bd: 'pro', persons: 10, avg_secs: 0 },
          { step: 2, bd: 'pro', persons: 5, avg_secs: 60 },
          { step: 1, bd: 'Other', persons: 4, avg_secs: 0 },
          { step: 2, bd: 'Other', persons: 1, avg_secs: 10 },
        ],
      },
    );
    if (out.kind !== 'funnel') throw new Error('kind');
    expect(out.result.steps.map((s) => s.count)).toEqual([14, 6]);
    expect(out.result.breakdowns?.map((b) => [b.value, b.overallConversion])).toEqual([['pro', 0.5], ['Other', 0.25]]);
  });

  it('does not divide by zero for an empty funnel', async () => {
    const out = await run({ kind: 'funnel', projectId: 'pnp_1', steps }, {});
    if (out.kind !== 'funnel') throw new Error('kind');
    expect(out.result.overallConversion).toBe(0);
    expect(out.result.steps.every((s) => s.count === 0 && s.conversionFromPrevious === (s.index === 0 ? 1 : 0))).toBe(true);
  });
});

describe('retention result', () => {
  it('lines up returns per cohort and period and averages only cohorts old enough', async () => {
    const out = await run(
      {
        kind: 'retention',
        projectId: 'pnp_1',
        dateRange: { from: '2026-10-26', to: '2026-11-14' },
        firstEvent: 'Signed up',
        interval: 'week',
        periods: 2,
      },
      {
        'retention.sizes': [
          { cohort: '2026-10-26T00:00:00', size: 10 },
          { cohort: '2026-11-02T00:00:00', size: 20 },
          { cohort: '2026-11-09T00:00:00', size: 40 },
        ],
        'retention.returns': [
          { cohort: '2026-10-26T00:00:00', period: 0, n: 10 },
          { cohort: '2026-10-26T00:00:00', period: 1, n: 5 },
          { cohort: '2026-10-26T00:00:00', period: 2, n: 2 },
          { cohort: '2026-11-02T00:00:00', period: 0, n: 20 },
          { cohort: '2026-11-02T00:00:00', period: 1, n: 10 },
          { cohort: '2026-11-09T00:00:00', period: 0, n: 40 },
          { cohort: '2026-10-26T00:00:00', period: 9, n: 1 },
        ],
      },
    );
    if (out.kind !== 'retention') throw new Error('kind');
    expect(out.result.cohorts).toEqual([
      { cohort: '2026-10-26', size: 10, counts: [10, 5, 2] },
      { cohort: '2026-11-02', size: 20, counts: [20, 10, 0] },
      { cohort: '2026-11-09', size: 40, counts: [40, 0, 0] },
    ]);
    // Period 1 exists for the first two cohorts only (15 of 30); period 2 for the first (2 of 10).
    expect(out.result.averageRetention).toEqual([1, 0.5, 0.2]);
  });
});

describe('flows result', () => {
  it('keeps the spec limit and counts the anchor from every path read', async () => {
    const out = await run(
      { kind: 'flows', projectId: 'pnp_1', anchor: { event: 'Signed up' }, depth: 2, limit: 1 },
      { 'flows.paths': [{ n1: '/welcome', n2: null, cnt: 7 }, { n1: '/home', n2: '/pricing', cnt: 3 }] },
    );
    if (out.kind !== 'flows') throw new Error('kind');
    expect(out.result.paths).toEqual([{ steps: ['/welcome', null], count: 7 }]);
    expect(out.result.anchorCount).toBe(10);
    expect(out.result.direction).toBe('after');
  });
});

describe('sessions result', () => {
  it('maps rows, marks the sessions that have chunks and issues a cursor', async () => {
    const row = (id: string) => ({
      session_id: id,
      started: '2026-11-14 10:00:00',
      ended: '2026-11-14T10:05:00Z',
      duration_seconds: 300,
      pageviews: 4,
      clicks: 9,
      events: 20,
      rage: 1,
      dead: 0,
      quickback: 0,
      excessive: 0,
      errors: 2,
      entry_page: '/',
      exit_page: '/pricing',
      device: 'mobile',
      browser: 'Safari',
      os: 'iOS',
      country: 'NL',
      person: 'user_1',
      user_id: 'user_1',
    });
    const out = await run(
      { kind: 'sessions', projectId: 'pnp_1', limit: 2 },
      { 'sessions.list': [row('s_1'), row('s_2'), row('s_3')], 'sessions.chunks': [{ session_id: 's_2', chunks: 3 }] },
    );
    if (out.kind !== 'sessions') throw new Error('kind');
    expect(out.result.sessions.map((s) => [s.sessionId, s.hasRecording, s.chunkCount])).toEqual([['s_1', false, 0], ['s_2', true, 3]]);
    expect(out.result.sessions[0]).toMatchObject({
      startedAt: '2026-11-14T10:00:00.000Z',
      endedAt: '2026-11-14T10:05:00.000Z',
      durationSeconds: 300,
      deviceType: 'mobile',
      rageClicks: 1,
      errors: 2,
      favorite: false,
    });
    expect(out.result.hasMore).toBe(true);
    expect(out.result.nextCursor).toBe('o2');
  });

  it('ends the list without a cursor and skips the chunk lookup when empty', async () => {
    const calls: string[] = [];
    const out = await runPanelQuery(panelQuerySpecSchema.parse({ kind: 'sessions', projectId: 'pnp_1' }), ctx, async (q) => {
      calls.push(q.name);
      return { rows: [] };
    });
    expect(calls).toEqual(['sessions.list']);
    if (out.result.kind !== 'sessions') throw new Error('kind');
    expect(out.result.result).toMatchObject({ sessions: [], hasMore: false, nextCursor: null });
  });
});

describe('heatmap result', () => {
  it('area: shares of the clicks per element', async () => {
    const out = await run(
      { kind: 'heatmap', projectId: 'pnp_1', type: 'area', deviceClass: 'desktop', urlPattern: '/' },
      {
        'heatmap.pageviews': [{ pageviews: 100 }],
        'heatmap.elements': [{ selector: '#buy', text: 'Buy', clicks: 30, rel_x: 0.4, rel_y: 1.7 }, { selector: 'a.logo', text: null, clicks: 10, rel_x: 0.5, rel_y: 0.5 }],
      },
    );
    if (out.kind !== 'heatmap') throw new Error('kind');
    expect(out.result.pageviews).toBe(100);
    expect(out.result.clicks).toBe(40);
    expect(out.result.elements[0]).toEqual({ selector: '#buy', text: 'Buy', clicks: 30, share: 0.75, relX: 0.4, relY: 1 });
  });

  it('scroll: share of leaves that got at least that far', async () => {
    const out = await run(
      { kind: 'heatmap', projectId: 'pnp_1', type: 'scroll', deviceClass: 'mobile', urlPattern: '/' },
      { 'heatmap.scroll': [{ depth: 0, leaves: 20 }, { depth: 50, leaves: 60 }, { depth: 100, leaves: 20 }] },
    );
    if (out.kind !== 'heatmap') throw new Error('kind');
    const at = (depth: number) => out.result.scroll.buckets.find((b) => b.depth === depth)?.reachedShare;
    expect(out.result.scroll.leaves).toBe(100);
    expect(at(0)).toBe(1);
    expect(at(10)).toBe(0.8);
    expect(at(50)).toBe(0.8);
    expect(at(60)).toBe(0.2);
    expect(at(100)).toBe(0.2);
  });

  it('click: points per element position', async () => {
    const out = await run(
      { kind: 'heatmap', projectId: 'pnp_1', type: 'click', deviceClass: 'tablet', urlPattern: '/' },
      { 'heatmap.points': [{ selector: '#a', rel_x: 0.1, rel_y: 0.9, clicks: 4 }] },
    );
    if (out.kind !== 'heatmap') throw new Error('kind');
    expect(out.result.points).toEqual([{ selector: '#a', relX: 0.1, relY: 0.9, count: 4 }]);
    expect(out.result.clicks).toBe(4);
  });
});

describe('statistics and rows', () => {
  it('adds up the bytes scanned and counts the statements', async () => {
    const out = await runPanelQuery(panelQuerySpecSchema.parse({ kind: 'web', projectId: 'pnp_1' }), ctx, async () => ({ rows: [], bytesScanned: 100 }));
    expect(out.stats).toEqual({ queries: 12, bytesScanned: 1200 });
  });

  it('reads positional and keyed rows alike', () => {
    expect(normalizeRows([[1, 'a'], { N: 2, B: 'b' }], ['n', 'b'])).toEqual([{ n: 1, b: 'a' }, { n: 2, b: 'b' }]);
  });
});

describe('time', () => {
  it('resolves presets in the timezone and counts days inclusive', () => {
    const today = resolveRange({ preset: 'today' }, 'Europe/Amsterdam', ctx);
    expect(today.from.toISOString()).toBe('2026-11-13T23:00:00.000Z');
    const week = resolveRange({ preset: '7d' }, 'UTC', ctx);
    expect(week.from.toISOString()).toBe('2026-11-08T00:00:00.000Z');
    expect(week.to).toEqual(NOW);
  });

  it('includes the whole last day of a custom range', () => {
    const range = resolveRange({ from: '2026-11-01', to: '2026-11-03' }, 'UTC', ctx);
    expect(range.from.toISOString()).toBe('2026-11-01T00:00:00.000Z');
    expect(range.to.toISOString()).toBe('2026-11-04T00:00:00.000Z');
  });

  it('flags a range shortened to the retention', () => {
    const range = resolveRange({ from: '2020-01-01', to: '2020-01-31' }, 'UTC', { ...ctx, retentionDays: 30 });
    expect(range.clampedToRetention).toBe(true);
    expect(range.to.getTime()).toBeGreaterThanOrEqual(range.from.getTime());
  });

  it('refuses an unknown timezone', () => {
    expect(() => resolveRange({ preset: '7d' }, 'Mars/Olympus', ctx)).toThrow('Unknown timezone');
  });

  it('lists every bucket, weeks from Monday', () => {
    const range = resolveRange({ from: '2026-11-04', to: '2026-11-18' }, 'UTC', { ...ctx, now: new Date('2026-11-30T00:00:00Z') });
    expect(bucketLabels(range, 'week', 0)).toEqual(['2026-11-02', '2026-11-09', '2026-11-16']);
    expect(bucketLabels(range, 'month', 0)).toEqual(['2026-11-01']);
    expect(bucketLabels(range, 'day', 0)).toHaveLength(15);
  });
});

describe('lexicon', () => {
  it('collects event names and property keys, dropping what the collector would refuse', () => {
    const scan = lexiconFromRows(
      [{ name: 'Signed up', n: 5 }, { name: '$pageview', n: 9 }, { name: "bad'name", n: 1 }],
      [{ properties: '{"plan":"pro","$action":"click","bad key":1}', n: 3 }, { properties: 'not json', n: 1 }],
      [{ user_id: 'u', properties: '{"$email":"a@b.c","company":"X"}' }],
    );
    expect(scan.events.map((e) => e.name)).toEqual(['Signed up', '$pageview']);
    expect(scan.properties).toEqual(['$action', '$email', 'company', 'plan']);
  });
});

describe('cache key and permissions', () => {
  it('keys by workspace, project and the spec, whatever order its keys are in', async () => {
    const a = await specCacheKey('ws_1', 'pnp_1', { kind: 'web', limit: 10, projectId: 'pnp_1' });
    const b = await specCacheKey('ws_1', 'pnp_1', { projectId: 'pnp_1', limit: 10, kind: 'web' });
    expect(a).toBe(b);
    expect(a).toMatch(/^panel:q:ws_1:pnp_1:[0-9a-f]{64}$/);
    expect(await specCacheKey('ws_2', 'pnp_1', { kind: 'web' })).not.toBe(await specCacheKey('ws_1', 'pnp_1', { kind: 'web' }));
    expect(stableStringify({ b: undefined, a: [1, { d: 1, c: 2 }] })).toBe('{"a":[1,{"c":2,"d":1}]}');
  });

  it('asks for recordings access only for the recordings list', () => {
    expect(requiredPanelPermissions('sessions')).toEqual(['panel_reports:read', 'panel_recordings:read']);
    expect(requiredPanelPermissions('heatmap')).toEqual(['panel_reports:read']);
    expect(requiredPanelPermissions('funnel')).toEqual(['panel_reports:read']);
  });
});

describe('contract copies stay in step', () => {
  it('uses the collector patterns for event names and property keys', () => {
    expect(PANEL_CUSTOM_EVENT_NAME.source).toBe(CUSTOM_EVENT_NAME.source);
    expect(PANEL_PROPERTY_KEY.source).toBe(PROPERTY_KEY.source);
  });

  it('keeps the person and live DTOs assignable both ways to the Durable Object types', () => {
    const person: PanelPerson = { userId: 'u', email: null, name: null, properties: { a: 1 }, anonIds: [], firstSeen: '', lastSeen: '' };
    const dto: PanelPersonDto = person;
    const back: PanelPerson = dto;
    const live: PanelLiveSession = { sessionId: 's', distinctId: 'd', path: '/', title: null, country: null, deviceType: null, ts: '', startedAt: '', pageviews: 1 };
    const liveDto: PanelLiveSessionDto = live;
    const liveBack: PanelLiveSession = liveDto;
    expect([back.userId, liveBack.sessionId]).toEqual(['u', 's']);
  });
});

describe('cross-page links', () => {
  const funnel = panelQuerySpecSchema.parse({
    kind: 'funnel',
    projectId: 'pnp_1',
    dateRange: { preset: '7d' },
    steps: [{ event: 'Viewed pricing' }, { event: 'Signed up' }, { event: 'Purchase' }],
  });

  it('links a funnel drop-off to the people who did the previous step but not this one', () => {
    if (funnel.kind !== 'funnel') throw new Error('kind');
    const search = funnelDropOffRecordingsSearch(funnel, 2, 'pnp_1');
    expect(search).toEqual({ project: 'pnp_1', range: '7d', did: ['Signed up'], didNot: ['Purchase'] });
    expect(recordingsSearchSchema.parse(search)).toEqual(search);
    expect(() => funnelDropOffRecordingsSearch(funnel, 3)).toThrow(RangeError);
  });

  it('round-trips a recordings search through the sessions spec', () => {
    const search = recordingsSearchSchema.parse({ range: '30d', minDuration: 5, pages: ['/pricing'], frustration: ['rage'], errors: true, sort: 'duration_desc', user: 'u_1' });
    const spec = recordingsSearchToSpec(search, 'pnp_1');
    expect(panelQuerySpecSchema.parse(spec).kind).toBe('sessions');
    expect(sessionsSpecToRecordingsSearch(spec)).toEqual(search);
  });
});
