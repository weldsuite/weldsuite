/** `sitemap.xml` and `robots.txt` for a shop, on its primary origin. */

export interface SitemapEntry {
  path: string;
}

function escapeXml(text: string): string {
  return text.replace(/[<>&'"]/g, (char) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[char] ?? char);
}

/** The most URLs one sitemap file may hold. */
export const SITEMAP_LIMIT = 50_000;

export interface SitemapInput {
  origin: string;
  /** Whether guests may see the catalogue (`settings.access` is not `signed_in`). */
  catalogue: boolean;
  products: Array<{ slug: string }>;
  categories: Array<{ slug: string }>;
  pages: Array<{ slug: string }>;
}

/** The shop's public URLs, without duplicates: home, the catalogue (when public) and the content pages. */
export function sitemapEntries(input: SitemapInput): SitemapEntry[] {
  const paths = new Set<string>();
  if (input.catalogue) {
    paths.add('/');
    paths.add('/products');
    for (const category of input.categories) paths.add(`/categories/${encodeURIComponent(category.slug)}`);
    for (const product of input.products) paths.add(`/products/${encodeURIComponent(product.slug)}`);
  }
  for (const page of input.pages) paths.add(`/pages/${encodeURIComponent(page.slug)}`);
  return [...paths].slice(0, SITEMAP_LIMIT).map((path) => ({ path }));
}

export function sitemapXml(origin: string, entries: SitemapEntry[]): string {
  const base = origin.replace(/\/+$/, '');
  const urls = entries.map((entry) => `  <url><loc>${escapeXml(base + entry.path)}</loc></url>`);
  return ['<?xml version="1.0" encoding="UTF-8"?>', '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">', ...urls, '</urlset>', ''].join('\n');
}

/** robots.txt: personal pages stay out of the index; a preview stays out entirely. */
export function robotsTxt(origin: string, preview: boolean): string {
  if (preview) return 'User-agent: *\nDisallow: /\n';
  const base = origin.replace(/\/+$/, '');
  return [
    'User-agent: *',
    'Disallow: /cart',
    'Disallow: /checkout',
    'Disallow: /account',
    'Disallow: /orders/',
    'Disallow: /quick-order',
    'Disallow: /search',
    '',
    `Sitemap: ${base}/sitemap.xml`,
    '',
  ].join('\n');
}
