/**
 * The collector against what the browser SDK actually sends. The SDK keeps its
 * own plain copy of the wire format (no zod in the bundle) and checks it
 * against the schema from its side (packages/sdk/panel-sdk/src/wire.contract.test.ts);
 * this is the same check from the collector's side, one step further: the SDK's
 * batches go through the real route and come out as rows.
 *
 * `buildBatches` is imported by relative path because the SDK package does not
 * export it and its entry point pulls in the DOM client; this file only needs
 * the pure batch builder.
 */

import { eventBatchSchema } from '@weldsuite/panel-domain/wire';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildBatches } from '../../../../packages/sdk/panel-sdk/src/batch';
import { NOW, TOKEN, call, makeEnv, resetIsolateState } from './testing/fakes';

const PAGE = 'https://shop.example.com/pricing?plan=pro&utm_source=newsletter';

const events = [
  { name: '$pageview', url: PAGE, title: 'Pricing', referrer: 'https://www.google.com/', viewport_w: 1280 },
  {
    name: '$autocapture',
    url: PAGE,
    x: 412,
    y: 980,
    el: { tag: 'button', selector: 'main > button.buy', text: 'Buy now', action: 'click' as const },
  },
  { name: '$pageleave', url: PAGE, scroll_depth: 63 },
  { name: 'Signed up', url: PAGE, props: { plan: 'pro', seats: 3, annual: false, coupon: null } },
];

describe('what the SDK sends', () => {
  beforeEach(() => {
    resetIsolateState();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => vi.useRealTimers());

  it.each([
    ['without consent', false],
    ['with consent', true],
  ])('is accepted by the collector and becomes one row per event, %s', async (_label, consent) => {
    const testEnv = makeEnv();
    const withIds = events.map((event) => (consent ? { ...event, anon_id: 'a-browser-id', session_id: 's-browser-id' } : event));
    const batches = buildBatches({ token: TOKEN, consent, events: withIds, sentAt: NOW });

    expect(batches).toHaveLength(1);
    for (const batch of batches) {
      expect(eventBatchSchema.safeParse(batch).success).toBe(true);
      expect((await call(testEnv, { body: batch })).status).toBe(204);
    }

    expect(testEnv.stream.sent.map((row) => row.name)).toEqual(['$pageview', '$autocapture', '$pageleave', 'Signed up']);
    expect(testEnv.stream.sent.every((row) => row.cookieless === !consent)).toBe(true);
    expect(testEnv.stream.sent[1]).toMatchObject({ el_selector: 'main > button.buy', el_text: 'Buy now', x: 412, y: 980 });
    expect(testEnv.stream.sent[2]).toMatchObject({ scroll_depth: 63 });
    expect(testEnv.stream.sent[3]!.properties).toBe('{"plan":"pro","seats":3,"annual":false,"coupon":null}');
    expect(testEnv.stream.sent[0]).toMatchObject({ utm_source: 'newsletter', referrer_host: 'www.google.com', viewport_w: 1280 });
  });

  it('keeps the browser ids only with consent', async () => {
    const testEnv = makeEnv();
    const [batch] = buildBatches({
      token: TOKEN,
      consent: true,
      events: [{ name: '$pageview', url: PAGE, anon_id: 'a-browser-id', session_id: 's-browser-id' }],
    });
    await call(testEnv, { body: batch });

    expect(testEnv.stream.sent[0]).toMatchObject({ anon_id: 'a-browser-id', session_id: 's-browser-id', cookieless: false });
  });

  it('is accepted even when the SDK had to clamp awkward input', async () => {
    const testEnv = makeEnv();
    const batches = buildBatches({
      token: TOKEN,
      consent: false,
      events: [
        { name: '$pageview', url: `https://shop.example.com/${'p'.repeat(3000)}`, title: 't'.repeat(900), referrer: 'r'.repeat(5000) },
        { name: 'Custom', url: PAGE, props: { s: 'v'.repeat(5000), n: 1e308, neg: -0 } },
      ],
    });

    for (const batch of batches) expect((await call(testEnv, { body: batch })).status).toBe(204);
  });
});
