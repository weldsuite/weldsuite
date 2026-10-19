/**
 * Bank account object panel (WeldBooks).
 *
 * Built on the same shell as the company / person / domain panels:
 * `useObjectPanelShell` + `EntityDetailView` + `ObjectPanelTabs`, so it
 * inherits the shared header chrome, the panel↔fullscreen toggle and the
 * stacking/back behaviour. It replaces the standalone
 * `/weldbooks/banking/:id` page, which now redirects to the list with this
 * panel open in fullscreen.
 *
 * Tabs: Details · Transactions · Bank feed · History.
 */

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link } from '@tanstack/react-router';
import {
  Banknote,
  Building2,
  CalendarClock,
  CircleDot,
  ClipboardCheck,
  Coins,
  CreditCard,
  Download,
  Edit,
  EllipsisVertical,
  Hash,
  Inbox,
  Link as LinkIcon,
  ListChecks,
  Plus,
  RefreshCw,
  Trash2,
  User,
  Wallet,
} from 'lucide-react';
import { toast } from 'sonner';
import { useTranslations } from '@weldsuite/i18n/client';
import { usePermissions } from '@weldsuite/permissions/react';
import { Badge } from '@weldsuite/ui/components/badge';
import { Button } from '@weldsuite/ui/components/button';
import { ConfirmDialog } from '@weldsuite/ui/components/confirm-dialog';
import { DrawerFieldSettings } from '@weldsuite/ui/components/drawer-field-settings';
import { EntityDetailView } from '@weldsuite/ui/components/entity-detail-view';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@weldsuite/ui/components/dropdown-menu';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@weldsuite/ui/components/select';
import {
  ObjectPanelTabs,
  useObjectPanelShell,
  useObjectPanelTabConfig,
  type ObjectPanelComponentProps,
} from '@/components/object-panel';
import { EntityAuditPanel } from '@/components/entity-audit-panel';
import { PageLoader } from '@/components/page-loader';
import { PropertyRow } from '@/components/objects/_shared/property-row';
import { BankTransactionFormDialog } from '@/components/accounting/bank-transaction-form-dialog';
import { TabListRow, TabListScope } from '@/components/objects/_shared/tab-list-row';
import { useAutoReconcile, useDeleteBankAccount } from '@/hooks/queries/use-accounting-queries';
import { useBankAccount, useBankLines } from '@/hooks/queries/use-weldbooks-banking-queries';
import { useWorkspaceUrl } from '@/hooks/use-workspace-url';
import { isLiabilityAccountType, type BankLine, type UsBankAccount } from '@/lib/api/domains/weldbooks-banking';
import { useI18n } from '@/lib/i18n/provider';
import { cn } from '@/lib/utils';
import { useCurrentJurisdiction } from '@/lib/weldbooks/use-jurisdiction';
import { isUsJurisdictionCode } from '@/lib/weldbooks/us-entity';
import { useWeldbooksFormat } from '@/lib/weldbooks/use-weldbooks-format';
import { BankFeedsPanel } from '@/app/weldbooks/banking/feeds/bank-feeds-panel';
import { BankAccountFormDialog } from '@/app/weldbooks/banking/components/bank-account-form-dialog';
import { RevealAccountNumber } from '@/app/weldbooks/banking/components/reveal-account-number';
import { getBankAccountTabs, type BankAccountTab } from './bank-account-tabs';

const BANK_ACCOUNT_PANEL_WIDTH = 480;

const PILL = 'inline-flex items-center h-[22px] px-2 rounded text-[12px] font-medium leading-none';
const PILL_GREEN = 'text-emerald-600 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-950';
const PILL_GRAY = 'text-gray-600 dark:text-muted-foreground bg-gray-100 dark:bg-secondary';

type Translations = ReturnType<typeof useI18n>['t'];

function BankAccountTitle({ account, t }: Readonly<{ account?: UsBankAccount; t: Translations }>) {
  if (!account) return <div className="h-4 w-32 rounded bg-muted animate-pulse" />;
  const tbp = t.accounting.bankingPages;
  return (
    <div className="flex min-w-0 items-center gap-2">
      <span className="relative top-px truncate text-[15px] font-medium text-foreground">{account.name}</span>
      {account.isDefault ? (
        <span className={cn(PILL, PILL_GREEN, 'flex-shrink-0')}>{tbp.badges.default}</span>
      ) : null}
      {account.isActive === false ? (
        <span className={cn(PILL, PILL_GRAY, 'flex-shrink-0')}>{tbp.badges.inactive}</span>
      ) : null}
    </div>
  );
}

function BankAccountActions({
  account,
  canEdit,
  canDelete,
  onEdit,
  onDelete,
  t,
}: Readonly<{
  account?: UsBankAccount;
  canEdit: boolean;
  canDelete: boolean;
  onEdit: () => void;
  onDelete: () => void;
  t: Translations;
}>) {
  const st = useTranslations();
  const workspaceUrl = useWorkspaceUrl();
  if (!account) return null;
  const tbp = t.accounting.bankingPages;

  const handleCopyLink = async () => {
    try {
      await navigator.clipboard.writeText(
        workspaceUrl(`/weldbooks/banking?stack=bank_account:${account.id}`),
      );
      toast.success(st('sweep.entities.linkCopied'));
    } catch {
      toast.error(st('sweep.entities.copyLinkFailed'));
    }
  };

  return (
    <div className="flex items-center gap-0.5">
      {canEdit ? (
        <Button
          variant="ghost"
          size="icon-sm"
          className="size-7"
          title={tbp.edit}
          aria-label={tbp.edit}
          onClick={onEdit}
        >
          <Edit className="h-4 w-4 text-muted-foreground" />
        </Button>
      ) : null}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            className="size-7 data-[state=open]:bg-accent dark:data-[state=open]:bg-accent/50"
            aria-label={t.weldbooksUs.banking.accountDetails.moreActions}
          >
            <EllipsisVertical className="h-4 w-4 text-muted-foreground" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onClick={() => void handleCopyLink()}>
            <LinkIcon />
            {st('sweep.entities.copyLink')}
          </DropdownMenuItem>
          {canDelete ? (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" onClick={onDelete}>
                <Trash2 />
                {tbp.deleteBankAccount}
              </DropdownMenuItem>
            </>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

// ─── Tab bar ───────────────────────────────────────────────────────────────

function BankAccountTabsBar({
  tabs,
  activeTab,
  setActiveTab,
  mode,
}: Readonly<{
  tabs: BankAccountTab[];
  activeTab: BankAccountTab['id'];
  setActiveTab: (id: BankAccountTab['id']) => void;
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
    objectType: 'bank_account',
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
        onChange={(id) => setActiveTab(id as BankAccountTab['id'])}
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

/** The US account facts: its type, routing and account (or card) number, and next check number. */
function UsAccountRows({ account, t }: Readonly<{ account: UsBankAccount; t: Translations }>) {
  const tb = t.weldbooksUs.banking;
  const td = tb.accountDetails;
  const typeLabel = account.accountType ? tb.accountTypes[account.accountType] : null;
  const isCard = account.accountType === 'credit_card';
  return (
    <>
      <PropertyRow icon={Wallet} label={td.accountType} value={typeLabel} readOnly />
      {isCard ? null : (
        <PropertyRow
          icon={Hash}
          label={td.routingNumber}
          value={account.routingNumber}
          readOnly
          renderValue={(value) => <span className="font-mono">{value}</span>}
        />
      )}
      <PropertyRow
        icon={CreditCard}
        label={isCard ? td.cardNumber : td.accountNumber}
        value={account.hasAccountNumber ? (account.accountNumberLast4 ?? '') : null}
        placeholder={td.notSet}
        readOnly
        renderValue={() => (
          <RevealAccountNumber bankAccountId={account.id} last4={account.accountNumberLast4} />
        )}
      />
      {isCard ? null : (
        <PropertyRow
          icon={Hash}
          label={td.nextCheckNumber}
          value={account.nextCheckNumber == null ? null : String(account.nextCheckNumber)}
          readOnly
        />
      )}
    </>
  );
}

function BankAccountDetailsTab({
  account,
  isUs,
  unreconciledCount,
  totalTransactions,
  t,
}: Readonly<{
  account: UsBankAccount;
  isUs: boolean;
  unreconciledCount: number;
  totalTransactions: number;
  t: Translations;
}>) {
  const { currency: entityCurrency, formatMoney, formatDateTime } = useWeldbooksFormat();
  const tbp = t.accounting.bankingPages;
  const tb = t.weldbooksUs.banking;
  const tp = tb.panel;
  const td = tb.accountDetails;
  const liability = isLiabilityAccountType(account.accountType);
  const currency = account.currency ?? entityCurrency;

  return (
    <div className="@container p-4 space-y-4">
      <div className="space-y-1">
        <PropertyRow
          icon={Banknote}
          label={liability ? td.balanceOwed : tbp.currentBalance}
          value={formatMoney(account.currentBalance, currency)}
          readOnly
        />
        <PropertyRow
          icon={ListChecks}
          label={tbp.unreconciled}
          value={String(unreconciledCount)}
          readOnly
          renderValue={(value) => (
            <span>
              {value}{' '}
              <span className="text-muted-foreground">
                {tbp.ofTransactions.replace('{total}', String(totalTransactions))}
              </span>
            </span>
          )}
        />
        <PropertyRow
          icon={CalendarClock}
          label={tbp.lastImport}
          value={formatDateTime(account.lastImportDate, '—')}
          tabular
          readOnly
        />
        <PropertyRow
          icon={CircleDot}
          label={tp.status}
          value={account.isActive === false ? tbp.badges.inactive : tp.active}
          readOnly
          renderValue={(value) => (
            <span className={cn(PILL, account.isActive === false ? PILL_GRAY : PILL_GREEN)}>{value}</span>
          )}
        />
        <PropertyRow icon={Building2} label={tp.bankName} value={account.bankName} readOnly />
        {isUs ? (
          <UsAccountRows account={account} t={t} />
        ) : (
          <>
            <PropertyRow
              icon={CreditCard}
              label={td.iban}
              value={account.iban}
              readOnly
              renderValue={(value) => <span className="font-mono">{value}</span>}
            />
            <PropertyRow
              icon={Hash}
              label={td.bic}
              value={account.bic}
              readOnly
              renderValue={(value) => <span className="font-mono">{value}</span>}
            />
          </>
        )}
        <PropertyRow icon={User} label={td.accountHolder} value={account.accountHolderName} readOnly />
        <PropertyRow icon={Coins} label={td.currency} value={currency} readOnly />
        <PropertyRow
          icon={RefreshCw}
          label={tp.autoReconcile}
          value={account.autoReconcile === false ? tp.off : tp.on}
          readOnly
          renderValue={(value) => (
            <span className={cn(PILL, account.autoReconcile === false ? PILL_GRAY : PILL_GREEN)}>{value}</span>
          )}
        />
      </div>
    </div>
  );
}

// ─── Transactions tab ──────────────────────────────────────────────────────

const LINE_STATUS_VARIANT: Record<string, 'default' | 'secondary' | 'outline'> = {
  reconciled: 'default',
  unreconciled: 'secondary',
  excluded: 'outline',
};

function TransactionRow({ line, currency }: Readonly<{ line: BankLine; currency: string | undefined }>) {
  const st = useTranslations();
  const { formatDate, formatMoney } = useWeldbooksFormat();
  const isPositive = (Number(line.amount) || 0) >= 0;
  const title = line.description || line.counterpartyName || '—';
  return (
    <TabListRow label={title}>
      <span className="w-[92px] flex-shrink-0 whitespace-nowrap text-sm tabular-nums">
        {formatDate(line.date)}
      </span>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm">{title}</div>
        {line.reference ? (
          <div className="truncate text-xs text-muted-foreground">{line.reference}</div>
        ) : null}
      </div>
      <span
        className={cn(
          'flex-shrink-0 text-right text-sm font-medium tabular-nums',
          isPositive ? 'text-emerald-600 dark:text-emerald-400' : 'text-foreground',
        )}
      >
        {formatMoney(line.amount, currency)}
      </span>
      <span className="w-[104px] flex-shrink-0 @max-[440px]:hidden">
        <Badge variant={LINE_STATUS_VARIANT[line.status] ?? 'secondary'}>
          {st(`sweep.weldbooks.bankTransactionsTable.${line.status}`)}
        </Badge>
      </span>
    </TabListRow>
  );
}

function BankAccountTransactionsTab({
  account,
  isUs,
  t,
}: Readonly<{ account: UsBankAccount; isUs: boolean; t: Translations }>) {
  const { can } = usePermissions();
  const { currency: entityCurrency } = useWeldbooksFormat();
  const tbp = t.accounting.bankingPages;
  const tb = t.weldbooksUs.banking;
  const id = account.id;
  const liability = isLiabilityAccountType(account.accountType);
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [addOpen, setAddOpen] = useState(false);
  const autoReconcile = useAutoReconcile();

  const statusOptions = [
    { value: 'all', label: tbp.allTransactions },
    { value: 'unreconciled', label: tbp.unreconciledFilter },
    { value: 'reconciled', label: tbp.reconciledFilter },
    { value: 'excluded', label: tbp.excludedFilter },
  ];

  const filters = useMemo(
    () => ({
      bankAccountId: id,
      status: statusFilter === 'all' ? undefined : statusFilter,
      pageSize: 25,
    }),
    [id, statusFilter],
  );
  const { data, isLoading } = useBankLines(filters);
  const transactions = data?.data ?? [];

  let body: ReactNode;
  if (isLoading) {
    body = <PageLoader fullScreen={false} />;
  } else if (transactions.length === 0) {
    body = (
      <div className="py-10 text-center space-y-3">
        <Inbox className="h-10 w-10 mx-auto text-muted-foreground" />
        <p className="text-sm text-muted-foreground">{tbp.noTransactionsYet}</p>
      </div>
    );
  } else {
    body = (
      <TabListScope>
        <div className="border-t border-gray-200/70 dark:border-border">
          {transactions.map((line) => (
            <TransactionRow key={line.id} line={line} currency={account.currency ?? entityCurrency} />
          ))}
        </div>
      </TabListScope>
    );
  }

  return (
    <div className="p-4 space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="h-8 w-44">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {statusOptions.map((opt) => (
              <SelectItem key={opt.value} value={opt.value}>
                {opt.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => autoReconcile.mutate(id)}
            disabled={autoReconcile.isPending || !can('banking:update')}
          >
            <RefreshCw className={cn('h-4 w-4', autoReconcile.isPending && 'animate-spin')} />
            {tbp.autoReconcile}
          </Button>
          {isUs ? (
            <>
              <Button variant="outline" size="sm" asChild>
                <Link to="/weldbooks/banking/statements" search={{ accountId: id }} data-testid="reconcile-statement">
                  <ClipboardCheck className="h-4 w-4" />
                  {tb.accountList.reconcileStatement}
                </Link>
              </Button>
              {!liability && can('banking:create') ? (
                <Button variant="outline" size="sm" asChild>
                  <Link to="/weldbooks/deposits/new" search={{ accountId: id }}>
                    <Wallet className="h-4 w-4" />
                    {tb.accountList.makeDeposit}
                  </Link>
                </Button>
              ) : null}
            </>
          ) : null}
          {can('banking:create') ? (
            <Button
              variant="outline"
              size="sm"
              data-testid="add-bank-transaction"
              onClick={() => setAddOpen(true)}
            >
              <Plus className="h-4 w-4" />
              {tbp.addTransactionButton}
            </Button>
          ) : null}
          <Button size="sm" asChild>
            <Link to="/weldbooks/banking/import" search={{ accountId: id }}>
              <Download className="h-4 w-4" />
              {tbp.importStatement}
            </Link>
          </Button>
        </div>
      </div>

      {body}

      <BankTransactionFormDialog open={addOpen} onOpenChange={setAddOpen} bankAccountId={id} />
    </div>
  );
}

// ─── Panel ─────────────────────────────────────────────────────────────────

export function BankAccountPanel(props: Readonly<ObjectPanelComponentProps>) {
  const { id, onClose, initialTab } = props;
  const { t } = useI18n();
  const st = useTranslations();
  const { can } = usePermissions();
  const tbp = t.accounting.bankingPages;
  const tp = t.weldbooksUs.banking.panel;
  const { code: jurisdictionCode } = useCurrentJurisdiction();
  const isUs = isUsJurisdictionCode(jurisdictionCode);

  const accountQuery = useBankAccount(id);
  const account = accountQuery.data?.data as UsBankAccount | undefined;

  const { data: allLines } = useBankLines({ bankAccountId: id, pageSize: 1 });
  const { data: unreconciledLines } = useBankLines({
    bankAccountId: id,
    status: 'unreconciled',
    pageSize: 1,
  });
  const totalTransactions = allLines?.pagination?.totalCount ?? 0;
  const unreconciledCount = unreconciledLines?.pagination?.totalCount ?? 0;

  const [editOpen, setEditOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const deleteMutation = useDeleteBankAccount();

  const shell = useObjectPanelShell({
    ...props,
    width: BANK_ACCOUNT_PANEL_WIDTH,
    loading: accountQuery.isLoading && !account,
  });
  const mode = shell.mode;

  const tabs = useMemo(
    () =>
      getBankAccountTabs({
        details: st('sweep.entities.detailsTab'),
        transactions: tp.transactionsTab,
        feeds: tp.bankFeedTab,
        history: st('sweep.entities.auditLogTab'),
        transactionsCount: totalTransactions || undefined,
      }),
    [st, tp, totalTransactions],
  );

  const initial = useMemo<BankAccountTab['id']>(() => {
    const match = tabs.find((tab) => tab.id === initialTab);
    return match?.id ?? 'overview';
  }, [initialTab, tabs]);
  const [activeTab, setActiveTab] = useState<BankAccountTab['id']>(initial);

  const handleDelete = () => {
    deleteMutation.mutate(id, {
      onSuccess: () => {
        toast.success(tp.deleted);
        setConfirmDelete(false);
        onClose();
      },
      onError: () => toast.error(tp.deleteFailed),
    });
  };

  return (
    <>
      <EntityDetailView
        {...shell.entityDetailViewProps}
        title={<BankAccountTitle account={account} t={t} />}
        actions={
          <BankAccountActions
            account={account}
            canEdit={can('banking:update')}
            canDelete={can('banking:delete')}
            onEdit={() => setEditOpen(true)}
            onDelete={() => setConfirmDelete(true)}
            t={t}
          />
        }
        tabs={
          <BankAccountTabsBar
            tabs={tabs}
            activeTab={activeTab}
            setActiveTab={setActiveTab}
            mode={mode}
          />
        }
      >
        {!accountQuery.isLoading && accountQuery.isError && (
          <div className="p-4 text-sm text-destructive">{st('sweep.entities.failedToLoad')}</div>
        )}
        {!accountQuery.isLoading && !accountQuery.isError && !account && (
          <div className="p-6 text-center text-sm text-muted-foreground">{tbp.bankAccountNotFound}</div>
        )}

        {account && activeTab === 'overview' && (
          <BankAccountDetailsTab
            account={account}
            isUs={isUs}
            unreconciledCount={unreconciledCount}
            totalTransactions={totalTransactions}
            t={t}
          />
        )}
        {account && activeTab === 'transactions' && (
          <BankAccountTransactionsTab account={account} isUs={isUs} t={t} />
        )}
        {account && activeTab === 'feeds' && (
          <div className="p-4">
            <BankFeedsPanel bankAccountId={account.id} />
          </div>
        )}
        {account && activeTab === 'history' && (
          <EntityAuditPanel entityType="bank_account" entityId={account.id} />
        )}
      </EntityDetailView>

      {account ? (
        <BankAccountFormDialog open={editOpen} onOpenChange={setEditOpen} bankAccount={account} />
      ) : null}

      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={tbp.deleteConfirmTitle}
        description={tbp.deleteConfirmDesc}
        confirmLabel={tbp.delete}
        cancelLabel={tbp.cancel}
        variant="destructive"
        loading={deleteMutation.isPending}
        onConfirm={handleDelete}
      />
    </>
  );
}
