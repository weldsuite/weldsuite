import type { ProductImage } from '../types';

/**
 * Flatten a product's image list to plain URL strings.
 *
 * `Product.images` is heterogeneous: the commerce API returns image objects
 * (`src` on some endpoints, `url` on others) while builder mock data and older
 * blocks use bare URL strings. Blocks that only need a `src` attribute call
 * this instead of branching on the shape themselves. Entries that resolve to
 * no URL are dropped.
 */
export function toImageUrls(images?: (string | ProductImage)[]): string[] {
  return (images ?? [])
    .map((img) => (typeof img === 'string' ? img : (img.src ?? img.url ?? '')))
    .filter((url): url is string => url.length > 0);
}
