import { describe, expect, it } from 'vitest';
import { en } from '@weldsuite/i18n/locales/en';
import { nl } from '@weldsuite/i18n/locales/nl';
import {
  buildPrivacyFormSchema,
  buildProjectFormSchema,
  normalizeDomainInput,
  parseDomain,
  parseIpFilter,
  parseUrlPattern,
} from './validation';

describe('normalizeDomainInput', () => {
  it('reduces a pasted address to its host', () => {
    expect(normalizeDomainInput('https://Example.com/pricing?x=1#top')).toBe('Example.com');
    expect(normalizeDomainInput('http://shop.example.com:8080/')).toBe('shop.example.com');
    expect(normalizeDomainInput('example.com:3000')).toBe('example.com');
    expect(normalizeDomainInput('  *.example.com  ')).toBe('*.example.com');
  });
});

describe('parseDomain', () => {
  it('accepts hosts, subdomains, wildcards and localhost, lower-cased', () => {
    expect(parseDomain('example.com')).toBe('example.com');
    expect(parseDomain('Shop.Example.COM')).toBe('shop.example.com');
    expect(parseDomain('*.example.com')).toBe('*.example.com');
    expect(parseDomain('localhost')).toBe('localhost');
    expect(parseDomain('https://example.com/a/b')).toBe('example.com');
  });

  it('rejects what is not a host', () => {
    expect(parseDomain('')).toBeNull();
    expect(parseDomain('example')).toBeNull();
    expect(parseDomain('not a domain')).toBeNull();
    expect(parseDomain('exa_mple.com')).toBeNull();
    expect(parseDomain('127.0.0.1')).toBeNull();
  });
});

describe('parseUrlPattern', () => {
  it('accepts paths and wildcards', () => {
    expect(parseUrlPattern('/admin/*')).toBe('/admin/*');
    expect(parseUrlPattern(' /checkout/success ')).toBe('/checkout/success');
  });

  it('rejects anything not starting with a slash', () => {
    expect(parseUrlPattern('admin')).toBeNull();
    expect(parseUrlPattern('')).toBeNull();
    expect(parseUrlPattern(`/${'a'.repeat(200)}`)).toBeNull();
  });
});

describe('buildProjectFormSchema', () => {
  const schema = buildProjectFormSchema(en.weldpanel.validation);
  const base = { name: 'Site', kind: 'website' as const, allowedDomains: ['example.com'] };

  it('accepts a valid project and trims the name', () => {
    const parsed = schema.parse({ ...base, name: '  Site  ' });
    expect(parsed.name).toBe('Site');
  });

  it('asks for a name, in the given language', () => {
    const result = schema.safeParse({ ...base, name: '   ' });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toBe(en.weldpanel.validation.nameRequired);

    const dutch = buildProjectFormSchema(nl.weldpanel.validation).safeParse({ ...base, name: '' });
    expect(dutch.error?.issues[0]?.message).toBe(nl.weldpanel.validation.nameRequired);
  });

  it('refuses a domain the contract refuses, with our message', () => {
    const result = schema.safeParse({ ...base, allowedDomains: ['example.com', 'nope'] });
    expect(result.error?.issues[0]?.message).toBe(en.weldpanel.validation.domainInvalid);
  });

  it('caps the domains at 20', () => {
    const domains = Array.from({ length: 21 }, (_, i) => `site${i}.example.com`);
    const result = schema.safeParse({ ...base, allowedDomains: domains });
    expect(result.error?.issues[0]?.message).toBe(en.weldpanel.validation.tooManyDomains);
  });
});

describe('buildPrivacyFormSchema', () => {
  const schema = buildPrivacyFormSchema(en.weldpanel.validation);
  const base = { autocapture: true, consentMode: 'required' as const, maskingLevel: 'balanced' as const,
    excludedUrls: ['/admin/*'],
    ipFilters: ['203.0.113.0/24'],
    recordingSamplePercent: 100,
    aiEnabled: true,
  };

  it('accepts valid settings', () => {
    expect(schema.safeParse(base).success).toBe(true);
  });

  it('refuses a pattern that does not start with a slash', () => {
    const result = schema.safeParse({ ...base, excludedUrls: ['admin'] });
    expect(result.error?.issues[0]?.message).toBe(en.weldpanel.validation.patternInvalid);
  });

  it('refuses an unknown consent mode or masking level', () => {
    expect(schema.safeParse({ ...base, consentMode: 'maybe' }).success).toBe(false);
    expect(schema.safeParse({ ...base, maskingLevel: 'off' }).success).toBe(false);
  });

  it('refuses an address or range that is not one', () => {
    const result = schema.safeParse({ ...base, ipFilters: ['office'] });
    expect(result.error?.issues[0]?.message).toBe(en.weldpanel.validation.ipInvalid);
  });

  it('takes a whole percent from 0 to 100 for the recording sample rate', () => {
    for (const ok of [0, 25, 100]) expect(schema.safeParse({ ...base, recordingSamplePercent: ok }).success).toBe(true);
    for (const bad of [-1, 101, 12.5, undefined, Number.NaN]) {
      const result = schema.safeParse({ ...base, recordingSamplePercent: bad });
      expect(result.error?.issues[0]?.message).toBe(en.weldpanel.validation.sampleRateInvalid);
    }
  });
});

describe('parseIpFilter', () => {
  it('accepts IPv4, IPv6 and CIDR ranges', () => {
    for (const ok of ['203.0.113.7', '203.0.113.0/24', '0.0.0.0/0', '2001:db8::/32', '::1', 'fe80::1', '::ffff:1.2.3.4', '2001:db8:0:0:0:0:0:1']) {
      expect(parseIpFilter(ok)).toBe(ok);
    }
    expect(parseIpFilter('  10.0.0.1 ')).toBe('10.0.0.1');
  });

  it('rejects what is not an address or range', () => {
    for (const bad of ['', 'office', '256.1.1.1', '1.2.3', '1.2.3.4/33', '1.2.3.4/', '1.2.3.4/8/8', '2001:db8::/129', '1::2::3', '1:2:3:4:5:6:7', ':::', 'g::1', '/24']) {
      expect(parseIpFilter(bad), bad).toBeNull();
    }
  });
});
