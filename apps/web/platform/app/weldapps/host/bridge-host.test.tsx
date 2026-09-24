import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import type { RefObject } from 'react';

const getToken = vi.fn(async () => 'clerk_session_jwt');
const mintSessionToken = vi.fn();

vi.mock('@clerk/clerk-react', () => ({
  useAuth: () => ({ getToken }),
  useUser: () => ({ user: { id: 'usr_1', fullName: 'Ada Lovelace', firstName: 'Ada', imageUrl: '' } }),
}));
vi.mock('@/lib/router', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('@/hooks/use-theme', () => ({ useTheme: () => ({ resolvedTheme: 'light' }) }));
vi.mock('@/lib/i18n/provider', () => ({
  useI18n: () => ({ language: 'en', t: { common: { actions: { confirm: 'Confirm', cancel: 'Cancel' } } } }),
}));
vi.mock('@/hooks/queries/use-user-apps-queries', () => ({
  useUserAppSessionToken: () => ({ mutateAsync: mintSessionToken }),
}));
vi.mock('@/lib/api/public-env', () => ({ getAppApiUrl: () => 'https://app-api.test' }));

import { useBridgeHost, type BridgeHostOptions } from './bridge-host';

interface Posted {
  message: { type: string; id?: string; ok?: boolean; payload?: Record<string, unknown>; error?: { message: string } };
}

function setup(overrides: Partial<BridgeHostOptions> = {}) {
  const posted: Posted[] = [];
  const contentWindow = {
    postMessage: vi.fn((message: Posted['message']) => {
      posted.push({ message });
    }),
  };
  const iframeRef = { current: { contentWindow } } as unknown as RefObject<HTMLIFrameElement>;
  const options: BridgeHostOptions = {
    appCode: 'demo',
    appName: 'Demo',
    iframeRef,
    targetOrigin: 'https://app-api.test',
    usesPlatformSession: false,
    path: '/',
    surface: 'page',
    frameSrc: 'https://app-api.test/public/user-apps/demo/index.html',
    sandbox: 'allow-scripts',
    onMounted: vi.fn(),
    onBreadcrumbs: vi.fn(),
    onDirty: vi.fn(),
    ...overrides,
  };
  renderHook(() => useBridgeHost(options));

  const fromApp = (data: unknown, origin = 'https://app-api.test', source: unknown = contentWindow) => {
    const event = new MessageEvent('message', { data, origin });
    Object.defineProperty(event, 'source', { value: source });
    act(() => {
      window.dispatchEvent(event);
    });
  };
  const responseFor = async (id: string) => {
    await vi.waitFor(() => {
      expect(posted.some((p) => p.message.type === 'weldapp:response' && p.message.id === id)).toBe(true);
    });
    return posted.find((p) => p.message.type === 'weldapp:response' && p.message.id === id)!.message;
  };
  return { posted, fromApp, responseFor, options };
}

describe('useBridgeHost (protocol 2)', () => {
  const fetchSpy = vi.fn();

  beforeEach(() => {
    fetchSpy.mockReset();
    getToken.mockClear();
    mintSessionToken.mockReset();
    vi.stubGlobal('fetch', fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('answers ready with an init that carries no token', () => {
    const { posted, fromApp } = setup();
    fromApp({ type: 'weldapp:ready' });
    const init = posted.find((p) => p.message.type === 'weldapp:init')?.message.payload;
    expect(init).toMatchObject({ appCode: 'demo', protocol: 2, token: null, tokenExpiresAt: null, surface: 'page' });
    expect(getToken).not.toHaveBeenCalled();
    expect(mintSessionToken).not.toHaveBeenCalled();
  });

  it('proxies a community app call through the gateway with the platform session', async () => {
    fetchSpy.mockResolvedValue(new Response('{"data":[]}', { status: 200, headers: { 'content-type': 'application/json' } }));
    const { fromApp, responseFor, posted } = setup();
    fromApp({
      type: 'weldapp:request',
      id: 'r1',
      method: 'fetch',
      payload: { method: 'GET', path: '/v1/people?limit=5', headers: [['authorization', 'Bearer forged']], body: null },
    });

    const response = await responseFor('r1');
    expect(response.ok).toBe(true);
    expect(response.payload).toMatchObject({ status: 200 });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://app-api.test/api/user-apps/code/demo/gateway/v1/people?limit=5');
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer clerk_session_jwt');
    expect(mintSessionToken).not.toHaveBeenCalled();
    // The session token never travels into the iframe.
    expect(JSON.stringify(posted.map((p) => p.message))).not.toContain('clerk_session_jwt');
  });

  it('refuses paths outside the app surface', async () => {
    const { fromApp, responseFor } = setup();
    fromApp({ type: 'weldapp:request', id: 'r2', method: 'fetch', payload: { method: 'GET', path: '/api/customers', headers: [] } });
    const response = await responseFor('r2');
    expect(response.ok).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('lets official apps call app-api directly', async () => {
    fetchSpy.mockResolvedValue(new Response(null, { status: 204 }));
    const { fromApp, responseFor } = setup({ usesPlatformSession: true, appCode: 'weldcommerce' });
    fromApp({ type: 'weldapp:request', id: 'r3', method: 'fetch', payload: { method: 'DELETE', path: '/api/products/p1', headers: [] } });
    await responseFor('r3');
    expect(fetchSpy.mock.calls[0]?.[0]).toBe('https://app-api.test/api/products/p1');
  });

  it('ignores messages from other windows or origins', () => {
    const { posted, fromApp } = setup();
    fromApp({ type: 'weldapp:ready' }, 'https://evil.test');
    fromApp({ type: 'weldapp:ready' }, 'https://app-api.test', {});
    expect(posted.filter((p) => p.message.type === 'weldapp:init')).toHaveLength(0);
  });

  it('routes breadcrumbs, dirty state and mounted to the page', async () => {
    const { fromApp, responseFor, options } = setup();
    fromApp({ type: 'weldapp:request', id: 'b', method: 'setBreadcrumbs', payload: { items: [{ label: 'Orders', path: '/orders' }] } });
    fromApp({ type: 'weldapp:request', id: 'd', method: 'setDirty', payload: { dirty: true, message: 'Draft' } });
    fromApp({ type: 'weldapp:notify', event: 'mounted' });
    await responseFor('b');
    await responseFor('d');
    expect(options.onBreadcrumbs).toHaveBeenCalledWith([{ label: 'Orders', href: '/apps/demo/orders' }]);
    expect(options.onDirty).toHaveBeenCalledWith({ message: 'Draft' });
    expect(options.onMounted).toHaveBeenCalled();
  });

  it('replays a forwarded Cmd+K on the platform document', () => {
    const { fromApp } = setup();
    const seen: KeyboardEvent[] = [];
    const listener = (event: KeyboardEvent) => seen.push(event);
    window.addEventListener('keydown', listener);
    fromApp({ type: 'weldapp:notify', event: 'shortcut', payload: { key: 'k', metaKey: true } });
    window.removeEventListener('keydown', listener);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ key: 'k', metaKey: true });
  });

  it('still serves legacy SDKs that ask for a token', async () => {
    mintSessionToken.mockResolvedValue({ token: 'wsat_x', expiresAt: '2030-01-01T00:00:00Z', apiBaseUrl: 'https://api.test' });
    const { fromApp, responseFor } = setup();
    fromApp({ type: 'weldapp:request', id: 'legacy', method: 'getToken' });
    const response = await responseFor('legacy');
    expect(response.payload).toMatchObject({ token: 'wsat_x', apiBaseUrl: 'https://api.test' });
  });
});
