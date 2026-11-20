import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import type { PanelActivityEvent } from '@weldsuite/app-api-client/schemas/weldpanel-objects';
import { buildMarkers, buildPageVisits, fitScale, formatClock, inactiveRanges, markerKind, mergeChunks, pageAt, readChunk, type ReplayEvent } from './replay';

const ev = (name: string, ts: string, extra: Partial<PanelActivityEvent> = {}): PanelActivityEvent => ({
  eventId: `${name}-${ts}`,
  name,
  ts,
  path: null,
  url: null,
  title: null,
  sessionId: 's1',
  detail: null,
  properties: {},
  ...extra,
});

const toBuffer = (value: unknown, gz: boolean): ArrayBuffer => {
  const raw = Buffer.from(JSON.stringify(value));
  const bytes = gz ? gzipSync(raw) : raw;
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
};

describe('readChunk', () => {
  const events: ReplayEvent[] = [{ type: 2, timestamp: 10, data: {} }];
  it('gunzips a chunk', async () => {
    expect(await readChunk(toBuffer(events, true))).toEqual(events);
  });
  it('accepts plain JSON and drops malformed entries', async () => {
    expect(await readChunk(toBuffer([...events, { nope: true }], false))).toEqual(events);
  });
  it('rejects something that is not a list', async () => {
    await expect(readChunk(toBuffer({}, false))).rejects.toThrow();
  });
});

describe('timeline', () => {
  const start = Date.parse('2026-11-14T10:00:00Z');
  it('classifies events', () => {
    expect(markerKind('$pageview')).toBe('page');
    expect(markerKind('$rageclick')).toBe('frustration');
    expect(markerKind('$exception')).toBe('error');
    expect(markerKind('$pageleave')).toBeNull();
    expect(markerKind('Signed up')).toBe('custom');
  });

  it('builds markers inside the recording only, in order', () => {
    const markers = buildMarkers(
      [ev('Signed up', '2026-11-14T10:00:30Z'), ev('$pageview', '2026-11-14T10:00:05Z', { path: '/a' }), ev('$pageleave', '2026-11-14T10:00:06Z'), ev('$autocapture', '2026-11-14T11:00:00Z')],
      start,
      60_000,
    );
    expect(markers.map((m) => [m.kind, m.offsetMs, m.label])).toEqual([
      ['page', 5000, '/a'],
      ['custom', 30000, 'Signed up'],
    ]);
  });

  it('finds the idle stretches and the current page', () => {
    const events: ReplayEvent[] = [100, 1000, 12000, 12500].map((t) => ({ type: 3, timestamp: start + t, data: {} }));
    expect(inactiveRanges(events, start)).toEqual([{ startMs: 1000, endMs: 12000 }]);
    const visits = buildPageVisits([ev('$pageview', '2026-11-14T10:00:00Z', { path: '/' }), ev('$pageview', '2026-11-14T10:00:20Z', { path: '/pricing' })], start, 40_000);
    expect(visits.map((v) => v.durationMs)).toEqual([20000, 20000]);
    expect(pageAt(visits, 25_000)?.path).toBe('/pricing');
    expect(pageAt(visits, 1000)?.path).toBe('/');
  });

  it('merges chunks by time', () => {
    const merged = mergeChunks([[{ type: 3, timestamp: 5, data: 1 }], [{ type: 2, timestamp: 1, data: 0 }]]);
    expect(merged.map((e) => e.timestamp)).toEqual([1, 5]);
  });
});

describe('formatting', () => {
  it('formats the clock', () => {
    expect(formatClock(65_000)).toBe('1:05');
    expect(formatClock(3_725_000)).toBe('1:02:05');
  });
  it('fits a viewport', () => {
    expect(fitScale(640, 400, 1280, 800)).toBe(0.5);
    expect(fitScale(2000, 2000, 1280, 800)).toBe(1);
  });
});
