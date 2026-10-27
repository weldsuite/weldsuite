/**
 * The SDK's plain copy of the wire format against the collector's Zod schema.
 *
 * Imported by relative path on purpose: the domain package (and zod) must
 * never become a dependency of the SDK bundle, only of this test. panel-ingest
 * runs the same check from its side.
 */

import { afterEach, describe, expect, it } from 'vitest';
import * as domain from '../../../domains/panel/src/wire';
import { buildBatches } from './batch';
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
    expect([...sdk.SYSTEM_EVENTS]).toEqual([...domain.SYSTEM_EVENTS]);
    expect(sdk.CUSTOM_EVENT_NAME.source).toBe(domain.CUSTOM_EVENT_NAME.source);
    expect(sdk.PROPERTY_KEY.source).toBe(domain.PROPERTY_KEY.source);
  });

  it('every batch the builder makes from awkward input passes the collector schema', () => {
    const awkward = [
      { name: '$pageview', url: `https://shop.example.com/${'p'.repeat(3000)}`, title: 't'.repeat(900), referrer: 'r'.repeat(5000) },
      { name: '$autocapture', url: 'https://shop.example.com/', x: -3.7, y: 1e9, viewport_w: 99999.5, el: { tag: 'x'.repeat(50), selector: 's'.repeat(900), text: 'y'.repeat(900), action: 'click' as const } },
      { name: '$pageleave', url: 'https://shop.example.com/', scroll_depth: 250.2 },
      { name: 'Custom', url: 'https://shop.example.com/', props: { s: 'v'.repeat(5000), n: 1e308, neg: -0, b: true, nil: null, bad: undefined, fn: () => 1 } },
      { name: 'Custom', url: 'https://shop.example.com/', event_id: 'x', ts: 'not a date', anon_id: 'a_'.repeat(50), session_id: 's' },
    ];
    const batches = buildBatches({ token: 'wpk_0123456789abcdef0123456789abcdef', consent: true, events: [...awkward, ...awkward, ...awkward] });
    expect(batches.length).toBeGreaterThan(0);
    for (const batch of batches) domain.eventBatchSchema.parse(batch);
  });

  it('what the client sends passes the collector schema, with and without consent', async () => {
    document.title = 'Pricing — Shop';
    document.body.innerHTML = '<div class="plans"><button id="pro" class="cta">Choose Pro €49</button></div>';
    const { client, net } = setup({ maskingLevel: 'relaxed' });
    client.api.track('Viewed plans', { count: 3, currency: 'EUR', annual: false });
    (document.getElementById('pro') as HTMLButtonElement).click();
    client.api.consent.grant();
    history.pushState(null, '', '/checkout?plan=pro');
    client.api.track('Started checkout', { plan: 'pro' });
    window.dispatchEvent(new Event('pagehide'));
    await client.api.flush();

    const sent = await net.sent();
    expect(sent.map((s) => s.batch.consent)).toEqual([false, true]);
    for (const s of sent) domain.eventBatchSchema.parse(s.batch);
  });
});
