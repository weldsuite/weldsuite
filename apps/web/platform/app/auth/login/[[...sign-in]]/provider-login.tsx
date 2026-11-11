/**
 * `/auth/login` on an OIDC provider (EU and self-hosted on Zitadel).
 *
 * Without `?authRequest=` the page starts the OIDC redirect. The provider
 * then either shows its own sign-in page, or, when its sign-in for the
 * platform points here (ADR SEC-016), comes straight back with
 * `?authRequest=…` and this page shows the screens Global shows
 * (`../../components/login-views`) over `/api/sign-in/*`.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { PageLoader } from '@weldsuite/ui/components/page-loader';
import { Button } from '@weldsuite/ui/components/button';
import { redirectToSignIn, useAuth } from '@/lib/auth';
import {
  loadSignInRequest,
  resendEmailVerification,
  sendSecondFactorCode,
  signInWithPassword,
  verifyEmailAddress,
  verifyEmailFromLink,
  verifySecondFactor,
  type CodeFormat,
  type SignInStep,
} from '@/lib/auth/oidc/sign-in-api';
import { getTranslations } from '@/lib/i18n';
import { useSearchParams } from '@/lib/router';
import { EmailCodeStep, LoginCredentialsView, TwoFactorStep } from '../../components/login-views';
import { restartSignIn, sameOriginPath, signInErrorCode, signInErrorMessage } from '../../components/provider-sign-in';
import { getSafeCallbackUrl } from '../../utils';

/** `/auth/login` when Clerk is not the provider. */
export function ProviderLoginPage() {
  const searchParams = useSearchParams();
  const authRequest = searchParams.get('authRequest');
  if (authRequest) {
    // `intent=sign-in`: the person came back from the sign-up form.
    return <PlatformLoginPage authRequest={authRequest} stayOnSignIn={searchParams.get('intent') === 'sign-in'} />;
  }
  const returnTo = sameOriginPath(getSafeCallbackUrl(searchParams));
  // The link in the "verify your email" mail.
  const verifyUser = searchParams.get('verifyUser');
  const verifyCode = searchParams.get('verifyCode');
  if (verifyUser && verifyCode) return <VerifyFromLink userId={verifyUser} code={verifyCode} returnTo={returnTo} />;
  return <StartSignIn returnTo={returnTo} />;
}

/**
 * The emailed link verifies the address, then signs in. In the browser that
 * signed up, the sign-in then goes straight on; in another one it asks for
 * the password. A code that no longer works changes nothing here: the
 * sign-in asks for a new one where the address still needs it.
 */
function VerifyFromLink({ userId, code, returnTo }: Readonly<{ userId: string; code: string; returnTo: string }>) {
  const t = getTranslations('common');
  const [settled, setSettled] = useState(false);
  const startedRef = useRef(false);

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    verifyEmailFromLink(userId, code)
      .catch(() => undefined)
      .finally(() => setSettled(true));
  }, [userId, code]);

  if (settled) return <StartSignIn returnTo={returnTo} />;
  return <PageLoader label={t.auth.identityProvider.completing} />;
}

/** No sign-in in progress: start one at the provider, unless the person is signed in already. */
function StartSignIn({ returnTo }: Readonly<{ returnTo: string }>) {
  const t = getTranslations('common');
  const { isLoaded, isSignedIn } = useAuth();
  const startedRef = useRef(false);

  useEffect(() => {
    if (!isLoaded || startedRef.current) return;
    startedRef.current = true;
    if (isSignedIn) {
      window.location.replace(returnTo);
      return;
    }
    void redirectToSignIn({ returnTo });
  }, [isLoaded, isSignedIn, returnTo]);

  return <PageLoader label={t.auth.identityProvider.redirecting} />;
}

type Screen =
  | { kind: 'loading' }
  | { kind: 'failed' }
  | { kind: 'credentials'; allowRegister: boolean; allowPasswordReset: boolean }
  | { kind: 'totp' }
  | { kind: 'second-factor-email'; email: string; format: CodeFormat }
  | { kind: 'verify-email'; email: string; format: CodeFormat };

/** The sign-in screens over the provider's session API. */
function PlatformLoginPage({
  authRequest,
  stayOnSignIn,
}: Readonly<{ authRequest: string; stayOnSignIn: boolean }>) {
  const t = getTranslations('common');
  const [screen, setScreen] = useState<Screen>({ kind: 'loading' });
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  // The form last shown, to return to from a code screen.
  const credentialsRef = useRef<Extract<Screen, { kind: 'credentials' }>>({
    kind: 'credentials',
    allowRegister: false,
    allowPasswordReset: false,
  });

  const restart = useCallback(() => {
    if (!restartSignIn()) setScreen({ kind: 'failed' });
  }, []);

  /** Show what the backend says comes next. Leaves the loading state on while the browser navigates away. */
  const apply = useCallback(
    (step: SignInStep) => {
      switch (step.status) {
        case 'complete':
          window.location.replace(step.redirectUrl);
          return;
        case 'hosted':
          window.location.replace(step.url);
          return;
        case 'expired':
          restart();
          return;
        case 'needs_credentials':
          if (step.intent === 'sign-up' && step.allowRegister && !stayOnSignIn) {
            window.location.replace(`/auth/register?authRequest=${encodeURIComponent(authRequest)}`);
            return;
          }
          credentialsRef.current = {
            kind: 'credentials',
            allowRegister: step.allowRegister,
            allowPasswordReset: step.allowPasswordReset,
          };
          if (step.loginHint) setEmail((current) => current || (step.loginHint ?? ''));
          setScreen(credentialsRef.current);
          break;
        case 'needs_second_factor':
          setCode('');
          // The authenticator app wins. Without one the backend emailed the
          // code as it answered; "Resend" asks for another.
          setScreen(
            step.factors.includes('totp')
              ? { kind: 'totp' }
              : { kind: 'second-factor-email', email: step.email, format: step.emailCode },
          );
          break;
        case 'needs_email_verification':
          setCode('');
          setScreen({ kind: 'verify-email', email: step.email, format: step.code });
          break;
      }
      setIsLoading(false);
    },
    [authRequest, restart, stayOnSignIn],
  );

  // Where this sign-in stands. A browser the provider still knows (switching
  // workspace, a second tab) goes straight on without a form.
  const loadedRef = useRef<string | null>(null);
  useEffect(() => {
    if (loadedRef.current === authRequest) return;
    loadedRef.current = authRequest;
    loadSignInRequest(authRequest)
      .then(apply)
      .catch(() => setScreen({ kind: 'failed' }));
  }, [authRequest, apply]);

  /** Run one step; a refusal shows on the current screen. */
  const run = async (action: () => Promise<SignInStep>, fallback: string) => {
    setError(null);
    setIsLoading(true);
    try {
      apply(await action());
    } catch (err) {
      const refusal = signInErrorCode(err);
      if (refusal === 'NO_SESSION') {
        // The provider session behind a code screen is gone: sign in again.
        setCode('');
        setScreen(credentialsRef.current);
        setError(t.auth.login.signInFailed);
      } else {
        setError(signInErrorMessage(refusal, fallback));
      }
      setIsLoading(false);
    }
  };

  /** Send a code again; the screen stays. */
  const resend = async (action: () => Promise<void>, fallback: string) => {
    setError(null);
    setIsLoading(true);
    try {
      await action();
    } catch (err) {
      setError(signInErrorMessage(signInErrorCode(err), fallback));
    }
    setIsLoading(false);
  };

  const backToCredentials = () => {
    setScreen(credentialsRef.current);
    setCode('');
    setPassword('');
    setError(null);
  };

  const onCodeChange = (value: string) => {
    setCode(value);
    if (error) setError(null);
  };

  if (screen.kind === 'loading') return <PageLoader label={t.auth.identityProvider.completing} />;

  if (screen.kind === 'failed') {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-4 p-4 text-center">
        <p className="text-sm text-muted-foreground">{t.auth.identityProvider.failed}</p>
        <Button onClick={() => void redirectToSignIn({ returnTo: '/' })}>{t.auth.identityProvider.retry}</Button>
      </div>
    );
  }

  if (screen.kind === 'totp') {
    return (
      <TwoFactorStep
        error={error}
        useBackupCode={false}
        backupCodes={false}
        twoFactorCode={code}
        isLoading={isLoading}
        isLoaded
        onSubmit={(e) => {
          e.preventDefault();
          void run(() => verifySecondFactor(authRequest, 'totp', code.trim()), t.auth.login.twoFactor.invalidCode);
        }}
        onCodeChange={setCode}
        onToggleBackupCode={() => undefined}
        onBack={backToCredentials}
      />
    );
  }

  if (screen.kind === 'second-factor-email') {
    return (
      <EmailCodeStep
        email={screen.email}
        code={code}
        error={error}
        isLoading={isLoading}
        isLoaded
        format={screen.format}
        onCodeChange={onCodeChange}
        onSubmit={(value) =>
          void run(() => verifySecondFactor(authRequest, 'email_code', value), t.auth.login.emailVerify.invalidCode)
        }
        onResend={() => void resend(() => sendSecondFactorCode(authRequest), t.auth.login.emailVerify.failedToResend)}
        onBack={backToCredentials}
      />
    );
  }

  if (screen.kind === 'verify-email') {
    return (
      <EmailCodeStep
        email={screen.email}
        code={code}
        error={error}
        isLoading={isLoading}
        isLoaded
        format={screen.format}
        onCodeChange={onCodeChange}
        onSubmit={(value) => void run(() => verifyEmailAddress(authRequest, value), t.auth.login.emailVerify.invalidCode)}
        onResend={() => void resend(() => resendEmailVerification(authRequest), t.auth.login.emailVerify.failedToResend)}
        onBack={backToCredentials}
      />
    );
  }

  return (
    <LoginCredentialsView
      email={email}
      password={password}
      emailLocked={false}
      error={error}
      isLoading={isLoading}
      isLoaded
      forgotPasswordHref={screen.allowPasswordReset ? '/auth/forgot-password' : undefined}
      // The sign-up form finishes this same sign-in, so no second trip to the provider.
      signUpHref={screen.allowRegister ? `/auth/register?authRequest=${encodeURIComponent(authRequest)}` : undefined}
      showPassword={showPassword}
      onEmailChange={setEmail}
      onPasswordChange={setPassword}
      onToggleShowPassword={() => setShowPassword(!showPassword)}
      onSubmit={(e) => {
        e.preventDefault();
        void run(() => signInWithPassword(authRequest, email.trim(), password), t.auth.login.signInFailed);
      }}
    />
  );
}
