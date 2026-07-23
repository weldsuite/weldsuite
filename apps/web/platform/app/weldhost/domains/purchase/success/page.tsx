
import { useEffect, useState } from 'react';
import { useSearchParams, useRouter } from '@/lib/router';
import { Button } from '@weldsuite/ui/components/button';
import { Badge } from '@weldsuite/ui/components/badge';
import {
  CheckCircle2,
  Loader2,
  AlertCircle,
  ArrowRight,
  Globe,
  XCircle,
  ExternalLink,
} from 'lucide-react';
import { PageLoader } from '@/components/page-loader';
import { pollMultipleRegistrationStatuses, type DomainPurchaseStatusResponse } from '@/lib/host/domain-purchase-client';
import { useAppApi } from '@/lib/api/use-app-api';
import { useI18n } from '@/lib/i18n/provider';
import { useTranslations } from '@weldsuite/i18n/client';

export default function DomainPurchaseSuccessPage() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const { domains: domainsApi } = useAppApi();
  const { t } = useI18n();
  const ts = t.host.purchaseSuccess;
  const tse = t.host.purchaseSuccessExtra;
  const st = useTranslations();
  const registrationIdsParam = searchParams.get('registration_ids');
  const sessionId = searchParams.get('session_id');

  const [statuses, setStatuses] = useState<Map<string, DomainPurchaseStatusResponse>>(new Map());
  const [isPolling, setIsPolling] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [registrationIds, setRegistrationIds] = useState<string[]>([]);

  useEffect(() => {
    if (!registrationIdsParam) {
      setError(st('sweep.miscB.noRegistrationIdsProvided'));
      setIsPolling(false);
      return;
    }

    const ids = registrationIdsParam.split(',').map((id: string) => id.trim()).filter(Boolean);
    if (ids.length === 0) {
      setError(st('sweep.miscB.invalidRegistrationIds'));
      setIsPolling(false);
      return;
    }

    setRegistrationIds(ids);

    const checkStatus = async (registrationId: string): Promise<DomainPurchaseStatusResponse> => {
      const res = await domainsApi.getRegistrationStatus(registrationId);
      return {
        status: res.data.status,
        domainName: res.data.domainName,
        domainId: res.data.domainId ?? undefined,
        totalPrice: res.data.totalPrice ?? undefined,
        error: res.data.failureReason ?? undefined,
      };
    };

    pollMultipleRegistrationStatuses(
      ids,
      (currentStatuses) => {
        setStatuses(new Map(currentStatuses));
      },
      checkStatus,
      60,
      3000
    )
      .then((finalStatuses) => {
        setStatuses(finalStatuses);
        setIsPolling(false);
      })
      .catch((err) => {
        console.error('Error polling registration statuses:', err);
        setError(err instanceof Error ? err.message : st('sweep.miscB.failedToCheckRegistrationStatuses'));
        setIsPolling(false);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [registrationIdsParam]);

  const totalDomains = registrationIds.length;
  const completedCount = Array.from(statuses.values()).filter(s => s.status === 'completed').length;
  const failedCount = Array.from(statuses.values()).filter(s => s.status === 'failed').length;
  const processingCount = totalDomains - completedCount - failedCount;
  const allCompleted = completedCount === totalDomains;
  const anyFailed = failedCount > 0;
  const allFailed = failedCount === totalDomains;

  const getStatusBadge = (status?: string) => {
    switch (status) {
      case 'completed':
        return <Badge className="bg-green-500/10 text-green-600 border-0 rounded-sm py-1">{ts.statusBadges.registered}</Badge>;
      case 'failed':
        return <Badge className="bg-red-500/10 text-red-600 border-0 rounded-sm py-1">{ts.statusBadges.failed}</Badge>;
      case 'payment_complete':
      case 'registering':
        return <Badge className="bg-blue-500/10 text-blue-600 border-0 rounded-sm py-1">{ts.statusBadges.registering}</Badge>;
      default:
        return <Badge className="bg-muted text-muted-foreground border-0 rounded-sm py-1">{ts.statusBadges.processing}</Badge>;
    }
  };

  if (error) {
    return (
      <div className="min-h-screen flex items-center justify-center p-6">
        <div className="max-w-md w-full text-center space-y-6">
          <div className="w-16 h-16 rounded-full bg-red-500/10 flex items-center justify-center mx-auto">
            <AlertCircle className="h-8 w-8 text-red-600" />
          </div>
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">{ts.somethingWentWrong}</h1>
            <p className="text-muted-foreground mt-2">{error}</p>
          </div>
          <div className="flex gap-3">
            <Button
              variant="outline"
              onClick={() => router.push('/weldhost/domains')}
              className="flex-1 rounded-lg"
            >
              {ts.goToDomains}
            </Button>
            <Button
              onClick={() => router.push('/weldhost/domains/register')}
              className="flex-1 rounded-lg"
            >
              {ts.tryAgain}
            </Button>
          </div>
        </div>
      </div>
    );
  }

  if (registrationIds.length === 0) {
    return <PageLoader label={ts.loadingRegistrationStatus} />;
  }

  return (
    <div className="min-h-screen py-12 px-6">
      <div className="max-w-2xl mx-auto space-y-8">
        {/* Header */}
        <div className="text-center space-y-4">
          <div className={`flex items-center justify-center mx-auto ${
            allCompleted
              ? 'w-14 h-14 rounded-xl bg-green-500/10'
              : allFailed
              ? 'w-14 h-14 rounded-xl bg-red-500/10'
              : 'w-20 h-20 rounded-full bg-blue-500/10'
          }`}>
            {allCompleted ? (
              <CheckCircle2 className="h-7 w-7 text-green-600" />
            ) : allFailed ? (
              <XCircle className="h-7 w-7 text-red-600" />
            ) : (
              <Loader2 className="h-10 w-10 text-blue-600 animate-spin" />
            )}
          </div>
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">
              {allCompleted
                ? ts.registrationComplete
                : allFailed
                ? ts.registrationFailed
                : ts.processingDomains}
            </h1>
            <p className="text-muted-foreground mt-1">
              {allCompleted
                ? (totalDomains > 1
                    ? tse.domainsReadyPlural.replace('{count}', String(totalDomains))
                    : tse.domainReadySingular)
                : allFailed
                ? <>{tse.contactSupportPrefix}<a href="https://www.weldsuite.org/support" target="_blank" rel="noopener noreferrer" className="underline hover:text-foreground">{ts.contactSupport}</a></>
                : ts.processingCount
                    .replace('{count}', String(totalDomains))
                    .replace('{plural}', totalDomains > 1 ? 's' : '')}
            </p>
          </div>
        </div>

        {/* Stats */}
        <div className="grid grid-cols-3 gap-4">
          <div className="px-4 py-3 rounded-lg border bg-card text-center">
            <p className="text-xl font-semibold">{completedCount}</p>
            <p className="text-sm font-medium text-muted-foreground mt-1">{ts.completed}</p>
          </div>
          <div className="px-4 py-3 rounded-lg border bg-card text-center">
            <p className="text-xl font-semibold">{processingCount}</p>
            <p className="text-sm font-medium text-muted-foreground mt-1">{ts.processing}</p>
          </div>
          <div className="px-4 py-3 rounded-lg border bg-card text-center">
            <p className="text-xl font-semibold">{failedCount}</p>
            <p className="text-sm font-medium text-muted-foreground mt-1">{ts.failed}</p>
          </div>
        </div>

        {/* Domain List */}
        <div className="space-y-3">
          <h2 className="text-sm font-medium text-muted-foreground">{ts.domains}</h2>
          <div className="border rounded-lg divide-y">
            {registrationIds.map((regId) => {
              const status = statuses.get(regId);
              return (
                <div key={regId} className="p-4 flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <div className={`w-10 h-10 rounded-lg flex items-center justify-center ${
                      status?.status === 'completed'
                        ? 'bg-green-500/10'
                        : status?.status === 'failed'
                        ? 'bg-red-500/10'
                        : 'bg-muted'
                    }`}>
                      <Globe className={`h-5 w-5 ${
                        status?.status === 'completed'
                          ? 'text-green-600'
                          : status?.status === 'failed'
                          ? 'text-red-600'
                          : 'text-muted-foreground'
                      }`} />
                    </div>
                    <div>
                      <p className="font-medium">{status?.domainName || ts.loadingStatus}</p>
                      {status?.totalPrice && (
                        <p className="text-sm text-muted-foreground">${tse.pricePerYear.replace('{price}', status.totalPrice.toFixed(2))}</p>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-3">
                    {getStatusBadge(status?.status)}
                    {status?.status === 'completed' && status?.domainId && (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => router.push(`/weldhost/domains/${status.domainId}`)}
                        className="rounded-lg"
                      >
                        <ExternalLink className="h-4 w-4" />
                      </Button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Polling Status */}
        {isPolling && !allCompleted && !allFailed && (
          <div className="flex items-center justify-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            <span>{ts.checkingStatus}</span>
          </div>
        )}

        {/* Actions */}
        <div className="flex gap-3 justify-end">
          <Button
            variant="outline"
            onClick={() => router.push('/weldhost/domains/register')}
          >
            {ts.registerMore}
          </Button>
          <Button
            onClick={() => router.push('/weldhost/domains')}
          >
            {allCompleted ? ts.viewAllDomains : ts.continueToDomains}
          </Button>
        </div>

      </div>
    </div>
  );
}
