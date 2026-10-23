import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { en } from '@weldsuite/i18n/locales/en';

const clerk = vi.hoisted(() => ({
  signIn: { authenticateWithRedirect: vi.fn() },
  setActive: vi.fn(),
}));
vi.mock('@clerk/clerk-react', () => ({
  useSignIn: () => ({ isLoaded: true, signIn: clerk.signIn, setActive: clerk.setActive }),
  useAuth: () => ({ isSignedIn: false, orgId: null }),
  useOrganizationList: () => ({ isLoaded: true, userMemberships: { data: [] } }),
}));
vi.mock('@clerk/clerk-react/errors', () => ({
  isClerkAPIResponseError: (err: unknown) => typeof err === 'object' && err !== null && 'errors' in err,
}));

const router = vi.hoisted(() => ({ search: '' }));
vi.mock('@/lib/router', () => ({
  useSearchParams: () => new URLSearchParams(router.search),
  Link: ({ href, children, ...props }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

const desktop = vi.hoisted(() => ({ inShell: false, signInExternally: vi.fn() }));
vi.mock('@/lib/desktop', () => ({
  isDesktop: () => desktop.inShell,
  getDesktop: () => ({ signInExternally: desktop.signInExternally }),
}));

vi.mock('@/lib/passkeys', () => ({
  isPasskeySupported: () => false,
  isPasskeyAutofillSupported: async () => false,
  isPasskeyDismissed: () => false,
}));

import LoginPage from './page';

const t = en.common.auth.login;

beforeEach(() => {
  vi.clearAllMocks();
  router.search = '';
  desktop.inShell = false;
  clerk.signIn.authenticateWithRedirect.mockResolvedValue(undefined);
});

describe('LoginPage single sign-on', () => {
  it('offers SSO next to the other sign-in options and asks for the work email', async () => {
    const user = userEvent.setup();
    render(<LoginPage />);

    await user.type(screen.getByLabelText(t.emailLabel), 'jane@acme.com');
    await user.click(screen.getByRole('button', { name: t.signInWithSso }));

    expect(screen.getByRole('heading', { name: t.sso.title })).toBeInTheDocument();
    // The email typed on the first screen carries over.
    expect(screen.getByLabelText(t.sso.emailLabel)).toHaveValue('jane@acme.com');
  });

  it('sends the work email to Clerk as an enterprise SSO sign-in that returns through the callback page', async () => {
    const user = userEvent.setup();
    router.search = 'callbackUrl=%2Fweldcrm';
    render(<LoginPage />);

    await user.click(screen.getByRole('button', { name: t.signInWithSso }));
    await user.type(screen.getByLabelText(t.sso.emailLabel), ' jane@acme.com ');
    await user.click(screen.getByRole('button', { name: t.sso.continue }));

    await waitFor(() =>
      expect(clerk.signIn.authenticateWithRedirect).toHaveBeenCalledWith({
        strategy: 'enterprise_sso',
        identifier: 'jane@acme.com',
        redirectUrl: '/auth/sso-callback',
        redirectUrlComplete: '/weldcrm',
      }),
    );
  });

  it('opens on the SSO step when the desktop app handed off with provider=sso, and hands the sign-in back to it', async () => {
    const user = userEvent.setup();
    router.search = 'desktop=1&provider=sso&return_to=weldsuite%3A%2F%2Fauth';
    render(<LoginPage />);

    expect(screen.getByRole('heading', { name: t.sso.title })).toBeInTheDocument();
    await user.type(screen.getByLabelText(t.sso.emailLabel), 'jane@acme.com');
    await user.click(screen.getByRole('button', { name: t.sso.continue }));

    await waitFor(() =>
      expect(clerk.signIn.authenticateWithRedirect).toHaveBeenCalledWith({
        strategy: 'enterprise_sso',
        identifier: 'jane@acme.com',
        redirectUrl: '/auth/sso-callback?desktop=1&return_to=weldsuite%3A%2F%2Fauth',
        redirectUrlComplete: `${window.location.origin}/auth/desktop-handoff?return_to=weldsuite%3A%2F%2Fauth`,
      }),
    );
  });

  it('does not skip the first screen for provider=sso without the desktop handoff', () => {
    router.search = 'provider=sso';
    render(<LoginPage />);

    expect(screen.getByRole('heading', { name: t.title })).toBeInTheDocument();
  });

  it('hands off to the system browser from the desktop app, without the email in the URL', async () => {
    const user = userEvent.setup();
    desktop.inShell = true;
    desktop.signInExternally.mockResolvedValue(undefined);
    render(<LoginPage />);

    await user.type(screen.getByLabelText(t.emailLabel), 'jane@acme.com');
    await user.click(screen.getByRole('button', { name: t.signInWithSso }));

    await waitFor(() =>
      expect(desktop.signInExternally).toHaveBeenCalledWith({
        path: '/auth/login?desktop=1&provider=sso&return_to=weldsuite%3A%2F%2Fauth',
        returnTo: 'weldsuite://auth',
      }),
    );
    expect(screen.queryByRole('heading', { name: t.sso.title })).not.toBeInTheDocument();
    expect(clerk.signIn.authenticateWithRedirect).not.toHaveBeenCalled();
  });

  it('says when the system browser could not be opened', async () => {
    const user = userEvent.setup();
    desktop.inShell = true;
    desktop.signInExternally.mockRejectedValue(new Error('no browser'));
    render(<LoginPage />);

    await user.click(screen.getByRole('button', { name: t.signInWithSso }));

    expect(await screen.findByText(t.couldNotOpenBrowser)).toBeInTheDocument();
  });

  it('shows a translated message when Clerk knows no connection for the email domain', async () => {
    const user = userEvent.setup();
    clerk.signIn.authenticateWithRedirect.mockRejectedValue({
      errors: [{ code: 'form_identifier_not_found', message: 'Couldn’t find your account.', longMessage: 'English text from Clerk' }],
    });
    render(<LoginPage />);

    await user.click(screen.getByRole('button', { name: t.signInWithSso }));
    await user.type(screen.getByLabelText(t.sso.emailLabel), 'jane@nowhere.example');
    await user.click(screen.getByRole('button', { name: t.sso.continue }));

    expect(await screen.findByText(t.sso.notAvailable)).toBeInTheDocument();
    expect(screen.queryByText('English text from Clerk')).not.toBeInTheDocument();
    // The person can correct the address and try again.
    expect(screen.getByRole('button', { name: t.sso.continue })).toBeEnabled();
  });

  it('shows a general message when the request never reached Clerk', async () => {
    const user = userEvent.setup();
    clerk.signIn.authenticateWithRedirect.mockRejectedValue(new Error('offline'));
    render(<LoginPage />);

    await user.click(screen.getByRole('button', { name: t.signInWithSso }));
    await user.type(screen.getByLabelText(t.sso.emailLabel), 'jane@acme.com');
    await user.click(screen.getByRole('button', { name: t.sso.continue }));

    expect(await screen.findByText(t.sso.failed)).toBeInTheDocument();
  });

  it('goes back to the sign-in options and clears the error', async () => {
    const user = userEvent.setup();
    clerk.signIn.authenticateWithRedirect.mockRejectedValue(new Error('offline'));
    render(<LoginPage />);

    await user.click(screen.getByRole('button', { name: t.signInWithSso }));
    await user.type(screen.getByLabelText(t.sso.emailLabel), 'jane@acme.com');
    await user.click(screen.getByRole('button', { name: t.sso.continue }));
    await screen.findByText(t.sso.failed);

    await user.click(screen.getByRole('button', { name: t.sso.backToLogin }));

    expect(screen.getByRole('heading', { name: t.title })).toBeInTheDocument();
    expect(screen.queryByText(t.sso.failed)).not.toBeInTheDocument();
  });

  it('says so when the identity provider round trip failed in the callback', () => {
    router.search = 'error=sso_failed';
    render(<LoginPage />);

    expect(screen.getByText(t.signInFailed)).toBeInTheDocument();
  });
});
