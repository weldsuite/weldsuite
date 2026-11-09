/**
 * Allowed embed domains: one hostname per line or comma. `https://www.example.com/page`
 * becomes `www.example.com`; `example.com` also allows its subdomains (the
 * server's rule), so no wildcard syntax is needed.
 */

const DOTTED_HOSTNAME = /^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

function isHostname(value: string): boolean {
  return value === 'localhost' || (value.length <= 253 && DOTTED_HOSTNAME.test(value));
}

export function normalizeDomain(input: string): string | null {
  let value = input.trim().toLowerCase();
  if (value === '') return null;
  value = value.replace(/^[a-z][a-z0-9+.-]*:\/\//, '');
  // Drops the path, query and fragment. A line break is never dropped, so such a value fails below.
  value = value.replace(/^([^/?#]*)[/?#].*$/, '$1');
  value = value.replace(/:\d+$/, '');
  value = value.replace(/^\*\./, '');
  return isHostname(value) ? value : null;
}

export interface ParsedDomains {
  domains: string[];
  /** Entries that are not hostnames, as typed. */
  invalid: string[];
}

export function parseDomains(text: string): ParsedDomains {
  const domains: string[] = [];
  const invalid: string[] = [];
  for (const raw of text.split(/[\s,;]+/)) {
    if (raw.trim() === '') continue;
    const domain = normalizeDomain(raw);
    if (!domain) invalid.push(raw.trim());
    else if (!domains.includes(domain)) domains.push(domain);
  }
  return { domains, invalid };
}
