import type { PostalAddress } from '@/components/address/postal-address';

/**
 * An address column on an accounting row. Rows written before the shared
 * `PostalAddress` shape carry the Dutch-style `{ street, houseNumber, province }`;
 * newer rows carry `{ line1, line2, state }`. The API returns either.
 */
export interface StoredAccountingAddress extends PostalAddress {
  street?: string;
  houseNumber?: string;
  province?: string;
  county?: string;
}

function str(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Read an accounting address in either shape as a `PostalAddress`:
 * street + houseNumber become `line1` and province becomes `state`. Returns
 * `null` for anything that holds no address at all.
 */
export function normalizeAccountingAddress(raw: unknown): PostalAddress | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const row = raw as Record<string, unknown>;

  const legacyLine1 = [str(row.street), str(row.houseNumber)].filter(Boolean).join(' ');
  const address: PostalAddress = {
    line1: str(row.line1) ?? (legacyLine1 || undefined),
    line2: str(row.line2),
    city: str(row.city),
    state: str(row.state) ?? str(row.province),
    postalCode: str(row.postalCode),
    country: str(row.country)?.toUpperCase(),
  };

  const hasAny = Object.values(address).some((v) => v !== undefined);
  return hasAny ? address : null;
}
