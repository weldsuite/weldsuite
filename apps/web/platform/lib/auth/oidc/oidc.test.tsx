/**
 * The OIDC implementation against a mocked Zitadel-like issuer: discovery,
 * the authorization redirect (PKCE), the code exchange, the facade's hooks,
 * workspace switching through organization-scoped tokens, and refresh. CI
 * against a real Zitadel is a later step (see the note in ./index.tsx).
 */
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createOidcAuth } from './index';
import { defaultAccountUrl, type OidcSessionConfig, type OidcSessionOptions } from './session';
import { parseWorkspaceDirectory, type WorkspaceDirectoryEntry } from './workspaces';
import { clerkAuth } from '../clerk-adapter';
import { BrowserSignInError, type BrowserSignIn } from './browser-sign-in';
import {
  getAuthProvider,
  getAuthToken,
  redirectToSignIn,
  setAuthImplementation,
  signInWithBrowser,
  useAuth,
  useOrganization,
  useOrganizationList,
  usesBrowserSignIn,
  usesPlatformSignIn,
  useUser,
  workspaceRefOf,
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
  /** The authorize request's nonce, echoed in the ID token. */
  nonce?: string | null;
  tokenRequests: URLSearchParams[];
  revocations?: URLSearchParams[];
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
    ...(state.nonce ? { nonce: state.nonce } : {}),
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
        revocation_endpoint: `${ISSUER}/oauth/v2/revoke`,
        jwks_uri: `${ISSUER}/oauth/v2/keys`,
      });
    }
    if (url === `${ISSUER}/oauth/v2/revoke`) {
      (state.revocations ??= []).push(new URLSearchParams(String(init?.body ?? '')));
      return new Response(null, { status: 200 });
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

describe('defaultAccountUrl (TASK-1427)', () => {
  it('is the Zitadel self-service page under the issuer', () => {
    expect(defaultAccountUrl('https://auth.test.weldsuite.eu')).toBe('https://auth.test.weldsuite.eu/ui/console/users/me');
    expect(defaultAccountUrl('not a url')).toBeUndefined();
  });
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

  it("asks WeldID's sign-in pages for the platform's current language", async () => {
    const { authorize } = await signedIn();
    expect(authorize.searchParams.get('ui_locales')).toBe('en');
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
    const loadWorkspaces = vi.fn(async (_token: string) => null);
    await signedIn({ loadWorkspaces });
    const { result } = renderHook(() => ({ auth: useAuth(), list: useOrganizationList() }));
    await waitFor(() => expect(loadWorkspaces).toHaveBeenCalled());
    await waitFor(() => expect(result.current.list.userMemberships.isLoading).toBe(false));
    expect(result.current.auth.orgSlug).toBe('acme');
    expect(result.current.list.userMemberships.data?.[0].organization.name).toBe('Acme');
  });

  it('takes an empty answer as no workspaces: a workspace the person left is not listed again', async () => {
    issuer.memberships = { org_acme: 'acme.auth.weldsuite.eu' };
    window.localStorage.setItem(
      'weldsuite:oidc:workspaces',
      JSON.stringify({ sub: 'user_2891', workspaces: [{ id: 'org_gone', name: 'Gone Co', slug: 'gone' }] }),
    );
    const loadWorkspaces = vi.fn(async (_token: string) => [] as WorkspaceDirectoryEntry[]);
    await signedIn({ loadWorkspaces });
    const { result } = renderHook(() => useOrganizationList());
    await waitFor(() => expect(loadWorkspaces).toHaveBeenCalled());
    await waitFor(() => expect(result.current.userMemberships.isLoading).toBe(false));
    expect(result.current.userMemberships.data?.map((m) => m.organization.id)).toEqual(['org_acme']);
    expect(JSON.parse(window.localStorage.getItem('weldsuite:oidc:workspaces') ?? '{}').workspaces).toEqual([]);
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

  describe('signing out to another page than /', () => {
    const endSessions = () =>
      assign.mock.calls
        .map(([url]) => String(url))
        .filter((url) => url.startsWith(`${ISSUER}/oidc/v1/end_session`))
        .map((url) => new URL(url));

    async function signOutTo(redirectUrl: string): Promise<URL> {
      await signedIn();
      const { result, unmount } = renderHook(() => useAuth());
      await waitFor(() => expect(result.current.isSignedIn).toBe(true));
      // The redirect never resolves (the page would unload), so it is not awaited.
      void result.current.signOut({ redirectUrl });
      await waitFor(() => expect(endSessions()).toHaveLength(1));
      unmount();
      return endSessions()[0]!;
    }

    /** A new page load, as the provider's redirect to `href` makes. */
    async function loadPage(href: string) {
      stubLocation(href);
      assign.mockClear();
      const auth = createOidcAuth(CONFIG, { origin: ORIGIN, storage: window.localStorage });
      setAuthImplementation(auth);
      const { result } = renderHook(() => useAuth());
      return result;
    }

    it('names only the registered post-logout URI, the page riding in state (WeldID compares it exactly)', async () => {
      const endSession = await signOutTo('/auth/login');
      expect(endSession.searchParams.get('post_logout_redirect_uri')).toBe(`${ORIGIN}/`);
      expect(endSession.searchParams.get('id_token_hint')).toBeTruthy();
      expect(endSession.searchParams.get('state')).toBeTruthy();
    });

    it('goes on from / to that page when the provider comes back, before the shell loads', async () => {
      const endSession = await signOutTo('/invite/accept?token=inv_1');
      const state = endSession.searchParams.get('state');

      const auth = await loadPage(`${ORIGIN}/?state=${state}`);
      await waitFor(() => expect(assign).toHaveBeenCalledWith('/invite/accept?token=inv_1'));
      expect(auth.current.isLoaded).toBe(false);

      // The state is spent: the same URL again is an ordinary signed-out load.
      const again = await loadPage(`${ORIGIN}/?state=${state}`);
      await waitFor(() => expect(again.current.isLoaded).toBe(true));
      expect(again.current.isSignedIn).toBe(false);
      expect(assign).not.toHaveBeenCalled();
    });

    it('sends no state when / is where it ends anyway', async () => {
      const endSession = await signOutTo('/');
      expect(endSession.searchParams.get('post_logout_redirect_uri')).toBe(`${ORIGIN}/`);
      expect(endSession.searchParams.has('state')).toBe(false);
    });

    it('never carries another origin through the provider', async () => {
      const endSession = await signOutTo('//evil.example/phish');
      expect(endSession.searchParams.get('post_logout_redirect_uri')).toBe(`${ORIGIN}/`);
      expect(endSession.searchParams.has('state')).toBe(false);
    });
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

describe('the facade on OIDC in header mode (WeldID in membership mode)', () => {
  /** What the Rust backend serves when WeldID owns the workspace header. */
  const HEADER_CONFIG: OidcSessionConfig = {
    provider: 'oidc',
    issuer: ISSUER,
    clientId: CLIENT_ID,
    audienceScope: null,
    organizationScope: null,
    workspaceSource: 'header',
  };
  const directory = [
    { id: 'ws_acme', name: 'Acme', slug: 'acme' },
    { id: 'ws_globex', name: 'Globex', slug: 'globex' },
  ];

  it('never asks for an audience or organization scope', async () => {
    const auth = createOidcAuth(HEADER_CONFIG, { origin: ORIGIN });
    setAuthImplementation(auth);
    void auth.redirectToSignIn?.();
    const { authorize } = await answerRedirect(auth, 0);
    const scopes = (authorize.searchParams.get('scope') ?? '').split(' ');
    expect(scopes.some((s) => s.startsWith(ORG_SCOPE))).toBe(false);
    expect(scopes.some((s) => s.includes(':aud'))).toBe(false);
  });

  it("lists workspaces from WeldSuite's own directory, never the token's claims, and switches with no redirect", async () => {
    const loadWorkspaces = vi.fn(async (_token: string) => directory);
    const auth = createOidcAuth(HEADER_CONFIG, { origin: ORIGIN, storage: window.localStorage, loadWorkspaces });
    setAuthImplementation(auth);
    void auth.redirectToSignIn?.();
    await answerRedirect(auth, 0);

    const { result } = renderHook(() => ({ auth: useAuth(), list: useOrganizationList() }));
    await waitFor(() =>
      expect(result.current.list.userMemberships.data?.map((m) => m.organization.id)).toEqual(['ws_acme', 'ws_globex']),
    );
    // Two workspaces and no local choice yet: none active.
    expect(result.current.auth.orgId).toBeNull();

    await act(async () => {
      await result.current.list.setActive?.({ organization: 'ws_globex' });
    });
    expect(result.current.auth.orgId).toBe('ws_globex');
    // A local choice only: the one redirect was the sign-in itself.
    expect(assign).toHaveBeenCalledTimes(1);
  });

  it('keeps the chosen workspace for this person across a reload', async () => {
    const loadWorkspaces = async () => directory;
    const first = createOidcAuth(HEADER_CONFIG, { origin: ORIGIN, storage: window.localStorage, loadWorkspaces });
    setAuthImplementation(first);
    void first.redirectToSignIn?.();
    await answerRedirect(first, 0);
    const { result: r1 } = renderHook(() => useOrganizationList());
    await waitFor(() => expect(r1.current.userMemberships.data?.length).toBe(2));
    await act(async () => {
      await r1.current.setActive?.({ organization: 'ws_globex' });
    });

    const second = createOidcAuth(HEADER_CONFIG, { origin: ORIGIN, storage: window.localStorage, loadWorkspaces });
    setAuthImplementation(second);
    const { result } = renderHook(() => useAuth());
    await waitFor(() => expect(result.current.isLoaded).toBe(true));
    expect(result.current.orgId).toBe('ws_globex');
  });

  it('activates a workspace just created by its workspaces.id, which the directory names by slug', async () => {
    const created = { id: 'ws_new', name: 'New Co', slug: 'new-co' };
    let workspaces: WorkspaceDirectoryEntry[] = directory;
    const loadWorkspaces = async () => workspaces;
    const auth = createOidcAuth(HEADER_CONFIG, { origin: ORIGIN, storage: window.localStorage, loadWorkspaces });
    setAuthImplementation(auth);
    void auth.redirectToSignIn?.();
    await answerRedirect(auth, 0);
    const { result } = renderHook(() => ({ auth: useAuth(), list: useOrganizationList() }));
    await waitFor(() => expect(result.current.list.userMemberships.data?.length).toBe(2));

    // What creating a workspace answers, and the list read again after it.
    const ref = workspaceRefOf({ organizationId: 'org_new', workspaceId: 'ws_new' });
    expect(ref).toBe('ws_new');
    workspaces = [...directory, created];
    await act(async () => {
      await result.current.list.userMemberships.revalidate?.();
      await result.current.list.setActive?.({ organization: ref });
    });

    expect(result.current.auth.orgId).toBe('ws_new');
    // The URL names the active workspace by `orgSlug || orgId`.
    expect(result.current.auth.orgSlug).toBe('new-co');
  });

});

describe('which id names a workspace just created (workspaceRefOf)', () => {
  const ids = { organizationId: 'org_new', workspaceId: 'ws_new' };

  it('is the organization id on Clerk and on claim-mode OIDC, which switch by organization', () => {
    setAuthImplementation(clerkAuth);
    expect(workspaceRefOf(ids)).toBe('org_new');
    setAuthImplementation(createOidcAuth(CONFIG, { origin: ORIGIN }));
    expect(workspaceRefOf(ids)).toBe('org_new');
    expect(workspaceRefOf({ workspaceId: 'ws_new' })).toBeNull();
  });

  it('is workspaces.id in header mode, else the organization id the backend also takes', () => {
    setAuthImplementation(createOidcAuth({ ...CONFIG, workspaceSource: 'header' }, { origin: ORIGIN }));
    expect(workspaceRefOf(ids)).toBe('ws_new');
    expect(workspaceRefOf({ organizationId: 'org_new' })).toBe('org_new');
    expect(workspaceRefOf({})).toBeNull();
  });
});

describe('inside the desktop shell (system browser, loopback redirect)', () => {
  /** What `/config.json` names for the desktop app: its own native client. */
  const DESKTOP_CONFIG: OidcSessionConfig = {
    provider: 'oidc',
    issuer: ISSUER,
    clientId: 'weldsuite-desktop',
    audienceScope: null,
    organizationScope: null,
    workspaceSource: 'header',
  };
  const LOOPBACK = 'http://127.0.0.1:53123/callback';

  type Answer = (authorize: URL, redirectUri: string) => string | BrowserSignInError;

  /** The shell's part, played here: the "browser" answers the authorization request. */
  function fakeShell(answer: Answer) {
    const authorizeUrls: URL[] = [];
    const opened: string[] = [];
    let flows = 0;
    const browserSignIn = {
      start: vi.fn(async () => ({ id: `flow-${++flows}`, redirectUri: LOOPBACK })),
      authorize: vi.fn(async (_id: string, url: string) => {
        const authorize = new URL(url);
        authorizeUrls.push(authorize);
        issuer.challenge = authorize.searchParams.get('code_challenge');
        issuer.nonce = authorize.searchParams.get('nonce');
        const result = answer(authorize, LOOPBACK);
        if (result instanceof BrowserSignInError) throw result;
        return result;
      }),
      cancel: vi.fn(async (_id: string) => undefined),
      openExternal: vi.fn(async (url: string) => {
        opened.push(url);
      }),
    } satisfies BrowserSignIn;
    return { browserSignIn, authorizeUrls, opened };
  }

  const backWithCode: Answer = (authorize, redirectUri) =>
    `${redirectUri}?code=code-1&state=${authorize.searchParams.get('state')}`;

  function desktop(answer: Answer = backWithCode) {
    const shell = fakeShell(answer);
    setAuthImplementation(createOidcAuth(DESKTOP_CONFIG, { origin: ORIGIN, browserSignIn: shell.browserSignIn }));
    return shell;
  }

  it('signs in through the system browser and redeems the code in this page', async () => {
    const shell = desktop();
    expect(usesBrowserSignIn()).toBe(true);
    await signInWithBrowser({ returnTo: '/weldknow' });

    const authorize = shell.authorizeUrls[0];
    expect(authorize.origin + authorize.pathname).toBe(`${ISSUER}/oauth/v2/authorize`);
    expect(authorize.searchParams.get('client_id')).toBe('weldsuite-desktop');
    expect(authorize.searchParams.get('redirect_uri')).toBe(LOOPBACK);
    expect(authorize.searchParams.get('response_type')).toBe('code');
    expect(authorize.searchParams.get('code_challenge_method')).toBe('S256');
    expect(authorize.searchParams.get('state')).toBeTruthy();
    expect(authorize.searchParams.get('nonce')).toMatch(/^[0-9a-f]{32}$/);
    expect((authorize.searchParams.get('scope') ?? '').split(' ')).toContain('offline_access');

    // The code is redeemed here, with the verifier, at the loopback redirect URI.
    const exchange = issuer.tokenRequests[0];
    expect(exchange.get('grant_type')).toBe('authorization_code');
    expect(exchange.get('client_id')).toBe('weldsuite-desktop');
    expect(exchange.get('redirect_uri')).toBe(LOOPBACK);
    await expect(getAuthToken()).resolves.toBe('at-1');
    // The window never went to the provider: only on to where sign-in started.
    expect(assign.mock.calls.map(([url]) => String(url))).toEqual(['/weldknow']);
    expect(shell.browserSignIn.cancel).not.toHaveBeenCalled();
  });

  it('keeps the session fresh with the desktop client’s refresh token', async () => {
    desktop();
    await signInWithBrowser();
    vi.useFakeTimers({ now: Date.now() + 10 * 60 * 1000, toFake: ['Date'] });
    try {
      await expect(getAuthToken()).resolves.toBe('at-2');
      expect(issuer.tokenRequests[1].get('grant_type')).toBe('refresh_token');
      expect(issuer.tokenRequests[1].get('client_id')).toBe('weldsuite-desktop');
    } finally {
      vi.useRealTimers();
    }
  });

  it('leaves no session when the person cancels, and stops the shell listening', async () => {
    const shell = desktop(() => new BrowserSignInError('cancelled'));
    await expect(signInWithBrowser()).rejects.toMatchObject({ reason: 'cancelled' });
    expect(shell.browserSignIn.cancel).toHaveBeenCalledWith('flow-1');
    expect(issuer.tokenRequests).toHaveLength(0);
    await expect(getAuthToken()).resolves.toBeNull();
  });

  it('refuses a callback for a state this page never sent', async () => {
    desktop((_authorize, redirectUri) => `${redirectUri}?code=code-1&state=forged`);
    await expect(signInWithBrowser()).rejects.toMatchObject({ reason: 'failed' });
    expect(issuer.tokenRequests).toHaveLength(0);
    await expect(getAuthToken()).resolves.toBeNull();
  });

  it('refuses an ID token without the nonce it asked for', async () => {
    desktop((authorize, redirectUri) => {
      issuer.nonce = 'someone-elses';
      return backWithCode(authorize, redirectUri) as string;
    });
    await expect(signInWithBrowser()).rejects.toBeInstanceOf(BrowserSignInError);
    await expect(getAuthToken()).resolves.toBeNull();
  });

  it('sends "sign in" from anywhere else to the sign-in screen, never to the provider', async () => {
    const shell = desktop();
    await redirectToSignIn({ returnTo: '/weldknow' });
    expect(assign).toHaveBeenLastCalledWith('/auth/login?callbackUrl=%2Fweldknow');
    await redirectToSignIn({ intent: 'sign-up' });
    expect(assign).toHaveBeenLastCalledWith('/auth/register');
    expect(shell.browserSignIn.start).not.toHaveBeenCalled();
  });

  it('signs out by revoking the refresh token and opening the provider’s sign-out with no token in it', async () => {
    const shell = desktop();
    await signInWithBrowser();
    const { result } = renderHook(() => useAuth());
    await waitFor(() => expect(result.current.isSignedIn).toBe(true));

    await act(() => result.current.signOut({ redirectUrl: '/auth/login' }));

    const revoked = issuer.revocations?.[0];
    expect(revoked?.get('token')).toBe('rt-1');
    expect(revoked?.get('token_type_hint')).toBe('refresh_token');
    expect(revoked?.get('client_id')).toBe('weldsuite-desktop');
    const endSession = new URL(shell.opened[0]);
    expect(endSession.origin + endSession.pathname).toBe(`${ISSUER}/oidc/v1/end_session`);
    expect(endSession.searchParams.get('client_id')).toBe('weldsuite-desktop');
    expect(endSession.searchParams.has('id_token_hint')).toBe(false);
    expect(endSession.searchParams.has('post_logout_redirect_uri')).toBe(false);
    expect(assign).toHaveBeenLastCalledWith(`${ORIGIN}/auth/login`);
    await expect(getAuthToken()).resolves.toBeNull();
  });

  it('is not used in a browser: sign-in there still leaves for the provider', async () => {
    setAuthImplementation(createOidcAuth(CONFIG, { origin: ORIGIN }));
    expect(usesBrowserSignIn()).toBe(false);
    await expect(signInWithBrowser()).rejects.toMatchObject({ reason: 'failed' });
  });
});
