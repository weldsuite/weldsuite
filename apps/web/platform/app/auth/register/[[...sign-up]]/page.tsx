
import { useState, useEffect } from 'react';
import { useSignUp, useAuth } from '@clerk/clerk-react';
import { useSearchParams, Link } from '@/lib/router';
import { Button } from '@weldsuite/ui/components/button';
import { Input } from '@weldsuite/ui/components/input';
import { InputOTP, InputOTPGroup, InputOTPSlot } from '@weldsuite/ui/components/input-otp';
import { Label } from '@weldsuite/ui/components/label';
import { Loader2, Mail, Lock, User, Eye, EyeOff, ChevronLeft } from 'lucide-react';
import { getClerkErrorMessage } from '../../utils';
import { getTranslations } from '@/lib/i18n';

function GoogleIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
      <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/>
      <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
      <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/>
      <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
    </svg>
  );
}

type RegisterStep = 'form' | 'verify';

export default function RegisterPage() {
  const t = getTranslations('common');
  const searchParams = useSearchParams();
  const prefillEmail = searchParams.get('email');
  const prefillName = searchParams.get('name');

  // Parse name into first/last name if provided
  const [prefillFirstName, prefillLastName] = prefillName
    ? prefillName.split(' ', 2)
    : ['', ''];

  const { signUp, setActive, isLoaded } = useSignUp();
  const { isSignedIn } = useAuth();

  const [step, setStep] = useState<RegisterStep>('form');
  const [isVerifying, setIsVerifying] = useState(false);

  // Redirect if already signed in (but not if we're in the middle of verification)
  useEffect(() => {
    if (isSignedIn && step === 'form' && !isVerifying) {
      // User came to register page while already signed in
      window.location.href = '/onboarding';
    }
  }, [isSignedIn, step, isVerifying]);
  const [firstName, setFirstName] = useState(prefillFirstName || '');
  const [lastName, setLastName] = useState(prefillLastName || '');
  const [email, setEmail] = useState(prefillEmail || '');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [verificationCode, setVerificationCode] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [isGoogleLoading, setIsGoogleLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [passwordErrors, setPasswordErrors] = useState<string[]>([]);
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);

  const handleGoogleSignUp = async () => {
    if (!isLoaded || !signUp) {
      return;
    }

    setError(null);
    setIsGoogleLoading(true);

    try {
      await signUp.authenticateWithRedirect({
        strategy: 'oauth_google',
        redirectUrl: '/auth/sso-callback',
        redirectUrlComplete: '/onboarding',
        // Force Google's account chooser so users can pick which Google
        // account to sign up with instead of Google auto-selecting one.
        oidcPrompt: 'select_account',
      });
    } catch (err) {
      const errorMessage = getClerkErrorMessage(err, t.auth.register.googleSignUpFailed);
      setError(errorMessage);
      setIsGoogleLoading(false);
    }
  };

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

    if (!isLoaded || !signUp) {
      return;
    }

    const pwdErrors = validatePassword(password);
    if (pwdErrors.length > 0) {
      setError(t.auth.register.passwordDoesNotMeetRequirements);
      return;
    }

    if (password !== confirmPassword) {
      setError(t.auth.register.passwordsDoNotMatch);
      return;
    }

    setError(null);
    setIsLoading(true);

    try {
      await signUp.create({
        emailAddress: email,
        password,
        firstName: firstName || undefined,
        lastName: lastName || undefined,
      });

      // Send email verification code
      await signUp.prepareEmailAddressVerification({ strategy: 'email_code' });

      setStep('verify');
      setIsLoading(false);
    } catch (err) {
      const errorMessage = getClerkErrorMessage(err, t.auth.register.registrationFailed);
      setError(errorMessage);
      setIsLoading(false);
    }
  };

  const handleVerification = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!isLoaded || !signUp) {
      return;
    }

    setError(null);
    setIsLoading(true);

    try {
      const result = await signUp.attemptEmailAddressVerification({
        code: verificationCode,
      });

      if (result.status === 'complete') {
        // Set flag to prevent useEffect redirect race condition
        setIsVerifying(true);
        await setActive({ session: result.createdSessionId });
        // Wait for session to be fully established before redirecting
        await new Promise(resolve => setTimeout(resolve, 1000));
        // Use window.location for full page navigation to ensure session cookies are set
        // Redirect to onboarding to create first organization
        window.location.href = '/onboarding';
      } else {
        setError(t.auth.register.verificationFailed);
        setIsLoading(false);
      }
    } catch (err) {
      const errorMessage = getClerkErrorMessage(err, t.auth.register.invalidVerificationCode);
      setError(errorMessage);
      setIsLoading(false);
    }
  };

  const handleResendCode = async () => {
    if (!isLoaded || !signUp) {
      return;
    }

    setError(null);
    setIsLoading(true);

    try {
      await signUp.prepareEmailAddressVerification({ strategy: 'email_code' });
      setIsLoading(false);
    } catch (err) {
      const errorMessage = getClerkErrorMessage(err, t.auth.register.failedToResend);
      setError(errorMessage);
      setIsLoading(false);
    }
  };

  useEffect(() => {
    if (step === 'verify') {
      setTimeout(() => {
        const input = document.querySelector<HTMLInputElement>('[data-input-otp]');
        input?.focus();
        input?.click();
      }, 300);
    }
  }, [step]);

  // Verification step
  if (step === 'verify') {
    return (
      <div className="min-h-screen bg-white flex items-center justify-center">
        <div className="w-full max-w-[448px] px-8">
          <div className="mb-4">
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                setStep('form');
                setVerificationCode('');
                setError(null);
              }}
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
              {t.auth.register.verify.subtitle.split('{email}')[0]}<span className="font-medium text-gray-900">{email}</span>{t.auth.register.verify.subtitle.split('{email}')[1]}
            </p>
          </div>

          {error && (
            <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-xl text-sm text-red-600">
              {error}
            </div>
          )}

          <form onSubmit={handleVerification} className="space-y-[25px]">
            <div>
              <Label className="mb-2 block text-gray-900">{t.auth.register.verify.verificationCodeLabel}</Label>
              <InputOTP
                maxLength={6}
                value={verificationCode}
                onChange={(value) => {
                  setVerificationCode(value);
                  if (value.length === 6) {
                    setTimeout(() => {
                      document.getElementById('verify-btn')?.click();
                    }, 0);
                  }
                }}
                disabled={isLoading}
                containerClassName="justify-center"
              >
                <InputOTPGroup className="w-full">
                  <InputOTPSlot index={0} className="h-[64px] flex-1 text-2xl" />
                  <InputOTPSlot index={1} className="h-[64px] flex-1 text-2xl" />
                  <InputOTPSlot index={2} className="h-[64px] flex-1 text-2xl" />
                  <InputOTPSlot index={3} className="h-[64px] flex-1 text-2xl" />
                  <InputOTPSlot index={4} className="h-[64px] flex-1 text-2xl" />
                  <InputOTPSlot index={5} className="h-[64px] flex-1 text-2xl" />
                </InputOTPGroup>
              </InputOTP>
            </div>

            <Button
              id="verify-btn"
              type="submit"
              disabled={isLoading || !isLoaded || verificationCode.length !== 6}
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
              onClick={handleResendCode}
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

  // Registration form
  return (
    <div className="min-h-screen bg-white flex relative">
      <div className="flex-1 flex flex-col justify-center px-8 py-12 lg:px-16">
        <div className="w-full max-w-[448px] mx-auto">
          <div className="mb-[32px]">
            <h1 className="text-[26px] font-semibold text-gray-900 mb-2">
              {prefillEmail ? t.auth.register.titleWithInvite : t.auth.register.title}
            </h1>
            <p className="text-gray-600">
              {prefillEmail
                ? t.auth.register.subtitleWithInvite
                : t.auth.register.subtitle}
            </p>
          </div>

          {error && (
            <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-xl text-sm text-red-600">
              {error}
            </div>
          )}

          {/* Google Sign Up - only show if not invitation flow */}
          {!prefillEmail && (
            <>
              <Button
                type="button"
                variant="outline"
                onClick={handleGoogleSignUp}
                disabled={isGoogleLoading || !isLoaded}
                className="w-full h-[42px] shadow-none rounded-[calc(var(--radius)+1px)] !border-gray-300 !bg-white !text-gray-700 hover:!bg-gray-50 hover:!text-gray-700 text-[14px]"
                size="lg"
              >
                {isGoogleLoading ? (
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

          <form onSubmit={handleSubmit} className="space-y-[20px]">
            {!prefillEmail && (
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
                      onChange={(e) => setFirstName(e.target.value)}
                      disabled={isLoading}
                      className="pl-10 !h-[40px] !border-gray-300 !bg-white text-gray-900 !text-[14px] selection:bg-blue-200 selection:text-gray-900 !ring-0 !ring-offset-0 focus:!ring-0 focus:!ring-offset-0 focus-visible:!ring-0 focus-visible:!ring-offset-0 focus:!border-gray-400"
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
                    onChange={(e) => setLastName(e.target.value)}
                    disabled={isLoading}
                    className="!h-[40px] !border-gray-300 !bg-white text-gray-900 !text-[14px] selection:bg-blue-200 selection:text-gray-900 !ring-0 !ring-offset-0 focus:!ring-0 focus:!ring-offset-0 focus-visible:!ring-0 focus-visible:!ring-offset-0 focus:!border-gray-400"
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
                  onChange={(e) => setEmail(e.target.value)}
                  required
                  disabled={isLoading || !!prefillEmail}
                  readOnly={!!prefillEmail}
                  className={`pl-10 !h-[40px] !border-gray-300 text-gray-900 !text-[14px] selection:bg-blue-200 selection:text-gray-900 !ring-0 !ring-offset-0 focus:!ring-0 focus:!ring-offset-0 focus-visible:!ring-0 focus-visible:!ring-offset-0 focus:!border-gray-400 ${prefillEmail ? '!bg-gray-50 cursor-not-allowed' : '!bg-white'}`}
                />
              </div>
              {prefillEmail && (
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
                  type={showPassword ? 'text' : 'password'}
                  placeholder={t.auth.register.passwordPlaceholder}
                  value={password}
                  onChange={handlePasswordChange}
                  required
                  disabled={isLoading}
                  className="pl-10 pr-10 !h-[40px] !border-gray-300 !bg-white text-gray-900 !text-[14px] selection:bg-blue-200 selection:text-gray-900 !ring-0 !ring-offset-0 focus:!ring-0 focus:!ring-offset-0 focus-visible:!ring-0 focus-visible:!ring-offset-0 focus:!border-gray-400"
                />
                <Button type="button" variant="ghost" onClick={() => setShowPassword(!showPassword)} className="absolute right-3.5 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600">
                  {showPassword ? <EyeOff className="h-[17px] w-[17px]" /> : <Eye className="h-[17px] w-[17px]" />}
                </Button>
              </div>

            </div>

            <div>
              <Label htmlFor="confirmPassword" className="mb-2 block text-gray-900">{t.auth.register.confirmPasswordLabel}</Label>
              <div className="relative">
                <Lock className="absolute left-3.5 top-1/2 -translate-y-1/2 h-[17px] w-[17px] text-gray-400 pointer-events-none" />
                <Input
                  id="confirmPassword"
                  type={showConfirmPassword ? 'text' : 'password'}
                  placeholder={t.auth.register.confirmPasswordPlaceholder}
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  required
                  disabled={isLoading}
                  className="pl-10 pr-10 !h-[40px] !border-gray-300 !bg-white text-gray-900 !text-[14px] selection:bg-blue-200 selection:text-gray-900 !ring-0 !ring-offset-0 focus:!ring-0 focus:!ring-offset-0 focus-visible:!ring-0 focus-visible:!ring-offset-0 focus:!border-gray-400"
                />
                <Button type="button" variant="ghost" onClick={() => setShowConfirmPassword(!showConfirmPassword)} className="absolute right-3.5 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600">
                  {showConfirmPassword ? <EyeOff className="h-[17px] w-[17px]" /> : <Eye className="h-[17px] w-[17px]" />}
                </Button>
              </div>
              {confirmPassword && password !== confirmPassword && (
                <p className="text-xs text-red-500 mt-1">{t.auth.register.passwordsDoNotMatch}</p>
              )}
            </div>

            <Button
              type="submit"
              disabled={isLoading || !isLoaded || passwordErrors.length > 0 || password !== confirmPassword}
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
            href="/auth/login"
            className="text-gray-900 hover:text-gray-700 font-medium"
          >
            {t.auth.register.signIn}
          </Link>
        </p>
      </div>
    </div>
  );
}
