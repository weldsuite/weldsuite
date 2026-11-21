import { describe, expect, it } from 'vitest';
import { ApiError } from '@weldsuite/api-client';
import { proxyRecipe as sdkProxyRecipe } from '../../../../../../packages/sdk/panel-sdk/src/install';
import { anomalyBand, conditionGuides, eventAlertSpec, previewSpec, splitForCheck } from './alerts';
import { annotationTimeForBucket, annotationsByBucket, bucketRange, bucketTime } from './annotations';
import { activeChannels, channelsDraft, channelsInput, channelsProblem } from './channels';
import { csvColumns, csvFilename, toCsv } from './csv';
import { fromLocalInput, toLocalDateTimeInput } from './date-input';
import { EXPORT_PROVIDER_PRESETS, formatBytes, isExportEndpoint } from './export-providers';
import { proxyRecipe, type ProxyRecipeKind } from './proxy-recipes';
import { resultCsvRows } from './result-csv';
import { scheduleText, timeZones, weekdayNames } from './schedule';
import { embedUrl, iframeSnippet, shareLinkState, shareRefusals } from './share';
import { specSummary } from './spec-summary';
import { makeFlowsResult, makeFunnelResult, makeRetentionResult, makeTrendsResult } from '../analytics-fixtures';

const BOM = '﻿';

describe('csv', () => {
  it('writes a BOM, a header from every key and CRLF lines', () => {
    expect(toCsv([{ a: 1, b: 'x' }, { a: 2, c: null }])).toBe(`${BOM}a,b,c\r\n1,x,\r\n2,,\r\n`);
  });

  it('quotes commas, quotes and line breaks', () => {
    expect(toCsv([{ v: 'a,b' }, { v: 'say "hi"' }, { v: 'two\nlines' }])).toBe(`${BOM}v\r\n"a,b"\r\n"say ""hi"""\r\n"two\nlines"\r\n`);
  });

  it('defuses text a spreadsheet would run as a formula, but not numbers', () => {
    expect(toCsv([{ v: '=SUM(A1)' }, { v: '@cmd' }, { v: -3 }])).toBe(`${BOM}v\r\n'=SUM(A1)\r\n'@cmd\r\n-3\r\n`);
  });

  it('is just the BOM without rows, and drops non-finite numbers', () => {
    expect(toCsv([])).toBe(BOM);
    expect(toCsv([{ v: Number.NaN }])).toBe(`${BOM}v\r\n\r\n`);
  });

  it('lists columns in first-seen order', () => {
    expect(csvColumns([{ b: 1 }, { a: 2, b: 3 }])).toEqual(['b', 'a']);
  });

  it('names a file after the report and the day', () => {
    expect(csvFilename('Signups by week', new Date('2026-03-03T10:00:00Z'))).toBe('signups-by-week-2026-03-03');
    expect(csvFilename('Café / Überblick', new Date('2026-03-03T10:00:00Z'))).toBe('cafe-uberblick-2026-03-03');
    expect(csvFilename('???', new Date('2026-03-03T10:00:00Z'))).toBe('weldpanel-2026-03-03');
  });
});

describe('result csv', () => {
  it('has a row per series point', () => {
    const rows = resultCsvRows({ kind: 'trends', result: makeTrendsResult() });
    expect(rows.length).toBeGreaterThan(0);
    expect(Object.keys(rows[0]!)).toEqual(['series', 'breakdown', 'bucket', 'value']);
  });

  it('has a row per funnel step, retention cohort and flow path', () => {
    const funnel = makeFunnelResult();
    expect(resultCsvRows({ kind: 'funnel', result: funnel })).toHaveLength(funnel.steps.length);
    const retention = makeRetentionResult();
    const rows = resultCsvRows({ kind: 'retention', result: retention });
    expect(rows).toHaveLength(retention.cohorts.length);
    expect(rows[0]).toMatchObject({ cohort: retention.cohorts[0]!.cohort, size: retention.cohorts[0]!.size });
    const flows = makeFlowsResult();
    expect(resultCsvRows({ kind: 'flows', result: flows })[0]).toEqual({ count: 40, step_1: '/signup', step_2: '/welcome' });
  });
});

describe('annotations', () => {
  const days = ['2026-03-01', '2026-03-02', '2026-03-03'];

  it('reads bucket starts as UTC', () => {
    expect(bucketTime('2026-03-01')).toBe(Date.UTC(2026, 2, 1));
    expect(bucketTime('2026-03-01T10:00:00Z')).toBe(Date.UTC(2026, 2, 1, 10));
    expect(bucketTime('Other')).toBeNull();
  });

  it('covers the chart from its first bucket to the end of the last', () => {
    expect(bucketRange(days)).toEqual({ from: '2026-03-01T00:00:00.000Z', to: '2026-03-03T23:59:59.999Z' });
    expect(bucketRange([])).toBeNull();
  });

  it('puts each annotation in the bucket it falls in and leaves out the rest', () => {
    const placed = annotationsByBucket(days, [
      { id: 'a', occurredAt: '2026-03-02T15:00:00Z' },
      { id: 'b', occurredAt: '2026-03-02T01:00:00Z' },
      { id: 'c', occurredAt: '2026-03-03T23:00:00Z' },
      { id: 'd', occurredAt: '2026-03-04T00:00:00Z' },
      { id: 'e', occurredAt: '2026-02-28T12:00:00Z' },
    ]);
    expect([...placed.entries()].map(([i, list]) => [i, list.map((a) => a.id)])).toEqual([
      [1, ['a', 'b']],
      [2, ['c']],
    ]);
  });

  it('suggests noon for a day and the start for an hour', () => {
    expect(annotationTimeForBucket('2026-03-02')).toBe('2026-03-02T12:00:00.000Z');
    expect(annotationTimeForBucket('2026-03-02T09:00:00Z')).toBe('2026-03-02T09:00:00.000Z');
  });

  it('round-trips a datetime-local value', () => {
    const iso = '2026-03-02T09:30:00.000Z';
    expect(fromLocalInput(toLocalDateTimeInput(iso))).toBe(iso);
    expect(fromLocalInput('')).toBeNull();
  });
});

describe('channels', () => {
  it('keeps a stored Slack webhook unless replaced or removed', () => {
    const draft = channelsDraft({ emailUserIds: ['u1'], inApp: true, slack: true, weldchatChannelId: null });
    expect(draft.slackMode).toBe('keep');
    expect(channelsInput(draft)).toEqual({ emailUserIds: ['u1'], inApp: true, weldchatChannelId: null });
    expect(channelsInput({ ...draft, slackMode: 'remove' })).toMatchObject({ slackWebhookUrl: null });
    expect(channelsInput({ ...draft, slackMode: 'set', slackUrl: ' https://hooks.slack.com/services/T/B/X ' })).toMatchObject({ slackWebhookUrl: 'https://hooks.slack.com/services/T/B/X' });
  });

  it('refuses a URL that is not a Slack webhook, and no channel at all', () => {
    const empty = channelsDraft(null);
    expect(channelsProblem(empty)).toBe('none');
    expect(channelsProblem({ ...empty, slackMode: 'set', slackUrl: 'https://evil.example.com/hook' })).toBe('slackInvalid');
    expect(channelsProblem({ ...empty, inApp: true })).toBeNull();
  });

  it('lists the channels a saved one sends to', () => {
    expect(activeChannels({ emailUserIds: ['a', 'b'], inApp: false, slack: true, weldchatChannelId: 'ch_1' })).toEqual([{ key: 'email', count: 2 }, { key: 'slack' }, { key: 'weldchat' }]);
  });
});

describe('alerts', () => {
  it('builds the anomaly band like the checker (median ± k·1.4826·MAD)', () => {
    const band = anomalyBand([10, 12, 11, 13, 9, 10, 11], 'medium');
    expect(band?.median).toBe(11);
    // MAD = 1 → spread 3 · 1.4826
    expect(band?.upper).toBeCloseTo(11 + 3 * 1.4826, 6);
    expect(band?.lower).toBeCloseTo(11 - 3 * 1.4826, 6);
    expect(anomalyBand([1, 2, 3], 'high')).toBeNull();
  });

  it('judges the last complete interval against the ones before', () => {
    expect(splitForCheck([1, 2, 3, 4, 99])).toEqual({ baseline: [1, 2, 3], last: 4 });
    expect(conditionGuides({ type: 'threshold', operator: 'above', value: 5 }, [1, 2])).toEqual({ threshold: 5, band: null });
  });

  it('previews one series at the check interval, without breakdowns or comparison', () => {
    const spec = { ...eventAlertSpec('wpp_1', 'Signed up', 'total', 'UTC'), series: [{ event: 'A' }, { event: 'B' }], compare: true, breakdown: { source: 'column' as const, field: 'country' as const }, display: 'cumulative' as const };
    const preview = previewSpec(spec, 1, 'hourly');
    expect(preview.series).toEqual([{ event: 'B' }]);
    expect(preview).toMatchObject({ interval: 'hour', dateRange: { preset: '7d' }, compare: false });
    expect(preview).not.toHaveProperty('breakdown');
    expect(preview).not.toHaveProperty('display');
  });
});

describe('share', () => {
  it('adds embed=1 and escapes the iframe attributes', () => {
    expect(embedUrl('https://app.weldsuite.org/s/panel/wpsh_x')).toBe('https://app.weldsuite.org/s/panel/wpsh_x?embed=1');
    expect(iframeSnippet('https://a.test/s/panel/t', 'Sales "Q1" <b>')).toContain('title="Sales &quot;Q1&quot; &lt;b>"');
  });

  it('reads the refusal reasons of a 422 NOT_SHAREABLE', () => {
    const error = new ApiError('Unprocessable', 422, { error: { code: 'NOT_SHAREABLE', message: 'x', details: { reasons: [{ reportId: 'wpr_1', reason: 'person_breakdown' }, { reportId: 'wpr_2', reason: 'bogus' }] } } });
    expect(shareRefusals(error)).toEqual([{ reportId: 'wpr_1', reason: 'person_breakdown' }]);
    expect(shareRefusals(new ApiError('Forbidden', 403))).toBeNull();
  });

  it('tells active, expired and revoked links apart', () => {
    const now = Date.parse('2026-03-01T00:00:00Z');
    expect(shareLinkState({ revokedAt: null, expiresAt: null }, now)).toBe('active');
    expect(shareLinkState({ revokedAt: null, expiresAt: '2026-02-01T00:00:00Z' }, now)).toBe('expired');
    expect(shareLinkState({ revokedAt: '2026-02-01T00:00:00Z', expiresAt: null }, now)).toBe('revoked');
  });
});

describe('schedule', () => {
  const texts = { daily: 'Every day at {time}', weekly: 'Every {weekday} at {time}', monthly: 'Day {day} at {time}' };
  const format = (template: string, values: Record<string, string>) => template.replace(/\{(\w+)\}/g, (_, key: string) => values[key] ?? '');

  it('starts the week on Sunday, as the API counts', () => {
    expect(weekdayNames('en')[0]).toBe('Sunday');
    expect(weekdayNames('en')[1]).toBe('Monday');
  });

  it('describes a schedule with its time zone', () => {
    expect(scheduleText({ frequency: 'weekly', hour: 9, weekday: 1, timezone: 'Europe/Amsterdam' }, texts, 'en-GB', format)).toBe('Every Monday at 09:00 (Europe/Amsterdam)');
    expect(scheduleText({ frequency: 'monthly', hour: 18, monthDay: 3, timezone: 'UTC' }, texts, 'en-GB', format)).toBe('Day 3 at 18:00 (UTC)');
  });

  it('lists UTC first and keeps an unknown current zone', () => {
    expect(timeZones()[0]).toBe('UTC');
    expect(timeZones('Mars/Olympus')[0]).toBe('Mars/Olympus');
  });
});

describe('exports', () => {
  it('accepts only https origins as endpoints', () => {
    expect(isExportEndpoint('https://abc.r2.cloudflarestorage.com')).toBe(true);
    expect(isExportEndpoint('http://minio.local')).toBe(false);
    expect(isExportEndpoint('https://s3.example.com/bucket')).toBe(false);
    expect(isExportEndpoint('https://user:pw@s3.example.com')).toBe(false);
  });

  it('has a preset per provider; only S3 goes without an endpoint', () => {
    expect(Object.entries(EXPORT_PROVIDER_PRESETS).filter(([, p]) => !p.needsEndpoint).map(([k]) => k)).toEqual(['s3']);
    expect(EXPORT_PROVIDER_PRESETS.minio.pathStyle).toBe(true);
  });

  it('formats sizes', () => {
    expect(formatBytes(512, 'en')).toBe('512 B');
    expect(formatBytes(1536, 'en')).toBe('1.5 KB');
  });
});

describe('spec summary', () => {
  it('reads the period, events, filters and breakdowns of a stored spec', () => {
    const summary = specSummary(
      { dateRange: { preset: '30d' }, series: [{ event: 'Signed up' }, { event: 'Paid', label: 'Payments' }], filters: [{}, {}], breakdowns: [{ source: 'column', field: 'country' }] },
      { '30d': 'Last 30 days' },
    );
    expect(summary).toEqual({ range: 'Last 30 days', events: ['Signed up', 'Payments'], filters: 2, breakdowns: ['country'] });
  });
});

describe('proxy recipes', () => {
  it('match the SDK recipes', () => {
    for (const kind of ['nextjs', 'vercel', 'cloudflare-worker', 'nginx'] as ProxyRecipeKind[]) {
      expect(proxyRecipe(kind, { path: '/stats', collector: 'https://pnl.example.com' })).toBe(sdkProxyRecipe(kind, { path: '/stats', collector: 'https://pnl.example.com' }));
      expect(proxyRecipe(kind)).toBe(sdkProxyRecipe(kind));
    }
  });
});
