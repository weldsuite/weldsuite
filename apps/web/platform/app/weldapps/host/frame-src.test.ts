import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/api/public-env', () => ({ getAppApiUrl: () => 'https://app-api.test' }));

import {
  bootstrapFrameSrc,
  bundleSrcFromPath,
  getBundleOrigin,
  isolateCommunityApps,
  resolveBundleOrigin,
} from './frame-src';

const api = 'https://app-api.weldsuite.org';

describe('resolveBundleOrigin', () => {
  it('keeps bundles on the API origin when nothing is configured', () => {
    expect(resolveBundleOrigin({ template: undefined, code: 'demo', apiBase: api })).toEqual({
      origin: api,
      perApp: false,
    });
    expect(resolveBundleOrigin({ template: '  ', code: 'demo', apiBase: `${api}/` })).toEqual({ origin: api, perApp: false });
  });

  it('uses a dedicated bundle origin', () => {
    expect(resolveBundleOrigin({ template: 'https://weldappcontent.net', code: 'demo', apiBase: api })).toEqual({
      origin: 'https://weldappcontent.net',
      perApp: false,
    });
  });

  it('expands a per-app template', () => {
    expect(resolveBundleOrigin({ template: 'https://{code}.weldappcontent.net', code: 'demo', apiBase: api })).toEqual({
      origin: 'https://demo.weldappcontent.net',
      perApp: true,
    });
  });

  it('ignores unusable values instead of building a frame URL from them', () => {
    for (const template of ['not a url', 'http://weldappcontent.net', 'https://weldappcontent.net/path', 'https://u:p@weldappcontent.net', 'javascript:alert(1)']) {
      expect(resolveBundleOrigin({ template, code: 'demo', apiBase: api })).toEqual({ origin: api, perApp: false });
    }
  });

  it('ignores a localhost value on a hosted SPA, honours it locally', () => {
    const template = 'http://localhost:8788';
    expect(resolveBundleOrigin({ template, code: 'demo', apiBase: api, spaHost: 'app.weldsuite.org' }).origin).toBe(api);
    expect(resolveBundleOrigin({ template, code: 'demo', apiBase: api, spaHost: 'localhost' }).origin).toBe(template);
  });
});

describe('getBundleOrigin', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('reads VITE_USER_APP_BUNDLE_ORIGIN, defaulting to the API origin', () => {
    expect(getBundleOrigin('demo').origin).toBe('https://app-api.test');
    vi.stubEnv('VITE_USER_APP_BUNDLE_ORIGIN', 'https://{code}.weldappcontent.net');
    expect(getBundleOrigin('demo')).toEqual({ origin: 'https://demo.weldappcontent.net', perApp: true });
  });
});

describe('bundleSrcFromPath', () => {
  const token = '1790000000.d3NfdGVzdA.abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ';

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('builds the frame URL from the plain and the signed path the API mints', () => {
    expect(bundleSrcFromPath('demo', '/public/user-apps/demo/index.html')).toBe(
      'https://app-api.test/public/user-apps/demo/index.html',
    );
    expect(bundleSrcFromPath('demo', `/public/user-apps/demo/s/${token}/index.html`)).toBe(
      `https://app-api.test/public/user-apps/demo/s/${token}/index.html`,
    );
  });

  it('puts the frame on the bundle origin when one is configured', () => {
    vi.stubEnv('VITE_USER_APP_BUNDLE_ORIGIN', 'https://weldappcontent.net');
    expect(bundleSrcFromPath('demo', '/public/user-apps/demo/index.html')).toBe(
      'https://weldappcontent.net/public/user-apps/demo/index.html',
    );
  });

  it('accepts nothing but the two shapes the API mints', () => {
    for (const path of [
      '/public/user-apps/other/index.html',
      '/public/user-apps/demo/other.html',
      '/public/user-apps/demo/index.html?x=1',
      '/public/user-apps/demo/s/short/index.html',
      '/public/user-apps/demo/s/../index.html',
      `/public/user-apps/demo/s/${token}/../index.html`,
      '//evil.test/public/user-apps/demo/index.html',
      'https://evil.test/public/user-apps/demo/index.html',
      '/api/customers',
    ]) {
      expect(bundleSrcFromPath('demo', path)).toBeNull();
    }
  });
});

describe('isolateCommunityApps', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('is off unless explicitly enabled', () => {
    expect(isolateCommunityApps()).toBe(false);
    vi.stubEnv('VITE_USER_APP_ISOLATE_COMMUNITY_APPS', 'true');
    expect(isolateCommunityApps()).toBe(true);
    vi.stubEnv('VITE_USER_APP_ISOLATE_COMMUNITY_APPS', '1');
    expect(isolateCommunityApps()).toBe(false);
  });
});

describe('bootstrapFrameSrc', () => {
  it('puts theme and route into the first src', () => {
    expect(bootstrapFrameSrc('https://app-api.test/public/user-apps/demo/index.html', 'dark', '/orders')).toBe(
      'https://app-api.test/public/user-apps/demo/index.html?theme=dark#orders',
    );
    expect(bootstrapFrameSrc('', 'dark', '/')).toBe('');
  });
});
