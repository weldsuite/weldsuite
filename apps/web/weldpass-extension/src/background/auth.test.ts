import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { ServerProfile } from '../lib/server';
import { AuthFlowError, createSession, openAuthSession, sessionDeps, type AuthPlatform } from './auth';

const profile: ServerProfile = {
  origin: 'https://app.weldsuite.eu',
  apiOrigin: 'https://app.weldsuite.eu',
  issuer: 'https://auth.weldsuite.eu',
  clientId: 'weldsuite-extension',
  audience: 'weldsuite-api',
  orgClaim: null,
  scopes: ['openid', 'profile', 'email', 'offline_access'],
  audienceScope: null,
  organizationScope: null,
  workspaceSource: 'header',
  accountUrl: null,
};

function platform(overrides: Partial<AuthPlatform> = {}): AuthPlatform {
  const store = new Map<string, string>();
  const kv = {
    getItem: async (key: string) => store.get(key) ?? null,
    setItem: async (key: string, value: string) => {
      store.set(key, value);
    },
    removeItem: async (key: string) => {
      store.delete(key);
    },
  };
  return {
    fetchImpl: vi.fn() as unknown as typeof fetch,
    local: kv,
    secure: { getItemAsync: kv.getItem, setItemAsync: kv.setItem, deleteItemAsync: kv.removeItem },
    session: kv,
    launchWebAuthFlow: async () => undefined,
    redirectUri: 'https://nlmnjlkgeoeklbahlemmlcfnlfgdimnp.chromiumapp.org/',
    ...overrides,
  };
}

describe('openAuthSession', () => {
  it('runs the flow interactively and hands back the redirect', async () => {
    const launch = vi.fn(async () => 'https://id.chromiumapp.org/?code=c&state=s');
    await expect(openAuthSession({ launchWebAuthFlow: launch })('https://auth/authorize')).resolves.toEqual({
      type: 'success',
      url: 'https://id.chromiumapp.org/?code=c&state=s',
    });
    expect(launch).toHaveBeenCalledWith({ url: 'https://auth/authorize', interactive: true });
  });

  it('treats a closed window as cancelled, and anything else as a failure', async () => {
    const closed = vi.fn(async () => {
      throw new Error('The user did not approve access.');
    });
    const broken = vi.fn(async () => {
      throw new Error('Authorization page could not be loaded.');
    });
    await expect(openAuthSession({ launchWebAuthFlow: closed })('u')).resolves.toEqual({ type: 'cancel' });
    await expect(openAuthSession({ launchWebAuthFlow: broken })('u')).rejects.toBeInstanceOf(AuthFlowError);
  });
});

describe('sessionDeps', () => {
  it('hashes the PKCE verifier as standard base64 SHA-256', async () => {
    const deps = sessionDeps(profile, platform());
    expect(await deps.sha256Base64('verifier')).toBe(createHash('sha256').update('verifier').digest('base64'));
    expect(deps.randomBytes(32)).toHaveLength(32);
  });

  it('keeps the access token in the memory-only store', () => {
    const p = platform();
    expect(sessionDeps(profile, p).accessTokenStore).toBe(p.session);
  });

  it("reads WeldSuite's workspace list in header mode only", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ data: [{ id: 'ws_1', name: 'Acme' }] })));
    const deps = sessionDeps(profile, platform({ fetchImpl: fetchImpl as unknown as typeof fetch }));
    await expect(deps.loadWorkspaces?.('token')).resolves.toEqual([{ id: 'ws_1', name: 'Acme', slug: null }]);
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://app.weldsuite.eu/api/workspaces',
      expect.objectContaining({ headers: { Authorization: 'Bearer token', Accept: 'application/json' } }),
    );
    expect(sessionDeps({ ...profile, workspaceSource: 'claim' }, platform()).loadWorkspaces).toBeUndefined();
  });
});

describe('createSession', () => {
  it('signs in with the extension client and the chromiumapp.org redirect', async () => {
    const authorizeUrls: string[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).endsWith('/.well-known/openid-configuration')) {
        return new Response(
          JSON.stringify({
            authorization_endpoint: 'https://auth.weldsuite.eu/oauth/authorize',
            token_endpoint: 'https://auth.weldsuite.eu/oauth/token',
          }),
        );
      }
      throw new Error('unexpected');
    });
    const session = createSession(
      profile,
      platform({
        fetchImpl: fetchImpl as unknown as typeof fetch,
        launchWebAuthFlow: async ({ url }) => {
          authorizeUrls.push(url);
          return undefined;
        },
      }),
    );
    await expect(session.signIn()).resolves.toBe('cancelled');
    const authorize = new URL(authorizeUrls[0]!);
    expect(authorize.searchParams.get('client_id')).toBe('weldsuite-extension');
    expect(authorize.searchParams.get('redirect_uri')).toBe('https://nlmnjlkgeoeklbahlemmlcfnlfgdimnp.chromiumapp.org/');
    expect(authorize.searchParams.get('code_challenge_method')).toBe('S256');
    expect(authorize.searchParams.get('scope')).toBe('openid profile email offline_access');
  });
});
