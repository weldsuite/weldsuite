import { describe, expect, it } from 'vitest';
import { NOW, projectRecord, wireBatch, wireEvent } from '../testing/fakes';
import { buildEventRows, consentedAnonId, correctTimestamp, type RowSource } from './rows';

const iso = (ms: number) => new Date(ms).toISOString();
const SECOND = 1000;
const DAY = 24 * 60 * 60 * SECOND;

describe('correctTimestamp', () => {
  it('keeps an event on a correct clock where it was (plus the time in flight)', () => {
    // Event 2 s before the send, received 150 ms after it.
    const ts = correctTimestamp(iso(NOW - 2 * SECOND), iso(NOW), NOW + 150);
    expect(ts).toBe(NOW - 2 * SECOND + 150);
  });

  it('moves events forward when the client clock is behind', () => {
    // Client thinks it is an hour earlier than it is: ts and sent_at are both an hour off.
    const behind = 60 * 60 * SECOND;
    expect(correctTimestamp(iso(NOW - behind - 5 * SECOND), iso(NOW - behind), NOW)).toBe(NOW - 5 * SECOND);
  });

  it('moves events back when the client clock is ahead', () => {
    const ahead = 3 * 60 * 60 * SECOND;
    expect(correctTimestamp(iso(NOW + ahead - 5 * SECOND), iso(NOW + ahead), NOW)).toBe(NOW - 5 * SECOND);
  });

  it('clamps to a week back and a minute ahead', () => {
    // An event queued offline for a month.
    expect(correctTimestamp(iso(NOW - 30 * DAY), iso(NOW), NOW)).toBe(NOW - 7 * DAY);
    // An event stamped after the send.
    expect(correctTimestamp(iso(NOW + 10 * 60 * SECOND), iso(NOW), NOW)).toBe(NOW + 60 * SECOND);
  });
});

describe('consentedAnonId', () => {
  it('uses the id only with consent', () => {
    expect(consentedAnonId({ consent: true }, { anon_id: 'abc123' })).toBe('abc123');
    expect(consentedAnonId({ consent: false }, { anon_id: 'abc123' })).toBeNull();
  });

  it('gives null when the event carries no id', () => {
    expect(consentedAnonId({ consent: true }, {})).toBeNull();
    expect(consentedAnonId({ consent: true }, { anon_id: '' })).toBeNull();
  });

  it('never accepts an id that looks like a cookieless hash', () => {
    expect(consentedAnonId({ consent: true }, { anon_id: 'ck_0123456789abcdef01234567' })).toBeNull();
  });
});

function source(overrides: Partial<RowSource> = {}): RowSource {
  return {
    record: projectRecord(),
    batch: wireBatch(),
    receivedAt: NOW,
    userAgent: { deviceType: 'desktop', browser: 'Chrome', os: 'Windows' },
    geo: { country: 'NL', region: 'North Holland', city: 'Amsterdam' },
    cookielessId: 'ck_cookieless00000000000000',
    ...overrides,
  };
}

describe('buildEventRows', () => {
  it('fills the standard columns of a pageview and leaves the later phases null', () => {
    const [row] = buildEventRows(
      source({
        batch: wireBatch({
          events: [
            wireEvent({
              title: 'Shoes',
              referrer: 'https://www.google.com/search?q=shoes',
              viewport_w: 1440,
              props: { plan: 'pro', seats: 3 },
            }),
          ],
        }),
      }),
    );

    expect(row).toEqual({
      event_id: 'evt-00000001',
      workspace_id: 'ws_test_workspace',
      project_id: 'pnp_test_project',
      name: '$pageview',
      ts: iso(NOW - 2 * SECOND),
      received_at: iso(NOW),
      distinct_id: 'ck_cookieless00000000000000',
      anon_id: 'ck_cookieless00000000000000',
      user_id: null,
      session_id: null,
      cookieless: true,
      url: 'https://shop.example.com/products?utm_source=news',
      host: 'shop.example.com',
      path: '/products',
      title: 'Shoes',
      referrer: 'https://www.google.com/search?q=shoes',
      referrer_host: 'www.google.com',
      utm_source: 'news',
      utm_medium: null,
      utm_campaign: null,
      utm_content: null,
      utm_term: null,
      country: 'NL',
      region: 'North Holland',
      city: 'Amsterdam',
      device_type: 'desktop',
      browser: 'Chrome',
      os: 'Windows',
      viewport_w: 1440,
      el_tag: null,
      el_selector: null,
      el_text: null,
      x: null,
      y: null,
      rel_x: null,
      rel_y: null,
      scroll_depth: null,
      error_message: null,
      properties: '{"plan":"pro","seats":3}',
      lib: 'web',
      lib_version: '0.1.0',
    });
  });

  it('carries the element, position and scroll depth of autocapture and pageleave events', () => {
    const rows = buildEventRows(
      source({
        batch: wireBatch({
          events: [
            wireEvent({
              event_id: 'evt-click-001',
              name: '$autocapture',
              el: { tag: 'button', selector: 'main > button.buy', text: 'Buy now', action: 'click' },
              x: 412,
              y: 980,
            }),
            wireEvent({ event_id: 'evt-leave-001', name: '$pageleave', scroll_depth: 72 }),
          ],
        }),
      }),
    );

    expect(rows[0]).toMatchObject({ el_tag: 'button', el_selector: 'main > button.buy', el_text: 'Buy now', x: 412, y: 980, scroll_depth: null });
    expect(rows[1]).toMatchObject({ el_tag: null, scroll_depth: 72, x: null });
  });

  it('writes {} when an event has no properties', () => {
    expect(buildEventRows(source())[0]!.properties).toBe('{}');
  });

  it('uses the browser ids only with consent, and marks the row accordingly', () => {
    const batch = wireBatch({
      consent: true,
      events: [wireEvent({ anon_id: 'anon-abc', session_id: 'sess-123' })],
    });
    expect(buildEventRows(source({ batch }))[0]).toMatchObject({
      anon_id: 'anon-abc',
      distinct_id: 'anon-abc',
      session_id: 'sess-123',
      cookieless: false,
    });
  });

  it('ignores ids the browser sends without consent', () => {
    const batch = wireBatch({
      consent: false,
      events: [wireEvent({ anon_id: 'anon-abc', session_id: 'sess-123' })],
    });
    expect(buildEventRows(source({ batch }))[0]).toMatchObject({
      anon_id: 'ck_cookieless00000000000000',
      session_id: null,
      cookieless: true,
    });
  });

  it('treats a consented event without an id as cookieless, and drops its session id', () => {
    const batch = wireBatch({ consent: true, events: [wireEvent({ session_id: 'sess-123' })] });
    expect(buildEventRows(source({ batch }))[0]).toMatchObject({ session_id: null, cookieless: true });
  });

  it('mixes consented and cookieless events of one batch', () => {
    const batch = wireBatch({
      consent: true,
      events: [wireEvent({ event_id: 'evt-with-id1', anon_id: 'anon-abc' }), wireEvent({ event_id: 'evt-no-id-01' })],
    });
    const rows = buildEventRows(source({ batch }));
    expect(rows.map((r) => [r.event_id, r.cookieless])).toEqual([
      ['evt-with-id1', false],
      ['evt-no-id-01', true],
    ]);
  });

  it('leaves out events that need a cookieless id when there is none', () => {
    const batch = wireBatch({
      consent: true,
      events: [wireEvent({ event_id: 'evt-with-id1', anon_id: 'anon-abc' }), wireEvent({ event_id: 'evt-no-id-01' })],
    });
    expect(buildEventRows(source({ batch, cookielessId: null })).map((r) => r.event_id)).toEqual(['evt-with-id1']);
  });

  it('strips secrets from the page URL and the referrer', () => {
    const batch = wireBatch({
      events: [
        wireEvent({
          url: 'https://shop.example.com/reset?token=abc&email=a%40b.com&lang=nl#access_token=zzz',
          referrer: 'https://mail.example.com/inbox?auth=secret&folder=1',
        }),
      ],
    });
    expect(buildEventRows(source({ batch }))[0]).toMatchObject({
      url: 'https://shop.example.com/reset?lang=nl',
      path: '/reset',
      referrer: 'https://mail.example.com/inbox?folder=1',
      referrer_host: 'mail.example.com',
    });
  });

  it('leaves out events on excluded paths, only those', () => {
    const record = projectRecord({ settings: { ...projectRecord().settings, excludedUrls: ['/admin/*'] } });
    const batch = wireBatch({
      events: [
        wireEvent({ event_id: 'evt-public-01', url: 'https://shop.example.com/products' }),
        wireEvent({ event_id: 'evt-admin-001', url: 'https://shop.example.com/admin/users' }),
      ],
    });
    expect(buildEventRows(source({ record, batch })).map((r) => r.event_id)).toEqual(['evt-public-01']);
  });

  it('leaves out events that are not on an http(s) page', () => {
    const batch = wireBatch({ events: [wireEvent({ url: 'file:///Users/me/page.html' })] });
    expect(buildEventRows(source({ batch }))).toEqual([]);
  });

  it('corrects each event by the batch clock skew', () => {
    const behind = 2 * 60 * 60 * SECOND;
    const batch = wireBatch({
      sent_at: iso(NOW - behind),
      events: [wireEvent({ ts: iso(NOW - behind - 3 * SECOND) })],
    });
    expect(buildEventRows(source({ batch }))[0]!.ts).toBe(iso(NOW - 3 * SECOND));
  });
});
