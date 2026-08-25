import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('@clerk/clerk-react', () => ({
  useSignUp: () => ({
    isLoaded: true,
    signUp: { create: vi.fn(), prepareEmailAddressVerification: vi.fn() },
    setActive: vi.fn(),
  }),
  useAuth: () => ({ isSignedIn: false }),
}));

vi.mock('@/lib/router', () => ({
  useSearchParams: () => new URLSearchParams(),
  Link: ({ href, children, ...props }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

vi.mock('@/lib/i18n', () => ({
  getTranslations: () => ({
    auth: {
      register: {
        title: 'Create an account',
        titleWithInvite: 'Set your password',
        subtitle: 'Get started with WeldSuite today.',
        subtitleWithInvite: 'Create a password to access your workspace invitation',
        firstNameLabel: 'First name',
        firstNamePlaceholder: 'John',
        lastNameLabel: 'Last name',
        lastNamePlaceholder: 'Doe',
        emailLabel: 'Email',
        emailPlaceholder: 'john@company.com',
        passwordLabel: 'Password',
        passwordPlaceholder: 'Create a password',
        confirmPasswordLabel: 'Confirm password',
        confirmPasswordPlaceholder: 'Confirm your password',
        passwordsDoNotMatch: 'Passwords do not match',
        passwordDoesNotMeetRequirements: 'Password does not meet requirements',
        continueWithGoogle: 'Continue with Google',
        googleSignUpFailed: 'Google sign up failed',
        orDivider: 'or',
        createAccount: 'Create Account',
        creatingAccount: 'Creating account...',
        alreadyHaveAccount: 'Already have an account?',
        signIn: 'Sign in',
        emailAssociatedWithInvitation: 'This email is associated with your invitation',
        registrationFailed: 'Registration failed',
        verify: {
          title: 'Verify your email',
          subtitle: "We've sent a verification code to {email}",
          backToRegistration: 'Back to registration',
          verificationCodeLabel: 'Verification code',
          verifying: 'Verifying...',
          verifyEmail: 'Verify email',
          didNotReceive: "Didn't receive a code?",
          resend: 'Resend',
          verificationFailed: 'Verification failed',
          invalidVerificationCode: 'Invalid verification code',
          failedToResend: 'Failed to resend',
        },
      },
      resetPassword: {
        requirements: {
          atLeast8Chars: 'At least 8 characters',
          oneUppercase: 'One uppercase letter',
          oneLowercase: 'One lowercase letter',
          oneNumber: 'One number',
        },
      },
    },
  }),
}));

import RegisterPage from './page';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('RegisterPage password requirements', () => {
  it('shows password requirement checklist and keeps Create Account disabled without uppercase', async () => {
    const user = userEvent.setup();
    render(<RegisterPage />);

    expect(screen.getByTestId('password-requirements')).toBeInTheDocument();
    expect(screen.getByText('One uppercase letter')).toBeInTheDocument();

    await user.type(screen.getByLabelText('First name'), 'Karthik');
    await user.type(screen.getByLabelText('Last name'), 'Veeradhi');
    await user.type(screen.getByLabelText('Email'), 'user@example.com');
    // Matches the reported bug: meets length/lowercase/number but no uppercase
    await user.type(screen.getByLabelText('Password'), 'karthik@117jagadeesh');
    await user.type(screen.getByLabelText('Confirm password'), 'karthik@117jagadeesh');

    const createAccountBtn = screen.getByRole('button', { name: 'Create Account' });
    expect(createAccountBtn).toBeDisabled();
  });

  it('enables Create Account when password meets all requirements and matches confirm', async () => {
    const user = userEvent.setup();
    render(<RegisterPage />);

    await user.type(screen.getByLabelText('First name'), 'Karthik');
    await user.type(screen.getByLabelText('Last name'), 'Veeradhi');
    await user.type(screen.getByLabelText('Email'), 'user@example.com');
    await user.type(screen.getByLabelText('Password'), 'Karthik@117');
    await user.type(screen.getByLabelText('Confirm password'), 'Karthik@117');

    const createAccountBtn = screen.getByRole('button', { name: 'Create Account' });
    expect(createAccountBtn).toBeEnabled();
  });
});
