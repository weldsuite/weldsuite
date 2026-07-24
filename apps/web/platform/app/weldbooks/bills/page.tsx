import { useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useAccountingBills } from '@/hooks/queries/use-accounting-queries';
import { Badge } from '@weldsuite/ui/components/badge';
import { ReceiptText } from 'lucide-react';
import { WeldbooksEntityList } from '@/components/accounting/weldbooks-entity-list';
import {
  EmptyStateIllustration,
  type ColumnDef,
  type GroupConfig,
} from '@/components/entity-list';
import { useI18n } from '@/lib/i18n/provider';

interface BillRow {
  id: string;
  billNumber: string | null;
  contactName: string | null;
  issueDate: string | null;
  dueDate: string | null;
  totalAmount: number | null;
  status: string;
}

function statusVariant(status: string) {
  switch (status) {
    case 'paid':
      return 'default' as const;
    case 'approved':
      return 'secondary' as const;
    case 'overdue':
      return 'destructive' as const;
    case 'draft':
      return 'outline' as const;
    default:
      return 'secondary' as const;
  }
}

function formatCurrency(value: number | null | undefined): string {
  return new Intl.NumberFormat('nl-NL', { style: 'currency', currency: 'EUR' }).format(Number(value ?? 0));
}

export default function BillsPage() {
  const [search, setSearch] = useState('');
  const { data, isLoading } = useAccountingBills({ search });
  const navigate = useNavigate();
  const { t } = useI18n();
  const tbp = t.accounting.billsPage;

  const bills = (data?.data ?? []) as unknown as BillRow[];

  // Group by lifecycle status, most-urgent first. The trailing "other" group is
  // an explicit catch-all: EntityList drops items matching no group, so any
  // status outside the known set stays visible here.
  const knownStatuses = ['overdue', 'approved', 'partial', 'draft', 'paid'];
  const groups: GroupConfig<BillRow>[] = [
    { id: 'overdue', label: tbp.groupOverdue, sortOrder: 1, filter: (b) => b.status === 'overdue' },
    { id: 'approved', label: tbp.groupApproved, sortOrder: 2, filter: (b) => b.status === 'approved' || b.status === 'partial' },
    { id: 'draft', label: tbp.groupDraft, sortOrder: 3, filter: (b) => b.status === 'draft' },
    { id: 'paid', label: tbp.groupPaid, sortOrder: 4, filter: (b) => b.status === 'paid' },
    { id: 'other', label: tbp.groupOther, sortOrder: 5, filter: (b) => !knownStatuses.includes(b.status) },
  ];

  const columns: ColumnDef<BillRow>[] = [
    {
      id: 'number',
      header: tbp.colNumber,
      width: 'flex-1',
      render: (bill) => <span className="font-medium">{bill.billNumber}</span>,
    },
    {
      id: 'supplier',
      header: tbp.colSupplier,
      width: 'flex-1',
      render: (bill) => (
        <span className="text-muted-foreground">{bill.contactName ?? '—'}</span>
      ),
    },
    {
      id: 'issueDate',
      header: tbp.colDate,
      width: 'w-[140px]',
      render: (bill) => (
        <span className="text-muted-foreground">{bill.issueDate ?? '—'}</span>
      ),
    },
    {
      id: 'dueDate',
      header: tbp.colDueDate,
      width: 'w-[140px]',
      render: (bill) => (
        <span className="text-muted-foreground">{bill.dueDate ?? '—'}</span>
      ),
    },
    {
      id: 'total',
      header: tbp.colTotal,
      width: 'w-[140px]',
      render: (bill) => <span>{formatCurrency(bill.totalAmount)}</span>,
    },
    {
      id: 'status',
      header: tbp.colStatus,
      width: 'w-[140px]',
      render: (bill) => <Badge variant={statusVariant(bill.status)}>{bill.status}</Badge>,
    },
  ];

  return (
    <WeldbooksEntityList<BillRow>
      items={bills}
      isLoading={isLoading}
      columns={columns}
      groups={groups}
      onRowClick={(bill) => navigate({ to: '/weldbooks/bills/$id', params: { id: bill.id } })}
      searchQuery={search}
      onSearchChange={setSearch}
      searchPlaceholder={tbp.searchPlaceholder}
      createButton={{
        label: tbp.newBill,
        onClick: () => navigate({ to: '/weldbooks/bills/add' }),
      }}
      emptyState={{
        icon: (
          <EmptyStateIllustration>
            <ReceiptText className="h-10 w-10 text-muted-foreground/60" strokeWidth={1.5} />
          </EmptyStateIllustration>
        ),
        title: tbp.noBills,
        description: tbp.searchPlaceholder,
        action: {
          label: tbp.newBill,
          onClick: () => navigate({ to: '/weldbooks/bills/add' }),
        },
      }}
    />
  );
}
