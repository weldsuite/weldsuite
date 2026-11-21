
import { useState, useEffect } from 'react';
import { useAuth, ClerkOnly } from '@/lib/auth';
import { useSignUp } from '@/lib/auth/clerk';
import { useSearchParams } from '@/lib/router';
import { getClerkErrorMessage } from '../../utils';
import { getTranslations } from '@/lib/i18n';
import { useOpenAIPixel } from '@/hooks/use-openai-pixel';
import { markSignupIntent, measureRegistrationCompleted } from '@/lib/openai-ads';
import { meetsPasswordPolicy } from '../../components/password-requirements';
import { RegisterFormView, RegisterVerifyView } from '../../components/register-views';
import { ProviderRegisterPage } from './provider-register';

type RegisterStep = 'form' | 'verify';

function ClerkRegisterPage() {
  const t = getTranslations('common');
  const searchParams = useSearchParams();
  const prefillEmail = searchParams.get('email');
  const prefillName = searchParams.get('name');

  // Parse name into first/last name if provided
  const [prefillFirstName, prefillLastName] = prefillName
    ? prefillName.split(' ', 2)
    : ['', ''];

  const { signUp, setActive, isLoaded } = useSignUp();
  const { isSignedIn } = useAuth();

  // Loaded on mount rather than at conversion time so the SDK has arrived
  // before the redirect to /onboarding takes the page away.
  useOpenAIPixel();

  const [step, setStep] = useState<RegisterStep>('form');
  const [isVerifying, setIsVerifying] = useState(false);

  // Redirect if already signed in (but not if we're in the middle of verification)
  useEffect(() => {
    if (isSignedIn && step === 'form' && !isVerifying) {
      // User came to register page while already signed in
      window.location.href = '/onboarding';
    }
  }, [isSignedIn, step, isVerifying]);
  const [firstName, setFirstName] = useState(prefillFirstName || '');
  const [lastName, setLastName] = useState(prefillLastName || '');
  const [email, setEmail] = useState(prefillEmail || '');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [verificationCode, setVerificationCode] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [isGoogleLoading, setIsGoogleLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleGoogleSignUp = async () => {
    if (!isLoaded || !signUp) {
      return;
    }

    setError(null);
    setIsGoogleLoading(true);

    // Clerk sends sign-in and sign-up through the same callback, so record that
    // this leg started from the register page.
    markSignupIntent();

    try {
      await signUp.authenticateWithRedirect({
        strategy: 'oauth_google',
        redirectUrl: '/auth/sso-callback',
        redirectUrlComplete: '/onboarding',
        // Force Google's account chooser so users can pick which Google
        // account to sign up with instead of Google auto-selecting one.
        oidcPrompt: 'select_account',
      });
    } catch (err) {
      const errorMessage = getClerkErrorMessage(err, t.auth.register.googleSignUpFailed);
      setError(errorMessage);
      setIsGoogleLoading(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!isLoaded || !signUp) {
      return;
    }

    if (!meetsPasswordPolicy(password)) {
      setError(t.auth.register.passwordDoesNotMeetRequirements);
      return;
    }

    if (password !== confirmPassword) {
      setError(t.auth.register.passwordsDoNotMatch);
      return;
    }

    setError(null);
    setIsLoading(true);

    try {
      await signUp.create({
        emailAddress: email,
        password,
        firstName: firstName || undefined,
        lastName: lastName || undefined,
      });

      // Send email verification code
      await signUp.prepareEmailAddressVerification({ strategy: 'email_code' });

      setStep('verify');
      setIsLoading(false);
    } catch (err) {
      const errorMessage = getClerkErrorMessage(err, t.auth.register.registrationFailed);
      setError(errorMessage);
      setIsLoading(false);
    }
  };

  const handleVerification = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!isLoaded || !signUp) {
      return;
    }

    setError(null);
    setIsLoading(true);

    try {
      const result = await signUp.attemptEmailAddressVerification({
        code: verificationCode,
      });

      if (result.status === 'complete') {
        // The account exists from here on — this is the conversion ChatGPT Ads
        // optimises against. Measured before the redirect, which the SDK's
        // pagehide flush covers.
        measureRegistrationCompleted(result.createdUserId ?? '');

        // Set flag to prevent useEffect redirect race condition
        setIsVerifying(true);
        await setActive({ session: result.createdSessionId });
        // Wait for session to be fully established before redirecting
        await new Promise(resolve => setTimeout(resolve, 1000));
        // Use window.location for full page navigation to ensure session cookies are set
        // Redirect to onboarding to create first organization
        window.location.href = '/onboarding';
      } else {
        setError(t.auth.register.verificationFailed);
        setIsLoading(false);
      }
    } catch (err) {
      const errorMessage = getClerkErrorMessage(err, t.auth.register.invalidVerificationCode);
      setError(errorMessage);
      setIsLoading(false);
    }
  };

  const handleResendCode = async () => {
    if (!isLoaded || !signUp) {
      return;
    }

    setError(null);
    setIsLoading(true);

    try {
      await signUp.prepareEmailAddressVerification({ strategy: 'email_code' });
      setIsLoading(false);
    } catch (err) {
      const errorMessage = getClerkErrorMessage(err, t.auth.register.failedToResend);
      setError(errorMessage);
      setIsLoading(false);
    }
  };

  useEffect(() => {
    if (step === 'verify') {
      setTimeout(() => {
        const input = document.querySelector<HTMLInputElement>('[data-input-otp]');
        input?.focus();
        input?.click();
      }, 300);
    }
  }, [step]);

  // Verification step
  if (step === 'verify') {
    return (
      <RegisterVerifyView
        email={email}
        code={verificationCode}
        error={error}
        isLoading={isLoading}
        isLoaded={isLoaded}
        onCodeChange={setVerificationCode}
        onSubmit={handleVerification}
        onResend={handleResendCode}
        onBack={() => {
          setStep('form');
          setVerificationCode('');
          setError(null);
        }}
      />
    );
  }

  // Registration form
  return (
    <RegisterFormView
      invited={!!prefillEmail}
      firstName={firstName}
      lastName={lastName}
      email={email}
      password={password}
      confirmPassword={confirmPassword}
      error={error}
      isLoading={isLoading}
      isLoaded={isLoaded}
      google={{ isLoading: isGoogleLoading, onClick: () => void handleGoogleSignUp() }}
      signInHref="/auth/login"
      onFirstNameChange={setFirstName}
      onLastNameChange={setLastName}
      onEmailChange={setEmail}
      onPasswordChange={setPassword}
      onConfirmPasswordChange={setConfirmPassword}
      onSubmit={handleSubmit}
    />
  );
}

/**
 * Clerk's own screen (Global). On another provider (OIDC): WeldSuite's same
 * screens over the provider's sign-up, or its hosted page (`provider-register`).
 */
export default function RegisterPage() {
  return (
    <ClerkOnly fallback={<ProviderRegisterPage />}>
      <ClerkRegisterPage />
    </ClerkOnly>
  );
}
