
import { useEffect } from 'react';
import { useRouter } from '@/lib/router';
import { track } from '@/lib/analytics';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@weldsuite/ui/components/card';
import { Button } from '@weldsuite/ui/components/button';
import { CheckCircle } from 'lucide-react';
import { PageLoader } from '@/components/page-loader';
import { getTranslations } from '@/lib/i18n';

export default function CheckoutSuccessPage() {
  const router = useRouter();
  const t = getTranslations('navigation');

  useEffect(() => {
    track('Checkout Completed');

    // Redirect to settings billing after 3 seconds
    const timer = setTimeout(() => {
      // Close the current window/tab if it was opened for checkout
      if (window.opener) {
        window.close();
      } else {
        // Otherwise redirect to home and open settings
        router.push('/');
        // Give it a moment to load, then programmatically open settings
        setTimeout(() => {
          const event = new KeyboardEvent('keydown', {
            key: ',',
            code: 'Comma',
            metaKey: true,
            ctrlKey: true,
            bubbles: true
          });
          document.dispatchEvent(event);
        }, 500);
      }
    }, 3000);

    return () => clearTimeout(timer);
  }, [router]);

  return (
    <div className="flex items-center justify-center min-h-screen bg-background p-4">
      <Card className="max-w-md w-full">
        <CardHeader className="text-center">
          <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-green-100 dark:bg-green-900">
            <CheckCircle className="h-6 w-6 text-green-600 dark:text-green-400" />
          </div>
          <CardTitle className="text-2xl">{t.checkoutSuccess.title}</CardTitle>
          <CardDescription>
            {t.checkoutSuccess.description}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="text-center space-y-2">
            <p className="text-sm text-muted-foreground">
              {t.checkoutSuccess.redirecting}
            </p>
            <PageLoader fullScreen={false} label="" className="min-h-0" />
          </div>
          <Button
            variant="outline"
            className="w-full"
            onClick={() => {
              if (window.opener) {
                window.close();
              } else {
                router.push('/');
              }
            }}
          >
            {t.checkoutSuccess.close}
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
