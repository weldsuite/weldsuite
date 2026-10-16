import { useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useAccountingBills } from '@/hooks/queries/use-accounting-queries';
import { ReceiptText } from 'lucide-react';
import { WeldbooksEntityList } from '@/components/accounting/weldbooks-entity-list';
import { ContactCell, RowAmount, RowDate, RowTitle, StatusChip } from '@/components/accounting/weldbooks-row-cells';
import {
  EmptyStateIllustration,
  type ColumnDef,
  type GroupConfig,
} from '@/components/entity-list';
import { useI18n } from '@/lib/i18n/provider';
import { useWeldbooksFormat } from '@/lib/weldbooks/use-weldbooks-format';

interface BillRow {
  id: string;
  billNumber: string | null;
  contactName: string | null;
  issueDate: string | null;
  dueDate: string | null;
  totalAmount: number | null;
  total?: string | number | null;
  currency?: string | null;
  status: string;
}

export default function BillsPage() {
  const [search, setSearch] = useState('');
  const { data, isLoading } = useAccountingBills({ search });
  const navigate = useNavigate();
  const { t } = useI18n();
  const { formatMoney, formatDate } = useWeldbooksFormat();
  const tbp = t.accounting.billsPage;
  const tsl = t.accounting.statusLabels.bill as Record<string, string>;

  const bills = (data?.data ?? []) as unknown as BillRow[];

  // Group by lifecycle status, most-urgent first. The trailing "other" group is
  // an explicit catch-all: EntityList drops items matching no group, so any
  // status outside the known set stays visible here.
  const knownStatuses = new Set(['overdue', 'approved', 'partial', 'draft', 'paid']);
  const groups: GroupConfig<BillRow>[] = [
    { id: 'overdue', label: tbp.groupOverdue, sortOrder: 1, filter: (b) => b.status === 'overdue' },
    { id: 'approved', label: tbp.groupApproved, sortOrder: 2, filter: (b) => b.status === 'approved' || b.status === 'partial' },
    { id: 'draft', label: tbp.groupDraft, sortOrder: 3, filter: (b) => b.status === 'draft' },
    { id: 'paid', label: tbp.groupPaid, sortOrder: 4, filter: (b) => b.status === 'paid' },
    { id: 'other', label: tbp.groupOther, sortOrder: 5, filter: (b) => !knownStatuses.has(b.status) },
  ];

  const columns: ColumnDef<BillRow>[] = [
    {
      id: 'number',
      header: tbp.colNumber,
      width: 'min-w-[200px] flex-1 gap-2',
      render: (bill) => <RowTitle>{bill.billNumber ?? '—'}</RowTitle>,
    },
    {
      id: 'supplier',
      header: tbp.colSupplier,
      width: 'w-[200px]',
      render: (bill) => <ContactCell name={bill.contactName} />,
    },
    {
      id: 'issueDate',
      header: tbp.colDate,
      width: 'w-[120px]',
      render: (bill) => <RowDate>{formatDate(bill.issueDate)}</RowDate>,
    },
    {
      id: 'dueDate',
      header: tbp.colDueDate,
      width: 'w-[120px]',
      render: (bill) => <RowDate>{formatDate(bill.dueDate)}</RowDate>,
    },
    {
      id: 'total',
      header: tbp.colTotal,
      width: 'w-[130px]',
      render: (bill) => <RowAmount>{formatMoney(bill.total ?? bill.totalAmount, bill.currency)}</RowAmount>,
    },
    {
      id: 'status',
      header: tbp.colStatus,
      width: 'w-[110px]',
      render: (bill) => <StatusChip status={bill.status}>{tsl[bill.status] ?? bill.status}</StatusChip>,
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
        description: tbp.emptyDescription,
        action: {
          label: tbp.newBill,
          onClick: () => navigate({ to: '/weldbooks/bills/add' }),
        },
      }}
    />
  );
}
