import { useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { PageLoader } from '@/components/page-loader';
import { useAccountingVatReturns, useCalculateVatReturn } from '@/hooks/queries/use-accounting-queries';
import { accountingApi, type IcpDeclaration } from '@/lib/api/domains/weldbooks';
import { Badge } from '@weldsuite/ui/components/badge';
import { Button } from '@weldsuite/ui/components/button';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@weldsuite/ui/components/select';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@weldsuite/ui/components/dialog';
import { Card, CardContent, CardHeader, CardTitle } from '@weldsuite/ui/components/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@weldsuite/ui/components/table';
import { Plus } from 'lucide-react';
import { useI18n } from '@/lib/i18n/provider';
import { useTranslations } from '@weldsuite/i18n/client';

interface VatReturnRow {
  id: string;
  periodType: string;
  periodStart: string | null;
  periodEnd: string | null;
  periodLabel: string | null;
  status: string;
  rubrieken?: Record<string, number> | null;
}

function fmt(value: number | string | null | undefined): string {
  return new Intl.NumberFormat('nl-NL', { style: 'currency', currency: 'EUR' }).format(Number(value ?? 0));
}

export default function VatReturnsPage() {
  const { data, isLoading } = useAccountingVatReturns();
  const calculateMutation = useCalculateVatReturn();
  const navigate = useNavigate();
  const { t } = useI18n();
  const st = useTranslations();
  const tv = t.accounting.vat;
  const tslVat = { ...t.accounting.vat.statuses, ...t.accounting.statusLabels.vatReturn };
  const [showDialog, setShowDialog] = useState(false);
  const [dialogMode, setDialogMode] = useState<'vat' | 'icp'>('vat');
  const [periodType, setPeriodType] = useState('quarterly');
  const [periodStart, setPeriodStart] = useState('');
  const [periodEnd, setPeriodEnd] = useState('');
  const [periodLabel, setPeriodLabel] = useState('');

  const qc = useQueryClient();
  const { data: icpData } = useQuery({
    queryKey: ['accounting', 'icp-declarations'],
    queryFn: () => accountingApi.listIcpDeclarations(),
  });

  const calculateIcp = useMutation({
    mutationFn: (payload: Record<string, unknown>) => accountingApi.calculateIcpDeclaration(payload),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ['accounting', 'icp-declarations'] });
      toast.success(
        tv.icpCalculated
          .replace('{count}', String(res.data.lineCount))
          .replace('{total}', fmt(res.data.totalAmount)),
      );
      if (res.data.skippedContacts.length > 0) {
        toast.warning(st('sweep.weldbooks.vat.skippedContacts', { count: res.data.skippedContacts.length }));
      }
    },
    onError: (err: any) => toast.error(err?.message ?? st('sweep.weldbooks.vat.icpCalculationFailed')),
  });

  const fileIcp = useMutation({
    mutationFn: (icpId: string) => accountingApi.fileIcpDeclaration(icpId),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['accounting', 'icp-declarations'] }),
    onError: (err: any) => toast.error(err?.message ?? st('sweep.weldbooks.vat.icpFilingFailed')),
  });

  if (isLoading) return <PageLoader fullScreen={false} />;

  const returns = (data?.data ?? []) as VatReturnRow[];

  const handleCalculate = () => {
    if (!periodStart || !periodEnd) return;
    const payload = {
      periodType,
      periodStart,
      periodEnd,
      periodLabel: periodLabel || undefined,
    };
    const reset = () => { setShowDialog(false); setPeriodStart(''); setPeriodEnd(''); setPeriodLabel(''); };
    if (dialogMode === 'icp') {
      calculateIcp.mutate(payload, { onSuccess: reset });
    } else {
      calculateMutation.mutate(payload, { onSuccess: reset });
    }
  };

  const icpDeclarations = (icpData?.data ?? []) as IcpDeclaration[];

  const statusBadge = (status: string) => (
    <Badge
      variant={
        status === 'filed' || status === 'accepted'
          ? 'default'
          : status === 'rejected'
            ? 'destructive'
            : 'outline'
      }
    >
      {tslVat[status as keyof typeof tslVat] ?? status}
    </Badge>
  );

  return (
    <div className="p-6 space-y-6">
      <h1 className="text-2xl font-semibold">{tv.title}</h1>

      {/* BTW-aangiftes */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0">
          <CardTitle className="text-base">{tv.returnsTitle}</CardTitle>
          <Button
            size="sm"
            onClick={() => { setDialogMode('vat'); setShowDialog(true); }}
          >
            <Plus className="h-4 w-4 mr-1" />
            {tv.listNewReturn}
          </Button>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{tv.colPeriod}</TableHead>
                <TableHead>{tv.colType}</TableHead>
                <TableHead className="text-right">{tv.colR5a}</TableHead>
                <TableHead className="text-right">{tv.colR5b}</TableHead>
                <TableHead className="text-right">{tv.colR5f}</TableHead>
                <TableHead>{tv.colStatus}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {returns.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={6} className="text-center text-muted-foreground py-8">
                    {tv.listEmpty}
                  </TableCell>
                </TableRow>
              ) : (
                returns.map((vr) => {
                  const r5f = (vr.rubrieken ?? {}).r5f ?? 0;
                  return (
                    <TableRow
                      key={vr.id}
                      className="cursor-pointer"
                      onClick={() => navigate({ to: `/weldbooks/vat/${vr.id}` as any })}
                    >
                      <TableCell className="font-medium">
                        {vr.periodLabel || `${vr.periodStart?.slice(0, 10)} — ${vr.periodEnd?.slice(0, 10)}`}
                      </TableCell>
                      <TableCell className="capitalize">{vr.periodType}</TableCell>
                      <TableCell className="text-right tabular-nums">{fmt((vr.rubrieken ?? {}).r5a)}</TableCell>
                      <TableCell className="text-right tabular-nums">{fmt((vr.rubrieken ?? {}).r5b)}</TableCell>
                      <TableCell className={`text-right tabular-nums font-medium ${r5f >= 0 ? 'text-red-600' : 'text-green-600'}`}>
                        {fmt(r5f)}
                      </TableCell>
                      <TableCell>{statusBadge(vr.status)}</TableCell>
                    </TableRow>
                  );
                })
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {/* Opgaaf ICP */}
      <Card>
        <CardHeader className="flex flex-row items-start justify-between space-y-0">
          <div>
            <CardTitle className="text-base">{tv.icpTitle}</CardTitle>
            <p className="text-sm text-muted-foreground mt-1">{tv.icpDesc}</p>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => { setDialogMode('icp'); setShowDialog(true); }}
          >
            <Plus className="h-4 w-4 mr-1" />
            {tv.icpNew}
          </Button>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{tv.colPeriod}</TableHead>
                <TableHead className="text-right">{tv.icpColTotal}</TableHead>
                <TableHead>{tv.colStatus}</TableHead>
                <TableHead className="text-right"></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {icpDeclarations.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={4} className="text-center text-muted-foreground py-8">
                    {tv.icpEmpty}
                  </TableCell>
                </TableRow>
              ) : (
                icpDeclarations.map((d) => (
                  <TableRow key={d.id}>
                    <TableCell className="font-medium">
                      {d.periodLabel || `${d.periodStart?.slice(0, 10)} — ${d.periodEnd?.slice(0, 10)}`}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{fmt(d.totalAmount)}</TableCell>
                    <TableCell>{statusBadge(d.status)}</TableCell>
                    <TableCell className="text-right">
                      {d.status === 'calculated' || d.status === 'reviewed' ? (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={fileIcp.isPending}
                          onClick={() => fileIcp.mutate(d.id)}
                        >
                          {tv.icpFile}
                        </Button>
                      ) : null}
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Dialog open={showDialog} onOpenChange={setShowDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{dialogMode === 'icp' ? tv.icpNew : tv.calculateReturn}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>{tv.periodType}</Label>
              <Select value={periodType} onValueChange={setPeriodType}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="monthly">{tv.periodTypes.monthly}</SelectItem>
                  <SelectItem value="quarterly">{tv.periodTypes.quarterly}</SelectItem>
                  <SelectItem value="yearly">{tv.periodTypes.annual}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>{tv.periodStart}</Label>
                <Input type="date" value={periodStart} onChange={(e) => setPeriodStart(e.target.value)} />
              </div>
              <div className="space-y-2">
                <Label>{tv.periodEnd}</Label>
                <Input type="date" value={periodEnd} onChange={(e) => setPeriodEnd(e.target.value)} />
              </div>
            </div>
            <div className="space-y-2">
              <Label>{tv.periodLabel}</Label>
              <Input placeholder={tv.periodLabelPlaceholder} value={periodLabel} onChange={(e) => setPeriodLabel(e.target.value)} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowDialog(false)}>{tv.cancel}</Button>
            <Button
              onClick={handleCalculate}
              disabled={!periodStart || !periodEnd || calculateMutation.isPending || calculateIcp.isPending}
            >
              {calculateMutation.isPending || calculateIcp.isPending ? tv.calculating : tv.calculate}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
