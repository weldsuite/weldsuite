/**
 * One postal address shape for WeldBooks.
 *
 * Accounting rows used to store a Dutch-style address (street + houseNumber,
 * province); parties, companies and orders use line1/line2/state. Everything
 * now reads and writes the shared shape, and `normalizePostalAddress` turns a
 * row in either shape (or a request body in either shape) into it.
 */

import type { PostalAddress, StoredPostalAddress } from '@weldsuite/db/schema';

export type { PostalAddress, StoredPostalAddress };

const ADDRESS_FIELDS = ['line1', 'line2', 'city', 'state', 'postalCode', 'country', 'county'] as const;

function clean(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

/**
 * The shared address for a value in either shape, or null when it holds
 * nothing. Legacy `street` + `houseNumber` become `line1` ("Damrak 1"),
 * `province` becomes `state`; country codes are upper-cased.
 */
export function normalizePostalAddress(
  input: StoredPostalAddress | Record<string, unknown> | null | undefined,
): PostalAddress | null {
  if (!input || typeof input !== 'object') return null;
  const raw = input as Record<string, unknown>;

  const street = clean(raw.street);
  const houseNumber = clean(raw.houseNumber);
  const legacyLine1 = [street, houseNumber].filter(Boolean).join(' ') || undefined;

  const address: PostalAddress = {
    line1: clean(raw.line1) ?? legacyLine1,
    line2: clean(raw.line2),
    city: clean(raw.city),
    state: clean(raw.state) ?? clean(raw.province),
    postalCode: clean(raw.postalCode),
    country: clean(raw.country)?.toUpperCase(),
    county: clean(raw.county),
  };

  const result: PostalAddress = {};
  for (const field of ADDRESS_FIELDS) {
    const value = address[field];
    if (value !== undefined) result[field] = value;
  }
  return Object.keys(result).length > 0 ? result : null;
}

/**
 * Printable lines for an address: street lines, then "city, ST 12345" for the
 * US and "1234 AB City" elsewhere, then the country code when it differs from
 * the issuer's.
 */
export function formatPostalAddressLines(
  input: StoredPostalAddress | null | undefined,
  options: { omitCountry?: string } = {},
): string[] {
  const address = normalizePostalAddress(input);
  if (!address) return [];

  const lines: string[] = [];
  if (address.line1) lines.push(address.line1);
  if (address.line2) lines.push(address.line2);

  const isUs = address.country === 'US';
  const locality = isUs
    ? [address.city, [address.state, address.postalCode].filter(Boolean).join(' ')].filter(Boolean).join(', ')
    : [address.postalCode, address.city].filter(Boolean).join(' ');
  if (locality) lines.push(locality);
  if (!isUs && address.state) lines.push(address.state);

  const omit = options.omitCountry?.toUpperCase();
  if (address.country && address.country !== omit) lines.push(address.country);
  return lines;
}
