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
 * A value from the site builder's persisted document.
 *
 * The builder stores whatever each block's settings schema produced, and the
 * components read their own ad-hoc keys straight into string/ReactNode
 * positions (`settings.heading || heading`). The document is genuinely
 * heterogeneous — properly modelling it means a discriminated union over every
 * element type, which is a data-model change, not a lint fix. `unknown` would
 * force a cast at all ~76 read sites without making any of them safer.
 *
 * This alias is the ONE escape hatch for that, so the `any` lives here with an
 * explanation instead of scattered across ~40 component files.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type BuilderValue = any;

/** Free-form per-block settings bag from the builder. See {@link BuilderValue}. */
export type BlockSettings = Record<string, BuilderValue>;

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
  /** Option axes the selector blocks read off a variant. */
  size?: string;
  color?: string;
  colorHex?: string;
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
  slug?: string;
  description?: string;
  image?: string;
  /** Wide banner variant, used when `image` is absent. */
  banner?: string;
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
