import type { ProductPrice } from '../types';

/**
 * Coerce a product price to a plain number.
 *
 * `Product.price` is heterogeneous: the commerce API returns a number on some
 * endpoints, a Money object (`{ amount }`) on others, and builder/mock data
 * sometimes carries a preformatted string. Anything unparseable becomes 0 so
 * callers can format without extra guards.
 */
export function toPriceNumber(price: ProductPrice | undefined | null): number {
  if (price === undefined || price === null || price === '') return 0;
  if (typeof price === 'number') return Number.isFinite(price) ? price : 0;
  if (typeof price === 'object') return Number.isFinite(price.amount) ? price.amount : 0;
  const parsed = parseFloat(price);
  return Number.isNaN(parsed) ? 0 : parsed;
}
