/**
 * The OIDC implementation against a mocked Zitadel-like issuer: discovery,
 * the authorization redirect (PKCE), the code exchange, the facade's hooks,
 * workspace switching through organization-scoped tokens, and refresh. CI
 * against a real Zitadel is a later step (see the note in ./index.tsx).
 */
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createOidcAuth } from './index';
import type { OidcSessionConfig, OidcSessionOptions } from './session';
import { parseWorkspaceDirectory, type WorkspaceDirectoryEntry } from './workspaces';
import { clerkAuth } from '../clerk-adapter';
import {
  getAuthProvider,
  getAuthToken,
  setAuthImplementation,
  useAuth,
  useOrganization,
  useOrganizationList,
  usesPlatformSignIn,
  useUser,
} from '../index';

const ISSUER = 'https://id.example.test';
const ORIGIN = 'https://weldsuite.example.eu';
const CLIENT_ID = '300000000000000300';
const PROJECT = '300000000000000100';
const ORG_CLAIM = `urn:zitadel:iam:org:project:${PROJECT}:roles`;
const ORG_SCOPE = 'urn:zitadel:iam:org:roles:id:';

/** What the Rust backend serves in `/config.json` `auth`. */
const CONFIG: OidcSessionConfig = {
  provider: 'oidc',
  issuer: ISSUER,
  clientId: CLIENT_ID,
  audience: PROJECT,
  orgClaim: ORG_CLAIM,
};

function base64url(input: string | ArrayBuffer): string {
  const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : new Uint8Array(input);
  let binary = '';
  for (const byte of bytes) binary += String.fromCodePoint(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** An unsigned JWT: oidc-client-ts reads the ID token's claims; the API verifies signatures. */
function jwt(claims: Record<string, unknown>): string {
  return `${base64url(JSON.stringify({ alg: 'none', typ: 'JWT' }))}.${base64url(JSON.stringify(claims))}.`;
}

const now = () => Math.floor(Date.now() / 1000);

interface IssuerState {
  challenge: string | null;
  /** The organizations the person has a project role in. */
  memberships: Record<string, string>;
  /** Set from the authorize request's org-roles scope, as Zitadel narrows the roles claim. */
  narrowTo: string | null;
  tokenRequests: URLSearchParams[];
}

function idToken(state: IssuerState) {
  const orgs = state.narrowTo
    ? { [state.narrowTo]: state.memberships[state.narrowTo] }
    : state.memberships;
  return jwt({
    iss: ISSUER,
    aud: [CLIENT_ID, PROJECT],
    sub: 'user_2891',
    iat: now(),
    exp: now() + 300,
    name: 'Anna de Vries',
    given_name: 'Anna',
    family_name: 'de Vries',
    email: 'anna@acme.test',
    'urn:zitadel:iam:org:id': 'org_acme',
    'urn:zitadel:iam:user:resourceowner:id': 'org_acme',
    'urn:zitadel:iam:user:resourceowner:name': 'Acme BV',
    'urn:zitadel:iam:org:project:roles': { member: orgs },
    [ORG_CLAIM]: { member: orgs },
  });
}

function mockIssuer(state: IssuerState) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    let url: string;
    if (typeof input === 'string') url = input;
    else if (input instanceof URL) url = input.href;
    else url = input.url;
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    if (url === `${ISSUER}/.well-known/openid-configuration`) {
      return json({
        issuer: ISSUER,
        authorization_endpoint: `${ISSUER}/oauth/v2/authorize`,
        token_endpoint: `${ISSUER}/oauth/v2/token`,
        end_session_endpoint: `${ISSUER}/oidc/v1/end_session`,
        userinfo_endpoint: `${ISSUER}/oidc/v1/userinfo`,
        jwks_uri: `${ISSUER}/oauth/v2/keys`,
      });
    }
    if (url !== `${ISSUER}/oauth/v2/token`) return json({ error: 'not_found' }, 404);
    const body = new URLSearchParams(String(init?.body ?? ''));
    state.tokenRequests.push(body);
    if (body.get('grant_type') === 'authorization_code') {
      // PKCE: the verifier must hash to the challenge sent on the redirect.
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(body.get('code_verifier') ?? ''));
      if (body.get('code') !== 'code-1' || base64url(digest) !== state.challenge) {
        return json({ error: 'invalid_grant' }, 400);
      }
    } else if (body.get('grant_type') !== 'refresh_token' || body.get('refresh_token') !== 'rt-1') {
      return json({ error: 'invalid_grant' }, 400);
    }
    return json({
      access_token: `at-${state.tokenRequests.length}`,
      id_token: idToken(state),
      refresh_token: 'rt-1',
      token_type: 'Bearer',
      expires_in: 300,
    });
  });
}

const originalLocation = window.location;
let assign: ReturnType<typeof vi.fn>;
let issuer: IssuerState;

function stubLocation(href: string) {
  const url = new URL(href);
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: {
      ...originalLocation,
      href: url.href,
      origin: url.origin,
      protocol: url.protocol,
      host: url.host,
      hostname: url.hostname,
      pathname: url.pathname,
      search: url.search,
      hash: url.hash,
      assign,
      replace: assign,
    },
  });
}

/** Play the provider's part for the redirect number `index`: come back with a code. */
async function answerRedirect(auth: ReturnType<typeof createOidcAuth>, index: number) {
  await waitFor(() => expect(assign.mock.calls.length).toBeGreaterThan(index));
  const authorize = new URL(String(assign.mock.calls[index][0]));
  issuer.challenge = authorize.searchParams.get('code_challenge');
  const orgScope = (authorize.searchParams.get('scope') ?? '').split(' ').find((s) => s.startsWith(ORG_SCOPE));
  issuer.narrowTo = orgScope ? orgScope.slice(ORG_SCOPE.length) : null;
  stubLocation(`${ORIGIN}/auth/sso-callback?code=code-1&state=${authorize.searchParams.get('state')}`);
  const next = await auth.completeSignIn?.();
  return { authorize, next };
}

/** Sign in through the mocked issuer and return the facade's implementation. */
async function signedIn(options: Pick<OidcSessionOptions, 'loadWorkspaces'> = {}) {
  const auth = createOidcAuth(CONFIG, { origin: ORIGIN, storage: window.localStorage, ...options });
  setAuthImplementation(auth);
  void auth.redirectToSignIn?.({ returnTo: '/weldknow' });
  const { authorize, next } = await answerRedirect(auth, 0);
  return { auth, authorize, next };
}

beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
  assign = vi.fn();
  issuer = {
    challenge: null,
    memberships: { org_acme: 'acme.id.example.test', org_globex: 'globex.id.example.test' },
    narrowTo: null,
    tokenRequests: [],
  };
  vi.stubGlobal('fetch', mockIssuer(issuer));
  stubLocation(`${ORIGIN}/auth/login`);
});

afterEach(() => {
  setAuthImplementation(clerkAuth);
  vi.unstubAllGlobals();
  Object.defineProperty(window, 'location', { configurable: true, value: originalLocation });
});

describe('OIDC sign-in', () => {
  it('redirects with authorization code + PKCE, the project in aud and no organization', async () => {
    const { authorize } = await signedIn();
    expect(authorize.origin + authorize.pathname).toBe(`${ISSUER}/oauth/v2/authorize`);
    expect(authorize.searchParams.get('response_type')).toBe('code');
    expect(authorize.searchParams.get('client_id')).toBe(CLIENT_ID);
    expect(authorize.searchParams.get('redirect_uri')).toBe(`${ORIGIN}/auth/sso-callback`);
    expect(authorize.searchParams.get('code_challenge_method')).toBe('S256');
    const scopes = (authorize.searchParams.get('scope') ?? '').split(' ');
    expect(scopes).toContain('urn:zitadel:iam:org:projects:roles');
    expect(scopes).toContain(`urn:zitadel:iam:org:project:id:${PROJECT}:aud`);
    expect(scopes.some((s) => s.startsWith(ORG_SCOPE))).toBe(false);
  });

  it('exchanges the code (the verifier matches the challenge) and returns to where sign-in started', async () => {
    const { next } = await signedIn();
    expect(next).toBe('/weldknow');
    expect(issuer.tokenRequests[0].get('grant_type')).toBe('authorization_code');
    await expect(getAuthToken()).resolves.toBe('at-1');
  });

  it('asks the provider for its sign-up form', async () => {
    const auth = createOidcAuth(CONFIG, { origin: ORIGIN });
    void auth.redirectToSignIn?.({ intent: 'sign-up' });
    await waitFor(() => expect(assign).toHaveBeenCalled());
    expect(new URL(String(assign.mock.calls[0][0])).searchParams.get('prompt')).toBe('create');
  });

  it('never returns to another origin', async () => {
    const auth = createOidcAuth(CONFIG, { origin: ORIGIN });
    setAuthImplementation(auth);
    void auth.redirectToSignIn?.({ returnTo: '//evil.example' });
    const { next } = await answerRedirect(auth, 0);
    expect(next).toBe('/');
  });
});

describe('the facade on OIDC', () => {
  it('maps the session to the person and lists every workspace, none active yet', async () => {
    await signedIn();
    expect(getAuthProvider()).toBe('oidc');

    const { result } = renderHook(() => ({
      auth: useAuth(),
      user: useUser(),
      org: useOrganization(),
      list: useOrganizationList({ userMemberships: true }),
    }));
    await waitFor(() => expect(result.current.auth.isLoaded).toBe(true));

    expect(result.current.auth.isSignedIn).toBe(true);
    expect(result.current.auth.userId).toBe('user_2891');
    // Two workspaces in the roles claim: the backend would answer ORG_REQUIRED, so none is active.
    expect(result.current.auth.orgId).toBeNull();
    expect(result.current.org.organization).toBeNull();
    expect(result.current.user.user?.fullName).toBe('Anna de Vries');
    expect(result.current.user.user?.primaryEmailAddress?.emailAddress).toBe('anna@acme.test');
    expect(result.current.list.userMemberships.data?.map((m) => m.organization.id)).toEqual([
      'org_acme',
      'org_globex',
    ]);
  });

  it('activates a workspace with an organization-scoped token and keeps the list', async () => {
    const { auth } = await signedIn();
    stubLocation(`${ORIGIN}/weldknow/spaces`);
    const { result } = renderHook(() => ({ auth: useAuth(), org: useOrganization(), list: useOrganizationList() }));
    await waitFor(() => expect(result.current.auth.isLoaded).toBe(true));

    void result.current.list.setActive?.({ organization: 'org_globex' });
    let next: string | undefined;
    await act(async () => {
      const answered = await answerRedirect(auth, 1);
      next = answered.next;
      expect(answered.authorize.searchParams.get('scope')).toContain(`${ORG_SCOPE}org_globex`);
    });

    expect(next).toBe('/weldknow/spaces');
    await waitFor(() => expect(result.current.auth.orgId).toBe('org_globex'));
    expect(result.current.org.organization?.id).toBe('org_globex');
    expect(result.current.list.userMemberships.data?.map((m) => m.organization.id)).toEqual([
      'org_acme',
      'org_globex',
    ]);
    await expect(result.current.auth.getToken()).resolves.toBe('at-2');
  });

  it('needs no second round trip for someone with one workspace, nor to re-activate the active one', async () => {
    issuer.memberships = { org_acme: 'acme.id.example.test' };
    await signedIn();
    const { result } = renderHook(() => ({ auth: useAuth(), list: useOrganizationList() }));
    await waitFor(() => expect(result.current.auth.orgId).toBe('org_acme'));
    await act(() => result.current.list.setActive?.({ organization: 'org_acme' }) ?? Promise.resolve());
    expect(assign).toHaveBeenCalledTimes(1);
  });

  it('refreshes an expired access token with the refresh token, staying on the workspace', async () => {
    const { auth } = await signedIn();
    vi.useFakeTimers({ now: Date.now() + 10 * 60 * 1000, toFake: ['Date'] });
    try {
      await expect(auth.getToken()).resolves.toBe('at-2');
      expect(issuer.tokenRequests[1].get('grant_type')).toBe('refresh_token');
    } finally {
      vi.useRealTimers();
    }
  });

  it("names workspaces from WeldSuite's list, with their slugs, and adds ones the token doesn't name yet", async () => {
    issuer.memberships = { org_acme: 'acme.auth.weldsuite.eu' };
    const directory: WorkspaceDirectoryEntry[] = [
      { id: 'org_acme', name: 'Acme', slug: 'acme' },
      { id: 'org_new', name: 'New Co', slug: 'new-co' },
    ];
    const loadWorkspaces = vi.fn(async (_token: string) => directory);
    await signedIn({ loadWorkspaces });
    const { result } = renderHook(() => ({ auth: useAuth(), list: useOrganizationList() }));
    await waitFor(() => expect(result.current.auth.orgSlug).toBe('acme'));

    expect(loadWorkspaces).toHaveBeenCalledWith('at-1');
    expect(result.current.list.userMemberships.isLoading).toBe(false);
    expect(result.current.list.userMemberships.data?.map((m) => m.organization)).toEqual([
      expect.objectContaining({ id: 'org_acme', name: 'Acme', slug: 'acme' }),
      expect.objectContaining({ id: 'org_new', name: 'New Co', slug: 'new-co' }),
    ]);
    // Kept for the next page load, which has them before the API answers.
    expect(JSON.parse(window.localStorage.getItem('weldsuite:oidc:workspaces') ?? '{}').workspaces).toEqual(directory);
  });

  it("keeps the last names when the backend's read fails", async () => {
    issuer.memberships = { org_acme: 'acme.auth.weldsuite.eu' };
    window.localStorage.setItem(
      'weldsuite:oidc:workspaces',
      JSON.stringify({ sub: 'user_2891', workspaces: [{ id: 'org_acme', name: 'Acme', slug: 'acme' }] }),
    );
    const loadWorkspaces = vi.fn(async (_token: string) => [] as WorkspaceDirectoryEntry[]);
    await signedIn({ loadWorkspaces });
    const { result } = renderHook(() => ({ auth: useAuth(), list: useOrganizationList() }));
    await waitFor(() => expect(loadWorkspaces).toHaveBeenCalled());
    await waitFor(() => expect(result.current.list.userMemberships.isLoading).toBe(false));
    expect(result.current.auth.orgSlug).toBe('acme');
    expect(result.current.list.userMemberships.data?.[0].organization.name).toBe('Acme');
  });

  it("switching from a page of another workspace comes back to the new workspace's home", async () => {
    const loadWorkspaces = async () => [
      { id: 'org_acme', name: 'Acme', slug: 'acme' },
      { id: 'org_globex', name: 'Globex', slug: 'globex' },
    ];
    const { auth } = await signedIn({ loadWorkspaces });
    stubLocation(`${ORIGIN}/w/acme/weldknow/spaces/space_1`);
    const { result } = renderHook(() => ({ auth: useAuth(), list: useOrganizationList() }));
    await waitFor(() => expect(result.current.list.userMemberships.data?.[1]?.organization.slug).toBe('globex'));

    void result.current.list.setActive?.({ organization: 'org_globex' });
    let next: string | undefined;
    await act(async () => {
      next = (await answerRedirect(auth, 1)).next;
    });
    // The old URL names Acme: Globex's token couldn't open it.
    expect(next).toBe('/w/globex/');
  });

  it('comes back to the same page when its URL already names the workspace, or to returnTo', async () => {
    const loadWorkspaces = async () => [{ id: 'org_globex', name: 'Globex', slug: 'globex' }];
    const { auth } = await signedIn({ loadWorkspaces });
    stubLocation(`${ORIGIN}/w/globex/weldknow?tab=recent`);
    const { result } = renderHook(() => ({ auth: useAuth(), list: useOrganizationList() }));
    await waitFor(() => expect(result.current.list.userMemberships.isLoading).toBe(false));

    void result.current.list.setActive?.({ organization: 'org_globex' });
    await act(async () => {
      expect((await answerRedirect(auth, 1)).next).toBe('/w/globex/weldknow?tab=recent');
    });

    stubLocation(`${ORIGIN}/w/globex/weldknow`);
    void result.current.list.setActive?.({ organization: 'org_acme', returnTo: '/onboarding' });
    await act(async () => {
      expect((await answerRedirect(auth, 2)).next).toBe('/onboarding');
    });
  });

  it('reads the list again on request, after a workspace was created server-side', async () => {
    issuer.memberships = { org_acme: 'acme.auth.weldsuite.eu' };
    let directory: WorkspaceDirectoryEntry[] = [{ id: 'org_acme', name: 'Acme', slug: 'acme' }];
    const loadWorkspaces = vi.fn(async (_token: string) => directory);
    await signedIn({ loadWorkspaces });
    const { result } = renderHook(() => useOrganizationList());
    await waitFor(() => expect(result.current.userMemberships.data?.[0]?.organization.name).toBe('Acme'));

    directory = [...directory, { id: 'org_new', name: 'New Co', slug: 'new-co' }];
    await act(async () => {
      await result.current.userMemberships.revalidate?.();
    });
    expect(result.current.userMemberships.data?.map((m) => m.organization.name)).toEqual(['Acme', 'New Co']);
    expect(loadWorkspaces).toHaveBeenCalledTimes(2);
  });

  it('switches to a workspace by its id while no slug is known', async () => {
    const { auth } = await signedIn({ loadWorkspaces: async () => null });
    stubLocation(`${ORIGIN}/w/org_acme/weldknow`);
    const { result } = renderHook(() => ({ auth: useAuth(), list: useOrganizationList() }));
    await waitFor(() => expect(result.current.list.userMemberships.isLoading).toBe(false));

    void result.current.list.setActive?.({ organization: 'org_globex' });
    await act(async () => {
      expect((await answerRedirect(auth, 1)).next).toBe('/w/org_globex/');
    });
    // What the token says stays the name until WeldSuite's list answers: the
    // person's own organization by name, any other by its domain.
    expect(result.current.list.userMemberships.data?.map((m) => m.organization.name)).toEqual([
      'Acme BV',
      'globex.id.example.test',
    ]);
  });

  it('reads the API answer into directory entries', () => {
    expect(
      parseWorkspaceDirectory({
        data: [
          { id: 'org_acme', workspaceId: 'ws_1', name: 'Acme', slug: 'acme', role: 'OWNER' },
          { id: 'org_x', name: '' },
          'junk',
        ],
      }),
    ).toEqual([{ id: 'org_acme', name: 'Acme', slug: 'acme' }]);
    expect(parseWorkspaceDirectory({ error: { code: 'ORG_REQUIRED' } })).toBeNull();
  });

  it('shows the provider’s pages unless the deployment has the platform show the sign-in screens', () => {
    setAuthImplementation(createOidcAuth(CONFIG, { origin: ORIGIN }));
    expect(usesPlatformSignIn()).toBe(false);
    setAuthImplementation(createOidcAuth({ ...CONFIG, signIn: 'platform' }, { origin: ORIGIN }));
    expect(usesPlatformSignIn()).toBe(true);
  });

  it('ends the session the sign-in screens opened, then signs out at the provider as before', async () => {
    const calls = () =>
      vi
        .mocked(fetch)
        .mock.calls.map(([input]) => String(input))
        .filter((url) => url.endsWith('/api/sign-in/sign-out'));
    const endSessions = () =>
      assign.mock.calls.map(([url]) => String(url)).filter((url) => url.startsWith(`${ISSUER}/oidc/v1/end_session`));
    // The redirect never resolves (the page would unload), so it is not awaited.
    const signOut = async (config: OidcSessionConfig, redirects: number) => {
      setAuthImplementation(createOidcAuth(config, { origin: ORIGIN }));
      const { result, unmount } = renderHook(() => useAuth());
      await waitFor(() => expect(result.current.isLoaded).toBe(true));
      void result.current.signOut({ redirectUrl: '/auth/login' });
      await waitFor(() => expect(endSessions()).toHaveLength(redirects));
      unmount();
    };

    // The provider's own pages: nothing of WeldSuite's to end.
    await signOut(CONFIG, 1);
    expect(calls()).toHaveLength(0);

    await signOut({ ...CONFIG, signIn: 'platform' }, 2);
    expect(calls()).toHaveLength(1);
  });

  it('is signed out without a session', async () => {
    const auth = createOidcAuth(CONFIG, { origin: ORIGIN });
    setAuthImplementation(auth);
    const { result } = renderHook(() => useAuth());
    await waitFor(() => expect(result.current.isLoaded).toBe(true));
    expect(result.current.isSignedIn).toBe(false);
    await expect(getAuthToken()).resolves.toBeNull();
  });
});
