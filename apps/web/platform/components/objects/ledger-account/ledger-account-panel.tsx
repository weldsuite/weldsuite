/**
 * Ledger account object panel (a row of the WeldBooks chart of accounts).
 *
 * Built on the same shell as the company / person / bank account panels:
 * `useObjectPanelShell` + `EntityDetailView` + `ObjectPanelTabs`, so it
 * inherits the shared header chrome, the panel↔fullscreen toggle and the
 * stacking/back behaviour. It replaces the standalone
 * `/weldbooks/accounts/:id` page, which now redirects to the chart of
 * accounts with this panel open in fullscreen. Editing stays on the
 * `/weldbooks/accounts/:id/edit` page.
 *
 * Tabs: Details · History.
 */

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link } from '@tanstack/react-router';
import {
  Ban,
  CheckCircle2,
  Coins,
  Edit,
  EllipsisVertical,
  FileText,
  Hash,
  Landmark,
  Layers,
  Link as LinkIcon,
  Receipt,
  Scale,
  Tag,
  Wallet,
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
  useObjectPanelShell,
  useObjectPanelTabConfig,
  type ObjectPanelComponentProps,
} from '@/components/object-panel';
import { EntityAuditPanel } from '@/components/entity-audit-panel';
import { PropertyRow } from '@/components/objects/_shared/property-row';
import {
  useAccountingAccount,
  useTaxLineCatalog,
  useUpdateAccount,
} from '@/hooks/queries/use-accounting-queries';
import { useCurrentEntityCurrency } from '@/hooks/use-current-entity-currency';
import { useWorkspaceUrl } from '@/hooks/use-workspace-url';
import type { Account } from '@/lib/api/domains/weldbooks';
import { useI18n } from '@/lib/i18n/provider';
import { cn } from '@/lib/utils';
import { form1099BoxName, FORM_1099_OMIT } from '@/lib/weldbooks/form-1099';
import { taxLineLabel } from '@/lib/weldbooks/tax-lines';
import { useCurrentJurisdiction } from '@/lib/weldbooks/use-jurisdiction';
import { getLedgerAccountTabs, type LedgerAccountTab } from './ledger-account-tabs';

const LEDGER_ACCOUNT_PANEL_WIDTH = 480;

const PILL = 'inline-flex items-center h-[22px] px-2 rounded text-[12px] font-medium leading-none';
const PILL_GRAY = 'text-gray-600 dark:text-muted-foreground bg-gray-100 dark:bg-secondary';
const PILL_RED = 'text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-950';

/** Read-only rows with no value show a dash instead of the editable "Set …" prompt. */
const EMPTY_VALUE = '—';

type Translations = ReturnType<typeof useI18n>['t'];

// ─── Header ────────────────────────────────────────────────────────────────

function LedgerAccountTitle({ account, t }: Readonly<{ account?: Account; t: Translations }>) {
  if (!account) return <div className="h-4 w-32 rounded bg-muted animate-pulse" />;
  const ta = t.accounting.accounts;
  return (
    <div className="flex min-w-0 items-center gap-2">
      <span className="relative top-px truncate text-[15px] font-medium text-foreground">
        <span className="mr-2 font-mono">{account.code}</span>
        {account.name}
      </span>
      {account.isActive === false ? (
        <span className={cn(PILL, PILL_RED, 'flex-shrink-0')}>{ta.inactive}</span>
      ) : null}
      {account.isSystemAccount ? (
        <span className={cn(PILL, PILL_GRAY, 'flex-shrink-0')}>{ta.system}</span>
      ) : null}
    </div>
  );
}

function LedgerAccountActions({
  account,
  canToggle,
  isUpdating,
  onToggle,
  t,
}: Readonly<{
  account?: Account;
  canToggle: boolean;
  isUpdating: boolean;
  onToggle: () => void;
  t: Translations;
}>) {
  const st = useTranslations();
  const workspaceUrl = useWorkspaceUrl();
  if (!account) return null;
  const ta = t.accounting.accounts;
  const isInactive = account.isActive === false;
  const ToggleIcon = isInactive ? CheckCircle2 : Ban;
  const toggleLabel = isInactive ? ta.reactivate : ta.deactivate;

  const handleCopyLink = async () => {
    try {
      await navigator.clipboard.writeText(
        workspaceUrl(`/weldbooks/accounts?stack=ledger_account:${account.id}`),
      );
      toast.success(st('sweep.entities.linkCopied'));
    } catch {
      toast.error(st('sweep.entities.copyLinkFailed'));
    }
  };

  return (
    <div className="flex items-center gap-0.5">
      {canToggle ? (
        <Button
          variant="ghost"
          size="icon-sm"
          className="size-7"
          title={toggleLabel}
          aria-label={toggleLabel}
          disabled={isUpdating}
          data-testid="account-toggle-active"
          onClick={onToggle}
        >
          <ToggleIcon className="h-4 w-4 text-muted-foreground" />
        </Button>
      ) : null}
      <Button
        variant="ghost"
        size="icon-sm"
          className="size-7"
        title={ta.editing}
        aria-label={ta.editing}
        asChild
      >
        <Link to="/weldbooks/accounts/$id/edit" params={{ id: account.id }}>
          <Edit className="h-4 w-4 text-muted-foreground" />
        </Link>
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            className="size-7 data-[state=open]:bg-accent dark:data-[state=open]:bg-accent/50"
            aria-label={t.accounting.invoiceDetail.moreActions}
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

function LedgerAccountTabsBar({
  tabs,
  activeTab,
  setActiveTab,
  mode,
}: Readonly<{
  tabs: LedgerAccountTab[];
  activeTab: LedgerAccountTab['id'];
  setActiveTab: (id: LedgerAccountTab['id']) => void;
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
    objectType: 'ledger_account',
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
        onChange={(id) => setActiveTab(id as LedgerAccountTab['id'])}
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

function Section({ title, children }: Readonly<{ title: string; children: ReactNode }>) {
  return (
    <div className="space-y-1">
      <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{title}</p>
      {children}
    </div>
  );
}

/** A read-only Details row; a dash stands in for a missing value. */
function InfoRow({
  icon,
  label,
  value,
  renderValue,
}: Readonly<{
  icon: Parameters<typeof PropertyRow>[0]['icon'];
  label: string;
  value: string | null | undefined;
  renderValue?: Parameters<typeof PropertyRow>[0]['renderValue'];
}>) {
  return (
    <PropertyRow
      icon={icon}
      label={label}
      value={value}
      renderValue={renderValue}
      placeholder={EMPTY_VALUE}
      readOnly
    />
  );
}

const capitalized = (value: string | null | undefined) => <span className="capitalize text-foreground">{value}</span>;

function LedgerAccountDetailsTab({ account, t }: Readonly<{ account: Account; t: Translations }>) {
  const ta = t.accounting.accounts;
  const tus = t.weldbooksUs.setup.accounts;
  const { formatMoney, entityCurrency } = useCurrentEntityCurrency();
  const { code: jurisdictionCode, features } = useCurrentJurisdiction();
  const isUs = jurisdictionCode === 'US';
  const taxLineCatalog = useTaxLineCatalog(undefined, { enabled: isUs });

  const typeLabels: Record<string, string> = ta.types;
  const normalSideLabels: Record<string, string> = { debit: ta.debit, credit: ta.credit };

  let form1099Value: string = tus.notSet;
  if (account.form1099Box) {
    form1099Value = account.form1099Box === FORM_1099_OMIT ? tus.form1099Omit : form1099BoxName(account.form1099Box);
  }

  return (
    <div className="p-4 space-y-5">
      <Section title={ta.accountDetails}>
        <InfoRow
          icon={Hash}
          label={ta.summaryCode}
          value={account.code}
          renderValue={(value) => <span className="font-mono">{value}</span>}
        />
        <InfoRow icon={FileText} label={ta.summaryName} value={account.name} />
        <InfoRow icon={FileText} label={ta.description} value={account.description} />
        <InfoRow
          icon={Tag}
          label={ta.summaryType}
          value={typeLabels[account.type] ?? account.type}
          renderValue={capitalized}
        />
        <InfoRow
          icon={Layers}
          label={ta.subtype}
          value={account.subtype ? account.subtype.replaceAll('_', ' ') : null}
          renderValue={capitalized}
        />
        <InfoRow
          icon={Scale}
          label={ta.normalSide}
          value={normalSideLabels[account.normalSide] ?? account.normalSide}
          renderValue={capitalized}
        />
        <InfoRow icon={Coins} label={ta.currency} value={account.currency ?? entityCurrency ?? EMPTY_VALUE} />
      </Section>

      {isUs ? (
        <Section title={tus.reportingTitle}>
          <InfoRow
            icon={Receipt}
            label={tus.taxLine}
            value={account.taxLine ? taxLineLabel(taxLineCatalog.data, account.taxLine) : tus.notSet}
          />
          {features.form1099 ? <InfoRow icon={Landmark} label={tus.form1099Box} value={form1099Value} /> : null}
        </Section>
      ) : null}

      <Section title={ta.balances}>
        <InfoRow
          icon={Wallet}
          label={ta.openingBalance}
          value={formatMoney(account.openingBalance, account.currency)}
        />
        <InfoRow
          icon={Wallet}
          label={ta.currentBalance}
          value={formatMoney(account.currentBalance, account.currency)}
        />
      </Section>
    </div>
  );
}

// ─── Panel ─────────────────────────────────────────────────────────────────

export function LedgerAccountPanel(props: Readonly<ObjectPanelComponentProps>) {
  const { id, initialTab } = props;
  const { t } = useI18n();
  const st = useTranslations();
  const { can } = usePermissions();
  const ta = t.accounting.accounts;

  const accountQuery = useAccountingAccount(id);
  const account = accountQuery.data?.data;

  const updateAccount = useUpdateAccount();
  const [confirmToggle, setConfirmToggle] = useState(false);

  const shell = useObjectPanelShell({
    ...props,
    width: LEDGER_ACCOUNT_PANEL_WIDTH,
    loading: accountQuery.isLoading && !account,
  });
  const mode = shell.mode;

  const tabs = useMemo(
    () =>
      getLedgerAccountTabs({
        details: st('sweep.entities.detailsTab'),
        history: st('sweep.entities.auditLogTab'),
      }),
    [st],
  );

  const initial = useMemo<LedgerAccountTab['id']>(() => {
    const match = tabs.find((tab) => tab.id === initialTab);
    return match?.id ?? 'overview';
  }, [initialTab, tabs]);
  const [activeTab, setActiveTab] = useState<LedgerAccountTab['id']>(initial);

  const isInactive = account?.isActive === false;
  // A system account can not be deactivated, only reactivated.
  const canToggle = can('accounts:update') && Boolean(account) && !(account?.isSystemAccount && !isInactive);

  const toggleActive = () => {
    if (!account) return;
    updateAccount.mutate(
      { id: account.id, data: { isActive: isInactive } },
      {
        onSuccess: () => {
          toast.success(isInactive ? ta.reactivated : ta.deactivated);
          setConfirmToggle(false);
        },
        onError: (err) => {
          setConfirmToggle(false);
          toast.error(isInactive ? ta.reactivateFailed : ta.deactivateFailed, {
            description: err instanceof Error ? err.message : undefined,
          });
        },
      },
    );
  };

  return (
    <>
      <EntityDetailView
        {...shell.entityDetailViewProps}
        title={<LedgerAccountTitle account={account} t={t} />}
        actions={
          <LedgerAccountActions
            account={account}
            canToggle={canToggle}
            isUpdating={updateAccount.isPending}
            onToggle={() => setConfirmToggle(true)}
            t={t}
          />
        }
        tabs={
          <LedgerAccountTabsBar tabs={tabs} activeTab={activeTab} setActiveTab={setActiveTab} mode={mode} />
        }
      >
        {!accountQuery.isLoading && accountQuery.isError && (
          <div className="p-4 text-sm text-destructive">{st('sweep.entities.failedToLoad')}</div>
        )}
        {!accountQuery.isLoading && !accountQuery.isError && !account && (
          <div className="p-6 text-center text-sm text-muted-foreground">{ta.notFound}</div>
        )}

        {account && activeTab === 'overview' && <LedgerAccountDetailsTab account={account} t={t} />}
        {account && activeTab === 'history' && <EntityAuditPanel entityType="account" entityId={account.id} />}
      </EntityDetailView>

      <ConfirmDialog
        open={confirmToggle}
        onOpenChange={setConfirmToggle}
        title={isInactive ? ta.reactivateTitle : ta.deactivateTitle}
        description={isInactive ? ta.reactivateDesc : ta.deactivateDesc}
        confirmLabel={isInactive ? ta.reactivate : ta.deactivate}
        cancelLabel={ta.cancel}
        loading={updateAccount.isPending}
        onConfirm={toggleActive}
      />
    </>
  );
}
