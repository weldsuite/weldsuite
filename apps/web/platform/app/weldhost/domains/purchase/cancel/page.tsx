
import { useSearchParams, useRouter } from '@/lib/router';
import { Card, CardContent, CardHeader, CardTitle } from '@weldsuite/ui/components/card';
import { Button } from '@weldsuite/ui/components/button';
import { Alert, AlertDescription, AlertTitle } from '@weldsuite/ui/components/alert';
import {
  XCircle,
  ArrowRight,
  RotateCcw,
  HelpCircle,
} from 'lucide-react';
import { useI18n } from '@/lib/i18n/provider';

export default function DomainPurchaseCancelPage() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const { t } = useI18n();
  const tc = t.host.purchaseCancel;
  const registrationId = searchParams.get('registration_id');

  return (
    <div className="min-h-screen bg-background">
      <div className="container mx-auto p-8 max-w-4xl space-y-8">
        {/* Cancel Header */}
        <div className="text-center space-y-3">
          <h1 className="text-4xl font-bold tracking-tight">{tc.title}</h1>
          <p className="text-lg text-muted-foreground">
            {tc.subtitle}
          </p>
        </div>

        {/* Main Card */}
        <Card>
          <CardHeader>
            <div className="flex items-center gap-4">
              <div className="h-12 w-12 rounded-full bg-orange-100 dark:bg-orange-900/20 flex items-center justify-center">
                <XCircle className="h-6 w-6 text-orange-600 dark:text-orange-500" />
              </div>
              <div>
                <CardTitle>{tc.noCharges}</CardTitle>
                <p className="text-sm text-muted-foreground mt-1">
                  {tc.noChargesDescription}
                </p>
              </div>
            </div>
          </CardHeader>
        <CardContent className="space-y-6">
          {/* Info Alert */}
          <Alert>
            <HelpCircle className="h-4 w-4" />
            <AlertTitle>{tc.whatHappenedTitle}</AlertTitle>
            <AlertDescription>
              {tc.whatHappenedDescription}
            </AlertDescription>
          </Alert>

          {/* Registration ID */}
          {registrationId && (
            <div className="text-sm text-muted-foreground">
              <p>{tc.registrationId.replace('{id}', registrationId)}</p>
              <p className="mt-1">{tc.tryAgainNote}</p>
            </div>
          )}

          {/* Actions */}
          <div className="flex flex-col gap-3">
            <Button
              size="lg"
              className="w-full"
              onClick={() => router.push('/weldhost/domains/register')}
            >
              <RotateCcw className="mr-2 h-5 w-5" />
              {tc.tryAgain}
            </Button>

            <Button
              variant="outline"
              size="lg"
              className="w-full"
              onClick={() => router.push('/weldhost/domains')}
            >
              {tc.goToDomains}
              <ArrowRight className="ml-2 h-5 w-5" />
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Help Card */}
      <Card>
        <CardHeader>
          <CardTitle>{tc.needHelp}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">
            {tc.needHelpDescription}
          </p>
          <ul className="space-y-2 list-disc list-inside text-sm">
            <li>{tc.helpItems.contactSupport}</li>
            <li>{tc.helpItems.checkAvailability}</li>
            <li>{tc.helpItems.reviewPayment}</li>
            <li>{tc.helpItems.differentPayment}</li>
          </ul>
          <Button variant="outline" className="w-full">
            {tc.contactSupport}
          </Button>
        </CardContent>
      </Card>

      {/* Common Issues */}
      <Card>
        <CardHeader>
          <CardTitle>{tc.commonReasons}</CardTitle>
        </CardHeader>
        <CardContent>
          <ul className="space-y-2 text-sm list-disc list-inside">
            <li>{tc.reasonItems.closedPage}</li>
            <li>{tc.reasonItems.reviewPricing}</li>
            <li>{tc.reasonItems.differentPayment}</li>
            <li>{tc.reasonItems.multipleDomains}</li>
            <li>{tc.reasonItems.verifyAvailability}</li>
          </ul>
        </CardContent>
      </Card>
      </div>
    </div>
  );
}
