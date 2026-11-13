
import { useState } from 'react';
import { useSignIn } from '@/lib/auth/clerk';
import { useRouter } from '@/lib/router';
import { ClerkOnly } from '@/lib/auth';
import { ForgotPasswordFormView, ForgotPasswordSentView } from '../components/password-views';
import { ProviderForgotPasswordPage } from './provider-forgot-password';

function ClerkForgotPasswordPage() {
  const router = useRouter();
  const { signIn, isLoaded } = useSignIn();

  const [email, setEmail] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [success, setSuccess] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!isLoaded || !signIn) {
      return;
    }

    setIsLoading(true);

    try {
      await signIn.create({
        strategy: 'reset_password_email_code',
        identifier: email,
      });

      setSuccess(true);
      setIsLoading(false);
    } catch {
      // Always show success to prevent email enumeration
      setSuccess(true);
      setIsLoading(false);
    }
  };

  if (success) {
    return (
      <ForgotPasswordSentView
        email={email}
        onContinue={() => router.push(`/auth/reset-password?email=${encodeURIComponent(email)}`)}
        onRetry={() => {
          setSuccess(false);
          setEmail('');
        }}
      />
    );
  }

  return (
    <ForgotPasswordFormView
      email={email}
      error={null}
      isLoading={isLoading}
      isLoaded={isLoaded}
      onEmailChange={setEmail}
      onSubmit={handleSubmit}
    />
  );
}

/**
 * Clerk's own screen (Global). On another provider (OIDC): WeldSuite's same
 * screens over the provider's password reset, or its hosted page
 * (`provider-forgot-password`).
 */
export default function ForgotPasswordPage() {
  return (
    <ClerkOnly fallback={<ProviderForgotPasswordPage />}>
      <ClerkForgotPasswordPage />
    </ClerkOnly>
  );
}
