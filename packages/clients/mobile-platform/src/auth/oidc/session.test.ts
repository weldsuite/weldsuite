import { createHash, randomBytes } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { KeyValueStore } from '../../runtime/state';
import {
  base64UrlFromBytes,
  bytesFromBase64,
  decodeJwtPayload,
  queryParams,
  utf8Decode,
} from './encoding';
import { OidcMobileSession, OidcSignInError, storageIdFor, type OidcSessionDeps, type SecureStoreLike } from './session';

const ISSUER = 'https://auth.test.weldsuite.eu';
const PROJECT = '300000000000000100';
const ROLES = `urn:zitadel:iam:org:project:${PROJECT}:roles`;
const REDIRECT = 'weldmail://sso-callback';

function b64url(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url');
}

function jwt(payload: Record<string, unknown>): string {
  return `${b64url('{"alg":"none"}')}.${b64url(JSON.stringify(payload))}.sig`;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

interface Fake {
  deps: OidcSessionDeps;
  secure: Map<string, string>;
  cache: Map<string, string>;
  tokenCalls: URLSearchParams[];
  revoked: string[];
  authorizeUrls: string[];
  /** What the next token request answers. */
  tokenAnswers: Array<(params: URLSearchParams) => Response>;
  now: { value: number };
  online: { value: boolean };
}

function fake(): Fake {
  const secure = new Map<string, string>();
  const cache = new Map<string, string>();
  const tokenCalls: URLSearchParams[] = [];
  const revoked: string[] = [];
  const authorizeUrls: string[] = [];
  const tokenAnswers: Fake['tokenAnswers'] = [];
  const now = { value: 1_000_000 };
  const online = { value: true };
  const secureStore: SecureStoreLike = {
    getItemAsync: async (key) => secure.get(key) ?? null,
    setItemAsync: async (key, value) => {
      secure.set(key, value);
    },
    deleteItemAsync: async (key) => {
      secure.delete(key);
    },
  };
  const cacheStore: KeyValueStore = {
    getItem: async (key) => cache.get(key) ?? null,
    setItem: async (key, value) => {
      cache.set(key, value);
    },
    removeItem: async (key) => {
      cache.delete(key);
    },
  };
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (!online.value) throw new TypeError('Network request failed');
    const url = String(input);
    if (url === `${ISSUER}/.well-known/openid-configuration`) {
      return json({
        authorization_endpoint: `${ISSUER}/oauth/v2/authorize`,
        token_endpoint: `${ISSUER}/oauth/v2/token`,
        revocation_endpoint: `${ISSUER}/oauth/v2/revoke`,
      });
    }
    const params = new URLSearchParams(String(init?.body ?? ''));
    if (url === `${ISSUER}/oauth/v2/token`) {
      tokenCalls.push(params);
      const answer = tokenAnswers.shift();
      if (!answer) throw new Error('no token answer queued');
      return answer(params);
    }
    if (url === `${ISSUER}/oauth/v2/revoke`) {
      revoked.push(params.get('token') ?? '');
      return new Response(null, { status: 200 });
    }
    throw new Error(`unexpected fetch ${url}`);
  }) as typeof fetch;

  const deps: OidcSessionDeps = {
    fetchImpl,
    secureStore,
    cacheStore,
    randomBytes: (size) => new Uint8Array(randomBytes(size)),
    sha256Base64: async (input) => createHash('sha256').update(input).digest('base64'),
    now: () => now.value,
    openAuthSession: async (url) => {
      authorizeUrls.push(url);
      const params = new URL(url).searchParams;
      return { type: 'success', url: `${REDIRECT}?code=code-${authorizeUrls.length}&state=${params.get('state')}` };
    },
  };
  return { deps, secure, cache, tokenCalls, revoked, authorizeUrls, tokenAnswers, now, online };
}

function session(f: Fake) {
  return new OidcMobileSession(
    {
      issuer: ISSUER,
      clientId: 'mobile-client',
      redirectUri: REDIRECT,
      audience: PROJECT,
      orgClaim: ROLES,
      storageId: storageIdFor('https://app.test.weldsuite.eu'),
    },
    f.deps,
  );
}

const PERSON = { sub: 'user-1', given_name: 'Ada', family_name: 'Lovelace', email: 'ada@example.com' };

function tokens(orgs: Record<string, string>, refresh: string) {
  return () =>
    json({
      access_token: jwt({ sub: 'user-1', [ROLES]: { member: orgs } }),
      refresh_token: refresh,
      id_token: jwt({ ...PERSON, [ROLES]: { member: orgs } }),
      expires_in: 600,
    });
}

describe('encoding', () => {
  it('round-trips base64url and UTF-8', () => {
    const bytes = new Uint8Array(randomBytes(31));
    expect(base64UrlFromBytes(bytes)).toBe(Buffer.from(bytes).toString('base64url'));
    expect(bytesFromBase64(Buffer.from(bytes).toString('base64url'))).toEqual(bytes);
    expect(utf8Decode(new Uint8Array(Buffer.from('Gërt 🚀 ü', 'utf8')))).toBe('Gërt 🚀 ü');
  });

  it('reads JWT payloads and redirect queries', () => {
    expect(decodeJwtPayload(jwt({ name: 'Zoë' }))).toEqual({ name: 'Zoë' });
    expect(decodeJwtPayload('nope')).toBeNull();
    expect(queryParams('weldmail://sso-callback?code=a%2Fb&state=x#frag')).toEqual({ code: 'a/b', state: 'x' });
  });
});

describe('OidcMobileSession', () => {
  it('signs in with PKCE, lists the workspaces and makes the only one active', async () => {
    const f = fake();
    f.tokenAnswers.push(tokens({ 'org-1': 'acme.example' }, 'rt-1'));
    const s = session(f);
    await s.init();
    expect(s.getSnapshot()).toMatchObject({ isLoaded: true, person: null });

    await expect(s.signIn()).resolves.toBe('signed-in');

    const authorize = new URL(f.authorizeUrls[0]!);
    expect(authorize.searchParams.get('client_id')).toBe('mobile-client');
    expect(authorize.searchParams.get('redirect_uri')).toBe(REDIRECT);
    expect(authorize.searchParams.get('code_challenge_method')).toBe('S256');
    expect(authorize.searchParams.get('scope')).toContain(`urn:zitadel:iam:org:project:id:${PROJECT}:aud`);
    const verifier = f.tokenCalls[0]!.get('code_verifier')!;
    expect(createHash('sha256').update(verifier).digest('base64url')).toBe(authorize.searchParams.get('code_challenge'));
    expect(f.tokenCalls[0]!.get('grant_type')).toBe('authorization_code');

    expect(s.getSnapshot()).toMatchObject({
      person: { id: 'user-1', fullName: 'Ada Lovelace', email: 'ada@example.com' },
      organizations: [{ id: 'org-1', name: 'acme.example' }],
      activeOrgId: 'org-1',
    });
    await expect(s.getToken()).resolves.toMatch(/\./);
    expect(f.tokenCalls).toHaveLength(1);
  });

  it('restores the session after a restart and refreshes the access token', async () => {
    const f = fake();
    f.tokenAnswers.push(tokens({ 'org-1': 'acme.example' }, 'rt-1'));
    await session(f).signIn();

    const restarted = session(f);
    await restarted.init();
    expect(restarted.getSnapshot()).toMatchObject({ person: { id: 'user-1' }, activeOrgId: 'org-1' });
    f.tokenAnswers.push(tokens({ 'org-1': 'acme.example' }, 'rt-2'));
    await expect(restarted.getToken()).resolves.toBeTruthy();
    expect(f.tokenCalls[1]!.get('grant_type')).toBe('refresh_token');
    expect(f.tokenCalls[1]!.get('refresh_token')).toBe('rt-1');
  });

  it('stays signed in offline and signs out when the refresh is refused', async () => {
    const f = fake();
    f.tokenAnswers.push(tokens({ 'org-1': 'acme.example' }, 'rt-1'));
    await session(f).signIn();
    const s = session(f);
    await s.init();

    f.online.value = false;
    await expect(s.getToken()).resolves.toBeNull();
    expect(s.getSnapshot().person).not.toBeNull();

    f.online.value = true;
    f.tokenAnswers.push(() => json({ error: 'invalid_grant' }, 400));
    await expect(s.getToken()).resolves.toBeNull();
    expect(s.getSnapshot().person).toBeNull();
    expect(f.secure.size).toBe(0);
  });

  it('switches workspace through the browser once, then with the kept token', async () => {
    const f = fake();
    f.tokenAnswers.push(tokens({ 'org-1': 'acme.example', 'org-2': 'globex.example' }, 'rt-all'));
    const s = session(f);
    await s.signIn();
    expect(s.getSnapshot()).toMatchObject({ activeOrgId: null, organizations: [{ id: 'org-1' }, { id: 'org-2' }] });

    f.tokenAnswers.push(tokens({ 'org-2': 'globex.example' }, 'rt-2'));
    await s.setActiveOrganization('org-2');
    expect(f.authorizeUrls).toHaveLength(2);
    expect(new URL(f.authorizeUrls[1]!).searchParams.get('scope')).toContain('urn:zitadel:iam:org:roles:id:org-2');
    expect(s.getSnapshot()).toMatchObject({ activeOrgId: 'org-2', organizations: [{ id: 'org-1' }, { id: 'org-2' }] });

    f.tokenAnswers.push(tokens({ 'org-1': 'acme.example' }, 'rt-1'));
    await s.setActiveOrganization('org-1');
    expect(f.authorizeUrls).toHaveLength(3);

    // Back to org-2: its refresh token is kept, no browser.
    f.tokenAnswers.push(tokens({ 'org-2': 'globex.example' }, 'rt-2b'));
    await s.setActiveOrganization('org-2');
    expect(f.authorizeUrls).toHaveLength(3);
    expect(f.tokenCalls.at(-1)!.get('refresh_token')).toBe('rt-2');
    expect(s.getSnapshot().activeOrgId).toBe('org-2');
  });

  it('treats a closed sheet as cancelled and a bad state as an error', async () => {
    const f = fake();
    const s = session(f);
    await s.init();
    f.deps.openAuthSession = async () => ({ type: 'cancel' });
    await expect(s.signIn()).resolves.toBe('cancelled');
    f.deps.openAuthSession = async () => ({ type: 'success', url: `${REDIRECT}?code=x&state=forged` });
    await expect(s.signIn()).rejects.toBeInstanceOf(OidcSignInError);
    f.deps.openAuthSession = async () => ({
      type: 'success',
      url: `${REDIRECT}?error=server_error&error_description=Something%20broke`,
    });
    await expect(s.signIn()).rejects.toThrow('Something broke');
  });

  it('asks for the sign-up form with prompt=create', async () => {
    const f = fake();
    f.tokenAnswers.push(tokens({}, 'rt'));
    await session(f).signIn({ intent: 'sign-up' });
    expect(new URL(f.authorizeUrls[0]!).searchParams.get('prompt')).toBe('create');
  });

  it('forgets everything and revokes the refresh tokens on sign-out', async () => {
    const f = fake();
    f.tokenAnswers.push(tokens({ 'org-1': 'acme.example', 'org-2': 'globex.example' }, 'rt-all'));
    const s = session(f);
    await s.signIn();
    f.tokenAnswers.push(tokens({ 'org-2': 'globex.example' }, 'rt-2'));
    await s.setActiveOrganization('org-2');
    const listener = vi.fn();
    s.subscribe(listener);

    await s.signOut();
    expect(s.getSnapshot()).toMatchObject({ person: null, organizations: [], activeOrgId: null });
    expect(listener).toHaveBeenCalled();
    expect(f.secure.size).toBe(0);
    expect(f.cache.size).toBe(0);
    expect(f.revoked.sort()).toEqual(['rt-2', 'rt-all']);
  });

  it('keeps storage keys to the characters the secure store allows', () => {
    expect(storageIdFor('https://weld.example.com:8443')).toBe('weld.example.com_8443');
  });
});
