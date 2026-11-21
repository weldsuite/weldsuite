/**
 * `/auth/forgot-password` on an OIDC provider. Where WeldSuite renders the
 * sign-in screens itself (`auth.signIn: "platform"` in `/config.json`, ADR
 * SEC-016), the screens Global shows over `/api/sign-in/password-reset`;
 * elsewhere the provider's own page.
 */

import { useState } from 'react';
import { usesPlatformSignIn } from '@/lib/auth';
import { requestPasswordReset } from '@/lib/auth/oidc/sign-in-api';
import { getTranslations } from '@/lib/i18n';
import { useRouter } from '@/lib/router';
import { HostedSignInRedirect } from '@/components/auth/identity-provider-screens';
import { ForgotPasswordFormView, ForgotPasswordSentView } from '../components/password-views';
import { signInErrorCode } from '../components/provider-sign-in';

/** `/auth/forgot-password` when Clerk is not the provider. */
export function ProviderForgotPasswordPage() {
  return usesPlatformSignIn() ? <PlatformForgotPasswordPage /> : <HostedSignInRedirect />;
}

function PlatformForgotPasswordPage() {
  const t = getTranslations('common');
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setIsLoading(true);
    try {
      await requestPasswordReset(email.trim());
      setSent(true);
    } catch (err) {
      // The backend answers the same for a known and an unknown address, so
      // a refusal here says nothing about the account: only that asking again
      // must wait, or that the request never arrived.
      if (signInErrorCode(err) === 'RATE_LIMITED') setError(t.auth.identityProvider.tooManyAttempts);
      else setError(t.auth.identityProvider.failed);
    }
    setIsLoading(false);
  };

  if (sent) {
    return (
      <ForgotPasswordSentView
        email={email}
        onContinue={() => router.push(`/auth/reset-password?email=${encodeURIComponent(email.trim())}`)}
        onRetry={() => {
          setSent(false);
          setEmail('');
        }}
      />
    );
  }

  return (
    <ForgotPasswordFormView
      email={email}
      error={error}
      isLoading={isLoading}
      isLoaded
      onEmailChange={setEmail}
      onSubmit={(e) => void handleSubmit(e)}
    />
  );
}
