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
  signOut: vi.fn(),
  state: { isLoaded: true, isSignedIn: false as boolean },
}));
vi.mock('@/lib/auth', () => ({
  usesPlatformSignIn: () => auth.platform,
  redirectToSignIn: auth.redirectToSignIn,
  useAuth: () => ({ ...auth.state, signOut: auth.signOut }),
  useUser: () => ({ user: { primaryEmailAddress: { emailAddress: 'bob@acme.test' } } }),
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

import { ApiError } from '@weldsuite/api-client';
import { ProviderInviteClient, keptRefusal } from './provider-invite';

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

/** The server's refusal of an acceptance, as the API client throws it. */
function refused(status: number, reason?: string) {
  return new ApiError('refused', status, { error: { code: 'X', message: 'refused', details: reason ? { reason } : undefined } });
}

describe('ProviderInviteClient: an invitation WeldSuite keeps (WeldID)', () => {
  const kept = { invitationId: 'inv_abc', orgId: 'org_1', orgName: 'Acme', email: 'ann@acme.test', isAuthenticated: false };
  const search = '?org_id=org_1&invitation_id=inv_abc&email=ann%40acme.test&org_name=Acme';

  beforeEach(() => {
    // WeldID shows its own sign-in pages: the platform's are off.
    auth.platform = false;
    at(search);
  });

  it('sends a signed-out invitee to sign in, and back to this link', async () => {
    render(<ProviderInviteClient {...kept} />);

    await waitFor(() =>
      expect(auth.redirectToSignIn).toHaveBeenCalledWith({ returnTo: `${window.location.pathname}${search}` }),
    );
    expect(membership.accept).not.toHaveBeenCalled();
  });

  it('accepts as the signed-in invitee and opens the workspace', async () => {
    auth.state = { isLoaded: true, isSignedIn: true };
    render(<ProviderInviteClient {...kept} isAuthenticated />);

    await waitFor(() => expect(membership.accept).toHaveBeenCalledWith('inv_abc'));
    await waitFor(() => expect(replace).toHaveBeenCalledWith('/w/org_1/'));
    expect(window.sessionStorage.getItem('weldsuite:pending-org')).toBe('org_1');
    expect(auth.redirectToSignIn).not.toHaveBeenCalled();
  });

  it('offers to sign out when the invitation is for another address', async () => {
    auth.state = { isLoaded: true, isSignedIn: true };
    membership.accept.mockRejectedValue(refused(403, 'invitation_email_mismatch'));
    render(<ProviderInviteClient {...kept} isAuthenticated />);

    expect(await screen.findByRole('heading', { name: t.invite.wrongAccountTitle })).toBeInTheDocument();
    expect(screen.getByText('bob@acme.test')).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole('button', { name: t.invite.signOutAndUseOtherAccount }));
    expect(auth.signOut).toHaveBeenCalledWith({ redirectUrl: window.location.href });
    expect(replace).not.toHaveBeenCalled();
  });

  it('says an expired invitation expired, a used one was accepted, and an unverified address to verify', async () => {
    auth.state = { isLoaded: true, isSignedIn: true };
    membership.accept.mockRejectedValueOnce(refused(410));
    const first = render(<ProviderInviteClient {...kept} isAuthenticated />);
    expect(await screen.findByRole('heading', { name: t.invite.invitationExpiredTitle })).toBeInTheDocument();
    first.unmount();

    membership.accept.mockRejectedValueOnce(refused(404));
    const second = render(<ProviderInviteClient {...kept} isAuthenticated />);
    expect(
      await screen.findByRole('heading', { name: t.invite.invitationAlreadyAcceptedTitle }),
    ).toBeInTheDocument();
    second.unmount();

    membership.accept.mockRejectedValueOnce(refused(403, 'invitation_email_unverified'));
    render(<ProviderInviteClient {...kept} isAuthenticated />);
    expect(await screen.findByText(t.invite.errors.verifyEmailFirst)).toBeInTheDocument();
    expect(replace).not.toHaveBeenCalled();
  });
});

describe('keptRefusal', () => {
  it('reads the status and the reason the server gave', () => {
    expect(keptRefusal(refused(410))).toBe('expired');
    expect(keptRefusal(refused(404))).toBe('used');
    expect(keptRefusal(refused(403, 'invitation_email_mismatch'))).toBe('wrong_account');
    expect(keptRefusal(refused(403, 'invitation_email_unverified'))).toBe('unverified');
    expect(keptRefusal(refused(403))).toBe('failed');
    expect(keptRefusal(refused(500))).toBe('failed');
    expect(keptRefusal(new Error('offline'))).toBe('failed');
  });
});
