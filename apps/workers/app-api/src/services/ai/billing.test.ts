/**
 * Unit tests for AI credit pricing — the pure `priceForModel` / `providerCostUsd`
 * / `creditsForUsage` math. No DB or network; guards the real price table, the
 * markup formula, and the rounding/minimum rules.
 */

import { describe, it, expect } from 'vitest';
import { DEFAULT_PRICE } from '@weldsuite/ai';
import { priceForModel, providerCostUsd, creditsForUsage } from './billing';

describe('priceForModel', () => {
  it('returns the real published price for a known model', () => {
    expect(priceForModel('anthropic/claude-sonnet-4-5')).toEqual({ inputPerM: 3, outputPerM: 15 });
    expect(priceForModel('@cf/meta/llama-3.3-70b-instruct-fp8-fast')).toEqual({
      inputPerM: 0.293,
      outputPerM: 2.253,
    });
  });

  it('uses the Workers AI fallback price for an unknown @cf/ model', () => {
    expect(priceForModel('@cf/some/new-model')).toEqual({ inputPerM: 0.1, outputPerM: 0.4 });
  });

  it('falls back to a Sonnet-class price for unknown third-party models', () => {
    expect(priceForModel('some/unknown-model')).toEqual({ inputPerM: 3, outputPerM: 15 });
  });
});

describe('providerCostUsd', () => {
  it('computes raw USD cost from tokens (sonnet 500in/300out = $0.006)', () => {
    expect(
      providerCostUsd('anthropic/claude-sonnet-4-5', { inputTokens: 500, outputTokens: 300 }),
    ).toBeCloseTo(0.006, 6);
  });
});

describe('creditsForUsage', () => {
  // Charge = rawCostUSD × 2.5 markup × 100 credits/USD, min 1.
  it('charges at least 1 credit for a tiny/cheap call (free-tier Workers AI)', () => {
    expect(
      creditsForUsage('@cf/meta/llama-3.1-8b-instruct-fast', {
        inputTokens: 800,
        outputTokens: 100,
      }),
    ).toBe(1);
  });

  it('prices a typical Sonnet draft (500in/300out) at 2 credits', () => {
    // 0.006 × 2.5 × 100 = 1.5 → ceil 2
    expect(
      creditsForUsage('anthropic/claude-sonnet-4-5', { inputTokens: 500, outputTokens: 300 }),
    ).toBe(2);
  });

  it('scales with tokens (Sonnet 4000in/800out = 6 credits)', () => {
    // 0.024 × 2.5 × 100 = 6
    expect(
      creditsForUsage('anthropic/claude-sonnet-4-5', { inputTokens: 4000, outputTokens: 800 }),
    ).toBe(6);
  });

  it('charges more for a pricier model at the same usage (Opus > Sonnet > llama)', () => {
    const usage = { inputTokens: 500, outputTokens: 300 };
    const opus = creditsForUsage('anthropic/claude-opus-4-1', usage);
    const sonnet = creditsForUsage('anthropic/claude-sonnet-4-5', usage);
    const llama = creditsForUsage('@cf/meta/llama-3.3-70b-instruct-fp8-fast', usage);
    expect(opus).toBeGreaterThan(sonnet);
    expect(sonnet).toBeGreaterThan(llama);
  });

  it('treats missing token counts as zero (still min 1)', () => {
    expect(creditsForUsage('anthropic/claude-sonnet-4-5', {})).toBe(1);
  });
});

/**
 * The invariant that makes cost-aware gateway routing safe to enable.
 *
 * Routing sends a call to whichever gateway is cheapest for US, and the customer
 * must never notice: they pay the canonical list price × markup regardless. That
 * holds structurally because `creditsForUsage` takes only (canonicalModelId,
 * usage) — the gateway is not, and must never become, an argument.
 *
 * If someone "helpfully" makes pricing gateway-aware, the same prompt starts
 * costing a different number of credits depending on invisible routing, and a
 * failover silently reprices a call mid-incident. This test is the tripwire.
 */
describe('customer price is independent of the serving gateway', () => {
  it('prices identically no matter which gateway served the call', () => {
    const usage = { inputTokens: 1000, outputTokens: 500 };
    // The same canonical id is what every gateway is asked for; only the native
    // id and OUR cost differ. Pricing must key on the canonical id alone.
    const canonical = 'anthropic/claude-sonnet-4-5';
    const viaCloudflare = creditsForUsage(canonical, usage);
    const viaVercel = creditsForUsage(canonical, usage);
    const viaNeon = creditsForUsage(canonical, usage);
    expect(viaVercel).toBe(viaCloudflare);
    expect(viaNeon).toBe(viaCloudflare);
  });

  it('takes exactly two arguments — a gateway cannot be threaded in', () => {
    expect(creditsForUsage.length).toBe(2);
    expect(providerCostUsd.length).toBe(2);
  });

  // Uses Haiku, not Sonnet: DEFAULT_PRICE *is* the Sonnet rate ({3,15}) by
  // definition, so a Sonnet-based assertion here proves nothing.
  it('would MISPRICE a gateway-native id — proof billing must see canonical ids', () => {
    const usage = { inputTokens: 1_000_000, outputTokens: 0 };
    const canonical = 'anthropic/claude-haiku-4-5'; // $1/1M in
    const vercelNative = 'anthropic/claude-haiku-4.5'; // same model, Vercel's id

    expect(priceForModel(canonical)).toEqual({ inputPerM: 1, outputPerM: 5 });
    // The native id isn't in MODEL_PRICES, so it silently bills Sonnet-class.
    expect(priceForModel(vercelNative)).toEqual(DEFAULT_PRICE);
    // 3× overcharge if a caller ever passed the native id through to billing.
    expect(creditsForUsage(vercelNative, usage)).toBe(creditsForUsage(canonical, usage) * 3);
  });
});
