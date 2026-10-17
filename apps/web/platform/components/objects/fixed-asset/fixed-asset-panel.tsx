/**
 * Fixed asset object panel (WeldBooks).
 *
 * Built on the same shell as the company / person / bank account panels:
 * `useObjectPanelShell` + `EntityDetailView` + `ObjectPanelTabs`, so it
 * inherits the shared header chrome, the panel↔fullscreen toggle and the
 * stacking/back behaviour. It replaces the standalone
 * `/weldbooks/fixed-assets/:id` page, which now redirects to the register with
 * this panel open in fullscreen. Editing still happens on
 * `/weldbooks/fixed-assets/:id/edit`.
 *
 * Tabs: Details · Depreciation · History.
 */

import { useEffect, useMemo, useState } from 'react';
import { Link } from '@tanstack/react-router';
import {
  AlignLeft,
  Banknote,
  BookText,
  CalendarCheck,
  CalendarDays,
  CalendarRange,
  CircleDot,
  Clock,
  EllipsisVertical,
  FileText,
  Hash,
  Layers,
  Link as LinkIcon,
  Lock,
  Pencil,
  Percent,
  PiggyBank,
  Receipt,
  Scale,
  Sigma,
  SquareChartGantt,
  StickyNote,
  Trash2,
  TrendingDown,
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
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@weldsuite/ui/components/dropdown-menu';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@weldsuite/ui/components/tabs';
import {
  ObjectPanelTabs,
  useObjectPanel,
  useObjectPanelShell,
  useObjectPanelTabConfig,
  type ObjectPanelComponentProps,
} from '@/components/object-panel';
import { EntityAuditPanel } from '@/components/entity-audit-panel';
import { PropertyRow } from '@/components/objects/_shared/property-row';
import { useAccountingAccounts } from '@/hooks/queries/use-accounting-queries';
import { useDeleteFixedAsset, useFixedAsset } from '@/hooks/queries/use-weldbooks-assets-queries';
import { useWorkspaceUrl } from '@/hooks/use-workspace-url';
import type { AssetStatus, FixedAssetBookWithSchedule, FixedAssetDetail } from '@/lib/api/domains/weldbooks-assets';
import { useI18n } from '@/lib/i18n/provider';
import { cn } from '@/lib/utils';
import { useWeldbooksFormat } from '@/lib/weldbooks/use-weldbooks-format';
import { trimNumber } from '@/app/weldbooks/fixed-assets/asset-form-model';
import { errorMessage, fill } from '@/app/weldbooks/fixed-assets/text';
import { DisposeDialog } from '@/app/weldbooks/fixed-assets/components/dispose-dialog';
import { IssueList } from '@/app/weldbooks/fixed-assets/components/issue-list';
import { AnnualScheduleList, LedgerPostingsList } from './fixed-asset-schedule';
import { getFixedAssetTabs, type FixedAssetTab } from './fixed-asset-tabs';

const FIXED_ASSET_PANEL_WIDTH = 480;

const PILL = 'inline-flex items-center h-[22px] px-2 rounded text-[12px] font-medium leading-none';
const PILL_GREEN = 'text-emerald-600 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-950';
const PILL_BLUE = 'text-blue-600 dark:text-blue-400 bg-blue-50 dark:bg-blue-950';
const PILL_GRAY = 'text-gray-600 dark:text-muted-foreground bg-gray-100 dark:bg-secondary';

const STATUS_PILL: Record<AssetStatus, string> = {
  active: PILL_GREEN,
  fully_depreciated: PILL_BLUE,
  disposed: PILL_GRAY,
};

type Translations = ReturnType<typeof useI18n>['t'];

function FixedAssetAvatar() {
  return (
    <div className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-lg bg-amber-100 dark:bg-amber-900">
      <SquareChartGantt className="h-3.5 w-3.5 text-amber-600 dark:text-amber-400" />
    </div>
  );
}

function FixedAssetTitle({ asset, t }: Readonly<{ asset?: FixedAssetDetail; t: Translations }>) {
  if (!asset) return <div className="h-4 w-32 rounded bg-muted animate-pulse" />;
  const fa = t.weldbooksUs.assets.fixedAssets;
  return (
    <div className="flex min-w-0 items-center gap-2">
      <span className="truncate text-[15px] font-medium text-foreground">{asset.name}</span>
      <span className={cn(PILL, STATUS_PILL[asset.status] ?? PILL_GRAY, 'flex-shrink-0')}>
        {fa.statuses[asset.status] ?? asset.status}
      </span>
    </div>
  );
}

function FixedAssetActions({
  asset,
  hasPosted,
  onDispose,
  onDelete,
  t,
}: Readonly<{
  asset?: FixedAssetDetail;
  hasPosted: boolean;
  onDispose: () => void;
  onDelete: () => void;
  t: Translations;
}>) {
  const st = useTranslations();
  const { can } = usePermissions();
  const workspaceUrl = useWorkspaceUrl();
  if (!asset) return null;
  const td = t.weldbooksUs.assets.fixedAssets.detail;
  const disposed = asset.status === 'disposed';
  const canEdit = can('accounts:update');
  const canDispose = !disposed && canEdit && can('journal:create');
  const canDelete = !disposed && can('accounts:delete');

  const handleCopyLink = async () => {
    try {
      await navigator.clipboard.writeText(workspaceUrl(`/weldbooks/fixed-assets?stack=fixed_asset:${asset.id}`));
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
          asChild
          size="icon-sm"
          className="size-7"
        >
          <Link
            to="/weldbooks/fixed-assets/$id/edit"
            params={{ id: asset.id }}
            title={td.edit}
            aria-label={td.edit}
          >
            <Pencil className="h-4 w-4 text-muted-foreground" />
          </Link>
        </Button>
      ) : null}
      {canDispose ? (
        <Button variant="outline" size="sm" className="mx-1" onClick={onDispose} data-testid="dispose-open">
          {td.dispose}
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
          {canDelete ? (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" disabled={hasPosted} onClick={onDelete}>
                <Trash2 />
                {td.delete}
              </DropdownMenuItem>
              {hasPosted ? (
                <p className="max-w-[240px] px-2 pb-1.5 text-xs text-muted-foreground">{td.deleteBlocked}</p>
              ) : null}
            </>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

// ─── Tab bar ───────────────────────────────────────────────────────────────

function FixedAssetTabsBar({
  tabs,
  activeTab,
  setActiveTab,
  mode,
}: Readonly<{
  tabs: FixedAssetTab[];
  activeTab: FixedAssetTab['id'];
  setActiveTab: (id: FixedAssetTab['id']) => void;
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
    objectType: 'fixed_asset',
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
        onChange={(id) => setActiveTab(id as FixedAssetTab['id'])}
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

function FixedAssetDetailsTab({
  asset,
  locked,
  t,
}: Readonly<{ asset: FixedAssetDetail; locked: boolean; t: Translations }>) {
  const { open: openPanel } = useObjectPanel();
  const { formatMoney, formatDate } = useWeldbooksFormat();
  const accountsQuery = useAccountingAccounts();
  const fa = t.weldbooksUs.assets.fixedAssets;
  const td = fa.detail;
  const disposed = asset.status === 'disposed';
  const businessUse = Number(asset.businessUsePercent);
  const billId = asset.billId;
  const disposalEntryId = asset.disposalJournalEntryId;

  const accountName = (accountId: string): string => {
    const account = accountsQuery.data?.data.find((item) => item.id === accountId);
    return account ? `${account.code} — ${account.name}` : accountId;
  };

  return (
    <div className="@container space-y-4 p-4">
      {locked && !disposed ? (
        <p className="flex items-start gap-2 text-sm text-muted-foreground" data-testid="asset-locked">
          <Lock className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          {td.locked}
        </p>
      ) : null}

      <IssueList issues={asset.issues} title={td.issuesTitle} />

      <div className="space-y-1">
        <PropertyRow icon={Banknote} label={td.summary.cost} value={formatMoney(asset.cost)} readOnly />
        <PropertyRow
          icon={TrendingDown}
          label={td.summary.accumulated}
          value={formatMoney(asset.accumulatedPosted)}
          readOnly
        />
        <PropertyRow icon={Scale} label={td.summary.netBookValue} value={formatMoney(asset.netBookValuePosted)} readOnly />
        <PropertyRow
          icon={CircleDot}
          label={td.summary.status}
          value={fa.statuses[asset.status] ?? asset.status}
          readOnly
          renderValue={(value) => <span className={cn(PILL, STATUS_PILL[asset.status] ?? PILL_GRAY)}>{value}</span>}
        />
        {asset.assetNumber ? (
          <PropertyRow icon={Hash} label={fa.form.fields.assetNumber} value={asset.assetNumber} readOnly />
        ) : null}
        <PropertyRow icon={CalendarDays} label={td.facts.acquisitionDate} value={formatDate(asset.acquisitionDate)} readOnly />
        <PropertyRow
          icon={CalendarCheck}
          label={td.facts.placedInServiceDate}
          value={formatDate(asset.placedInServiceDate)}
          readOnly
        />
        {asset.assetClass ? (
          <PropertyRow
            icon={Layers}
            label={td.facts.class}
            value={(fa.classes as Record<string, string>)[asset.assetClass] ?? asset.assetClass}
            readOnly
          />
        ) : null}
        {Number(asset.salvageValue) > 0 ? (
          <PropertyRow icon={PiggyBank} label={td.facts.salvageValue} value={formatMoney(asset.salvageValue)} readOnly />
        ) : null}
        {businessUse !== 100 ? (
          <PropertyRow
            icon={Percent}
            label={td.facts.businessUse}
            value={`${trimNumber(asset.businessUsePercent)}%`}
            readOnly
          />
        ) : null}
        {billId ? (
          <PropertyRow
            icon={FileText}
            label={td.facts.bill}
            value={td.facts.viewBill}
            readOnly
            renderValue={(value) => (
              <button
                type="button"
                className="min-w-0 truncate text-primary hover:underline"
                onClick={() => openPanel({ type: 'bill', id: billId, stack: true })}
              >
                {value}
              </button>
            )}
          />
        ) : null}
        {asset.description ? (
          <PropertyRow icon={AlignLeft} label={td.facts.description} value={asset.description} readOnly />
        ) : null}
        {asset.notes ? (
          <PropertyRow
            icon={StickyNote}
            label={td.facts.notes}
            value={asset.notes}
            readOnly
            renderValue={(value) => <span className="whitespace-pre-wrap break-words">{value}</span>}
          />
        ) : null}
      </div>

      <section className="space-y-2">
        <h3 className="text-sm font-medium">{fa.form.sections.accounts}</h3>
        <div className="space-y-1">
          <PropertyRow icon={BookText} label={td.facts.assetAccount} value={accountName(asset.assetAccountId)} readOnly />
          <PropertyRow
            icon={BookText}
            label={td.facts.accumulatedAccount}
            value={accountName(asset.accumulatedDepreciationAccountId)}
            readOnly
          />
          <PropertyRow
            icon={BookText}
            label={td.facts.expenseAccount}
            value={accountName(asset.depreciationExpenseAccountId)}
            readOnly
          />
        </div>
      </section>

      {disposed ? (
        <section className="space-y-1" data-testid="disposal-card">
          <h3 className="pb-1 text-sm font-medium">{td.disposal.title}</h3>
          <PropertyRow icon={CalendarDays} label={td.disposal.date} value={formatDate(asset.disposalDate)} readOnly />
          <PropertyRow
            icon={PiggyBank}
            label={td.disposal.proceeds}
            value={formatMoney(asset.disposalProceeds ?? 0)}
            readOnly
          />
          {disposalEntryId ? (
            <PropertyRow
              icon={FileText}
              label={td.disposal.entry}
              value={td.disposal.viewEntry}
              readOnly
              renderValue={(value) => (
                <button
                  type="button"
                  className="min-w-0 truncate text-primary hover:underline"
                  onClick={() => openPanel({ type: 'journal_entry', id: disposalEntryId, stack: true })}
                >
                  {value}
                </button>
              )}
            />
          ) : null}
        </section>
      ) : null}
    </div>
  );
}

// ─── Depreciation tab ──────────────────────────────────────────────────────

function BookPanel({
  book,
  asset,
  t,
}: Readonly<{ book: FixedAssetBookWithSchedule; asset: FixedAssetDetail; t: Translations }>) {
  const fa = t.weldbooksUs.assets.fixedAssets;
  const tb = fa.detail.book;
  const { formatMoney } = useWeldbooksFormat();
  const schedule = book.schedule;
  const ledgerRows = book.postsToLedger ? asset.ledgerRows.filter((row) => row.bookId === book.id) : [];

  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <PropertyRow icon={TrendingDown} label={tb.method} value={fa.methods[schedule.method]} readOnly />
        <PropertyRow icon={CalendarRange} label={tb.convention} value={fa.conventions[schedule.convention]} readOnly />
        <PropertyRow
          icon={Clock}
          label={tb.recoveryYears}
          value={fill(tb.years, { years: trimNumber(schedule.recoveryYears) })}
          readOnly
        />
        <PropertyRow icon={Banknote} label={tb.depreciableBasis} value={formatMoney(schedule.basis.depreciableBasis)} readOnly />
        {schedule.basis.section179 > 0 ? (
          <PropertyRow icon={Receipt} label={tb.section179} value={formatMoney(schedule.basis.section179)} readOnly />
        ) : null}
        {schedule.basis.bonus > 0 ? (
          <PropertyRow
            icon={Percent}
            label={tb.bonus}
            value={`${formatMoney(schedule.basis.bonus)} (${trimNumber(book.bonusPercent)}%)`}
            readOnly
          />
        ) : null}
        <PropertyRow icon={Sigma} label={tb.totalDeducted} value={formatMoney(schedule.basis.totalDepreciable)} readOnly />
      </div>
      <p className="text-xs text-muted-foreground">{book.postsToLedger ? tb.postsToLedger : tb.taxOnly}</p>

      {schedule.annual.length === 0 ? (
        <p className="text-sm text-muted-foreground">{fa.detail.noSchedule}</p>
      ) : (
        <div className="space-y-2">
          <p className="text-sm font-medium">{fa.detail.annual.title}</p>
          <AnnualScheduleList rows={schedule.annual} />
        </div>
      )}

      {book.postsToLedger ? <LedgerPostingsList rows={ledgerRows} /> : null}
    </div>
  );
}

function FixedAssetDepreciationTab({ asset, t }: Readonly<{ asset: FixedAssetDetail; t: Translations }>) {
  const fa = t.weldbooksUs.assets.fixedAssets;
  const td = fa.detail;
  const ledgerBook = asset.books.find((book) => book.postsToLedger);
  const defaultTab = ledgerBook?.id ?? asset.books[0]?.id;
  const bookLabel = (book: FixedAssetBookWithSchedule) =>
    book.book === 'state' && book.stateCode ? `${fa.bookKinds.state} ${book.stateCode}` : fa.bookKinds[book.book];

  return (
    <div className="@container space-y-3 p-4">
      <h2 className="text-sm font-medium">{td.booksTitle}</h2>
      {asset.books.length === 0 ? (
        <p className="text-sm text-muted-foreground">{td.noSchedule}</p>
      ) : (
        <Tabs defaultValue={defaultTab}>
          <TabsList className="h-auto flex-wrap justify-start">
            {asset.books.map((book) => (
              <TabsTrigger key={book.id} value={book.id}>
                {bookLabel(book)}
              </TabsTrigger>
            ))}
          </TabsList>
          {asset.books.map((book) => (
            <TabsContent key={book.id} value={book.id} className="pt-4">
              <BookPanel book={book} asset={asset} t={t} />
            </TabsContent>
          ))}
        </Tabs>
      )}
    </div>
  );
}

// ─── Panel ─────────────────────────────────────────────────────────────────

/** One fixed asset: what it cost, what is posted, and the depreciation schedule of every book. */
export function FixedAssetPanel(props: Readonly<ObjectPanelComponentProps>) {
  const { id, onClose, initialTab } = props;
  const { t } = useI18n();
  const st = useTranslations();
  const fa = t.weldbooksUs.assets.fixedAssets;
  const td = fa.detail;
  const common = t.weldbooksUs.assets.common;

  const assetQuery = useFixedAsset(id);
  const asset = assetQuery.data;
  const deleteAsset = useDeleteFixedAsset();
  const [disposing, setDisposing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const shell = useObjectPanelShell({
    ...props,
    width: FIXED_ASSET_PANEL_WIDTH,
    loading: assetQuery.isLoading && !asset,
  });
  const mode = shell.mode;

  const booksCount = asset?.books.length ?? 0;
  const tabs = useMemo(
    () =>
      getFixedAssetTabs({
        details: st('sweep.entities.detailsTab'),
        depreciation: td.depreciationTab,
        history: st('sweep.entities.auditLogTab'),
        booksCount: booksCount || undefined,
      }),
    [st, td.depreciationTab, booksCount],
  );

  const initial = useMemo<FixedAssetTab['id']>(() => {
    const match = tabs.find((tab) => tab.id === initialTab);
    return match?.id ?? 'overview';
  }, [initialTab, tabs]);
  const [activeTab, setActiveTab] = useState<FixedAssetTab['id']>(initial);

  const hasPosted = asset?.ledgerRows.some((row) => row.journalEntryId !== null) ?? false;
  const locked = asset?.status === 'disposed' || hasPosted;

  const confirmRemoval = async () => {
    if (!asset) return;
    try {
      await deleteAsset.mutateAsync(asset.id);
      toast.success(td.deleted);
      setConfirmDelete(false);
      onClose();
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  return (
    <>
      <EntityDetailView
        {...shell.entityDetailViewProps}
        avatar={<FixedAssetAvatar />}
        title={<FixedAssetTitle asset={asset} t={t} />}
        actions={
          <FixedAssetActions
            asset={asset}
            hasPosted={hasPosted}
            onDispose={() => setDisposing(true)}
            onDelete={() => setConfirmDelete(true)}
            t={t}
          />
        }
        tabs={<FixedAssetTabsBar tabs={tabs} activeTab={activeTab} setActiveTab={setActiveTab} mode={mode} />}
      >
        {!assetQuery.isLoading && assetQuery.isError && (
          <div className="space-y-3 p-4">
            <p className="text-sm text-destructive" role="alert">
              {td.loadFailed}
            </p>
            <Button variant="outline" size="sm" onClick={() => void assetQuery.refetch()}>
              {common.retry}
            </Button>
          </div>
        )}
        {!assetQuery.isLoading && !assetQuery.isError && !asset && (
          <div className="p-6 text-center text-sm text-muted-foreground">{td.notFound}</div>
        )}

        {asset && activeTab === 'overview' && <FixedAssetDetailsTab asset={asset} locked={locked} t={t} />}
        {asset && activeTab === 'depreciation' && <FixedAssetDepreciationTab asset={asset} t={t} />}
        {asset && activeTab === 'history' && <EntityAuditPanel entityType="fixed_asset" entityId={asset.id} />}
      </EntityDetailView>

      {disposing && asset ? <DisposeDialog asset={asset} open onOpenChange={(open) => setDisposing(open)} /> : null}

      {asset ? (
        <ConfirmDialog
          open={confirmDelete}
          onOpenChange={setConfirmDelete}
          title={fill(td.deleteTitle, { name: asset.name })}
          description={td.deleteBody}
          confirmLabel={td.deleteConfirm}
          cancelLabel={common.cancel}
          variant="destructive"
          onConfirm={confirmRemoval}
        />
      ) : null}
    </>
  );
}
