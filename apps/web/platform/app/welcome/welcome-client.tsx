
import { useEffect, useState } from 'react';
import { Button } from '@weldsuite/ui/components/button';
import { useRouter } from '@/lib/router';
import { PageLoader } from '@/components/page-loader';
import { getTranslations } from '@/lib/i18n';

interface WelcomeClientProps {
  error?: string;
  errorDescription?: string;
}

export function WelcomeClient({ error, errorDescription }: WelcomeClientProps) {
  const [isRedirecting, setIsRedirecting] = useState(false);
  const router = useRouter();
  const t = getTranslations('common');

  useEffect(() => {
    // Don't auto-redirect if there's an error
    if (error) return;

    // Small delay to show the welcome message
    const timer = setTimeout(() => {
      setIsRedirecting(true);
      // Redirect to login page - Clerk will handle authentication
      router.push('/auth/login');
    }, 500);

    return () => clearTimeout(timer);
  }, [error, router]);

  const handleRetry = () => {
    router.push('/auth/login');
  };

  // Show error state if something went wrong
  if (error) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="text-center space-y-4 max-w-md px-4">
          <div className="mx-auto w-12 h-12 rounded-full bg-destructive/10 flex items-center justify-center">
            <svg
              className="w-6 h-6 text-destructive"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
              />
            </svg>
          </div>
          <h1 className="text-2xl font-semibold text-foreground">
            {t.welcome.somethingWentWrong}
          </h1>
          <p className="text-muted-foreground">
            {errorDescription || t.welcome.invitationError}
          </p>
          <Button
            variant="default"
            onClick={handleRetry}
            className="mt-4 px-4 py-2 bg-primary text-primary-foreground rounded-md hover:bg-primary/90 transition-colors"
          >
            {t.welcome.tryAgain}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <PageLoader label={isRedirecting ? t.welcome.redirectingToLogin : t.welcome.settingUpWorkspace} />
  );
}
