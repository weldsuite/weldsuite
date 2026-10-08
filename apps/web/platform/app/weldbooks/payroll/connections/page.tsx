import { Link } from '@tanstack/react-router';
import { ArrowLeft, Info } from 'lucide-react';
import { usePermissions } from '@weldsuite/permissions/react';
import { Badge } from '@weldsuite/ui/components/badge';
import { Button } from '@weldsuite/ui/components/button';
import { Card, CardContent } from '@weldsuite/ui/components/card';
import { PageLoader } from '@/components/page-loader';
import { usePayrollConnections } from '@/hooks/queries/use-weldbooks-assets-queries';
import { useI18n } from '@/lib/i18n/provider';
import { GustoConnectForm } from '../components/gusto-connect-form';
import { GustoConnectionCard } from '../components/gusto-connection-card';

/** Gusto: connect a company with an access token, map its payroll to accounts, and import the processed payrolls. */
export default function PayrollConnectionsPage() {
  const { t } = useI18n();
  const tg = t.weldbooksUs.assets.payroll.gusto;
  const common = t.weldbooksUs.assets.common;
  const { can } = usePermissions();
  const { data, isLoading, isError, refetch } = usePayrollConnections();
  const connections = data ?? [];

  return (
    <div className="max-w-4xl space-y-6 p-4 sm:p-6">
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="icon" asChild aria-label={common.back}>
          <Link to="/weldbooks/payroll">
            <ArrowLeft className="h-4 w-4" />
          </Link>
        </Button>
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-semibold">{tg.title}</h1>
            <Badge variant="outline">{tg.beta}</Badge>
          </div>
          <p className="text-sm text-muted-foreground">{tg.subtitle}</p>
        </div>
      </div>

      <p className="flex items-start gap-2 text-sm text-muted-foreground">
        <Info className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
        {tg.betaNote}
      </p>

      {isLoading ? (
        <PageLoader fullScreen={false} />
      ) : isError ? (
        <Card>
          <CardContent className="space-y-3 py-10 text-center">
            <p className="text-sm text-destructive" role="alert">
              {tg.loadFailed}
            </p>
            <Button variant="outline" size="sm" onClick={() => void refetch()}>
              {common.retry}
            </Button>
          </CardContent>
        </Card>
      ) : (
        <>
          {connections.length === 0 ? <p className="text-sm text-muted-foreground">{tg.none}</p> : null}
          {connections.map((connection) => (
            <GustoConnectionCard
              key={connection.id}
              connection={connection}
              can={{ map: can('journal:update'), sync: can('journal:create'), disconnect: can('journal:delete') }}
            />
          ))}
        </>
      )}

      {can('journal:create') ? <GustoConnectForm /> : null}
    </div>
  );
}
