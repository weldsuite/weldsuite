/**
 * Journal entry object panel (WeldBooks).
 *
 * Built on the same shell as the company / person / bank account panels:
 * `useObjectPanelShell` + `EntityDetailView` + `ObjectPanelTabs`, so it
 * inherits the shared header chrome, the panel↔fullscreen toggle and the
 * stacking/back behaviour. It replaces the standalone
 * `/weldbooks/journal/:id` page, which now redirects to the list with this
 * panel open in fullscreen.
 *
 * Tabs: Details · Lines · History.
 */

import { useEffect, useMemo, useState } from 'react';
import {
  AlignLeft,
  ArrowDownLeft,
  ArrowUpRight,
  BookText,
  CalendarDays,
  EllipsisVertical,
  Layers,
  Link as LinkIcon,
} from 'lucide-react';
import { toast } from 'sonner';
import { useTranslations } from '@weldsuite/i18n/client';
import { usePermissions } from '@weldsuite/permissions/react';
import { Button } from '@weldsuite/ui/components/button';
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
import { TabListRow, TabListScope } from '@/components/objects/_shared/tab-list-row';
import { NotesIllustration, TabEmptyState, tabBodyClassName } from '@/components/objects/_shared/tab-empty-state';
import {
  useAccountingAccounts,
  useAccountingJournalEntry,
  useDimensionValues,
  usePostJournalEntry,
} from '@/hooks/queries/use-accounting-queries';
import { useWorkspaceUrl } from '@/hooks/use-workspace-url';
import type { JournalEntryDetail, JournalLine } from '@/lib/api/domains/weldbooks';
import { useI18n } from '@/lib/i18n/provider';
import { cn } from '@/lib/utils';
import { useWeldbooksFormat } from '@/lib/weldbooks/use-weldbooks-format';
import { useDocumentTexts } from '@/lib/weldbooks/use-document-texts';
import { getJournalEntryTabs, type JournalEntryTab } from './journal-entry-tabs';

const JOURNAL_ENTRY_PANEL_WIDTH = 480;

const PILL = 'inline-flex items-center h-[22px] px-2 rounded text-[12px] font-medium leading-none';
const PILL_GREEN = 'text-emerald-600 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-950';
const PILL_GRAY = 'text-gray-600 dark:text-muted-foreground bg-gray-100 dark:bg-secondary';
const PILL_RED = 'text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-950';

type Translations = ReturnType<typeof useI18n>['t'];

function statusPillClass(status: string): string {
  if (status === 'posted') return PILL_GREEN;
  if (status === 'reversed') return PILL_RED;
  return PILL_GRAY;
}

function journalStatusLabel(status: string, t: Translations): string {
  const labels = t.accounting.statusLabels.journalEntry;
  if (status === 'draft') return labels.draft;
  if (status === 'posted') return labels.posted;
  if (status === 'reversed') return labels.reversed;
  return status;
}

function JournalEntryAvatar() {
  return (
    <div className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-lg bg-indigo-100 dark:bg-indigo-900">
      <BookText className="h-3.5 w-3.5 text-indigo-600 dark:text-indigo-400" />
    </div>
  );
}

function JournalEntryTitle({ entry, t }: Readonly<{ entry?: JournalEntryDetail; t: Translations }>) {
  if (!entry) return <div className="h-4 w-32 rounded bg-muted animate-pulse" />;
  return (
    <div className="flex min-w-0 items-center gap-2">
      <span className="truncate text-[15px] font-medium text-foreground">
        {entry.entryNumber ?? t.accounting.statusLabels.journalEntry.fallback}
      </span>
      <span className={cn(PILL, statusPillClass(entry.status), 'flex-shrink-0')}>
        {journalStatusLabel(entry.status, t)}
      </span>
    </div>
  );
}

function JournalEntryActions({
  entry,
  canPost,
  posting,
  onPost,
  t,
}: Readonly<{
  entry?: JournalEntryDetail;
  canPost: boolean;
  posting: boolean;
  onPost: () => void;
  t: Translations;
}>) {
  const st = useTranslations();
  const workspaceUrl = useWorkspaceUrl();
  if (!entry) return null;
  const tj = t.accounting.journalEntry;

  const handleCopyLink = async () => {
    try {
      await navigator.clipboard.writeText(
        workspaceUrl(`/weldbooks/journal?stack=journal_entry:${entry.id}`),
      );
      toast.success(st('sweep.entities.linkCopied'));
    } catch {
      toast.error(st('sweep.entities.copyLinkFailed'));
    }
  };

  return (
    <div className="flex items-center gap-1">
      {entry.status === 'draft' && canPost ? (
        <Button size="sm" onClick={onPost} disabled={posting} data-testid="post-journal-entry">
          {posting ? tj.posting : tj.postEntry}
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

function JournalEntryTabsBar({
  tabs,
  activeTab,
  setActiveTab,
  mode,
}: Readonly<{
  tabs: JournalEntryTab[];
  activeTab: JournalEntryTab['id'];
  setActiveTab: (id: JournalEntryTab['id']) => void;
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
    objectType: 'journal_entry',
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
        onChange={(id) => setActiveTab(id as JournalEntryTab['id'])}
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

function JournalEntryDetailsTab({ entry, t }: Readonly<{ entry: JournalEntryDetail; t: Translations }>) {
  const st = useTranslations();
  const { formatMoney, formatDate } = useWeldbooksFormat();
  const tj = t.accounting.journalEntry;
  const source = entry.sourceType?.replace('_', ' ') || t.accounting.statusLabels.journalEntry.sourceManual;

  return (
    <div className="@container p-4 space-y-4">
      <div className="space-y-1">
        <PropertyRow icon={ArrowDownLeft} label={tj.debit} value={formatMoney(entry.totalDebit)} readOnly />
        <PropertyRow icon={ArrowUpRight} label={tj.credit} value={formatMoney(entry.totalCredit)} readOnly />
        <PropertyRow icon={CalendarDays} label={st('sweep.entities.fieldDate')} value={formatDate(entry.date)} readOnly />
        <PropertyRow
          icon={AlignLeft}
          label={tj.descriptionLabel}
          value={entry.description}
          placeholder="—"
          readOnly
        />
        <PropertyRow
          icon={Layers}
          label={tj.sourceLabel}
          value={source}
          readOnly
          renderValue={(value) => (
            <span className="flex min-w-0 flex-wrap items-center gap-2">
              <span className="capitalize">{value}</span>
              {entry.isAutomatic ? <span className={cn(PILL, PILL_GRAY)}>{tj.autoGenerated}</span> : null}
            </span>
          )}
        />
      </div>
    </div>
  );
}

// ─── Lines tab ─────────────────────────────────────────────────────────────

interface LineView {
  line: JournalLine;
  account: string;
  dimensions: string;
}

function JournalLineRow({ view, t }: Readonly<{ view: LineView; t: Translations }>) {
  const { formatMoney } = useWeldbooksFormat();
  const tj = t.accounting.journalEntry;
  const { line, account, dimensions } = view;
  const amounts = [
    Number(line.debit) > 0 ? { label: tj.debit, value: formatMoney(line.debit, line.currency) } : null,
    Number(line.credit) > 0 ? { label: tj.credit, value: formatMoney(line.credit, line.currency) } : null,
  ].filter((amount): amount is { label: string; value: string } => amount !== null);

  return (
    <TabListRow label={account}>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium">{account}</div>
        <div className="truncate text-xs text-muted-foreground">{line.description || '-'}</div>
        {dimensions ? <div className="truncate text-xs text-muted-foreground">{dimensions}</div> : null}
      </div>
      <div className="flex-shrink-0 text-right tabular-nums">
        {amounts.length === 0 ? <span className="text-sm">-</span> : null}
        {amounts.map((amount) => (
          <div key={amount.label}>
            <div className="text-sm font-medium">{amount.value}</div>
            <div className="text-xs text-muted-foreground">{amount.label}</div>
          </div>
        ))}
      </div>
    </TabListRow>
  );
}

function JournalEntryLinesTab({ entry, t }: Readonly<{ entry: JournalEntryDetail; t: Translations }>) {
  const td = useDocumentTexts().journal;
  const { formatMoney } = useWeldbooksFormat();
  const tj = t.accounting.journalEntry;
  const { data: accountsData } = useAccountingAccounts({ includeInactive: true });
  const { data: dimensionValues } = useDimensionValues();

  const accountName = (accountId: string): string => {
    const account = accountsData?.data.find((item) => item.id === accountId);
    return account ? `${account.code} — ${account.name}` : accountId;
  };
  const dimensionName = (valueId: string | null | undefined) =>
    valueId ? (dimensionValues ?? []).find((value) => value.id === valueId)?.name : undefined;

  const views: LineView[] = (entry.lines ?? []).map((line) => {
    const dims = line as JournalLine & { classId?: string | null; locationId?: string | null };
    const className = dimensionName(dims.classId);
    const locationName = dimensionName(dims.locationId);
    return {
      line,
      account: accountName(line.accountId),
      dimensions: [className && `${td.class}: ${className}`, locationName && `${td.location}: ${locationName}`]
        .filter(Boolean)
        .join(' · '),
    };
  });

  if (views.length === 0) {
    return (
      <TabEmptyState
        illustration={<NotesIllustration />}
        bare
        title={tj.noLines}
        description={tj.noLinesDescription}
      />
    );
  }

  return (
    <div className="p-4">
      <TabListScope>
        <div className="border-t border-gray-200/70 dark:border-border">
          {views.map((view) => (
            <JournalLineRow key={view.line.id} view={view} t={t} />
          ))}
        </div>
      </TabListScope>
      <div className="flex items-start justify-between gap-4 px-4 pt-3 text-sm">
        <span className="font-medium">{tj.totals}</span>
        <dl className="space-y-0.5 tabular-nums">
          <div className="flex justify-between gap-6">
            <dt className="text-muted-foreground">{tj.debit}</dt>
            <dd className="font-semibold">{formatMoney(entry.totalDebit)}</dd>
          </div>
          <div className="flex justify-between gap-6">
            <dt className="text-muted-foreground">{tj.credit}</dt>
            <dd className="font-semibold">{formatMoney(entry.totalCredit)}</dd>
          </div>
        </dl>
      </div>
    </div>
  );
}

// ─── Panel ─────────────────────────────────────────────────────────────────

export function JournalEntryPanel(props: Readonly<ObjectPanelComponentProps>) {
  const { id, initialTab } = props;
  const { t } = useI18n();
  const st = useTranslations();
  const { can } = usePermissions();
  const tj = t.accounting.journalEntry;

  const entryQuery = useAccountingJournalEntry(id);
  const entry = entryQuery.data?.data;
  const postEntry = usePostJournalEntry();

  const shell = useObjectPanelShell({
    ...props,
    width: JOURNAL_ENTRY_PANEL_WIDTH,
    loading: entryQuery.isLoading && !entry,
  });
  const mode = shell.mode;

  const lineCount = entry?.lines?.length ?? 0;
  const tabs = useMemo(
    () =>
      getJournalEntryTabs({
        details: st('sweep.entities.detailsTab'),
        lines: tj.journalLines,
        history: st('sweep.entities.auditLogTab'),
        linesCount: lineCount || undefined,
      }),
    [st, tj.journalLines, lineCount],
  );

  const initial = useMemo<JournalEntryTab['id']>(() => {
    const match = tabs.find((tab) => tab.id === initialTab);
    return match?.id ?? 'overview';
  }, [initialTab, tabs]);
  const [activeTab, setActiveTab] = useState<JournalEntryTab['id']>(initial);

  const handlePost = () => {
    if (!entry) return;
    postEntry.mutate(entry.id, {
      onError: (error) => toast.error(error instanceof Error ? error.message : String(error)),
    });
  };

  return (
    <EntityDetailView
      {...shell.entityDetailViewProps}
      contentClassName={tabBodyClassName(mode)}
      avatar={<JournalEntryAvatar />}
      title={<JournalEntryTitle entry={entry} t={t} />}
      actions={
        <JournalEntryActions
          entry={entry}
          canPost={can('journal:update')}
          posting={postEntry.isPending}
          onPost={handlePost}
          t={t}
        />
      }
      tabs={
        <JournalEntryTabsBar tabs={tabs} activeTab={activeTab} setActiveTab={setActiveTab} mode={mode} />
      }
    >
      {!entryQuery.isLoading && entryQuery.isError && (
        <div className="p-4 text-sm text-destructive">{st('sweep.entities.failedToLoad')}</div>
      )}
      {!entryQuery.isLoading && !entryQuery.isError && !entry && (
        <div className="p-6 text-center text-sm text-muted-foreground">{tj.notFound}</div>
      )}

      {entry && activeTab === 'overview' && <JournalEntryDetailsTab entry={entry} t={t} />}
      {entry && activeTab === 'lines' && <JournalEntryLinesTab entry={entry} t={t} />}
      {entry && activeTab === 'history' && <EntityAuditPanel entityType="journal_entry" entityId={entry.id} />}
    </EntityDetailView>
  );
}
