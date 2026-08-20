import type { DomainSearchResult } from '@weldsuite/core-api-client/schemas/domains';

export function normalizeDomainSearchTerm(term: string): string {
  return term
    .toLowerCase()
    .replace(/^(https?:\/\/)?(www\.)?/, '')
    .replace(/\.$/, '');
}

export function isTakenDomainResult(result: Pick<DomainSearchResult, 'status' | 'reason'>): boolean {
  if (result.reason && result.reason !== 'domain_unavailable') return false;
  return result.status === 2;
}

/**
 * The taken domain that matches what the user typed.
 * FQDN wins; for a bare name like `weldsuite`, prefer `weldsuite.com`.
 */
export function findExactTakenMatch(
  searchTerm: string,
  results: DomainSearchResult[],
): DomainSearchResult | undefined {
  const searchLower = normalizeDomainSearchTerm(searchTerm);
  if (!searchLower) return undefined;

  const taken = results.filter(isTakenDomainResult);
  const fqdnMatch = taken.find((r) => r.domain_name.toLowerCase() === searchLower);
  if (fqdnMatch) return fqdnMatch;

  if (searchLower.includes('.')) return undefined;

  return (
    taken.find((r) => r.domain_name.toLowerCase() === `${searchLower}.com`) ??
    taken.find((r) => r.domain_name.toLowerCase().split('.')[0] === searchLower)
  );
}
