import { useMemo } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useAccountingContactNames, useAccountingRecurringInvoices } from '@/hooks/queries/use-accounting-queries';
import { Repeat } from 'lucide-react';
import { EmptyStateIllustration, type ColumnDef, type GroupConfig } from '@/components/entity-list';
import { WeldbooksEntityList } from '@/components/accounting/weldbooks-entity-list';
import { ContactCell, RowAmount, RowChip, RowDate, RowTitle, StatusChip } from '@/components/accounting/weldbooks-row-cells';
import { useI18n } from '@/lib/i18n/provider';
import { useWeldbooksFormat } from '@/lib/weldbooks/use-weldbooks-format';
import { useDocumentTexts } from '@/lib/weldbooks/use-document-texts';
import { RECURRING_FREQUENCIES, type RecurringFrequency } from './components/recurring-payload';

/** A `recurring_invoices` row as the list endpoint returns it. */
interface RecurringInvoice {
  id: string;
  name: string | null;
  contactId: string;
  frequency: string;
  nextIssueDate: string | null;
  status: string;
  templateData?: {
    items?: Array<{ quantity: number; unitPrice: number }>;
    currency?: string;
  } | null;
}

interface RecurringRow {
  id: string;
  title: string;
  contactName: string | null;
  frequency: string;
  frequencyLabel: string;
  nextIssueDate: string | null;
  amount: number;
  currency: string | null;
  status: string;
}

function isFrequency(value: string): value is RecurringFrequency {
  return (RECURRING_FREQUENCIES as readonly string[]).includes(value);
}

export default function RecurringInvoicesPage() {
  const { t } = useI18n();
  const td = useDocumentTexts();
  const { formatMoney, formatDate } = useWeldbooksFormat();
  const trp = t.accounting.recurringPage;
  const navigate = useNavigate();

  const { data, isLoading } = useAccountingRecurringInvoices();
  const raw = useMemo(() => (data?.data ?? []) as unknown as RecurringInvoice[], [data]);
  // The list endpoint returns only `contactId`.
  const contactNames = useAccountingContactNames(raw.map((rec) => rec.contactId));

  const statusLabels: Record<string, string> = {
    active: trp.statusActive,
    paused: trp.statusPaused,
    completed: trp.statusCompleted,
  };

  const items = useMemo<RecurringRow[]>(() => {
    return raw.map((rec) => {
      const contactName = contactNames.get(rec.contactId) ?? null;
      const amount = (rec.templateData?.items ?? []).reduce(
        (sum, line) => sum + Number(line.quantity || 0) * Number(line.unitPrice || 0),
        0,
      );
      return {
        id: rec.id,
        title: rec.name || contactName || trp.defaultName,
        contactName,
        frequency: rec.frequency,
        frequencyLabel: isFrequency(rec.frequency) ? td.recurring.frequencies[rec.frequency] : rec.frequency,
        nextIssueDate: rec.nextIssueDate,
        amount,
        currency: rec.templateData?.currency ?? null,
        status: rec.status,
      };
    });
  }, [raw, contactNames, td, trp.defaultName]);

  // Grouped by status like the task list. The trailing group is a catch-all:
  // EntityList drops items matching no group.
  const knownStatuses = new Set(['active', 'paused', 'completed']);
  const groups: GroupConfig<RecurringRow>[] = [
    { id: 'active', label: trp.statusActive, sortOrder: 1, filter: (r) => r.status === 'active' },
    { id: 'paused', label: trp.statusPaused, sortOrder: 2, filter: (r) => r.status === 'paused' },
    { id: 'completed', label: trp.statusCompleted, sortOrder: 3, filter: (r) => r.status === 'completed' },
    { id: 'other', label: t.accounting.invoicesPage.groupOther, sortOrder: 4, filter: (r) => !knownStatuses.has(r.status) },
  ];

  const columns: ColumnDef<RecurringRow>[] = [
    {
      id: 'name',
      header: trp.colName,
      width: 'min-w-[200px] flex-1 gap-2',
      render: (rec) => (
        <RowTitle chips={<RowChip icon={<Repeat />}>{rec.frequencyLabel}</RowChip>}>{rec.title}</RowTitle>
      ),
    },
    {
      id: 'contact',
      header: trp.colContact,
      width: 'w-[200px]',
      render: (rec) => <ContactCell name={rec.contactName} />,
    },
    {
      id: 'nextDate',
      header: trp.colNextDate,
      width: 'w-[120px]',
      render: (rec) => <RowDate>{rec.status === 'completed' ? null : formatDate(rec.nextIssueDate)}</RowDate>,
    },
    {
      id: 'amount',
      header: trp.colAmount,
      width: 'w-[130px]',
      render: (rec) => <RowAmount>{formatMoney(rec.amount, rec.currency)}</RowAmount>,
    },
    {
      id: 'status',
      header: trp.colStatus,
      width: 'w-[110px]',
      render: (rec) => <StatusChip status={rec.status}>{statusLabels[rec.status] ?? rec.status}</StatusChip>,
    },
  ];

  return (
    <WeldbooksEntityList<RecurringRow>
      items={items}
      isLoading={isLoading}
      columns={columns}
      groups={groups}
      onRowClick={(item) => navigate({ to: '/weldbooks/recurring/$id', params: { id: item.id } })}
      filters={[]}
      searchFields={['title', 'contactName', 'frequencyLabel']}
      createButton={{
        label: trp.newRecurring,
        onClick: () => navigate({ to: '/weldbooks/recurring/add' }),
      }}
      emptyState={{
        icon: (
          <EmptyStateIllustration>
            <Repeat className="h-10 w-10 text-muted-foreground/60" strokeWidth={1.5} />
          </EmptyStateIllustration>
        ),
        title: trp.noRecurring,
        description: trp.emptyDescription,
        action: {
          label: trp.newRecurring,
          onClick: () => navigate({ to: '/weldbooks/recurring/add' }),
        },
      }}
    />
  );
}
