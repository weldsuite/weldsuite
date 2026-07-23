
import { Suspense } from 'react';
import { useSearchParams, Link } from '@/lib/router';
import { Button } from '@weldsuite/ui/components/button';
import { Alert, AlertDescription, AlertTitle } from '@weldsuite/ui/components/alert';
import { AlertTriangle, ArrowLeft } from 'lucide-react';
import { PageLoader } from '@/components/page-loader';
import { getTranslations } from '@/lib/i18n';

function AuthErrorContent() {
  const t = getTranslations('common');
  const searchParams = useSearchParams();
  const errorType = searchParams.get('error') || 'Default';

  const errorMessages: Record<string, { title: string; description: string }> = {
    Configuration: t.auth.error.configuration,
    AccessDenied: t.auth.error.accessDenied,
    Verification: t.auth.error.verification,
    CredentialsSignin: t.auth.error.credentialsSignin,
    SessionRequired: t.auth.error.sessionRequired,
    sso_failed: t.auth.error.ssoFailed,
    Default: t.auth.error.default,
  };

  const { title, description } = errorMessages[errorType] || errorMessages.Default;

  return (
    <div className="min-w-sm bg-muted flex w-full max-w-sm flex-col items-center gap-y-4 rounded-lg px-6 py-12">
      <div className="bg-red-100 dark:bg-red-900/30 rounded-full p-3">
        <AlertTriangle className="h-8 w-8 text-red-600 dark:text-red-400" />
      </div>
      <h1 className="text-xl font-semibold text-center">{title}</h1>

      <Alert variant="destructive">
        <AlertTriangle className="h-4 w-4" />
        <AlertTitle>{t.auth.error.alertTitle}</AlertTitle>
        <AlertDescription>{description}</AlertDescription>
      </Alert>

      <Link href="/auth/login" className="w-full mt-4">
        <Button className="w-full">{t.auth.error.tryAgain}</Button>
      </Link>

      <Link href="/" className="w-full">
        <Button variant="ghost" className="w-full">
          <ArrowLeft className="mr-0.5 h-4 w-4" />
          {t.auth.error.goToHome}
        </Button>
      </Link>
    </div>
  );
}

export default function AuthErrorPage() {
  const t = getTranslations('common');
  return (
    <section className="bg-background h-screen">
      <div className="flex h-full items-center justify-center">
        <div className="flex flex-col items-center gap-6 lg:justify-start">
          <Link href="/">
            <img
              src="/weldsuite-logo.svg"
              alt={t.auth.logoAlt}
              title={t.auth.logoAlt}
              className="h-10 dark:invert"
            />
          </Link>

          <Suspense fallback={<PageLoader fullScreen={false} />}>
            <AuthErrorContent />
          </Suspense>
        </div>
      </div>
    </section>
  );
}
