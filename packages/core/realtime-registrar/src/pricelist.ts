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
