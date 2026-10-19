/**
 * Deposit object panel (WeldBooks, US entities).
 *
 * Built on the same shell as the company / person / bank account panels:
 * `useObjectPanelShell` + `EntityDetailView` + `ObjectPanelTabs`, so it
 * inherits the shared header chrome, the panel↔fullscreen toggle and the
 * stacking/back behaviour. It replaces the standalone
 * `/weldbooks/deposits/:id` page, which now redirects to the list with this
 * panel open in fullscreen.
 *
 * Deposits are a US practice: for an entity of another country the panel shows
 * the same notice the list page does, and the deposit is never fetched.
 *
 * Tabs: Details · Payments · History.
 */

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  Ban,
  BookText,
  Building2,
  CalendarDays,
  CircleDot,
  EllipsisVertical,
  Link as LinkIcon,
  Pencil,
} from 'lucide-react';
import { toast } from 'sonner';
import { useTranslations } from '@weldsuite/i18n/client';
import { usePermissions } from '@weldsuite/permissions/react';
import { Button } from '@weldsuite/ui/components/button';
import { ConfirmDialog } from '@weldsuite/ui/components/confirm-dialog';
import { DrawerFieldSettings } from '@weldsuite/ui/components/drawer-field-settings';
import { EntityDetailView } from '@weldsuite/ui/components/entity-detail-view';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@weldsuite/ui/components/dropdown-menu';
import {
  ObjectPanelTabs,
  useObjectPanel,
  useObjectPanelShell,
  useObjectPanelTabConfig,
  type ObjectPanelComponentProps,
} from '@/components/object-panel';
import { EntityAuditPanel } from '@/components/entity-audit-panel';
import { PropertyRow } from '@/components/objects/_shared/property-row';
import { TabListRow, TabListScope } from '@/components/objects/_shared/tab-list-row';
import {
  useBankDeposit,
  useUpdateBankDepositMemo,
  useVoidBankDeposit,
} from '@/hooks/queries/use-weldbooks-banking-queries';
import { useWorkspaceUrl } from '@/hooks/use-workspace-url';
import type { BankDepositDetail, DepositOtherLineView, DepositPaymentRow } from '@/lib/api/domains/weldbooks-banking';
import { useI18n } from '@/lib/i18n/provider';
import { cn } from '@/lib/utils';
import { useCurrentJurisdiction } from '@/lib/weldbooks/use-jurisdiction';
import { isUsJurisdictionCode } from '@/lib/weldbooks/us-entity';
import { useWeldbooksFormat } from '@/lib/weldbooks/use-weldbooks-format';
import { getDepositTabs, type DepositTab } from './deposit-tabs';

const DEPOSIT_PANEL_WIDTH = 480;

const PILL = 'inline-flex items-center h-[22px] px-2 rounded text-[12px] font-medium leading-none';
const PILL_GREEN = 'text-emerald-600 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-950';
const PILL_GRAY = 'text-gray-600 dark:text-muted-foreground bg-gray-100 dark:bg-secondary';

type Translations = ReturnType<typeof useI18n>['t'];

function messageOf(error: unknown): string {
  return error instanceof Error && error.message ? error.message : String(error);
}

function DepositTitle({ deposit, t }: Readonly<{ deposit?: BankDepositDetail; t: Translations }>) {
  const { formatMoney, entityCurrency } = useWeldbooksFormat();
  if (!deposit) return <div className="h-4 w-32 rounded bg-muted animate-pulse" />;
  const td = t.weldbooksUs.banking.deposits;
  return (
    <div className="flex min-w-0 items-center gap-2">
      <span className="relative top-px truncate text-[15px] font-medium tabular-nums text-foreground">
        {formatMoney(deposit.amount, deposit.currency || entityCurrency)}
      </span>
      <span className={cn(PILL, deposit.status === 'void' ? PILL_GRAY : PILL_GREEN, 'flex-shrink-0')}>
        {td.statuses[deposit.status]}
      </span>
      {deposit.bankTransactionId ? (
        <span className={cn(PILL, PILL_GRAY, 'flex-shrink-0')}>{td.matched}</span>
      ) : null}
    </div>
  );
}

function DepositActions({
  deposit,
  canVoid,
  onVoid,
  t,
}: Readonly<{
  deposit?: BankDepositDetail;
  canVoid: boolean;
  onVoid: () => void;
  t: Translations;
}>) {
  const st = useTranslations();
  const workspaceUrl = useWorkspaceUrl();
  if (!deposit) return null;
  const tdd = t.weldbooksUs.banking.deposits.detail;

  const handleCopyLink = async () => {
    try {
      await navigator.clipboard.writeText(workspaceUrl(`/weldbooks/deposits?stack=deposit:${deposit.id}`));
      toast.success(st('sweep.entities.linkCopied'));
    } catch {
      toast.error(st('sweep.entities.copyLinkFailed'));
    }
  };

  return (
    <div className="flex items-center gap-1">
      {canVoid ? (
        <Button variant="outline" size="sm" onClick={onVoid} data-testid="void-deposit">
          <Ban className="h-4 w-4" />
          {tdd.void}
        </Button>
      ) : null}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            className="size-7 data-[state=open]:bg-accent dark:data-[state=open]:bg-accent/50"
            aria-label={st('sweep.entities.copyLink')}
          >
            <EllipsisVertical className="h-4 w-4 text-muted-foreground" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onClick={() => void handleCopyLink()}>
            <LinkIcon />
            {st('sweep.entities.copyLink')}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

// ─── Tab bar ───────────────────────────────────────────────────────────────

function DepositTabsBar({
  tabs,
  activeTab,
  setActiveTab,
  mode,
}: Readonly<{
  tabs: DepositTab[];
  activeTab: DepositTab['id'];
  setActiveTab: (id: DepositTab['id']) => void;
  mode: 'panel' | 'fullscreen';
}>) {
  const st = useTranslations();
  const configEntries = useMemo(
    () =>
      tabs.map((tab) => ({
        id: tab.id,
        label: tab.label,
        required: tab.required,
        defaultVisible:
          mode === 'panel' ? (tab.defaultVisibleInPanel ?? false) : (tab.defaultVisibleInFullscreen ?? false),
      })),
    [tabs, mode],
  );

  const { visibility, isVisible, toggle, resetToDefaults } = useObjectPanelTabConfig({
    objectType: 'deposit',
    mode,
    tabs: configEntries,
  });

  useEffect(() => {
    if (isVisible(activeTab)) return;
    const fallback = tabs.find((tab) => isVisible(tab.id));
    if (fallback && fallback.id !== activeTab) setActiveTab(fallback.id);
  }, [activeTab, isVisible, setActiveTab, tabs]);

  const visibleTabs = useMemo(
    () =>
      tabs
        .filter((tab) => isVisible(tab.id))
        .map((tab) => ({ id: tab.id, label: tab.label, icon: tab.icon, count: tab.count })),
    [tabs, isVisible],
  );

  return (
    <div className="group/tabs-header relative">
      <ObjectPanelTabs
        tabs={visibleTabs}
        activeTab={activeTab}
        onChange={(id) => setActiveTab(id as DepositTab['id'])}
      />
      <div className="absolute top-0 right-2 h-full flex items-center opacity-0 group-hover/tabs-header:opacity-100 focus-within:opacity-100 transition-opacity">
        <DrawerFieldSettings
          fields={configEntries}
          fieldVisibility={visibility}
          onToggle={toggle}
          onReset={resetToDefaults}
          label={st('sweep.entities.visibleTabs')}
        />
      </div>
    </div>
  );
}

// ─── Details tab ───────────────────────────────────────────────────────────

function DepositDetailsTab({
  deposit,
  canEdit,
  t,
}: Readonly<{ deposit: BankDepositDetail; canEdit: boolean; t: Translations }>) {
  const st = useTranslations();
  const { open: openPanel } = useObjectPanel();
  const { formatDate } = useWeldbooksFormat();
  const updateMemo = useUpdateBankDepositMemo();
  const td = t.weldbooksUs.banking.deposits;
  const tdd = td.detail;
  const isVoid = deposit.status === 'void';

  return (
    <div className="@container p-4">
      <div className="space-y-1">
        <PropertyRow
          icon={CircleDot}
          label={st('sweep.entities.fieldStatus')}
          value={td.statuses[deposit.status]}
          readOnly
          renderValue={(value) => <span className={cn(PILL, isVoid ? PILL_GRAY : PILL_GREEN)}>{value}</span>}
        />
        <PropertyRow icon={CalendarDays} label={td.columns.date} value={formatDate(deposit.date)} tabular readOnly />
        <PropertyRow icon={Building2} label={td.columns.bankAccount} value={deposit.bankAccountName} placeholder="—" readOnly />
        <PropertyRow
          icon={BookText}
          label={tdd.journalEntry}
          value={deposit.journalEntryId ? (deposit.journalEntryNumber ?? deposit.journalEntryId) : null}
          placeholder="—"
          readOnly
          renderValue={(value) => (
            <button
              type="button"
              className="min-w-0 truncate text-primary hover:underline"
              onClick={() => {
                if (deposit.journalEntryId) {
                  openPanel({ type: 'journal_entry', id: deposit.journalEntryId, stack: true });
                }
              }}
            >
              {value}
            </button>
          )}
        />
        <PropertyRow
          icon={LinkIcon}
          label={td.columns.bankLine}
          value={deposit.bankTransactionId ? tdd.matchedToLine : tdd.notMatched}
          readOnly
        />
        <PropertyRow
          icon={Pencil}
          label={td.columns.memo}
          value={deposit.memo}
          placeholder={canEdit ? undefined : '—'}
          readOnly={!canEdit}
          onSave={
            canEdit
              ? (next) =>
                  updateMemo.mutate(
                    { id: deposit.id, memo: next },
                    { onError: (error) => toast.error(messageOf(error)) },
                  )
              : undefined
          }
        />
      </div>
    </div>
  );
}

// ─── Payments tab ──────────────────────────────────────────────────────────

function SectionTitle({ children }: Readonly<{ children: ReactNode }>) {
  return <h3 className="px-4 pb-2 text-sm font-medium">{children}</h3>;
}

function PaymentRow({
  payment,
  currency,
  t,
}: Readonly<{ payment: DepositPaymentRow; currency: string | null; t: Translations }>) {
  const { formatMoney, formatDate } = useWeldbooksFormat();
  const methodLabels = t.accounting.paymentMethods;
  const method =
    payment.paymentMethod && payment.paymentMethod in methodLabels
      ? methodLabels[payment.paymentMethod as keyof typeof methodLabels]
      : payment.paymentMethod;
  const detail = [method, payment.checkNumber ? `#${payment.checkNumber}` : null, payment.reference]
    .filter(Boolean)
    .join(' · ');
  const from = payment.contactName ?? '—';

  return (
    <TabListRow label={from}>
      <span className="w-[92px] flex-shrink-0 whitespace-nowrap text-sm tabular-nums">
        {formatDate(payment.date)}
      </span>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm">{from}</div>
        {detail ? <div className="truncate text-xs text-muted-foreground">{detail}</div> : null}
      </div>
      <span className="flex-shrink-0 text-right text-sm font-medium tabular-nums">
        {formatMoney(payment.amount, payment.currency || currency)}
      </span>
    </TabListRow>
  );
}

function OtherLineRow({ line, currency }: Readonly<{ line: DepositOtherLineView; currency: string | null }>) {
  const { formatMoney } = useWeldbooksFormat();
  const account = line.accountCode
    ? `${line.accountCode} — ${line.accountName ?? ''}`
    : (line.accountName ?? line.accountId);
  return (
    <TabListRow label={account}>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm">{account}</div>
        {line.description ? <div className="truncate text-xs text-muted-foreground">{line.description}</div> : null}
      </div>
      <span className="flex-shrink-0 text-right text-sm font-medium tabular-nums">
        {formatMoney(line.amount, currency)}
      </span>
    </TabListRow>
  );
}

function DepositPaymentsTab({
  deposit,
  currency,
  t,
}: Readonly<{ deposit: BankDepositDetail; currency: string | null; t: Translations }>) {
  const { formatMoney } = useWeldbooksFormat();
  const tdd = t.weldbooksUs.banking.deposits.detail;
  const paymentsTotal =
    deposit.payments.reduce((sum, payment) => sum + Math.round(Number(payment.amount) * 100), 0) / 100;

  return (
    <div className="space-y-6 py-4">
      <section>
        <SectionTitle>{tdd.paymentsTitle}</SectionTitle>
        {deposit.payments.length === 0 ? (
          <p className="px-4 text-sm text-muted-foreground">{tdd.noPayments}</p>
        ) : (
          <TabListScope>
            <div className="border-t border-gray-200/70 dark:border-border">
              {deposit.payments.map((payment) => (
                <PaymentRow key={payment.id} payment={payment} currency={currency} t={t} />
              ))}
            </div>
            <div className="flex items-center justify-between gap-4 px-4 pt-3 text-sm font-medium">
              <span>{tdd.paymentsSubtotal}</span>
              <span className="tabular-nums">{formatMoney(paymentsTotal, currency)}</span>
            </div>
          </TabListScope>
        )}
      </section>

      {deposit.otherLines.length > 0 ? (
        <section>
          <SectionTitle>{tdd.otherTitle}</SectionTitle>
          <TabListScope>
            <div className="border-t border-gray-200/70 dark:border-border">
              {deposit.otherLines.map((line) => (
                <OtherLineRow
                  key={`${line.accountId}:${line.amount}:${line.description ?? ''}`}
                  line={line}
                  currency={currency}
                />
              ))}
            </div>
          </TabListScope>
        </section>
      ) : null}
    </div>
  );
}

// ─── Panel ─────────────────────────────────────────────────────────────────

function UsOnlyNotice({ t }: Readonly<{ t: Translations }>) {
  const tu = t.weldbooksUs.banking.deposits.usOnly;
  return (
    <div className="space-y-2 p-6 text-center">
      <p className="font-medium">{tu.title}</p>
      <p className="text-sm text-muted-foreground">{tu.description}</p>
    </div>
  );
}

export function DepositPanel(props: Readonly<ObjectPanelComponentProps>) {
  const { id, initialTab } = props;
  const { t } = useI18n();
  const st = useTranslations();
  const { can } = usePermissions();
  const { entityCurrency } = useWeldbooksFormat();
  const tdd = t.weldbooksUs.banking.deposits.detail;

  // Deposits are for US entities; another entity's deposit is never fetched.
  const { code: jurisdictionCode, isError: jurisdictionError } = useCurrentJurisdiction();
  const usOnly = !!jurisdictionCode && !isUsJurisdictionCode(jurisdictionCode);
  const jurisdictionKnown = !!jurisdictionCode || jurisdictionError;

  const depositQuery = useBankDeposit(jurisdictionKnown && !usOnly ? id : undefined);
  const deposit = depositQuery.data;
  const voidDeposit = useVoidBankDeposit();
  const [confirmVoid, setConfirmVoid] = useState(false);

  const shell = useObjectPanelShell({
    ...props,
    width: DEPOSIT_PANEL_WIDTH,
    loading: !usOnly && (!jurisdictionKnown || (depositQuery.isLoading && !deposit)),
  });
  const mode = shell.mode;

  const paymentsCount = deposit?.payments.length ?? 0;
  const tabs = useMemo(
    () =>
      getDepositTabs({
        details: st('sweep.entities.detailsTab'),
        payments: tdd.paymentsSubtotal,
        history: st('sweep.entities.auditLogTab'),
        paymentsCount: paymentsCount || undefined,
      }),
    [st, tdd.paymentsSubtotal, paymentsCount],
  );

  const initial = useMemo<DepositTab['id']>(() => {
    const match = tabs.find((tab) => tab.id === initialTab);
    return match?.id ?? 'overview';
  }, [initialTab, tabs]);
  const [activeTab, setActiveTab] = useState<DepositTab['id']>(initial);

  const isVoid = deposit?.status === 'void';
  const canEdit = can('banking:update') && !isVoid;
  const currency = deposit?.currency || entityCurrency;

  const handleVoid = async () => {
    try {
      await voidDeposit.mutateAsync(id);
    } catch (error) {
      toast.error(messageOf(error));
    }
    setConfirmVoid(false);
  };

  return (
    <>
      <EntityDetailView
        {...shell.entityDetailViewProps}
        title={<DepositTitle deposit={deposit} t={t} />}
        actions={
          <DepositActions deposit={deposit} canVoid={canEdit} onVoid={() => setConfirmVoid(true)} t={t} />
        }
        tabs={<DepositTabsBar tabs={tabs} activeTab={activeTab} setActiveTab={setActiveTab} mode={mode} />}
      >
        {usOnly && <UsOnlyNotice t={t} />}
        {!usOnly && !depositQuery.isLoading && depositQuery.isError && (
          <div className="p-4 text-sm text-destructive">{st('sweep.entities.failedToLoad')}</div>
        )}
        {!usOnly && jurisdictionKnown && !depositQuery.isLoading && !depositQuery.isError && !deposit && (
          <div className="p-6 text-center text-sm text-muted-foreground">{tdd.notFound}</div>
        )}

        {deposit && activeTab === 'overview' && <DepositDetailsTab deposit={deposit} canEdit={canEdit} t={t} />}
        {deposit && activeTab === 'payments' && <DepositPaymentsTab deposit={deposit} currency={currency} t={t} />}
        {deposit && activeTab === 'history' && <EntityAuditPanel entityType="bank_deposit" entityId={deposit.id} />}
      </EntityDetailView>

      <ConfirmDialog
        open={confirmVoid}
        onOpenChange={setConfirmVoid}
        title={tdd.voidTitle}
        description={tdd.voidDescription}
        confirmLabel={tdd.void}
        cancelLabel={tdd.cancel}
        variant="destructive"
        onConfirm={handleVoid}
      />
    </>
  );
}
