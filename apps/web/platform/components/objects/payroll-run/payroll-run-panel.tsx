/**
 * Payroll run object panel (WeldBooks).
 *
 * Built on the same shell as the company / person / bank account panels:
 * `useObjectPanelShell` + `EntityDetailView` + `ObjectPanelTabs`, so it
 * inherits the shared header chrome, the panel↔fullscreen toggle and the
 * stacking/back behaviour. It replaces the standalone `/weldbooks/payroll/:id`
 * page, which now redirects to the list with this panel open in fullscreen.
 *
 * Tabs: Details · Journal entry · History.
 */

import { useMemo, useState } from 'react';
import { Link } from '@tanstack/react-router';
import {
  BookOpen,
  CalendarDays,
  CircleDot,
  EllipsisVertical,
  FileText,
  HandCoins,
  Link as LinkIcon,
  Plug,
  Undo2,
} from 'lucide-react';
import { useTranslations } from '@weldsuite/i18n/client';
import { usePermissions } from '@weldsuite/permissions/react';
import { Button } from '@weldsuite/ui/components/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@weldsuite/ui/components/dropdown-menu';
import { EntityDetailView } from '@weldsuite/ui/components/entity-detail-view';
import { useObjectPanelShell, type ObjectPanelComponentProps } from '@/components/object-panel';
import { EntityAuditPanel } from '@/components/entity-audit-panel';
import { StatusChip } from '@/components/accounting/weldbooks-row-cells';
import { ConfigurablePanelTabs } from '@/components/objects/_shared/configurable-panel-tabs';
import {
  PanelAvatar,
  PanelRow,
  PanelNotice,
  PanelSection,
  useCopyPanelLink,
} from '@/components/objects/_shared/record-panel-parts';
import {
  NotesIllustration,
  TabEmptyState,
  tabBodyClassName,
} from '@/components/objects/_shared/tab-empty-state';
import { TabListRow, TabListScope } from '@/components/objects/_shared/tab-list-row';
import { usePayrollImport } from '@/hooks/queries/use-weldbooks-assets-queries';
import type { PayrollImportDetail, PayrollJournalLine } from '@/lib/api/domains/weldbooks-assets';
import { useI18n } from '@/lib/i18n/provider';
import { useWeldbooksFormat } from '@/lib/weldbooks/use-weldbooks-format';
import { toCents } from '@/app/weldbooks/fixed-assets/asset-math';
import { fill } from '@/app/weldbooks/fixed-assets/text';
import { ReversePayrollDialog } from '@/app/weldbooks/payroll/components/reverse-dialog';
import { getPayrollRunTabs, type PayrollRunTab } from './payroll-run-tabs';

const PAYROLL_RUN_PANEL_WIDTH = 480;
const PAYROLL_RUN_TYPE = 'payroll_run';
/** The entity type the audit log files a payroll import under. */
const PAYROLL_AUDIT_ENTITY = 'payroll_import';
const AMOUNT_CELL = 'w-[88px] flex-shrink-0 text-right text-sm tabular-nums';

type Translations = ReturnType<typeof useI18n>['t'];

function PayrollRunTitle({
  payroll,
  t,
}: Readonly<{ payroll?: PayrollImportDetail; t: Translations }>) {
  const { formatDate } = useWeldbooksFormat();
  if (!payroll) return <div className="h-4 w-32 rounded bg-muted animate-pulse" />;
  const tp = t.weldbooksUs.assets.payroll;
  return (
    <div className="flex min-w-0 items-center gap-2">
      <span className="truncate text-[15px] font-medium text-foreground">
        {fill(tp.detail.title, { date: formatDate(payroll.payDate) })}
      </span>
      <span className="flex-shrink-0">
        <StatusChip status={payroll.status}>{tp.statuses[payroll.status]}</StatusChip>
      </span>
    </div>
  );
}

function PayrollRunActions({
  payroll,
  canReverse,
  onReverse,
  t,
}: Readonly<{
  payroll?: PayrollImportDetail;
  canReverse: boolean;
  onReverse: () => void;
  t: Translations;
}>) {
  const st = useTranslations();
  const copyLink = useCopyPanelLink('/weldbooks/payroll', PAYROLL_RUN_TYPE, payroll?.id ?? '');
  if (!payroll) return null;
  const td = t.weldbooksUs.assets.payroll.detail;
  const showReverse = payroll.status === 'posted' && canReverse;

  return (
    <div className="flex items-center gap-0.5">
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
          {payroll.journalEntryId ? (
            <DropdownMenuItem asChild>
              <Link to="/weldbooks/journal/$id" params={{ id: payroll.journalEntryId }}>
                <BookOpen />
                {td.viewEntry}
              </Link>
            </DropdownMenuItem>
          ) : null}
          <DropdownMenuItem onClick={() => void copyLink()}>
            <LinkIcon />
            {st('sweep.entities.copyLink')}
          </DropdownMenuItem>
          {showReverse ? (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" onClick={onReverse} data-testid="reverse-open">
                <Undo2 />
                {td.reverse}
              </DropdownMenuItem>
            </>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

// ─── Details tab ───────────────────────────────────────────────────────────

function PayrollRunDetailsTab({
  payroll,
  t,
}: Readonly<{ payroll: PayrollImportDetail; t: Translations }>) {
  const { formatMoney, formatDate, formatDateTime } = useWeldbooksFormat();
  const tp = t.weldbooksUs.assets.payroll;
  const td = tp.detail;
  const categories = tp.categories as Record<string, string>;
  const summary = Object.entries(payroll.summary ?? {}).filter(([, value]) => value !== 0);
  const period =
    payroll.periodStart && payroll.periodEnd
      ? `${formatDate(payroll.periodStart)} – ${formatDate(payroll.periodEnd)}`
      : null;

  return (
    <div className="p-4 space-y-4">
      <div className="space-y-1">
        <PanelRow
          icon={CircleDot}
          label={tp.list.columns.status}
          value={tp.statuses[payroll.status]}
          renderValue={() => <StatusChip status={payroll.status}>{tp.statuses[payroll.status]}</StatusChip>}
        />
        <PanelRow
          icon={Plug}
          label={tp.list.columns.source}
          value={tp.sources[payroll.source]}
        />
        <PanelRow
          icon={CalendarDays}
          label={tp.list.columns.payDate}
          value={formatDate(payroll.payDate)}
        />
        <PanelRow icon={CalendarDays} label={tp.list.columns.period} value={period} />
        <PanelRow icon={FileText} label={tp.panel.sourceFile} value={payroll.sourceFileName} />
        <PanelRow
          icon={CalendarDays}
          label={tp.panel.importedOn}
          value={formatDateTime(payroll.createdAt)}
        />
        <PanelRow
          icon={BookOpen}
          label={td.lines}
          value={payroll.journalEntryId}
          renderValue={(entryId) => (
            <Link
              to="/weldbooks/journal/$id"
              params={{ id: entryId ?? '' }}
              className="text-primary hover:underline"
            >
              {td.viewEntry}
            </Link>
          )}
        />
      </div>

      {payroll.status === 'reversed' ? <PanelNotice>{td.reversedNote}</PanelNotice> : null}

      {summary.length > 0 ? (
        <PanelSection title={td.summary}>
          <dl className="text-sm">
            {summary.map(([key, value]) => (
              <div key={key} className="flex justify-between gap-3 border-b border-border py-1.5 last:border-b-0">
                <dt className="min-w-0 truncate text-muted-foreground">{categories[key] ?? key}</dt>
                <dd className="flex-shrink-0 font-medium tabular-nums">{formatMoney(value)}</dd>
              </div>
            ))}
          </dl>
        </PanelSection>
      ) : null}
    </div>
  );
}

// ─── Journal entry tab ─────────────────────────────────────────────────────

function JournalLineRow({ line }: Readonly<{ line: PayrollJournalLine }>) {
  const { formatMoney } = useWeldbooksFormat();
  const title = `${line.accountCode} — ${line.accountName}`;
  return (
    <TabListRow label={title}>
      <div className="min-w-0 flex-1">
        <Link
          to="/weldbooks/accounts/$id"
          params={{ id: line.accountId }}
          className="block truncate text-sm underline-offset-2 hover:underline"
        >
          {title}
        </Link>
        {line.description ? (
          <div className="truncate text-xs text-muted-foreground">{line.description}</div>
        ) : null}
      </div>
      <span className={AMOUNT_CELL}>{Number(line.debit) ? formatMoney(line.debit) : ''}</span>
      <span className={AMOUNT_CELL}>{Number(line.credit) ? formatMoney(line.credit) : ''}</span>
    </TabListRow>
  );
}

function PayrollRunJournalTab({
  payroll,
  t,
}: Readonly<{ payroll: PayrollImportDetail; t: Translations }>) {
  const { formatMoney } = useWeldbooksFormat();
  const tp = t.weldbooksUs.assets.payroll;
  const td = tp.detail;

  if (payroll.lines.length === 0) {
    return (
      <TabEmptyState
        bare
        illustration={<NotesIllustration />}
        title={tp.panel.noLinesTitle}
        description={td.noLines}
      />
    );
  }

  const totalDebit = payroll.lines.reduce((sum, line) => sum + toCents(line.debit), 0) / 100;
  const totalCredit = payroll.lines.reduce((sum, line) => sum + toCents(line.credit), 0) / 100;

  return (
    <TabListScope>
      <div className="flex items-center gap-4 border-b border-gray-200/70 px-4 py-2 text-xs text-muted-foreground dark:border-border">
        <span className="min-w-0 flex-1">{td.columns.account}</span>
        <span className={AMOUNT_CELL}>{td.columns.debit}</span>
        <span className={AMOUNT_CELL}>{td.columns.credit}</span>
        <span className="w-[40px] flex-shrink-0" />
      </div>
      {payroll.lines.map((line, index) => (
        <JournalLineRow key={`${line.accountId}-${index}`} line={line} />
      ))}
      <div className="flex items-center gap-4 px-4 py-3 text-sm font-medium">
        <span className="min-w-0 flex-1">{t.weldbooksUs.assets.common.total}</span>
        <span className={AMOUNT_CELL}>{formatMoney(totalDebit)}</span>
        <span className={AMOUNT_CELL}>{formatMoney(totalCredit)}</span>
        <span className="w-[40px] flex-shrink-0" />
      </div>
    </TabListScope>
  );
}

// ─── Panel ─────────────────────────────────────────────────────────────────

export function PayrollRunPanel(props: Readonly<ObjectPanelComponentProps>) {
  const { id, initialTab } = props;
  const { t } = useI18n();
  const st = useTranslations();
  const { can } = usePermissions();
  const tp = t.weldbooksUs.assets.payroll;
  const td = tp.detail;

  const payrollQuery = usePayrollImport(id);
  const payroll = payrollQuery.data;

  const [reversing, setReversing] = useState(false);

  const shell = useObjectPanelShell({
    ...props,
    width: PAYROLL_RUN_PANEL_WIDTH,
    loading: payrollQuery.isLoading && !payroll,
  });
  const mode = shell.mode;

  const tabs = useMemo(
    () =>
      getPayrollRunTabs({
        details: st('sweep.entities.detailsTab'),
        journal: td.lines,
        history: st('sweep.entities.auditLogTab'),
        journalCount: payroll?.lines.length || undefined,
      }),
    [st, td.lines, payroll?.lines.length],
  );

  const initial = useMemo<PayrollRunTab['id']>(() => {
    const match = tabs.find((tab) => tab.id === initialTab);
    return match?.id ?? 'overview';
  }, [initialTab, tabs]);
  const [activeTab, setActiveTab] = useState<PayrollRunTab['id']>(initial);

  return (
    <>
      <EntityDetailView
        {...shell.entityDetailViewProps}
        contentClassName={tabBodyClassName(mode)}
        avatar={
          <PanelAvatar
            icon={HandCoins}
            className="bg-emerald-100 text-emerald-600 dark:bg-emerald-900 dark:text-emerald-400"
          />
        }
        title={<PayrollRunTitle payroll={payroll} t={t} />}
        actions={
          <PayrollRunActions
            payroll={payroll}
            canReverse={can('journal:delete')}
            onReverse={() => setReversing(true)}
            t={t}
          />
        }
        tabs={
          <ConfigurablePanelTabs
            objectType={PAYROLL_RUN_TYPE}
            tabs={tabs}
            activeTab={activeTab}
            setActiveTab={setActiveTab}
            mode={mode}
          />
        }
      >
        {payrollQuery.isError && !payroll ? (
          <div className="space-y-3 p-4">
            <p className="text-sm text-destructive" role="alert">
              {td.loadFailed}
            </p>
            <Button variant="outline" size="sm" onClick={() => void payrollQuery.refetch()}>
              {t.weldbooksUs.assets.common.retry}
            </Button>
          </div>
        ) : null}
        {!payrollQuery.isLoading && !payrollQuery.isError && !payroll ? (
          <div className="p-6 text-center text-sm text-muted-foreground">{td.notFound}</div>
        ) : null}

        {payroll && activeTab === 'overview' ? <PayrollRunDetailsTab payroll={payroll} t={t} /> : null}
        {payroll && activeTab === 'journal' ? <PayrollRunJournalTab payroll={payroll} t={t} /> : null}
        {payroll && activeTab === 'history' ? (
          <EntityAuditPanel entityType={PAYROLL_AUDIT_ENTITY} entityId={payroll.id} />
        ) : null}
      </EntityDetailView>

      {reversing && payroll ? (
        <ReversePayrollDialog payroll={payroll} open onOpenChange={setReversing} />
      ) : null}
    </>
  );
}
