import { describe, expect, it } from 'vitest';
import { resolveMenuLink } from './menu-links';

const pages = [
  { id: 'sfp_about', slug: 'about' },
  { id: 'sfp_terms', slug: 'terms' },
];

describe('menu links', () => {
  it('resolves the fixed links', () => {
    expect(resolveMenuLink({ type: 'home' }, pages)).toBe('/');
    expect(resolveMenuLink({ type: 'catalog' }, pages)).toBe('/products');
    expect(resolveMenuLink({ type: 'cart' }, pages)).toBe('/cart');
    expect(resolveMenuLink({ type: 'account' }, pages)).toBe('/account');
    expect(resolveMenuLink({ type: 'search' }, pages)).toBe('/search');
  });

  it('links products and categories by id (their pages redirect to the slug)', () => {
    expect(resolveMenuLink({ type: 'product', id: 'prd_1' }, pages)).toBe('/products/prd_1');
    expect(resolveMenuLink({ type: 'category', id: 'cat 2' }, pages)).toBe('/categories/cat%202');
  });

  it('links pages by slug, and drops a link to a page that is not published', () => {
    expect(resolveMenuLink({ type: 'page', id: 'sfp_about' }, pages)).toBe('/pages/about');
    expect(resolveMenuLink({ type: 'page', id: 'sfp_hidden' }, pages)).toBeNull();
  });

  it('keeps safe URLs only', () => {
    expect(resolveMenuLink({ type: 'url', url: 'https://example.com/a' }, pages)).toBe('https://example.com/a');
    expect(resolveMenuLink({ type: 'url', url: '/pages/about#team' }, pages)).toBe('/pages/about#team');
    expect(resolveMenuLink({ type: 'url', url: 'javascript:alert(1)' }, pages)).toBeNull();
    expect(resolveMenuLink({ type: 'url', url: '//evil.example' }, pages)).toBeNull();
  });
});
