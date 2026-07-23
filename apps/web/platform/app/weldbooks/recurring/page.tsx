import { useNavigate } from '@tanstack/react-router';
import { useAccountingRecurringInvoices } from '@/hooks/queries/use-accounting-queries';
import { Badge } from '@weldsuite/ui/components/badge';
import { Repeat } from 'lucide-react';
import { EmptyStateIllustration, type ColumnDef } from '@/components/entity-list';
import { WeldbooksEntityList } from '@/components/accounting/weldbooks-entity-list';
import { useI18n } from '@/lib/i18n/provider';

interface RecurringRow {
  id: string;
  contactName: string | null;
  frequency: string;
  nextDate: string | null;
  amount: number | null;
  active: boolean;
}

export default function RecurringInvoicesPage() {
  const { t } = useI18n();
  const trp = t.accounting.recurringPage;

  const { data, isLoading } = useAccountingRecurringInvoices();
  const navigate = useNavigate();

  const items = (data?.data ?? []) as unknown as RecurringRow[];

  const columns: ColumnDef<RecurringRow>[] = [
    {
      id: 'contact',
      header: trp.colContact,
      width: 'flex-1',
      render: (item) => <span className="font-medium">{item.contactName}</span>,
    },
    {
      id: 'frequency',
      header: trp.colFrequency,
      width: 'w-[140px]',
      render: (item) => <span className="capitalize text-muted-foreground">{item.frequency}</span>,
    },
    {
      id: 'nextDate',
      header: trp.colNextDate,
      width: 'w-[140px]',
      render: (item) => <span className="text-muted-foreground">{item.nextDate ?? '—'}</span>,
    },
    {
      id: 'amount',
      header: trp.colAmount,
      width: 'w-[140px]',
      render: (item) =>
        new Intl.NumberFormat('nl-NL', { style: 'currency', currency: 'EUR' }).format(
          Number(item.amount ?? 0),
        ),
    },
    {
      id: 'status',
      header: trp.colStatus,
      width: 'w-[140px]',
      render: (item) => (
        <Badge variant={item.active ? 'default' : 'outline'}>
          {item.active ? trp.statusActive : trp.statusPaused}
        </Badge>
      ),
    },
  ];

  return (
    <WeldbooksEntityList<RecurringRow>
      items={items}
      isLoading={isLoading}
      columns={columns}
      onRowClick={(item) => navigate({ to: `/weldbooks/recurring/${item.id}` as any })}
      filters={[]}
      searchFields={['contactName', 'frequency']}
      createButton={{
        label: trp.newRecurring,
        onClick: () => navigate({ to: '/weldbooks/recurring/add' as any }),
      }}
      emptyState={{
        icon: (
          <EmptyStateIllustration>
            <Repeat className="h-10 w-10 text-muted-foreground/60" strokeWidth={1.5} />
          </EmptyStateIllustration>
        ),
        title: trp.noRecurring,
        description: t.accounting.description,
        action: {
          label: trp.newRecurring,
          onClick: () => navigate({ to: '/weldbooks/recurring/add' as any }),
        },
      }}
    />
  );
}
