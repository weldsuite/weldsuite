import { describe, expect, it } from 'vitest';
import { buildBatch, buildBatches } from './batch';
import { cleanProps, normalizeEvent, normalizePeopleOp, utf8Length } from './event';
import { excludedMatcher, resolveConfig } from './config';
import { MAX_BATCH_BYTES, MAX_EVENTS_PER_BATCH } from './wire';

const URL_ = 'https://shop.example.com/';
/** `{ p0: value(0), p1: value(1), … }` */
const record = (n: number, value: (i: number) => unknown, prefix = 'p') => {
  const out: Record<string, unknown> = {};
  for (let i = 0; i < n; i++) out[prefix + i] = value(i);
  return out;
};
const bytes = (v: unknown) => new TextEncoder().encode(JSON.stringify(v)).length;
const events = (n: number, extra = {}) =>
  Array.from({ length: n }, (_, i) => ({ name: 'Viewed item', url: URL_, event_id: `evt_${String(i).padStart(8, '0')}`, ...extra }));

describe('buildBatches', () => {
  it('splits by count', () => {
    const batches = buildBatches({ token: 'wpk_x', consent: false, events: events(250) });
    expect(batches.map((b) => b.events.length)).toEqual([100, 100, 50]);
    expect(batches[0]).toMatchObject({ token: 'wpk_x', lib: 'web', consent: false });
  });

  it('splits by size, every batch within 64 KiB, nothing lost', () => {
    const big = { props: { a: 'é'.repeat(2048), b: '😀'.repeat(1024), c: 'x'.repeat(2048) } };
    const batches = buildBatches({ token: 'wpk_x', consent: true, events: events(40, big) });
    expect(batches.length).toBeGreaterThan(1);
    for (const b of batches) {
      expect(bytes(b)).toBeLessThanOrEqual(MAX_BATCH_BYTES);
      expect(b.events.length).toBeLessThanOrEqual(MAX_EVENTS_PER_BATCH);
    }
    expect(batches.reduce((n, b) => n + b.events.length, 0)).toBe(40);
  });

  it('fills a batch right up to the byte limit', () => {
    const batches = buildBatches({ token: 'wpk_x', consent: true, events: events(60, { props: { a: 'x'.repeat(2000) } }) });
    const [first, second] = batches;
    expect(bytes(first)).toBeLessThanOrEqual(MAX_BATCH_BYTES);
    // One more event would not have fitted.
    expect(bytes({ ...first, events: [...first.events, second.events[0]] })).toBeGreaterThan(MAX_BATCH_BYTES);
  });

  it('leaves out an event too big for any batch, and invalid events', () => {
    const huge = { name: 'Huge', url: URL_, props: record(40, () => 'x'.repeat(2048)) };
    const batches = buildBatches({
      token: 'wpk_x',
      consent: false,
      events: [huge, { name: '', url: URL_ }, { name: 'Ok', url: 'not a url' }, { name: 'Ok', url: URL_ }],
    });
    expect(batches).toHaveLength(1);
    expect(batches[0].events.map((e) => e.name)).toEqual(['Ok']);
  });

  it('returns nothing for no valid events', () => {
    expect(buildBatches({ token: 'wpk_x', consent: false, events: [] })).toEqual([]);
  });
});

describe('buildBatches with profile operations', () => {
  const op = (i: number) => ({ op: 'set' as const, user_id: 'user-1', ts: '2026-11-14T10:00:00.000Z', props: { n: i } });

  it('adds them to the event batches, at most 50 a batch', () => {
    const ops = Array.from({ length: 120 }, (_, i) => op(i));
    const batches = buildBatches({ token: 'wpk_x', consent: true, events: events(250), people: ops });
    expect(batches.map((b) => b.people?.length)).toEqual([50, 50, 20]);
    expect(batches[0].people?.[0]).toEqual(op(0));
  });

  it('sends none without consent, and none without events', () => {
    expect(buildBatches({ token: 'wpk_x', consent: false, events: events(1), people: [op(1)] })[0].people).toBeUndefined();
    expect(buildBatches({ token: 'wpk_x', consent: true, events: [], people: [op(1)] })).toEqual([]);
  });

  it('keeps every batch within 64 KiB', () => {
    const big = (i: number) => ({ op: 'set' as const, user_id: 'user-1', props: record(8, () => 'x'.repeat(2000), `p${i}_`) });
    const batches = buildBatches({
      token: 'wpk_x',
      consent: true,
      events: events(60, { props: { a: 'x'.repeat(1500) } }),
      people: Array.from({ length: 6 }, (_, i) => big(i)),
    });
    for (const b of batches) expect(bytes(b)).toBeLessThanOrEqual(MAX_BATCH_BYTES);
    // The first batch is nearly full of events; the second has room for some operations, the rest are left out.
    expect(batches[0].people).toBeUndefined();
    expect(batches[1].people?.length).toBeGreaterThan(0);
    expect(batches[1].people?.length).toBeLessThan(6);
  });
});

describe('normalizePeopleOp', () => {
  it('maps email and name to the profile fields and drops what the collector refuses', () => {
    expect(normalizePeopleOp({ op: 'set', user_id: ' user-1 ', ts: 0, props: { email: 'a@b.co', name: 'Ann', plan: 'pro', $evil: 1, nested: {} } })).toEqual({
      op: 'set',
      user_id: 'user-1',
      ts: '1970-01-01T00:00:00.000Z',
      props: { $email: 'a@b.co', $name: 'Ann', plan: 'pro' },
    });
  });

  it('keeps numbers only for increment, and keys for unset', () => {
    expect(normalizePeopleOp({ op: 'increment', user_id: 'u', props: { logins: 1, plan: 'pro' } })).toMatchObject({ props: { logins: 1 } });
    expect(normalizePeopleOp({ op: 'unset', user_id: 'u', keys: ['email', 'plan', 'plan', 'bad key'] })).toMatchObject({ keys: ['$email', 'plan'] });
  });

  it('returns null without a valid user id or anything to change', () => {
    expect(normalizePeopleOp({ op: 'set', user_id: '', props: { a: 1 } })).toBeNull();
    expect(normalizePeopleOp({ op: 'set', user_id: 'x'.repeat(256), props: { a: 1 } })).toBeNull();
    expect(normalizePeopleOp({ op: 'set', user_id: 'tab	here', props: { a: 1 } })).toBeNull();
    expect(normalizePeopleOp({ op: 'set', user_id: 'u', props: { 'bad key': 1 } })).toBeNull();
    expect(normalizePeopleOp({ op: 'unset', user_id: 'u', keys: [] })).toBeNull();
  });
});

describe('buildBatch', () => {
  it('builds one batch', () => {
    const batch = buildBatch({ token: 'wpk_x', consent: false, events: events(3), sentAt: '2026-10-27T10:00:00Z', libVersion: '9.9.9' });
    expect(batch).toMatchObject({ sent_at: '2026-10-27T10:00:00.000Z', lib_version: '9.9.9' });
    expect(batch.events).toHaveLength(3);
  });

  it('throws when the events do not fit in one, or none is valid', () => {
    expect(() => buildBatch({ token: 'wpk_x', consent: false, events: events(101) })).toThrow(RangeError);
    expect(() => buildBatch({ token: 'wpk_x', consent: false, events: [{ name: '$nope', url: URL_ }] })).toThrow(RangeError);
  });
});

describe('normalizeEvent', () => {
  it('accepts the system names and custom names, nothing else', () => {
    for (const name of ['$pageview', '$pageleave', '$autocapture', 'Signed up', 'checkout:step/2', 'a.b-c_d']) {
      expect(normalizeEvent({ name, url: URL_ })?.name).toBe(name);
    }
    for (const name of ['$custom', '', ' leading space', 'emoji 😀', 'x'.repeat(101), 'semi;colon']) {
      expect(normalizeEvent({ name, url: URL_ })).toBeNull();
    }
  });

  it('clamps fields to what the collector accepts', () => {
    const e = normalizeEvent({
      name: '$autocapture',
      url: `${URL_}?q=${'a'.repeat(3000)}#${'h'.repeat(10)}`,
      event_id: 'short',
      ts: 'garbage',
      title: 't'.repeat(600),
      referrer: '',
      viewport_w: 1280.6,
      x: -5,
      y: 2000000,
      scroll_depth: 140,
      el: { tag: 'CUSTOM-ELEMENT-WITH-A-VERY-LONG-NAME', selector: 's'.repeat(600), text: 'x'.repeat(300), action: 'click' },
    })!;
    expect(e.url).toBe(URL_);
    expect(e.event_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(new Date(e.ts).toISOString()).toBe(e.ts);
    expect(e.title).toHaveLength(512);
    expect(e.referrer).toBeUndefined();
    expect(e).toMatchObject({ viewport_w: 1281, x: 0, y: 1000000, scroll_depth: 100 });
    expect(e.el?.tag.length).toBeLessThanOrEqual(32);
    expect(e.el?.selector).toHaveLength(512);
    expect(e.el?.text).toHaveLength(255);
  });

  it('keeps user_id, rel_x / rel_y and error_message, clamped', () => {
    const e = normalizeEvent({ name: '$exception', url: URL_, user_id: ' 42 ', rel_x: 1.5, rel_y: 0.123456, error_message: 'm'.repeat(1200), props: { $source: 'https://x/app.js', $line: 3, $nope: 1 } })!;
    expect(e).toMatchObject({ user_id: '42', rel_x: 1, rel_y: 0.1235 });
    expect(e.error_message).toHaveLength(1000);
    expect(e.props).toEqual({ $source: 'https://x/app.js', $line: 3 });
    expect(normalizeEvent({ name: 'X', url: URL_, user_id: 'x'.repeat(300) })!.user_id).toBeUndefined();
  });

  it('is idempotent', () => {
    const once = normalizeEvent({ name: 'Signed up', url: URL_, props: { plan: 'pro', seats: 3 } })!;
    expect(normalizeEvent(once)).toEqual(once);
  });
});

describe('cleanProps', () => {
  it('keeps flat primitives with identifier keys, at most 50', () => {
    const dropped: string[] = [];
    const many = record(60, (i) => i, 'k');
    const props = cleanProps({ ok: 'x', n: 1.5, b: false, z: null, 'bad key': 1, $x: 1, arr: [1], obj: {}, inf: Infinity, ...many }, (k) =>
      dropped.push(k),
    )!;
    expect(Object.keys(props)).toHaveLength(50);
    expect(props).toMatchObject({ ok: 'x', n: 1.5, b: false, z: null });
    expect(dropped).toEqual(expect.arrayContaining(['bad key', '$x', 'arr', 'obj', 'inf', 'k59']));
  });
});

describe('utf8Length', () => {
  it('matches TextEncoder', () => {
    for (const s of ['plain', 'héllo', '日本語', 'emoji 😀 and 👩‍👩‍👧', JSON.stringify('lone \ud800 surrogate')]) {
      expect(utf8Length(s)).toBe(new TextEncoder().encode(s).length);
    }
  });
});

describe('config', () => {
  it('falls back to the more private choice for values it does not know', () => {
    expect(resolveConfig({ consentMode: 'maybe' as 'none', maskingLevel: 'loose' as 'relaxed' })).toEqual({
      autocapture: true,
      consentMode: 'required',
      maskingLevel: 'strict',
      excludedUrls: [],
      recordingSampleRate: 0,
      recordingBlocked: true,
      snapshot: null,
    });
  });

  it('reads the recording fields, clamping the sample rate and checking the snapshot request', () => {
    const snapshot = { pageGroupId: 'pnh_1', urlPattern: '/products/*', deviceClass: 'mobile' as const };
    expect(resolveConfig({ recordingSampleRate: 0.25, recordingBlocked: false, snapshot })).toMatchObject({
      recordingSampleRate: 0.25,
      recordingBlocked: false,
      snapshot,
    });
    expect(resolveConfig({ recordingSampleRate: 7 }).recordingSampleRate).toBe(1);
    expect(resolveConfig({ recordingSampleRate: -1 }).recordingSampleRate).toBe(0);
    expect(resolveConfig({ snapshot: { ...snapshot, deviceClass: 'watch' as 'mobile' } }).snapshot).toBeNull();
  });

  it('matches excluded URL patterns against the whole path', () => {
    const excluded = excludedMatcher(['/admin/*', '/checkout/*/pay', '/a.b', '/über/*']);
    expect(excluded('/admin/users')).toBe(true);
    expect(excluded('/admin')).toBe(false);
    expect(excluded('/shop/admin/x')).toBe(false);
    expect(excluded('/checkout/123/pay')).toBe(true);
    expect(excluded('/checkout/123/pay/more')).toBe(false);
    expect(excluded('/a.b')).toBe(true);
    expect(excluded('/aXb')).toBe(false);
    expect(excluded('/%C3%BCber/x')).toBe(true);
    expect(excludedMatcher([])('/anything')).toBe(false);
  });
});
