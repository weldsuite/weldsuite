import { describe, expect, it } from 'vitest';
import {
  externalDomainProblem,
  externalDomainSchema,
} from '@weldsuite/core-api-client/schemas/domains';

describe('externalDomainProblem', () => {
  it('accepts a normal domain, whatever the case or surrounding spaces', () => {
    expect(externalDomainProblem('example.com')).toBeNull();
    expect(externalDomainProblem('  Shop.Example.co.uk ')).toBeNull();
  });

  it('flags text that is not a domain', () => {
    expect(externalDomainProblem('not a domain')).toBe('invalid');
    expect(externalDomainProblem('localhost')).toBe('invalid');
    expect(externalDomainProblem('-bad.com')).toBe('invalid');
  });

  it('flags special-use TLDs that can never be verified', () => {
    for (const domain of ['e2e-weldtest.example', 'a.test', 'b.invalid', 'c.localhost', 'printer.local']) {
      expect(externalDomainProblem(domain)).toBe('reserved');
    }
    // Only the last label counts.
    expect(externalDomainProblem('example.test.com')).toBeNull();
  });
});

describe('externalDomainSchema', () => {
  it('normalises a valid domain', () => {
    expect(externalDomainSchema.parse({ domain: ' Example.COM ' })).toEqual({ domain: 'example.com' });
  });

  it('rejects a reserved TLD with a readable message', () => {
    const result = externalDomainSchema.safeParse({ domain: 'e2e-weldtest.example' });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toMatch(/reserved/);
    }
  });
});
