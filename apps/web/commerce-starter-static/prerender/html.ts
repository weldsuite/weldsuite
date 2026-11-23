/**
 * Static HTML for product and category pages, written at build time so
 * search engines and link previews get a title, a description, a canonical
 * URL and JSON-LD without running the app. Every value is escaped; the app
 * replaces the page body and the `data-prerender` head tags when it starts.
 */

import { formatMoney, type StorefrontCategory, type StorefrontProduct } from '@weldsuite/commerce-sdk';

export interface ShopContext {
  /** The shop's origin, e.g. https://shop.example.com. */
  shopUrl: string;
  shopName: string;
  locale: string;
}

export interface PrerenderedPage {
  /** The page's path, e.g. /products/blue-mug (its file is <path>/index.html). */
  path: string;
  title: string;
  description: string;
  image: string | null;
  ogType: 'website' | 'product';
  jsonLd: Array<Record<string, unknown>>;
  /** The page's content, as HTML (already escaped). */
  body: string;
}

const ENTITIES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** Text for HTML content or a quoted attribute. */
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ENTITIES[char] ?? char);
}

const LINE_SEPARATOR = new RegExp(String.fromCharCode(0x2028), 'g');
const PARAGRAPH_SEPARATOR = new RegExp(String.fromCharCode(0x2029), 'g');

/** JSON for a `<script type="application/ld+json">`: nothing in it can close the script element. */
export function jsonLdText(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(LINE_SEPARATOR, '\\u2028')
    .replace(PARAGRAPH_SEPARATOR, '\\u2029');
}

/** A slug that is safe as a folder name and a URL segment; others are not prerendered (the app still serves them). */
export function safeSlug(slug: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._~-]{0,199}$/.test(slug) && !slug.includes('..');
}

/** Text without line breaks, shortened for a meta description. */
export function summary(text: string | null | undefined, max = 160): string {
  const flat = (text ?? '').replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}

function money(amount: string, currency: string, locale: string): string {
  try {
    return formatMoney(amount, currency, { locale });
  } catch {
    return amount;
  }
}

function https(url: string | null | undefined): string | null {
  return url && /^https?:\/\//.test(url) ? url : null;
}

export function productPage(product: StorefrontProduct, shop: ShopContext): PrerenderedPage {
  const path = `/products/${product.slug}`;
  const url = `${shop.shopUrl}${path}`;
  const image = https(product.featuredImageUrl) ?? https(product.images[0]?.url);
  const prices = product.variants.length > 0 ? product.variants.map((variant) => variant.price) : [product.price];
  const numeric = prices.map(Number).filter(Number.isFinite);
  const low = numeric.length > 0 ? Math.min(...numeric) : Number(product.price);
  const high = numeric.length > 0 ? Math.max(...numeric) : Number(product.price);
  const availability = product.available ? 'https://schema.org/InStock' : 'https://schema.org/OutOfStock';
  const lowText = prices.find((price) => Number(price) === low) ?? product.price;
  const highText = prices.find((price) => Number(price) === high) ?? product.price;
  const offers =
    low === high
      ? { '@type': 'Offer', url, priceCurrency: product.currency, price: lowText, availability }
      : { '@type': 'AggregateOffer', url, priceCurrency: product.currency, lowPrice: lowText, highPrice: highText, offerCount: product.variants.length, availability };
  const category = product.categories[0];
  const trail = [
    { name: 'Home', item: `${shop.shopUrl}/` },
    ...(category ? [{ name: category.name, item: `${shop.shopUrl}/categories/${encodeURIComponent(category.slug)}` }] : []),
    { name: product.name, item: url },
  ];
  const price = money(product.price, product.currency, shop.locale);
  return {
    path,
    title: `${product.name} · ${shop.shopName}`,
    description: summary(product.description) || product.name,
    image,
    ogType: 'product',
    jsonLd: [
      {
        '@context': 'https://schema.org',
        '@type': 'Product',
        name: product.name,
        url,
        ...(product.description ? { description: product.description.slice(0, 5000) } : {}),
        ...(image ? { image: [image] } : {}),
        offers,
      },
      breadcrumbs(trail),
    ],
    body: [
      '<main id="main">',
      `<h1>${escapeHtml(product.name)}</h1>`,
      image ? `<img src="${escapeHtml(image)}" alt="${escapeHtml(product.name)}" width="600" height="600">` : '',
      `<p>${escapeHtml(prices.length > 1 && low !== high ? `From ${price}` : price)}</p>`,
      product.description ? `<p>${escapeHtml(product.description)}</p>` : '',
      '</main>',
    ].join(''),
  };
}

export function categoryPage(category: StorefrontCategory, products: StorefrontProduct[], shop: ShopContext): PrerenderedPage {
  const path = `/categories/${category.slug}`;
  const url = `${shop.shopUrl}${path}`;
  const items = products
    .filter((product) => safeSlug(product.slug))
    .map((product) => `<li><a href="/products/${escapeHtml(product.slug)}">${escapeHtml(product.name)}</a></li>`)
    .join('');
  return {
    path,
    title: `${category.name} · ${shop.shopName}`,
    description: summary(category.description) || category.name,
    image: null,
    ogType: 'website',
    jsonLd: [
      { '@context': 'https://schema.org', '@type': 'CollectionPage', name: category.name, url, ...(category.description ? { description: category.description } : {}) },
      breadcrumbs([
        { name: 'Home', item: `${shop.shopUrl}/` },
        { name: category.name, item: url },
      ]),
    ],
    body: [
      '<main id="main">',
      `<h1>${escapeHtml(category.name)}</h1>`,
      category.description ? `<p>${escapeHtml(category.description)}</p>` : '',
      items ? `<ul>${items}</ul>` : '',
      '</main>',
    ].join(''),
  };
}

function breadcrumbs(trail: Array<{ name: string; item: string }>): Record<string, unknown> {
  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: trail.map((crumb, index) => ({ '@type': 'ListItem', position: index + 1, name: crumb.name, item: crumb.item })),
  };
}

/** The page's head tags, each marked `data-prerender` so the app can drop them. */
export function headTags(page: PrerenderedPage, shop: ShopContext): string {
  const url = `${shop.shopUrl}${page.path}`;
  const tags = [
    `<title data-prerender>${escapeHtml(page.title)}</title>`,
    `<meta data-prerender name="description" content="${escapeHtml(page.description)}">`,
    `<link data-prerender rel="canonical" href="${escapeHtml(url)}">`,
    `<meta data-prerender property="og:title" content="${escapeHtml(page.title)}">`,
    `<meta data-prerender property="og:description" content="${escapeHtml(page.description)}">`,
    `<meta data-prerender property="og:url" content="${escapeHtml(url)}">`,
    `<meta data-prerender property="og:type" content="${page.ogType}">`,
    `<meta data-prerender property="og:site_name" content="${escapeHtml(shop.shopName)}">`,
    ...(page.image ? [`<meta data-prerender property="og:image" content="${escapeHtml(page.image)}">`] : []),
    ...page.jsonLd.map((json) => `<script data-prerender type="application/ld+json">${jsonLdText(json)}</script>`),
  ];
  return tags.join('\n    ');
}

/** The app's index.html with the page's head tags and body. */
export function renderPage(template: string, page: PrerenderedPage, shop: ShopContext): string {
  const withoutTitle = template.replace(/<title data-prerender>[\s\S]*?<\/title>/, '');
  const head = withoutTitle.replace('</head>', `    ${headTags(page, shop)}\n  </head>`);
  return head.replace('<div id="root"></div>', `<div id="root">${page.body}</div>`);
}

/** The shell every other path gets (the SPA fallback): just the shop's name as its title. */
export function renderIndex(template: string, shop: ShopContext): string {
  return template.replace(/<title data-prerender>[\s\S]*?<\/title>/, `<title data-prerender>${escapeHtml(shop.shopName)}</title>`);
}
