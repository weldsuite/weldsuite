import { describe, expect, it } from 'vitest';
import { CUSTOM_EVENT_NAME, parseEventBatch } from './wire';

const event = (overrides: Record<string, unknown> = {}) => ({
  event_id: 'evt_00000001',
  name: '$pageview',
  ts: '2026-10-27T12:00:00.000Z',
  url: 'https://shop.example.com/',
  ...overrides,
});

const batch = (events: unknown[]) => ({
  token: 'wpk_0123456789abcdef0123456789abcdef',
  sent_at: '2026-10-27T12:00:01.000Z',
  lib: 'web',
  lib_version: '0.1.0',
  consent: false,
  events,
});

describe('parseEventBatch', () => {
  it('drops the invalid events of a batch and keeps the rest', () => {
    const parsed = parseEventBatch(batch([event(), event({ url: 'not a url' }), event({ event_id: 'evt_00000002' })]));

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.batch.events.map((e) => e.event_id)).toEqual(['evt_00000001', 'evt_00000002']);
    expect(parsed.dropped).toBe(1);
  });

  it('fails a batch whose events are all invalid, pointing at the first', () => {
    const parsed = parseEventBatch(batch([event({ url: 'nope' }), event({ name: '$madeup' })]));

    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.issues[0]?.path.slice(0, 3)).toEqual(['events', 0, 'url']);
  });

  it('checks the envelope strictly', () => {
    expect(parseEventBatch({ ...batch([event()]), consent: 'yes' }).ok).toBe(false);
    expect(parseEventBatch(batch([])).ok).toBe(false);
    expect(parseEventBatch(batch(Array.from({ length: 101 }, () => event()))).ok).toBe(false);
  });
});

describe('custom event names', () => {
  it('take what a person would type', () => {
    for (const name of ['Signed up', 'checkout:started', 'plan/upgrade', 'a', 'A'.repeat(100)]) {
      expect(CUSTOM_EVENT_NAME.test(name), name).toBe(true);
    }
  });

  it('refuse leading or trailing spaces, $ names and over 100 characters', () => {
    for (const name of ['Signed up ', ' Signed up', '$pageview', 'A'.repeat(101), '']) {
      expect(CUSTOM_EVENT_NAME.test(name), name).toBe(false);
    }
  });
});
