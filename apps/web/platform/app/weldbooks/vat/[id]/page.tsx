import { useParams, useNavigate } from '@tanstack/react-router';
import { PageLoader } from '@/components/page-loader';
import { Button } from '@weldsuite/ui/components/button';
import { Badge } from '@weldsuite/ui/components/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@weldsuite/ui/components/card';
import { ArrowLeft, Download, Send, CheckCircle2, AlertCircle } from 'lucide-react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { accountingApi } from '@/lib/api/domains/weldbooks';
import { useI18n } from '@/lib/i18n/provider';
import { useTranslations } from '@weldsuite/i18n/client';
import { useWeldbooksFormat } from '@/lib/weldbooks/use-weldbooks-format';
import { useCurrentJurisdiction } from '@/lib/weldbooks/use-jurisdiction';
import { VatNotAvailable } from '../components/vat-not-available';

function vatStatusBadgeVariant(status: string): 'default' | 'destructive' | 'outline' {
  if (status === 'filed' || status === 'accepted') return 'default';
  if (status === 'rejected') return 'destructive';
  return 'outline';
}

/** NL BTW return boxes, in filing order. Labels come from `accounting.vat.rubriekLabels`. */
const RUBRIEK_KEYS = [
  'r1a', 'r1b', 'r1c', 'r1d', 'r1e', 'r1f', 'r2a', 'r3a', 'r3b', 'r3c', 'r4a', 'r4b',
  'r5a', 'r5b', 'r5c', 'r5d', 'r5e', 'r5f',
] as const;

export default function VatReturnDetailPage() {
  const { id } = useParams({ strict: false });
  const navigate = useNavigate();
  const { t } = useI18n();
  const st = useTranslations();
  const tv = t.accounting.vat;
  const tslVat = { ...t.accounting.vat.statuses, ...t.accounting.statusLabels.vatReturn };
  const { formatMoney: fmt, formatDate, formatDateTime } = useWeldbooksFormat();
  const { features, isResolved, isError: jurisdictionError } = useCurrentJurisdiction();

  const qc = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: ['accounting', 'vat-returns', 'detail', id],
    queryFn: () => accountingApi.getVatReturn(id!),
    enabled: !!id,
  });

  const fileMutation = useMutation({
    mutationFn: () => accountingApi.fileVatReturn(id!),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['accounting', 'vat-returns'] }); },
  });

  const suppletieMutation = useMutation({
    mutationFn: () => accountingApi.createSuppletie(id!),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ['accounting', 'vat-returns'] });
      const result = res.data;
      toast.info(result.message);
      if (result.correctionRequired && result.id) {
        navigate({ to: '/weldbooks/vat/$id', params: { id: result.id } });
      }
    },
    onError: (err) => toast.error(err?.message ?? st('sweep.weldbooks.vat.suppletieCheckFailed')),
  });

  const statusMutation = useMutation({
    mutationFn: () => accountingApi.getVatFilingStatus(id!),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ['accounting', 'vat-returns'] });
      toast.info(tv.statusResult.replace('{status}', String(res.data.status)));
    },
    onError: (err) => toast.error(err?.message ?? st('sweep.weldbooks.vat.statusCheckFailed')),
  });

  const handleXmlDownload = async () => {
    const xml = await accountingApi.getVatReturnXml(id!);
    const blob = new Blob([xml], { type: 'application/xml' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `btw-aangifte-${id}.xml`;
    a.click();
    URL.revokeObjectURL(url);
  };

  if (isLoading || (!isResolved && !jurisdictionError)) return <PageLoader fullScreen={false} />;

  if (!features.vatReturn) {
    return <VatNotAvailable title={tv.notAvailableTitle} description={tv.notAvailableDescription} />;
  }

  const vr = data?.data;
  if (!vr) {
    return <div className="p-6 text-muted-foreground">{tv.vatNotFound}</div>;
  }

  const rubrieken = vr.rubrieken ?? {};
  const periodTypeName =
    vr.periodType === 'yearly' || vr.periodType === 'annual'
      ? tv.periodTypes.annual
      : (tv.periodTypes as Record<string, string>)[vr.periodType] ?? vr.periodType;

  return (
    <div className="p-4 sm:p-6 space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <Button
            variant="ghost"
            size="sm"
            aria-label={tv.cancel}
            onClick={() => navigate({ to: '/weldbooks/vat' })}
          >
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <div>
            <h1 className="text-2xl font-semibold">
              {tv.vatReturnTitle.replace(
                '{period}',
                vr.periodLabel ?? `${formatDate(vr.periodStart)} — ${formatDate(vr.periodEnd)}`,
              )}
            </h1>
            <p className="text-sm text-muted-foreground">
              {tv.periodTypeLabel.replace('{type}', periodTypeName)}
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant={vatStatusBadgeVariant(vr.status)}>
            {tslVat[vr.status as keyof typeof tslVat] ?? vr.status}
          </Badge>
          {(vr.status === 'calculated' || vr.status === 'reviewed') && (
            <Button
              size="sm"
              onClick={() => fileMutation.mutate()}
              disabled={fileMutation.isPending}
            >
              <Send className="h-4 w-4 mr-1" />
              {fileMutation.isPending ? tv.filing : tv.fileToTax}
            </Button>
          )}
          {(vr.status === 'filed' || vr.status === 'accepted') && (
            <>
              <Button
                variant="outline"
                size="sm"
                onClick={() => statusMutation.mutate()}
                disabled={statusMutation.isPending}
              >
                {statusMutation.isPending ? tv.checkingStatus : tv.checkStatus}
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => suppletieMutation.mutate()}
                disabled={suppletieMutation.isPending}
              >
                {suppletieMutation.isPending ? tv.suppletieChecking : tv.suppletieButton}
              </Button>
            </>
          )}
          <Button variant="outline" size="sm" onClick={handleXmlDownload}>
            <Download className="h-4 w-4 mr-1" />
            {tv.downloadXml}
          </Button>
        </div>
      </div>

      {vr.suppletieDeadline && (
        <div className="text-sm text-amber-700 flex items-center gap-1">
          <AlertCircle className="h-4 w-4" />
          {tv.suppletieDeadlineLabel}: {formatDate(vr.suppletieDeadline)}
        </div>
      )}

      {fileMutation.isSuccess && (
        <div className="text-sm text-green-600 flex items-center gap-1">
          <CheckCircle2 className="h-4 w-4" />
          {tv.filedSuccess}
        </div>
      )}
      {fileMutation.isError && (
        <div className="text-sm text-red-600 flex items-center gap-1">
          <AlertCircle className="h-4 w-4" />
          {tv.filingFailed.replace('{error}', fileMutation.error?.message || st('sweep.weldbooks.common.unknownError'))}
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">{tv.rubrieken}</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-1">
            {RUBRIEK_KEYS.map((key) => {
              const label = tv.rubriekLabels[key];
              const isTotals = key.startsWith('r5');
              return (
                <div
                  key={key}
                  className={`flex items-center justify-between py-2 px-3 rounded ${
                    isTotals ? 'bg-muted font-medium' : ''
                  } ${key === 'r5f' ? 'bg-primary/10 font-semibold text-lg' : ''}`}
                >
                  <span className="text-sm">{label}</span>
                  <span className="text-sm tabular-nums">{fmt(rubrieken[key])}</span>
                </div>
              );
            })}
          </div>
        </CardContent>
      </Card>

      {vr.filingReference && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{tv.filingDetails}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">{tv.digipoortKenmerk}</span>
              <span>{vr.filingReference}</span>
            </div>
            {vr.filedAt && (
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">{tv.filedAt}</span>
                <span>{formatDateTime(vr.filedAt)}</span>
              </div>
            )}
            {vr.filedBy && (
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">{tv.filedBy}</span>
                <span>{vr.filedBy}</span>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {vr.notes && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{tv.notesSection}</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm whitespace-pre-wrap">{vr.notes}</p>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
