import { describe, expect, it } from 'vitest';
import {
  isExternalDomainRegistrar,
  isHiddenUnpaidDomain,
  isManagedDomainRegistrar,
  publicDomainRegistrar,
  toPublicDomain,
} from '@weldsuite/core-api-client/schemas/domains';

describe('public domain registrar', () => {
  it('maps wholesale and legacy WeldHost names to WeldSuite', () => {
    expect(publicDomainRegistrar('realtimeregister')).toBe('WeldSuite');
    expect(publicDomainRegistrar('cloudflare')).toBe('WeldSuite');
    expect(publicDomainRegistrar('WeldHost')).toBe('WeldSuite');
    expect(publicDomainRegistrar(null)).toBe('WeldSuite');
    expect(publicDomainRegistrar(undefined)).toBe('WeldSuite');
  });

  it('keeps external registrars such as GoDaddy', () => {
    expect(publicDomainRegistrar('GoDaddy')).toBe('GoDaddy');
    expect(publicDomainRegistrar('External')).toBe('External');
    expect(isExternalDomainRegistrar('GoDaddy')).toBe(true);
    expect(isExternalDomainRegistrar('realtimeregister')).toBe(false);
    expect(isExternalDomainRegistrar(null)).toBe(false);
    expect(isManagedDomainRegistrar('WeldSuite')).toBe(true);
  });

  it('hides unpaid checkout rows from My Domains', () => {
    expect(isHiddenUnpaidDomain({ status: 'pending', registrationStatus: 'pending_payment' })).toBe(true);
    expect(isHiddenUnpaidDomain({ status: 'cancelled', registrationStatus: 'failed' })).toBe(true);
    expect(isHiddenUnpaidDomain({ status: 'pending', registrationStatus: 'pending_registration' })).toBe(false);
    expect(isHiddenUnpaidDomain({ status: 'pending', registrationStatus: null })).toBe(false);
    expect(isHiddenUnpaidDomain({ status: 'cancelled', registrationStatus: 'registration_failed' })).toBe(false);
  });

  it('toPublicDomain rewrites registrar in place without dropping other fields', () => {
    const row = toPublicDomain({
      id: 'dom_1',
      registrar: 'realtimeregister' as string | null,
      fullDomain: 'example.com',
    });
    expect(row).toEqual({
      id: 'dom_1',
      registrar: 'WeldSuite',
      fullDomain: 'example.com',
    });
  });
});
