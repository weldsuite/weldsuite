import { describe, it, expect } from 'vitest';
import { fingerprintsEqual, probeConnectorUpdates, type ConnectorProbeClient } from './probe';

function fakeClient(args: {
  hits?: Partial<Record<string, boolean>>;
  counts?: Partial<Record<string, number>>;
}): ConnectorProbeClient {
  return {
    hasUpdatesSince: async (resource) => args.hits?.[resource] ?? false,
    countResource: async (resource) => args.counts?.[resource] ?? 0,
  };
}

describe('probeConnectorUpdates', () => {
  it('returns no updates when every resource is empty', async () => {
    const result = await probeConnectorUpdates({
      provider: 'woocommerce',
      credentials: {},
      client: fakeClient({ hits: { products: false, orders: false, customers: false } }),
    });
    expect(result).toEqual({ hasUpdates: false, resources: [] });
  });

  it('lists only the resources that have new rows', async () => {
    const result = await probeConnectorUpdates({
      provider: 'shopify',
      credentials: {},
      client: fakeClient({ hits: { products: true, orders: false, customers: true } }),
    });
    expect(result.hasUpdates).toBe(true);
    expect(result.resources).toEqual(['products', 'customers']);
  });
});

describe('fingerprintsEqual', () => {
  it('treats missing keys as zero', () => {
    expect(fingerprintsEqual({ products: 2 }, { products: 2, orders: 0 })).toBe(true);
    expect(fingerprintsEqual({ products: 2 }, { products: 3 })).toBe(false);
  });
});
