import { afterEach, describe, expect, it, vi } from 'vitest';
import { memoryStorage, setup, TOKEN } from './test/harness';
import { RETRY_BASE_MS, RETRY_MAX_MS, SEND_TIMEOUT_MS, type FetchResponse } from './client';
import { utf8Length } from './event';
import { MAX_BATCH_BYTES, type WireEvent } from './wire';

const QUEUE = `weldpanel:${TOKEN}:queue`;
const NO_CONSENT_NEEDED = { config: { consentMode: 'none' } };

afterEach(() => {
  vi.useRealTimers();
});

describe('batching', () => {
  it('sends as soon as flushAt events wait', async () => {
    vi.useFakeTimers();
    const { panel, idle, net } = setup({ flushAt: 5 });
    await panel.ready;
    for (let i = 0; i < 3; i++) panel.track(`E${i}`);
    await idle();
    expect(net.attempts).toHaveLength(0);
    panel.track('E3');
    await idle();
    expect(net.sent.map((s) => s.batch.events.length)).toEqual([5]);
    panel.shutdown();
  });

  it('sends flushIntervalMs after the first event waits', async () => {
    vi.useFakeTimers();
    const { panel, net } = setup({ flushIntervalMs: 10_000 });
    await panel.ready;
    panel.track('A');
    await vi.advanceTimersByTimeAsync(9_999);
    expect(net.attempts).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(net.names()).toEqual(['$app_opened', 'A']);
    panel.shutdown();
  });

  it('never more than 100 events or 64 KiB in a batch', async () => {
    vi.useFakeTimers();
    const { panel, idle, net } = setup({ flushAt: 100 });
    await panel.ready;
    for (let i = 0; i < 250; i++) panel.track('Small', { i });
    await panel.flush();
    await idle();
    expect(net.sent.map((s) => s.batch.events.length)).toEqual([100, 100, 51]);

    const big = 'x'.repeat(2000);
    for (let i = 0; i < 40; i++) panel.track('Big', { a: big, b: big, c: big, d: big, e: big });
    await panel.flush();
    await idle();
    const bigBatches = net.sent.slice(3);
    expect(bigBatches.length).toBeGreaterThan(1);
    for (const { batch } of bigBatches) expect(utf8Length(JSON.stringify(batch))).toBeLessThanOrEqual(MAX_BATCH_BYTES);
    expect(net.names().filter((n) => n === 'Big')).toHaveLength(40);
    panel.shutdown();
  });

  it('profile operations past 50 wait for the next batch', async () => {
    const { panel, idle, net } = setup({ network: NO_CONSENT_NEEDED });
    await panel.ready;
    panel.identify('ann');
    for (let i = 0; i < 60; i++) panel.people.set({ [`p${i}`]: i });
    for (let i = 0; i < 55; i++) panel.groups.set('company', 'acme', { [`g${i}`]: i });
    await panel.flush();
    await idle();
    expect(net.sent).toHaveLength(1);
    expect(net.sent[0].batch.people).toHaveLength(50);
    expect(net.sent[0].batch.groups).toHaveLength(50);
    panel.track('Next');
    await panel.flush();
    await idle();
    expect(net.sent[1].batch.people).toHaveLength(10);
    expect(net.sent[1].batch.people?.[0]).toMatchObject({ props: { p50: 50 } });
    expect(net.sent[1].batch.groups).toHaveLength(5);
  });
});

describe('retries', () => {
  it('keeps the batch on a network failure, 5xx or 429 and retries after 1 s, 2 s, 4 s', async () => {
    vi.useFakeTimers();
    const { panel, net } = setup({ network: { answers: ['error', 503, 429] } });
    await panel.ready;
    panel.track('A');
    await panel.flush();
    expect(net.attempts).toHaveLength(1);
    for (const [wait, attempts] of [
      [RETRY_BASE_MS, 2],
      [2 * RETRY_BASE_MS, 3],
      [4 * RETRY_BASE_MS, 4],
    ]) {
      // Meanwhile, more events don't send early.
      panel.track('Meanwhile');
      await vi.advanceTimersByTimeAsync(wait - 1);
      expect(net.attempts).toHaveLength(attempts - 1);
      await vi.advanceTimersByTimeAsync(1);
      expect(net.attempts).toHaveLength(attempts);
    }
    expect(net.names()).toEqual(['$app_opened', 'A', 'Meanwhile', 'Meanwhile', 'Meanwhile']);
    // The retried batch carries the same event ids, so the collector can drop a late duplicate.
    expect(net.attempts[0].batch.events.map((e) => e.event_id)).toEqual(net.attempts[1].batch.events.slice(0, 2).map((e) => e.event_id));
    panel.shutdown();
  });

  it('backs off up to a minute', async () => {
    vi.useFakeTimers();
    const { panel, net } = setup({ network: { answers: Array.from({ length: 9 }, () => 'error' as const) } });
    await panel.ready;
    await panel.flush();
    for (const wait of [1, 2, 4, 8, 16, 32, 60, 60].map((s) => s * 1000)) {
      const before = net.attempts.length;
      await vi.advanceTimersByTimeAsync(wait - 1);
      expect(net.attempts).toHaveLength(before);
      await vi.advanceTimersByTimeAsync(1);
      expect(net.attempts).toHaveLength(before + 1);
    }
    expect(RETRY_MAX_MS).toBe(60_000);
    panel.shutdown();
  });

  it('a send that never answers counts as failed', async () => {
    vi.useFakeTimers();
    const { panel, net } = setup();
    await panel.ready;
    net.fetch.mockImplementationOnce(() => new Promise<FetchResponse>(() => undefined));
    const flushed = panel.flush();
    await vi.advanceTimersByTimeAsync(SEND_TIMEOUT_MS);
    await flushed;
    await vi.advanceTimersByTimeAsync(RETRY_BASE_MS);
    expect(net.names()).toEqual(['$app_opened']);
    panel.shutdown();
  });

  it('drops a batch the collector refuses (4xx) instead of retrying it', async () => {
    vi.useFakeTimers();
    const { panel, net } = setup({ network: { answers: [400] } });
    await panel.ready;
    panel.track('Refused');
    await panel.flush();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(net.attempts).toHaveLength(1);
    panel.track('Next');
    await panel.flush();
    expect(net.names()).toEqual(['Next']);
    panel.shutdown();
  });

  it('an explicit flush() during the back-off tries again at once', async () => {
    vi.useFakeTimers();
    const { panel, net } = setup({ network: { answers: ['error'] } });
    await panel.ready;
    await panel.flush();
    expect(net.attempts).toHaveLength(1);
    await panel.flush();
    expect(net.attempts).toHaveLength(2);
    expect(net.names()).toEqual(['$app_opened']);
    panel.shutdown();
  });
});

describe('offline queue', () => {
  it('with consent, waiting events survive a restart and go first', async () => {
    vi.useFakeTimers();
    const storage = memoryStorage();
    const first = setup({ storage, network: { ...NO_CONSENT_NEEDED, answers: ['error'] } });
    await first.panel.ready;
    first.panel.identify('ann');
    first.panel.people.set({ plan: 'pro' });
    first.panel.group('company', 'acme');
    first.panel.track('Offline');
    await first.panel.flush();
    await first.idle();
    expect(first.net.sent).toHaveLength(0);
    const stored = storage.json(QUEUE) as { events: WireEvent[]; people: unknown[]; groups: unknown[] };
    expect(stored.events.map((e) => e.name)).toEqual(['$app_installed', '$app_opened', '$identify', 'Offline']);
    expect(stored.people).toHaveLength(1);
    expect(stored.groups).toHaveLength(1);
    first.panel.shutdown();

    const second = setup({ storage, network: NO_CONSENT_NEEDED });
    await second.panel.flush();
    await second.idle();
    expect(second.net.names()).toEqual(['$app_installed', '$app_opened', '$identify', 'Offline', '$app_opened']);
    expect(second.net.events()[3].event_id).toBe(stored.events[3].event_id);
    expect(second.net.sent[0].batch.people).toHaveLength(1);
    expect(second.net.sent[0].batch.groups).toHaveLength(1);
    expect(storage.data.has(QUEUE)).toBe(false);
    second.panel.shutdown();
  });

  it('without consent, waiting events stay in memory only', async () => {
    vi.useFakeTimers();
    const storage = memoryStorage();
    const { panel, idle, net } = setup({ storage, network: { answers: ['error'] } });
    await panel.ready;
    panel.track('Offline');
    panel.groups.set('company', 'acme', { plan: 'pro' });
    await panel.flush();
    await idle();
    expect(net.sent).toHaveLength(0);
    expect(storage.writes).toEqual([]);
    panel.shutdown();
  });

  it('keeps at most maxQueue events, dropping the oldest', async () => {
    const { panel, idle, net } = setup({ maxQueue: 5, flushAt: 100 });
    await panel.ready;
    for (let i = 0; i < 10; i++) panel.track(`E${i}`);
    await panel.flush();
    await idle();
    expect(net.names()).toEqual(['E5', 'E6', 'E7', 'E8', 'E9']);
  });

  it('events collected before consent leave without ids, those after with them', async () => {
    const { panel, idle, net } = setup();
    await panel.ready;
    panel.track('Before');
    panel.consent.grant();
    panel.track('After');
    await panel.flush();
    await idle();
    expect(net.sent.map((s) => [s.batch.consent, s.batch.events.map((e) => e.name)])).toEqual([
      [false, ['$app_opened', 'Before']],
      [true, ['$app_installed', 'After']],
    ]);
  });
});
