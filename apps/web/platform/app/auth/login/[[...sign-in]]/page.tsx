
import { useState, useEffect, useMemo, useRef } from 'react';
import { useAuth, useOrganizationList, ClerkOnly } from '@/lib/auth';
import { useSignIn, isClerkAPIResponseError } from '@/lib/auth/clerk';
import { useSearchParams } from '@/lib/router';
import { isDesktop, getDesktop } from '@/lib/desktop';
import { getSafeCallbackUrl, getClerkErrorMessage } from '../../utils';
import { isPasskeySupported, isPasskeyAutofillSupported, isPasskeyDismissed } from '@/lib/passkeys';
import { getTranslations } from '@/lib/i18n';
import { EmailCodeStep, LoginCredentialsView, SsoStep, TwoFactorStep } from '../../components/login-views';
import { ProviderLoginPage } from './provider-login';

type LoginStep = 'credentials' | 'two-factor' | 'email-verify' | 'first-factor-verify' | 'sso';

type SignInResource = NonNullable<ReturnType<typeof useSignIn>['signIn']>;

/**
 * Picks the second-factor step to show. TOTP wins over email code; for an email
 * code the code is sent first. Returns null when no supported factor exists.
 */
async function resolveSecondFactorStep(
  signIn: SignInResource,
  secondFactors: SignInResource['supportedSecondFactors'],
): Promise<LoginStep | null> {
  if (secondFactors?.some((f) => f.strategy === 'totp')) {
    // TOTP authenticator app
    return 'two-factor';
  }
  if (secondFactors?.some((f) => f.strategy === 'email_code')) {
    // Email verification needed
    await signIn.prepareSecondFactor({ strategy: 'email_code' });
    return 'email-verify';
  }
  return null;
}

/**
 * Sends the first-factor email code when the factor is offered.
 * Returns false when no email-code factor is supported.
 */
async function prepareEmailCodeFirstFactor(
  signIn: SignInResource,
  firstFactors: SignInResource['supportedFirstFactors'],
): Promise<boolean> {
  const emailFactor = firstFactors?.find((f) => f.strategy === 'email_code');
  if (!emailFactor) return false;
  if ('emailAddressId' in emailFactor) {
    await signIn.prepareFirstFactor({
      strategy: 'email_code',
      emailAddressId: emailFactor.emailAddressId,
    });
  }
  return true;
}

function ClerkLoginPage() {
  const t = getTranslations('common');
  const searchParams = useSearchParams();
  // Use sanitized callback URL to prevent redirect loops to auth pages
  const callbackUrl = useMemo(() => getSafeCallbackUrl(searchParams), [searchParams]);
  const prefillEmail = searchParams.get('email');

  // Desktop handoff — when the Electron shell opened this page in the system
  // browser it passes ?desktop=1&return_to=weldsuite://auth. After sign-in
  // succeeds we redirect to /auth/desktop-handoff instead of the dashboard,
  // so the handoff page can mint a ticket and deep-link back to the shell.
  const isDesktopHandoff = searchParams.get('desktop') === '1';
  const desktopReturnTo = searchParams.get('return_to') ?? 'weldsuite://auth';
  // After sign-in send the user to their dashboard (the safe callback URL),
  // NOT the /onboarding wizard. The app shell already redirects genuinely
  // org-less users to /onboarding and waits for org activation for users who
  // do have a workspace — so routing existing users here never flashes the
  // "Create New Database" wizard, which used to happen when this fallback
  // raced ahead of Clerk's organization list loading.
  const postSignInUrl = useMemo(() => {
    if (!isDesktopHandoff) return callbackUrl;
    const url = new URL('/auth/desktop-handoff', window.location.origin);
    url.searchParams.set('return_to', desktopReturnTo);
    return url.toString();
  }, [isDesktopHandoff, desktopReturnTo, callbackUrl]);

  const { signIn, setActive, isLoaded } = useSignIn();
  const { isSignedIn, orgId } = useAuth();
  const { isLoaded: orgsLoaded, userMemberships } = useOrganizationList({
    userMemberships: true,
  });

  // The system browser the desktop app opened for "Sign in with SSO" goes
  // straight to the SSO step (like `provider=google` auto-starts Google).
  const [step, setStep] = useState<LoginStep>(() =>
    isDesktopHandoff && searchParams.get('provider') === 'sso' && !isDesktop() ? 'sso' : 'credentials',
  );
  const [email, setEmail] = useState(prefillEmail || '');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [twoFactorCode, setTwoFactorCode] = useState('');
  const [firstFactorCode, setFirstFactorCode] = useState('');
  const [useBackupCode, setUseBackupCode] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [isGoogleLoading, setIsGoogleLoading] = useState(false);
  const [isPasskeyLoading, setIsPasskeyLoading] = useState(false);
  const [isSsoLoading, setIsSsoLoading] = useState(false);
  // Inside the Electron shell the passkey button hands off to the system
  // browser (like Google), so it is shown there even without WebAuthn.
  const [showPasskeyButton] = useState(() => isDesktop() || isPasskeySupported());
  // The SSO callback sends a failed identity-provider round trip back here.
  const [error, setError] = useState<string | null>(() =>
    searchParams.get('error') === 'sso_failed' ? t.auth.login.signInFailed : null,
  );

  // Where Clerk returns after an identity provider (Google or SSO), carrying
  // the desktop handoff along.
  const providerRedirectUrl = isDesktopHandoff
    ? `/auth/sso-callback?desktop=1&return_to=${encodeURIComponent(desktopReturnTo)}`
    : '/auth/sso-callback';

  // Redirect if already signed in
  useEffect(() => {
    if (!isSignedIn || !orgsLoaded) return;

    // Check if user has any organizations
    const hasOrgs = userMemberships?.data && userMemberships.data.length > 0;

    if (isDesktopHandoff) {
      window.location.href = postSignInUrl;
    } else if (hasOrgs || orgId) {
      // User has a workspace, go straight to their dashboard
      window.location.href = callbackUrl;
    } else {
      // No workspace yet — the dashboard shell will forward genuinely
      // org-less users on to /onboarding.
      window.location.href = postSignInUrl;
    }
  }, [isSignedIn, orgsLoaded, userMemberships, orgId, callbackUrl, isDesktopHandoff, postSignInUrl]);

  const handleGoogleSignIn = async () => {
    if (!isLoaded || !signIn) {
      return;
    }

    setError(null);
    setIsGoogleLoading(true);

    // In the Electron shell: Google blocks OAuth inside embedded webviews.
    // Bounce the entire sign-in flow to the system browser; the browser then
    // auto-triggers Google OAuth, and the handoff page deep-links a Clerk
    // sign-in ticket back to the desktop app.
    if (isDesktop()) {
      try {
        const returnTo = 'weldsuite://auth';
        await getDesktop()?.signInExternally({
          path: `/auth/login?desktop=1&provider=google&return_to=${encodeURIComponent(returnTo)}`,
          returnTo,
        });
      } catch {
        setError(t.auth.login.couldNotOpenBrowser);
        setIsGoogleLoading(false);
      }
      // Intentionally leave the loading state on — user's focus is now in
      // their browser; the desktop window will receive `weldsuite://auth`.
      return;
    }

    try {
      await signIn.authenticateWithRedirect({
        strategy: 'oauth_google',
        redirectUrl: providerRedirectUrl,
        redirectUrlComplete: postSignInUrl,
        // Force Google's account chooser every time. Without this Google
        // silently reuses the single active session, so users with multiple
        // Google accounts can never switch which one they sign in with.
        oidcPrompt: 'select_account',
      });
    } catch (err) {
      const errorMessage = getClerkErrorMessage(err, t.auth.login.googleSignInFailed);
      setError(errorMessage);
      setIsGoogleLoading(false);
    }
  };

  // Auto-trigger Google OAuth when the browser was opened via the desktop
  // handoff with `?provider=google`. Runs once, after Clerk's signIn is ready.
  const autoGoogleRef = useRef(false);
  useEffect(() => {
    if (autoGoogleRef.current) return;
    if (!isLoaded || !signIn) return;
    if (isDesktop()) return;
    if (searchParams.get('provider') !== 'google') return;
    if (!isDesktopHandoff) return;

    autoGoogleRef.current = true;
    void handleGoogleSignIn();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLoaded, signIn, isDesktopHandoff]);

  // "Sign in with SSO": ask for the work email in the browser. Inside the
  // Electron shell hand off to the system browser instead (company identity
  // providers do not work in an embedded webview), which opens the SSO step
  // itself (`provider=sso`); the handoff page deep-links a Clerk sign-in
  // ticket back to the desktop app, as for Google. The email is typed in the
  // browser, never carried in the URL.
  const handleSsoClick = async () => {
    setError(null);

    if (isDesktop()) {
      setIsSsoLoading(true);
      try {
        const returnTo = 'weldsuite://auth';
        await getDesktop()?.signInExternally({
          path: `/auth/login?desktop=1&provider=sso&return_to=${encodeURIComponent(returnTo)}`,
          returnTo,
        });
      } catch {
        setError(t.auth.login.couldNotOpenBrowser);
        setIsSsoLoading(false);
      }
      // Intentionally leave the loading state on — the user's focus is now in
      // their browser; the desktop window will receive `weldsuite://auth`.
      return;
    }

    setStep('sso');
  };

  const handleSsoSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    const identifier = email.trim();
    if (!isLoaded || !signIn || !identifier) {
      return;
    }

    setError(null);
    setIsSsoLoading(true);

    try {
      // Clerk looks up the enterprise connection of the email's domain and
      // redirects to its identity provider; the callback page finishes sign-in.
      await signIn.authenticateWithRedirect({
        strategy: 'enterprise_sso',
        identifier,
        redirectUrl: providerRedirectUrl,
        redirectUrlComplete: postSignInUrl,
      });
    } catch (err) {
      // Clerk refuses an email whose domain has no (active) connection. Its own
      // wording is English, so the person gets a translated message instead.
      setError(isClerkAPIResponseError(err) ? t.auth.login.sso.notAvailable : t.auth.login.sso.failed);
      setIsSsoLoading(false);
    }
  };

  // Shared by the passkey button and the autofill (conditional UI) flow.
  // A passkey normally satisfies MFA on its own, but fall through to the
  // second-factor step if the instance still asks for one.
  const handlePasskeyResult = async (result: SignInResource) => {
    if (!isLoaded || !signIn) return;
    if (result.status === 'complete') {
      await setActive({ session: result.createdSessionId });
      // Land on the dashboard; the shell forwards org-less users to /onboarding.
      setTimeout(() => {
        window.location.href = postSignInUrl;
      }, 500);
      return;
    }
    if (result.status === 'needs_second_factor') {
      const nextStep = await resolveSecondFactorStep(signIn, result.supportedSecondFactors);
      if (nextStep) {
        setStep(nextStep);
        return;
      }
    }
    setError(t.auth.login.passkeySignInFailed);
  };

  const handlePasskeySignIn = async () => {
    if (!isLoaded || !signIn) {
      return;
    }

    setError(null);

    // In the Electron shell WebAuthn is unreliable (no platform authenticator
    // on every OS), so sign in through the system browser and come back via
    // the desktop handoff, exactly like Google.
    if (isDesktop()) {
      setIsPasskeyLoading(true);
      try {
        const returnTo = 'weldsuite://auth';
        await getDesktop()?.signInExternally({
          path: `/auth/login?desktop=1&return_to=${encodeURIComponent(returnTo)}`,
          returnTo,
        });
      } catch {
        setError(t.auth.login.couldNotOpenBrowser);
        setIsPasskeyLoading(false);
      }
      return;
    }

    setIsPasskeyLoading(true);
    try {
      const result = await signIn.authenticateWithPasskey({ flow: 'discoverable' });
      await handlePasskeyResult(result);
      if (result.status !== 'complete') setIsPasskeyLoading(false);
    } catch (err) {
      if (!isPasskeyDismissed(err)) {
        setError(getClerkErrorMessage(err, t.auth.login.passkeySignInFailed));
      }
      setIsPasskeyLoading(false);
    }
  };

  // Passkey autofill: offer the user's passkeys in the email field's
  // autocomplete dropdown (WebAuthn conditional mediation). The request stays
  // pending until a passkey is picked; Clerk aborts it when another WebAuthn
  // request starts (the passkey button), which is ignored as a dismissal.
  // Errors here are never shown: the request starts unprompted on page load,
  // so a failure (e.g. passkeys not enabled on the Clerk instance) must not
  // put an error banner in front of every visitor. The button reports them.
  const passkeyAutofillRef = useRef(false);
  useEffect(() => {
    if (passkeyAutofillRef.current) return;
    if (!isLoaded || !signIn) return;
    if (isDesktop() || prefillEmail) return;

    passkeyAutofillRef.current = true;
    void (async () => {
      if (!(await isPasskeyAutofillSupported())) return;
      try {
        const result = await signIn.authenticateWithPasskey({ flow: 'autofill' });
        setIsPasskeyLoading(true);
        await handlePasskeyResult(result);
        if (result.status !== 'complete') setIsPasskeyLoading(false);
      } catch {
        setIsPasskeyLoading(false);
      }
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps -- start the pending autofill request once, when Clerk is ready.
  }, [isLoaded, signIn]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!isLoaded || !signIn) {
      return;
    }

    setError(null);
    setIsLoading(true);

    try {
      const result = await signIn.create({
        identifier: email,
        password,
      });

      if (result.status === 'complete') {
        await setActive({ session: result.createdSessionId });
        // The useEffect will handle redirect after checking org membership.
        // Small delay to let Clerk hooks update; the fallback lands the user
        // on their dashboard (org-less users are forwarded to /onboarding by
        // the shell) rather than flashing the create-workspace wizard.
        setTimeout(() => {
          window.location.href = postSignInUrl;
        }, 500);
      } else if (result.status === 'needs_second_factor') {
        // Check what type of second factor is needed
        const nextStep = await resolveSecondFactorStep(signIn, result.supportedSecondFactors);
        if (nextStep) {
          setStep(nextStep);
        } else {
          // Unknown second factor type
          setError(t.auth.login.additionalVerificationRequired);
        }
        setIsLoading(false);
      } else if (result.status === 'needs_first_factor') {
        // Handle first factor verification (e.g., email verification for existing accounts)
        // Email verification required when an email-code factor is offered
        if (await prepareEmailCodeFirstFactor(signIn, result.supportedFirstFactors)) {
          setStep('first-factor-verify');
        } else {
          // Unknown first factor type
          setError(t.auth.login.additionalVerificationContact);
        }
        setIsLoading(false);
      } else {
        setError(t.auth.login.signInFailed);
        setIsLoading(false);
      }
    } catch (err) {
      const errorMessage = getClerkErrorMessage(err, t.auth.login.invalidEmailOrPassword);
      setError(errorMessage);
      setIsLoading(false);
    }
  };

  const handleTwoFactorSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!isLoaded || !signIn) {
      return;
    }

    setError(null);
    setIsLoading(true);

    try {
      const result = await signIn.attemptSecondFactor({
        strategy: useBackupCode ? 'backup_code' : 'totp',
        code: twoFactorCode,
      });

      if (result.status === 'complete') {
        await setActive({ session: result.createdSessionId });
        // Land on the dashboard; the shell forwards org-less users to /onboarding.
        setTimeout(() => {
          window.location.href = postSignInUrl;
        }, 500);
      } else {
        setError(t.auth.login.twoFactor.verificationFailed);
        setIsLoading(false);
      }
    } catch (err) {
      const errorMessage = getClerkErrorMessage(err, t.auth.login.twoFactor.invalidCode);
      setError(errorMessage);
      setIsLoading(false);
    }
  };

  const handleEmailVerifySubmit = async (code: string) => {
    if (!isLoaded || !signIn) {
      return;
    }

    setError(null);
    setIsLoading(true);

    try {
      const result = await signIn.attemptSecondFactor({
        strategy: 'email_code',
        code,
      });

      if (result.status === 'complete') {
        await setActive({ session: result.createdSessionId });
        // Land on the dashboard; the shell forwards org-less users to /onboarding.
        setTimeout(() => {
          window.location.href = postSignInUrl;
        }, 500);
      } else {
        setError(t.auth.login.emailVerify.verificationFailed);
        setIsLoading(false);
      }
    } catch (err) {
      const errorMessage = getClerkErrorMessage(err, t.auth.login.emailVerify.invalidCode);
      setError(errorMessage);
      setIsLoading(false);
    }
  };

  const handleResendEmailCode = async () => {
    if (!isLoaded || !signIn) {
      return;
    }

    setError(null);
    setIsLoading(true);

    try {
      await signIn.prepareSecondFactor({ strategy: 'email_code' });
      setIsLoading(false);
    } catch (err) {
      const errorMessage = getClerkErrorMessage(err, t.auth.login.emailVerify.failedToResend);
      setError(errorMessage);
      setIsLoading(false);
    }
  };

  const handleFirstFactorVerifySubmit = async (code: string) => {
    if (!isLoaded || !signIn) {
      return;
    }

    setError(null);
    setIsLoading(true);

    try {
      const result = await signIn.attemptFirstFactor({
        strategy: 'email_code',
        code,
      });

      if (result.status === 'complete') {
        await setActive({ session: result.createdSessionId });
        setTimeout(() => {
          window.location.href = postSignInUrl;
        }, 500);
      } else if (result.status === 'needs_second_factor') {
        // User also has 2FA enabled
        const nextStep = await resolveSecondFactorStep(signIn, result.supportedSecondFactors);
        if (nextStep) setStep(nextStep);
        setIsLoading(false);
      } else {
        setError(t.auth.login.emailVerify.verificationFailed);
        setIsLoading(false);
      }
    } catch (err) {
      const errorMessage = getClerkErrorMessage(err, t.auth.login.emailVerify.invalidCode);
      setError(errorMessage);
      setIsLoading(false);
    }
  };

  const handleResendFirstFactorCode = async () => {
    if (!isLoaded || !signIn) {
      return;
    }

    setError(null);
    setIsLoading(true);

    try {
      await prepareEmailCodeFirstFactor(signIn, signIn.supportedFirstFactors);
      setIsLoading(false);
    } catch (err) {
      const errorMessage = getClerkErrorMessage(err, t.auth.login.twoFactor.failedToResend);
      setError(errorMessage);
      setIsLoading(false);
    }
  };

  // Single sign-on step
  if (step === 'sso') {
    return (
      <SsoStep
        email={email}
        emailLocked={!!prefillEmail}
        error={error}
        isLoading={isSsoLoading}
        isLoaded={isLoaded}
        onEmailChange={setEmail}
        onSubmit={handleSsoSubmit}
        onBack={() => {
          setStep('credentials');
          setIsSsoLoading(false);
          setError(null);
        }}
      />
    );
  }

  // Two-factor authentication step
  if (step === 'two-factor') {
    return (
      <TwoFactorStep
        error={error}
        useBackupCode={useBackupCode}
        twoFactorCode={twoFactorCode}
        isLoading={isLoading}
        isLoaded={isLoaded}
        onSubmit={handleTwoFactorSubmit}
        onCodeChange={setTwoFactorCode}
        onToggleBackupCode={() => {
          setUseBackupCode(!useBackupCode);
          setTwoFactorCode('');
          setError(null);
        }}
        onBack={() => {
          setStep('credentials');
          setTwoFactorCode('');
          setUseBackupCode(false);
          setError(null);
        }}
      />
    );
  }

  // Email verification step
  if (step === 'email-verify') {
    return (
      <EmailCodeStep
        email={email}
        code={twoFactorCode}
        error={error}
        isLoading={isLoading}
        isLoaded={isLoaded}
        onCodeChange={(value) => {
          setTwoFactorCode(value);
          if (error) setError(null);
        }}
        onSubmit={(value) => void handleEmailVerifySubmit(value)}
        onResend={handleResendEmailCode}
        onBack={() => {
          setStep('credentials');
          setTwoFactorCode('');
          setError(null);
        }}
      />
    );
  }

  // First factor verification step (e.g., email verification for existing accounts)
  if (step === 'first-factor-verify') {
    return (
      <EmailCodeStep
        email={email}
        code={firstFactorCode}
        error={error}
        isLoading={isLoading}
        isLoaded={isLoaded}
        onCodeChange={(value) => {
          setFirstFactorCode(value);
          if (error) setError(null);
        }}
        onSubmit={(value) => void handleFirstFactorVerifySubmit(value)}
        onResend={handleResendFirstFactorCode}
        onBack={() => {
          setStep('credentials');
          setFirstFactorCode('');
          setError(null);
        }}
      />
    );
  }

  return (
    <LoginCredentialsView
      email={email}
      password={password}
      emailLocked={!!prefillEmail}
      error={error}
      isLoading={isLoading}
      isLoaded={isLoaded}
      google={{ isLoading: isGoogleLoading, onClick: () => void handleGoogleSignIn() }}
      passkey={showPasskeyButton ? { isLoading: isPasskeyLoading, onClick: () => void handlePasskeySignIn() } : undefined}
      sso={{ isLoading: isSsoLoading, onClick: () => void handleSsoClick() }}
      passkeyAutofill
      forgotPasswordHref="/auth/forgot-password"
      signUpHref={
        prefillEmail
          ? `/auth/register?email=${encodeURIComponent(prefillEmail)}&callbackUrl=${encodeURIComponent(callbackUrl)}`
          : '/auth/register'
      }
      showPassword={showPassword}
      onEmailChange={setEmail}
      onPasswordChange={setPassword}
      onToggleShowPassword={() => setShowPassword(!showPassword)}
      onSubmit={handleSubmit}
    />
  );
}

/**
 * Clerk's own screen (Global). On another provider (OIDC): WeldSuite's same
 * screens over the provider's sign-in, or its hosted page (`provider-login`).
 */
export default function LoginPage() {
  return (
    <ClerkOnly fallback={<ProviderLoginPage />}>
      <ClerkLoginPage />
    </ClerkOnly>
  );
}
