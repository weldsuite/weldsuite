/**
 * Titles, descriptions, canonical URLs, Open Graph and JSON-LD (Product with
 * offers, BreadcrumbList). Loaders work out a `PageHead` on the server; the
 * routes turn it into tags.
 */

import type { StorefrontProduct } from '@weldsuite/commerce-sdk';
import { compareMoney } from '@weldsuite/commerce-sdk';
import { format, safeImageSrc, type ShopStrings } from '@weldsuite/storefront-theme';

export interface PageHead {
  /** The full `<title>`. */
  title: string;
  description?: string;
  /** Absolute, on the primary origin; absent for personal pages. */
  canonical?: string;
  image?: string;
  ogType?: 'website' | 'product';
  /** JSON-LD documents, already serialised (and safe inside a script element). */
  jsonLd?: string[];
  noindex?: boolean;
}

export interface HeadContext {
  shopName: string;
  strings: ShopStrings;
  primaryOrigin: string;
  preview: boolean;
  /** The site's SEO defaults. */
  seo: { title?: string; description?: string; imageUrl?: string };
}

/** "Page | Shop", or the shop's own title for its home page. */
export function pageTitle(ctx: HeadContext, page: string | null): string {
  const shop = ctx.seo.title?.trim() || ctx.shopName;
  return page ? format(ctx.strings.meta.pageTitle, { page, shop: ctx.shopName }) : shop;
}

export function absolute(ctx: HeadContext, path: string): string {
  return `${ctx.primaryOrigin.replace(/\/+$/, '')}${path}`;
}

/** A head for a page: defaults from the site's SEO, noindex in preview and for personal pages. */
export function makeHead(
  ctx: HeadContext,
  page: { title: string | null; description?: string | null; path?: string; image?: string | null; ogType?: 'website' | 'product'; jsonLd?: Array<Record<string, unknown>>; personal?: boolean },
): PageHead {
  const description = page.description?.trim() || ctx.seo.description?.trim() || undefined;
  const image = safeImageSrc(page.image) ?? safeImageSrc(ctx.seo.imageUrl) ?? undefined;
  return {
    title: pageTitle(ctx, page.title),
    ...(description ? { description } : {}),
    ...(page.path && !page.personal ? { canonical: absolute(ctx, page.path) } : {}),
    ...(image ? { image: image.startsWith('/') ? absolute(ctx, image) : image } : {}),
    ogType: page.ogType ?? 'website',
    ...(page.jsonLd && !page.personal ? { jsonLd: page.jsonLd.map(jsonLdText) } : {}),
    noindex: ctx.preview || page.personal === true,
  };
}

/** `BreadcrumbList` for a trail of (name, path). */
export function breadcrumbJsonLd(ctx: HeadContext, trail: Array<{ name: string; path: string }>): Record<string, unknown> {
  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: trail.map((crumb, index) => ({ '@type': 'ListItem', position: index + 1, name: crumb.name, item: absolute(ctx, crumb.path) })),
  };
}

function availability(available: boolean): string {
  return available ? 'https://schema.org/InStock' : 'https://schema.org/OutOfStock';
}

/** `Product` with its offer (or price range); without offers when the shop hides prices. */
export function productJsonLd(ctx: HeadContext, product: StorefrontProduct, path: string, withOffers: boolean): Record<string, unknown> {
  const url = absolute(ctx, path);
  const images = [product.featuredImageUrl, ...product.images.map((image) => image.url)]
    .map((src) => safeImageSrc(src))
    .filter((src): src is string => src !== null);
  const json: Record<string, unknown> = {
    '@context': 'https://schema.org',
    '@type': 'Product',
    name: product.name,
    url,
    ...(product.description ? { description: product.description.slice(0, 5000) } : {}),
    ...(images.length > 0 ? { image: [...new Set(images)] } : {}),
  };
  const sku = product.variants.length === 1 ? product.variants[0]?.sku : null;
  if (sku) json.sku = sku;
  if (!withOffers) return json;
  const prices = (product.variants.length > 0 ? product.variants.map((variant) => variant.price) : [product.price]).slice().sort((a, b) => {
    try {
      return compareMoney(a, b);
    } catch {
      return 0;
    }
  });
  const low = prices[0] ?? product.price;
  const high = prices[prices.length - 1] ?? product.price;
  json.offers =
    low === high
      ? { '@type': 'Offer', url, priceCurrency: product.currency, price: low, availability: availability(product.available) }
      : {
          '@type': 'AggregateOffer',
          url,
          priceCurrency: product.currency,
          lowPrice: low,
          highPrice: high,
          offerCount: product.variants.length,
          availability: availability(product.available),
        };
  return json;
}

/** JSON for a `<script type="application/ld+json">`, safe inside HTML. */
export function jsonLdText(value: Record<string, unknown>): string {
  return JSON.stringify(value).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

/** The tags of a head, for a route's `head()`. */
export function headTags(head: PageHead | undefined) {
  if (!head) return { meta: [] };
  const meta: Array<Record<string, string>> = [
    { title: head.title },
    { property: 'og:title', content: head.title },
    { property: 'og:type', content: head.ogType ?? 'website' },
  ];
  if (head.description) {
    meta.push({ name: 'description', content: head.description }, { property: 'og:description', content: head.description });
  }
  if (head.canonical) meta.push({ property: 'og:url', content: head.canonical });
  if (head.image) meta.push({ property: 'og:image', content: head.image }, { name: 'twitter:card', content: 'summary_large_image' });
  if (head.noindex) meta.push({ name: 'robots', content: 'noindex' });
  return {
    meta,
    links: head.canonical ? [{ rel: 'canonical', href: head.canonical }] : [],
    scripts: (head.jsonLd ?? []).map((json) => ({ type: 'application/ld+json', children: json })),
  };
}
