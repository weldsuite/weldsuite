/**
 * `/auth/register` on an OIDC provider (EU and self-hosted on Zitadel).
 *
 * Without `?authRequest=` the page starts the OIDC redirect asking for
 * sign-up (`prompt=create`): the provider shows its own registration, or,
 * when its sign-in for the platform points at `/auth/login` (ADR SEC-016),
 * comes back there and on to here with `?authRequest=…`. Then this page
 * shows the screens Global shows (`../../components/register-views`) over
 * `/api/sign-in/*`, and signing up finishes that same sign-in.
 */

import { useEffect, useState } from 'react';
import { Button } from '@weldsuite/ui/components/button';
import { redirectToSignIn } from '@/lib/auth';
import {
  loadPasswordPolicy,
  resendEmailVerification,
  signUp,
  verifyEmailAddress,
  type CodeFormat,
  type SignInStep,
} from '@/lib/auth/oidc/sign-in-api';
import { getTranslations } from '@/lib/i18n';
import { useSearchParams } from '@/lib/router';
import { HostedSignInRedirect } from '@/components/auth/identity-provider-screens';
import {
  DEFAULT_PASSWORD_POLICY,
  meetsPasswordPolicy,
  type PasswordPolicy,
} from '../../components/password-requirements';
import { restartSignIn, signInErrorCode, signInErrorMessage } from '../../components/provider-sign-in';
import { RegisterFormView, RegisterVerifyView } from '../../components/register-views';

/** `/auth/register` when Clerk is not the provider. */
export function ProviderRegisterPage() {
  const authRequest = useSearchParams().get('authRequest');
  if (authRequest) return <PlatformRegisterPage authRequest={authRequest} />;
  return <HostedSignInRedirect intent="sign-up" />;
}

type Screen = { kind: 'form' } | { kind: 'verify'; email: string; format: CodeFormat } | { kind: 'failed' };

/** The sign-up screens over the provider's user and session APIs. */
function PlatformRegisterPage({ authRequest }: Readonly<{ authRequest: string }>) {
  const t = getTranslations('common');
  const [screen, setScreen] = useState<Screen>({ kind: 'form' });
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [code, setCode] = useState('');
  const [policy, setPolicy] = useState<PasswordPolicy>(DEFAULT_PASSWORD_POLICY);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  // The provider's own rules for the checklist; Global's until they arrive.
  useEffect(() => {
    let current = true;
    loadPasswordPolicy()
      .then((loaded) => {
        if (current) setPolicy(loaded);
      })
      .catch(() => undefined);
    return () => {
      current = false;
    };
  }, []);

  const loginHref = `/auth/login?authRequest=${encodeURIComponent(authRequest)}&intent=sign-in`;

  /** Show what the backend says comes next; stays busy while the browser navigates away. */
  const apply = (step: SignInStep) => {
    switch (step.status) {
      case 'complete':
        window.location.replace(step.redirectUrl);
        return;
      case 'hosted':
        window.location.replace(step.url);
        return;
      case 'expired':
        if (!restartSignIn('sign-up')) setScreen({ kind: 'failed' });
        return;
      case 'needs_email_verification':
        setCode('');
        setScreen({ kind: 'verify', email: step.email, format: step.code });
        break;
      default:
        // Signed up, with something left that the sign-in screens ask for.
        window.location.replace(loginHref);
        return;
    }
    setIsLoading(false);
  };

  const run = async (action: () => Promise<SignInStep>, fallback: string) => {
    setError(null);
    setIsLoading(true);
    try {
      apply(await action());
    } catch (err) {
      const refusal = signInErrorCode(err);
      if (refusal === 'NO_SESSION') {
        // The account exists; its sign-in was lost on the way. Sign in instead.
        window.location.replace(loginHref);
        return;
      }
      setError(signInErrorMessage(refusal, fallback));
      setIsLoading(false);
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!meetsPasswordPolicy(password, policy)) {
      setError(t.auth.register.passwordDoesNotMeetRequirements);
      return;
    }
    if (password !== confirmPassword) {
      setError(t.auth.register.passwordsDoNotMatch);
      return;
    }
    void run(
      () => signUp(authRequest, { firstName: firstName.trim(), lastName: lastName.trim(), email: email.trim(), password }),
      t.auth.register.registrationFailed,
    );
  };

  const handleResend = async () => {
    setError(null);
    setIsLoading(true);
    try {
      await resendEmailVerification(authRequest);
    } catch (err) {
      setError(signInErrorMessage(signInErrorCode(err), t.auth.register.failedToResend));
    }
    setIsLoading(false);
  };

  if (screen.kind === 'failed') {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-4 p-4 text-center">
        <p className="text-sm text-muted-foreground">{t.auth.identityProvider.failed}</p>
        <Button onClick={() => void redirectToSignIn({ intent: 'sign-up', returnTo: '/' })}>
          {t.auth.identityProvider.retry}
        </Button>
      </div>
    );
  }

  if (screen.kind === 'verify') {
    return (
      <RegisterVerifyView
        email={screen.email}
        code={code}
        error={error}
        isLoading={isLoading}
        isLoaded
        format={screen.format}
        onCodeChange={setCode}
        onSubmit={(e) => {
          e.preventDefault();
          void run(() => verifyEmailAddress(authRequest, code), t.auth.register.invalidVerificationCode);
        }}
        onResend={() => void handleResend()}
        onBack={() => {
          setScreen({ kind: 'form' });
          setCode('');
          setError(null);
        }}
      />
    );
  }

  return (
    <RegisterFormView
      invited={false}
      firstName={firstName}
      lastName={lastName}
      email={email}
      password={password}
      confirmPassword={confirmPassword}
      error={error}
      isLoading={isLoading}
      isLoaded
      passwordPolicy={policy}
      signInHref={loginHref}
      onFirstNameChange={setFirstName}
      onLastNameChange={setLastName}
      onEmailChange={setEmail}
      onPasswordChange={setPassword}
      onConfirmPasswordChange={setConfirmPassword}
      onSubmit={handleSubmit}
    />
  );
}
