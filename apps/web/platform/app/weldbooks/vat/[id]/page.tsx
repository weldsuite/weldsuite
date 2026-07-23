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

function fmt(value: number | null | undefined): string {
  return new Intl.NumberFormat('nl-NL', {
    style: 'currency',
    currency: 'EUR',
  }).format(value ?? 0);
}

const rubriekLabels: Record<string, string> = {
  r1a: '1a. Leveringen/diensten belast met hoog tarief',
  r1b: '1b. Omzetbelasting over 1a',
  r1c: '1c. Leveringen/diensten belast met laag tarief',
  r1d: '1d. Omzetbelasting over 1c',
  r1e: '1e. Leveringen/diensten belast met overige tarieven',
  r1f: '1f. Omzetbelasting over 1e',
  r2a: '2a. Leveringen/diensten waarbij de omzetbelasting naar u is verlegd',
  r3a: '3a. Leveringen naar landen buiten de EU',
  r3b: '3b. Leveringen naar/diensten in landen binnen de EU',
  r3c: '3c. Installatie/afstandsverkopen binnen de EU',
  r4a: '4a. Leveringen/diensten uit landen buiten de EU',
  r4b: '4b. Leveringen/diensten uit landen binnen de EU',
  r5a: '5a. Verschuldigde omzetbelasting (subtotaal)',
  r5b: '5b. Voorbelasting',
  r5c: '5c. Subtotaal (5a - 5b)',
  r5d: '5d. Vermindering kleineondernemersregeling',
  r5e: '5e. Schatting vorige aangifte(n)',
  r5f: '5f. Totaal te betalen / te ontvangen',
};

export default function VatReturnDetailPage() {
  const { id } = useParams({ strict: false });
  const navigate = useNavigate();
  const { t } = useI18n();
  const st = useTranslations();
  const tv = t.accounting.vat;
  const tslVat = { ...t.accounting.vat.statuses, ...t.accounting.statusLabels.vatReturn };

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
        navigate({ to: `/weldbooks/vat/${result.id}` as any });
      }
    },
    onError: (err: any) => toast.error(err?.message ?? st('sweep.weldbooks.vat.suppletieCheckFailed')),
  });

  const statusMutation = useMutation({
    mutationFn: () => accountingApi.getVatFilingStatus(id!),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ['accounting', 'vat-returns'] });
      toast.info(tv.statusResult.replace('{status}', String(res.data.status)));
    },
    onError: (err: any) => toast.error(err?.message ?? st('sweep.weldbooks.vat.statusCheckFailed')),
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

  if (isLoading) return <PageLoader fullScreen={false} />;

  const vr = data?.data as any;
  if (!vr) {
    return <div className="p-6 text-muted-foreground">{tv.vatNotFound}</div>;
  }

  const rubrieken = vr.rubrieken ?? {};

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="sm" onClick={() => navigate({ to: '/weldbooks/vat' })}>
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <div>
            <h1 className="text-2xl font-semibold">
              {tv.vatReturnTitle.replace('{period}', vr.periodLabel ?? `${vr.periodStart} — ${vr.periodEnd}`)}
            </h1>
            <p className="text-sm text-muted-foreground capitalize">
              {tv.periodTypeLabel.replace('{type}', vr.periodType)}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Badge
            variant={
              vr.status === 'filed' || vr.status === 'accepted'
                ? 'default'
                : vr.status === 'rejected'
                  ? 'destructive'
                  : 'outline'
            }
          >
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
          {tv.suppletieDeadlineLabel}: {String(vr.suppletieDeadline).slice(0, 10)}
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
          {tv.filingFailed.replace('{error}', (fileMutation.error as any)?.message || st('sweep.weldbooks.common.unknownError'))}
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">{tv.rubrieken}</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-1">
            {Object.entries(rubriekLabels).map(([key, label]) => {
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
                <span>{vr.filedAt}</span>
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
