
import { useEffect } from 'react';
import { useRouter } from '@/lib/router';
import { track } from '@/lib/analytics';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@weldsuite/ui/components/card';
import { Button } from '@weldsuite/ui/components/button';
import { XCircle } from 'lucide-react';
import { getTranslations } from '@/lib/i18n';

export default function CheckoutCancelPage() {
  const router = useRouter();
  const t = getTranslations('navigation');

  useEffect(() => {
    track('Checkout Cancelled');

    // Redirect after 5 seconds
    const timer = setTimeout(() => {
      if (window.opener) {
        window.close();
      } else {
        router.push('/');
      }
    }, 5000);

    return () => clearTimeout(timer);
  }, [router]);

  return (
    <div className="flex items-center justify-center min-h-screen bg-background p-4">
      <Card className="max-w-md w-full">
        <CardHeader className="text-center">
          <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-yellow-100 dark:bg-yellow-900">
            <XCircle className="h-6 w-6 text-yellow-600 dark:text-yellow-400" />
          </div>
          <CardTitle className="text-2xl">{t.checkoutCancel.title}</CardTitle>
          <CardDescription>
            {t.checkoutCancel.description}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground text-center">
            {t.checkoutCancel.hint}
          </p>
          <div className="space-y-2">
            <Button
              className="w-full"
              onClick={() => {
                if (window.opener) {
                  window.close();
                } else {
                  router.push('/');
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
              }}
            >
              {t.checkoutCancel.backToSettings}
            </Button>
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
              {t.checkoutCancel.close}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
