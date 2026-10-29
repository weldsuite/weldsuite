import { describe, expect, it } from 'vitest';
import { en } from '@weldsuite/i18n/locales/en';
import { nl } from '@weldsuite/i18n/locales/nl';
import {
  buildPrivacyFormSchema,
  buildProjectFormSchema,
  normalizeDomainInput,
  parseDomain,
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
  const base = { autocapture: true, consentMode: 'required' as const, maskingLevel: 'balanced' as const, excludedUrls: ['/admin/*'] };

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
});
