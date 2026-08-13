/**
 * Exact-match helpers for WeldHost domain search.
 *
 * ADAC `input` expands a query across a TLD set and may also emit similar-name
 * suggestions. Search should keep only the typed second-level name
 * (`weldsuite` → `weldsuite.com`, not `getweldsuite.com`).
 */

export function normalizeDomainSearchQuery(query: string): string {
  return query
    .trim()
    .toLowerCase()
    .replace(/^(https?:\/\/)?(www\.)?/, '')
    .replace(/\.$/, '');
}

export function domainSearchSld(query: string): string {
  const cleaned = normalizeDomainSearchQuery(query);
  const dot = cleaned.indexOf('.');
  return dot === -1 ? cleaned : cleaned.slice(0, dot);
}

/**
 * True when `domainName` is the typed label with any TLD.
 * `weldsuite` and `weldsuite.com` match `weldsuite.net`, not `weld-suite.com`.
 */
export function isExactSldMatch(query: string, domainName: string): boolean {
  const sld = domainSearchSld(query);
  if (!sld) return false;
  const nameSld = domainName.trim().toLowerCase().split('.')[0] ?? '';
  return nameSld === sld;
}

/** Pin a typed FQDN first; otherwise keep ADAC TLD-set order (including taken). */
export function rankExactDomainSearchResults<T extends { name: string }>(
  query: string,
  results: T[],
): T[] {
  const fqdn = normalizeDomainSearchQuery(query);
  if (!fqdn.includes('.')) return results;
  return [...results].sort(
    (a, b) => Number(a.name === fqdn ? 0 : 1) - Number(b.name === fqdn ? 0 : 1),
  );
}
