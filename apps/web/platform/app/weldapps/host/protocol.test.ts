import { describe, expect, it } from 'vitest';
import {
  isSafeRelativePath,
  parseConfirmRequest,
  parseOpenModalRequest,
  parseProxyFetchRequest,
  parseShortcut,
  resolveProxyUrl,
  toPlatformBreadcrumbs,
} from './protocol';

const API = 'https://app-api.weldsuite.org';

describe('resolveProxyUrl', () => {
  it('routes community apps through the scoped gateway', () => {
    expect(
      resolveProxyUrl({ apiBase: API, appCode: 'demo', usesPlatformSession: false, path: '/v1/people?limit=5' }),
    ).toBe(`${API}/api/user-apps/code/demo/gateway/v1/people?limit=5`);
  });

  it('keeps community apps off app-api itself', () => {
    expect(resolveProxyUrl({ apiBase: API, appCode: 'demo', usesPlatformSession: false, path: '/api/customers' })).toBeNull();
    expect(resolveProxyUrl({ apiBase: API, appCode: 'demo', usesPlatformSession: false, path: '/v1/../api/customers' })).toBeNull();
    expect(resolveProxyUrl({ apiBase: API, appCode: 'demo', usesPlatformSession: false, path: 'https://evil.test/v1/x' })).toBeNull();
  });

  it('lets official apps call app-api under /api/ only', () => {
    expect(resolveProxyUrl({ apiBase: `${API}/`, appCode: 'weldcommerce', usesPlatformSession: true, path: '/api/products' })).toBe(
      `${API}/api/products`,
    );
    expect(resolveProxyUrl({ apiBase: API, appCode: 'weldcommerce', usesPlatformSession: true, path: '/public/x' })).toBeNull();
  });
});

describe('isSafeRelativePath', () => {
  it('allows `//` inside a query string only', () => {
    expect(isSafeRelativePath('/v1/x?url=https://a.test')).toBe(true);
    expect(isSafeRelativePath('//evil.test')).toBe(false);
    expect(isSafeRelativePath('/v1/%2e%2e/x')).toBe(false);
    expect(isSafeRelativePath('/v1/a%2fb')).toBe(false);
    expect(isSafeRelativePath('/v1/a\\b')).toBe(false);
  });
});

describe('parseProxyFetchRequest', () => {
  it('strips headers outside the allowlist and bodies on GET', () => {
    expect(
      parseProxyFetchRequest({
        method: 'get',
        path: '/v1/people',
        headers: [
          ['Authorization', 'Bearer stolen'],
          ['Cookie', 'a=b'],
          ['Content-Type', 'application/json'],
        ],
        body: 'ignored',
      }),
    ).toEqual({ method: 'GET', path: '/v1/people', headers: [['content-type', 'application/json']], body: null });
  });

  it('rejects unknown methods', () => {
    expect(parseProxyFetchRequest({ method: 'TRACE', path: '/v1/x', headers: [] })).toBeNull();
    expect(parseProxyFetchRequest(null)).toBeNull();
  });
});

describe('dialogs, crumbs and shortcuts', () => {
  it('parses confirm options and requires a title', () => {
    expect(parseConfirmRequest({ title: ' Delete? ', destructive: true })).toMatchObject({
      title: 'Delete?',
      destructive: true,
    });
    expect(parseConfirmRequest({ description: 'x' })).toBeNull();
  });

  it('parses modal options with a safe app path and default size', () => {
    expect(parseOpenModalRequest({ path: '/orders/new', params: { a: 1 } })).toEqual({
      path: '/orders/new',
      title: undefined,
      size: 'md',
      params: { a: 1 },
    });
    expect(parseOpenModalRequest({ path: 'https://evil.test' })).toBeNull();
  });

  it('maps app crumbs under /apps/{code} and drops unsafe links', () => {
    expect(
      toPlatformBreadcrumbs('demo', [
        { label: 'Orders', path: '/orders' },
        { label: 'Evil', path: '//evil.test' },
        { label: '' },
      ]),
    ).toEqual([{ label: 'Orders', href: '/apps/demo/orders' }, { label: 'Evil' }]);
  });

  it('only accepts platform shortcuts with a modifier', () => {
    expect(parseShortcut({ key: 'K', metaKey: true })).toEqual({
      key: 'k',
      metaKey: true,
      ctrlKey: false,
      shiftKey: false,
      altKey: false,
    });
    expect(parseShortcut({ key: 'k' })).toBeNull();
    expect(parseShortcut({ key: 'w', ctrlKey: true })).toBeNull();
  });
});
