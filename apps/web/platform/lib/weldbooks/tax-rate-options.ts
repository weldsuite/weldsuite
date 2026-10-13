/** The part of a tax rate row the pickers filter on. */
export interface TaxRateOption {
  id: string;
  type?: string | null;
}

/**
 * The rates a document line may use: an invoice (a sale) takes `sales` and
 * `both` rates, a bill (a purchase) `purchase` and `both`. The API refuses the
 * other kind, so the picker does not offer it.
 */
export function taxRatesFor<T extends TaxRateOption>(rates: readonly T[], direction: 'sales' | 'purchase'): T[] {
  return rates.filter((rate) => rate.type === direction || rate.type === 'both');
}
