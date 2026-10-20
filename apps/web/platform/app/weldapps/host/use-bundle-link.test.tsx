import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

const post = vi.fn();

vi.mock('@clerk/clerk-react', () => ({ useAuth: () => ({ orgId: 'org_1' }) }));
vi.mock('@/lib/api/use-app-api', () => ({
  useAppApiClient: () => ({ getClient: async () => ({ post }) }),
}));
vi.mock('@/lib/api/public-env', () => ({ getAppApiUrl: () => 'https://app-api.test' }));

import {
  BUNDLE_LINK_REFRESH_MARGIN_MS,
  bundleLinkNearExpiry,
  useUserAppBundleLink,
  type BundleLink,
} from './use-bundle-link';

const TOKEN = '1790000000.d3NfdGVzdA.abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ';

const signed = (expiresInMs: number): BundleLink => ({
  path: `/public/user-apps/demo/s/${TOKEN}/index.html`,
  signed: true,
  expiresAt: new Date(Date.now() + expiresInMs).toISOString(),
});
const plain: BundleLink = { path: '/public/user-apps/demo/index.html', signed: false, expiresAt: null };

function wrapper(client: QueryClient) {
  return function Wrapper({ children }: Readonly<{ children: ReactNode }>) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

const newClient = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });

describe('bundleLinkNearExpiry', () => {
  it('is false for plain links and links with time left, true inside the margin', () => {
    expect(bundleLinkNearExpiry(null)).toBe(false);
    expect(bundleLinkNearExpiry(plain)).toBe(false);
    expect(bundleLinkNearExpiry(signed(6 * 60 * 60 * 1000))).toBe(false);
    expect(bundleLinkNearExpiry(signed(BUNDLE_LINK_REFRESH_MARGIN_MS - 60_000))).toBe(true);
    expect(bundleLinkNearExpiry(signed(-1000))).toBe(true);
  });
});

describe('useUserAppBundleLink', () => {
  beforeEach(() => {
    post.mockReset();
  });

  it('mints a link and builds the frame URL from it', async () => {
    post.mockResolvedValue({ data: signed(12 * 60 * 60 * 1000) });
    const { result } = renderHook(() => useUserAppBundleLink('demo', { enabled: true }), { wrapper: wrapper(newClient()) });
    await waitFor(() => expect(result.current.src).not.toBeNull());
    expect(post).toHaveBeenCalledWith('/user-apps/code/demo/bundle-url');
    expect(result.current.src).toBe(`https://app-api.test/public/user-apps/demo/s/${TOKEN}/index.html`);
    expect(result.current.expiresAtMs).toBeGreaterThan(Date.now());
    expect(result.current.isError).toBe(false);
  });

  it('uses the plain URL of a public app', async () => {
    post.mockResolvedValue({ data: plain });
    const { result } = renderHook(() => useUserAppBundleLink('demo', { enabled: true }), { wrapper: wrapper(newClient()) });
    await waitFor(() => expect(result.current.src).toBe('https://app-api.test/public/user-apps/demo/index.html'));
    expect(result.current.expiresAtMs).toBeNull();
  });

  it('does not mint while disabled (a preview is showing) or without a code', () => {
    renderHook(() => useUserAppBundleLink('demo', { enabled: false }), { wrapper: wrapper(newClient()) });
    renderHook(() => useUserAppBundleLink(undefined, { enabled: true }), { wrapper: wrapper(newClient()) });
    expect(post).not.toHaveBeenCalled();
  });

  it('reports an error, and no src, when the link cannot be minted', async () => {
    post.mockRejectedValue(new Error('not found'));
    const { result } = renderHook(() => useUserAppBundleLink('demo', { enabled: true }), { wrapper: wrapper(newClient()) });
    // The hook retries once (after ~1s) before giving up.
    await waitFor(() => expect(result.current.isError).toBe(true), { timeout: 5000 });
    expect(post).toHaveBeenCalledTimes(2);
    expect(result.current.src).toBeNull();
  });

  it('refuses a path the API should never mint', async () => {
    post.mockResolvedValue({ data: { path: 'https://evil.test/index.html', signed: false, expiresAt: null } });
    const { result } = renderHook(() => useUserAppBundleLink('demo', { enabled: true }), { wrapper: wrapper(newClient()) });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.src).toBeNull();
  });

  it('keeps a fresh cached link on remount, and re-mints one that is about to expire', async () => {
    const key = ['user-apps', 'bundle-link', 'org_1', 'demo'];

    const fresh = newClient();
    fresh.setQueryData(key, signed(6 * 60 * 60 * 1000));
    renderHook(() => useUserAppBundleLink('demo', { enabled: true }), { wrapper: wrapper(fresh) });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(post).not.toHaveBeenCalled();

    const stale = newClient();
    stale.setQueryData(key, signed(5 * 60 * 1000));
    post.mockResolvedValue({ data: signed(12 * 60 * 60 * 1000) });
    const { result } = renderHook(() => useUserAppBundleLink('demo', { enabled: true }), { wrapper: wrapper(stale) });
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(bundleLinkNearExpiry(result.current.link)).toBe(false));
  });
});
