import { useNavigate } from '@tanstack/react-router';
import { useAccountingJournalEntries } from '@/hooks/queries/use-accounting-queries';
import { BookOpen } from 'lucide-react';
import { EmptyStateIllustration, type ColumnDef, type GroupConfig } from '@/components/entity-list';
import { WeldbooksEntityList } from '@/components/accounting/weldbooks-entity-list';
import { useI18n } from '@/lib/i18n/provider';
import { useWeldbooksFormat } from '@/lib/weldbooks/use-weldbooks-format';
import { toCalendarDate } from '@/lib/weldbooks/format';

interface JournalEntryRow {
  id: string;
  date: string | null;
  reference: string | null;
  description: string | null;
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
  const { data, isLoading } = useAccountingJournalEntries();
  const navigate = useNavigate();
  const { t } = useI18n();
  const tjp = t.accounting.journalPage;
  const { formatMoney: fmt, formatDate, formatMonth } = useWeldbooksFormat();

  const entries = (data?.data ?? []) as unknown as JournalEntryRow[];

  const columns: ColumnDef<JournalEntryRow>[] = [
    {
      id: 'date',
      header: tjp.colDate,
      width: 'w-[140px]',
      render: (e) => <span className="text-muted-foreground">{formatDate(e.date)}</span>,
    },
    {
      id: 'reference',
      header: tjp.colReference,
      width: 'flex-1',
      render: (e) => <span className="font-medium">{e.reference}</span>,
    },
    {
      id: 'description',
      header: tjp.colDescription,
      width: 'flex-1',
      render: (e) => <span className="text-muted-foreground">{e.description ?? '—'}</span>,
    },
    {
      id: 'debit',
      header: tjp.colDebit,
      width: 'w-[140px]',
      render: (e) => fmt(e.totalDebit),
    },
    {
      id: 'credit',
      header: tjp.colCredit,
      width: 'w-[140px]',
      render: (e) => fmt(e.totalCredit),
    },
  ];

  return (
    <WeldbooksEntityList<JournalEntryRow>
      items={entries}
      isLoading={isLoading}
      columns={columns}
      groups={buildMonthGroups(entries, tjp.ungrouped, formatMonth)}
      onRowClick={(e) => navigate({ to: '/weldbooks/journal/$id', params: { id: e.id } })}
      filters={[]}
      searchFields={['reference', 'description']}
      createButton={{
        label: tjp.newEntry,
        onClick: () => navigate({ to: '/weldbooks/journal/add' }),
      }}
      emptyState={{
        icon: (
          <EmptyStateIllustration>
            <BookOpen className="h-10 w-10 text-muted-foreground/60" strokeWidth={1.5} />
          </EmptyStateIllustration>
        ),
        title: tjp.noEntries,
        description: t.accounting.description,
        action: {
          label: tjp.newEntry,
          onClick: () => navigate({ to: '/weldbooks/journal/add' }),
        },
      }}
    />
  );
}
