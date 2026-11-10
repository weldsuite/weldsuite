/**
 * Forgotten passwords on an OIDC provider (EU): the screens Global shows,
 * over the backend's `/api/sign-in/password-reset` (mocked at `sign-in-api`).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { en } from '@weldsuite/i18n/locales/en';

const auth = vi.hoisted(() => ({ platform: true, redirectToSignIn: vi.fn() }));
vi.mock('@/lib/auth', () => ({
  usesPlatformSignIn: () => auth.platform,
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
    requestPasswordReset: vi.fn(),
    confirmPasswordReset: vi.fn(),
  };
});
vi.mock('@/lib/auth/oidc/sign-in-api', () => api);

const router = vi.hoisted(() => ({ search: '', push: vi.fn() }));
vi.mock('@/lib/router', () => ({
  useSearchParams: () => new URLSearchParams(router.search),
  useRouter: () => ({ push: router.push, replace: vi.fn() }),
  Link: ({ href, children, ...props }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

import { ProviderForgotPasswordPage } from '../forgot-password/provider-forgot-password';
import { ProviderResetPasswordPage } from './provider-reset-password';

const t = en.common.auth;
const originalLocation = window.location;
let replace: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  auth.platform = true;
  router.search = '';
  api.loadPasswordPolicy.mockResolvedValue({ minLength: 10, uppercase: true, lowercase: true, number: true, symbol: false });
  replace = vi.fn();
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: { ...originalLocation, replace },
  });
});

describe('ProviderForgotPasswordPage', () => {
  it('goes to the provider’s own page where it shows the sign-in screens', async () => {
    auth.platform = false;
    render(<ProviderForgotPasswordPage />);

    await waitFor(() => expect(auth.redirectToSignIn).toHaveBeenCalled());
    expect(screen.queryByRole('heading', { name: t.forgotPassword.title })).not.toBeInTheDocument();
  });

  it('asks for the address and says a code is on its way, whoever has it', async () => {
    const user = userEvent.setup();
    api.requestPasswordReset.mockResolvedValue(undefined);
    render(<ProviderForgotPasswordPage />);

    await user.type(screen.getByLabelText(t.forgotPassword.emailLabel), ' jane@acme.test ');
    await user.click(screen.getByRole('button', { name: t.forgotPassword.sendResetCode }));

    await waitFor(() => expect(api.requestPasswordReset).toHaveBeenCalledWith('jane@acme.test'));
    expect(await screen.findByRole('heading', { name: t.forgotPassword.success.title })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: t.forgotPassword.success.enterResetCode }));
    expect(router.push).toHaveBeenCalledWith('/auth/reset-password?email=jane%40acme.test');
  });

  it('says to wait when a code was asked for too often', async () => {
    const user = userEvent.setup();
    api.requestPasswordReset.mockRejectedValue(new api.SignInError('RATE_LIMITED'));
    render(<ProviderForgotPasswordPage />);

    await user.type(screen.getByLabelText(t.forgotPassword.emailLabel), 'jane@acme.test');
    await user.click(screen.getByRole('button', { name: t.forgotPassword.sendResetCode }));

    expect(await screen.findByText(t.identityProvider.tooManyAttempts)).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: t.forgotPassword.success.title })).not.toBeInTheDocument();
  });
});

describe('ProviderResetPasswordPage', () => {
  it('takes the code from the emailed link and sets the new password, then signs in', async () => {
    const user = userEvent.setup();
    router.search = 'userId=42&code=ABC123';
    api.confirmPasswordReset.mockResolvedValue(undefined);
    render(<ProviderResetPasswordPage />);
    await waitFor(() => expect(api.loadPasswordPolicy).toHaveBeenCalled());

    expect(screen.getByLabelText(t.resetPassword.resetCodeLabel)).toHaveValue('ABC123');
    // The provider's rules: ten characters here, not Global's eight.
    expect(await screen.findByText(t.resetPassword.requirements.atLeastChars.replace('{count}', '10'))).toBeInTheDocument();

    await user.type(screen.getByLabelText(t.resetPassword.newPasswordLabel), 'Changed4567');
    await user.type(screen.getByLabelText(t.resetPassword.confirmPasswordLabel), 'Changed4567');
    await user.click(screen.getByRole('button', { name: t.resetPassword.resetPassword }));

    await waitFor(() =>
      expect(api.confirmPasswordReset).toHaveBeenCalledWith({
        email: undefined,
        userId: '42',
        code: 'ABC123',
        password: 'Changed4567',
      }),
    );
    await waitFor(() => expect(replace).toHaveBeenCalledWith('/auth/login'));
  });

  it('says the code is wrong, and lets the person try again', async () => {
    const user = userEvent.setup();
    router.search = 'email=jane%40acme.test';
    api.confirmPasswordReset.mockRejectedValue(new api.SignInError('INVALID_CODE'));
    render(<ProviderResetPasswordPage />);
    await waitFor(() => expect(api.loadPasswordPolicy).toHaveBeenCalled());

    await user.type(screen.getByLabelText(t.resetPassword.resetCodeLabel), 'wrong1');
    await user.type(screen.getByLabelText(t.resetPassword.newPasswordLabel), 'Changed4567');
    await user.type(screen.getByLabelText(t.resetPassword.confirmPasswordLabel), 'Changed4567');
    await user.click(screen.getByRole('button', { name: t.resetPassword.resetPassword }));

    expect(await screen.findByText(t.resetPassword.invalidCode)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: t.resetPassword.resetPassword })).toBeEnabled();
    expect(replace).not.toHaveBeenCalled();
  });

  it('asks for the address first when nobody is named', async () => {
    render(<ProviderResetPasswordPage />);

    await waitFor(() => expect(replace).toHaveBeenCalledWith('/auth/forgot-password'));
  });
});
