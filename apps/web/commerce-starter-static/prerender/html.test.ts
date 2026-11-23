import type { StorefrontCategory, StorefrontProduct } from '@weldsuite/commerce-sdk';
import { describe, expect, it } from 'vitest';

import { withOrigin } from './plugin';
import { categoryPage, escapeHtml, jsonLdText, productPage, renderIndex, renderPage, safeSlug } from './html';

const shop = { shopUrl: 'https://shop.example.com', shopName: 'Mugs & <Co>', locale: 'en-IE' };
const template = '<!doctype html><html><head><title data-prerender>Shop</title></head><body><div id="root"></div></body></html>';

const product: StorefrontProduct = {
  id: 'prd_1',
  slug: 'blue-mug',
  name: 'Blue "mug" <script>alert(1)</script>',
  description: 'Holds </script><script>alert(2)</script> tea & coffee',
  featuredImageUrl: 'https://cdn.example.com/m.jpg',
  images: [],
  currency: 'EUR',
  price: '19.95',
  compareAtPrice: null,
  options: [],
  variants: [],
  available: true,
  categories: [{ id: 'cat_1', slug: 'mugs', name: 'Mugs' }],
};

describe('escaping', () => {
  it('escapes text for HTML content and attributes', () => {
    expect(escapeHtml(`<a href="x">'&'</a>`)).toBe('&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;');
  });

  it('keeps JSON-LD from closing its script element', () => {
    const text = jsonLdText({ name: '</script><script>alert(1)</script>', note: `a${String.fromCharCode(0x2028)}b` });
    expect(text).not.toContain('</script');
    expect(text).not.toContain('<');
    expect(text).toContain('\\u003c/script\\u003e');
    expect(text).toContain('\\u2028');
    expect(JSON.parse(text)).toEqual({ name: '</script><script>alert(1)</script>', note: `a${String.fromCharCode(0x2028)}b` });
  });

  it('only prerenders slugs that are safe folder names', () => {
    expect(safeSlug('blue-mug_2.0')).toBe(true);
    expect(safeSlug('../etc')).toBe(false);
    expect(safeSlug('a/b')).toBe(false);
    expect(safeSlug('')).toBe(false);
    expect(safeSlug('mug%20x')).toBe(false);
  });
});

describe('prerendered pages', () => {
  it('writes a product page with escaped head tags, canonical URL and JSON-LD', () => {
    const html = renderPage(template, productPage(product, shop), shop);
    expect(html).not.toContain('<script>alert');
    expect(html).toContain('<link data-prerender rel="canonical" href="https://shop.example.com/products/blue-mug">');
    expect(html).toContain('<title data-prerender>Blue &quot;mug&quot; &lt;script&gt;alert(1)&lt;/script&gt; · Mugs &amp; &lt;Co&gt;</title>');
    expect(html.match(/<title/g)).toHaveLength(1);
    const ld = [...html.matchAll(/<script data-prerender type="application\/ld\+json">(.*?)<\/script>/g)].map((match) => JSON.parse(match[1] ?? ''));
    expect(ld[0]).toMatchObject({ '@type': 'Product', offers: { '@type': 'Offer', price: '19.95', priceCurrency: 'EUR' } });
    expect(ld[1]).toMatchObject({ '@type': 'BreadcrumbList' });
    expect(html).toContain('<div id="root"><main id="main"><h1>');
  });

  it('gives a product with several prices an aggregate offer', () => {
    const variants = [
      { id: 'v1', name: 'S', sku: 'S', optionValues: { Size: 'S' }, price: '10.00', compareAtPrice: null, available: true },
      { id: 'v2', name: 'L', sku: 'L', optionValues: { Size: 'L' }, price: '12.50', compareAtPrice: null, available: false },
    ];
    const page = productPage({ ...product, variants, price: '10.00' }, shop);
    expect(page.jsonLd[0]).toMatchObject({ offers: { '@type': 'AggregateOffer', lowPrice: '10.00', highPrice: '12.50', offerCount: 2 } });
  });

  it('lists a category’s products', () => {
    const category: StorefrontCategory = { id: 'cat_1', slug: 'mugs', name: 'Mugs', description: null, parentId: null, children: [] };
    const page = categoryPage(category, [product], shop);
    expect(page.path).toBe('/categories/mugs');
    expect(page.body).toContain('<a href="/products/blue-mug">');
    expect(page.description).toBe('Mugs');
  });

  it('names the fallback page after the shop', () => {
    expect(renderIndex(template, shop)).toContain('<title data-prerender>Mugs &amp; &lt;Co&gt;</title>');
  });
});

describe('build-time fetch', () => {
  it('sends the shop’s origin with every catalogue request', async () => {
    let seen: Headers | undefined;
    const fetch = withOrigin('https://shop.example.com', async (_url, init) => {
      seen = new Headers(init.headers);
      return new Response('{}');
    });
    await fetch('https://api.example.com/storefront/v1/products', { headers: { Authorization: 'Bearer wcp_x' } });
    expect(seen?.get('origin')).toBe('https://shop.example.com');
    expect(seen?.get('authorization')).toBe('Bearer wcp_x');
  });
});
