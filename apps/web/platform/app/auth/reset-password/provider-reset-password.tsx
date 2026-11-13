/**
 * `/auth/reset-password` on an OIDC provider. Where WeldSuite renders the
 * sign-in screens itself (`auth.signIn: "platform"` in `/config.json`, ADR
 * SEC-016), the screen Global shows over `/api/sign-in/password-reset/confirm`;
 * elsewhere the provider's own page.
 *
 * Reached from "Enter reset code" (`?email=…`) or from the link in the
 * provider's email (`?userId=…&code=…`), which fills the code in.
 */

import { useEffect, useState } from 'react';
import { usesPlatformSignIn } from '@/lib/auth';
import { confirmPasswordReset, loadPasswordPolicy } from '@/lib/auth/oidc/sign-in-api';
import { getTranslations } from '@/lib/i18n';
import { useSearchParams } from '@/lib/router';
import { HostedSignInRedirect } from '@/components/auth/identity-provider-screens';
import {
  DEFAULT_PASSWORD_POLICY,
  meetsPasswordPolicy,
  type PasswordPolicy,
} from '../components/password-requirements';
import { ResetPasswordFormView } from '../components/password-views';
import { signInErrorCode, signInErrorMessage } from '../components/provider-sign-in';

/** `/auth/reset-password` when Clerk is not the provider. */
export function ProviderResetPasswordPage() {
  return usesPlatformSignIn() ? <PlatformResetPasswordPage /> : <HostedSignInRedirect />;
}

function PlatformResetPasswordPage() {
  const t = getTranslations('common');
  const searchParams = useSearchParams();
  const email = searchParams.get('email') ?? undefined;
  const userId = searchParams.get('userId') ?? undefined;
  const [code, setCode] = useState(searchParams.get('code') ?? '');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
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

  // Nobody to reset the password of: ask for the address first.
  const anonymous = !email && !userId;
  useEffect(() => {
    if (anonymous) window.location.replace('/auth/forgot-password');
  }, [anonymous]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!meetsPasswordPolicy(password, policy)) {
      setError(t.auth.resetPassword.passwordDoesNotMeetRequirements);
      return;
    }
    if (password !== confirmPassword) {
      setError(t.auth.resetPassword.passwordsDoNotMatch);
      return;
    }
    setError(null);
    setIsLoading(true);
    try {
      await confirmPasswordReset({ email, userId, code: code.trim(), password });
      // Sign in with the new password; stays busy while the browser leaves.
      window.location.replace('/auth/login');
    } catch (err) {
      setError(signInErrorMessage(signInErrorCode(err), t.auth.resetPassword.invalidCode));
      setIsLoading(false);
    }
  };

  return (
    <ResetPasswordFormView
      code={code}
      password={password}
      confirmPassword={confirmPassword}
      error={error}
      isLoading={isLoading}
      isLoaded={!anonymous}
      passwordPolicy={policy}
      numericCode={false}
      onCodeChange={setCode}
      onPasswordChange={setPassword}
      onConfirmPasswordChange={setConfirmPassword}
      onSubmit={(e) => void handleSubmit(e)}
    />
  );
}
