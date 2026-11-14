/**
 * The SDK's plain copy of the wire format against the collector's Zod schema.
 *
 * Imported by relative path on purpose: the domain package (and zod) must
 * never become a dependency of the SDK bundle, only of this test. panel-ingest
 * runs the same check from its side.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import * as deviceClass from '../../../domains/panel/src/device-class';
import * as domain from '../../../domains/panel/src/wire';
import { buildBatches } from './batch';
import { createPanelServer } from './server';
import { resetPage, setup } from './test/harness';
import * as sdk from './wire';

afterEach(resetPage);

describe('wire contract', () => {
  it('has the same limits, names and patterns as the collector', () => {
    expect(sdk.MAX_EVENTS_PER_BATCH).toBe(domain.MAX_EVENTS_PER_BATCH);
    expect(sdk.MAX_BATCH_BYTES).toBe(domain.MAX_BATCH_BYTES);
    expect(sdk.MAX_PROPERTIES).toBe(domain.MAX_PROPERTIES);
    expect(sdk.MAX_STRING).toBe(domain.MAX_STRING);
    expect(sdk.MAX_ELEMENT_TEXT).toBe(domain.MAX_ELEMENT_TEXT);
    expect(sdk.MAX_ERROR_MESSAGE).toBe(domain.MAX_ERROR_MESSAGE);
    expect(sdk.MAX_PEOPLE_OPS_PER_BATCH).toBe(domain.MAX_PEOPLE_OPS_PER_BATCH);
    expect(sdk.MAX_UNSET_KEYS).toBe(domain.MAX_UNSET_KEYS);
    expect(sdk.MAX_TRACK_EVENTS).toBe(domain.MAX_TRACK_EVENTS);
    expect(sdk.MAX_IMPORT_EVENTS).toBe(domain.MAX_IMPORT_EVENTS);
    expect([...sdk.SYSTEM_EVENTS].sort()).toEqual([...domain.SYSTEM_EVENTS].sort());
    expect(sdk.CUSTOM_EVENT_NAME.source).toBe(domain.CUSTOM_EVENT_NAME.source);
    expect(sdk.PROPERTY_KEY.source).toBe(domain.PROPERTY_KEY.source);
    expect(sdk.EVENT_PROPERTY_KEY.source).toBe(domain.EVENT_PROPERTY_KEY.source);
    expect(sdk.PROFILE_PROPERTY_KEY.source).toBe(domain.PROFILE_PROPERTY_KEY.source);
    expect(sdk.USER_ID.source).toBe(domain.USER_ID.source);
  });

  it('splits device classes where the collector does', () => {
    for (const width of [0, 320, 767, 768, 1023, 1024, 1920, 20000]) {
      expect(sdk.deviceClassFromViewport(width)).toBe(deviceClass.deviceClassFromViewport(width));
    }
  });

  it('every batch the builder makes from awkward input passes the collector schema', () => {
    const awkward = [
      { name: '$pageview', url: `https://shop.example.com/${'p'.repeat(3000)}`, title: 't'.repeat(900), referrer: 'r'.repeat(5000) },
      { name: '$autocapture', url: 'https://shop.example.com/', x: -3.7, y: 1e9, viewport_w: 99999.5, rel_x: -0.2, rel_y: 1.7, el: { tag: 'x'.repeat(50), selector: 's'.repeat(900), text: 'y'.repeat(900), action: 'click' as const } },
      { name: '$pageleave', url: 'https://shop.example.com/', scroll_depth: 250.2 },
      { name: 'Custom', url: 'https://shop.example.com/', props: { s: 'v'.repeat(5000), n: 1e308, neg: -0, b: true, nil: null, bad: undefined, fn: () => 1 } },
      { name: 'Custom', url: 'https://shop.example.com/', event_id: 'x', ts: 'not a date', anon_id: 'a_'.repeat(50), session_id: 's', user_id: 'u'.repeat(300) },
      { name: '$exception', url: 'https://shop.example.com/', error_message: 'e'.repeat(5000), props: { $source: 'https://x/app.js', $line: 1, $col: 2, $other: 1 } },
      { name: '$identify', url: 'https://shop.example.com/', anon_id: 'a_1', user_id: ' user 1 ' },
      { name: '$quickback', url: 'https://shop.example.com/', props: { $from: '/pricing' } },
    ];
    const people = [
      { op: 'set' as const, user_id: 'user-1', props: { email: 'a@b.co', name: 'Ann', $avatar: 'https://x/a.png', s: 'v'.repeat(5000), bad: {} } },
      { op: 'set_once' as const, user_id: 'user-1', ts: 'garbage', props: { $created: '2026-01-01' } },
      { op: 'unset' as const, user_id: 'user-1', keys: ['email', ...Array.from({ length: 80 }, (_, i) => `k${i}`)] },
      { op: 'increment' as const, user_id: 'user-1', props: { n: 1, s: 'x' } },
      { op: 'set' as const, user_id: 'bad\u0000id', props: { a: 1 } },
    ];
    const batches = buildBatches({
      token: 'wpk_0123456789abcdef0123456789abcdef',
      consent: true,
      events: [...awkward, ...awkward, ...awkward],
      people: [...people, ...people],
    });
    expect(batches.length).toBeGreaterThan(0);
    expect(batches[0].people).toHaveLength(8);
    for (const batch of batches) domain.eventBatchSchema.parse(batch);
  });

  it('what the client sends passes the collector schema: consent, identity, profiles, frustration', async () => {
    vi.useFakeTimers();
    document.title = 'Pricing — Shop';
    document.body.innerHTML = '<div class="plans"><button id="pro" class="cta">Choose Pro €49</button></div>';
    const { client, net } = setup({ maskingLevel: 'relaxed' });
    await vi.advanceTimersByTimeAsync(100);
    client.api.track('Viewed plans', { count: 3, currency: 'EUR', annual: false });
    const button = document.getElementById('pro')!;
    button.getBoundingClientRect = () => ({ left: 0, top: 0, width: 120, height: 40, right: 120, bottom: 40, x: 0, y: 0, toJSON: () => ({}) });
    for (let i = 0; i < 3; i++) button.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 30, clientY: 20 }));
    window.dispatchEvent(new ErrorEvent('error', { message: 'Boom at jane@example.com', filename: 'https://shop.example.com/app.js?v=1', lineno: 3, colno: 9 }));
    await vi.advanceTimersByTimeAsync(1000);
    client.api.consent.grant();
    client.api.identify('user-42');
    client.api.people.set({ email: 'jane@example.com', plan: 'pro' });
    client.api.people.increment('visits');
    history.pushState(null, '', '/checkout?plan=pro');
    history.pushState(null, '', '/');
    client.api.track('Started checkout', { plan: 'pro' });
    window.dispatchEvent(new Event('pagehide'));
    await client.api.flush();

    const sent = await net.sent();
    const names = ([] as string[]).concat(...sent.map((s) => s.batch.events.map((e) => e.name)));
    for (const name of ['$autocapture', '$rageclick', '$deadclick', '$exception', '$identify', '$quickback']) expect(names).toContain(name);
    expect(sent.map((s) => s.batch.consent)).toEqual([false, true]);
    expect(sent[1].batch.people).toHaveLength(2);
    for (const s of sent) {
      const parsed = domain.parseEventBatch(s.batch);
      expect(parsed).toMatchObject({ ok: true, dropped: 0, peopleDropped: 0 });
    }
  });

  it('what the server client sends passes the collector schema', async () => {
    const bodies: unknown[] = [];
    const fetchMock = async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify({ accepted: 1, dropped: 0 }), { status: 200 });
    };
    const panel = createPanelServer({ secretKey: 'wps_0123456789abcdef0123456789abcdef', fetch: fetchMock as unknown as typeof fetch });
    panel.track({ name: 'Renewed', distinctId: 'user-1', url: 'https://shop.example.com/x', title: 't'.repeat(900), props: { plan: 'pro', $from: 'nope' } });
    panel.track({ name: '$exception', distinctId: 'user-1', props: { $source: 'https://x/app.js', $line: 2 } });
    panel.identify({ userId: 'user-1', anonId: 'a_123' });
    panel.people.set('user-1', { email: 'a@b.co', name: 'Ann' });
    panel.people.unset('user-1', ['name']);
    await panel.flush();
    await panel.import([{ name: 'Order placed', distinctId: 'user-1', timestamp: '2023-05-01T00:00:00Z' }]);

    expect(bodies).toHaveLength(2);
    expect(domain.parseServerBatch(bodies[0], domain.MAX_TRACK_EVENTS)).toMatchObject({ ok: true, dropped: 0, peopleDropped: 0 });
    expect(domain.parseServerBatch(bodies[1], domain.MAX_IMPORT_EVENTS)).toMatchObject({ ok: true, dropped: 0 });
  });
});
