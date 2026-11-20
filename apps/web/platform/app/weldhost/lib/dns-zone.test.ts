import { describe, expect, it } from 'vitest';
import { isManagedDnsProvider } from './dns-zone';

describe('isManagedDnsProvider', () => {
  it('manages Cloudflare zones everywhere', () => {
    expect(isManagedDnsProvider('cloudflare', false)).toBe(true);
    expect(isManagedDnsProvider('cloudflare', true)).toBe(true);
  });

  it('manages Hetzner zones only on the Kubernetes editions', () => {
    expect(isManagedDnsProvider('hetzner', true)).toBe(true);
    expect(isManagedDnsProvider('hetzner', false)).toBe(false);
  });

  it('leaves other zones alone', () => {
    expect(isManagedDnsProvider('custom', true)).toBe(false);
    expect(isManagedDnsProvider(null, true)).toBe(false);
    expect(isManagedDnsProvider(undefined, false)).toBe(false);
  });
});
