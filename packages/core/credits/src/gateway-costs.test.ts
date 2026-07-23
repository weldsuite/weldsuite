import { describe, it, expect } from 'vitest';

import { nanoUsd, remainingNanoUsd, usdFromNano } from './gateway-costs.js';
import {
  GATEWAY_CREDIT_MAX_AGE_MS,
  isSnapshotUsable,
  toCreditStates,
  toSnapshot,
} from './gateway-cache.js';

const NOW = new Date('2026-07-16T12:00:00Z');

function row(over: Partial<Parameters<typeof remainingNanoUsd>[0]> = {}) {
  return {
    allowanceNanoUsd: 5_000_000_000, // $5
    manualAdjustmentNanoUsd: 0,
    spentNanoUsd: 0,
    allowanceExpiresAt: null,
    exhaustionMarginNanoUsd: 250_000_000, // $0.25
    ...over,
  };
}

describe('nanoUsd', () => {
  it('converts dollars to integer nano-USD', () => {
    expect(nanoUsd(0.006)).toBe(6_000_000);
    expect(nanoUsd(5)).toBe(5_000_000_000);
  });

  it('rounds sub-nano to zero and never goes negative', () => {
    expect(nanoUsd(1e-12)).toBe(0);
    expect(nanoUsd(-5)).toBe(0);
    expect(nanoUsd(Number.NaN)).toBe(0);
  });

  it('round-trips through usdFromNano', () => {
    expect(usdFromNano(nanoUsd(1.25))).toBeCloseTo(1.25, 9);
  });

  it('represents a Workers AI call that numeric(10,2) could not', () => {
    // $0.000074 — the reason this is nano-USD and not numeric(10,2).
    expect(nanoUsd(0.000074)).toBe(74_000);
  });
});

describe('remainingNanoUsd', () => {
  it('is allowance - spent + adjustment', () => {
    expect(remainingNanoUsd(row({ spentNanoUsd: 1_000_000_000 }), NOW)).toBe(4_000_000_000);
    expect(
      remainingNanoUsd(row({ spentNanoUsd: 1_000_000_000, manualAdjustmentNanoUsd: 2_000_000_000 }), NOW),
    ).toBe(6_000_000_000);
  });

  it('treats a null allowance as unlimited', () => {
    expect(remainingNanoUsd(row({ allowanceNanoUsd: null }), NOW)).toBeNull();
  });

  // The fail-safe for "free during beta": when the beta ends, an unlimited
  // allowance must stop reading as free rather than silently running up a bill.
  it('returns 0 (NOT null) for an EXPIRED unlimited allowance', () => {
    const expired = row({
      allowanceNanoUsd: null,
      allowanceExpiresAt: new Date('2026-07-15T00:00:00Z'),
    });
    expect(remainingNanoUsd(expired, NOW)).toBe(0);
  });

  it('still reports unlimited before the expiry date', () => {
    const future = row({
      allowanceNanoUsd: null,
      allowanceExpiresAt: new Date('2026-10-01T00:00:00Z'),
    });
    expect(remainingNanoUsd(future, NOW)).toBeNull();
  });

  it('treats "nearly gone" as exhausted, absorbing snapshot staleness', () => {
    // $0.10 left, margin $0.25 -> exhausted.
    expect(remainingNanoUsd(row({ spentNanoUsd: 4_900_000_000 }), NOW)).toBe(0);
    // $1 left -> still usable.
    expect(remainingNanoUsd(row({ spentNanoUsd: 4_000_000_000 }), NOW)).toBe(1_000_000_000);
  });

  it('never reports negative remaining when overspent', () => {
    expect(remainingNanoUsd(row({ spentNanoUsd: 9_000_000_000 }), NOW)).toBe(0);
  });
});

describe('snapshot freshness', () => {
  const snapshot = () =>
    toSnapshot(
      [
        {
          gateway: 'cloudflare',
          remainingNanoUsd: 5_000_000_000,
          spentNanoUsd: 0,
          allowanceNanoUsd: 5_000_000_000,
          manualAdjustmentNanoUsd: 0,
          allowanceExpiresAt: null,
          enabled: true,
          priority: 10,
          exhaustionMarginNanoUsd: 0,
          periodStart: NOW,
          periodEnd: NOW,
          lastRolledUpAt: NOW,
        },
      ],
      NOW,
    );

  it('accepts a fresh, well-formed snapshot', () => {
    expect(isSnapshotUsable(snapshot(), NOW.getTime())).toBe(true);
  });

  // Guards against a wedged cron serving "cloudflare is free" forever.
  it('rejects a snapshot older than the max age', () => {
    expect(isSnapshotUsable(snapshot(), NOW.getTime() + GATEWAY_CREDIT_MAX_AGE_MS + 1)).toBe(false);
  });

  it('rejects malformed blobs rather than routing on garbage', () => {
    expect(isSnapshotUsable(null)).toBe(false);
    expect(isSnapshotUsable('nope')).toBe(false);
    expect(isSnapshotUsable({ at: 'soon', gateways: [] })).toBe(false);
    expect(isSnapshotUsable({ at: Date.now() })).toBe(false);
  });

  it('carries only what the router needs', () => {
    expect(snapshot().gateways[0]).toEqual({
      gateway: 'cloudflare',
      remainingNanoUsd: 5_000_000_000,
      enabled: true,
      priority: 10,
    });
  });

  it('degrades a missing snapshot to "no credit info", not a crash', () => {
    expect(toCreditStates(null)).toEqual([]);
  });
});
