import { describe, expect, it } from 'vitest';
import { robotsTxt, sitemapEntries, sitemapXml } from './sitemap';

describe('sitemap', () => {
  const input = {
    origin: 'https://shop.example.com',
    catalogue: true,
    products: [{ slug: 'blue-mug' }, { slug: 'blue-mug' }, { slug: 'tea & co' }],
    categories: [{ slug: 'mugs' }],
    pages: [{ slug: 'about' }],
  };

  it('lists home, the catalogue and the content pages, once each', () => {
    expect(sitemapEntries(input).map((entry) => entry.path)).toEqual([
      '/',
      '/products',
      '/categories/mugs',
      '/products/blue-mug',
      '/products/tea%20%26%20co',
      '/pages/about',
    ]);
  });

  it('leaves the catalogue out when guests may not see it', () => {
    expect(sitemapEntries({ ...input, catalogue: false }).map((entry) => entry.path)).toEqual(['/pages/about']);
  });

  it('writes absolute, escaped URLs on the primary origin', () => {
    const xml = sitemapXml('https://shop.example.com/', [{ path: '/pages/a?b=1&c=2' }]);
    expect(xml).toContain('<loc>https://shop.example.com/pages/a?b=1&amp;c=2</loc>');
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    expect(xml).toContain('xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"');
  });

  it('points robots.txt at the sitemap, and keeps previews out entirely', () => {
    expect(robotsTxt('https://shop.example.com', false)).toContain('Sitemap: https://shop.example.com/sitemap.xml');
    expect(robotsTxt('https://shop.example.com', false)).toContain('Disallow: /checkout');
    expect(robotsTxt('https://shop.example.com', true)).toBe('User-agent: *\nDisallow: /\n');
  });
});
