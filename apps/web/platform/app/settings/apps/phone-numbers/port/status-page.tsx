import { Link, useParams } from '@tanstack/react-router';
import { Button } from '@weldsuite/ui/components/button';
import { Badge } from '@weldsuite/ui/components/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@weldsuite/ui/components/card';
import { Alert, AlertDescription, AlertTitle } from '@weldsuite/ui/components/alert';
import { ArrowLeft, RefreshCw, X, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { PageLoader } from '@/components/page-loader';
import {
  usePortingOrder,
  useRefreshPortingOrder,
  useCancelPortingOrder,
  type PortingOrderStatus,
} from '@/hooks/use-porting';
import { getTranslations } from '@/lib/i18n';

const STATUS_VARIANTS: Record<PortingOrderStatus, { variant: 'default' | 'secondary' | 'destructive' | 'outline'; }> = {
  draft: { variant: 'secondary' },
  preflight_failed: { variant: 'destructive' },
  awaiting_documents: { variant: 'outline' },
  submitted: { variant: 'default' },
  in_process: { variant: 'default' },
  exception: { variant: 'destructive' },
  cancelled: { variant: 'secondary' },
  completed: { variant: 'default' },
};

const CANCELLABLE: PortingOrderStatus[] = ['draft', 'preflight_failed', 'awaiting_documents'];
const RESUMABLE: PortingOrderStatus[] = ['draft', 'awaiting_documents'];

export default function PortStatusPage() {
  const { id } = useParams({ from: '/settings/apps/phone-numbers/port/$id/' });
  const t = getTranslations('porting');
  const { data: order, isLoading } = usePortingOrder(id);
  const refresh = useRefreshPortingOrder(id);
  const cancel = useCancelPortingOrder();

  if (isLoading) return <PageLoader fullScreen={false} />;
  if (!order) {
    return (
      <div className="mx-auto max-w-3xl p-6">
        <Alert variant="destructive">
          <AlertTitle>{t.notFoundTitle}</AlertTitle>
          <AlertDescription>{t.notFoundBody}</AlertDescription>
        </Alert>
      </div>
    );
  }

  const handleRefresh = async () => {
    try {
      await refresh.mutateAsync();
      toast.success(t.refreshed);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Refresh failed');
    }
  };

  const handleCancel = async () => {
    if (!confirm(t.cancelConfirm)) return;
    try {
      await cancel.mutateAsync(order.id);
      toast.success(t.cancelled);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Cancel failed');
    }
  };

  return (
    <div className="mx-auto max-w-3xl space-y-6 p-6">
      <Button variant="ghost" size="sm" asChild>
        <Link to="/settings/apps/phone-numbers">
          <ArrowLeft className="h-4 w-4" /> {t.backToNumbers}
        </Link>
      </Button>

      <Card>
        <CardHeader>
          <div className="flex items-start justify-between">
            <div>
              <CardTitle>{order.formattedNumber ?? order.phoneNumber}</CardTitle>
              <p className="text-sm text-muted-foreground mt-1">
                {t.statusLabel}: <Badge variant={STATUS_VARIANTS[order.status].variant}>{order.status}</Badge>
              </p>
              {order.substatus && (
                <p className="text-xs text-muted-foreground mt-1">{order.substatus}</p>
              )}
            </div>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={handleRefresh} disabled={refresh.isPending}>
                {refresh.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
              </Button>
              {CANCELLABLE.includes(order.status) && (
                <Button variant="destructive" size="sm" onClick={handleCancel} disabled={cancel.isPending}>
                  <X className="h-4 w-4" /> {t.cancel}
                </Button>
              )}
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {order.status === 'exception' && order.lastErrorMessage && (
            <Alert variant="destructive">
              <AlertTitle>{t.exceptionTitle}</AlertTitle>
              <AlertDescription>{order.lastErrorMessage}</AlertDescription>
            </Alert>
          )}

          {order.status === 'completed' && (
            <Alert>
              <AlertTitle>{t.completeTitle}</AlertTitle>
              <AlertDescription>{t.completeBody}</AlertDescription>
            </Alert>
          )}

          {order.billingError && (
            <Alert variant="destructive">
              <AlertTitle>{t.billingErrorTitle}</AlertTitle>
              <AlertDescription>{order.billingError}</AlertDescription>
            </Alert>
          )}

          <Detail label={t.currentCarrier} value={order.currentCarrier} />
          <Detail label={t.currentAccountNumber} value={order.currentAccountNumber} />
          <Detail label={t.requestedFoc} value={formatDate(order.requestedFocAt)} />
          <Detail label={t.actualFoc} value={formatDate(order.actualFocAt)} />
          <Detail label={t.createdAt} value={formatDate(order.createdAt)} />

          {RESUMABLE.includes(order.status) && (
            <div className="pt-2">
              <Button asChild>
                <Link to="/settings/apps/phone-numbers/port">{t.resume}</Link>
              </Button>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function Detail({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <div className="grid grid-cols-3 gap-4 border-b py-2 last:border-b-0">
      <div className="text-sm text-muted-foreground">{label}</div>
      <div className="col-span-2 text-sm">{value || '—'}</div>
    </div>
  );
}

function formatDate(iso?: string | null) {
  if (!iso) return null;
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}
