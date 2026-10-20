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
  options?: { targetOrigin?: string };
}

function setup(overrides: Partial<BridgeHostOptions> = {}) {
  const posted: Posted[] = [];
  const contentWindow = {
    postMessage: vi.fn((message: Posted['message'], options?: Posted['options']) => {
      posted.push({ message, options });
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

  const fromApp = (data: unknown, origin = options.targetOrigin ?? 'https://app-api.test', source: unknown = contentWindow) => {
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

  it('hands no credential to a published bundle in init either, whoever it is', () => {
    const { posted, fromApp } = setup({ usesPlatformSession: true, appCode: 'weldcommerce' });
    fromApp({ type: 'weldapp:ready' });
    const init = posted.find((p) => p.message.type === 'weldapp:init')?.message.payload;
    expect(init).toMatchObject({ token: null, tokenExpiresAt: null });
    expect(JSON.stringify(posted.map((p) => p.message))).not.toContain('clerk_session_jwt');
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

  it('still serves legacy SDKs of community apps that ask for a (scoped) token', async () => {
    mintSessionToken.mockResolvedValue({ token: 'wsat_x', expiresAt: '2030-01-01T00:00:00Z', apiBaseUrl: 'https://api.test' });
    const { fromApp, responseFor } = setup();
    fromApp({ type: 'weldapp:request', id: 'legacy', method: 'getToken' });
    const response = await responseFor('legacy');
    expect(response.payload).toMatchObject({ token: 'wsat_x', apiBaseUrl: 'https://api.test' });
  });

  it('never hands the member\'s platform session (Clerk JWT) to any frame, official apps included', async () => {
    const { fromApp, responseFor, posted } = setup({ usesPlatformSession: true, appCode: 'weldcommerce' });
    fromApp({ type: 'weldapp:request', id: 'official', method: 'getToken' });
    const response = await responseFor('official');
    expect(response.ok).toBe(false);
    expect(getToken).not.toHaveBeenCalled();
    expect(mintSessionToken).not.toHaveBeenCalled();
    expect(JSON.stringify(posted.map((p) => p.message))).not.toContain('clerk_session_jwt');
  });
});

describe('useBridgeHost: frame pinning', () => {
  const fetchSpy = vi.fn();
  const TUNNEL = 'https://abc.trycloudflare.com';

  beforeEach(() => {
    fetchSpy.mockReset();
    getToken.mockClear();
    mintSessionToken.mockReset();
    vi.stubGlobal('fetch', fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const previewSetup = (overrides: Partial<BridgeHostOptions> = {}) =>
    setup({
      targetOrigin: TUNNEL,
      frameKind: 'preview',
      frameSrc: `${TUNNEL}/`,
      ...overrides,
    });

  it('never gives a preview frame a token: getToken is refused and nothing is minted', async () => {
    mintSessionToken.mockResolvedValue({ token: 'wsat_x', expiresAt: '2030-01-01T00:00:00Z', apiBaseUrl: 'https://api.test' });
    const { fromApp, responseFor, posted } = previewSetup();
    fromApp({ type: 'weldapp:request', id: 'tok', method: 'getToken' });
    const response = await responseFor('tok');
    expect(response.ok).toBe(false);
    expect(mintSessionToken).not.toHaveBeenCalled();
    expect(getToken).not.toHaveBeenCalled();
    expect(JSON.stringify(posted.map((p) => p.message))).not.toMatch(/wsat_|clerk_session_jwt/);
  });

  it('refuses getToken to a preview of an official app too (no Clerk JWT in the frame)', async () => {
    const { fromApp, responseFor, posted } = previewSetup({ usesPlatformSession: true, appCode: 'weldcommerce' });
    fromApp({ type: 'weldapp:request', id: 'tok2', method: 'getToken' });
    const response = await responseFor('tok2');
    expect(response.ok).toBe(false);
    expect(getToken).not.toHaveBeenCalled();
    expect(JSON.stringify(posted.map((p) => p.message))).not.toContain('clerk_session_jwt');
  });

  it('sends a preview init without any credential, posted only to its exact origin', () => {
    const { posted, fromApp } = previewSetup();
    fromApp({ type: 'weldapp:ready' });
    const init = posted.find((p) => p.message.type === 'weldapp:init');
    expect(init?.message.payload).toMatchObject({ token: null, tokenExpiresAt: null, protocol: 2 });
    expect(init?.options?.targetOrigin).toBe(TUNNEL);
  });

  it('proxies fetches for a preview only from the registered origin', async () => {
    fetchSpy.mockResolvedValue(new Response('{"data":[]}', { status: 200 }));
    const { fromApp, responseFor, posted } = previewSetup();

    // Another tunnel on the same provider, or a frame that navigated away, is ignored.
    fromApp(
      { type: 'weldapp:request', id: 'evil', method: 'fetch', payload: { method: 'GET', path: '/v1/people', headers: [] } },
      'https://attacker.trycloudflare.com',
    );
    fromApp(
      { type: 'weldapp:request', id: 'null-origin', method: 'fetch', payload: { method: 'GET', path: '/v1/people', headers: [] } },
      'null',
    );
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(posted.filter((p) => p.message.type === 'weldapp:response')).toHaveLength(0);

    fromApp({ type: 'weldapp:request', id: 'ok', method: 'fetch', payload: { method: 'GET', path: '/v1/people', headers: [] } });
    const response = await responseFor('ok');
    expect(response.ok).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('ignores everything, and posts nothing, when the frame has no usable origin', () => {
    const { posted, fromApp } = setup({ targetOrigin: null });
    fromApp({ type: 'weldapp:ready' });
    fromApp({ type: 'weldapp:request', id: 'x', method: 'fetch', payload: { method: 'GET', path: '/v1/people', headers: [] } });
    expect(posted).toHaveLength(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('pins an isolated (opaque origin) frame by window, posting with * and accepting only the null origin', async () => {
    fetchSpy.mockResolvedValue(new Response('{"data":[]}', { status: 200 }));
    const { posted, fromApp, responseFor } = setup({ isolated: true, sandbox: 'allow-scripts' });

    // The frame's real origin is not what an opaque frame reports.
    fromApp({ type: 'weldapp:ready' }, 'https://app-api.test');
    expect(posted.filter((p) => p.message.type === 'weldapp:init')).toHaveLength(0);

    fromApp({ type: 'weldapp:ready' }, 'null');
    const init = posted.find((p) => p.message.type === 'weldapp:init');
    expect(init?.options?.targetOrigin).toBe('*');
    expect(init?.message.payload).toMatchObject({ token: null });

    // Still bound to the iframe's own window.
    fromApp({ type: 'weldapp:request', id: 'other-window', method: 'fetch', payload: { method: 'GET', path: '/v1/people', headers: [] } }, 'null', {});
    expect(fetchSpy).not.toHaveBeenCalled();

    fromApp({ type: 'weldapp:request', id: 'iso', method: 'fetch', payload: { method: 'GET', path: '/v1/people', headers: [] } }, 'null');
    await responseFor('iso');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});
