// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LIB_VERSION } from './event';
import { createPanelServer, PanelServerError, toServerEvent } from './server';
import type { ServerBatch } from './wire';

const KEY = 'wps_0123456789abcdef0123456789abcdef';
const COLLECTOR = 'https://pnl.example.org';

interface Call {
  url: string;
  auth: string | null;
  body: ServerBatch;
}

let calls: Call[];
/** Answers to give, in order; the last one repeats. A thrown Error is a network failure. */
let answers: Array<{ status: number; body?: unknown } | Error>;

const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
  const body = JSON.parse(String(init.body)) as ServerBatch;
  calls.push({ url, auth: new Headers(init.headers).get('Authorization'), body });
  const answer = answers.length > 1 ? answers.shift()! : answers[0];
  if (answer instanceof Error) throw answer;
  const json = answer.body ?? { accepted: body.events.length, dropped: 0 };
  return new Response(JSON.stringify(json), { status: answer.status, headers: { 'Content-Type': 'application/json' } });
});

beforeEach(() => {
  calls = [];
  answers = [{ status: 200 }];
  fetchMock.mockClear();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const server = (extra = {}) => createPanelServer({ secretKey: KEY, collectorUrl: `${COLLECTOR}/`, fetch: fetchMock as unknown as typeof fetch, ...extra });

describe('createPanelServer()', () => {
  it('wants a secret key', () => {
    expect(() => createPanelServer({ secretKey: 'wpk_0123456789abcdef0123456789abcdef' })).toThrow(TypeError);
  });

  it('sends queued events to /v1/track with the key, on flush()', async () => {
    const panel = server();
    panel.track({
      name: 'Subscription renewed',
      distinctId: 'user-1',
      userId: 'user-1',
      url: 'https://shop.example.com/billing',
      props: { plan: 'pro', amount: 49, $source: 'nope' },
      timestamp: '2026-11-14T10:00:00Z',
      eventId: 'evt_00000001',
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await panel.flush()).toEqual({ accepted: 1, dropped: 0 });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`${COLLECTOR}/v1/track`);
    expect(calls[0].auth).toBe(`Bearer ${KEY}`);
    expect(calls[0].body).toEqual({
      lib: 'server',
      lib_version: LIB_VERSION,
      events: [
        {
          event_id: 'evt_00000001',
          name: 'Subscription renewed',
          ts: '2026-11-14T10:00:00.000Z',
          distinct_id: 'user-1',
          user_id: 'user-1',
          url: 'https://shop.example.com/billing',
          props: { plan: 'pro', amount: 49 },
        },
      ],
    });
    // Nothing left to send.
    expect(await panel.flush()).toEqual({ accepted: 0, dropped: 0 });
    expect(calls).toHaveLength(1);
  });

  it('drops invalid events here and counts them', async () => {
    const panel = server();
    panel.track({ name: '$custom', distinctId: 'u' });
    panel.track({ name: 'Ok', distinctId: '' });
    panel.track({ name: 'Ok', distinctId: 'u' });
    expect(await panel.flush()).toEqual({ accepted: 1, dropped: 2 });
  });

  it('sends 100 events a request, starting as soon as 100 are waiting', async () => {
    const panel = server();
    for (let i = 0; i < 250; i++) panel.track({ name: 'Ping', distinctId: `u${i}` });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(await panel.flush()).toEqual({ accepted: 250, dropped: 0 });
    expect(calls.map((c) => c.body.events.length)).toEqual([100, 100, 50]);
  });

  it('identify() links an anonymous id to the user', async () => {
    const panel = server();
    panel.identify({ userId: 'user-1', anonId: 'a_123' });
    panel.identify({ userId: 'user-1', anonId: '' });
    expect(await panel.flush()).toMatchObject({ accepted: 1, dropped: 1 });
    expect(calls[0].body.events[0]).toMatchObject({ name: '$identify', distinct_id: 'user-1', user_id: 'user-1', anon_id: 'a_123' });
  });

  it('people.* go with the events; email and name are the profile fields', async () => {
    const panel = server();
    panel.track({ name: 'Signed up', distinctId: 'user-1' });
    panel.people.set('user-1', { email: 'ann@example.com', plan: 'pro' });
    panel.people.set_once('user-1', { first_plan: 'free' });
    panel.people.unset('user-1', 'trial');
    panel.people.increment('user-1', 'logins');
    panel.people.increment('user-1', { credits: -5 });
    panel.people.set('', { plan: 'x' });
    expect(await panel.flush()).toEqual({ accepted: 1, dropped: 1 });
    expect(calls[0].body.people?.map(({ ts: _ts, ...op }) => op)).toEqual([
      { op: 'set', user_id: 'user-1', props: { $email: 'ann@example.com', plan: 'pro' } },
      { op: 'set_once', user_id: 'user-1', props: { first_plan: 'free' } },
      { op: 'unset', user_id: 'user-1', keys: ['trial'] },
      { op: 'increment', user_id: 'user-1', props: { logins: 1 } },
      { op: 'increment', user_id: 'user-1', props: { credits: -5 } },
    ]);
  });

  it('profile updates without events go on their own', async () => {
    const panel = server();
    panel.people.set('user-1', { plan: 'pro' });
    await panel.flush();
    expect(calls[0].body).toMatchObject({ events: [], people: [{ op: 'set', user_id: 'user-1' }] });
  });

  it('import() sends up to 1000 events a request to /v1/import', async () => {
    const panel = server();
    const events = Array.from({ length: 2500 }, (_, i) => ({ name: 'Order placed', distinctId: `u${i}`, timestamp: '2024-01-01T00:00:00Z' }));
    expect(await panel.import([...events, { name: '', distinctId: 'u' }])).toEqual({ accepted: 2500, dropped: 1 });
    expect(calls.map((c) => [c.url, c.body.events.length])).toEqual([
      [`${COLLECTOR}/v1/import`, 1000],
      [`${COLLECTOR}/v1/import`, 1000],
      [`${COLLECTOR}/v1/import`, 500],
    ]);
  });
});

describe('errors', () => {
  it('a bad or revoked key rejects flush() with a PanelServerError', async () => {
    answers = [{ status: 401, body: { error: { code: 'unauthorized', message: 'Send a valid secret key as a Bearer token' } } }];
    const panel = server();
    panel.track({ name: 'Ping', distinctId: 'u' });
    const error = await panel.flush().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PanelServerError);
    expect(error).toMatchObject({ status: 401, code: 'unauthorized' });
    expect(calls).toHaveLength(1);
  });

  it('retries once after a network failure or a 5xx', async () => {
    vi.useFakeTimers();
    answers = [new TypeError('fetch failed'), { status: 200 }, { status: 503 }, { status: 200 }];
    const panel = server();
    panel.track({ name: 'Ping', distinctId: 'u' });
    const first = panel.flush();
    await vi.advanceTimersByTimeAsync(1000);
    expect(await first).toEqual({ accepted: 1, dropped: 0 });

    panel.track({ name: 'Ping', distinctId: 'u' });
    const second = panel.flush();
    await vi.advanceTimersByTimeAsync(1000);
    expect(await second).toEqual({ accepted: 1, dropped: 0 });
    // Each flush: a failed first try, then the retry.
    expect(calls).toHaveLength(4);
  });

  it('a failure in a send started by a full queue goes to onError', async () => {
    answers = [{ status: 400, body: { error: { code: 'invalid_batch', message: 'events.0.ts: Invalid datetime' } } }];
    const onError = vi.fn();
    const panel = server({ onError });
    for (let i = 0; i < 100; i++) panel.track({ name: 'Ping', distinctId: 'u' });
    await vi.waitFor(() => expect(onError).toHaveBeenCalledWith(expect.any(PanelServerError)));
  });
});

describe('toServerEvent()', () => {
  it('makes an event id without the global Web Crypto (Node 18)', () => {
    vi.stubGlobal('crypto', undefined);
    const event = toServerEvent({ name: 'Ping', distinctId: 'u' })!;
    expect(event.event_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});
