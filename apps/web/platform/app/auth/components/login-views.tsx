/**
 * The sign-in screens, without a sign-in behind them: markup, labels and
 * events only. The Clerk page (Global) and the provider sign-in page (EU and
 * self-hosted on Zitadel, ADR SEC-016) both render these, so the two editions
 * show the same screens.
 */

import { Button } from '@weldsuite/ui/components/button';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import { InputOTP, InputOTPGroup, InputOTPSlot } from '@weldsuite/ui/components/input-otp';
import { REGEXP_ONLY_DIGITS, REGEXP_ONLY_DIGITS_AND_CHARS } from 'input-otp';
import { Building2, ChevronLeft, Eye, EyeOff, Fingerprint, KeyRound, Loader2, Lock, Mail } from 'lucide-react';
import { Link } from '@/lib/router';
import { getTranslations } from '@/lib/i18n';

// Auth pages are always light, so pin the OTP slots to the white theme instead of the app theme tokens.
const OTP_SLOT_CLASS =
  'h-[52px] flex-1 -ml-px border-l first:ml-0 bg-white dark:bg-white border-gray-200 text-[20px] font-medium text-gray-900 shadow-none data-[active=true]:border-gray-900 data-[active=true]:ring-gray-900/10 [&_.animate-caret-blink]:h-6 [&_.animate-caret-blink]:bg-gray-900 aria-invalid:border-red-500 data-[active=true]:aria-invalid:border-red-500 data-[active=true]:aria-invalid:ring-red-500/15';

const PROVIDER_BUTTON_CLASS =
  'w-full h-[42px] shadow-none rounded-[calc(var(--radius)+1px)] !border-gray-300 !bg-white !text-gray-700 hover:!bg-gray-50 hover:!text-gray-700 text-[14px]';

export function LoginErrorBanner({ error }: Readonly<{ error: string | null }>) {
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

export function GoogleIcon({ className }: Readonly<{ className?: string }>) {
  return (
    <svg className={className} viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
      <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/>
      <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
      <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/>
      <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
    </svg>
  );
}

export interface TwoFactorStepProps {
  error: string | null;
  useBackupCode: boolean;
  twoFactorCode: string;
  isLoading: boolean;
  isLoaded: boolean;
  /** Offer "use a backup code instead". Off where the provider has no backup codes. */
  backupCodes?: boolean;
  onSubmit: (e: React.FormEvent) => void;
  onCodeChange: (code: string) => void;
  onToggleBackupCode: () => void;
  onBack: () => void;
}

export function TwoFactorStep({
  error,
  useBackupCode,
  twoFactorCode,
  isLoading,
  isLoaded,
  backupCodes = true,
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

          {backupCodes && (
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
          )}

          <div className={`${backupCodes ? 'mt-4' : 'mt-6'} text-center`}>
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

export interface SsoStepProps {
  email: string;
  /** The email came with an invitation and cannot be changed. */
  emailLocked: boolean;
  error: string | null;
  isLoading: boolean;
  isLoaded: boolean;
  onEmailChange: (email: string) => void;
  onSubmit: (e: React.FormEvent) => void;
  onBack: () => void;
}

/** Single sign-on: the work email decides which company identity provider the person is sent to. */
export function SsoStep({
  email,
  emailLocked,
  error,
  isLoading,
  isLoaded,
  onEmailChange,
  onSubmit,
  onBack,
}: Readonly<SsoStepProps>) {
  const t = getTranslations('common');
  return (
    <div className="min-h-screen bg-white flex relative">
      <div className="flex-1 flex flex-col justify-center px-8 py-12 lg:px-16">
        <div className="w-full max-w-[420px] mx-auto">
          <div className="mb-5">
            <Button
              type="button"
              variant="ghost"
              onClick={onBack}
              className="text-gray-500 hover:text-black hover:underline underline-offset-4 inline-flex items-center gap-1 h-auto p-0 has-[>svg]:px-0 hover:bg-transparent dark:hover:bg-transparent transition-colors"
            >
              <ChevronLeft className="h-4 w-4 -ml-[4px]" />
              {t.auth.login.sso.backToLogin}
            </Button>
          </div>

          <div className="mb-[32px]">
            <h1 className="text-[26px] font-semibold text-gray-900 mb-2">{t.auth.login.sso.title}</h1>
            <p className="text-gray-600">{t.auth.login.sso.subtitle}</p>
          </div>

          <LoginErrorBanner error={error} />

          <form onSubmit={onSubmit} className="space-y-[25px]">
            <div>
              <Label htmlFor="sso-email" className="mb-2 block text-gray-900">{t.auth.login.sso.emailLabel}</Label>
              <div className="relative">
                <Mail className="absolute left-3.5 top-1/2 -translate-y-1/2 h-[17px] w-[17px] text-gray-400 pointer-events-none" />
                <Input
                  id="sso-email"
                  type="email"
                  autoComplete="email"
                  placeholder={t.auth.login.sso.emailPlaceholder}
                  value={email}
                  onChange={(e) => onEmailChange(e.target.value)}
                  required
                  disabled={isLoading || emailLocked}
                  readOnly={emailLocked}
                  autoFocus={!emailLocked}
                  className={`pl-10 !h-[40px] !border-gray-300 text-gray-900 !text-[14px] selection:bg-blue-200 selection:text-gray-900 !ring-0 !ring-offset-0 focus:!ring-0 focus:!ring-offset-0 focus-visible:!ring-0 focus-visible:!ring-offset-0 focus:!border-gray-400 ${emailLocked ? '!bg-gray-50 cursor-not-allowed' : '!bg-white'}`}
                />
              </div>
            </div>

            <Button
              type="submit"
              disabled={isLoading || !isLoaded || !email.trim()}
              className="w-full h-[42px] shadow-none rounded-[calc(var(--radius)+1px)] bg-black hover:bg-black/90 text-white text-[14px]"
              size="lg"
            >
              {isLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : t.auth.login.sso.continue}
            </Button>
          </form>
        </div>
      </div>
    </div>
  );
}

/** How a provider writes the codes it emails: Clerk sends six digits, Zitadel what its instance is set to. */
export interface EmailCodeFormat {
  length: number;
  charset: 'digits' | 'alphanumeric';
}

const SIX_DIGITS: EmailCodeFormat = { length: 6, charset: 'digits' };

export interface EmailCodeStepProps {
  /** Where the code was sent, shown in the subtitle. */
  email: string;
  code: string;
  error: string | null;
  isLoading: boolean;
  isLoaded: boolean;
  format?: EmailCodeFormat;
  /** Every edit, so the page can clear its error. */
  onCodeChange: (code: string) => void;
  /** The button, and the last character typed. */
  onSubmit: (code: string) => void;
  onResend: () => void;
  onBack: () => void;
}

/** "Verify your email": the code the provider just emailed, as a first or a second factor. */
export function EmailCodeStep({
  email,
  code,
  error,
  isLoading,
  isLoaded,
  format = SIX_DIGITS,
  onCodeChange,
  onSubmit,
  onResend,
  onBack,
}: Readonly<EmailCodeStepProps>) {
  const t = getTranslations('common');
  const [beforeEmail, afterEmail] = t.auth.login.emailVerify.subtitle.split('{email}');
  const letters = format.charset === 'alphanumeric';
  return (
    <div className="min-h-screen bg-white flex relative">
      <div className="flex-1 flex flex-col justify-center px-8 py-12 lg:px-16">
        <div className="w-full max-w-[420px] mx-auto">
          <div className="mb-5">
            <Button
              type="button"
              variant="ghost"
              onClick={onBack}
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
              {beforeEmail}<span className="font-medium text-gray-900">{email}</span>{afterEmail}
            </p>
          </div>

          <form
            onSubmit={(e) => {
              e.preventDefault();
              onSubmit(code);
            }}
            className="space-y-[25px]"
          >
            <div>
              <InputOTP
                maxLength={format.length}
                pattern={letters ? REGEXP_ONLY_DIGITS_AND_CHARS : REGEXP_ONLY_DIGITS}
                inputMode={letters ? 'text' : 'numeric'}
                value={code}
                onChange={(value) => {
                  onCodeChange(value);
                  if (value.length === format.length) onSubmit(value);
                }}
                disabled={isLoading}
                autoFocus
              >
                <InputOTPGroup className="w-full">
                  {Array.from({ length: format.length }, (_, index) => (
                    <InputOTPSlot key={index} index={index} className={OTP_SLOT_CLASS} aria-invalid={!!error} />
                  ))}
                </InputOTPGroup>
              </InputOTP>
              <OtpFieldError error={error} />
            </div>

            <Button
              type="submit"
              disabled={isLoading || !isLoaded || !code}
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
              onClick={onResend}
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

/** One of the buttons above the email form; left out, the button is not offered. */
export interface ProviderButton {
  isLoading: boolean;
  onClick: () => void;
}

export interface LoginCredentialsViewProps {
  email: string;
  password: string;
  /** The email came with an invitation and cannot be changed. */
  emailLocked: boolean;
  error: string | null;
  isLoading: boolean;
  isLoaded: boolean;
  google?: ProviderButton;
  passkey?: ProviderButton;
  sso?: ProviderButton;
  /** Let the browser list passkeys in the email field's autofill dropdown. */
  passkeyAutofill?: boolean;
  /** "Forgot password?" next to the password label; left out, no link. */
  forgotPasswordHref?: string;
  /** "Need an account? Sign up" under the form; left out, no link. */
  signUpHref?: string;
  showPassword: boolean;
  onEmailChange: (email: string) => void;
  onPasswordChange: (password: string) => void;
  onToggleShowPassword: () => void;
  onSubmit: (e: React.FormEvent) => void;
}

/** "Welcome back": the provider buttons, then email and password. */
export function LoginCredentialsView({
  email,
  password,
  emailLocked,
  error,
  isLoading,
  isLoaded,
  google,
  passkey,
  sso,
  passkeyAutofill = false,
  forgotPasswordHref,
  signUpHref,
  showPassword,
  onEmailChange,
  onPasswordChange,
  onToggleShowPassword,
  onSubmit,
}: Readonly<LoginCredentialsViewProps>) {
  const t = getTranslations('common');
  const providers = [
    google && { key: 'google', button: google, icon: <GoogleIcon className="h-5 w-5 mr-2" />, label: t.auth.login.continueWithGoogle },
    passkey && { key: 'passkey', button: passkey, icon: <Fingerprint className="h-5 w-5 mr-2" />, label: t.auth.login.signInWithPasskey },
    sso && { key: 'sso', button: sso, icon: <Building2 className="h-5 w-5 mr-2" />, label: t.auth.login.signInWithSso },
  ].filter((provider) => !!provider);

  return (
    <div className="min-h-screen bg-white flex relative">
      {/* Login Form */}
      <div className="flex-1 flex flex-col justify-center px-8 py-12 lg:px-16">
        <div className="w-full max-w-[448px] mx-auto">
          <div className="mb-[32px]">
            <h1 className="text-[26px] leading-tight font-semibold text-gray-900 mb-0.5">
              {t.auth.login.title}
            </h1>
            <p className="text-gray-600">
              {t.auth.login.subtitle}
            </p>
          </div>

          <LoginErrorBanner error={error} />

          {providers.map(({ key, button, icon, label }, index) => (
            <Button
              key={key}
              type="button"
              variant="outline"
              onClick={button.onClick}
              disabled={button.isLoading || !isLoaded}
              className={index === 0 ? PROVIDER_BUTTON_CLASS : `${PROVIDER_BUTTON_CLASS} mt-3`}
              size="lg"
            >
              {button.isLoading ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <>
                  {icon}
                  {label}
                </>
              )}
            </Button>
          ))}

          {/* Divider */}
          {providers.length > 0 && (
            <div className="relative my-6">
              <div className="absolute inset-0 flex items-center">
                <div className="w-full border-t border-gray-200" />
              </div>
              <div className="relative flex justify-center text-xs uppercase">
                <span className="bg-white px-2 text-gray-500">{t.auth.login.orDivider}</span>
              </div>
            </div>
          )}

          <form onSubmit={onSubmit} className="space-y-[25px]">
            <div>
              <Label htmlFor="email" className="mb-2 block text-gray-900">{t.auth.login.emailLabel}</Label>
              <div className="relative">
                <Mail className="absolute left-3.5 top-1/2 -translate-y-[calc(50%-1px)] h-[17px] w-[17px] text-gray-400 pointer-events-none" />
                <Input
                  id="email"
                  type="text"
                  inputMode="email"
                  // `webauthn` lets the browser list passkeys in this field's
                  // autofill dropdown (the page's passkey autofill request).
                  autoComplete={passkeyAutofill ? 'username webauthn' : 'username'}
                  placeholder={t.auth.login.emailPlaceholder}
                  value={email}
                  onChange={(e) => onEmailChange(e.target.value)}
                  required
                  disabled={isLoading || emailLocked}
                  readOnly={emailLocked}
                  className={`pl-10 !h-[40px] !border-gray-300 text-gray-900 !text-[14px] selection:bg-blue-200 selection:text-gray-900 !ring-0 !ring-offset-0 focus:!ring-0 focus:!ring-offset-0 focus-visible:!ring-0 focus-visible:!ring-offset-0 focus:!border-gray-400 ${emailLocked ? '!bg-gray-50 cursor-not-allowed' : '!bg-white'}`}
                />
              </div>
              {emailLocked && (
                <p className="text-xs text-gray-500 mt-1">
                  {t.auth.login.signInWithInvitationHint}
                </p>
              )}
            </div>

            <div>
              <div className="flex items-center justify-between mb-2">
                <Label htmlFor="password" className="text-gray-900">{t.auth.login.passwordLabel}</Label>
                {forgotPasswordHref && (
                  <Link
                    href={forgotPasswordHref}
                    className="text-xs text-gray-900 hover:text-gray-700 font-medium"
                  >
                    {t.auth.login.forgotPassword}
                  </Link>
                )}
              </div>
              <div className="relative">
                <Lock className="absolute left-3.5 top-1/2 -translate-y-1/2 h-[17px] w-[17px] text-gray-400 pointer-events-none" />
                <Input
                  id="password"
                  type={showPassword ? 'text' : 'password'}
                  placeholder={t.auth.login.passwordPlaceholder}
                  value={password}
                  onChange={(e) => onPasswordChange(e.target.value)}
                  required
                  disabled={isLoading}
                  autoFocus={emailLocked}
                  className="pl-10 pr-10 !h-[40px] !border-gray-300 !bg-white text-gray-900 !text-[14px] selection:bg-blue-200 selection:text-gray-900 !ring-0 !ring-offset-0 focus:!ring-0 focus:!ring-offset-0 focus-visible:!ring-0 focus-visible:!ring-offset-0 focus:!border-gray-400"
                />
                <button
                  type="button"
                  onClick={onToggleShowPassword}
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

      {signUpHref && (
        <div className="absolute bottom-6 left-0 right-0 text-center">
          <p className="text-sm text-gray-600">
            {t.auth.login.needAccount}{' '}
            <Link
              href={signUpHref}
              className="text-gray-900 hover:text-gray-700 font-medium"
            >
              {t.auth.login.signUp}
            </Link>
          </p>
        </div>
      )}
    </div>
  );
}
