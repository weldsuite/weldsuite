/**
 * PanelUsage's alarm: counts reach panel-api (the settlement) about every five
 * minutes while there are new ones, nothing is sent when there are none, a
 * failed send is retried, and a blocked workspace keeps asking until panel-api
 * says `ok`, because a blocked collector sends no counts that could lift it.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeDurableObjectContext } from '../testing/fakes';
import { PanelUsage, SETTLE_INTERVAL_MS, SETTLE_URL, resetUsageWarnings } from './panel-usage';
import type { Env } from '../env';

const WS = 'ws_test_workspace';
const NOW = Date.parse('2026-10-27T12:00:00.000Z');

type Call = { url: string; body: { workspaceId: string; month: string; events: number; recordings: number } };

function create(answers: Array<{ quota?: string } | 'fail' | 'throw'> = []) {
  const state = fakeDurableObjectContext();
  const calls: Call[] = [];
  let index = 0;
  const api = {
    fetch: vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init.body)) });
      const answer = answers[Math.min(index, answers.length - 1)] ?? { quota: 'ok' };
      index += 1;
      if (answer === 'throw') throw new Error('network down');
      if (answer === 'fail') return new Response('nope', { status: 500 });
      return Response.json(answer);
    }),
  };
  const usage = new PanelUsage(state.ctx, { PANEL_API: api } as unknown as Env);
  return { usage, api, calls, ...state };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  resetUsageWarnings();
});
afterEach(() => vi.useRealTimers());

describe('PanelUsage settlement alarm', () => {
  it('sets an alarm five minutes out on the first count, and does not push it back on later ones', async () => {
    const { usage, alarm } = create();
    await usage.add('2026-10-27', 5, WS);
    expect(alarm()).toBe(NOW + SETTLE_INTERVAL_MS);

    vi.setSystemTime(NOW + 60_000);
    await usage.add('2026-10-27', 5, WS);
    await usage.addRecordings('2026-10-27', 1, WS);
    expect(alarm()).toBe(NOW + SETTLE_INTERVAL_MS);
  });

  it('sends the month totals to panel-api and goes quiet once they are accepted', async () => {
    const { usage, calls, alarm, api } = create([{ quota: 'ok' }]);
    await usage.add('2026-10-26', 40, WS);
    await usage.add('2026-10-27', 2, WS);
    await usage.addRecordings('2026-10-27', 3, WS);

    await usage.alarm();

    expect(calls).toEqual([{ url: SETTLE_URL, body: { workspaceId: WS, month: '2026-10', events: 42, recordings: 3 } }]);
    expect(api.fetch.mock.calls[0]![1]).toMatchObject({ method: 'POST', headers: { 'content-type': 'application/json' } });

    // Nothing new: the next alarm (there is none, but if one fired) sends nothing.
    await usage.alarm();
    expect(calls).toHaveLength(1);
    expect(alarm()).toBe(NOW + SETTLE_INTERVAL_MS); // the one set by the first count; no further one was added
  });

  it('keeps each month apart when counts from a finished month are still unsent', async () => {
    const { usage, calls } = create();
    await usage.add('2026-09-30', 7, WS);
    await usage.add('2026-10-01', 1, WS);

    await usage.alarm();

    expect(calls.map((c) => c.body)).toEqual([
      { workspaceId: WS, month: '2026-09', events: 7, recordings: 0 },
      { workspaceId: WS, month: '2026-10', events: 1, recordings: 0 },
    ]);
  });

  it('retries a failed or refused send in five minutes, then stops when it is accepted', async () => {
    const { usage, alarm, calls } = create(['fail', 'throw', { quota: 'ok' }]);
    await usage.add('2026-10-27', 9, WS);

    await usage.alarm();
    expect(alarm()).toBe(NOW + SETTLE_INTERVAL_MS);
    await usage.alarm();
    await usage.alarm();
    expect(calls).toHaveLength(3);

    await usage.alarm();
    expect(calls).toHaveLength(3); // accepted: marked clean
  });

  it('keeps the alarm going while the quota is not ok, with no new counts, and lets go when panel-api says ok', async () => {
    const { usage, alarm, calls } = create([{ quota: 'events_blocked' }, { quota: 'events_blocked' }, { quota: 'ok' }]);
    await usage.add('2026-10-27', 60_000, WS);

    vi.setSystemTime(NOW + SETTLE_INTERVAL_MS);
    await usage.alarm();
    expect(alarm()).toBe(NOW + 2 * SETTLE_INTERVAL_MS);

    vi.setSystemTime(NOW + 2 * SETTLE_INTERVAL_MS);
    await usage.alarm();
    expect(calls).toHaveLength(2);
    expect(calls[1]!.body).toMatchObject({ month: '2026-10', events: 60_000 }); // same totals: panel-api retries unpaid blocks

    vi.setSystemTime(NOW + 3 * SETTLE_INTERVAL_MS);
    const before = alarm();
    await usage.alarm();
    expect(calls).toHaveLength(3);
    expect(alarm()).toBe(before); // no new alarm after `ok`
  });

  it('asks again for the new month while blocked, so a block lifts when the month turns', async () => {
    const { usage, calls } = create([{ quota: 'replay_blocked' }, { quota: 'ok' }]);
    await usage.add('2026-10-31', 10, WS);
    vi.setSystemTime(Date.parse('2026-10-31T23:58:00.000Z'));
    await usage.alarm();

    vi.setSystemTime(Date.parse('2026-11-01T00:03:00.000Z'));
    await usage.alarm();

    expect(calls.map((c) => c.body.month)).toEqual(['2026-10', '2026-11']);
    expect(calls[1]!.body).toMatchObject({ events: 0, recordings: 0 });
  });

  it('sends counts that arrived while panel-api was answering in the next round', async () => {
    const { usage, api, calls } = create();
    await usage.add('2026-10-27', 5, WS);
    api.fetch.mockImplementationOnce(async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init.body)) });
      await usage.add('2026-10-27', 1, WS); // a collector call lands during the settle
      return Response.json({ quota: 'ok' });
    });

    await usage.alarm();
    await usage.alarm();

    expect(calls.map((c) => c.body.events)).toEqual([5, 6]);
  });

  it('does nothing without a workspace id or without the binding, and warns once about the binding', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const noId = create();
    await noId.usage.add('2026-10-27', 1);
    await noId.usage.alarm();
    expect(noId.calls).toHaveLength(0);

    const state = fakeDurableObjectContext();
    const bare = new PanelUsage(state.ctx, {} as Env);
    await bare.add('2026-10-27', 1, WS);
    await bare.alarm();
    await bare.alarm();
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});
