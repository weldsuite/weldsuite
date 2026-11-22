import { describe, expect, it } from 'vitest';
import { LIVE_MINUTES, LIVE_WINDOW_MS, liveCounts } from './project-object';

const NOW = Date.parse('2026-11-20T12:00:00.000Z');
const MINUTE = 60 * 1000;
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const row = (distinctId: string, startedAgo: number, lastAgo: number) => ({ distinctId, startedAt: ago(startedAgo), ts: ago(lastAgo) });

/** 30 zeros with the given buckets set. */
function minutes(set: Record<number, number>): number[] {
  const out = Array<number>(LIVE_MINUTES).fill(0);
  for (const [i, n] of Object.entries(set)) out[Number(i)] = n;
  return out;
}

describe('liveCounts', () => {
  it('answers zeros and 30 empty minutes for no sessions', () => {
    expect(liveCounts([], NOW)).toEqual({ visitors: 0, visitors30m: 0, perMinute: minutes({}) });
  });

  it('counts a session in every minute from its start to its last activity, each visitor once', () => {
    const counts = liveCounts(
      [
        row('a-1', 10 * MINUTE, 7.5 * MINUTE),
        // The same visitor in another session, in a minute it already counts in.
        row('a-1', 9 * MINUTE, 9 * MINUTE),
        row('a-2', 30 * 1000, 30 * 1000),
        row('a-3', 4 * MINUTE, 2 * MINUTE),
      ],
      NOW,
    );
    expect(counts).toEqual({
      visitors: 2,
      visitors30m: 3,
      perMinute: minutes({ 20: 1, 21: 1, 22: 1, 26: 1, 27: 1, 28: 1, 29: 1 }),
    });
  });

  it('includes a bucket start and excludes its end', () => {
    // Started exactly when bucket 29 starts: in 29, not in 28.
    expect(liveCounts([row('a-1', MINUTE, MINUTE)], NOW).perMinute).toEqual(minutes({ 29: 1 }));
    // Last seen exactly when bucket 28 ends (= bucket 29 starts): in 29 too.
    expect(liveCounts([row('a-1', 2 * MINUTE, MINUTE)], NOW).perMinute).toEqual(minutes({ 28: 1, 29: 1 }));
    // Starting right now is past the last bucket.
    expect(liveCounts([row('a-1', 0, 0)], NOW)).toEqual({ visitors: 1, visitors30m: 1, perMinute: minutes({}) });
  });

  it('counts five minutes in visitors and 30 in visitors30m, edges included', () => {
    expect(liveCounts([row('a-1', 5 * MINUTE, 5 * MINUTE)], NOW)).toMatchObject({ visitors: 1, visitors30m: 1 });
    expect(liveCounts([row('a-1', 6 * MINUTE, 5 * MINUTE + 1)], NOW)).toMatchObject({ visitors: 0, visitors30m: 1 });
    expect(liveCounts([row('a-1', LIVE_WINDOW_MS, LIVE_WINDOW_MS)], NOW)).toEqual({ visitors: 0, visitors30m: 1, perMinute: minutes({ 0: 1 }) });
    // A session that started before the window counts from the first minute.
    expect(liveCounts([row('a-1', 45 * MINUTE, 29 * MINUTE + 30 * 1000)], NOW).perMinute).toEqual(minutes({ 0: 1 }));
    expect(liveCounts([row('a-1', LIVE_WINDOW_MS + 1, LIVE_WINDOW_MS + 1)], NOW)).toEqual({ visitors: 0, visitors30m: 0, perMinute: minutes({}) });
  });

  it('leaves out a row whose time is not one, and a start that is not one from the minutes', () => {
    expect(liveCounts([{ distinctId: 'a-1', startedAt: ago(MINUTE), ts: 'later' }], NOW)).toEqual({ visitors: 0, visitors30m: 0, perMinute: minutes({}) });
    expect(liveCounts([{ distinctId: 'a-1', startedAt: 'earlier', ts: ago(MINUTE) }], NOW)).toEqual({ visitors: 1, visitors30m: 1, perMinute: minutes({}) });
  });
});
