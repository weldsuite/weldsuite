import { describe, expect, it } from 'vitest';
import { MAX_IMPORT_EVENTS, MAX_TRACK_EVENTS, parseEventBatch, parseServerBatch } from './wire';

const TS = '2026-10-27T12:00:00.000Z';

const event = (overrides: Record<string, unknown> = {}) => ({
  event_id: 'evt_00000001',
  name: '$pageview',
  ts: TS,
  url: 'https://shop.example.com/',
  ...overrides,
});

const batch = (events: unknown[], extra: Record<string, unknown> = {}) => ({
  token: 'wpk_0123456789abcdef0123456789abcdef',
  sent_at: '2026-10-27T12:00:01.000Z',
  lib: 'web',
  lib_version: '0.1.0',
  consent: true,
  events,
  ...extra,
});

describe('phase 3 to 5 additions to the event batch', () => {
  it('accepts the new system events, user ids, click positions and error messages', () => {
    const parsed = parseEventBatch(
      batch([
        event({ name: '$identify', anon_id: 'a-1', user_id: 'user@example.com' }),
        event({
          event_id: 'evt_00000002',
          name: '$rageclick',
          x: 10,
          y: 20,
          rel_x: 0.25,
          rel_y: 1,
          el: { tag: 'button', selector: 'main > button', action: 'click' },
        }),
        event({
          event_id: 'evt_00000003',
          name: '$exception',
          error_message: 'x is not a function',
          props: { $source: 'app.js', $line: 12, $col: 3 },
        }),
        event({ event_id: 'evt_00000004', name: '$quickback', props: { $from: '/pricing' } }),
        event({ event_id: 'evt_00000005', name: '$excessivescroll', scroll_depth: 80 }),
        event({ event_id: 'evt_00000006', name: '$deadclick' }),
      ]),
    );

    expect(parsed.ok && parsed.dropped).toBe(0);
  });

  it('drops events with a bad user id, click position or reserved property', () => {
    const parsed = parseEventBatch(
      batch([
        event({ event_id: 'evt_00000001', user_id: '' }),
        event({ event_id: 'evt_00000002', user_id: 'a\nb' }),
        event({ event_id: 'evt_00000003', rel_x: 1.5 }),
        event({ event_id: 'evt_00000004', rel_y: -0.1 }),
        event({ event_id: 'evt_00000005', error_message: 'e'.repeat(1001) }),
        event({ event_id: 'evt_00000006', props: { $action: 'click' } }),
        event({ event_id: 'evt_00000007', user_id: 'u'.repeat(255) }),
      ]),
    );

    expect(parsed.ok && parsed.batch.events.map((e) => e.event_id)).toEqual(['evt_00000007']);
  });

  describe('people operations', () => {
    it('are read one by one, the unreadable ones dropped', () => {
      const parsed = parseEventBatch(
        batch([event()], {
          people: [
            { op: 'set', user_id: 'u1', ts: TS, props: { $email: 'A@B.com', plan: 'pro', seats: 3, trial: false, coupon: null } },
            { op: 'set_once', user_id: 'u1', ts: TS, props: { $created: '2026-01-01' } },
            { op: 'unset', user_id: 'u1', ts: TS, keys: ['plan', '$avatar'] },
            { op: 'increment', user_id: 'u1', ts: TS, props: { logins: 1 } },
            { op: 'increment', user_id: 'u1', ts: TS, props: { logins: 'one' } },
            { op: 'rename', user_id: 'u1', ts: TS },
            { op: 'set', user_id: '', ts: TS, props: {} },
            { op: 'set', user_id: 'u1', ts: TS, props: { 'bad-key': 1 } },
            { op: 'set', user_id: 'u1', ts: TS, props: { $secret: 1 } },
            { op: 'unset', user_id: 'u1', ts: TS, keys: Array.from({ length: 51 }, (_, i) => `k${i}`) },
          ],
        }),
      );

      expect(parsed.ok).toBe(true);
      if (!parsed.ok) return;
      expect(parsed.batch.people?.map((op) => op.op)).toEqual(['set', 'set_once', 'unset', 'increment']);
      expect(parsed.peopleDropped).toBe(6);
    });

    it('are left out of the batch when none is readable', () => {
      const parsed = parseEventBatch(batch([event()], { people: [{ op: 'nope' }] }));
      expect(parsed.ok && 'people' in parsed.batch).toBe(false);
    });

    it('are at most 50 per batch', () => {
      const op = { op: 'set', user_id: 'u1', ts: TS, props: {} };
      expect(parseEventBatch(batch([event()], { people: Array.from({ length: 51 }, () => op) })).ok).toBe(false);
      expect(parseEventBatch(batch([event()], { people: Array.from({ length: 50 }, () => op) })).ok).toBe(true);
    });
  });
});

describe('parseServerBatch', () => {
  const serverEvent = (overrides: Record<string, unknown> = {}) => ({
    event_id: 'evt_00000001',
    name: 'Order placed',
    ts: TS,
    distinct_id: 'user_1',
    ...overrides,
  });
  const server = (events: unknown[], extra: Record<string, unknown> = {}) => ({
    lib: 'server',
    lib_version: '0.1.0',
    events,
    ...extra,
  });

  it('reads events, with and without a url', () => {
    const parsed = parseServerBatch(
      server([
        serverEvent(),
        serverEvent({
          event_id: 'evt_00000002',
          url: 'https://shop.example.com/thanks',
          user_id: 'user_1',
          anon_id: 'a-1',
          props: { total: 12.5 },
        }),
      ]),
      MAX_TRACK_EVENTS,
    );

    expect(parsed.ok && parsed.batch.events).toHaveLength(2);
  });

  it('accepts a batch with only people operations (people.set without an event)', () => {
    const parsed = parseServerBatch(
      server([], { people: [{ op: 'set', user_id: 'user_1', ts: TS, props: { plan: 'pro' } }] }),
      MAX_TRACK_EVENTS,
    );

    expect(parsed.ok).toBe(true);
    expect(parsed.ok && parsed.batch.events).toHaveLength(0);
    expect(parsed.ok && parsed.batch.people).toHaveLength(1);
  });

  it('refuses a batch with neither events nor people operations', () => {
    expect(parseServerBatch(server([]), MAX_TRACK_EVENTS).ok).toBe(false);
    expect(parseServerBatch({ lib: 'server', lib_version: '0.1.0' }, MAX_TRACK_EVENTS).ok).toBe(false);
    expect(parseServerBatch(server([], { people: [{ op: 'nope' }] }), MAX_TRACK_EVENTS).ok).toBe(false);
  });

  it('drops events without a distinct_id or with a bad url and keeps the rest', () => {
    const parsed = parseServerBatch(
      server([
        serverEvent({ distinct_id: undefined }),
        serverEvent({ event_id: 'evt_00000002', url: 'nope' }),
        serverEvent({ event_id: 'evt_00000003' }),
      ]),
      MAX_TRACK_EVENTS,
    );

    expect(parsed.ok && parsed.batch.events.map((e) => e.event_id)).toEqual(['evt_00000003']);
    expect(parsed.ok && parsed.dropped).toBe(2);
  });

  it('refuses more events than the endpoint takes', () => {
    const events = Array.from({ length: 101 }, (_, i) => serverEvent({ event_id: `evt_${String(i).padStart(8, '0')}` }));

    expect(parseServerBatch(server(events), MAX_TRACK_EVENTS).ok).toBe(false);
    expect(parseServerBatch(server(events), MAX_IMPORT_EVENTS).ok).toBe(true);
  });

  it('wants a server envelope and at least one valid event', () => {
    expect(parseServerBatch({ ...server([serverEvent()]), lib: 'web' }, MAX_TRACK_EVENTS).ok).toBe(false);
    expect(parseServerBatch(server([]), MAX_TRACK_EVENTS).ok).toBe(false);
    expect(parseServerBatch(server([{ nope: true }]), MAX_TRACK_EVENTS).ok).toBe(false);
    expect(parseServerBatch('x', MAX_TRACK_EVENTS).ok).toBe(false);
  });

  it('carries valid people operations', () => {
    const parsed = parseServerBatch(
      server([serverEvent()], { people: [{ op: 'set', user_id: 'user_1', ts: TS, props: { plan: 'pro' } }, { op: 'x' }] }),
      MAX_TRACK_EVENTS,
    );

    expect(parsed.ok && parsed.batch.people).toHaveLength(1);
    expect(parsed.ok && parsed.peopleDropped).toBe(1);
  });
});
