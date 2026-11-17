import { describe, expect, it } from 'vitest';
import { buildBatches, nextBatch, type QueuedEvent } from './batch';
import { normalizeEvent, screenUrl, utf8Length } from './event';
import { MAX_BATCH_BYTES, type WireGroupOp, type WirePeopleOp } from './wire';

const TOKEN = 'wpk_0123456789abcdef0123456789abcdef';

function queued(name: string, c: boolean, props?: Record<string, unknown>): QueuedEvent {
  const e = normalizeEvent({ name, url: 'app://com.acme.shop/', props });
  if (!e) throw new Error('invalid');
  return { e, c };
}

const peopleOp = (i: number, size = 0): WirePeopleOp => ({
  op: 'set',
  user_id: 'ann',
  ts: '2026-11-17T10:00:00.000Z',
  props: { [`p${i}`]: 'v'.repeat(size) },
});

describe('nextBatch', () => {
  it('takes only the leading events collected under the same consent', () => {
    const events = [queued('A', false), queued('B', false), queued('C', true), queued('D', false)];
    const plan = nextBatch({ token: TOKEN, events });
    expect(plan?.batch).toMatchObject({ token: TOKEN, lib: 'mobile', consent: false });
    expect(plan?.batch?.events.map((e) => e.name)).toEqual(['A', 'B']);
    expect(plan?.events).toEqual(events.slice(0, 2));
    expect(nextBatch({ token: TOKEN, events: [] })).toBeNull();
  });

  it('puts profile operations only in a batch sent with consent; group operations in any', () => {
    const people = [peopleOp(1)];
    const groups: WireGroupOp[] = [{ op: 'set', type: 'company', key: 'acme', props: {} }];
    const without = nextBatch({ token: TOKEN, events: [queued('A', false)], people, groups });
    expect(without?.batch?.people).toBeUndefined();
    expect(without?.batch?.groups).toEqual(groups);
    expect(without?.people).toEqual([]);
    const withConsent = nextBatch({ token: TOKEN, events: [queued('A', true)], people, groups });
    expect(withConsent?.batch?.people).toEqual(people);
  });

  it('uses up an event too large for any batch, and drops it', () => {
    const huge = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`k${i}`, 'x'.repeat(2048)]));
    const events = [queued('Huge', true, huge), queued('Fine', true)];
    const plan = nextBatch({ token: TOKEN, events });
    expect(plan?.batch?.events.map((e) => e.name)).toEqual(['Fine']);
    expect(plan?.events).toEqual(events);
    expect(nextBatch({ token: TOKEN, events: events.slice(0, 1) })).toEqual({ batch: null, events: events.slice(0, 1), people: [], groups: [] });
  });

  it('keeps operations in order: the first that does not fit waits with those after it', () => {
    const people = [peopleOp(1, 10), peopleOp(2, 64_000), peopleOp(3, 10)];
    const plan = nextBatch({ token: TOKEN, events: [queued('A', true, { s: 'y'.repeat(2000) })], people });
    expect(plan?.people).toEqual([people[0]]);
    expect(utf8Length(JSON.stringify(plan?.batch))).toBeLessThanOrEqual(MAX_BATCH_BYTES);
  });

  it('counts its bytes exactly: a batch filled to the limit is at most 64 KiB', () => {
    for (const fill of [1000, 1999, 2048]) {
      const events = Array.from({ length: 100 }, (_, i) => queued(`E${i}`, true, { a: 'é'.repeat(fill), b: '€'.repeat(fill % 7) }));
      const people = Array.from({ length: 60 }, (_, i) => peopleOp(i, fill % 300));
      const groups: WireGroupOp[] = Array.from({ length: 60 }, (_, i) => ({ op: 'set', type: 'company', key: `c${i}`, props: { n: 'ü'.repeat(fill % 200) } }));
      const plan = nextBatch({ token: TOKEN, events, people, groups });
      const size = utf8Length(JSON.stringify(plan?.batch));
      expect(size).toBeLessThanOrEqual(MAX_BATCH_BYTES);
      expect(size).toBeGreaterThan(MAX_BATCH_BYTES - 4000);
    }
  });
});

describe('buildBatches', () => {
  it('splits at 100 events and leaves nothing out', () => {
    const batches = buildBatches({
      token: TOKEN,
      consent: true,
      events: Array.from({ length: 230 }, (_, i) => ({ name: 'E', url: 'app://x/', props: { i } })),
    });
    expect(batches.map((b) => b.events.length)).toEqual([100, 100, 30]);
  });
});

describe('screenUrl', () => {
  it('builds app://<app id>/<screen> with the collector’s path rules', () => {
    expect(screenUrl('com.acme.shop', 'Product  Detail')).toBe('app://com.acme.shop/Product-Detail');
    expect(screenUrl('com.acme.shop', undefined)).toBe('app://com.acme.shop/');
    expect(screenUrl(undefined, 'Home')).toBe('app://app/Home');
    expect(screenUrl('my app!', 'Settings/Profile')).toBe('app://my-app-/Settings/Profile');
    expect(screenUrl('x', 'a'.repeat(500))).toBe(`app://x/${'a'.repeat(199)}`);
    expect(screenUrl('x', '\ud800 broken')).toBe('app://x/');
  });
});
