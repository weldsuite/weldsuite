import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { startFakeProvider, type FakeProvider } from './testing/fake-oidc-provider';

/** The staff organization's setting, which some tests take away. */
const ORG_SETTING = 'ADMIN_OIDC_ORG_ID';
const staffIdentity = vi.hoisted(() => vi.fn());
vi.mock('./staff-roster', () => ({ staffIdentity }));

import { handleCallback, handleSignIn, sessionCookieOf } from './auth-routes';
import { oidcConfig, readSession } from './oidc';

const STAFF_ORG = 'org-staff';
const person = { sub: '300000000000000042', email: 'ann@weldsuite.test', emailVerified: true, name: 'Ann Staff', org: STAFF_ORG };
const identity = { userId: person.sub, email: person.email, name: person.name, role: 'admin', isSuperAdmin: false };

let provider: FakeProvider;
const env: Record<string, string> = {};

beforeAll(async () => {
  provider = await startFakeProvider({ clientId: 'admin-console', clientSecret: 'client-secret', person });
  Object.assign(env, {
    ADMIN_OIDC_ISSUER: provider.issuer,
    ADMIN_OIDC_CLIENT_ID: 'admin-console',
    ADMIN_OIDC_CLIENT_SECRET: 'client-secret',
    ADMIN_OIDC_ORG_ID: STAFF_ORG,
    ADMIN_PUBLIC_URL: 'https://admin.eu.example',
    ADMIN_SESSION_SECRET: 'x'.repeat(40),
  });
});
afterAll(() => provider.close());
beforeEach(() => {
  Object.assign(process.env, env);
  provider.person = person;
  staffIdentity.mockReset();
});
afterEach(() => {
  for (const name of Object.keys(env)) delete process.env[name];
  vi.restoreAllMocks();
});

/** Through the provider and back: the callback's response. */
async function signIn(): Promise<Response> {
  const start = await handleSignIn(new Request('https://admin.eu.example/auth/sign-in?redirect_url=/staff'));
  const flow = start.headers.getSetCookie()[0]!.split(';')[0]!;
  const callback = provider.authorize(start.headers.get('location')!);
  return handleCallback(new Request(callback, { headers: { cookie: flow } }));
}

describe('handleCallback', () => {
  it("checks the staff account against the roster with the staff organization, and seals its organization", async () => {
    staffIdentity.mockResolvedValue(identity);
    const response = await signIn();
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('/staff');
    expect(staffIdentity).toHaveBeenCalledWith(expect.objectContaining({ sub: person.sub, org: STAFF_ORG }), {
      staffOrgId: STAFF_ORG,
      signingIn: true,
    });
    const cookie = response.headers.getSetCookie().map((header) => header.split(';')[0]!).join('; ');
    const session = await readSession(oidcConfig(), sessionCookieOf(new Request('https://admin.eu.example/', { headers: { cookie } })));
    expect(session?.org).toBe(STAFF_ORG);
  });

  it('says when someone signed in with an account outside the staff organization', async () => {
    provider.person = { ...person, org: 'org-platform' };
    staffIdentity.mockResolvedValue(null);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const response = await signIn();
    // A session all the same: they get the "no access" page and its sign-out button.
    expect(response.headers.get('location')).toBe('/staff');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('outside the staff organization'), person.sub);
  });

  it('says when a staff account is not on the roster', async () => {
    staffIdentity.mockResolvedValue(null);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await signIn();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('not on the staff roster'), person.sub);
  });
});

describe('handleSignIn', () => {
  it('answers 503, naming what is missing, until a required setting is configured', async () => {
    delete process.env.ADMIN_OIDC_ISSUER;
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const response = await handleSignIn(new Request('https://admin.eu.example/auth/sign-in'));
    expect(response.status).toBe(503);
    expect(await response.text()).toContain('ADMIN_OIDC_ISSUER is not set');
  });

  it('signs in without a staff organization configured (WeldID, SEC-019), asking no resource-owner scope', async () => {
    delete process.env[ORG_SETTING];
    const response = await handleSignIn(new Request('https://admin.eu.example/auth/sign-in'));
    expect(response.status).toBe(302);
    const location = new URL(response.headers.get('location')!);
    expect(location.searchParams.get('scope')).toBe('openid email profile');
  });
});
