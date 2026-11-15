import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  FLOW_COOKIE,
  OidcConfigError,
  claimedOrg,
  finishSignIn,
  oidcConfig,
  readSession,
  safeReturnTo,
  sessionCookie,
  signOutLocation,
  startSignIn,
  type OidcConfig,
} from './oidc';
import { readCookie, seal } from './sealed-cookie';
import { startFakeProvider, type FakeProvider } from './testing/fake-oidc-provider';

const person = { sub: '300000000000000042', email: 'Ann@WeldSuite.test', emailVerified: true, name: 'Ann Staff', org: 'org-staff' };

let provider: FakeProvider;
let config: OidcConfig;

beforeAll(async () => {
  provider = await startFakeProvider({ clientId: 'admin-console', clientSecret: 'client-secret', person });
  config = oidcConfig({
    ADMIN_OIDC_ISSUER: provider.issuer,
    ADMIN_OIDC_CLIENT_ID: 'admin-console',
    ADMIN_OIDC_CLIENT_SECRET: 'client-secret',
    ADMIN_OIDC_ORG_ID: 'org-staff',
    ADMIN_PUBLIC_URL: 'https://admin.eu.example',
    ADMIN_SESSION_SECRET: 'x'.repeat(40),
  });
});
afterAll(() => provider.close());
beforeEach(() => {
  provider.person = person;
  provider.faults = {};
});

/** The flow cookie's value from its Set-Cookie header. */
const flowValue = (setCookie: string) => readCookie(setCookie.split(';')[0]!, FLOW_COOKIE);

async function signIn(returnTo: string | null = '/workspaces') {
  const start = await startSignIn(config, returnTo);
  return { start, callback: new URL(provider.authorize(start.location)), flow: flowValue(start.cookie) };
}

describe('startSignIn', () => {
  it('sends the person to the provider with PKCE, a state and a nonce', async () => {
    const { location, cookie } = await startSignIn(config, '/workspaces');
    const url = new URL(location);
    expect(url.origin + url.pathname).toBe(`${provider.issuer}/authorize`);
    expect(url.searchParams.get('client_id')).toBe('admin-console');
    expect(url.searchParams.get('redirect_uri')).toBe('https://admin.eu.example/auth/callback');
    expect(url.searchParams.get('scope')).toBe(
      'openid email profile urn:zitadel:iam:user:resourceowner urn:zitadel:iam:org:id:org-staff',
    );
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('code_challenge')).toMatch(/^[\w-]{43}$/);
    expect(url.searchParams.get('state')).toBeTruthy();
    expect(url.searchParams.get('nonce')).toBeTruthy();
    expect(cookie).toMatch(/^__Host-admin_oidc=[\w-]+; Path=\/; Max-Age=600; HttpOnly; Secure; SameSite=Lax$/);
  });
});

describe('finishSignIn', () => {
  it('returns who signed in and their organization, with the email lowercased', async () => {
    const { callback, flow } = await signIn();
    await expect(finishSignIn(config, callback, flow)).resolves.toEqual({
      session: { sub: person.sub, email: 'ann@weldsuite.test', emailVerified: true, name: 'Ann Staff', org: 'org-staff' },
      returnTo: '/workspaces',
    });
  });

  it('names no organization when the provider gives none', async () => {
    provider.person = { ...person, org: undefined };
    const { callback, flow } = await signIn();
    const { session } = await finishSignIn(config, callback, flow);
    expect(session.org).toBeNull();
  });

  it("reads another organization's account as such", async () => {
    provider.person = { ...person, org: 'org-platform' };
    const { callback, flow } = await signIn();
    const { session } = await finishSignIn(config, callback, flow);
    expect(session.org).toBe('org-platform');
  });

  it('keeps an unverified email marked as such', async () => {
    provider.person = { ...person, emailVerified: false };
    const { callback, flow } = await signIn();
    const { session } = await finishSignIn(config, callback, flow);
    expect(session.emailVerified).toBe(false);
  });

  it('refuses a callback without the flow cookie', async () => {
    const { callback } = await signIn();
    await expect(finishSignIn(config, callback, undefined)).rejects.toThrow(/No sign-in in progress/);
  });

  it('refuses a callback whose state is not the flow cookie\'s', async () => {
    const { callback, flow } = await signIn();
    callback.searchParams.set('state', 'forged');
    await expect(finishSignIn(config, callback, flow)).rejects.toThrow(/unexpected "state"/);
  });

  it("refuses another sign-in's callback (state and PKCE verifier don't match)", async () => {
    const first = await signIn();
    const second = await signIn();
    await expect(finishSignIn(config, first.callback, second.flow)).rejects.toThrow(/unexpected "state"/);
  });

  it('refuses an ID token with another nonce', async () => {
    const { callback, flow } = await signIn();
    provider.faults.nonce = 'replayed';
    await expect(finishSignIn(config, callback, flow)).rejects.toThrow(/"nonce" claim/);
  });

  it('refuses userinfo about someone else', async () => {
    const { callback, flow } = await signIn();
    provider.faults.userinfoSub = 'someone-else';
    await expect(finishSignIn(config, callback, flow)).rejects.toThrow(/"sub" property/);
  });

  it('refuses a code used twice', async () => {
    const { callback, flow } = await signIn();
    await finishSignIn(config, callback, flow);
    await expect(finishSignIn(config, callback, flow)).rejects.toThrow(/error in the response body/);
  });

  it('refuses a code redeemed with another PKCE verifier', async () => {
    const { start, callback } = await signIn();
    const state = callback.searchParams.get('state')!;
    const nonce = new URL(start.location).searchParams.get('nonce')!;
    const forged = await seal(config.sessionSecret, FLOW_COOKIE, { state, nonce, verifier: 'v'.repeat(43), returnTo: '/' }, 60);
    await expect(finishSignIn(config, callback, forged)).rejects.toThrow(/error in the response body/);
  });
});

describe('the session cookie', () => {
  it('opens to the session it was made from', async () => {
    const session = { sub: 's', email: 'a@b.c', emailVerified: true, name: null, org: 'org-staff' };
    const header = await sessionCookie(config, session);
    expect(header).toMatch(/^__Host-admin_session=[\w-]+; Path=\/; Max-Age=28800; HttpOnly; Secure; SameSite=Lax$/);
    await expect(readSession(config, readCookie(header.split(';')[0]!, '__Host-admin_session'))).resolves.toEqual(session);
  });
});

describe('signOutLocation', () => {
  it("ends the provider's session and comes back to the console", async () => {
    const url = new URL(await signOutLocation(config));
    expect(url.origin + url.pathname).toBe(`${provider.issuer}/end_session`);
    expect(url.searchParams.get('post_logout_redirect_uri')).toBe('https://admin.eu.example/sign-in?signed_out=1');
  });
});

describe('safeReturnTo', () => {
  it('keeps paths on this console', () => {
    expect(safeReturnTo('/workspaces/ws_1?tab=members#x')).toBe('/workspaces/ws_1?tab=members#x');
    expect(safeReturnTo('/')).toBe('/');
  });

  it('never sends anyone to another site or back into the sign-in', () => {
    for (const value of [null, '', 'https://evil.example', '//evil.example', '/\\evil.example', 'javascript:alert(1)', '/auth/sign-in']) {
      expect(safeReturnTo(value)).toBe('/');
    }
  });

  it('checks the path after dot segments collapse, not only as given', () => {
    for (const value of ['/.//evil.example', '/a/..//evil.example', '/..//evil.example', '/./\\evil.example', '/x/../auth/callback']) {
      expect(safeReturnTo(value)).toBe('/');
    }
    expect(safeReturnTo('/a/../workspaces')).toBe('/workspaces');
  });
});

describe('oidcConfig', () => {
  it('names everything that is missing, and never a value', () => {
    expect(() => oidcConfig({ ADMIN_SESSION_SECRET: 'short-secret-value' })).toThrow(OidcConfigError);
    try {
      oidcConfig({ ADMIN_OIDC_ISSUER: 'not a url', ADMIN_SESSION_SECRET: 'short-secret-value' });
    } catch (error) {
      const message = (error as Error).message;
      for (const name of [
        'ADMIN_OIDC_ISSUER is not a URL',
        'ADMIN_PUBLIC_URL',
        'ADMIN_OIDC_CLIENT_ID',
        'ADMIN_OIDC_CLIENT_SECRET',
        'ADMIN_OIDC_ORG_ID',
        'shorter than 32',
      ]) {
        expect(message).toContain(name);
      }
      expect(message).not.toContain('short-secret-value');
    }
  });
});

describe('claimedOrg', () => {
  it('takes the first non-empty string', () => {
    expect(claimedOrg(undefined, ' org-staff ')).toBe('org-staff');
    expect(claimedOrg('org-a', 'org-b')).toBe('org-a');
  });

  it('names nothing for anything else', () => {
    expect(claimedOrg()).toBeNull();
    expect(claimedOrg('', '  ', null, 42, ['org-staff'], { id: 'org-staff' })).toBeNull();
  });
});
