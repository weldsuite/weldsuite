import { render, renderHook, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const clerk = vi.hoisted(() => ({
  auth: { isLoaded: true, isSignedIn: true, userId: 'user_1', orgId: 'org_1', orgSlug: 'acme' },
  user: { isLoaded: true, isSignedIn: true, user: { id: 'user_1' } },
  organization: { isLoaded: true, organization: { id: 'org_1' } },
  list: { isLoaded: true, setActive: vi.fn(), userMemberships: { data: [] } },
}));

vi.mock('@clerk/clerk-react', () => ({
  useAuth: () => clerk.auth,
  useUser: () => clerk.user,
  useOrganization: () => clerk.organization,
  useOrganizationList: () => clerk.list,
}));

import { ClerkOnly, getAuthProvider, getAuthToken, useAuth, useOrganization, useOrganizationList, useUser } from './index';

afterEach(() => {
  delete (window as { Clerk?: unknown }).Clerk;
});

describe('auth facade on Clerk (Global)', () => {
  it('is the default provider', () => {
    expect(getAuthProvider()).toBe('clerk');
  });

  it("hands Clerk's own hook results through untouched", () => {
    const { result } = renderHook(() => ({
      auth: useAuth(),
      user: useUser(),
      organization: useOrganization(),
      list: useOrganizationList({ userMemberships: true }),
    }));
    expect(result.current.auth).toBe(clerk.auth);
    expect(result.current.user).toBe(clerk.user);
    expect(result.current.organization).toBe(clerk.organization);
    expect(result.current.list).toBe(clerk.list);
  });

  it('renders Clerk-only screens', () => {
    render(<ClerkOnly fallback={<p>fallback</p>}><p>clerk screen</p></ClerkOnly>);
    expect(screen.getByText('clerk screen')).toBeInTheDocument();
    expect(screen.queryByText('fallback')).toBeNull();
  });

  it('reads the token off window.Clerk for code outside React', async () => {
    await expect(getAuthToken()).resolves.toBeNull();
    (window as { Clerk?: unknown }).Clerk = { loaded: true, session: { getToken: async () => 'jwt-1' } };
    await expect(getAuthToken()).resolves.toBe('jwt-1');
  });

  it('waits for Clerk to load when asked to', async () => {
    const pending = getAuthToken({ waitForLoad: true });
    (window as { Clerk?: unknown }).Clerk = { loaded: true, session: { getToken: async () => 'jwt-2' } };
    await expect(pending).resolves.toBe('jwt-2');
  });
});
