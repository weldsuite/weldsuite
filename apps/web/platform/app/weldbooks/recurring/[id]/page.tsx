import { useParams, useNavigate } from '@tanstack/react-router';
import { PageLoader } from '@/components/page-loader';
import { Button } from '@weldsuite/ui/components/button';
import { Badge } from '@weldsuite/ui/components/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@weldsuite/ui/components/card';
import { ArrowLeft, Play, Pause, RefreshCw } from 'lucide-react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { accountingApi } from '@/lib/api/domains/weldbooks';
import { useI18n } from '@/lib/i18n/provider';
import { useWeldbooksFormat } from '@/lib/weldbooks/use-weldbooks-format';

const STATUS_BADGE_VARIANTS: Record<string, 'default' | 'secondary' | 'outline'> = {
  active: 'default',
  paused: 'secondary',
};

/** Builds stable keys for id-less template items (duplicates get an occurrence suffix). */
function withItemKeys<T extends { description?: string; quantity?: number; unitPrice?: number }>(
  list: T[],
): Array<{ key: string; item: T }> {
  const seen = new Map<string, number>();
  return list.map((item) => {
    const base = `${item.description ?? ''}|${item.quantity ?? ''}|${item.unitPrice ?? ''}`;
    const occurrence = seen.get(base) ?? 0;
    seen.set(base, occurrence + 1);
    return { key: `${base}#${occurrence}`, item };
  });
}

export default function RecurringInvoiceDetailPage() {
  const { t } = useI18n();
  const { formatMoney: fmt, formatDate, formatDateTime } = useWeldbooksFormat();
  const trp = t.accounting.recurringPage;
  const tslRec = t.accounting.statusLabels.recurringInvoice;

  const { id } = useParams({ strict: false });
  const navigate = useNavigate();
  const qc = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: ['accounting', 'recurring', 'detail', id],
    queryFn: () => accountingApi.getRecurringInvoice(id!),
    enabled: !!id,
  });

  const generateMutation = useMutation({
    mutationFn: () => accountingApi.generateRecurringInvoice(id!),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['accounting', 'recurring'] });
      qc.invalidateQueries({ queryKey: ['accounting', 'invoices'] });
    },
  });

  const pauseMutation = useMutation({
    mutationFn: () => accountingApi.pauseRecurringInvoice(id!),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['accounting', 'recurring'] }); },
  });

  const resumeMutation = useMutation({
    mutationFn: () => accountingApi.resumeRecurringInvoice(id!),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['accounting', 'recurring'] }); },
  });

  if (isLoading) return <PageLoader fullScreen={false} />;

  const rec = data?.data;
  if (!rec) return <div className="p-6 text-muted-foreground">{trp.notFound}</div>;

  const template = rec.templateData ?? {};
  const items = template.items ?? [];
  const keyedItems = withItemKeys(items);
  const statusVariant = STATUS_BADGE_VARIANTS[rec.status] ?? 'outline';

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="sm" onClick={() => navigate({ to: '/weldbooks/recurring' })}>
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <div>
            <h1 className="text-2xl font-semibold">{rec.name || trp.defaultName}</h1>
            <p className="text-sm text-muted-foreground capitalize">{rec.frequency} — {rec.contactId}</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant={statusVariant}>
            {tslRec[rec.status as keyof typeof tslRec] ?? rec.status}
          </Badge>
          {rec.status === 'active' && (
            <>
              <Button size="sm" onClick={() => generateMutation.mutate()} disabled={generateMutation.isPending}>
                <RefreshCw className="h-4 w-4 mr-1" />
                {generateMutation.isPending ? trp.generating : trp.generateNow}
              </Button>
              <Button variant="outline" size="sm" onClick={() => pauseMutation.mutate()} disabled={pauseMutation.isPending}>
                <Pause className="h-4 w-4 mr-1" />
                {trp.pause}
              </Button>
            </>
          )}
          {rec.status === 'paused' && (
            <Button size="sm" onClick={() => resumeMutation.mutate()} disabled={resumeMutation.isPending}>
              <Play className="h-4 w-4 mr-1" />
              {trp.resume}
            </Button>
          )}
        </div>
      </div>

      {generateMutation.isSuccess && (
        <div className="text-sm text-green-600">
          {trp.generatedInvoice.replace('{number}', generateMutation.data?.data?.invoiceNumber ?? '')}
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Card>
          <CardHeader><CardTitle className="text-sm">{trp.nextIssueDate}</CardTitle></CardHeader>
          <CardContent>
            <span className="text-lg font-medium">{formatDate(rec.nextIssueDate)}</span>
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle className="text-sm">{trp.generatedCount}</CardTitle></CardHeader>
          <CardContent>
            <span className="text-lg font-medium">{rec.generatedCount ?? 0}</span>
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle className="text-sm">{trp.lastGenerated}</CardTitle></CardHeader>
          <CardContent>
            <span className="text-lg font-medium">{formatDateTime(rec.lastGeneratedAt, trp.never)}</span>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader><CardTitle className="text-base">{trp.schedule}</CardTitle></CardHeader>
        <CardContent className="space-y-2 text-sm">
          <div className="flex justify-between">
            <span className="text-muted-foreground">{trp.frequency}</span>
            <span className="capitalize">{rec.frequency}</span>
          </div>
          {rec.dayOfMonth && (
            <div className="flex justify-between">
              <span className="text-muted-foreground">{trp.dayOfMonth}</span>
              <span>{rec.dayOfMonth}</span>
            </div>
          )}
          {rec.endDate && (
            <div className="flex justify-between">
              <span className="text-muted-foreground">{trp.endDate}</span>
              <span>{formatDate(rec.endDate)}</span>
            </div>
          )}
          <div className="flex justify-between">
            <span className="text-muted-foreground">{trp.autoFinalize}</span>
            <span>{rec.autoFinalize ? trp.yes : trp.no}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">{trp.autoSend}</span>
            <span>{rec.autoSend ? trp.yes : trp.no}</span>
          </div>
        </CardContent>
      </Card>

      {items.length > 0 && (
        <Card>
          <CardHeader><CardTitle className="text-base">{trp.templateItems}</CardTitle></CardHeader>
          <CardContent>
            <div className="space-y-2">
              {keyedItems.map(({ key, item }) => (
                <div key={key} className="flex justify-between text-sm border-b pb-2">
                  <span>{item.description}</span>
                  <span className="font-medium">
                    {item.quantity} × {fmt(item.unitPrice, template.currency)} = {fmt((item.quantity ?? 1) * (item.unitPrice ?? 0), template.currency)}
                  </span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
