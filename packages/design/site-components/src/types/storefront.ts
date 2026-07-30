/**
 * Storefront data passed into section/block components as the `store` prop.
 *
 * These blocks render whatever the site builder hands them, and the same
 * component runs against three sources — live WeldCommerce data, the builder's
 * preview payload, and hard-coded demo defaults. Fields are therefore optional
 * across the board: a block must degrade gracefully rather than assume a field
 * is present.
 *
 * The shape is derived from what the blocks actually read plus the `store`
 * object assembled in `apps/web/sites/app/[domain]/page.tsx`.
 */

/**
 * Free-form per-block settings bag.
 *
 * The site builder persists whatever the block's settings schema produced, and
 * every block reads its own ad-hoc keys straight into string/ReactNode
 * positions (`settings.heading || heading`). There is no single shape to
 * describe, and `unknown` would force a cast at all ~76 read sites without
 * making any of them safer. This alias keeps that escape hatch in ONE place
 * instead of scattering `any` across the block components.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type BlockSettings = Record<string, any>;

/**
 * An image on a product. WeldCommerce returns objects; the builder preview and
 * the blocks' own demo defaults use bare URL strings, so both forms reach the
 * components. Normalize with `productImageSrc` / `productImageAlt`.
 */
export type StoreProductImage = string | { src?: string; alt?: string; url?: string };

/** URL for a product image in either wire form. */
export function productImageSrc(image: StoreProductImage | undefined): string {
  if (!image) return '';
  return typeof image === 'string' ? image : (image.src ?? image.url ?? '');
}

/** Numeric value of a price in any of its wire forms; NaN-safe. */
export function priceAmount(price: StorePrice | undefined): number {
  if (price == null) return 0;
  if (typeof price === 'number') return price;
  if (typeof price === 'string') {
    const n = parseFloat(price);
    return Number.isNaN(n) ? 0 : n;
  }
  return price.amount ?? 0;
}

/** Alt text for a product image; string-form images carry none. */
export function productImageAlt(image: StoreProductImage | undefined, fallback = ''): string {
  if (!image || typeof image === 'string') return fallback;
  return image.alt ?? fallback;
}

/**
 * A Shopify-style Money object. WeldCommerce returns plain numbers, but
 * imported Shopify/Woo catalogues surface `{ amount, currencyCode }`, and the
 * blocks branch on `'amount' in price` to handle both.
 */
export interface StoreMoney {
  amount: number;
  currencyCode?: string;
}

/** A price in any of the three forms that reach the blocks. */
export type StorePrice = number | string | StoreMoney;

/** A product variant option (size, colour, …). */
export interface StoreProductVariant {
  id?: string;
  name?: string;
  value?: string;
  price?: StorePrice;
  available?: boolean;
  stock?: number;
}

export interface StoreProduct {
  id?: string;
  name?: string;
  handle?: string;
  description?: string;
  /** A bare category name, or the joined category row when the API expands it. */
  category?: string | { id?: string; name?: string };
  categoryIds?: string[];
  collection?: string;
  collectionId?: string;

  price?: StorePrice;
  salePrice?: StorePrice;
  compareAtPrice?: StorePrice;
  currency?: string;
  discountPercent?: number;

  image?: string;
  imageUrl?: string;
  featuredImageUrl?: string;
  images?: StoreProductImage[];

  badge?: string;
  rating?: number;
  reviews?: number;
  reviewCount?: number;

  stock?: number;
  inventoryQuantity?: number;
  sizes?: string[];
  colors?: string[];
  variants?: StoreProductVariant[];

  link?: string;
  storeName?: string;
  /** Collapsible "product information" sections rendered by the accordion blocks. */
  info?: StoreProductInfoItem[];
}

/** One collapsible product-information section. */
export interface StoreProductInfoItem {
  id: string;
  title: string;
  content: string;
}

export interface StoreCollection {
  id?: string;
  name?: string;
  title?: string;
  handle?: string;
  description?: string;
  image?: string;
  link?: string;
  price?: StorePrice;
  productCount?: number;
}

export interface StoreBlogPost {
  id?: string;
  title?: string;
  excerpt?: string;
  image?: string;
  link?: string;
  date?: string;
  author?: string;
}

/** The `store` prop threaded through every storefront section and block. */
export interface StoreData {
  name?: string;
  description?: string;
  logo?: string;
  products?: StoreProduct[];
  collections?: StoreCollection[];
  blogPosts?: StoreBlogPost[];
  /** Set by the builder preview when a specific product is being previewed. */
  selectedProduct?: StoreProduct;
}
