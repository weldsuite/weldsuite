import { describe, expect, it, vi } from 'vitest';
import { isManagedDnsProvider, isManagedDnsZone } from './dns-zone';

const runtimeModules = vi.hoisted(() => ({ value: null as string[] | null }));

vi.mock('@/lib/edition', () => ({
  offeredModules: () => (runtimeModules.value ? new Set(runtimeModules.value) : null),
}));

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

  it('reads the edition from the runtime config by default', () => {
    runtimeModules.value = null;
    expect(isManagedDnsProvider('hetzner')).toBe(false);
    runtimeModules.value = ['core', 'host'];
    expect(isManagedDnsProvider('hetzner')).toBe(true);
    runtimeModules.value = null;
  });
});

describe('isManagedDnsZone', () => {
  it('needs a managed provider and a zone at it', () => {
    expect(isManagedDnsZone({ provider: 'cloudflare', externalZoneId: 'cf_1' }, false)).toBe(true);
    expect(isManagedDnsZone({ provider: 'hetzner', externalZoneId: 'example.com' }, true)).toBe(true);
  });

  it('skips a zone row with nothing at the provider yet', () => {
    expect(isManagedDnsZone({ provider: 'cloudflare', externalZoneId: null }, false)).toBe(false);
    expect(isManagedDnsZone({ provider: 'hetzner', externalZoneId: '' }, true)).toBe(false);
  });

  it('skips unmanaged providers and missing zones', () => {
    expect(isManagedDnsZone({ provider: 'hetzner', externalZoneId: 'example.com' }, false)).toBe(false);
    expect(isManagedDnsZone(null, true)).toBe(false);
    expect(isManagedDnsZone(undefined, false)).toBe(false);
  });
});
