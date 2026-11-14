/** The part of a tax rate row the pickers filter on. */
export interface TaxRateOption {
  id: string;
  type?: string | null;
  name?: string | null;
  rate?: string | number | null;
  taxCategoryCode?: string | null;
  isDefault?: boolean | null;
  isActive?: boolean | null;
}

export type TaxRateDirection = 'sales' | 'purchase';

/** Two rates are twins when they are of the same category and the same percentage (a sales and a purchase "BTW 21%"). */
function areTwins(a: TaxRateOption, b: TaxRateOption): boolean {
  return !!a.taxCategoryCode && a.taxCategoryCode === b.taxCategoryCode && Number(a.rate) === Number(b.rate);
}

/**
 * The rates a document line may use: an invoice (a sale) takes `sales` and
 * `both` rates, a bill (a purchase) `purchase` and `both`. The API refuses the
 * other kind, so the picker does not offer it. A bill does not list a `both`
 * rate next to the `purchase` rate of the same category and percentage: they
 * would read as the same rate twice.
 */
export function taxRatesFor<T extends TaxRateOption>(rates: readonly T[], direction: TaxRateDirection): T[] {
  const usable = rates.filter((rate) => rate.type === direction || rate.type === 'both');
  if (direction === 'sales') return usable;
  return usable.filter(
    (rate) => !(rate.type === 'both' && usable.some((other) => other.type === 'purchase' && areTwins(other, rate))),
  );
}

/**
 * The tax rate a new line starts with: the workspace's default rate. For a sale it is the
 * active default when that is a sales or both rate. For a purchase it is the purchase twin of the
 * default (same category and percentage), else the default itself when a bill may use it.
 * Null when there is no default to offer.
 */
export function defaultTaxRateId<T extends TaxRateOption>(
  rates: readonly T[] | undefined,
  direction: TaxRateDirection,
): string | null {
  const active = (rates ?? []).filter((rate) => rate.isActive !== false);
  const preferred = active.find((rate) => rate.isDefault);
  if (!preferred) return null;
  if (direction === 'sales') {
    return preferred.type === 'sales' || preferred.type === 'both' ? preferred.id : null;
  }
  const twin = active.find((rate) => rate.type === 'purchase' && areTwins(rate, preferred));
  if (twin) return twin.id;
  return preferred.type === 'purchase' || preferred.type === 'both' ? preferred.id : null;
}

/** A rate as the pickers show it: its name, with the percentage added unless the name has it already. */
export function taxRateLabel(rate: Pick<TaxRateOption, 'name' | 'rate'>): string {
  const percentage = `${Number(rate.rate)}%`;
  const name = rate.name?.trim();
  if (!name) return percentage;
  return name.includes('%') ? name : `${name} (${percentage})`;
}
