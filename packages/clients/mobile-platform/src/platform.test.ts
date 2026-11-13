// The public entry points (api, edition, auth facade, runtime) with the native
// modules they import replaced by in-memory fakes.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const storage = new Map<string, string>();
const reloadAsync = vi.fn(async () => {});
const devReload = vi.fn();

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: async (key: string) => storage.get(key) ?? null,
    setItem: async (key: string, value: string) => {
      storage.set(key, value);
    },
    removeItem: async (key: string) => {
      storage.delete(key);
    },
  },
}));
vi.mock('expo-updates', () => ({ reloadAsync: () => reloadAsync() }));
vi.mock('react-native', () => ({ DevSettings: { reload: () => devReload() } }));
vi.mock('expo-crypto', () => ({
  getRandomBytes: (size: number) => new Uint8Array(size),
  digestStringAsync: async () => '',
  CryptoDigestAlgorithm: { SHA256: 'SHA-256' },
  CryptoEncoding: { BASE64: 'base64' },
}));
vi.mock('expo-secure-store', () => ({
  getItemAsync: async () => null,
  setItemAsync: async () => {},
  deleteItemAsync: async () => {},
}));
vi.mock('expo-web-browser', () => ({ openAuthSessionAsync: async () => ({ type: 'cancel' }) }));
const clerkSignOut = vi.fn(async () => {});
const clerkGetToken = vi.fn(async () => 'clerk-token');
vi.mock('@clerk/expo', () => ({
  ClerkProvider: () => null,
  getClerkInstance: () => ({ session: { getToken: () => clerkGetToken() }, signOut: () => clerkSignOut() }),
  useAuth: () => ({ isLoaded: true }),
  useUser: () => ({ isLoaded: true }),
  useOrganization: () => ({ isLoaded: true }),
  useOrganizationList: () => ({ isLoaded: true }),
}));
vi.mock('@clerk/expo/token-cache', () => ({ tokenCache: {} }));

const { buildGlobalRuntime, buildServerRuntime } = await import('./runtime/build');
const { setMobileRuntime } = await import('./runtime/state');
const api = await import('./api/index');
const edition = await import('./edition/index');
const auth = await import('./auth/index');
const runtime = await import('./runtime/index');
const { resetServerSwitchRegistry, onLeaveServer } = await import('./runtime/switch');

const APP = { code: 'weldmail', name: 'WeldMail', requiredModules: ['mail' as const] };
const BUILD = {
  appApiUrl: 'https://app-api-test.weldsuite.org',
  apiModules: 'all',
  realtimeUrl: 'wss://realtime-test.weldsuite.org',
  clerkPublishableKey: 'pk_test_abc',
  euServerUrl: 'https://app.test.weldsuite.eu',
  serverPicker: 'on',
};
const EU_CONFIG = {
  backend: 'rust',
  version: '0.3.0',
  modules: ['core', 'mail'],
  unavailableFeatures: ['mail-ai'],
  auth: {
    provider: 'oidc' as const,
    issuer: 'https://auth.test.weldsuite.eu',
    mobileClientId: 'mobile',
    accountUrl: 'https://auth.test.weldsuite.eu/ui/console/users/me',
  },
};
const globalRuntime = buildGlobalRuntime(APP, BUILD);
const euRuntime = buildServerRuntime(APP, BUILD, { kind: 'eu', origin: 'https://app.test.weldsuite.eu' }, EU_CONFIG);

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
}

beforeEach(() => {
  storage.clear();
  api.resetApiOrigins();
  auth.setAuthImplementation(null);
  resetServerSwitchRegistry();
  setMobileRuntime(globalRuntime);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('api', () => {
  it('reads every host from the runtime', () => {
    expect(api.apiOrigin()).toBe('https://app-api-test.weldsuite.org');
    expect(api.apiOriginForPath('/api/workspaces')).toBe('https://app-api-test.weldsuite.org');
    expect(api.personalApiOrigin()).toBe('https://personal-api-test.weldsuite.org');
    expect(api.realtimeUrl()).toBe('wss://realtime-test.weldsuite.org');
    expect(api.platformUrl()).toBe('https://app-test.weldsuite.org');
    setMobileRuntime(euRuntime);
    api.resetApiOrigins();
    expect(api.apiOriginForPath('/api/mail-threads')).toBe('https://app.test.weldsuite.eu');
  });

  it('sends the app code, extra headers and the token', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ data: { ok: true } }));
    vi.stubGlobal('fetch', fetchMock);
    const { client, requestInit } = api.createMobileApiClient({
      appCode: 'weldmail',
      getToken: async () => 'token-1',
      getExtraHeaders: () => ({ 'X-Accounting-Entity-Id': 'ent_1' }),
    });
    await client.get('/workspaces');
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://app-api-test.weldsuite.org/api/workspaces');
    expect(new Headers(init.headers).get('X-Weld-App')).toBe('weldmail');
    expect(new Headers(init.headers).get('X-Accounting-Entity-Id')).toBe('ent_1');
    await expect(requestInit('/files/f1')).resolves.toEqual({
      url: 'https://app-api-test.weldsuite.org/api/files/f1',
      headers: { Authorization: 'Bearer token-1', 'X-Accounting-Entity-Id': 'ent_1', 'X-Weld-App': 'weldmail' },
    });
    const anonymous = api.createMobileApiClient({ appCode: 'weldmail', getToken: async () => null });
    await expect(anonymous.requestInit('/files/f1')).rejects.toThrow('Authentication required');
  });

  it('builds a lazy client on first use and again when the origin changes', () => {
    let origin = 'https://one.example';
    const build = vi.fn((base: string) => ({ base, hello() { return `hi from ${this.base}`; } }));
    const client = api.lazyClient(() => origin, build);
    expect(build).not.toHaveBeenCalled();
    expect(client.hello()).toBe('hi from https://one.example');
    expect(client.base).toBe('https://one.example');
    expect(build).toHaveBeenCalledTimes(1);
    origin = 'https://two.example';
    expect(client.hello()).toBe('hi from https://two.example');
    expect(build).toHaveBeenCalledTimes(2);
  });
});

describe('edition', () => {
  it('lacks nothing on Global', () => {
    expect(edition.getEdition()).toBe('global');
    expect(edition.useEdition()).toBe('global');
    expect(edition.isFeatureAvailable('mail-ai')).toBe(true);
    expect(edition.useEditionFeature('chat-calls')).toBe(true);
    expect(edition.isModuleAvailable('agent')).toBe(true);
    expect(edition.isPushAvailable()).toBe(true);
    expect(edition.isNotificationForThisServer({ threadId: 't1' })).toBe(true);
    expect(edition.isNotificationForThisServer(null)).toBe(true);
  });

  it('hides what the EU server lacks and ignores Global notifications there', () => {
    setMobileRuntime(euRuntime);
    expect(edition.getEdition()).toBe('eu');
    expect(edition.isFeatureAvailable('mail-ai')).toBe(false);
    expect(edition.isModuleAvailable('mail')).toBe(true);
    expect(edition.isModuleAvailable('core')).toBe(true);
    expect(edition.isModuleAvailable('agent')).toBe(false);
    expect(edition.isPushAvailable()).toBe(false);
    expect(edition.isNotificationForThisServer({ threadId: 't1' })).toBe(false);
    expect(edition.isNotificationForThisServer({ server: 'https://app.test.weldsuite.eu' })).toBe(true);
    expect(edition.isNotificationForThisServer({ server: 'https://other.example' })).toBe(false);
  });
});

describe('auth facade', () => {
  it('uses Clerk on Global and passes its token through', async () => {
    expect(auth.getAuthProvider()).toBe('clerk');
    expect(auth.useAuthProvider()).toBe('clerk');
    expect(auth.useHostedSignIn()).toBeNull();
    await expect(auth.getAuthToken()).resolves.toBe('clerk-token');
    await auth.signOutActive();
    expect(clerkSignOut).toHaveBeenCalledTimes(1);
  });

  it('uses OIDC on an OIDC server, with its account page', () => {
    setMobileRuntime(euRuntime);
    expect(auth.getAuthProvider()).toBe('oidc');
    const hosted = auth.useHostedSignIn();
    expect(hosted?.accountUrl).toBe('https://auth.test.weldsuite.eu/ui/console/users/me');
  });

  it('renders loaded / loading / Clerk-only content from the provider state', () => {
    const state = { isLoaded: false };
    auth.setAuthImplementation({
      provider: 'clerk',
      Provider: ({ children }) => children,
      useAuth: () => state as never,
      useUser: () => ({ isLoaded: false, isSignedIn: undefined, user: undefined }),
      useOrganization: () => ({ isLoaded: false, organization: undefined }),
      useOrganizationList: () => ({
        isLoaded: false,
        setActive: undefined,
        userMemberships: { data: undefined, isLoading: true, isFetching: false, hasNextPage: false, fetchNext: undefined },
      }),
      getToken: async () => null,
      signOut: async () => {},
    });
    expect(auth.AuthLoaded({ children: 'app' })).toBeNull();
    expect(auth.AuthLoading({ children: 'spinner' })).not.toBeNull();
    state.isLoaded = true;
    expect(auth.AuthLoaded({ children: 'app' })).not.toBeNull();
    expect(auth.AuthLoading({ children: 'spinner' })).toBeNull();
    expect(auth.ClerkOnly({ children: 'clerk' })).not.toBeNull();
    expect(auth.useAuth()).toBe(state);
    expect(auth.useUser().isLoaded).toBe(false);
    expect(auth.useOrganization().isLoaded).toBe(false);
    expect(auth.useOrganizationList().isLoaded).toBe(false);
  });

  it('does nothing on sign-out before the runtime booted', async () => {
    setMobileRuntime(null);
    await expect(auth.signOutActive()).resolves.toBeUndefined();
    expect(() => auth.getAuthProvider()).toThrow(/booted/);
  });
});

describe('runtime entry', () => {
  it('boots Global and refuses addresses that are not servers', async () => {
    setMobileRuntime(null);
    const result = await runtime.bootMobileRuntime(APP, BUILD);
    expect(result.status).toBe('ready');
    expect(runtime.currentServer()).toEqual({ kind: 'global' });
    await expect(runtime.checkServerAddress('', APP)).resolves.toEqual({ ok: false, problem: 'invalid-address' });
    await expect(runtime.checkServerAddress('http://weld.example.com', APP)).resolves.toEqual({
      ok: false,
      problem: 'insecure-address',
    });
  });

  it('checks a server before it is saved', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(EU_CONFIG)));
    await expect(runtime.checkServerAddress('weld.example.com', APP)).resolves.toMatchObject({
      ok: true,
      origin: 'https://weld.example.com',
    });
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ ...EU_CONFIG, modules: ['core'] })));
    await expect(runtime.checkServerOrigin('https://weld.example.com', APP)).resolves.toEqual({
      ok: false,
      problem: 'app-unavailable',
    });
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ backend: 'workers' })));
    await expect(runtime.checkServerOrigin('https://weld.example.com', APP)).resolves.toEqual({
      ok: false,
      problem: 'not-weldsuite',
    });
  });

  it('switches: leave tasks, sign-out, save, reload (dev reload as the fallback)', async () => {
    const leave = vi.fn();
    onLeaveServer('push', leave);
    await runtime.switchServer({ kind: 'self-hosted', origin: 'https://weld.example.com' });
    expect(leave).toHaveBeenCalledTimes(1);
    expect(clerkSignOut).toHaveBeenCalledTimes(1);
    expect(JSON.parse(storage.get('weldsuite:server') ?? '{}')).toEqual({
      kind: 'self-hosted',
      origin: 'https://weld.example.com',
    });
    expect(reloadAsync).toHaveBeenCalledTimes(1);

    reloadAsync.mockRejectedValueOnce(new Error('not in development'));
    await runtime.switchServer({ kind: 'global' });
    expect(storage.has('weldsuite:server')).toBe(false);
    expect(devReload).toHaveBeenCalledTimes(1);
  });
});
