// The OIDC and Clerk implementations behind the facade, rendered with
// react-dom/server (no device): what the hooks report for a stored session.
import { createElement, type ReactNode } from 'react';
import { renderToString } from 'react-dom/server';
import { beforeAll, describe, expect, it, vi } from 'vitest';

const secure = new Map<string, string>();
const cache = new Map<string, string>();

vi.mock('expo-secure-store', () => ({
  getItemAsync: async (key: string) => secure.get(key) ?? null,
  setItemAsync: async (key: string, value: string) => {
    secure.set(key, value);
  },
  deleteItemAsync: async (key: string) => {
    secure.delete(key);
  },
}));
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: async (key: string) => cache.get(key) ?? null,
    setItem: async (key: string, value: string) => {
      cache.set(key, value);
    },
    removeItem: async (key: string) => {
      cache.delete(key);
    },
  },
}));
vi.mock('expo-crypto', () => ({
  getRandomBytes: (size: number) => new Uint8Array(size),
  digestStringAsync: async () => '',
  CryptoDigestAlgorithm: { SHA256: 'SHA-256' },
  CryptoEncoding: { BASE64: 'base64' },
}));
vi.mock('expo-web-browser', () => ({ openAuthSessionAsync: async () => ({ type: 'cancel' }) }));
vi.mock('@clerk/expo', () => ({
  ClerkProvider: ({ children }: { children: ReactNode }) => children,
  getClerkInstance: () => {
    throw new Error('not initialised');
  },
  useAuth: () => ({}),
  useUser: () => ({}),
  useOrganization: () => ({}),
  useOrganizationList: () => ({}),
}));
vi.mock('@clerk/expo/token-cache', () => ({ tokenCache: {} }));

const { buildGlobalRuntime, buildServerRuntime } = await import('../../runtime/build');
const { setMobileRuntime } = await import('../../runtime/state');
const { oidcAuth, oidcRedirectUri } = await import('./adapter');
const { clerkAuth } = await import('../clerk');

const APP = { code: 'weldmail', name: 'WeldMail', requiredModules: [] };
const BUILD = { appApiUrl: 'https://app-api-test.weldsuite.org', clerkPublishableKey: 'pk_test_abc', serverPicker: 'on' };
const euRuntime = buildServerRuntime(APP, BUILD, { kind: 'eu', origin: 'https://app.test.weldsuite.eu' }, {
  backend: 'rust',
  auth: {
    provider: 'oidc',
    issuer: 'https://auth.test.weldsuite.eu',
    mobileClientId: 'mobile',
    accountUrl: 'https://auth.test.weldsuite.eu/ui/console/users/me',
  },
});

/** Renders the four hooks once and returns what they reported. */
function readHooks() {
  const seen: Record<string, unknown> = {};
  function Probe() {
    seen.auth = oidcAuth.useAuth();
    seen.user = oidcAuth.useUser();
    seen.organization = oidcAuth.useOrganization();
    seen.list = oidcAuth.useOrganizationList();
    return null;
  }
  renderToString(createElement(oidcAuth.Provider, null, createElement(Probe)));
  return seen as {
    auth: { isLoaded: boolean; isSignedIn?: boolean; userId?: string | null; orgId?: string | null };
    user: { isSignedIn?: boolean; user?: { fullName: string | null; primaryEmailAddress: unknown; phoneNumbers: unknown[] } | null };
    organization: { organization: { id: string; name: string } | null | undefined };
    list: { isLoaded: boolean; setActive?: unknown; userMemberships: { data?: unknown[] } };
  };
}

describe('OIDC implementation', () => {
  beforeAll(async () => {
    setMobileRuntime(euRuntime);
    secure.set(
      'weldsuite.oidc.app.test.weldsuite.eu',
      JSON.stringify({ v: 1, sub: 'user-1', active: 'org-1', tokens: { 'org-1': { refresh: 'rt-1', at: 1 } } }),
    );
    cache.set(
      'weldsuite:oidc-profile:app.test.weldsuite.eu',
      JSON.stringify({
        sub: 'user-1',
        person: {
          id: 'user-1',
          firstName: 'Ada',
          lastName: 'Lovelace',
          fullName: 'Ada Lovelace',
          username: null,
          imageUrl: '',
          email: 'ada@example.com',
        },
        organizations: [{ id: 'org-1', name: 'Acme', slug: null }],
      }),
    );
    // Offline: the stored session stays signed in without a fresh token.
    vi.stubGlobal('fetch', async () => {
      throw new TypeError('Network request failed');
    });
    await expect(oidcAuth.getToken()).resolves.toBeNull();
  });

  it('reports the stored person and workspace', () => {
    const { auth, user, organization, list } = readHooks();
    expect(auth).toMatchObject({ isLoaded: true, isSignedIn: true, userId: 'user-1', orgId: 'org-1' });
    expect(user.user).toMatchObject({
      fullName: 'Ada Lovelace',
      primaryEmailAddress: { emailAddress: 'ada@example.com' },
      phoneNumbers: [],
    });
    expect(organization.organization).toMatchObject({ id: 'org-1', name: 'Acme' });
    expect(list.isLoaded).toBe(true);
    expect(typeof list.setActive).toBe('function');
    expect(list.userMemberships.data).toEqual([{ organization: { id: 'org-1', name: 'Acme', slug: null, imageUrl: '' } }]);
  });

  it('redirects to the app scheme and links the provider account page', () => {
    expect(oidcRedirectUri()).toBe('weldmail://sso-callback');
    expect(oidcAuth.accountUrl).toBe('https://auth.test.weldsuite.eu/ui/console/users/me');
  });

  it('reports signed out after sign-out', async () => {
    await oidcAuth.signOut();
    const { auth, user, organization } = readHooks();
    expect(auth).toMatchObject({ isLoaded: true, isSignedIn: false, userId: null });
    expect(user).toMatchObject({ isSignedIn: false, user: null });
    expect(organization.organization).toBeNull();
    expect(secure.size).toBe(0);
  });
});

describe('Clerk implementation', () => {
  it('mounts ClerkProvider with the runtime key and survives an uninitialised Clerk', async () => {
    setMobileRuntime(buildGlobalRuntime(APP, BUILD));
    expect(renderToString(createElement(clerkAuth.Provider, { clerk: { passkeys: {} }, children: 'app' }))).toBe('app');
    await expect(clerkAuth.getToken()).resolves.toBeNull();
    await expect(clerkAuth.signOut()).resolves.toBeUndefined();
  });
});
