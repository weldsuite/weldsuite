/**
 * `/auth/login` on an OIDC provider (EU): the screens Global shows, over the
 * backend's `/api/sign-in` (mocked here at `sign-in-api`).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { en } from '@weldsuite/i18n/locales/en';

const auth = vi.hoisted(() => ({
  state: { isLoaded: true, isSignedIn: false },
  redirectToSignIn: vi.fn(),
}));
vi.mock('@/lib/auth', () => ({
  useAuth: () => auth.state,
  redirectToSignIn: auth.redirectToSignIn,
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
    loadSignInRequest: vi.fn(),
    signInWithPassword: vi.fn(),
    sendSecondFactorCode: vi.fn(),
    verifySecondFactor: vi.fn(),
    verifyEmailAddress: vi.fn(),
    verifyEmailFromLink: vi.fn(),
    resendEmailVerification: vi.fn(),
  };
});
vi.mock('@/lib/auth/oidc/sign-in-api', () => api);

const router = vi.hoisted(() => ({ search: '' }));
vi.mock('@/lib/router', () => ({
  useSearchParams: () => new URLSearchParams(router.search),
  Link: ({ href, children, ...props }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

import { ProviderLoginPage } from './provider-login';

const t = en.common.auth;
const REQUEST = 'V2_300000000000000100';
const CREDENTIALS = {
  status: 'needs_credentials',
  intent: 'sign-in',
  loginHint: null,
  allowRegister: true,
  allowPasswordReset: true,
} as const;

// jsdom lays nothing out; the code field (input-otp) asks where its slots are.
document.elementFromPoint = () => null;

const originalLocation = window.location;
let replace: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  router.search = `authRequest=${REQUEST}`;
  auth.state = { isLoaded: true, isSignedIn: false };
  api.loadSignInRequest.mockResolvedValue(CREDENTIALS);
  window.sessionStorage.clear();
  replace = vi.fn();
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: { ...originalLocation, replace },
  });
});

async function signIn(user: ReturnType<typeof userEvent.setup>, email = 'jane@acme.test', password = 'Secret123') {
  await user.type(await screen.findByLabelText(t.login.emailLabel), email);
  await user.type(screen.getByLabelText(t.login.passwordLabel), password);
  await user.click(screen.getByRole('button', { name: t.login.signIn }));
}

describe('starting a sign-in', () => {
  it('goes to the provider, to come back where the visitor was headed', async () => {
    router.search = 'callbackUrl=%2Fweldcrm';
    render(<ProviderLoginPage />);

    await waitFor(() => expect(auth.redirectToSignIn).toHaveBeenCalledWith({ returnTo: '/weldcrm' }));
    expect(api.loadSignInRequest).not.toHaveBeenCalled();
  });

  it('never returns to another origin', async () => {
    router.search = 'callbackUrl=%2F%2Fevil.example';
    render(<ProviderLoginPage />);

    await waitFor(() => expect(auth.redirectToSignIn).toHaveBeenCalledWith({ returnTo: '/' }));
  });

  it('sends someone who is signed in already straight on', async () => {
    router.search = 'callbackUrl=%2Fweldcrm';
    auth.state = { isLoaded: true, isSignedIn: true };
    render(<ProviderLoginPage />);

    await waitFor(() => expect(replace).toHaveBeenCalledWith('/weldcrm'));
    expect(auth.redirectToSignIn).not.toHaveBeenCalled();
  });

  it('verifies the address from the emailed link, then signs in', async () => {
    router.search = 'verifyUser=42&verifyCode=ABC123';
    api.verifyEmailFromLink.mockRejectedValue(new api.SignInError('INVALID_CODE'));
    render(<ProviderLoginPage />);

    await waitFor(() => expect(api.verifyEmailFromLink).toHaveBeenCalledWith('42', 'ABC123'));
    // A code that no longer works does not stop the sign-in.
    await waitFor(() => expect(auth.redirectToSignIn).toHaveBeenCalledWith({ returnTo: '/' }));
  });
});

describe('the sign-in screen', () => {
  it("is Global's, without the sign-in methods the provider does not offer here", async () => {
    render(<ProviderLoginPage />);

    expect(await screen.findByRole('heading', { name: t.login.title })).toBeInTheDocument();
    expect(api.loadSignInRequest).toHaveBeenCalledWith(REQUEST);
    expect(screen.queryByRole('button', { name: t.login.continueWithGoogle })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: t.login.signInWithPasskey })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: t.login.signInWithSso })).not.toBeInTheDocument();
    expect(screen.queryByText(t.login.orDivider)).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: t.login.forgotPassword })).toHaveAttribute('href', '/auth/forgot-password');
    // Signing up finishes this same sign-in.
    expect(screen.getByRole('link', { name: t.login.signUp })).toHaveAttribute(
      'href',
      `/auth/register?authRequest=${REQUEST}`,
    );
  });

  it('hides sign-up and password reset where the provider has them closed', async () => {
    api.loadSignInRequest.mockResolvedValue({ ...CREDENTIALS, allowRegister: false, allowPasswordReset: false });
    render(<ProviderLoginPage />);

    await screen.findByRole('heading', { name: t.login.title });
    expect(screen.queryByRole('link', { name: t.login.signUp })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: t.login.forgotPassword })).not.toBeInTheDocument();
  });

  it('fills in the address the sign-in was started for', async () => {
    api.loadSignInRequest.mockResolvedValue({ ...CREDENTIALS, loginHint: 'jane@acme.test' });
    render(<ProviderLoginPage />);

    expect(await screen.findByLabelText(t.login.emailLabel)).toHaveValue('jane@acme.test');
  });

  it('signs in with the password and continues on the provider callback', async () => {
    const user = userEvent.setup();
    api.signInWithPassword.mockResolvedValue({
      status: 'complete',
      redirectUrl: 'https://app.test/auth/sso-callback?code=c&state=s',
    });
    render(<ProviderLoginPage />);

    await signIn(user, ' jane@acme.test ');

    await waitFor(() => expect(api.signInWithPassword).toHaveBeenCalledWith(REQUEST, 'jane@acme.test', 'Secret123'));
    await waitFor(() => expect(replace).toHaveBeenCalledWith('https://app.test/auth/sso-callback?code=c&state=s'));
  });

  it('says so in the visitor’s language when the password is wrong', async () => {
    const user = userEvent.setup();
    api.signInWithPassword.mockRejectedValue(new api.SignInError('INVALID_CREDENTIALS'));
    render(<ProviderLoginPage />);

    await signIn(user);

    expect(await screen.findByText(t.login.invalidEmailOrPassword)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: t.login.signIn })).toBeEnabled();
    expect(replace).not.toHaveBeenCalled();
  });

  it('says to wait when there were too many attempts', async () => {
    const user = userEvent.setup();
    api.signInWithPassword.mockRejectedValue(new api.SignInError('RATE_LIMITED'));
    render(<ProviderLoginPage />);

    await signIn(user);

    expect(await screen.findByText(t.identityProvider.tooManyAttempts)).toBeInTheDocument();
  });
});

describe('a session the browser already has', () => {
  it('continues without a form (switching workspace)', async () => {
    api.loadSignInRequest.mockResolvedValue({ status: 'complete', redirectUrl: 'https://app.test/auth/sso-callback?code=c' });
    render(<ProviderLoginPage />);

    await waitFor(() => expect(replace).toHaveBeenCalledWith('https://app.test/auth/sso-callback?code=c'));
    expect(screen.queryByRole('heading', { name: t.login.title })).not.toBeInTheDocument();
  });
});

describe('the second factor', () => {
  it('asks for the authenticator code after the password', async () => {
    const user = userEvent.setup();
    api.signInWithPassword.mockResolvedValue({
      status: 'needs_second_factor',
      factors: ['totp', 'email_code'],
      email: 'jane@acme.test',
      emailCode: { length: 8, charset: 'digits' },
    });
    api.verifySecondFactor.mockResolvedValue({ status: 'complete', redirectUrl: '/auth/sso-callback?code=c' });
    render(<ProviderLoginPage />);
    await signIn(user);

    expect(await screen.findByRole('heading', { name: t.login.twoFactor.title })).toBeInTheDocument();
    // The provider has no backup codes.
    expect(screen.queryByRole('button', { name: t.login.twoFactor.useBackupCodeInstead })).not.toBeInTheDocument();
    expect(api.sendSecondFactorCode).not.toHaveBeenCalled();

    await user.type(screen.getByLabelText(t.login.twoFactor.verificationCodeLabel), '654321');
    await user.click(screen.getByRole('button', { name: t.login.twoFactor.verify }));

    await waitFor(() => expect(api.verifySecondFactor).toHaveBeenCalledWith(REQUEST, 'totp', '654321'));
    await waitFor(() => expect(replace).toHaveBeenCalledWith('/auth/sso-callback?code=c'));
  });

  it('takes the emailed code, as long as the provider writes it, and sends another on request', async () => {
    const user = userEvent.setup();
    api.signInWithPassword.mockResolvedValue({
      status: 'needs_second_factor',
      factors: ['email_code'],
      email: 'jane@acme.test',
      emailCode: { length: 8, charset: 'digits' },
    });
    api.sendSecondFactorCode.mockResolvedValue(undefined);
    api.verifySecondFactor.mockRejectedValueOnce(new api.SignInError('INVALID_CODE'));
    render(<ProviderLoginPage />);
    await signIn(user);

    expect(await screen.findByRole('heading', { name: t.login.emailVerify.title })).toBeInTheDocument();
    expect(screen.getByText('jane@acme.test')).toBeInTheDocument();
    // The backend emailed the code with its answer; the screen sends none itself.
    expect(api.sendSecondFactorCode).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: new RegExp(t.login.emailVerify.resend) }));
    await waitFor(() => expect(api.sendSecondFactorCode).toHaveBeenCalledWith(REQUEST));

    // Eight digits, not Clerk's six: the last one submits.
    await user.type(screen.getByRole('textbox'), '12345678');
    await waitFor(() => expect(api.verifySecondFactor).toHaveBeenCalledWith(REQUEST, 'email_code', '12345678'));
    expect(await screen.findByText(t.login.emailVerify.invalidCode)).toBeInTheDocument();
  });

  it('goes back to the form when the provider session behind the code is gone', async () => {
    const user = userEvent.setup();
    api.signInWithPassword.mockResolvedValue({
      status: 'needs_second_factor',
      factors: ['totp'],
      email: 'jane@acme.test',
      emailCode: { length: 8, charset: 'digits' },
    });
    api.verifySecondFactor.mockRejectedValue(new api.SignInError('NO_SESSION'));
    render(<ProviderLoginPage />);
    await signIn(user);

    await user.type(await screen.findByLabelText(t.login.twoFactor.verificationCodeLabel), '654321');
    await user.click(screen.getByRole('button', { name: t.login.twoFactor.verify }));

    expect(await screen.findByRole('heading', { name: t.login.title })).toBeInTheDocument();
    expect(screen.getByText(t.login.signInFailed)).toBeInTheDocument();
  });
});

describe('what the screens hand on', () => {
  it('verifies an unverified address before signing in', async () => {
    const user = userEvent.setup();
    api.signInWithPassword.mockResolvedValue({
      status: 'needs_email_verification',
      email: 'jane@acme.test',
      code: { length: 6, charset: 'alphanumeric' },
    });
    api.verifyEmailAddress.mockResolvedValue({ status: 'complete', redirectUrl: '/auth/sso-callback?code=c' });
    render(<ProviderLoginPage />);
    await signIn(user);

    expect(await screen.findByRole('heading', { name: t.login.emailVerify.title })).toBeInTheDocument();
    // Letters as well as digits.
    await user.type(screen.getByRole('textbox'), 'ABC123');

    await waitFor(() => expect(api.verifyEmailAddress).toHaveBeenCalledWith(REQUEST, 'ABC123'));
    await waitFor(() => expect(replace).toHaveBeenCalledWith('/auth/sso-callback?code=c'));
  });

  it('opens the sign-up form when the sign-in was started for sign-up', async () => {
    api.loadSignInRequest.mockResolvedValue({ ...CREDENTIALS, intent: 'sign-up' });
    render(<ProviderLoginPage />);

    await waitFor(() => expect(replace).toHaveBeenCalledWith(`/auth/register?authRequest=${REQUEST}`));
  });

  it('stays on sign-in for someone who came back from the sign-up form', async () => {
    router.search = `authRequest=${REQUEST}&intent=sign-in`;
    api.loadSignInRequest.mockResolvedValue({ ...CREDENTIALS, intent: 'sign-up' });
    render(<ProviderLoginPage />);

    expect(await screen.findByRole('heading', { name: t.login.title })).toBeInTheDocument();
    expect(replace).not.toHaveBeenCalled();
  });

  it('goes to the provider’s own page for what these screens do not do', async () => {
    const user = userEvent.setup();
    api.signInWithPassword.mockResolvedValue({
      status: 'hosted',
      url: `https://id.test/ui/v2/login/login?authRequest=${REQUEST}`,
    });
    render(<ProviderLoginPage />);
    await signIn(user);

    await waitFor(() =>
      expect(replace).toHaveBeenCalledWith(`https://id.test/ui/v2/login/login?authRequest=${REQUEST}`),
    );
  });

  it('starts again once when the provider no longer knows the sign-in, then says it failed', async () => {
    api.loadSignInRequest.mockResolvedValue({ status: 'expired' });
    const first = render(<ProviderLoginPage />);
    await waitFor(() => expect(auth.redirectToSignIn).toHaveBeenCalledTimes(1));
    first.unmount();

    // Back with a request the provider refuses too: no loop.
    render(<ProviderLoginPage />);
    expect(await screen.findByText(t.identityProvider.failed)).toBeInTheDocument();
    expect(auth.redirectToSignIn).toHaveBeenCalledTimes(1);
  });

  it('says sign-in failed when the backend cannot be reached', async () => {
    api.loadSignInRequest.mockRejectedValue(new api.SignInError('UNAVAILABLE'));
    render(<ProviderLoginPage />);

    expect(await screen.findByText(t.identityProvider.failed)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: t.identityProvider.retry })).toBeInTheDocument();
  });
});
