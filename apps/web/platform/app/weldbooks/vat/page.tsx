import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { VatNotAvailable } from './components/vat-not-available';
import GstReturnPage from './gst-return-page';
import BrApuracaoPage from './br-apuracao-page';
import { toast } from 'sonner';
import { PageLoader } from '@/components/page-loader';
import { useAccountingVatReturns, useCalculateVatReturn } from '@/hooks/queries/use-accounting-queries';
import { accountingApi, type IcpDeclaration } from '@/lib/api/domains/weldbooks';
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
import { FileText, Receipt, Trash2 } from 'lucide-react';
import { EmptyStateIllustration, type ColumnDef } from '@/components/entity-list';
import { WeldbooksEntityList } from '@/components/accounting/weldbooks-entity-list';
import {
  RowAmount,
  RowText,
  RowTitle,
  StatusChip,
} from '@/components/accounting/weldbooks-row-cells';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { useObjectPanel, useObjectPanelUrlSync } from '@/components/object-panel';
import { vatStatusTone } from '@/components/objects/vat-return/vat-return-model';
import { useI18n } from '@/lib/i18n/provider';
import { useTranslations } from '@weldsuite/i18n/client';
import { useCurrentAccountingEntity } from '@/hooks/use-current-accounting-entity';
import { useWeldbooksFormat } from '@/lib/weldbooks/use-weldbooks-format';
import { useCurrentJurisdiction } from '@/lib/weldbooks/use-jurisdiction';
import { isFeatureAvailable } from '@/lib/edition';

interface VatReturnRow {
  id: string;
  periodType: string;
  periodStart: string | null;
  periodEnd: string | null;
  periodLabel: string | null;
  status: string;
  rubrieken?: Record<string, number> | null;
}

export default function VatReturnsPage() {
  const { formatMoney: fmt, formatDate } = useWeldbooksFormat();
  const { features, isResolved, isError: jurisdictionError } = useCurrentJurisdiction();
  const { data, isLoading } = useAccountingVatReturns();
  const calculateMutation = useCalculateVatReturn();
  // Each return opens in the shared object panel (type 'vat_return'), the
  // same panel/fullscreen shell as WeldCRM companies, synced to `?stack=`.
  const { open: openPanel } = useObjectPanel();
  useObjectPanelUrlSync('/weldbooks/vat');
  const { t } = useI18n();
  const st = useTranslations();
  const tv = t.accounting.vat;
  const tslVat = { ...t.accounting.vat.statuses, ...t.accounting.statusLabels.vatReturn };
  const { entityId } = useCurrentAccountingEntity();
  const [showDialog, setShowDialog] = useState(false);
  const [dialogMode, setDialogMode] = useState<'vat' | 'icp'>('vat');
  const [periodType, setPeriodType] = useState('quarterly');
  const [periodStart, setPeriodStart] = useState('');
  const [periodEnd, setPeriodEnd] = useState('');
  const [periodLabel, setPeriodLabel] = useState('');
  const [icpToDelete, setIcpToDelete] = useState<string | null>(null);

  const qc = useQueryClient();

  // Gate on the jurisdiction's features; never assume NL while it is unresolved.
  const showIcp = features.icp;

  useEffect(() => {
    if (!showIcp && dialogMode === 'icp') {
      setShowDialog(false);
      setDialogMode('vat');
      setPeriodStart('');
      setPeriodEnd('');
      setPeriodLabel('');
    }
  }, [showIcp, dialogMode]);

  const { data: icpData } = useQuery({
    queryKey: ['accounting', 'icp-declarations', entityId],
    enabled: showIcp && Boolean(entityId),
    queryFn: () => accountingApi.listIcpDeclarations(),
  });

  const calculateIcp = useMutation({
    mutationFn: (payload: Record<string, unknown>) => accountingApi.calculateIcpDeclaration(payload),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ['accounting', 'icp-declarations'] });
      toast.success(
        (res.data.recalculated ? tv.icpRecalculated : tv.icpCalculated)
          .replace('{count}', String(res.data.lineCount))
          .replace('{total}', fmt(res.data.totalAmount)),
      );
      if (res.data.skippedContacts.length > 0) {
        toast.warning(st('sweep.weldbooks.vat.skippedContacts', { count: res.data.skippedContacts.length }));
      }
    },
    onError: (err) => toast.error(err?.message ?? st('sweep.weldbooks.vat.icpCalculationFailed')),
  });

  const fileIcp = useMutation({
    mutationFn: (icpId: string) => accountingApi.fileIcpDeclaration(icpId),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['accounting', 'icp-declarations'] }),
    onError: (err) => toast.error(err?.message ?? st('sweep.weldbooks.vat.icpFilingFailed')),
  });

  const deleteIcp = useMutation({
    mutationFn: (icpId: string) => accountingApi.deleteIcpDeclaration(icpId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['accounting', 'icp-declarations'] });
      toast.success(tv.icpDeleted);
      setIcpToDelete(null);
    },
    onError: (err) => toast.error(tv.icpDeleteFailed, { description: err instanceof Error ? err.message : undefined }),
  });

  if (isLoading || (!isResolved && !jurisdictionError)) return <PageLoader fullScreen={false} />;

  // India has no stored return: the GSTR-1 / GSTR-3B worksheet of a period instead.
  if (features.gstReturn) return <GstReturnPage />;

  // Brazil has no stored return either: the monthly apuração (DAS / taxes / withholdings) of a period.
  if (features.brTaxReturn) return <BrApuracaoPage />;

  if (!features.vatReturn) {
    return <VatNotAvailable title={tv.notAvailableTitle} description={tv.notAvailableDescription} />;
  }

  const returns = (data?.data ?? []) as VatReturnRow[];

  const periodTypeLabel = (type: string) => {
    if (type === 'yearly' || type === 'annual') return tv.periodTypes.annual;
    if (type === 'monthly') return tv.periodTypes.monthly;
    if (type === 'quarterly') return tv.periodTypes.quarterly;
    return type;
  };
  const periodRange = (start: string | null, end: string | null) => `${formatDate(start)} — ${formatDate(end)}`;

  const handleCalculate = () => {
    if (!periodStart || !periodEnd) return;
    if (periodEnd < periodStart) {
      toast.error(tv.invalidPeriod);
      return;
    }
    if (dialogMode === 'icp' && !showIcp) {
      toast.error(st('sweep.weldbooks.vat.icpFilingFailed'));
      return;
    }
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
      calculateMutation.mutate(payload, {
        onSuccess: (res) => {
          if (res.data.recalculated) toast.info(tv.recalculated);
          reset();
        },
        onError: (err) => toast.error(err?.message ?? st('sweep.weldbooks.common.unknownError')),
      });
    }
  };

  const icpDeclarations = (icpData?.data ?? []) as IcpDeclaration[];

  const statusChip = (status: string) => (
    <StatusChip tone={vatStatusTone(status)}>{tslVat[status as keyof typeof tslVat] ?? status}</StatusChip>
  );

  const openVatDialog = () => {
    setDialogMode('vat');
    setShowDialog(true);
  };
  const openIcpDialog = () => {
    setDialogMode('icp');
    setShowDialog(true);
  };

  const returnColumns: ColumnDef<VatReturnRow>[] = [
    {
      id: 'period',
      header: tv.colPeriod,
      width: 'min-w-[200px] flex-1 gap-2',
      render: (vr) => <RowTitle>{vr.periodLabel || periodRange(vr.periodStart, vr.periodEnd)}</RowTitle>,
    },
    {
      id: 'type',
      header: tv.colType,
      width: 'w-[120px]',
      render: (vr) => <RowText>{periodTypeLabel(vr.periodType)}</RowText>,
    },
    {
      id: 'r5a',
      header: tv.colR5a,
      width: 'w-[130px]',
      render: (vr) => <RowAmount>{fmt(vr.rubrieken?.r5a)}</RowAmount>,
    },
    {
      id: 'r5b',
      header: tv.colR5b,
      width: 'w-[130px]',
      render: (vr) => <RowAmount>{fmt(vr.rubrieken?.r5b)}</RowAmount>,
    },
    {
      id: 'r5g',
      header: tv.colR5g,
      width: 'w-[130px]',
      render: (vr) => {
        const r5g = vr.rubrieken?.r5g ?? 0;
        return (
          <RowAmount className={`font-medium ${r5g >= 0 ? 'text-red-600' : 'text-green-600'}`}>{fmt(r5g)}</RowAmount>
        );
      },
    },
    {
      id: 'status',
      header: tv.colStatus,
      width: 'w-[110px]',
      render: (vr) => statusChip(vr.status),
    },
  ];

  const icpColumns: ColumnDef<IcpDeclaration>[] = [
    {
      id: 'period',
      header: tv.colPeriod,
      width: 'min-w-[200px] flex-1 gap-2',
      render: (d) => <RowTitle>{d.periodLabel || periodRange(d.periodStart, d.periodEnd)}</RowTitle>,
    },
    {
      id: 'total',
      header: tv.icpColTotal,
      width: 'w-[150px]',
      render: (d) => <RowAmount>{fmt(d.totalAmount)}</RowAmount>,
    },
    {
      id: 'status',
      header: tv.colStatus,
      width: 'w-[110px]',
      render: (d) => statusChip(d.status),
    },
    {
      id: 'actions',
      header: '',
      width: 'w-[150px] justify-end gap-2',
      render: (d) =>
        d.status === 'calculated' || d.status === 'reviewed' ? (
          <>
            {isFeatureAvailable('vat-digipoort') ? (
              <Button size="sm" variant="outline" className="h-7" disabled={fileIcp.isPending} onClick={() => fileIcp.mutate(d.id)}>
                {tv.icpFile}
              </Button>
            ) : null}
            <Button
              size="sm"
              variant="ghost"
              className="h-7 w-7 px-0"
              aria-label={tv.icpDelete}
              disabled={deleteIcp.isPending}
              onClick={() => setIcpToDelete(d.id)}
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          </>
        ) : null,
    },
  ];

  return (
    <>
      {/* BTW-aangiftes */}
      {showIcp ? <h2 className="px-4 pt-4 text-sm font-semibold sm:px-6">{tv.returnsTitle}</h2> : null}
      <WeldbooksEntityList<VatReturnRow>
        items={returns}
        isLoading={false}
        columns={returnColumns}
        onRowClick={(vr) => openPanel({ type: 'vat_return', id: vr.id })}
        getRowLabel={(vr) => vr.periodLabel || periodRange(vr.periodStart, vr.periodEnd)}
        filters={[]}
        createButton={{ label: tv.listNewReturn, onClick: openVatDialog }}
        emptyState={{
          icon: (
            <EmptyStateIllustration>
              <Receipt className="h-10 w-10 text-muted-foreground/60" strokeWidth={1.5} />
            </EmptyStateIllustration>
          ),
          title: tv.emptyTitle,
          description: tv.emptyDescription,
          action: { label: tv.listNewReturn, onClick: openVatDialog },
        }}
      />

      {/* EC Sales List (ICP) — only where the jurisdiction has it */}
      {showIcp ? (
        <>
          <div className="px-4 pt-6 sm:px-6">
            <h2 className="text-sm font-semibold">{tv.icpTitle}</h2>
            <p className="mt-1 text-sm text-muted-foreground">{tv.icpDesc}</p>
          </div>
          <WeldbooksEntityList<IcpDeclaration>
            items={icpDeclarations}
            isLoading={false}
            columns={icpColumns}
            filters={[]}
            createButton={{ label: tv.icpNew, onClick: openIcpDialog }}
            emptyState={{
              icon: (
                <EmptyStateIllustration>
                  <FileText className="h-10 w-10 text-muted-foreground/60" strokeWidth={1.5} />
                </EmptyStateIllustration>
              ),
              title: tv.icpEmpty,
              description: tv.icpEmptyDescription,
              action: { label: tv.icpNew, onClick: openIcpDialog },
            }}
          />
        </>
      ) : null}

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
      <ConfirmDialog
        open={icpToDelete !== null}
        onOpenChange={(open) => {
          if (!open) setIcpToDelete(null);
        }}
        title={tv.icpDeleteTitle}
        description={tv.icpDeleteDescription}
        confirmLabel={tv.icpDelete}
        cancelLabel={tv.cancel}
        variant="destructive"
        loading={deleteIcp.isPending}
        onConfirm={async () => {
          if (icpToDelete) await deleteIcp.mutateAsync(icpToDelete).catch(() => undefined);
        }}
      />
    </>
  );
}
