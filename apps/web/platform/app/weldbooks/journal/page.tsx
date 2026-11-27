import { useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useInfiniteAccountingJournalEntries } from '@/hooks/queries/use-accounting-queries';
import { TextAlignStart } from 'lucide-react';
import { EmptyStateIllustration, type ActiveFilter, type ColumnDef, type FilterConfig, type GroupConfig } from '@/components/entity-list';
import { useObjectPanel, useObjectPanelUrlSync } from '@/components/object-panel';
import { WeldbooksEntityList } from '@/components/accounting/weldbooks-entity-list';
import {
  RowAmount,
  RowDate,
  RowNumberChip,
  RowText,
  RowTitle,
  StatusChip,
} from '@/components/accounting/weldbooks-row-cells';
import { useI18n } from '@/lib/i18n/provider';
import { useWeldbooksFormat } from '@/lib/weldbooks/use-weldbooks-format';
import { toCalendarDate } from '@/lib/weldbooks/format';
import { journalSourceLabel } from '@/lib/weldbooks/journal-source';
import { applyExclusions, pillValue } from '@/lib/weldbooks/list-filters';

/** The statuses the Status filter offers. */
const JOURNAL_STATUSES = ['draft', 'posted', 'reversed'] as const;

interface JournalEntryRow {
  id: string;
  date: string | null;
  entryNumber: string | null;
  reference: string | null;
  description: string | null;
  status: string;
  sourceType: string | null;
  totalDebit: number | null;
  totalCredit: number | null;
}

/**
 * Derive one group per distinct year-month that appears in the entries, sorted
 * newest-first so the most recent month sits at the top. A trailing catch-all
 * group keeps undated / unparseable entries visible — EntityList drops items
 * that match no group, so they'd otherwise disappear.
 */
function monthKey(date: string | null): string | null {
  const iso = toCalendarDate(date);
  return iso ? iso.slice(0, 7) : null;
}

function buildMonthGroups(
  entries: JournalEntryRow[],
  ungroupedLabel: string,
  formatMonth: (value: string | null) => string,
): GroupConfig<JournalEntryRow>[] {
  const monthLabels = new Map<string, string>();
  for (const e of entries) {
    const key = monthKey(e.date);
    if (!key) continue;
    if (!monthLabels.has(key)) monthLabels.set(key, formatMonth(e.date));
  }
  const keys = [...monthLabels.keys()].sort((a, b) => b.localeCompare(a));
  const groups: GroupConfig<JournalEntryRow>[] = keys.map((key, i) => ({
    id: key,
    label: monthLabels.get(key)!,
    sortOrder: i,
    filter: (e) => monthKey(e.date) === key,
  }));
  groups.push({
    id: 'ungrouped',
    label: ungroupedLabel,
    sortOrder: keys.length,
    filter: (e) => monthKey(e.date) === null,
  });
  return groups;
}

export default function JournalEntriesPage() {
  const [activeFilters, setActiveFilters] = useState<ActiveFilter[]>([]);
  const [search, setSearch] = useState('');
  // The server filters on the status and searches number, reference and description, a page at a time.
  const { data, isLoading, hasNextPage, isFetchingNextPage, fetchNextPage } = useInfiniteAccountingJournalEntries({
    status: pillValue(activeFilters, 'status'),
    search,
  });
  const navigate = useNavigate();
  // Each entry opens in the shared object panel (type 'journal_entry'), the
  // same panel/fullscreen shell as WeldCRM companies, synced to `?stack=`.
  const { open: openPanel } = useObjectPanel();
  useObjectPanelUrlSync('/weldbooks/journal');
  const { t } = useI18n();
  const tjp = t.accounting.journalPage;
  const statusLabels = t.accounting.statusLabels.journalEntry as Record<string, string>;
  const sourceLabels = t.accounting.statusLabels.journalEntrySource as Record<string, string>;
  const { formatMoney: fmt, formatDate, formatMonth } = useWeldbooksFormat();

  // The server filters on an `is` status; an `is not` one narrows the rows it sent.
  const entries = applyExclusions((data?.rows ?? []) as unknown as JournalEntryRow[], activeFilters, { status: (e) => e.status });
  const filterConfigs: FilterConfig[] = [
    { field: 'status', label: tjp.colStatus, options: JOURNAL_STATUSES.map((value) => ({ value, label: statusLabels[value] ?? value })) },
  ];

  // Entries made without a free-text reference are still identified by their entry number.
  const columns: ColumnDef<JournalEntryRow>[] = [
    {
      id: 'reference',
      header: tjp.colReference,
      width: 'min-w-0 flex-1 gap-2 @2xl/list:min-w-[200px]',
      render: (e) => (
        <RowTitle chips={e.reference && e.entryNumber ? <RowNumberChip>{e.entryNumber}</RowNumberChip> : null}>
          {e.reference || e.entryNumber || '—'}
        </RowTitle>
      ),
    },
    {
      id: 'description',
      header: tjp.colDescription,
      width: 'hidden shrink-0 @6xl/list:flex w-[240px]',
      render: (e) => <RowText>{e.description}</RowText>,
    },
    {
      id: 'date',
      header: tjp.colDate,
      width: 'hidden shrink-0 @4xl/list:flex w-[120px]',
      render: (e) => <RowDate>{formatDate(e.date)}</RowDate>,
    },
    {
      id: 'debit',
      header: tjp.colDebit,
      width: 'hidden shrink-0 @4xl/list:flex w-[130px]',
      render: (e) => <RowAmount>{fmt(e.totalDebit)}</RowAmount>,
    },
    {
      id: 'credit',
      header: tjp.colCredit,
      width: 'hidden shrink-0 @4xl/list:flex w-[130px]',
      render: (e) => <RowAmount>{fmt(e.totalCredit)}</RowAmount>,
    },
    {
      id: 'source',
      header: tjp.colSource,
      width: 'hidden shrink-0 @6xl/list:flex w-[150px]',
      render: (e) => <RowText>{journalSourceLabel(e.sourceType, sourceLabels)}</RowText>,
    },
    {
      id: 'status',
      header: tjp.colStatus,
      width: 'shrink-0 w-[110px]',
      render: (e) => <StatusChip status={e.status}>{statusLabels[e.status] ?? e.status}</StatusChip>,
    },
  ];

  return (
    <WeldbooksEntityList<JournalEntryRow>
      items={entries}
      isLoading={isLoading}
      columns={columns}
      groups={buildMonthGroups(entries, tjp.ungrouped, formatMonth)}
      onRowClick={(e) => openPanel({ type: 'journal_entry', id: e.id })}
      getRowLabel={(e) => e.reference || e.entryNumber || e.id}
      filters={filterConfigs}
      activeFilters={activeFilters}
      onFiltersChange={setActiveFilters}
      searchQuery={search}
      onSearchChange={setSearch}
      searchPlaceholder={tjp.searchPlaceholder}
      hasMore={hasNextPage}
      isLoadingMore={isFetchingNextPage}
      onLoadMore={() => void fetchNextPage()}
      createButton={{
        label: tjp.newEntry,
        onClick: () => navigate({ to: '/weldbooks/journal/add' }),
      }}
      emptyState={{
        icon: (
          <EmptyStateIllustration>
            <TextAlignStart className="h-10 w-10 text-muted-foreground/60" strokeWidth={1.5} />
          </EmptyStateIllustration>
        ),
        title: tjp.noEntries,
        description: tjp.emptyDescription,
        action: {
          label: tjp.newEntry,
          onClick: () => navigate({ to: '/weldbooks/journal/add' }),
        },
      }}
    />
  );
}
