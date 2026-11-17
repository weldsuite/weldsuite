/**
 * The SDK's plain copy of the wire format against the collector's Zod schema.
 *
 * Imported by relative path on purpose: the domain package (and zod) must
 * never become a dependency of the SDK, only of this test.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import * as domain from '../../../domains/panel/src/wire';
import { buildBatches } from './batch';
import { fakeDevice, setup } from './test/harness';
import * as sdk from './wire';

afterEach(() => {
  vi.useRealTimers();
});

describe('wire contract', () => {
  it('has the same limits, names and patterns as the collector', () => {
    expect(sdk.MAX_EVENTS_PER_BATCH).toBe(domain.MAX_EVENTS_PER_BATCH);
    expect(sdk.MAX_BATCH_BYTES).toBe(domain.MAX_BATCH_BYTES);
    expect(sdk.MAX_PROPERTIES).toBe(domain.MAX_PROPERTIES);
    expect(sdk.MAX_STRING).toBe(domain.MAX_STRING);
    expect(sdk.MAX_PEOPLE_OPS_PER_BATCH).toBe(domain.MAX_PEOPLE_OPS_PER_BATCH);
    expect(sdk.MAX_GROUP_OPS_PER_BATCH).toBe(domain.MAX_GROUP_OPS_PER_BATCH);
    expect(sdk.MAX_GROUP_TYPES).toBe(domain.MAX_GROUP_TYPES);
    expect(sdk.MAX_GROUP_KEY).toBe(domain.MAX_GROUP_KEY);
    expect(sdk.MAX_UNSET_KEYS).toBe(domain.MAX_UNSET_KEYS);
    expect([...sdk.SYSTEM_EVENTS].sort()).toEqual([...domain.SYSTEM_EVENTS].sort());
    expect(domain.LIBS).toContain('mobile');
    for (const name of ['CUSTOM_EVENT_NAME', 'PROPERTY_KEY', 'PAGE_EVENT_KEY', 'DEVICE_EVENT_KEY', 'PROFILE_PROPERTY_KEY', 'USER_ID', 'GROUP_TYPE', 'GROUP_PROPERTY'] as const) {
      expect(sdk[name].source, name).toBe(domain[name].source);
    }
  });

  it('every batch built from awkward input passes the collector schema', () => {
    const long = (n: number) => 'x'.repeat(n);
    const events = [
      { name: '$screen', url: `app://com.acme.shop/${long(1000)}`, title: long(900), props: { $screen_name: long(5000), $os: 'ios', $device_type: 'tablet' } },
      { name: '$app_opened', url: 'app://com.acme.shop/', viewport_w: 99999.5, props: { $app_id: 'com.acme.shop', $screen_width: 1024.6, $locale: 'nl-NL' } },
      { name: '$app_updated', url: 'app://com.acme.shop/', props: { previous_version: '1.0.0', $previous_version: '1.0.0', $other: 1 } },
      { name: 'Custom', url: 'app://com.acme.shop/', props: { s: long(5000), n: 1e308, neg: -0, b: true, nil: null, bad: undefined, fn: () => 1, $group_company: 'acme' } },
      { name: 'Custom', url: 'app://app/', event_id: 'x', ts: 'not a date', anon_id: 'a_'.repeat(50), session_id: 's', user_id: 'u'.repeat(300) },
      { name: '$identify', url: 'app://app/', anon_id: 'a_1', user_id: ' user 1 ', viewport_w: -3 },
      { name: 'Not $ allowed', url: 'app://app/' },
      { name: '$unknown_system', url: 'app://app/' },
      { name: 'No URL', url: 'not a url' },
    ];
    const people = [
      { op: 'set' as const, user_id: 'user-1', props: { email: 'a@b.co', name: 'Ann', $avatar: 'https://x/a.png', s: long(5000), bad: {} } },
      { op: 'set_once' as const, user_id: 'user-1', ts: 'garbage', props: { $created: '2026-01-01' } },
      { op: 'unset' as const, user_id: 'user-1', keys: ['email', ...Array.from({ length: 80 }, (_, i) => `k${i}`)] },
      { op: 'increment' as const, user_id: 'user-1', props: { n: 1, s: 'x' } },
      { op: 'set' as const, user_id: 'bad\u0000id', props: { a: 1 } },
    ];
    const groups = [
      { op: 'set' as const, type: 'company', key: 'acme', props: { name: 'Acme', plan: 'pro', $bad: 1 } },
      { op: 'set' as const, type: 'team', key: 42, props: {} },
      { op: 'set_once' as const, type: 'company', key: 'acme', props: { $created: '2026-01-01' } },
      { op: 'unset' as const, type: 'company', key: 'acme', keys: ['legacy', 'name', 'legacy'] },
      { op: 'set' as const, type: 'Bad Type', key: 'acme', props: { a: 1 } },
      { op: 'set' as const, type: 'company', key: long(300), props: { a: 1 } },
    ];
    for (const consent of [false, true]) {
      const batches = buildBatches({
        token: 'wpk_0123456789abcdef0123456789abcdef',
        consent,
        events: [...events, ...events, ...events],
        people: [...people, ...people],
        groups: [...groups, ...groups],
      });
      expect(batches.length).toBeGreaterThan(0);
      expect(batches[0].events).toHaveLength(18);
      expect(batches[0].people ?? []).toHaveLength(consent ? 8 : 0);
      expect(batches[0].groups).toHaveLength(8);
      for (const batch of batches) {
        domain.eventBatchSchema.parse(batch);
        expect(domain.parseEventBatch(batch)).toMatchObject({ ok: true, dropped: 0, peopleDropped: 0, groupsDropped: 0 });
      }
    }
  });

  it('what the client sends passes the collector schema with nothing dropped', async () => {
    vi.useFakeTimers();
    const device = fakeDevice({
      device: { os: 'android', osVersion: '14', deviceType: 'tablet', deviceModel: 'Google Pixel Tablet', locale: 'nl-NL' },
      window: { width: 1280.5, height: 800 },
      screen: { width: 1280, height: 800 },
    });
    const { panel, idle, net } = setup({ device });
    panel.register({ plan: 'pro', 'bad key': 1 });
    panel.group('company', 'acme', { name: 'Acme Inc.', seats: 12 });
    panel.screen('Product  Detail — “Ünïcode” #1?', { sku: 'A-100' });
    panel.track('Added to cart', { price: 19.99, currency: 'EUR', gift: false, note: null });
    await panel.ready;
    await panel.flush();
    panel.consent.grant();
    panel.identify('user-42');
    panel.people.set({ email: 'jane@example.com', name: 'Jane', plan: 'pro' });
    panel.people.set_once({ $created: '2026-01-01' });
    panel.people.increment({ logins: 1, credits: -5 });
    panel.people.unset(['legacy']);
    panel.groups.set_once('company', 'acme', { $created: '2025-03-01' });
    panel.groups.unset('company', 'acme', ['legacy']);
    panel.screen('Checkout');
    device.setAppState('background');
    await idle();
    device.setAppState('active');
    panel.track('Order placed', { total: 42 });
    await panel.flush();
    await idle();

    expect(net.sent.map((s) => s.batch.consent)).toEqual([false, true, true]);
    expect(net.names()).toEqual([
      '$app_opened',
      '$screen',
      'Added to cart',
      '$app_installed',
      '$identify',
      '$screen',
      '$app_backgrounded',
      '$app_opened',
      'Order placed',
    ]);
    expect(net.sent[1].batch.people).toHaveLength(4);
    // group() before consent only sets the membership; its profile operation is dropped.
    expect(net.sent.flatMap((s) => s.batch.groups ?? [])).toHaveLength(2);
    for (const { batch } of net.sent) {
      domain.eventBatchSchema.parse(batch);
      expect(domain.parseEventBatch(batch)).toMatchObject({ ok: true, dropped: 0, peopleDropped: 0, groupsDropped: 0 });
    }
    const added = net.events()[2];
    // Before consent the membership stays on the device.
    expect(added.props).not.toHaveProperty('$group_company');
    expect(net.events()[8].props).toMatchObject({ $group_company: 'acme' });
    expect(added.props).toMatchObject({
      $screen_name: 'Product  Detail — “Ünïcode” #1?',
      $os: 'android',
      $device_type: 'tablet',
      $device_model: 'Google Pixel Tablet',
      $app_id: 'com.acme.shop',
      plan: 'pro',
      price: 19.99,
    });
    expect(added.viewport_w).toBe(1281);
    panel.shutdown();
  });
});
