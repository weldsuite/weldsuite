/**
 * Web vitals: the plugin's measures on fake performance entries, and the
 * client sending one anonymous `$webvitals` per page view.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import * as domain from '../../../domains/panel/src/wire';
import { defineOn, resetPage, setup } from './test/harness';
import { watchVitals } from './vitals';
import type { WireEvent } from './wire';

afterEach(resetPage);

type Callback = (list: { getEntries(): PerformanceEntry[] }) => void;

/** A PerformanceObserver whose entries the test emits by type. */
function fakeObservers() {
  const observers: Array<{ type: string; callback: Callback }> = [];
  class FakeObserver {
    constructor(private readonly callback: Callback) {}
    observe(options: { type: string }) {
      observers.push({ type: options.type, callback: this.callback });
    }
    disconnect() {}
  }
  vi.stubGlobal('PerformanceObserver', FakeObserver);
  return (type: string, ...entries: Array<Record<string, unknown>>) => {
    for (const o of observers.filter((x) => x.type === type)) o.callback({ getEntries: () => entries as unknown as PerformanceEntry[] });
  };
}

function navigation(entry: Record<string, unknown> | null) {
  defineOn(performance, 'getEntriesByType', (type: string) => (type === 'navigation' && entry ? [entry] : []));
}

describe('watchVitals', () => {
  it('measures LCP, FCP, TTFB, CLS session windows and the longest interaction, with their elements', () => {
    navigation({ type: 'reload', responseStart: 120.4, activationStart: 0 });
    const emit = fakeObservers();
    const img = document.createElement('img');
    img.className = 'hero';
    document.body.appendChild(img);
    const button = document.createElement('button');
    button.id = 'buy';
    document.body.appendChild(button);
    const vitals = watchVitals((el) => (el.id ? `#${el.id}` : el.tagName.toLowerCase()));

    emit('paint', { name: 'first-paint', startTime: 50 }, { name: 'first-contentful-paint', startTime: 80.6 });
    emit('largest-contentful-paint', { startTime: 900, element: img });
    emit('layout-shift', { startTime: 1000, value: 0.05, hadRecentInput: false, sources: [{ node: img }] });
    emit('layout-shift', { startTime: 1500, value: 0.05, hadRecentInput: false, sources: [{ node: img }] });
    emit('layout-shift', { startTime: 1600, value: 0.5, hadRecentInput: true });
    emit('layout-shift', { startTime: 9000, value: 0.02, hadRecentInput: false });
    emit('event', { interactionId: 0, duration: 500 });
    emit('event', { interactionId: 7, duration: 180, target: button }, { interactionId: 8, duration: 90, target: img });

    expect(vitals.take()).toEqual({
      $ttfb: 120,
      $nav_type: 'reload',
      $fcp: 81,
      $lcp: 900,
      $lcp_el: 'img',
      $cls: 0.1,
      $cls_el: 'img',
      $inp: 180,
      $inp_el: '#buy',
    });
    // Once per page view.
    expect(vitals.take()).toBeNull();

    vitals.soft();
    expect(vitals.take()).toBeNull();
    emit('event', { interactionId: 9, duration: 64 });
    expect(vitals.take()).toEqual({ $nav_type: 'soft', $inp: 64 });
  });

  it('names a prerendered page and measures TTFB from its activation', () => {
    navigation({ type: 'navigate', responseStart: 300, activationStart: 250 });
    fakeObservers();
    expect(watchVitals(() => 'x').take()).toEqual({ $ttfb: 50, $nav_type: 'prerender' });
  });
});

describe('the client', () => {
  it('sends one anonymous $webvitals per page view, on a route change and on page hide', async () => {
    navigation({ type: 'navigate', responseStart: 100, activationStart: 0 });
    const emit = fakeObservers();
    const { client, net } = setup({ consentMode: 'none' }, { webVitals: true, vitals: watchVitals });
    client.api.register({ plan: 'pro' });
    // The plugin arrives through a promise.
    await Promise.resolve();
    await Promise.resolve();
    emit('largest-contentful-paint', { startTime: 700 });

    history.pushState(null, '', '/next');
    emit('event', { interactionId: 3, duration: 120 });
    window.dispatchEvent(new Event('pagehide'));
    await client.api.flush();

    const sent = await net.sent();
    const vitals = ([] as WireEvent[]).concat(...sent.map((s) => s.batch.events)).filter((e) => e.name === '$webvitals');
    expect(vitals.map((e) => [new URL(e.url).pathname, e.props])).toEqual([
      ['/', { $ttfb: 100, $nav_type: 'navigate', $lcp: 700 }],
      ['/next', { $nav_type: 'soft', $inp: 120 }],
    ]);
    // No ids, no super or first-touch properties.
    for (const e of vitals) expect(e.anon_id).toBeUndefined();
    for (const s of sent) expect(domain.parseEventBatch(s.batch).ok).toBe(true);
  });

  it('sends nothing with webVitals off', async () => {
    navigation({ type: 'navigate', responseStart: 100, activationStart: 0 });
    fakeObservers();
    const { client, net } = setup({ consentMode: 'none' }, { webVitals: false, vitals: watchVitals });
    window.dispatchEvent(new Event('pagehide'));
    await client.api.flush();
    expect(await net.names()).not.toContain('$webvitals');
  });
});
