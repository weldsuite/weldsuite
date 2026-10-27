import { describe, expect, it } from 'vitest';
import { buildBatch, buildBatches } from './batch';
import { cleanProps, normalizeEvent, utf8Length } from './event';
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
    });
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
