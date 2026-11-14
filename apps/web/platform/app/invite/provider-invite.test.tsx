/**
 * Invitations on an OIDC provider (EU): Global's invite screens over the
 * backend's `/api/sign-in/invitation/accept` (mocked at `sign-in-api`),
 * instead of the provider's own page.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { en } from '@weldsuite/i18n/locales/en';

const auth = vi.hoisted(() => ({
  platform: true,
  redirectToSignIn: vi.fn(),
  state: { isLoaded: true, isSignedIn: false as boolean },
}));
vi.mock('@/lib/auth', () => ({
  usesPlatformSignIn: () => auth.platform,
  redirectToSignIn: auth.redirectToSignIn,
  useAuth: () => auth.state,
  completeSignIn: vi.fn(),
  getAccountUrl: () => undefined,
}));

const api = vi.hoisted(() => {
  class SignInError extends Error {
    code: string;
    constructor(code: string) {
      super(code);
      this.code = code;
    }
  }
  return { SignInError, loadPasswordPolicy: vi.fn(), acceptInvitation: vi.fn() };
});
vi.mock('@/lib/auth/oidc/sign-in-api', () => api);

const membership = vi.hoisted(() => ({ accept: vi.fn() }));
vi.mock('@/hooks/queries/use-settings-queries', () => ({
  useAcceptInvitation: () => ({ mutateAsync: membership.accept }),
}));

const router = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock('@/lib/router', () => ({ useRouter: () => ({ push: router.push, replace: vi.fn() }) }));

import { ProviderInviteClient } from './provider-invite';

const t = en.common;
const originalLocation = window.location;
let replace: ReturnType<typeof vi.fn>;

function at(search: string) {
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: { ...originalLocation, search, replace },
  });
}

const link = { userId: '500', code: 'XY7Q2K', orgId: 'org_1', email: 'ann@acme.test', isAuthenticated: false };

async function choosePassword(password: string) {
  const user = userEvent.setup();
  await user.type(screen.getByLabelText(t.invite.passwordLabel), password);
  await user.type(screen.getByLabelText(t.invite.confirmPasswordLabel), password);
  await user.click(screen.getByRole('button', { name: t.invite.joinWorkspace }));
}

beforeEach(() => {
  vi.clearAllMocks();
  auth.platform = true;
  auth.state = { isLoaded: true, isSignedIn: false };
  api.loadPasswordPolicy.mockResolvedValue({ minLength: 10, uppercase: true, lowercase: true, number: true, symbol: false });
  membership.accept.mockResolvedValue({ workspaceId: 'org_1', workspaceName: 'Acme', role: 'MEMBER' });
  replace = vi.fn();
  at('?org_id=org_1&userId=500&code=XY7Q2K&email=ann%40acme.test');
  window.sessionStorage.clear();
});

describe('ProviderInviteClient', () => {
  it('leaves membership to the provider where it shows its own sign-in pages', () => {
    auth.platform = false;
    render(<ProviderInviteClient {...link} />);

    expect(screen.getByText(t.auth.identityProvider.invitationsManaged)).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: t.invite.completeYourAccount })).not.toBeInTheDocument();
  });

  it('sets the first password on Global’s screen, then signs in and comes back to join', async () => {
    api.acceptInvitation.mockResolvedValue({ email: 'ann@acme.test', signedIn: true });
    render(<ProviderInviteClient {...link} />);

    expect(screen.getByRole('heading', { name: t.invite.completeYourAccount })).toBeInTheDocument();
    expect(screen.getByText('ann@acme.test')).toBeInTheDocument();
    // The provider's rules: ten characters here, not Global's eight.
    expect(
      await screen.findByText(t.auth.resetPassword.requirements.atLeastChars.replace('{count}', '10')),
    ).toBeInTheDocument();

    await choosePassword('Welcome1234');

    await waitFor(() =>
      expect(api.acceptInvitation).toHaveBeenCalledWith({ userId: '500', code: 'XY7Q2K', password: 'Welcome1234' }),
    );
    expect(await screen.findByRole('heading', { name: t.invite.welcomeTitle })).toBeInTheDocument();
    await waitFor(
      () => expect(auth.redirectToSignIn).toHaveBeenCalledWith({ returnTo: '/invite?joined=500&org_id=org_1' }),
      { timeout: 2000 },
    );
  });

  it('says an expired or wrong code has expired, and a used link was accepted', async () => {
    api.acceptInvitation.mockRejectedValueOnce(new api.SignInError('INVALID_CODE'));
    const { unmount } = render(<ProviderInviteClient {...link} />);
    await choosePassword('Welcome1234');
    expect(await screen.findByRole('heading', { name: t.invite.invitationExpiredTitle })).toBeInTheDocument();
    unmount();

    api.acceptInvitation.mockRejectedValueOnce(new api.SignInError('INVITATION_ACCEPTED'));
    render(<ProviderInviteClient {...link} />);
    await choosePassword('Welcome1234');
    expect(
      await screen.findByRole('heading', { name: t.invite.invitationAlreadyAcceptedTitle }),
    ).toBeInTheDocument();
    expect(auth.redirectToSignIn).not.toHaveBeenCalled();
  });

  it('keeps the form with the reason when the provider refuses the password', async () => {
    api.acceptInvitation.mockRejectedValue(new api.SignInError('WEAK_PASSWORD'));
    render(<ProviderInviteClient {...link} />);
    await waitFor(() => expect(api.loadPasswordPolicy).toHaveBeenCalled());

    await choosePassword('Welcome1234');

    expect(await screen.findByText(t.auth.register.passwordDoesNotMeetRequirements)).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: t.invite.completeYourAccount })).toBeInTheDocument();
  });

  it('back from the sign-in, links the invited member and opens the workspace', async () => {
    auth.state = { isLoaded: true, isSignedIn: true };
    at('?joined=500&org_id=org_1');
    render(<ProviderInviteClient orgId="org_1" isAuthenticated />);

    await waitFor(() => expect(membership.accept).toHaveBeenCalledWith('500'));
    await waitFor(() => expect(replace).toHaveBeenCalledWith('/w/org_1/'));
    expect(window.sessionStorage.getItem('weldsuite:pending-org')).toBe('org_1');
  });

  it('opens the workspace even when linking the member fails: the identity sync catches up', async () => {
    auth.state = { isLoaded: true, isSignedIn: true };
    membership.accept.mockRejectedValue(new Error('offline'));
    at('?joined=500&org_id=org_1');
    render(<ProviderInviteClient orgId="org_1" isAuthenticated />);

    await waitFor(() => expect(replace).toHaveBeenCalledWith('/w/org_1/'));
  });
});
