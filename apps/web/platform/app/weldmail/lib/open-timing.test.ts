import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const track = vi.fn();
vi.mock('@/lib/analytics', () => ({ track: (...args: unknown[]) => track(...args) }));

import {
  abandonMailOpen,
  markMailGatePassed,
  markMailListFailed,
  markMailListShown,
  normalizePath,
  startMailOpen,
  summarizeRequests,
} from './open-timing';

/** A resource entry as the browser reports a fetch. */
function resource(url: string, startTime: number, extra: Partial<PerformanceResourceTiming> = {}) {
  return {
    name: url,
    entryType: 'resource',
    initiatorType: 'fetch',
    startTime,
    duration: 300,
    transferSize: 2048,
    serverTiming: [],
    ...extra,
  } as unknown as PerformanceResourceTiming;
}

let queued: PerformanceEntry[] = [];

/** PerformanceObserver that hands over `queued` when asked for its records. */
class FakeObserver {
  observe() {}
  disconnect() {}
  takeRecords() {
    const records = queued;
    queued = [];
    return records;
  }
}

describe('open timing', () => {
  let now = 0;

  beforeEach(() => {
    track.mockReset();
    queued = [];
    now = 0;
    vi.stubGlobal('PerformanceObserver', FakeObserver);
    vi.spyOn(performance, 'now').mockImplementation(() => now);
  });

  afterEach(() => {
    abandonMailOpen();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('reports a navigation from the router entering mail to the first list from the server', () => {
    now = 1_000;
    startMailOpen(false);
    now = 1_100;
    markMailGatePassed();
    now = 1_200;
    markMailListShown(false);
    queued = [
      resource('https://app-api.weldsuite.org/api/me/permissions', 900),
      resource('https://mail-api.weldsuite.org/api/mail-labels/threads?labelSlug=inbox', 1_150, {
        serverTiming: [
          { name: 'db', duration: 120.4, description: '6 queries' },
          { name: 'total', duration: 250 },
        ] as unknown as PerformanceServerTiming[],
      }),
      resource('https://app.weldsuite.org/assets/chunk.js', 1_160, { initiatorType: 'script' }),
    ];
    now = 1_500;
    markMailListShown(true);

    expect(track).toHaveBeenCalledTimes(1);
    expect(track).toHaveBeenCalledWith('Mail Open Timing', {
      kind: 'navigation',
      outcome: 'loaded',
      wasHidden: false,
      totalMs: 500,
      gateMs: 100,
      firstListMs: 200,
      listFromCache: true,
      requests: [
        {
          host: 'mail-api',
          path: '/api/mail-labels/threads',
          startMs: 150,
          ms: 300,
          bytes: 2048,
          server: { db: 120, total: 250 },
        },
      ],
    });
  });

  it('measures a page load from the time origin', () => {
    now = 2_000;
    startMailOpen(true);
    now = 2_400;
    markMailListShown(true);

    expect(track).toHaveBeenCalledWith(
      'Mail Open Timing',
      expect.objectContaining({ kind: 'page-load', totalMs: 2_400, firstListMs: 2_400, listFromCache: false, gateMs: null }),
    );
  });

  it('reports a failed list as an error, once', () => {
    startMailOpen(false);
    now = 300;
    markMailListFailed();
    markMailListShown(true);

    expect(track).toHaveBeenCalledTimes(1);
    expect(track).toHaveBeenCalledWith('Mail Open Timing', expect.objectContaining({ outcome: 'error', totalMs: 300 }));
  });

  it('sends nothing for an open the user left', () => {
    startMailOpen(false);
    abandonMailOpen();
    markMailListShown(true);

    expect(track).not.toHaveBeenCalled();
  });

  it('ignores list updates when no open is running', () => {
    markMailListShown(true);
    expect(track).not.toHaveBeenCalled();
  });
});

describe('normalizePath', () => {
  it('replaces record ids and keeps the route words', () => {
    expect(normalizePath('/api/mail-accounts/macc_01HXYZ123ABC/labels')).toBe('/api/mail-accounts/:id/labels');
    expect(normalizePath('/api/mail-messages/stats')).toBe('/api/mail-messages/stats');
  });
});

describe('summarizeRequests', () => {
  it('orders requests by start and reports them relative to the open', () => {
    const summary = summarizeRequests(
      [
        resource('https://mail-api.weldsuite.org/api/mail-messages/stats', 600, { transferSize: 0 }),
        resource('https://mail-api.weldsuite.org/api/mail-accounts', 500),
      ],
      400,
    );
    expect(summary.map((r) => [r.path, r.startMs, r.bytes])).toEqual([
      ['/api/mail-accounts', 100, 2048],
      ['/api/mail-messages/stats', 200, 0],
    ]);
  });
});
