/**
 * VAT return object panel (WeldBooks).
 *
 * Built on the same shell as the company / person / bank account panels:
 * `useObjectPanelShell` + `EntityDetailView` + `ObjectPanelTabs`, so it
 * inherits the shared header chrome, the panel↔fullscreen toggle and the
 * stacking/back behaviour. It replaces the standalone `/weldbooks/vat/:id`
 * page, which now redirects to the list with this panel open in fullscreen.
 *
 * Tabs: Details · Return boxes · History.
 */

import { useMemo, useState } from 'react';
import {
  AlertCircle,
  ArrowDownLeft,
  ArrowUpRight,
  CalendarClock,
  CalendarDays,
  CheckCircle2,
  CircleDot,
  Download,
  EllipsisVertical,
  Hash,
  Link as LinkIcon,
  Receipt,
  Repeat,
  Scale,
  Send,
  ShieldCheck,
  Trash2,
  User,
} from 'lucide-react';
import { toast } from 'sonner';
import { useTranslations } from '@weldsuite/i18n/client';
import { usePermissions } from '@weldsuite/permissions/react';
import { Button } from '@weldsuite/ui/components/button';
import { ConfirmDialog } from '@weldsuite/ui/components/confirm-dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@weldsuite/ui/components/dropdown-menu';
import { EntityDetailView } from '@weldsuite/ui/components/entity-detail-view';
import {
  useObjectPanel,
  useObjectPanelShell,
  type ObjectPanelComponentProps,
} from '@/components/object-panel';
import { EntityAuditPanel } from '@/components/entity-audit-panel';
import { StatusChip } from '@/components/accounting/weldbooks-row-cells';
import { ConfigurablePanelTabs } from '@/components/objects/_shared/configurable-panel-tabs';
import {
  PanelAvatar,
  PanelRow,
  PanelSection,
  useCopyPanelLink,
} from '@/components/objects/_shared/record-panel-parts';
import { tabBodyClassName } from '@/components/objects/_shared/tab-empty-state';
import { TabListRow, TabListScope } from '@/components/objects/_shared/tab-list-row';
import { VatNotAvailable } from '@/app/weldbooks/vat/components/vat-not-available';
import { accountingApi, type VatReturn } from '@/lib/api/domains/weldbooks';
import { useI18n } from '@/lib/i18n/provider';
import { cn } from '@/lib/utils';
import { useCurrentJurisdiction } from '@/lib/weldbooks/use-jurisdiction';
import { useWeldbooksFormat } from '@/lib/weldbooks/use-weldbooks-format';
import {
  canDeleteVatReturn,
  canFileVatReturn,
  isFiledVatReturn,
  vatStatusTone,
  VAT_BOXES,
  VAT_TOTAL_KEYS,
} from './vat-return-model';
import { getVatReturnTabs, type VatReturnTab } from './vat-return-tabs';
import {
  useDeleteVatReturn,
  useFileVatReturn,
  useVatFilingStatus,
  useVatReturn,
  useVatSuppletie,
} from './use-vat-return-data';

const VAT_RETURN_PANEL_WIDTH = 480;
const VAT_RETURN_TYPE = 'vat_return';
const AMOUNT_CELL = 'w-[88px] flex-shrink-0 text-right text-sm tabular-nums';

type Translations = ReturnType<typeof useI18n>['t'];

/** The labels of a return's statuses: the VAT page's own, over the shared ones. */
function useVatStatusLabels(t: Translations): Record<string, string> {
  return useMemo(
    () => ({ ...t.accounting.vat.statuses, ...t.accounting.statusLabels.vatReturn }),
    [t],
  );
}

function periodTypeName(type: string, t: Translations): string {
  const types = t.accounting.vat.periodTypes as Record<string, string>;
  return type === 'yearly' || type === 'annual' ? types.annual : (types[type] ?? type);
}

function VatReturnTitle({ vr, t }: Readonly<{ vr?: VatReturn; t: Translations }>) {
  const { formatDate } = useWeldbooksFormat();
  const statusLabels = useVatStatusLabels(t);
  if (!vr) return <div className="h-4 w-32 rounded bg-muted animate-pulse" />;
  const tv = t.accounting.vat;
  const period = vr.periodLabel ?? `${formatDate(vr.periodStart)} — ${formatDate(vr.periodEnd)}`;
  return (
    <div className="flex min-w-0 items-center gap-2">
      <span className="truncate text-[15px] font-medium text-foreground">
        {tv.vatReturnTitle.replace('{period}', period)}
      </span>
      <span className="flex-shrink-0">
        <StatusChip tone={vatStatusTone(vr.status)}>{statusLabels[vr.status] ?? vr.status}</StatusChip>
      </span>
    </div>
  );
}

// ─── Actions ───────────────────────────────────────────────────────────────

function VatReturnActions({
  vr,
  filing,
  checkingStatus,
  checkingCorrections,
  onFile,
  onCheckStatus,
  onCheckCorrections,
  onDelete,
  t,
}: Readonly<{
  vr?: VatReturn;
  filing: boolean;
  checkingStatus: boolean;
  checkingCorrections: boolean;
  onFile: () => void;
  onCheckStatus: () => void;
  onCheckCorrections: () => void;
  onDelete: () => void;
  t: Translations;
}>) {
  const st = useTranslations();
  const { can } = usePermissions();
  const copyLink = useCopyPanelLink('/weldbooks/vat', VAT_RETURN_TYPE, vr?.id ?? '');
  if (!vr) return null;
  const tv = t.accounting.vat;

  const handleXmlDownload = async () => {
    try {
      const xml = await accountingApi.getVatReturnXml(vr.id);
      const blob = new Blob([xml], { type: 'application/xml' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `btw-aangifte-${vr.id}.xml`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      toast.error(err instanceof Error && err.message ? err.message : st('sweep.weldbooks.common.unknownError'));
    }
  };

  const filed = isFiledVatReturn(vr.status);

  return (
    <div className="flex items-center gap-0.5">
      {canFileVatReturn(vr.status) && can('reports:update') ? (
        <Button
          size="sm"
          className="mr-1 h-7"
          title={tv.fileToTax}
          aria-label={tv.fileToTax}
          onClick={onFile}
          disabled={filing}
        >
          <Send className="h-3.5 w-3.5" />
          {filing ? tv.filing : tv.file}
        </Button>
      ) : null}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            className="size-7 data-[state=open]:bg-accent dark:data-[state=open]:bg-accent/50"
            aria-label={t.common.actions.openMenu}
          >
            <EllipsisVertical className="h-4 w-4 text-muted-foreground" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {filed ? (
            <DropdownMenuItem onClick={onCheckStatus} disabled={checkingStatus}>
              <ShieldCheck />
              {checkingStatus ? tv.checkingStatus : tv.checkStatus}
            </DropdownMenuItem>
          ) : null}
          {filed && can('reports:create') ? (
            <DropdownMenuItem onClick={onCheckCorrections} disabled={checkingCorrections}>
              <Repeat />
              {checkingCorrections ? tv.suppletieChecking : tv.suppletieButton}
            </DropdownMenuItem>
          ) : null}
          <DropdownMenuItem onClick={() => void handleXmlDownload()}>
            <Download />
            {tv.downloadXml}
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => void copyLink()}>
            <LinkIcon />
            {st('sweep.entities.copyLink')}
          </DropdownMenuItem>
          {canDeleteVatReturn(vr.status) && can('reports:delete') ? (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" onClick={onDelete}>
                <Trash2 />
                {tv.deleteReturn}
              </DropdownMenuItem>
            </>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

// ─── Details tab ───────────────────────────────────────────────────────────

function VatReturnDetailsTab({
  vr,
  filedNotice,
  filingError,
  t,
}: Readonly<{
  vr: VatReturn;
  /** The return was filed from this panel a moment ago. */
  filedNotice: boolean;
  filingError: string | null;
  t: Translations;
}>) {
  const { formatMoney, formatDate, formatDateTime } = useWeldbooksFormat();
  const statusLabels = useVatStatusLabels(t);
  const tv = t.accounting.vat;
  const rubrieken = vr.rubrieken ?? {};
  const total = rubrieken.r5g ?? 0;

  return (
    <div className="@container p-4 space-y-4">
      {filedNotice ? (
        <p className="flex items-center gap-1 text-sm text-green-600 dark:text-green-400" role="status">
          <CheckCircle2 className="h-4 w-4" />
          {tv.filedSuccess}
        </p>
      ) : null}
      {filingError ? (
        <p className="flex items-center gap-1 text-sm text-red-600 dark:text-red-400" role="alert">
          <AlertCircle className="h-4 w-4" />
          {filingError}
        </p>
      ) : null}

      <div className="space-y-1">
        <PanelRow icon={ArrowUpRight} label={tv.colR5a} value={formatMoney(rubrieken.r5a)} />
        <PanelRow icon={ArrowDownLeft} label={tv.colR5b} value={formatMoney(rubrieken.r5b)} />
        <PanelRow
          icon={Scale}
          label={tv.colR5g}
          value={formatMoney(total)}
          renderValue={(value) => (
            <span className={total >= 0 ? 'text-red-600 dark:text-red-400' : 'text-green-600 dark:text-green-400'}>
              {value}
            </span>
          )}
        />
        <PanelRow
          icon={CircleDot}
          label={tv.status}
          value={statusLabels[vr.status] ?? vr.status}
          renderValue={(value) => <StatusChip tone={vatStatusTone(vr.status)}>{value}</StatusChip>}
        />
        <PanelRow
          icon={CalendarDays}
          label={tv.period}
          value={`${formatDate(vr.periodStart)} — ${formatDate(vr.periodEnd)}`}
        />
        <PanelRow icon={Repeat} label={tv.type} value={periodTypeName(vr.periodType, t)} />
        {vr.suppletieDeadline ? (
          <PanelRow
            icon={CalendarClock}
            label={tv.suppletieDeadlineLabel}
            value={formatDate(vr.suppletieDeadline)}
            renderValue={(value) => <span className="text-amber-700 dark:text-amber-400">{value}</span>}
          />
        ) : null}
        {vr.filingReference ? (
          <>
            <PanelRow icon={Hash} label={tv.digipoortKenmerk} value={vr.filingReference} />
            <PanelRow
              icon={CalendarDays}
              label={tv.filedAt}
              value={vr.filedAt ? formatDateTime(vr.filedAt) : null}
            />
            <PanelRow icon={User} label={tv.filedBy} value={vr.filedBy} />
          </>
        ) : null}
      </div>

      {vr.notes ? (
        <PanelSection title={tv.notesSection}>
          <p className="whitespace-pre-wrap text-sm">{vr.notes}</p>
        </PanelSection>
      ) : null}
    </div>
  );
}

// ─── Return boxes tab ──────────────────────────────────────────────────────

function VatReturnBoxesTab({ vr, t }: Readonly<{ vr: VatReturn; t: Translations }>) {
  const { formatMoney } = useWeldbooksFormat();
  const tv = t.accounting.vat;
  const rubrieken = vr.rubrieken ?? {};
  const labels = tv.rubriekLabels;

  return (
    <TabListScope>
      <div className="flex items-center gap-4 border-b border-gray-200/70 px-4 py-2 text-xs text-muted-foreground dark:border-border">
        <span className="min-w-0 flex-1" />
        <span className={AMOUNT_CELL}>{tv.colTurnover}</span>
        <span className={AMOUNT_CELL}>{tv.colVat}</span>
        <span className="w-[40px] flex-shrink-0" />
      </div>
      {VAT_BOXES.map(({ key, turnover, vat }) => {
        const label = labels[key as keyof typeof labels];
        return (
          <TabListRow key={key} label={label}>
            <span className="min-w-0 flex-1 text-sm">{label}</span>
            <span className={AMOUNT_CELL}>{formatMoney(rubrieken[turnover])}</span>
            <span className={AMOUNT_CELL}>{vat ? formatMoney(rubrieken[vat]) : ''}</span>
          </TabListRow>
        );
      })}
      {VAT_TOTAL_KEYS.map((key) => (
        <TabListRow key={key} label={labels[key]}>
          <span className={cn('min-w-0 flex-1 text-sm font-medium', key === 'r5g' && 'font-semibold')}>
            {labels[key]}
          </span>
          <span className={AMOUNT_CELL} />
          <span className={cn(AMOUNT_CELL, 'font-medium', key === 'r5g' && 'font-semibold')}>
            {formatMoney(rubrieken[key])}
          </span>
        </TabListRow>
      ))}
    </TabListScope>
  );
}

function VatReturnTabBody({
  vr,
  activeTab,
  filedNotice,
  filingError,
  t,
}: Readonly<{
  vr: Parameters<typeof VatReturnBoxesTab>[0]['vr'];
  activeTab: VatReturnTab['id'];
  filedNotice: boolean;
  filingError: string | null;
  t: Translations;
}>) {
  if (activeTab === 'boxes') return <VatReturnBoxesTab vr={vr} t={t} />;
  if (activeTab === 'history') return <EntityAuditPanel entityType={VAT_RETURN_TYPE} entityId={vr.id} />;
  return <VatReturnDetailsTab vr={vr} filedNotice={filedNotice} filingError={filingError} t={t} />;
}

// ─── Panel ─────────────────────────────────────────────────────────────────

export function VatReturnPanel(props: Readonly<ObjectPanelComponentProps>) {
  const { id, onClose, initialTab } = props;
  const { t } = useI18n();
  const st = useTranslations();
  const tv = t.accounting.vat;
  const { open: openPanel } = useObjectPanel();
  const { features, isResolved, isError: jurisdictionError } = useCurrentJurisdiction();

  const vatQuery = useVatReturn(id);
  const vr = vatQuery.data?.data;

  const fileMutation = useFileVatReturn(id);
  const deleteMutation = useDeleteVatReturn(id);
  const suppletieMutation = useVatSuppletie(id);
  const statusMutation = useVatFilingStatus(id);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const jurisdictionPending = !isResolved && !jurisdictionError;
  const shell = useObjectPanelShell({
    ...props,
    width: VAT_RETURN_PANEL_WIDTH,
    loading: (vatQuery.isLoading && !vr) || jurisdictionPending,
  });
  const mode = shell.mode;

  const tabs = useMemo(
    () =>
      getVatReturnTabs({
        details: st('sweep.entities.detailsTab'),
        boxes: tv.rubrieken,
        history: st('sweep.entities.auditLogTab'),
      }),
    [st, tv.rubrieken],
  );

  const initial = useMemo<VatReturnTab['id']>(() => {
    const match = tabs.find((tab) => tab.id === initialTab);
    return match?.id ?? 'overview';
  }, [initialTab, tabs]);
  const [activeTab, setActiveTab] = useState<VatReturnTab['id']>(initial);

  const handleDelete = () => {
    deleteMutation.mutate(undefined, {
      onSuccess: () => {
        toast.success(tv.returnDeleted);
        setConfirmDelete(false);
        onClose();
      },
      onError: (err) => {
        toast.error(tv.returnDeleteFailed, { description: err instanceof Error ? err.message : undefined });
        setConfirmDelete(false);
      },
    });
  };

  const handleCheckCorrections = () => {
    suppletieMutation.mutate(undefined, {
      onSuccess: (res) => {
        const result = res.data;
        toast.info(result.message);
        // A correction is a return of its own: open it on top, so back returns to this one.
        if (result.correctionRequired && result.id) {
          openPanel({ type: VAT_RETURN_TYPE, id: result.id, mode, stack: true });
        }
      },
      onError: (err) => toast.error(err?.message ?? st('sweep.weldbooks.vat.suppletieCheckFailed')),
    });
  };

  const handleCheckStatus = () => {
    statusMutation.mutate(undefined, {
      onSuccess: (res) => toast.info(tv.statusResult.replace('{status}', String(res.data.status))),
      onError: (err) => toast.error(err?.message ?? st('sweep.weldbooks.vat.statusCheckFailed')),
    });
  };

  const filingError = fileMutation.isError
    ? tv.filingFailed.replace(
        '{error}',
        fileMutation.error?.message || st('sweep.weldbooks.common.unknownError'),
      )
    : null;

  let body = null;
  if (!jurisdictionPending && !features.vatReturn) {
    body = <VatNotAvailable title={tv.notAvailableTitle} description={tv.notAvailableDescription} />;
  } else if (!vatQuery.isLoading && vatQuery.isError) {
    body = <div className="p-4 text-sm text-destructive">{st('sweep.entities.failedToLoad')}</div>;
  } else if (!vatQuery.isLoading && !vr) {
    body = <div className="p-6 text-center text-sm text-muted-foreground">{tv.vatNotFound}</div>;
  } else if (vr) {
    body = (
      <VatReturnTabBody
        vr={vr}
        activeTab={activeTab}
        filedNotice={fileMutation.isSuccess}
        filingError={filingError}
        t={t}
      />
    );
  }

  return (
    <>
      <EntityDetailView
        {...shell.entityDetailViewProps}
        contentClassName={tabBodyClassName(mode)}
        avatar={
          <PanelAvatar
            icon={Receipt}
            className="bg-indigo-100 text-indigo-600 dark:bg-indigo-900 dark:text-indigo-400"
          />
        }
        title={<VatReturnTitle vr={vr} t={t} />}
        actions={
          <VatReturnActions
            vr={features.vatReturn ? vr : undefined}
            filing={fileMutation.isPending}
            checkingStatus={statusMutation.isPending}
            checkingCorrections={suppletieMutation.isPending}
            onFile={() => fileMutation.mutate()}
            onCheckStatus={handleCheckStatus}
            onCheckCorrections={handleCheckCorrections}
            onDelete={() => setConfirmDelete(true)}
            t={t}
          />
        }
        tabs={
          <ConfigurablePanelTabs
            objectType={VAT_RETURN_TYPE}
            tabs={tabs}
            activeTab={activeTab}
            setActiveTab={setActiveTab}
            mode={mode}
          />
        }
      >
        {body}
      </EntityDetailView>

      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={tv.deleteReturnTitle}
        description={tv.deleteReturnDescription}
        confirmLabel={tv.deleteReturn}
        cancelLabel={tv.keepReturn}
        variant="destructive"
        loading={deleteMutation.isPending}
        onConfirm={handleDelete}
      />
    </>
  );
}
