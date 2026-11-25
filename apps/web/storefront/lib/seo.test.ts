import { describe, expect, it } from 'vitest';
import { absolute, withoutTrailingSlashes, type HeadContext } from './seo';
import { robotsTxt, sitemapXml } from './sitemap';

describe('trailing slashes', () => {
  // The regular expression the loop replaced, kept to show the two agree.
  const before = (value: string) => value.replace(/\/+$/, '');
  const inputs = ['', '/', '///', 'https://shop.example.com', 'https://shop.example.com/', 'https://shop.example.com///', 'https://shop.example.com/a/b/', '/a', 'a//b', 'a/ ', 'a/ /', ' /', 'a/\n', 'a\\'];

  it.each(inputs)('trims %j as the regular expression did', (input) => {
    expect(withoutTrailingSlashes(input)).toBe(before(input));
  });

  it('drops only the slashes at the very end', () => {
    expect(withoutTrailingSlashes('')).toBe('');
    expect(withoutTrailingSlashes('///')).toBe('');
    expect(withoutTrailingSlashes('https://shop.example.com//')).toBe('https://shop.example.com');
    expect(withoutTrailingSlashes('a//b')).toBe('a//b');
    expect(withoutTrailingSlashes('a/ ')).toBe('a/ ');
  });

  it('builds URLs on an origin given with trailing slashes', () => {
    const ctx = { primaryOrigin: 'https://shop.example.com//' } as HeadContext;
    expect(absolute(ctx, '/products')).toBe('https://shop.example.com/products');
    expect(sitemapXml('https://shop.example.com///', [{ path: '/' }])).toContain('<loc>https://shop.example.com/</loc>');
    expect(robotsTxt('https://shop.example.com/', false)).toContain('Sitemap: https://shop.example.com/sitemap.xml');
  });
});
