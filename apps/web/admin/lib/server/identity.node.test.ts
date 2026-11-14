import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** The staff organization's setting, which some tests take away. */
const ORG_SETTING = 'ADMIN_OIDC_ORG_ID';
const request = vi.hoisted(() => ({ current: new Request('https://admin.eu.example/') }));
vi.mock('@tanstack/react-start/server', () => ({ getRequest: () => request.current }));
const staffIdentity = vi.hoisted(() => vi.fn());
vi.mock('./staff-roster', () => ({ staffIdentity }));

import { currentAdminIdentity, isSignedIn } from './identity.node';
import { oidcConfig, sessionCookie, type StaffSession } from './oidc';

const env = {
  ADMIN_OIDC_ISSUER: 'https://auth.eu.example',
  ADMIN_OIDC_CLIENT_ID: 'admin-console',
  ADMIN_OIDC_CLIENT_SECRET: 'client-secret',
  ADMIN_OIDC_ORG_ID: 'org-staff',
  ADMIN_PUBLIC_URL: 'https://admin.eu.example',
  ADMIN_SESSION_SECRET: 'x'.repeat(40),
};
const session: StaffSession = { sub: 'sub-ann-staff', email: 'ann@weldsuite.test', emailVerified: true, name: 'Ann', org: 'org-staff' };

/** A request carrying the session cookie a sign-in leaves. */
async function signedInRequest(): Promise<Request> {
  const header = await sessionCookie(oidcConfig(), session);
  return new Request('https://admin.eu.example/', { headers: { cookie: header.split(';')[0]! } });
}

beforeEach(() => {
  Object.assign(process.env, env);
  staffIdentity.mockReset();
  request.current = new Request('https://admin.eu.example/');
});
afterEach(() => {
  for (const name of Object.keys(env)) delete process.env[name];
});

describe('currentAdminIdentity (Kubernetes)', () => {
  it('asks the roster about the session, with the staff organization', async () => {
    const identity = { userId: session.sub, email: session.email, name: 'Ann', role: 'admin', isSuperAdmin: false };
    staffIdentity.mockResolvedValue(identity);
    request.current = await signedInRequest();
    await expect(currentAdminIdentity()).resolves.toBe(identity);
    expect(staffIdentity).toHaveBeenCalledWith(session, { staffOrgId: 'org-staff' });
    await expect(isSignedIn()).resolves.toBe(true);
  });

  it('is nobody without a session cookie', async () => {
    await expect(currentAdminIdentity()).resolves.toBeNull();
    await expect(isSignedIn()).resolves.toBe(false);
    expect(staffIdentity).not.toHaveBeenCalled();
  });

  it('is nobody while sign-in is not configured', async () => {
    request.current = await signedInRequest();
    delete process.env[ORG_SETTING];
    await expect(currentAdminIdentity()).resolves.toBeNull();
    expect(staffIdentity).not.toHaveBeenCalled();
  });
});
