/**
 * Realtime Register customer pricelist — wholesale CREATE/RENEW/TRANSFER
 * in cents, keyed by TLD (`domain_com` → `com`).
 *
 * @see https://dm.realtimeregister.com/docs/api/customers/pricelist
 */

export interface DomainWholesalePrice {
  createCents: number;
  renewCents?: number;
  transferCents?: number;
  currency: string;
}

export interface PricelistRow {
  product?: string;
  action?: string;
  currency?: string;
  price?: number;
}

export function parseDomainPricelist(
  prices: PricelistRow[] | undefined | null,
): Map<string, DomainWholesalePrice> {
  const byTld = new Map<string, DomainWholesalePrice>();
  for (const row of prices ?? []) {
    if (typeof row.product !== 'string' || typeof row.price !== 'number') continue;
    if (!row.product.startsWith('domain_')) continue;
    const tld = row.product.slice('domain_'.length).replace(/^\./, '').toLowerCase();
    if (!tld) continue;

    let entry = byTld.get(tld);
    if (!entry) {
      entry = { createCents: 0, currency: (row.currency ?? 'EUR').toUpperCase() };
      byTld.set(tld, entry);
    }
    if (row.currency) entry.currency = row.currency.toUpperCase();

    const action = (row.action ?? '').toUpperCase();
    if (action === 'CREATE') entry.createCents = row.price;
    else if (action === 'RENEW') entry.renewCents = row.price;
    else if (action === 'TRANSFER') entry.transferCents = row.price;
  }

  for (const [tld, entry] of byTld) {
    if (!entry.createCents) byTld.delete(tld);
  }
  return byTld;
}

/** Strip a leading dot and lowercase — catalog rows sometimes store `.com`. */
export function normalizeTld(tld: string): string {
  return tld.replace(/^\./, '').trim().toLowerCase();
}

/** RTR prices are integer cents; `domain_pricing` stores major units. */
export function centsToMajorUnits(cents: number): string {
  return (cents / 100).toFixed(2);
}

const POPULAR_TLDS = new Set([
  'com', 'net', 'org', 'nl', 'be', 'de', 'eu', 'io', 'app', 'ai',
]);

export interface DomainPricingBackfillRow {
  tld: string;
  registrationPrice: string;
  renewalPrice: string;
  transferPrice: string;
  currency: string;
  isPopular: boolean;
  registrar: 'realtimeregister';
}

/**
 * Rows to insert into master `domain_pricing` for TLDs present on the RTR
 * pricelist but missing from the catalog. Existing TLDs (and their markup)
 * are left untouched.
 */
export function missingDomainPricingFromPricelist(
  wholesale: Map<string, DomainWholesalePrice>,
  existingTlds: Iterable<string>,
): DomainPricingBackfillRow[] {
  const existing = new Set(
    [...existingTlds].map(normalizeTld).filter(Boolean),
  );
  const rows: DomainPricingBackfillRow[] = [];
  for (const [rawTld, price] of wholesale) {
    const tld = normalizeTld(rawTld);
    if (!tld || existing.has(tld) || !price.createCents) continue;
    const create = centsToMajorUnits(price.createCents);
    rows.push({
      tld,
      registrationPrice: create,
      renewalPrice: centsToMajorUnits(price.renewCents ?? price.createCents),
      transferPrice: centsToMajorUnits(price.transferCents ?? price.createCents),
      currency: (price.currency || 'EUR').toUpperCase(),
      isPopular: POPULAR_TLDS.has(tld),
      registrar: 'realtimeregister',
    });
  }
  return rows.sort((a, b) => a.tld.localeCompare(b.tld));
}
