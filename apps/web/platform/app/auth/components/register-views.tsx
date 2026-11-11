/**
 * The sign-up screens, without a sign-up behind them (see `login-views`):
 * the Clerk page (Global) and the provider sign-up page (EU and self-hosted
 * on Zitadel, ADR SEC-016) both render these.
 */

import { useState } from 'react';
import { Button } from '@weldsuite/ui/components/button';
import { Input } from '@weldsuite/ui/components/input';
import { InputOTP, InputOTPGroup, InputOTPSlot } from '@weldsuite/ui/components/input-otp';
import { Label } from '@weldsuite/ui/components/label';
import { REGEXP_ONLY_DIGITS, REGEXP_ONLY_DIGITS_AND_CHARS } from 'input-otp';
import { ChevronLeft, Eye, EyeOff, Loader2, Lock, Mail, User } from 'lucide-react';
import { Link } from '@/lib/router';
import { getTranslations } from '@/lib/i18n';
import { GoogleIcon, type EmailCodeFormat, type ProviderButton } from './login-views';
import {
  DEFAULT_PASSWORD_POLICY,
  meetsPasswordPolicy,
  PasswordRequirementList,
  type PasswordPolicy,
} from './password-requirements';

const FIELD_CLASS =
  '!h-[40px] !border-gray-300 !bg-white text-gray-900 !text-[14px] selection:bg-blue-200 selection:text-gray-900 !ring-0 !ring-offset-0 focus:!ring-0 focus:!ring-offset-0 focus-visible:!ring-0 focus-visible:!ring-offset-0 focus:!border-gray-400';

/** A password field's show/hide toggle. */
function usePasswordReveal() {
  const [shown, setShown] = useState(false);
  return { shown, toggle: () => setShown((value) => !value) };
}

function ErrorBanner({ error }: Readonly<{ error: string | null }>) {
  if (!error) return null;
  return (
    <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-xl text-sm text-red-600">
      {error}
    </div>
  );
}

export interface RegisterFormViewProps {
  /** Arrived with an invitation: the email is fixed, the names are not asked, no Google. */
  invited: boolean;
  firstName: string;
  lastName: string;
  email: string;
  password: string;
  confirmPassword: string;
  error: string | null;
  isLoading: boolean;
  isLoaded: boolean;
  /** "Continue with Google"; left out, the button is not offered. */
  google?: ProviderButton;
  passwordPolicy?: PasswordPolicy;
  signInHref: string;
  onFirstNameChange: (value: string) => void;
  onLastNameChange: (value: string) => void;
  onEmailChange: (value: string) => void;
  onPasswordChange: (value: string) => void;
  onConfirmPasswordChange: (value: string) => void;
  onSubmit: (e: React.FormEvent) => void;
}

/** "Create an account": Google, then names, email and a password typed twice. */
export function RegisterFormView({
  invited,
  firstName,
  lastName,
  email,
  password,
  confirmPassword,
  error,
  isLoading,
  isLoaded,
  google,
  passwordPolicy = DEFAULT_PASSWORD_POLICY,
  signInHref,
  onFirstNameChange,
  onLastNameChange,
  onEmailChange,
  onPasswordChange,
  onConfirmPasswordChange,
  onSubmit,
}: Readonly<RegisterFormViewProps>) {
  const t = getTranslations('common');
  // Local to the view: revealing a password is not the sign-up's business.
  const passwordField = usePasswordReveal();
  const confirmField = usePasswordReveal();
  const passwordOk = meetsPasswordPolicy(password, passwordPolicy);

  return (
    <div className="min-h-screen bg-white flex relative">
      <div className="flex-1 flex flex-col justify-center px-8 py-12 lg:px-16">
        <div className="w-full max-w-[448px] mx-auto">
          <div className="mb-[32px]">
            <h1 className="text-[26px] leading-tight font-semibold text-gray-900 mb-0.5">
              {invited ? t.auth.register.titleWithInvite : t.auth.register.title}
            </h1>
            <p className="text-gray-600">
              {invited
                ? t.auth.register.subtitleWithInvite
                : t.auth.register.subtitle}
            </p>
          </div>

          <ErrorBanner error={error} />

          {/* Google Sign Up - only show if not invitation flow */}
          {!invited && google && (
            <>
              <Button
                type="button"
                variant="outline"
                onClick={google.onClick}
                disabled={google.isLoading || !isLoaded}
                className="w-full h-[42px] shadow-none rounded-[calc(var(--radius)+1px)] !border-gray-300 !bg-white !text-gray-700 hover:!bg-gray-50 hover:!text-gray-700 text-[14px]"
                size="lg"
              >
                {google.isLoading ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <>
                    <GoogleIcon className="h-5 w-5 mr-2" />
                    {t.auth.register.continueWithGoogle}
                  </>
                )}
              </Button>

              {/* Divider */}
              <div className="relative my-6">
                <div className="absolute inset-0 flex items-center">
                  <div className="w-full border-t border-gray-200" />
                </div>
                <div className="relative flex justify-center text-xs uppercase">
                  <span className="bg-white px-2 text-gray-500">{t.auth.register.orDivider}</span>
                </div>
              </div>
            </>
          )}

          <form onSubmit={onSubmit} className="space-y-[20px]">
            {!invited && (
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <Label htmlFor="firstName" className="mb-2 block text-gray-900">{t.auth.register.firstNameLabel}</Label>
                  <div className="relative">
                    <User className="absolute left-3.5 top-1/2 -translate-y-1/2 h-[17px] w-[17px] text-gray-400 pointer-events-none" />
                    <Input
                      id="firstName"
                      type="text"
                      placeholder={t.auth.register.firstNamePlaceholder}
                      value={firstName}
                      onChange={(e) => onFirstNameChange(e.target.value)}
                      disabled={isLoading}
                      className={`pl-10 ${FIELD_CLASS}`}
                    />
                  </div>
                </div>
                <div>
                  <Label htmlFor="lastName" className="mb-2 block text-gray-900">{t.auth.register.lastNameLabel}</Label>
                  <Input
                    id="lastName"
                    type="text"
                    placeholder={t.auth.register.lastNamePlaceholder}
                    value={lastName}
                    onChange={(e) => onLastNameChange(e.target.value)}
                    disabled={isLoading}
                    className={FIELD_CLASS}
                  />
                </div>
              </div>
            )}

            <div>
              <Label htmlFor="email" className="mb-2 block text-gray-900">{t.auth.register.emailLabel}</Label>
              <div className="relative">
                <Mail className="absolute left-3.5 top-1/2 -translate-y-1/2 h-[17px] w-[17px] text-gray-400 pointer-events-none" />
                <Input
                  id="email"
                  type="email"
                  placeholder={t.auth.register.emailPlaceholder}
                  value={email}
                  onChange={(e) => onEmailChange(e.target.value)}
                  required
                  disabled={isLoading || invited}
                  readOnly={invited}
                  className={`pl-10 !h-[40px] !border-gray-300 text-gray-900 !text-[14px] selection:bg-blue-200 selection:text-gray-900 !ring-0 !ring-offset-0 focus:!ring-0 focus:!ring-offset-0 focus-visible:!ring-0 focus-visible:!ring-offset-0 focus:!border-gray-400 ${invited ? '!bg-gray-50 cursor-not-allowed' : '!bg-white'}`}
                />
              </div>
              {invited && (
                <p className="text-xs text-gray-500 mt-1">
                  {t.auth.register.emailAssociatedWithInvitation}
                </p>
              )}
            </div>

            <div>
              <Label htmlFor="password" className="mb-2 block text-gray-900">{t.auth.register.passwordLabel}</Label>
              <div className="relative">
                <Lock className="absolute left-3.5 top-1/2 -translate-y-1/2 h-[17px] w-[17px] text-gray-400 pointer-events-none" />
                <Input
                  id="password"
                  type={passwordField.shown ? 'text' : 'password'}
                  placeholder={t.auth.register.passwordPlaceholder}
                  value={password}
                  onChange={(e) => onPasswordChange(e.target.value)}
                  required
                  disabled={isLoading}
                  className={`pl-10 pr-10 ${FIELD_CLASS}`}
                />
                <Button type="button" variant="ghost" onClick={passwordField.toggle} className="absolute right-3.5 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600">
                  {passwordField.shown ? <EyeOff className="h-[17px] w-[17px]" /> : <Eye className="h-[17px] w-[17px]" />}
                </Button>
              </div>

              {/* Password requirements — same checklist as reset-password so users
                  know why Create Account stays disabled (e.g. missing uppercase).
                  Hidden until a typed password misses one of them. */}
              {password && !passwordOk && (
                <PasswordRequirementList password={password} policy={passwordPolicy} testId="password-requirements" />
              )}
            </div>

            <div>
              <Label htmlFor="confirmPassword" className="mb-2 block text-gray-900">{t.auth.register.confirmPasswordLabel}</Label>
              <div className="relative">
                <Lock className="absolute left-3.5 top-1/2 -translate-y-1/2 h-[17px] w-[17px] text-gray-400 pointer-events-none" />
                <Input
                  id="confirmPassword"
                  type={confirmField.shown ? 'text' : 'password'}
                  placeholder={t.auth.register.confirmPasswordPlaceholder}
                  value={confirmPassword}
                  onChange={(e) => onConfirmPasswordChange(e.target.value)}
                  required
                  disabled={isLoading}
                  className={`pl-10 pr-10 ${FIELD_CLASS}`}
                />
                <Button type="button" variant="ghost" onClick={confirmField.toggle} className="absolute right-3.5 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600">
                  {confirmField.shown ? <EyeOff className="h-[17px] w-[17px]" /> : <Eye className="h-[17px] w-[17px]" />}
                </Button>
              </div>
              {confirmPassword && password !== confirmPassword && (
                <p className="text-xs text-red-500 mt-1">{t.auth.register.passwordsDoNotMatch}</p>
              )}
            </div>

            <Button
              type="submit"
              disabled={isLoading || !isLoaded || (!!password && !passwordOk) || password !== confirmPassword}
              className="w-full h-[42px] shadow-none !mt-[8px] rounded-[calc(var(--radius)+1px)] bg-black hover:bg-black/90 text-white text-[14px]"
              size="lg"
            >
              {isLoading ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  {t.auth.register.creatingAccount}
                </>
              ) : (
                t.auth.register.createAccount
              )}
            </Button>
          </form>
        </div>
      </div>

      <div className="absolute bottom-6 left-0 right-0 text-center">
        <p className="text-sm text-gray-600">
          {t.auth.register.alreadyHaveAccount}{' '}
          <Link
            href={signInHref}
            className="text-gray-900 hover:text-gray-700 font-medium"
          >
            {t.auth.register.signIn}
          </Link>
        </p>
      </div>
    </div>
  );
}

export interface RegisterVerifyViewProps {
  /** Where the code was sent, shown in the subtitle. */
  email: string;
  code: string;
  error: string | null;
  isLoading: boolean;
  isLoaded: boolean;
  /** How the provider writes the code; left out: six characters, unrestricted. */
  format?: EmailCodeFormat;
  onCodeChange: (code: string) => void;
  onSubmit: (e: React.FormEvent) => void;
  onResend: () => void;
  onBack: () => void;
}

/** "Verify your email": the code sent to the address just signed up with. */
export function RegisterVerifyView({
  email,
  code,
  error,
  isLoading,
  isLoaded,
  format,
  onCodeChange,
  onSubmit,
  onResend,
  onBack,
}: Readonly<RegisterVerifyViewProps>) {
  const t = getTranslations('common');
  const [beforeEmail, afterEmail] = t.auth.register.verify.subtitle.split('{email}');
  const length = format?.length ?? 6;
  // Clerk's six digits are typed into an unrestricted field, as before; a
  // provider that states its format gets exactly that.
  const restriction = format
    ? {
        pattern: format.charset === 'alphanumeric' ? REGEXP_ONLY_DIGITS_AND_CHARS : REGEXP_ONLY_DIGITS,
        inputMode: format.charset === 'alphanumeric' ? ('text' as const) : ('numeric' as const),
      }
    : {};
  return (
    <div className="min-h-screen bg-white flex items-center justify-center">
      <div className="w-full max-w-[448px] px-8">
        <div className="mb-4">
          <Button
            type="button"
            variant="ghost"
            onClick={onBack}
            className="text-sm text-gray-600 hover:text-gray-900"
          >
            <ChevronLeft className="inline h-4 w-4" /> {t.auth.register.verify.backToRegistration}
          </Button>
        </div>

        <div className="mb-[32px]">
          <h1 className="text-[26px] font-semibold text-gray-900 mb-2">
            {t.auth.register.verify.title}
          </h1>
          <p className="text-gray-600 text-sm">
            {beforeEmail}<span className="font-medium text-gray-900">{email}</span>{afterEmail}
          </p>
        </div>

        <ErrorBanner error={error} />

        <form onSubmit={onSubmit} className="space-y-[25px]">
          <div>
            <Label className="mb-2 block text-gray-900">{t.auth.register.verify.verificationCodeLabel}</Label>
            <InputOTP
              maxLength={length}
              {...restriction}
              value={code}
              onChange={(value) => {
                onCodeChange(value);
                if (value.length === length) {
                  setTimeout(() => {
                    document.getElementById('verify-btn')?.click();
                  }, 0);
                }
              }}
              disabled={isLoading}
              containerClassName="justify-center"
            >
              <InputOTPGroup className="w-full">
                {Array.from({ length }, (_, index) => (
                  <InputOTPSlot key={index} index={index} className="h-[64px] flex-1 text-2xl" />
                ))}
              </InputOTPGroup>
            </InputOTP>
          </div>

          <Button
            id="verify-btn"
            type="submit"
            disabled={isLoading || !isLoaded || code.length !== length}
            className="w-full h-[42px] shadow-none rounded-[calc(var(--radius)+1px)] bg-black hover:bg-black/90 text-white text-[14px]"
            size="lg"
          >
            {isLoading ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                {t.auth.register.verify.verifying}
              </>
            ) : (
              t.auth.register.verify.verifyEmail
            )}
          </Button>
        </form>

        <div className="mt-4 text-center">
          <Button
            type="button"
            variant="ghost"
            onClick={onResend}
            disabled={isLoading}
            className="text-sm text-gray-600 hover:text-gray-900"
          >
            {t.auth.register.verify.didNotReceive} <span className="font-medium">{t.auth.register.verify.resend}</span>
          </Button>
        </div>

      </div>
    </div>
  );
}
