
import { Suspense, useState } from 'react';
import { useSignIn } from '@clerk/clerk-react';
import { useRouter, useSearchParams, Link } from '@/lib/router';
import { Button } from '@weldsuite/ui/components/button';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import { Loader2, Lock, CheckCircle, KeyRound, ChevronLeft } from 'lucide-react';
import { PageLoader } from '@/components/page-loader';
import { getTranslations } from '@/lib/i18n';

type ResetStep = 'reset' | 'two-factor';

export default function ResetPasswordPage() {
  return (
    <Suspense fallback={<PageLoader />}>
      <ResetPasswordContent />
    </Suspense>
  );
}

function ResetPasswordContent() {
  const t = getTranslations('common');
  const router = useRouter();
  const searchParams = useSearchParams();
  const emailFromParams = searchParams.get('email') || '';

  const { signIn, setActive, isLoaded } = useSignIn();

  const [step, setStep] = useState<ResetStep>('reset');
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [twoFactorCode, setTwoFactorCode] = useState('');
  const [useBackupCode, setUseBackupCode] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [passwordErrors, setPasswordErrors] = useState<string[]>([]);

  const requirementKeys = [
    t.auth.resetPassword.requirements.atLeast8Chars,
    t.auth.resetPassword.requirements.oneUppercase,
    t.auth.resetPassword.requirements.oneLowercase,
    t.auth.resetPassword.requirements.oneNumber,
  ];

  const validatePassword = (pwd: string) => {
    const errors: string[] = [];
    if (pwd.length < 8) errors.push(t.auth.resetPassword.requirements.atLeast8Chars);
    if (!/[A-Z]/.test(pwd)) errors.push(t.auth.resetPassword.requirements.oneUppercase);
    if (!/[a-z]/.test(pwd)) errors.push(t.auth.resetPassword.requirements.oneLowercase);
    if (!/[0-9]/.test(pwd)) errors.push(t.auth.resetPassword.requirements.oneNumber);
    return errors;
  };

  const handlePasswordChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const pwd = e.target.value;
    setPassword(pwd);
    setPasswordErrors(validatePassword(pwd));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!isLoaded || !signIn) {
      return;
    }

    const pwdErrors = validatePassword(password);
    if (pwdErrors.length > 0) {
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
    } catch (err: any) {
      const errorMessage = err?.errors?.[0]?.longMessage || err?.errors?.[0]?.message || t.auth.resetPassword.invalidCode;
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
    } catch (err: any) {
      const errorMessage = err?.errors?.[0]?.longMessage || err?.errors?.[0]?.message || t.auth.resetPassword.twoFactor.invalidCode;
      setError(errorMessage);
      setIsLoading(false);
    }
  };

  // Two-factor verification step
  if (step === 'two-factor') {
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

            <form onSubmit={handleTwoFactorSubmit} className="space-y-[25px]">
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
                    onChange={(e) => setTwoFactorCode(e.target.value)}
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
                onClick={() => {
                  setUseBackupCode(!useBackupCode);
                  setTwoFactorCode('');
                  setError(null);
                }}
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
                onClick={() => {
                  setStep('reset');
                  setTwoFactorCode('');
                  setUseBackupCode(false);
                  setError(null);
                }}
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

  return (
    <div className="min-h-screen bg-white flex relative">
      <div className="flex-1 flex flex-col justify-center px-8 py-12 lg:px-16">
        <div className="w-full max-w-[448px] mx-auto">
          <div className="mb-[32px]">
            <h1 className="text-[26px] font-semibold text-gray-900 mb-2">
              {t.auth.resetPassword.title}
            </h1>
            <p className="text-gray-600">
              {t.auth.resetPassword.subtitle}
            </p>
          </div>

          {error && (
            <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-xl text-sm text-red-600">
              {error}
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-[20px]">
            <div>
              <Label htmlFor="code" className="mb-2 block text-gray-900">{t.auth.resetPassword.resetCodeLabel}</Label>
              <div className="relative">
                <KeyRound className="absolute left-3.5 top-1/2 -translate-y-1/2 h-[17px] w-[17px] text-gray-400 pointer-events-none" />
                <Input
                  id="code"
                  type="text"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  placeholder={t.auth.resetPassword.resetCodePlaceholder}
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  required
                  disabled={isLoading}
                  className="pl-10 !h-[40px] !border-gray-300 !bg-white text-gray-900 !text-[14px] tracking-widest !ring-0 !ring-offset-0 focus:!ring-0 focus:!ring-offset-0 focus-visible:!ring-0 focus-visible:!ring-offset-0 focus:!border-gray-400"
                />
              </div>
            </div>

            <div>
              <Label htmlFor="password" className="mb-2 block text-gray-900">{t.auth.resetPassword.newPasswordLabel}</Label>
              <div className="relative">
                <Lock className="absolute left-3.5 top-1/2 -translate-y-1/2 h-[17px] w-[17px] text-gray-400 pointer-events-none" />
                <Input
                  id="password"
                  type="password"
                  placeholder={t.auth.resetPassword.newPasswordPlaceholder}
                  value={password}
                  onChange={handlePasswordChange}
                  required
                  disabled={isLoading}
                  className="pl-10 !h-[40px] !border-gray-300 !bg-white text-gray-900 !text-[14px] !ring-0 !ring-offset-0 focus:!ring-0 focus:!ring-offset-0 focus-visible:!ring-0 focus-visible:!ring-offset-0 focus:!border-gray-400"
                />
              </div>

              {/* Password requirements */}
              <div className="mt-2 space-y-1">
                {requirementKeys.map((req, i) => {
                  const checks = [
                    password.length >= 8,
                    /[A-Z]/.test(password),
                    /[a-z]/.test(password),
                    /[0-9]/.test(password),
                  ];
                  const isValid = checks[i];
                  return (
                    <div key={req} className="flex items-center gap-2 text-xs">
                      <CheckCircle
                        className={`h-3 w-3 ${isValid ? 'text-green-500' : 'text-gray-300'}`}
                      />
                      <span className={isValid ? 'text-gray-700' : 'text-gray-400'}>{req}</span>
                    </div>
                  );
                })}
              </div>
            </div>

            <div>
              <Label htmlFor="confirmPassword" className="mb-2 block text-gray-900">{t.auth.resetPassword.confirmPasswordLabel}</Label>
              <div className="relative">
                <Lock className="absolute left-3.5 top-1/2 -translate-y-1/2 h-[17px] w-[17px] text-gray-400 pointer-events-none" />
                <Input
                  id="confirmPassword"
                  type="password"
                  placeholder={t.auth.resetPassword.confirmPasswordPlaceholder}
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  required
                  disabled={isLoading}
                  className="pl-10 !h-[40px] !border-gray-300 !bg-white text-gray-900 !text-[14px] !ring-0 !ring-offset-0 focus:!ring-0 focus:!ring-offset-0 focus-visible:!ring-0 focus-visible:!ring-offset-0 focus:!border-gray-400"
                />
              </div>
              {confirmPassword && password !== confirmPassword && (
                <p className="text-xs text-red-500 mt-1">{t.auth.resetPassword.passwordsDoNotMatch}</p>
              )}
            </div>

            <Button
              type="submit"
              disabled={isLoading || !isLoaded || passwordErrors.length > 0 || password !== confirmPassword || !code}
              className="w-full h-[42px] shadow-none !mt-[8px] rounded-[calc(var(--radius)+1px)] bg-black hover:bg-black/90 text-white text-[14px]"
              size="lg"
            >
              {isLoading ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  {t.auth.resetPassword.resettingPassword}
                </>
              ) : (
                t.auth.resetPassword.resetPassword
              )}
            </Button>
          </form>

          <div className="mt-6 text-center">
            <Link
              href="/auth/forgot-password"
              className="text-sm text-gray-600 hover:text-gray-900"
            >
              {t.auth.resetPassword.didNotReceiveCode} <span className="font-medium">{t.auth.resetPassword.tryAgain}</span>
            </Link>
          </div>
        </div>
      </div>

      <div className="absolute bottom-6 left-0 right-0 text-center">
        <p className="text-sm text-gray-600">
          {t.auth.resetPassword.rememberPassword}{' '}
          <Link
            href="/auth/login"
            className="text-gray-900 hover:text-gray-700 font-medium"
          >
            {t.auth.resetPassword.signIn}
          </Link>
        </p>
      </div>
    </div>
  );
}
