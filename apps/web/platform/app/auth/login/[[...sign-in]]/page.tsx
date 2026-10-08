
import { useState, useEffect, useMemo, useRef } from 'react';
import { useSignIn, useAuth, useOrganizationList } from '@clerk/clerk-react';
import { useSearchParams, Link } from '@/lib/router';
import { isDesktop, getDesktop } from '@/lib/desktop';
import { Button } from '@weldsuite/ui/components/button';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import {
  InputOTP,
  InputOTPGroup,
  InputOTPSlot,
} from '@weldsuite/ui/components/input-otp';
import { REGEXP_ONLY_DIGITS } from 'input-otp';
import { Loader2, Mail, Lock, KeyRound, ChevronLeft, Eye, EyeOff, Fingerprint } from 'lucide-react';
import { getSafeCallbackUrl, getClerkErrorMessage } from '../../utils';
import { isPasskeySupported, isPasskeyAutofillSupported, isPasskeyDismissed } from '@/lib/passkeys';
import { getTranslations } from '@/lib/i18n';

type LoginStep = 'credentials' | 'two-factor' | 'email-verify' | 'first-factor-verify';

// Auth pages are always light, so pin the OTP slots to the white theme instead of the app theme tokens.
const OTP_SLOT_CLASS =
  'h-[52px] flex-1 -ml-px border-l first:ml-0 bg-white dark:bg-white border-gray-200 text-[20px] font-medium text-gray-900 shadow-none data-[active=true]:border-gray-900 data-[active=true]:ring-gray-900/10 [&_.animate-caret-blink]:h-6 [&_.animate-caret-blink]:bg-gray-900 aria-invalid:border-red-500 data-[active=true]:aria-invalid:border-red-500 data-[active=true]:aria-invalid:ring-red-500/15';

function LoginErrorBanner({ error }: Readonly<{ error: string | null }>) {
  if (!error) return null;
  return (
    <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-xl text-sm text-red-600">
      {error}
    </div>
  );
}

function OtpFieldError({ error }: Readonly<{ error: string | null }>) {
  if (!error) return null;
  return (
    <p role="alert" className="mt-2.5 text-[13px] text-red-600">
      {error}
    </p>
  );
}

function SubmitLabel({
  isLoading,
  loadingLabel,
  label,
}: Readonly<{ isLoading: boolean; loadingLabel: string; label: string }>) {
  if (!isLoading) return <>{label}</>;
  return (
    <>
      <Loader2 className="h-4 w-4 animate-spin" />
      {loadingLabel}
    </>
  );
}

interface TwoFactorStepProps {
  error: string | null;
  useBackupCode: boolean;
  twoFactorCode: string;
  isLoading: boolean;
  isLoaded: boolean;
  onSubmit: (e: React.FormEvent) => void;
  onCodeChange: (code: string) => void;
  onToggleBackupCode: () => void;
  onBack: () => void;
}

function TwoFactorStep({
  error,
  useBackupCode,
  twoFactorCode,
  isLoading,
  isLoaded,
  onSubmit,
  onCodeChange,
  onToggleBackupCode,
  onBack,
}: Readonly<TwoFactorStepProps>) {
  const t = getTranslations('common');
  return (
    <div className="min-h-screen bg-white flex relative">
      <div className="flex-1 flex flex-col justify-center px-8 py-12 lg:px-16">
        <div className="w-full max-w-[448px] mx-auto">
          <div className="mb-[32px]">
            <h1 className="text-[26px] font-semibold text-gray-900 mb-2">
              {t.auth.login.twoFactor.title}
            </h1>
            <p className="text-gray-600">
              {useBackupCode
                ? t.auth.login.twoFactor.subtitleBackupCode
                : t.auth.login.twoFactor.subtitleAuthenticator}
            </p>
          </div>

          <LoginErrorBanner error={error} />

          <form onSubmit={onSubmit} className="space-y-[25px]">
            <div>
              <Label htmlFor="code" className="mb-2 block text-gray-900">
                {useBackupCode ? t.auth.login.twoFactor.backupCodeLabel : t.auth.login.twoFactor.verificationCodeLabel}
              </Label>
              <div className="relative">
                <KeyRound className="absolute left-3.5 top-1/2 -translate-y-1/2 h-[17px] w-[17px] text-gray-400 pointer-events-none" />
                <Input
                  id="code"
                  type="text"
                  inputMode={useBackupCode ? 'text' : 'numeric'}
                  autoComplete="one-time-code"
                  placeholder={useBackupCode ? t.auth.login.twoFactor.backupCodePlaceholder : t.auth.login.twoFactor.verificationCodePlaceholder}
                  value={twoFactorCode}
                  onChange={(e) => onCodeChange(e.target.value)}
                  required
                  disabled={isLoading}
                  autoFocus
                  className={`pl-10 !h-[40px] !border-gray-300 !bg-white text-gray-900 !text-[14px] !ring-0 !ring-offset-0 focus:!ring-0 focus:!ring-offset-0 focus-visible:!ring-0 focus-visible:!ring-offset-0 focus:!border-gray-400 ${!useBackupCode ? 'text-center tracking-widest' : ''}`}
                />
              </div>
            </div>

            <Button
              type="submit"
              disabled={isLoading || !isLoaded || !twoFactorCode}
              className="w-full h-[42px] shadow-none rounded-[calc(var(--radius)+1px)] bg-black hover:bg-black/90 text-white text-[14px]"
              size="lg"
            >
              <SubmitLabel isLoading={isLoading} loadingLabel={t.auth.login.twoFactor.verifying} label={t.auth.login.twoFactor.verify} />
            </Button>
          </form>

          <div className="mt-6 text-center">
            <Button
              type="button"
              variant="ghost"
              onClick={onToggleBackupCode}
              className="text-sm text-gray-600 hover:text-gray-900"
            >
              {useBackupCode
                ? t.auth.login.twoFactor.useAuthenticatorInstead
                : t.auth.login.twoFactor.useBackupCodeInstead}
            </Button>
          </div>

          <div className="mt-4 text-center">
            <Button
              type="button"
              variant="ghost"
              onClick={onBack}
              className="text-gray-600 hover:text-gray-900 inline-flex items-center gap-1 pl-2 pr-[9px] py-1 rounded-lg hover:bg-gray-100 transition-colors"
            >
              <ChevronLeft className="h-4 w-4" />
              {t.auth.login.twoFactor.backToLogin}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

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

function GoogleIcon({ className }: Readonly<{ className?: string }>) {
  return (
    <svg className={className} viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
      <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/>
      <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
      <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/>
      <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
    </svg>
  );
}

export default function LoginPage() {
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

  const [step, setStep] = useState<LoginStep>('credentials');
  const [email, setEmail] = useState(prefillEmail || '');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [twoFactorCode, setTwoFactorCode] = useState('');
  const [firstFactorCode, setFirstFactorCode] = useState('');
  const [useBackupCode, setUseBackupCode] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [isGoogleLoading, setIsGoogleLoading] = useState(false);
  const [isPasskeyLoading, setIsPasskeyLoading] = useState(false);
  // Inside the Electron shell the passkey button hands off to the system
  // browser (like Google), so it is shown there even without WebAuthn.
  const [showPasskeyButton] = useState(() => isDesktop() || isPasskeySupported());
  const [error, setError] = useState<string | null>(null);

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
        redirectUrl: isDesktopHandoff
          ? `/auth/sso-callback?desktop=1&return_to=${encodeURIComponent(desktopReturnTo)}`
          : '/auth/sso-callback',
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

  const handleEmailVerifySubmit = async (e: React.FormEvent, codeOverride?: string) => {
    e.preventDefault();

    if (!isLoaded || !signIn) {
      return;
    }

    setError(null);
    setIsLoading(true);

    try {
      const result = await signIn.attemptSecondFactor({
        strategy: 'email_code',
        code: codeOverride ?? twoFactorCode,
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

  const handleFirstFactorVerifySubmit = async (e: React.FormEvent, codeOverride?: string) => {
    e.preventDefault();

    if (!isLoaded || !signIn) {
      return;
    }

    setError(null);
    setIsLoading(true);

    try {
      const result = await signIn.attemptFirstFactor({
        strategy: 'email_code',
        code: codeOverride ?? firstFactorCode,
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
      <div className="min-h-screen bg-white flex relative">
        <div className="flex-1 flex flex-col justify-center px-8 py-12 lg:px-16">
          <div className="w-full max-w-[420px] mx-auto">
            <div className="mb-5">
              <Button
                type="button"
                variant="ghost"
                onClick={() => {
                  setStep('credentials');
                  setTwoFactorCode('');
                  setError(null);
                }}
                className="text-gray-500 hover:text-black hover:underline underline-offset-4 inline-flex items-center gap-1 h-auto p-0 has-[>svg]:px-0 hover:bg-transparent dark:hover:bg-transparent transition-colors"
              >
                <ChevronLeft className="h-4 w-4 -ml-[4px]" />
                {t.auth.login.emailVerify.backToLogin}
              </Button>
            </div>

            <div className="mb-[32px]">
              <h1 className="text-[26px] font-semibold text-gray-900 mb-2">
                {t.auth.login.emailVerify.title}
              </h1>
              <p className="text-gray-600">
                {t.auth.login.emailVerify.subtitle.split('{email}')[0]}<span className="font-medium text-gray-900">{email}</span>{t.auth.login.emailVerify.subtitle.split('{email}')[1]}
              </p>
            </div>

            <form onSubmit={handleEmailVerifySubmit} className="space-y-[25px]">
              <div>
                <InputOTP
                  maxLength={6}
                  pattern={REGEXP_ONLY_DIGITS}
                  value={twoFactorCode}
                  onChange={(value) => {
                    setTwoFactorCode(value);
                    if (error) setError(null);
                    if (value.length === 6) {
                      void handleEmailVerifySubmit({ preventDefault: () => {} } as React.FormEvent, value);
                    }
                  }}
                  disabled={isLoading}
                  autoFocus
                >
                  <InputOTPGroup className="w-full">
                    <InputOTPSlot index={0} className={OTP_SLOT_CLASS} aria-invalid={!!error} />
                    <InputOTPSlot index={1} className={OTP_SLOT_CLASS} aria-invalid={!!error} />
                    <InputOTPSlot index={2} className={OTP_SLOT_CLASS} aria-invalid={!!error} />
                    <InputOTPSlot index={3} className={OTP_SLOT_CLASS} aria-invalid={!!error} />
                    <InputOTPSlot index={4} className={OTP_SLOT_CLASS} aria-invalid={!!error} />
                    <InputOTPSlot index={5} className={OTP_SLOT_CLASS} aria-invalid={!!error} />
                  </InputOTPGroup>
                </InputOTP>
                <OtpFieldError error={error} />
              </div>

              <Button
                type="submit"
                disabled={isLoading || !isLoaded || !twoFactorCode}
                className="w-full h-[42px] shadow-none rounded-[calc(var(--radius)+1px)] bg-black hover:bg-black/90 text-white text-[14px]"
                size="lg"
              >
                <SubmitLabel isLoading={isLoading} loadingLabel={t.auth.login.emailVerify.verifying} label={t.auth.login.emailVerify.verify} />
              </Button>
            </form>

            <div className="mt-8 text-center">
              <Button
                type="button"
                variant="ghost"
                onClick={handleResendEmailCode}
                disabled={isLoading}
                className="text-gray-500 hover:text-gray-500 h-auto p-0 hover:bg-transparent dark:hover:bg-transparent"
              >
                {t.auth.login.emailVerify.didNotReceive} <span className="font-medium hover:text-black hover:underline underline-offset-4 transition-colors">{t.auth.login.emailVerify.resend}</span>
              </Button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // First factor verification step (e.g., email verification for existing accounts)
  if (step === 'first-factor-verify') {
    return (
      <div className="min-h-screen bg-white flex relative">
        <div className="flex-1 flex flex-col justify-center px-8 py-12 lg:px-16">
          <div className="w-full max-w-[420px] mx-auto">
            <div className="mb-5">
              <Button
                type="button"
                variant="ghost"
                onClick={() => {
                  setStep('credentials');
                  setFirstFactorCode('');
                  setError(null);
                }}
                className="text-gray-500 hover:text-black hover:underline underline-offset-4 inline-flex items-center gap-1 h-auto p-0 has-[>svg]:px-0 hover:bg-transparent dark:hover:bg-transparent transition-colors"
              >
                <ChevronLeft className="h-4 w-4 -ml-[4px]" />
                {t.auth.login.emailVerify.backToLogin}
              </Button>
            </div>

            <div className="mb-[32px]">
              <h1 className="text-[26px] font-semibold text-gray-900 mb-2">
                {t.auth.login.emailVerify.title}
              </h1>
              <p className="text-gray-600">
                {t.auth.login.emailVerify.subtitle.split('{email}')[0]}<span className="font-medium text-gray-900">{email}</span>{t.auth.login.emailVerify.subtitle.split('{email}')[1]}
              </p>
            </div>

            <form onSubmit={handleFirstFactorVerifySubmit} className="space-y-[25px]">
              <div>
                <InputOTP
                  maxLength={6}
                  pattern={REGEXP_ONLY_DIGITS}
                  value={firstFactorCode}
                  onChange={(value) => {
                    setFirstFactorCode(value);
                    if (error) setError(null);
                    if (value.length === 6) {
                      void handleFirstFactorVerifySubmit({ preventDefault: () => {} } as React.FormEvent, value);
                    }
                  }}
                  disabled={isLoading}
                  autoFocus
                >
                  <InputOTPGroup className="w-full">
                    <InputOTPSlot index={0} className={OTP_SLOT_CLASS} aria-invalid={!!error} />
                    <InputOTPSlot index={1} className={OTP_SLOT_CLASS} aria-invalid={!!error} />
                    <InputOTPSlot index={2} className={OTP_SLOT_CLASS} aria-invalid={!!error} />
                    <InputOTPSlot index={3} className={OTP_SLOT_CLASS} aria-invalid={!!error} />
                    <InputOTPSlot index={4} className={OTP_SLOT_CLASS} aria-invalid={!!error} />
                    <InputOTPSlot index={5} className={OTP_SLOT_CLASS} aria-invalid={!!error} />
                  </InputOTPGroup>
                </InputOTP>
                <OtpFieldError error={error} />
              </div>

              <Button
                type="submit"
                disabled={isLoading || !isLoaded || !firstFactorCode}
                className="w-full h-[42px] shadow-none rounded-[calc(var(--radius)+1px)] bg-black hover:bg-black/90 text-white text-[14px]"
                size="lg"
              >
                <SubmitLabel isLoading={isLoading} loadingLabel={t.auth.login.emailVerify.verifying} label={t.auth.login.emailVerify.verify} />
              </Button>
            </form>

            <div className="mt-8 text-center">
              <Button
                type="button"
                variant="ghost"
                onClick={handleResendFirstFactorCode}
                disabled={isLoading}
                className="text-gray-500 hover:text-gray-500 h-auto p-0 hover:bg-transparent dark:hover:bg-transparent"
              >
                {t.auth.login.emailVerify.didNotReceive} <span className="font-medium hover:text-black hover:underline underline-offset-4 transition-colors">{t.auth.login.emailVerify.resend}</span>
              </Button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-white flex relative">
      {/* Login Form */}
      <div className="flex-1 flex flex-col justify-center px-8 py-12 lg:px-16">
        <div className="w-full max-w-[448px] mx-auto">
          <div className="mb-[32px]">
            <h1 className="text-[26px] font-semibold text-gray-900 mb-2">
              {t.auth.login.title}
            </h1>
            <p className="text-gray-600">
              {t.auth.login.subtitle}
            </p>
          </div>

          <LoginErrorBanner error={error} />

          {/* Google Sign In */}
          <Button
            type="button"
            variant="outline"
            onClick={handleGoogleSignIn}
            disabled={isGoogleLoading || !isLoaded}
            className="w-full h-[42px] shadow-none rounded-[calc(var(--radius)+1px)] !border-gray-300 !bg-white !text-gray-700 hover:!bg-gray-50 hover:!text-gray-700 text-[14px]"
            size="lg"
          >
            {isGoogleLoading ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <>
                <GoogleIcon className="h-5 w-5 mr-2" />
                {t.auth.login.continueWithGoogle}
              </>
            )}
          </Button>

          {/* Passkey Sign In */}
          {showPasskeyButton && (
            <Button
              type="button"
              variant="outline"
              onClick={handlePasskeySignIn}
              disabled={isPasskeyLoading || !isLoaded}
              className="w-full h-[42px] mt-3 shadow-none rounded-[calc(var(--radius)+1px)] !border-gray-300 !bg-white !text-gray-700 hover:!bg-gray-50 hover:!text-gray-700 text-[14px]"
              size="lg"
            >
              {isPasskeyLoading ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <>
                  <Fingerprint className="h-5 w-5 mr-2" />
                  {t.auth.login.signInWithPasskey}
                </>
              )}
            </Button>
          )}

          {/* Divider */}
          <div className="relative my-6">
            <div className="absolute inset-0 flex items-center">
              <div className="w-full border-t border-gray-200" />
            </div>
            <div className="relative flex justify-center text-xs uppercase">
              <span className="bg-white px-2 text-gray-500">{t.auth.login.orDivider}</span>
            </div>
          </div>

          <form onSubmit={handleSubmit} className="space-y-[25px]">
            <div>
              <Label htmlFor="email" className="mb-2 block text-gray-900">{t.auth.login.emailLabel}</Label>
              <div className="relative">
                <Mail className="absolute left-3.5 top-1/2 -translate-y-[calc(50%-1px)] h-[17px] w-[17px] text-gray-400 pointer-events-none" />
                <Input
                  id="email"
                  type="text"
                  inputMode="email"
                  // `webauthn` lets the browser list passkeys in this field's
                  // autofill dropdown (see the passkey autofill effect).
                  autoComplete="username webauthn"
                  placeholder={t.auth.login.emailPlaceholder}
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                  disabled={isLoading || !!prefillEmail}
                  readOnly={!!prefillEmail}
                  className={`pl-10 !h-[40px] !border-gray-300 text-gray-900 !text-[14px] selection:bg-blue-200 selection:text-gray-900 !ring-0 !ring-offset-0 focus:!ring-0 focus:!ring-offset-0 focus-visible:!ring-0 focus-visible:!ring-offset-0 focus:!border-gray-400 ${prefillEmail ? '!bg-gray-50 cursor-not-allowed' : '!bg-white'}`}
                />
              </div>
              {prefillEmail && (
                <p className="text-xs text-gray-500 mt-1">
                  {t.auth.login.signInWithInvitationHint}
                </p>
              )}
            </div>

            <div>
              <div className="flex items-center justify-between mb-2">
                <Label htmlFor="password" className="text-gray-900">{t.auth.login.passwordLabel}</Label>
                <Link
                  href="/auth/forgot-password"
                  className="text-xs text-gray-900 hover:text-gray-700 font-medium"
                >
                  {t.auth.login.forgotPassword}
                </Link>
              </div>
              <div className="relative">
                <Lock className="absolute left-3.5 top-1/2 -translate-y-1/2 h-[17px] w-[17px] text-gray-400 pointer-events-none" />
                <Input
                  id="password"
                  type={showPassword ? 'text' : 'password'}
                  placeholder={t.auth.login.passwordPlaceholder}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  disabled={isLoading}
                  autoFocus={!!prefillEmail}
                  className="pl-10 pr-10 !h-[40px] !border-gray-300 !bg-white text-gray-900 !text-[14px] selection:bg-blue-200 selection:text-gray-900 !ring-0 !ring-offset-0 focus:!ring-0 focus:!ring-offset-0 focus-visible:!ring-0 focus-visible:!ring-offset-0 focus:!border-gray-400"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  aria-label={showPassword ? t.auth.login.hidePassword : t.auth.login.showPassword}
                  aria-pressed={showPassword}
                  className="absolute right-2 top-1/2 -translate-y-1/2 p-1.5 rounded-md text-gray-400 hover:text-gray-600 hover:bg-gray-100 transition-colors cursor-pointer"
                >
                  {showPassword ? <EyeOff className="h-[17px] w-[17px]" /> : <Eye className="h-[17px] w-[17px]" />}
                </button>
              </div>
            </div>

            <Button
              type="submit"
              disabled={isLoading || !isLoaded}
              className="w-full h-[42px] shadow-none !mt-[4px] rounded-[calc(var(--radius)+1px)] bg-black hover:bg-black/90 text-white text-[14px]"
              size="lg"
            >
              <SubmitLabel isLoading={isLoading} loadingLabel={t.auth.login.signingIn} label={t.auth.login.signIn} />
            </Button>
          </form>
        </div>
      </div>

      <div className="absolute bottom-6 left-0 right-0 text-center">
        <p className="text-sm text-gray-600">
          {t.auth.login.needAccount}{' '}
          <Link
            href={prefillEmail
              ? `/auth/register?email=${encodeURIComponent(prefillEmail)}&callbackUrl=${encodeURIComponent(callbackUrl)}`
              : '/auth/register'}
            className="text-gray-900 hover:text-gray-700 font-medium"
          >
            {t.auth.login.signUp}
          </Link>
        </p>
      </div>
    </div>
  );
}
