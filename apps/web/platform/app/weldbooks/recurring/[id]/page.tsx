import { useParams, useNavigate } from '@tanstack/react-router';
import { PageLoader } from '@/components/page-loader';
import { Button } from '@weldsuite/ui/components/button';
import { Badge } from '@weldsuite/ui/components/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@weldsuite/ui/components/card';
import { ArrowLeft, Play, Pause, RefreshCw } from 'lucide-react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { accountingApi } from '@/lib/api/domains/weldbooks';
import { useI18n } from '@/lib/i18n/provider';

function fmt(value: string | number | null | undefined): string {
  return new Intl.NumberFormat('nl-NL', { style: 'currency', currency: 'EUR' }).format(Number(value ?? 0));
}

export default function RecurringInvoiceDetailPage() {
  const { t } = useI18n();
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
          <Badge variant={rec.status === 'active' ? 'default' : rec.status === 'paused' ? 'secondary' : 'outline'}>
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
            <span className="text-lg font-medium">{rec.nextIssueDate?.slice(0, 10)}</span>
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
            <span className="text-lg font-medium">{rec.lastGeneratedAt?.slice(0, 10) || trp.never}</span>
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
              <span>{rec.endDate?.slice(0, 10)}</span>
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
              {items.map((item, i: number) => (
                <div key={i} className="flex justify-between text-sm border-b pb-2">
                  <span>{item.description}</span>
                  <span className="font-medium">
                    {item.quantity} × {fmt(item.unitPrice)} = {fmt((item.quantity ?? 1) * (item.unitPrice ?? 0))}
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
