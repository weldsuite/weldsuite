
import { useState } from 'react';
import { useSignIn } from '@clerk/clerk-react';
import { useRouter, Link } from '@/lib/router';
import { Button } from '@weldsuite/ui/components/button';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import { Loader2, Mail, Check } from 'lucide-react';
import { getTranslations } from '@/lib/i18n';

export default function ForgotPasswordPage() {
  const t = getTranslations('common');
  const router = useRouter();
  const { signIn, isLoaded } = useSignIn();

  const [email, setEmail] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!isLoaded || !signIn) {
      return;
    }

    setError(null);
    setIsLoading(true);

    try {
      await signIn.create({
        strategy: 'reset_password_email_code',
        identifier: email,
      });

      setSuccess(true);
      setIsLoading(false);
    } catch (err: any) {
      // Always show success to prevent email enumeration
      setSuccess(true);
      setIsLoading(false);
    }
  };

  if (success) {
    return (
      <div className="min-h-screen bg-white flex relative">
        <div className="flex-1 flex flex-col justify-center px-8 py-12 lg:px-16">
          <div className="w-full max-w-[448px] mx-auto">
            <div className="mb-[32px]">
              <h1 className="text-[26px] font-semibold text-gray-900 mb-2">
                {t.auth.forgotPassword.success.title}
              </h1>
              <p className="text-gray-600">
                {t.auth.forgotPassword.success.description.split('{email}')[0]}<span className="font-medium text-gray-900">{email}</span>{t.auth.forgotPassword.success.description.split('{email}')[1]}
              </p>
            </div>

            <div className="bg-gray-50 border border-gray-200 rounded-xl p-4 mb-6">
              <h3 className="font-semibold text-gray-900 mb-3">{t.auth.forgotPassword.success.whatNext}</h3>
              <div className="space-y-2">
                <div className="flex gap-3">
                  <div className="flex-shrink-0 w-5 h-5 rounded-full bg-gray-100 flex items-center justify-center mt-0.5">
                    <Check className="h-3 w-3 text-gray-700" />
                  </div>
                  <p className="text-sm text-gray-600">
                    {t.auth.forgotPassword.success.step1}
                  </p>
                </div>
                <div className="flex gap-3">
                  <div className="flex-shrink-0 w-5 h-5 rounded-full bg-gray-100 flex items-center justify-center mt-0.5">
                    <Check className="h-3 w-3 text-gray-700" />
                  </div>
                  <p className="text-sm text-gray-600">
                    {t.auth.forgotPassword.success.step2}
                  </p>
                </div>
                <div className="flex gap-3">
                  <div className="flex-shrink-0 w-5 h-5 rounded-full bg-gray-100 flex items-center justify-center mt-0.5">
                    <Check className="h-3 w-3 text-gray-700" />
                  </div>
                  <p className="text-sm text-gray-600">
                    {t.auth.forgotPassword.success.step3}
                  </p>
                </div>
              </div>
            </div>

            <Button
              onClick={() => router.push(`/auth/reset-password?email=${encodeURIComponent(email)}`)}
              className="w-full h-[42px] shadow-none rounded-[calc(var(--radius)+1px)] bg-black hover:bg-black/90 text-white text-[14px]"
              size="lg"
            >
              {t.auth.forgotPassword.success.enterResetCode}
            </Button>

            <div className="mt-4">
              <Button
                variant="outline"
                onClick={() => {
                  setSuccess(false);
                  setEmail('');
                }}
                className="w-full h-[42px] shadow-none rounded-[calc(var(--radius)+1px)] text-[14px]"
                size="lg"
              >
                {t.auth.forgotPassword.success.tryDifferentEmail}
              </Button>
            </div>
          </div>
        </div>

        <div className="absolute bottom-6 left-0 right-0 text-center">
          <p className="text-sm text-gray-600">
            {t.auth.forgotPassword.rememberPassword}{' '}
            <Link
              href="/auth/login"
              className="text-gray-900 hover:text-gray-700 font-medium"
            >
              {t.auth.forgotPassword.signIn}
            </Link>
          </p>
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
              {t.auth.forgotPassword.title}
            </h1>
            <p className="text-gray-600">
              {t.auth.forgotPassword.subtitle}
            </p>
          </div>

          {error && (
            <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-xl text-sm text-red-600">
              {error}
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-[25px]">
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
                  onChange={(e) => setEmail(e.target.value)}
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

      <div className="absolute bottom-6 left-0 right-0 text-center">
        <p className="text-sm text-gray-600">
          {t.auth.forgotPassword.rememberPassword}{' '}
          <Link
            href="/auth/login"
            className="text-gray-900 hover:text-gray-700 font-medium"
          >
            {t.auth.forgotPassword.signIn}
          </Link>
        </p>
      </div>
    </div>
  );
}
