import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { VatNotAvailable } from './components/vat-not-available';
import GstReturnPage from './gst-return-page';
import BrApuracaoPage from './br-apuracao-page';
import { toast } from 'sonner';
import { PageLoader } from '@weldsuite/ui/components/page-loader';
import { useAccountingVatReturns, useCalculateVatReturn } from '@/hooks/queries/use-accounting-queries';
import { accountingApi, type IcpDeclaration } from '@/lib/api/domains/weldbooks';
import { Button } from '@weldsuite/ui/components/button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@weldsuite/ui/components/dialog';
import { FileText, Receipt, ShieldCheck, Trash2 } from 'lucide-react';
import { EmptyStateIllustration, type ColumnDef, type FilterConfig } from '@/components/entity-list';
import { applyPillFilters } from '@/lib/weldbooks/list-filters';
import { WeldbooksEntityList } from '@/components/accounting/weldbooks-entity-list';
import {
  RowAmount,
  RowText,
  RowTitle,
  StatusChip,
} from '@/components/accounting/weldbooks-row-cells';
import { ConfirmDialog } from '@weldsuite/ui/components/confirm-dialog';
import { useObjectPanel, useObjectPanelUrlSync } from '@/components/object-panel';
import {
  canCheckFilingStatus,
  canDeleteVatReturn,
  canFileVatReturn,
  vatStatusTone,
  vatTotalToneClass,
} from '@/components/objects/vat-return/vat-return-model';
import { PreprodBadge } from '@/components/accounting/digipoort-filing';
import { useI18n } from '@/lib/i18n/provider';
import { useTranslations } from '@weldsuite/i18n/client';
import { useCurrentAccountingEntity } from '@/hooks/use-current-accounting-entity';
import { useWeldbooksFormat } from '@/lib/weldbooks/use-weldbooks-format';
import { useCurrentJurisdiction } from '@/lib/weldbooks/use-jurisdiction';
import { isFeatureAvailable } from '@/lib/edition';
import type { TranslationsType } from '@weldsuite/i18n/types';
import {
  lastFinishedPeriod,
  periodBounds,
  periodIssue,
  periodLabel as labelOfPeriod,
  type ReturnPeriod,
  type ReturnPeriodType,
} from './return-periods';
import { ReturnPeriodFields } from './components/return-period-fields';

interface VatReturnRow {
  id: string;
  periodType: string;
  periodStart: string | null;
  periodEnd: string | null;
  periodLabel: string | null;
  status: string;
  rubrieken?: Record<string, number> | null;
}

/** Why the typed-in dates can't be filed, or null. */
function periodErrorText(
  tv: TranslationsType['accounting']['vat'],
  type: ReturnPeriodType,
  start: string,
  end: string,
): string | null {
  const issue = periodIssue(type, start, end);
  if (issue === 'reversed') return tv.invalidPeriod;
  if (issue === 'notWhole') return tv.periodNotWhole[type];
  return null;
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
  const { t, language } = useI18n();
  const st = useTranslations();
  const tv = t.accounting.vat;
  const tslVat = { ...t.accounting.vat.statuses, ...t.accounting.statusLabels.vatReturn };
  const { entityId } = useCurrentAccountingEntity();
  const [showDialog, setShowDialog] = useState(false);
  const [dialogMode, setDialogMode] = useState<'vat' | 'icp'>('vat');
  const [periodType, setPeriodType] = useState<ReturnPeriodType>('quarterly');
  const [period, setPeriod] = useState<ReturnPeriod>(() => lastFinishedPeriod('quarterly', new Date()));
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

  const td = t.weldbooksNl.digipoort;

  // A refused filing answers with the reason (the Belastingdienst's, or Digipoort's): show it as it is.
  const fileIcp = useMutation({
    mutationFn: (icpId: string) => accountingApi.fileIcpDeclaration(icpId),
    onSuccess: (res) => {
      void qc.invalidateQueries({ queryKey: ['accounting', 'icp-declarations'] });
      toast.success(res.data?.status === 'submitted' ? td.icpSubmitted : td.icpFiled);
    },
    onError: (err) => toast.error(err?.message ?? st('sweep.weldbooks.vat.icpFilingFailed')),
  });

  // Asks Digipoort, then reads the declaration again so its new status shows.
  const checkIcpStatus = useMutation({
    mutationFn: (icpId: string) => accountingApi.getIcpFilingStatus(icpId),
    onSuccess: (res) => {
      void qc.invalidateQueries({ queryKey: ['accounting', 'icp-declarations'] });
      const result = res.data;
      if (result.success === false) {
        toast.error(result.error ?? td.statusCheckFailed);
        return;
      }
      toast.info(td.icpStatusResult.replace('{status}', td.statusLabels[result.status]), {
        description: result.statusDescription || result.reason || undefined,
      });
    },
    onError: (err) => toast.error(err?.message ?? td.statusCheckFailed),
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

  // Picking a month, quarter or year fills in its dates and label; the dates stay editable.
  const applyPeriod = (type: ReturnPeriodType, next: ReturnPeriod) => {
    const bounds = periodBounds(type, next);
    setPeriodType(type);
    setPeriod(next);
    setPeriodStart(bounds.start);
    setPeriodEnd(bounds.end);
    setPeriodLabel(labelOfPeriod(type, next, language));
  };

  const periodError = periodErrorText(tv, periodType, periodStart, periodEnd);

  const handleCalculate = () => {
    if (!periodStart || !periodEnd) return;
    if (periodError) {
      toast.error(periodError);
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
    applyPeriod(periodType, lastFinishedPeriod(periodType, new Date()));
    setShowDialog(true);
  };
  const openIcpDialog = () => {
    setDialogMode('icp');
    applyPeriod(periodType, lastFinishedPeriod(periodType, new Date()));
    setShowDialog(true);
  };

  const returnColumns: ColumnDef<VatReturnRow>[] = [
    {
      id: 'period',
      header: tv.colPeriod,
      // Narrow list (a record panel open, a phone): the period, the total and the status stay.
      width: 'min-w-0 flex-1 gap-2 @2xl/list:min-w-[200px]',
      render: (vr) => <RowTitle>{vr.periodLabel || periodRange(vr.periodStart, vr.periodEnd)}</RowTitle>,
    },
    {
      id: 'type',
      header: tv.colType,
      width: 'hidden shrink-0 @4xl/list:flex w-[120px]',
      render: (vr) => <RowText>{periodTypeLabel(vr.periodType)}</RowText>,
    },
    {
      id: 'r5a',
      header: tv.colR5a,
      width: 'hidden shrink-0 @3xl/list:flex w-[130px]',
      render: (vr) => <RowAmount>{fmt(vr.rubrieken?.r5a)}</RowAmount>,
    },
    {
      id: 'r5b',
      header: tv.colR5b,
      width: 'hidden shrink-0 @3xl/list:flex w-[130px]',
      render: (vr) => <RowAmount>{fmt(vr.rubrieken?.r5b)}</RowAmount>,
    },
    {
      id: 'r5g',
      header: tv.colR5g,
      width: 'shrink-0 w-[130px]',
      render: (vr) => {
        const r5g = vr.rubrieken?.r5g ?? 0;
        return <RowAmount className={`font-medium ${vatTotalToneClass(r5g)}`}>{fmt(r5g)}</RowAmount>;
      },
    },
    {
      id: 'status',
      header: tv.colStatus,
      width: 'shrink-0 w-[110px]',
      render: (vr) => statusChip(vr.status),
    },
  ];

  // Filter options are the statuses (and, for returns, the period types) the rows have.
  const optionsOf = (values: string[], label: (value: string) => string) =>
    [...new Set(values)].map((value) => ({ value, label: label(value) }));
  const statusLabel = (status: string) => tslVat[status as keyof typeof tslVat] ?? status;
  const returnFilters: FilterConfig[] = [
    { field: 'status', label: tv.colStatus, options: optionsOf(returns.map((vr) => vr.status), statusLabel) },
    { field: 'type', label: tv.colType, options: optionsOf(returns.map((vr) => vr.periodType), periodTypeLabel) },
  ];
  const icpFilters: FilterConfig[] = [
    { field: 'status', label: tv.colStatus, options: optionsOf(icpDeclarations.map((d) => d.status), statusLabel) },
  ];

  const icpColumns: ColumnDef<IcpDeclaration>[] = [
    {
      id: 'period',
      header: tv.colPeriod,
      width: 'min-w-0 flex-1 gap-2 @2xl/list:min-w-[200px]',
      render: (d) => (
        <RowTitle
          chips={
            <>
              <PreprodBadge row={d} />
              {d.status === 'rejected' && d.rejectionReason ? (
                <span title={d.rejectionReason} className="hidden min-w-0 truncate text-xs text-destructive @3xl/list:inline">
                  {d.rejectionReason}
                </span>
              ) : null}
            </>
          }
        >
          {d.periodLabel || periodRange(d.periodStart, d.periodEnd)}
        </RowTitle>
      ),
    },
    {
      id: 'total',
      header: tv.icpColTotal,
      width: 'shrink-0 w-[130px]',
      render: (d) => <RowAmount>{fmt(d.totalAmount)}</RowAmount>,
    },
    {
      id: 'status',
      header: tv.colStatus,
      width: 'shrink-0 w-[110px]',
      render: (d) => statusChip(d.status),
    },
    {
      id: 'actions',
      header: '',
      width: 'shrink-0 w-[200px] justify-end gap-2',
      render: (d) => (
        <>
          {canCheckFilingStatus(d.status) && isFeatureAvailable('vat-digipoort') ? (
            <Button
              size="sm"
              variant="outline"
              className="h-7"
              disabled={checkIcpStatus.isPending}
              onClick={() => checkIcpStatus.mutate(d.id)}
            >
              <ShieldCheck className="h-3.5 w-3.5" />
              {checkIcpStatus.isPending && checkIcpStatus.variables === d.id ? tv.checkingStatus : tv.checkStatus}
            </Button>
          ) : null}
          {canFileVatReturn(d.status) && isFeatureAvailable('vat-digipoort') ? (
            <Button size="sm" variant="outline" className="h-7" disabled={fileIcp.isPending} onClick={() => fileIcp.mutate(d.id)}>
              {tv.icpFile}
            </Button>
          ) : null}
          {canDeleteVatReturn(d.status) && d.status !== 'draft' ? (
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
          ) : null}
        </>
      ),
    },
  ];

  return (
    // One scroll for the whole page: the two lists keep their natural height instead of shrinking into clipped regions.
    <div className="h-full min-h-0 overflow-y-auto">
      {/* BTW-aangiftes */}
      <div className="flex-none shrink-0">
      {showIcp ? <h2 className="px-4 pt-4 text-sm font-semibold sm:px-6">{tv.returnsTitle}</h2> : null}
      <WeldbooksEntityList<VatReturnRow>
        emptyStateClassName="min-h-0 py-10"
        items={returns}
        isLoading={false}
        columns={returnColumns}
        onRowClick={(vr) => openPanel({ type: 'vat_return', id: vr.id })}
        getRowLabel={(vr) => vr.periodLabel || periodRange(vr.periodStart, vr.periodEnd)}
        filters={returnFilters}
        applyFilters={(rows, active) =>
          applyPillFilters(rows, active, { status: (vr) => vr.status, type: (vr) => vr.periodType })
        }
        searchFields={['periodLabel']}
        searchPlaceholder={tv.searchPlaceholder}
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
      </div>

      {/* EC Sales List (ICP) — only where the jurisdiction has it */}
      {showIcp ? (
        <div className="flex-none shrink-0">
          <div className="px-4 pt-6 sm:px-6">
            <h2 className="text-sm font-semibold">{tv.icpTitle}</h2>
            <p className="mt-1 text-sm text-muted-foreground">{tv.icpDesc}</p>
          </div>
          <WeldbooksEntityList<IcpDeclaration>
            emptyStateClassName="min-h-0 py-10"
            items={icpDeclarations}
            isLoading={false}
            columns={icpColumns}
            filters={icpFilters}
            applyFilters={(rows, active) => applyPillFilters(rows, active, { status: (d) => d.status })}
            searchFields={['periodLabel', 'filingReference', 'notes']}
            searchPlaceholder={tv.icpSearchPlaceholder}
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
        </div>
      ) : null}

      <Dialog open={showDialog} onOpenChange={setShowDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{dialogMode === 'icp' ? tv.icpNew : tv.calculateReturn}</DialogTitle>
          </DialogHeader>
          <ReturnPeriodFields
            periodType={periodType}
            period={period}
            periodStart={periodStart}
            periodEnd={periodEnd}
            periodLabel={periodLabel}
            periodError={periodError}
            onPick={applyPeriod}
            onStartChange={setPeriodStart}
            onEndChange={setPeriodEnd}
            onLabelChange={setPeriodLabel}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowDialog(false)}>{tv.cancel}</Button>
            <Button
              onClick={handleCalculate}
              disabled={!periodStart || !periodEnd || Boolean(periodError) || calculateMutation.isPending || calculateIcp.isPending}
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
    </div>
  );
}
