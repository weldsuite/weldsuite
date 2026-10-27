import { describe, expect, it } from 'vitest';
import { excludedPathMatcher, isSecretParam, parsePageUrl, parseReferrer } from './url';

describe('isSecretParam', () => {
  it.each([
    'token', 'key', 'secret', 'password', 'pass', 'auth', 'code', 'email',
    'access_token', 'accessToken', 'reset-token', 'api_key', 'apiKey', 'apikey', 'accesstoken',
    'client_secret', 'user_email', 'Authorization', 'session_id', 'sig', 'otp', 'jwt',
  ])('flags %s', (name) => {
    expect(isSecretParam(name, 'x')).toBe(true);
  });

  it.each(['utm_source', 'utm_campaign', 'q', 'page', 'keyword', 'author', 'monkey', 'ref', 'sort', 'lang', 'sessions'])(
    'keeps %s',
    (name) => {
      expect(isSecretParam(name, 'x')).toBe(false);
    },
  );

  it('flags a parameter whose value is an email address, whatever its name', () => {
    expect(isSecretParam('ref', 'someone@example.com')).toBe(true);
    expect(isSecretParam('ref', 'not an email')).toBe(false);
  });
});

describe('parsePageUrl', () => {
  it('splits host and path and lowercases the host', () => {
    const page = parsePageUrl('https://Shop.Example.com/products/shoes?color=red');
    expect(page).toMatchObject({ host: 'shop.example.com', path: '/products/shoes', url: 'https://shop.example.com/products/shoes?color=red' });
  });

  it('strips secret query parameters and keeps the rest, in their original encoding', () => {
    const page = parsePageUrl('https://example.com/reset?token=abc123&lang=en&email=a%40b.com&q=red%20shoes&utm_source=news');
    expect(page?.url).toBe('https://example.com/reset?lang=en&q=red%20shoes&utm_source=news');
  });

  it('leaves no question mark when every parameter was a secret', () => {
    expect(parsePageUrl('https://example.com/login?code=1&lang=en&key=2')?.url).toBe('https://example.com/login?lang=en');
    expect(parsePageUrl('https://example.com/login?code=1&password=3')?.url).toBe('https://example.com/login');
  });

  it('drops the fragment (OAuth and magic links put tokens there) and any credentials', () => {
    expect(parsePageUrl('https://user:pw@example.com/cb#access_token=abc&state=x')?.url).toBe('https://example.com/cb');
  });

  it('reads the utm columns, trimmed and empty ones as null', () => {
    const page = parsePageUrl('https://example.com/?utm_source=newsletter&utm_medium=%20email%20&utm_campaign=&utm_term=shoes');
    expect(page?.utm).toEqual({ source: 'newsletter', medium: 'email', campaign: null, content: null, term: 'shoes' });
  });

  it('refuses anything that is not an http(s) page', () => {
    expect(parsePageUrl('javascript:alert(1)')).toBeNull();
    expect(parsePageUrl('file:///etc/passwd')).toBeNull();
    expect(parsePageUrl('chrome-extension://abc/page.html')).toBeNull();
    expect(parsePageUrl('not a url')).toBeNull();
  });
});

describe('parseReferrer', () => {
  it('gives the cleaned referrer and its host', () => {
    expect(parseReferrer('https://www.google.com/search?q=weldsuite&token=abc#top')).toEqual({
      referrer: 'https://www.google.com/search?q=weldsuite',
      host: 'www.google.com',
    });
  });

  it('gives nulls for an empty, missing or unreadable referrer', () => {
    expect(parseReferrer('')).toEqual({ referrer: null, host: null });
    expect(parseReferrer(undefined)).toEqual({ referrer: null, host: null });
    expect(parseReferrer('garbage')).toEqual({ referrer: null, host: null });
  });
});

describe('excludedPathMatcher', () => {
  // The same cases as the SDK's excludedMatcher test (packages/sdk/panel-sdk/src/batch.test.ts): both sides must agree.
  it('matches the whole path, * standing for any characters, like the SDK does', () => {
    const excluded = excludedPathMatcher(['/admin/*', '/checkout/*/pay', '/a.b', '/über/*']);
    expect(excluded('/admin/users')).toBe(true);
    expect(excluded('/admin/users/42/edit')).toBe(true);
    expect(excluded('/admin')).toBe(false);
    expect(excluded('/shop/admin/x')).toBe(false);
    expect(excluded('/checkout/123/pay')).toBe(true);
    expect(excluded('/checkout/123/pay/more')).toBe(false);
    expect(excluded('/a.b')).toBe(true);
    expect(excluded('/aXb')).toBe(false);
    expect(excluded('/%C3%BCber/x')).toBe(true);
    expect(excludedPathMatcher([])('/anything')).toBe(false);
  });

  it('matches an exact path only, and is case-sensitive', () => {
    const excluded = excludedPathMatcher(['/checkout/thanks', '/Admin/*']);
    expect(excluded('/checkout/thanks')).toBe(true);
    expect(excluded('/checkout/thanks/42')).toBe(false);
    expect(excluded('/admin/x')).toBe(false);
    expect(excluded('/Admin/x')).toBe(true);
  });

  it('matches wildcards at the start and in the middle', () => {
    const excluded = excludedPathMatcher(['/u/*/settings', '*/print']);
    expect(excluded('/u/42/settings')).toBe(true);
    expect(excluded('/u/42/profile')).toBe(false);
    expect(excluded('/docs/intro/print')).toBe(true);
  });

  it('survives a path that cannot be decoded', () => {
    expect(excludedPathMatcher(['/admin/*'])('/%E0%A4%A')).toBe(false);
  });

  it('skips empty and oversized patterns, and matches everything for /*', () => {
    expect(excludedPathMatcher(['', `/${'a'.repeat(300)}`])('/anything')).toBe(false);
    const all = excludedPathMatcher(['/*']);
    expect(all('/')).toBe(true);
    expect(all('/any/path')).toBe(true);
  });
});
