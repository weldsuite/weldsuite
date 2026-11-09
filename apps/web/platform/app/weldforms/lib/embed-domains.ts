/**
 * Allowed embed domains: one hostname per line or comma. `https://www.example.com/page`
 * becomes `www.example.com`; `example.com` also allows its subdomains (the
 * server's rule), so no wildcard syntax is needed.
 */

const HOSTNAME = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$|^localhost$/;

export function normalizeDomain(input: string): string | null {
  let value = input.trim().toLowerCase();
  if (value === '') return null;
  value = value.replace(/^[a-z][a-z0-9+.-]*:\/\//, '');
  value = value.replace(/[/?#].*$/, '');
  value = value.replace(/:\d+$/, '');
  value = value.replace(/^\*\./, '');
  return HOSTNAME.test(value) ? value : null;
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
