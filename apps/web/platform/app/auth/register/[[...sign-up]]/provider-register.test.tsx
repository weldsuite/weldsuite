/**
 * `/auth/register` on an OIDC provider (EU): the screens Global shows, over
 * the backend's `/api/sign-in` (mocked here at `sign-in-api`).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { en } from '@weldsuite/i18n/locales/en';

const auth = vi.hoisted(() => ({ redirectToSignIn: vi.fn() }));
vi.mock('@/lib/auth', () => ({
  redirectToSignIn: auth.redirectToSignIn,
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
  return {
    SignInError,
    loadPasswordPolicy: vi.fn(),
    signUp: vi.fn(),
    verifyEmailAddress: vi.fn(),
    resendEmailVerification: vi.fn(),
  };
});
vi.mock('@/lib/auth/oidc/sign-in-api', () => api);

const router = vi.hoisted(() => ({ search: '' }));
vi.mock('@/lib/router', () => ({
  useSearchParams: () => new URLSearchParams(router.search),
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  Link: ({ href, children, ...props }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

import { ProviderRegisterPage } from './provider-register';

const t = en.common.auth;
const REQUEST = 'V2_300000000000000100';

// jsdom lays nothing out; the code field (input-otp) asks where its slots are.
document.elementFromPoint = () => null;

const originalLocation = window.location;
let replace: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  router.search = `authRequest=${REQUEST}`;
  // Zitadel's default rules: a symbol on top of Global's four.
  api.loadPasswordPolicy.mockResolvedValue({ minLength: 8, uppercase: true, lowercase: true, number: true, symbol: true });
  window.sessionStorage.clear();
  replace = vi.fn();
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: { ...originalLocation, replace },
  });
});

async function fillIn(user: ReturnType<typeof userEvent.setup>, password: string) {
  await user.type(screen.getByLabelText(t.register.firstNameLabel), 'Jane');
  await user.type(screen.getByLabelText(t.register.lastNameLabel), 'Doe');
  await user.type(screen.getByLabelText(t.register.emailLabel), 'jane@acme.test');
  await user.type(screen.getByLabelText(t.register.passwordLabel), password);
  await user.type(screen.getByLabelText(t.register.confirmPasswordLabel), password);
}

describe('ProviderRegisterPage', () => {
  it('asks the provider for sign-up when no sign-in is in progress', async () => {
    router.search = '';
    render(<ProviderRegisterPage />);

    await waitFor(() => expect(auth.redirectToSignIn).toHaveBeenCalledWith({ intent: 'sign-up', returnTo: '/' }));
    expect(screen.queryByRole('heading', { name: t.register.title })).not.toBeInTheDocument();
  });

  it("shows Global's form, without Google, and links back to this same sign-in", async () => {
    render(<ProviderRegisterPage />);

    expect(screen.getByRole('heading', { name: t.register.title })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: t.register.continueWithGoogle })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: t.register.signIn })).toHaveAttribute(
      'href',
      `/auth/login?authRequest=${REQUEST}&intent=sign-in`,
    );
  });

  it('checks the password against the provider’s rules, not Global’s', async () => {
    const user = userEvent.setup();
    render(<ProviderRegisterPage />);
    await waitFor(() => expect(api.loadPasswordPolicy).toHaveBeenCalled());

    // Fine on Global; the provider also wants a symbol.
    await fillIn(user, 'Secret123');

    expect(await screen.findByText(t.resetPassword.requirements.oneSymbol)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: t.register.createAccount })).toBeDisabled();
    expect(api.signUp).not.toHaveBeenCalled();
  });

  it('creates the account, verifies the address with the emailed code, and signs in', async () => {
    const user = userEvent.setup();
    api.signUp.mockResolvedValue({
      status: 'needs_email_verification',
      email: 'jane@acme.test',
      code: { length: 6, charset: 'alphanumeric' },
    });
    api.verifyEmailAddress.mockResolvedValue({ status: 'complete', redirectUrl: '/auth/sso-callback?code=c' });
    render(<ProviderRegisterPage />);
    await waitFor(() => expect(api.loadPasswordPolicy).toHaveBeenCalled());

    await fillIn(user, 'Secret123!');
    await user.click(screen.getByRole('button', { name: t.register.createAccount }));

    await waitFor(() =>
      expect(api.signUp).toHaveBeenCalledWith(REQUEST, {
        firstName: 'Jane',
        lastName: 'Doe',
        email: 'jane@acme.test',
        password: 'Secret123!',
      }),
    );
    expect(await screen.findByRole('heading', { name: t.register.verify.title })).toBeInTheDocument();

    await user.type(screen.getByRole('textbox'), 'ABC123');

    await waitFor(() => expect(api.verifyEmailAddress).toHaveBeenCalledWith(REQUEST, 'ABC123'));
    await waitFor(() => expect(replace).toHaveBeenCalledWith('/auth/sso-callback?code=c'));
  });

  it('says so when the address already has an account', async () => {
    const user = userEvent.setup();
    api.signUp.mockRejectedValue(new api.SignInError('EMAIL_TAKEN'));
    render(<ProviderRegisterPage />);
    await waitFor(() => expect(api.loadPasswordPolicy).toHaveBeenCalled());

    await fillIn(user, 'Secret123!');
    await user.click(screen.getByRole('button', { name: t.register.createAccount }));

    expect(await screen.findByText(t.identityProvider.emailTaken)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: t.register.createAccount })).toBeEnabled();
  });

  it('sends the code again on request', async () => {
    const user = userEvent.setup();
    api.signUp.mockResolvedValue({
      status: 'needs_email_verification',
      email: 'jane@acme.test',
      code: { length: 6, charset: 'alphanumeric' },
    });
    api.resendEmailVerification.mockResolvedValue(undefined);
    render(<ProviderRegisterPage />);
    await waitFor(() => expect(api.loadPasswordPolicy).toHaveBeenCalled());
    await fillIn(user, 'Secret123!');
    await user.click(screen.getByRole('button', { name: t.register.createAccount }));
    await screen.findByRole('heading', { name: t.register.verify.title });

    await user.click(screen.getByRole('button', { name: new RegExp(t.register.verify.resend) }));

    await waitFor(() => expect(api.resendEmailVerification).toHaveBeenCalledWith(REQUEST));
  });
});
