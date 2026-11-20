
import { Suspense, useState } from 'react';
import { useSignIn } from '@/lib/auth/clerk';
import { Button } from '@weldsuite/ui/components/button';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import { Loader2, KeyRound, ChevronLeft } from 'lucide-react';
import { PageLoader } from '@weldsuite/ui/components/page-loader';
import { getTranslations } from '@/lib/i18n';
import { getClerkErrorMessage } from '../utils';
import { ClerkOnly } from '@/lib/auth';
import { meetsPasswordPolicy } from '../components/password-requirements';
import { ResetPasswordFormView } from '../components/password-views';
import { ProviderResetPasswordPage } from './provider-reset-password';

type ResetStep = 'reset' | 'two-factor';

function ClerkResetPasswordPage() {
  return (
    <Suspense fallback={<PageLoader />}>
      <ResetPasswordContent />
    </Suspense>
  );
}

interface ResetTwoFactorStepProps {
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

function ResetTwoFactorStep({
  error,
  useBackupCode,
  twoFactorCode,
  isLoading,
  isLoaded,
  onSubmit,
  onCodeChange,
  onToggleBackupCode,
  onBack,
}: Readonly<ResetTwoFactorStepProps>) {
  const t = getTranslations('common');
  return (
    <div className="min-h-screen bg-white flex relative">
      <div className="flex-1 flex flex-col justify-center px-8 py-12 lg:px-16">
        <div className="w-full max-w-[448px] mx-auto">
          <div className="mb-[32px]">
            <h1 className="text-[26px] font-semibold text-gray-900 mb-2">
              {t.auth.resetPassword.twoFactor.title}
            </h1>
            <p className="text-gray-600">
              {useBackupCode
                ? t.auth.resetPassword.twoFactor.subtitleBackupCode
                : t.auth.resetPassword.twoFactor.subtitleAuthenticator}
            </p>
          </div>

          {error && (
            <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-xl text-sm text-red-600">
              {error}
            </div>
          )}

          <form onSubmit={onSubmit} className="space-y-[25px]">
            <div>
              <Label htmlFor="twoFactorCode" className="mb-2 block text-gray-900">
                {useBackupCode ? t.auth.resetPassword.twoFactor.backupCodeLabel : t.auth.resetPassword.twoFactor.verificationCodeLabel}
              </Label>
              <div className="relative">
                <KeyRound className="absolute left-3.5 top-1/2 -translate-y-1/2 h-[17px] w-[17px] text-gray-400 pointer-events-none" />
                <Input
                  id="twoFactorCode"
                  type="text"
                  inputMode={useBackupCode ? 'text' : 'numeric'}
                  autoComplete="one-time-code"
                  placeholder={useBackupCode ? t.auth.resetPassword.twoFactor.backupCodePlaceholder : t.auth.resetPassword.twoFactor.verificationCodePlaceholder}
                  value={twoFactorCode}
                  onChange={(e) => onCodeChange(e.target.value)}
                  required
                  disabled={isLoading}
                  autoFocus
                  className={`pl-10 !h-[40px] !border-gray-300 !bg-white text-gray-900 !text-[14px] !ring-0 !ring-offset-0 focus:!ring-0 focus:!ring-offset-0 focus-visible:!ring-0 focus-visible:!ring-offset-0 focus:!border-gray-400 ${!useBackupCode ? 'tracking-widest text-center' : ''}`}
                />
              </div>
            </div>

            <Button
              type="submit"
              disabled={isLoading || !isLoaded || !twoFactorCode}
              className="w-full h-[42px] shadow-none rounded-[calc(var(--radius)+1px)] bg-black hover:bg-black/90 text-white text-[14px]"
              size="lg"
            >
              {isLoading ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  {t.auth.resetPassword.twoFactor.verifying}
                </>
              ) : (
                t.auth.resetPassword.twoFactor.verify
              )}
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
                ? t.auth.resetPassword.twoFactor.useAuthenticatorInstead
                : t.auth.resetPassword.twoFactor.useBackupCodeInstead}
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
              {t.auth.resetPassword.twoFactor.backToPasswordReset}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

function ResetPasswordContent() {
  const t = getTranslations('common');

  const { signIn, setActive, isLoaded } = useSignIn();

  const [step, setStep] = useState<ResetStep>('reset');
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [twoFactorCode, setTwoFactorCode] = useState('');
  const [useBackupCode, setUseBackupCode] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!isLoaded || !signIn) {
      return;
    }

    if (!meetsPasswordPolicy(password)) {
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
      const result = await signIn.attemptFirstFactor({
        strategy: 'reset_password_email_code',
        code,
        password,
      });

      if (result.status === 'complete') {
        await setActive({ session: result.createdSessionId });
        // Use window.location for full page navigation to ensure session cookies are set
        window.location.href = '/';
      } else if (result.status === 'needs_second_factor') {
        // User has 2FA enabled, need to verify
        setStep('two-factor');
        setIsLoading(false);
      } else {
        setError(t.auth.resetPassword.passwordResetFailed);
        setIsLoading(false);
      }
    } catch (err) {
      const errorMessage = getClerkErrorMessage(err, t.auth.resetPassword.invalidCode);
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
        window.location.href = '/';
      } else {
        setError(t.auth.resetPassword.twoFactor.verificationFailed);
        setIsLoading(false);
      }
    } catch (err) {
      const errorMessage = getClerkErrorMessage(err, t.auth.resetPassword.twoFactor.invalidCode);
      setError(errorMessage);
      setIsLoading(false);
    }
  };

  // Two-factor verification step
  if (step === 'two-factor') {
    return (
      <ResetTwoFactorStep
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
          setStep('reset');
          setTwoFactorCode('');
          setUseBackupCode(false);
          setError(null);
        }}
      />
    );
  }

  return (
    <ResetPasswordFormView
      code={code}
      password={password}
      confirmPassword={confirmPassword}
      error={error}
      isLoading={isLoading}
      isLoaded={isLoaded}
      onCodeChange={setCode}
      onPasswordChange={setPassword}
      onConfirmPasswordChange={setConfirmPassword}
      onSubmit={handleSubmit}
    />
  );
}

/**
 * Clerk's own screen (Global). On another provider (OIDC): WeldSuite's same
 * screen over the provider's password reset, or its hosted page
 * (`provider-reset-password`).
 */
export default function ResetPasswordPage() {
  return (
    <ClerkOnly fallback={<ProviderResetPasswordPage />}>
      <ClerkResetPasswordPage />
    </ClerkOnly>
  );
}
