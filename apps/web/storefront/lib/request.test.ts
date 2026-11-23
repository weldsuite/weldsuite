import { describe, expect, it } from 'vitest';
import { catalogueClosed, showsPrices } from './access';
import { edgeVersion, isHttps, shopHost, shopperIp } from './forwarded';
import { isEditorOrigin, parseEditorMessage } from './preview';
import { redirectTarget } from './redirects';

describe('edge headers', () => {
  it('reads the shop host without a port, the shopper IP and the protocol', () => {
    const headers = new Headers({
      'x-storefront-host': 'My.Shop.localhost:8791',
      'x-forwarded-for': '203.0.113.7',
      'x-forwarded-proto': 'https',
      'x-storefront-version': 'sfv_2',
    });
    expect(shopHost(headers)).toBe('my.shop.localhost');
    expect(shopperIp(headers)).toBe('203.0.113.7');
    expect(isHttps(headers)).toBe(true);
    expect(edgeVersion(headers)).toBe('sfv_2');
  });

  it('ignores an address that is not one', () => {
    expect(shopperIp(new Headers({ 'x-forwarded-for': 'unknown' }))).toBeUndefined();
    expect(shopperIp(new Headers())).toBeUndefined();
    expect(isHttps(new Headers({ 'x-forwarded-proto': 'http' }))).toBe(false);
  });
});

describe('access', () => {
  it('hides prices from guests of a prices_signed_in shop, and the catalogue of a signed_in one', () => {
    expect(showsPrices('public', false)).toBe(true);
    expect(showsPrices('prices_signed_in', false)).toBe(false);
    expect(showsPrices('prices_signed_in', true)).toBe(true);
    expect(catalogueClosed('signed_in', false)).toBe(true);
    expect(catalogueClosed('signed_in', true)).toBe(false);
    expect(catalogueClosed('prices_signed_in', false)).toBe(false);
  });
});

describe('document redirects', () => {
  const redirects = [
    { fromPath: '/old-shop/mugs', toPath: '/categories/mugs' },
    { fromPath: '/sale', toPath: '/products?sort=price' },
    { fromPath: '/bad', toPath: 'javascript:alert(1)' },
  ];

  it('redirects an exact path, keeping the query unless the target has its own', () => {
    expect(redirectTarget(redirects, new URL('https://s.test/old-shop/mugs?ref=x'))).toBe('/categories/mugs?ref=x');
    expect(redirectTarget(redirects, new URL('https://s.test/sale?ref=x'))).toBe('/products?sort=price');
    expect(redirectTarget(redirects, new URL('https://s.test/old-shop'))).toBeNull();
    expect(redirectTarget(redirects, new URL('https://s.test/bad'))).toBeNull();
  });
});

describe('preview bridge messages', () => {
  it('takes the editor’s messages only, and paths of the shop only', () => {
    expect(parseEditorMessage({ source: 'weldsuite-storefront', type: 'refresh' })).toEqual({ type: 'refresh' });
    expect(parseEditorMessage({ source: 'weldsuite-storefront', type: 'highlight', sectionId: null })).toEqual({ type: 'highlight', sectionId: null });
    expect(parseEditorMessage({ source: 'weldsuite-storefront', type: 'navigate', path: '/cart' })).toEqual({ type: 'navigate', path: '/cart' });
    expect(parseEditorMessage({ source: 'weldsuite-storefront', type: 'navigate', path: 'https://evil.example' })).toBeNull();
    expect(parseEditorMessage({ source: 'other', type: 'refresh' })).toBeNull();
    expect(parseEditorMessage('refresh')).toBeNull();
  });

  it('accepts the configured editor origins only', () => {
    const allowed = ['https://app.weldsuite.eu', 'http://localhost:3000'];
    expect(isEditorOrigin('https://app.weldsuite.eu', allowed)).toBe(true);
    expect(isEditorOrigin('http://localhost:3000', allowed)).toBe(true);
    expect(isEditorOrigin('https://app.weldsuite.eu.evil.example', allowed)).toBe(false);
    expect(isEditorOrigin('null', allowed)).toBe(false);
  });
});
