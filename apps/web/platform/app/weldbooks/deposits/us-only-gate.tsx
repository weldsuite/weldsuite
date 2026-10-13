import type { ReactNode } from 'react';
import { Link } from '@tanstack/react-router';
import { Landmark } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { Card, CardContent } from '@weldsuite/ui/components/card';
import { PageLoader } from '@/components/page-loader';
import { useI18n } from '@/lib/i18n/provider';
import { useCurrentJurisdiction } from '@/lib/weldbooks/use-jurisdiction';
import { isUsJurisdictionCode } from '@/lib/weldbooks/us-entity';

/**
 * Undeposited Funds and deposits are a US practice: an entity of another
 * country gets a notice instead of the screen (and its data is never fetched).
 */
export function DepositsUsOnlyGate({ children }: Readonly<{ children: ReactNode }>) {
  const { t } = useI18n();
  const tu = t.weldbooksUs.banking.deposits.usOnly;
  const { code, isError } = useCurrentJurisdiction();

  if (!code && !isError) return <PageLoader fullScreen={false} />;
  if (code && !isUsJurisdictionCode(code)) {
    return (
      <div className="p-6">
        <Card>
          <CardContent className="space-y-3 py-10 text-center">
            <Landmark className="mx-auto h-10 w-10 text-muted-foreground" />
            <p className="font-medium">{tu.title}</p>
            <p className="mx-auto max-w-md text-sm text-muted-foreground">{tu.description}</p>
            <Button asChild variant="outline">
              <Link to="/weldbooks/dashboard">{tu.back}</Link>
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }
  return <>{children}</>;
}
