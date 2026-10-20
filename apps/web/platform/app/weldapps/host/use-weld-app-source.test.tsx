import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';

const state = vi.hoisted(() => ({
  installed: [] as Array<{ appCode: string; publisherType?: 'community' | 'weldsuite' }>,
  devSession: null as { url: string; origin?: string; expiresAt: string } | null,
  bundle: {
    src: 'https://app-api.test/public/user-apps/demo/index.html' as string | null,
    expiresAtMs: null as number | null,
    isLoading: false,
    isError: false,
    refresh: () => undefined,
    link: null,
  },
  bundleEnabled: [] as boolean[],
}));

vi.mock('@/lib/api/public-env', () => ({ getAppApiUrl: () => 'https://app-api.test' }));
vi.mock('@/hooks/queries/use-user-apps-queries', () => ({
  useInstalledUserApps: () => ({ data: state.installed, isLoading: false }),
  useUserAppDevSession: () => ({ data: state.devSession }),
}));
vi.mock('./use-bundle-link', () => ({
  BUNDLE_LINK_REFRESH_MARGIN_MS: 1800000,
  useUserAppBundleLink: (_code: string | undefined, options: { enabled: boolean }) => {
    state.bundleEnabled.push(options.enabled);
    return state.bundle;
  },
}));

import { useWeldAppSource } from './use-weld-app-source';
import { ISOLATED_SANDBOX, PREVIEW_SANDBOX, R2_SANDBOX } from './preview';

const BUNDLE = 'https://app-api.test/public/user-apps/demo/index.html';

describe('useWeldAppSource', () => {
  beforeEach(() => {
    state.installed = [{ appCode: 'demo', publisherType: 'community' }];
    state.devSession = null;
    state.bundle = { src: BUNDLE, expiresAtMs: null, isLoading: false, isError: false, refresh: () => undefined, link: null };
    state.bundleEnabled = [];
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  const source = () => renderHook(() => useWeldAppSource('demo')).result.current;

  it('loads the published bundle through its minted link', () => {
    const s = source();
    expect(s.kind).toBe('bundle');
    expect(s.iframeSrc).toBe(BUNDLE);
    expect(s.targetOrigin).toBe('https://app-api.test');
    expect(s.sandbox).toBe(R2_SANDBOX);
    expect(s.previewUrl).toBeNull();
    expect(s.usesPlatformSession).toBe(false);
  });

  it('shows a loopback preview and does not mint a bundle link for it', () => {
    state.devSession = { url: 'http://localhost:5173/', origin: 'http://localhost:5173', expiresAt: '2030-01-01T00:00:00Z' };
    const s = source();
    expect(s.kind).toBe('preview');
    expect(s.iframeSrc).toBe('http://localhost:5173/');
    expect(s.targetOrigin).toBe('http://localhost:5173');
    expect(s.sandbox).toBe(PREVIEW_SANDBOX);
    expect(state.bundleEnabled.every((enabled) => !enabled)).toBe(true);
  });

  it('shows a tunnel preview only when its origin is the registered one', () => {
    state.devSession = {
      url: 'https://abc.trycloudflare.com/app/',
      origin: 'https://abc.trycloudflare.com',
      expiresAt: '2030-01-01T00:00:00Z',
    };
    expect(source().kind).toBe('preview');

    // The server says one origin, the URL is another: not rendered, the bundle stays.
    state.devSession = {
      url: 'https://attacker.ngrok.app/',
      origin: 'https://abc.trycloudflare.com',
      expiresAt: '2030-01-01T00:00:00Z',
    };
    const s = source();
    expect(s.kind).toBe('bundle');
    expect(s.previewUrl).toBeNull();
    expect(s.iframeSrc).toBe(BUNDLE);
  });

  it('never renders a preview from a host that is not allowlisted', () => {
    state.devSession = { url: 'https://evil.example.com/', origin: 'https://evil.example.com', expiresAt: '2030-01-01T00:00:00Z' };
    const s = source();
    expect(s.kind).toBe('bundle');
    expect(s.iframeSrc).toBe(BUNDLE);
  });

  it('waits for the bundle link, and reports when it cannot be minted', () => {
    state.bundle = { ...state.bundle, src: null, isLoading: true };
    let s = source();
    expect(s.isLoading).toBe(true);
    expect(s.iframeSrc).toBe('');
    expect(s.targetOrigin).toBeNull();

    state.bundle = { ...state.bundle, isLoading: false, isError: true };
    s = source();
    expect(s.isLoading).toBe(false);
    expect(s.bundleError).toBe(true);
  });

  it('is not loading and has no error for an app that is not installed', () => {
    state.installed = [];
    const s = source();
    expect(s.app).toBeUndefined();
    expect(s.isLoading).toBe(false);
    expect(s.bundleError).toBe(false);
  });

  describe('isolating community apps (VITE_USER_APP_ISOLATE_COMMUNITY_APPS)', () => {
    it('keeps allow-same-origin by default', () => {
      expect(source().isolated).toBe(false);
    });

    it('renders community bundles in an opaque origin when enabled', () => {
      vi.stubEnv('VITE_USER_APP_ISOLATE_COMMUNITY_APPS', 'true');
      const s = source();
      expect(s.isolated).toBe(true);
      expect(s.sandbox).toBe(ISOLATED_SANDBOX);
    });

    it('leaves official apps, previews and per-app origins alone', () => {
      vi.stubEnv('VITE_USER_APP_ISOLATE_COMMUNITY_APPS', 'true');

      state.installed = [{ appCode: 'demo', publisherType: 'weldsuite' }];
      expect(source().isolated).toBe(false);

      state.installed = [{ appCode: 'demo', publisherType: 'community' }];
      state.devSession = { url: 'http://localhost:5173/', origin: 'http://localhost:5173', expiresAt: '2030-01-01T00:00:00Z' };
      const preview = source();
      expect(preview.isolated).toBe(false);
      expect(preview.sandbox).toBe(PREVIEW_SANDBOX);

      state.devSession = null;
      vi.stubEnv('VITE_USER_APP_BUNDLE_ORIGIN', 'https://{code}.weldappcontent.net');
      expect(source().isolated).toBe(false);
    });
  });
});
