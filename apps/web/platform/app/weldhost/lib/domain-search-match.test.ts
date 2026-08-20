import { describe, expect, it } from 'vitest';
import {
  findExactTakenMatch,
  isTakenDomainResult,
  normalizeDomainSearchTerm,
} from './domain-search-match';
import type { DomainSearchResult } from '@weldsuite/core-api-client/schemas/domains';

function result(
  domain_name: string,
  status: 1 | 2,
  reason?: DomainSearchResult['reason'],
): DomainSearchResult {
  return {
    domain_name,
    suffix: domain_name.split('.').slice(1).join('.'),
    status,
    premium: false,
    price: status === 1 ? 1046 : null,
    currency: 'USD',
    domain: domain_name,
    available: status === 1,
    reason,
  };
}

describe('normalizeDomainSearchTerm', () => {
  it('strips protocol, www, and trailing dots', () => {
    expect(normalizeDomainSearchTerm('HTTPS://WWW.WeldSuite.com.')).toBe('weldsuite.com');
  });
});

describe('isTakenDomainResult', () => {
  it('treats status 2 with domain_unavailable as taken', () => {
    expect(isTakenDomainResult(result('weldsuite.com', 2, 'domain_unavailable'))).toBe(true);
  });

  it('treats status 2 without a reason as taken', () => {
    expect(isTakenDomainResult(result('weldsuite.com', 2))).toBe(true);
  });
});

describe('findExactTakenMatch', () => {
  const results = [
    result('weldsuite.com', 2, 'domain_unavailable'),
    result('weldsuite.net', 1),
    result('weldsuite.org', 2, 'domain_unavailable'),
  ];

  it('matches a typed FQDN', () => {
    expect(findExactTakenMatch('WeldSuite.com', results)?.domain_name).toBe('weldsuite.com');
  });

  it('prefers .com when the query is a bare name', () => {
    expect(findExactTakenMatch('WeldSuite', results)?.domain_name).toBe('weldsuite.com');
  });

  it('returns undefined when the typed FQDN is available', () => {
    expect(findExactTakenMatch('weldsuite.net', results)).toBeUndefined();
  });
});
