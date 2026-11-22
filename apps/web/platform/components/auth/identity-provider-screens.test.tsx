/**
 * Settings › Security and `/invite` when the provider owns the account: a
 * customer's own identity provider, or WeldID, WeldSuite's own, which must
 * not be called "your organization's identity provider".
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { en } from '@weldsuite/i18n/locales/en';

const auth = vi.hoisted(() => ({
  weldId: false,
  accountUrl: undefined as string | undefined,
}));
vi.mock('@/lib/auth', () => ({
  getAccountUrl: () => auth.accountUrl,
  isWeldIdProvider: () => auth.weldId,
  completeSignIn: vi.fn(),
  redirectToSignIn: vi.fn(),
  usesBrowserSignIn: () => false,
}));
vi.mock('@/lib/router', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }) }));

import { ManagedByIdentityProvider } from './identity-provider-screens';

const copy = en.common.auth.identityProvider;

beforeEach(() => {
  auth.weldId = false;
  auth.accountUrl = undefined;
});

describe('ManagedByIdentityProvider', () => {
  it('names WeldID, and links to the WeldID account, when WeldID signs people in', () => {
    auth.weldId = true;
    auth.accountUrl = 'https://auth.example.eu/account';
    render(<ManagedByIdentityProvider />);

    expect(screen.getByRole('heading', { name: copy.weldId.managedTitle })).toBeTruthy();
    expect(screen.getByText(copy.weldId.managedDescription)).toBeTruthy();
    expect(screen.queryByText(copy.managedDescription)).toBeNull();
    const link = screen.getByRole('link', { name: copy.weldId.openAccount });
    expect(link.getAttribute('href')).toBe('https://auth.example.eu/account');
  });

  it("names the organization's identity provider on any other OIDC provider", () => {
    auth.accountUrl = 'https://id.example.eu/ui/console/users/me';
    render(<ManagedByIdentityProvider />);

    expect(screen.getByRole('heading', { name: copy.managedTitle })).toBeTruthy();
    expect(screen.getByText(copy.managedDescription)).toBeTruthy();
    expect(screen.getByRole('link', { name: copy.openAccount }).getAttribute('href')).toBe(
      'https://id.example.eu/ui/console/users/me',
    );
  });

  it('shows no link when the deployment names no account page', () => {
    render(<ManagedByIdentityProvider />);
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('calls an invitation link without an invitation incomplete on WeldID, where invitations are WeldSuite\'s', () => {
    auth.weldId = true;
    auth.accountUrl = 'https://auth.example.eu/account';
    render(<ManagedByIdentityProvider topic="invitations" />);

    expect(screen.getByRole('heading', { name: copy.weldId.invitationIncompleteTitle })).toBeTruthy();
    expect(screen.getByText(copy.weldId.invitationIncomplete)).toBeTruthy();
    expect(screen.queryByRole('link')).toBeNull();
  });

  it("leaves invitations to the organization's identity provider elsewhere", () => {
    render(<ManagedByIdentityProvider topic="invitations" />);
    expect(screen.getByText(copy.invitationsManaged)).toBeTruthy();
  });
});
