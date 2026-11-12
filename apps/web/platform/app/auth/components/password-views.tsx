/**
 * The forgotten-password screens, without a reset behind them (see
 * `login-views`): the Clerk pages (Global) and the provider pages (EU and
 * self-hosted on Zitadel, ADR SEC-016) both render these.
 */

import { Button } from '@weldsuite/ui/components/button';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import { Check, KeyRound, Loader2, Lock, Mail } from 'lucide-react';
import { Link } from '@/lib/router';
import { getTranslations } from '@/lib/i18n';
import {
  DEFAULT_PASSWORD_POLICY,
  meetsPasswordPolicy,
  PasswordRequirementList,
  type PasswordPolicy,
} from './password-requirements';

const FIELD_CLASS =
  'pl-10 !h-[40px] !border-gray-300 !bg-white text-gray-900 !text-[14px] !ring-0 !ring-offset-0 focus:!ring-0 focus:!ring-offset-0 focus-visible:!ring-0 focus-visible:!ring-offset-0 focus:!border-gray-400';

function ErrorBanner({ error }: Readonly<{ error: string | null }>) {
  if (!error) return null;
  return (
    <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-xl text-sm text-red-600">
      {error}
    </div>
  );
}

function RememberPasswordFooter({ label, signIn }: Readonly<{ label: string; signIn: string }>) {
  return (
    <div className="absolute bottom-6 left-0 right-0 text-center">
      <p className="text-sm text-gray-600">
        {label}{' '}
        <Link
          href="/auth/login"
          className="text-gray-900 hover:text-gray-700 font-medium"
        >
          {signIn}
        </Link>
      </p>
    </div>
  );
}

export interface ForgotPasswordFormViewProps {
  email: string;
  error: string | null;
  isLoading: boolean;
  isLoaded: boolean;
  onEmailChange: (email: string) => void;
  onSubmit: (e: React.FormEvent) => void;
}

/** "Forgot your password?": the address to send a reset code to. */
export function ForgotPasswordFormView({
  email,
  error,
  isLoading,
  isLoaded,
  onEmailChange,
  onSubmit,
}: Readonly<ForgotPasswordFormViewProps>) {
  const t = getTranslations('common');
  return (
    <div className="min-h-screen bg-white flex relative">
      <div className="flex-1 flex flex-col justify-center px-8 py-12 lg:px-16">
        <div className="w-full max-w-[448px] mx-auto">
          <div className="mb-[32px]">
            <h1 className="text-[26px] font-semibold text-gray-900 mb-2">
              {t.auth.forgotPassword.title}
            </h1>
            <p className="text-gray-600">
              {t.auth.forgotPassword.subtitle}
            </p>
          </div>

          <ErrorBanner error={error} />

          <form onSubmit={onSubmit} className="space-y-[25px]">
            <div>
              <Label htmlFor="email" className="mb-2 block text-gray-900">{t.auth.forgotPassword.emailLabel}</Label>
              <div className="relative">
                <Mail className="absolute left-3.5 top-1/2 -translate-y-[calc(50%-1px)] h-[17px] w-[17px] text-gray-400 pointer-events-none" />
                <Input
                  id="email"
                  type="email"
                  inputMode="email"
                  autoComplete="email"
                  placeholder={t.auth.forgotPassword.emailPlaceholder}
                  value={email}
                  onChange={(e) => onEmailChange(e.target.value)}
                  required
                  disabled={isLoading}
                  className="pl-10 !h-[40px] !border-gray-300 !bg-white text-gray-900 !text-[14px] selection:bg-blue-200 selection:text-gray-900 !ring-0 !ring-offset-0 focus:!ring-0 focus:!ring-offset-0 focus-visible:!ring-0 focus-visible:!ring-offset-0 focus:!border-gray-400"
                />
              </div>
            </div>

            <Button
              type="submit"
              disabled={isLoading || !isLoaded}
              className="w-full h-[42px] shadow-none rounded-[calc(var(--radius)+1px)] bg-black hover:bg-black/90 text-white text-[14px]"
              size="lg"
            >
              {isLoading ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  {t.auth.forgotPassword.sending}
                </>
              ) : (
                t.auth.forgotPassword.sendResetCode
              )}
            </Button>
          </form>
        </div>
      </div>

      <RememberPasswordFooter label={t.auth.forgotPassword.rememberPassword} signIn={t.auth.forgotPassword.signIn} />
    </div>
  );
}

export interface ForgotPasswordSentViewProps {
  email: string;
  /** "Enter reset code". */
  onContinue: () => void;
  /** "Try a different email". */
  onRetry: () => void;
}

/** "Check your email": said whether or not an account has the address. */
export function ForgotPasswordSentView({ email, onContinue, onRetry }: Readonly<ForgotPasswordSentViewProps>) {
  const t = getTranslations('common');
  const [beforeEmail, afterEmail] = t.auth.forgotPassword.success.description.split('{email}');
  const steps = [
    t.auth.forgotPassword.success.step1,
    t.auth.forgotPassword.success.step2,
    t.auth.forgotPassword.success.step3,
  ];
  return (
    <div className="min-h-screen bg-white flex relative">
      <div className="flex-1 flex flex-col justify-center px-8 py-12 lg:px-16">
        <div className="w-full max-w-[448px] mx-auto">
          <div className="mb-[32px]">
            <h1 className="text-[26px] font-semibold text-gray-900 mb-2">
              {t.auth.forgotPassword.success.title}
            </h1>
            <p className="text-gray-600">
              {beforeEmail}<span className="font-medium text-gray-900">{email}</span>{afterEmail}
            </p>
          </div>

          <div className="bg-gray-50 border border-gray-200 rounded-xl p-4 mb-6">
            <h3 className="font-semibold text-gray-900 mb-3">{t.auth.forgotPassword.success.whatNext}</h3>
            <div className="space-y-2">
              {steps.map((step) => (
                <div key={step} className="flex gap-3">
                  <div className="flex-shrink-0 w-5 h-5 rounded-full bg-gray-100 flex items-center justify-center mt-0.5">
                    <Check className="h-3 w-3 text-gray-700" />
                  </div>
                  <p className="text-sm text-gray-600">
                    {step}
                  </p>
                </div>
              ))}
            </div>
          </div>

          <Button
            onClick={onContinue}
            className="w-full h-[42px] shadow-none rounded-[calc(var(--radius)+1px)] bg-black hover:bg-black/90 text-white text-[14px]"
            size="lg"
          >
            {t.auth.forgotPassword.success.enterResetCode}
          </Button>

          <div className="mt-4">
            <Button
              variant="outline"
              onClick={onRetry}
              className="w-full h-[42px] shadow-none rounded-[calc(var(--radius)+1px)] text-[14px]"
              size="lg"
            >
              {t.auth.forgotPassword.success.tryDifferentEmail}
            </Button>
          </div>
        </div>
      </div>

      <RememberPasswordFooter label={t.auth.forgotPassword.rememberPassword} signIn={t.auth.forgotPassword.signIn} />
    </div>
  );
}

export interface ResetPasswordFormViewProps {
  code: string;
  password: string;
  confirmPassword: string;
  error: string | null;
  isLoading: boolean;
  isLoaded: boolean;
  passwordPolicy?: PasswordPolicy;
  /** The code field takes digits only (Clerk's six); off for a provider whose codes have letters. */
  numericCode?: boolean;
  onCodeChange: (code: string) => void;
  onPasswordChange: (password: string) => void;
  onConfirmPasswordChange: (password: string) => void;
  onSubmit: (e: React.FormEvent) => void;
}

/** "Reset your password": the emailed code and the new password, typed twice. */
export function ResetPasswordFormView({
  code,
  password,
  confirmPassword,
  error,
  isLoading,
  isLoaded,
  passwordPolicy = DEFAULT_PASSWORD_POLICY,
  numericCode = true,
  onCodeChange,
  onPasswordChange,
  onConfirmPasswordChange,
  onSubmit,
}: Readonly<ResetPasswordFormViewProps>) {
  const t = getTranslations('common');
  const passwordOk = meetsPasswordPolicy(password, passwordPolicy);
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

          <ErrorBanner error={error} />

          <form onSubmit={onSubmit} className="space-y-[20px]">
            <div>
              <Label htmlFor="code" className="mb-2 block text-gray-900">{t.auth.resetPassword.resetCodeLabel}</Label>
              <div className="relative">
                <KeyRound className="absolute left-3.5 top-1/2 -translate-y-1/2 h-[17px] w-[17px] text-gray-400 pointer-events-none" />
                <Input
                  id="code"
                  type="text"
                  inputMode={numericCode ? 'numeric' : 'text'}
                  autoComplete="one-time-code"
                  placeholder={numericCode ? t.auth.resetPassword.resetCodePlaceholder : t.auth.resetPassword.resetCodePlaceholderAny}
                  value={code}
                  onChange={(e) => onCodeChange(e.target.value)}
                  required
                  disabled={isLoading}
                  className={`${FIELD_CLASS} tracking-widest`}
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
                  onChange={(e) => onPasswordChange(e.target.value)}
                  required
                  disabled={isLoading}
                  className={FIELD_CLASS}
                />
              </div>

              {/* Password requirements */}
              <PasswordRequirementList password={password} policy={passwordPolicy} />
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
                  onChange={(e) => onConfirmPasswordChange(e.target.value)}
                  required
                  disabled={isLoading}
                  className={FIELD_CLASS}
                />
              </div>
              {confirmPassword && password !== confirmPassword && (
                <p className="text-xs text-red-500 mt-1">{t.auth.resetPassword.passwordsDoNotMatch}</p>
              )}
            </div>

            <Button
              type="submit"
              disabled={isLoading || !isLoaded || (!!password && !passwordOk) || password !== confirmPassword || !code}
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

      <RememberPasswordFooter label={t.auth.resetPassword.rememberPassword} signIn={t.auth.resetPassword.signIn} />
    </div>
  );
}
