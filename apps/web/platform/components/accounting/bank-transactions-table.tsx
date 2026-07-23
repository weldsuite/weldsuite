import { Badge } from '@weldsuite/ui/components/badge';
import { useTranslations } from '@weldsuite/i18n/client';
import { cn } from '@/lib/utils';
import {
  ListTable,
  type ListTableColumn,
  type ListTableGroup,
} from '@weldsuite/ui/components/list-table';
import type { BankTransaction } from '@/lib/api/domains/weldbooks';

interface BankTransactionsTableProps {
  transactions: BankTransaction[];
  emptyMessage?: string;
  currency?: string;
  /** When true, hide the counterparty column (used on account detail where it's obvious). */
  dense?: boolean;
  /**
   * When true, split rows under Unreconciled / Reconciled / Excluded group headers.
   * Enabled on the cross-account transactions list; disabled on the per-account
   * detail page where transactions are chronological and grouping adds noise.
   */
  groupByStatus?: boolean;
}

function statusVariant(status: string) {
  switch (status) {
    case 'reconciled':
      return 'default';
    case 'excluded':
      return 'outline';
    case 'unreconciled':
    default:
      return 'secondary';
  }
}

function formatDate(dateStr: string | null | undefined): string {
  if (!dateStr) return '';
  try {
    return new Intl.DateTimeFormat('nl-NL', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
    }).format(new Date(dateStr));
  } catch {
    return dateStr;
  }
}

function formatAmount(amount: string, currency: string): string {
  const n = Number(amount) || 0;
  return new Intl.NumberFormat('nl-NL', {
    style: 'currency',
    currency,
  }).format(n);
}

export function BankTransactionsTable({
  transactions,
  emptyMessage,
  currency = 'EUR',
  dense,
  groupByStatus,
}: BankTransactionsTableProps) {
  const st = useTranslations();
  const resolvedEmptyMessage = emptyMessage ?? st('sweep.weldbooks.bankTransactionsTable.emptyMessage');
  const columns: ListTableColumn<BankTransaction>[] = [
    {
      id: 'date',
      header: st('sweep.weldbooks.date'),
      width: 110,
      cell: (t) => <span className="text-sm">{formatDate(t.date)}</span>,
    },
    {
      id: 'description',
      header: st('sweep.weldbooks.description'),
      cell: (t) => (
        <div className="text-sm truncate max-w-[360px]">{t.description || '—'}</div>
      ),
    },
    {
      id: 'counterparty',
      header: st('sweep.weldbooks.bankTransactionsTable.counterparty'),
      hidden: dense,
      cell: (t) =>
        t.counterpartyName ? (
          <div className="text-sm">
            <div className="truncate max-w-[200px]">{t.counterpartyName}</div>
            {t.counterpartyIban ? (
              <div className="text-xs text-muted-foreground truncate max-w-[200px]">
                {t.counterpartyIban}
              </div>
            ) : null}
          </div>
        ) : (
          <span className="text-muted-foreground">—</span>
        ),
    },
    {
      id: 'reference',
      header: st('sweep.weldbooks.bankTransactionsTable.reference'),
      cell: (t) => (
        <span className="text-sm text-muted-foreground truncate max-w-[200px]">
          {t.reference || '—'}
        </span>
      ),
    },
    {
      id: 'amount',
      header: st('sweep.weldbooks.amount'),
      align: 'right',
      cell: (t) => {
        const isPositive = (Number(t.amount) || 0) >= 0;
        return (
          <span
            className={cn(
              'text-sm font-medium tabular-nums',
              isPositive ? 'text-emerald-600 dark:text-emerald-400' : 'text-foreground',
            )}
          >
            {formatAmount(t.amount, currency)}
          </span>
        );
      },
    },
    {
      id: 'status',
      header: st('sweep.weldbooks.status'),
      width: 120,
      cell: (t) => (
        <Badge variant={statusVariant(t.status)} className="capitalize">
          {t.status}
        </Badge>
      ),
    },
  ];

  const groups: ListTableGroup<BankTransaction>[] | undefined = groupByStatus
    ? [
        { id: 'unreconciled', label: st('sweep.weldbooks.bankTransactionsTable.unreconciled'), sortOrder: 1, filter: (t) => t.status === 'unreconciled' },
        { id: 'reconciled', label: st('sweep.weldbooks.bankTransactionsTable.reconciled'), sortOrder: 2, filter: (t) => t.status === 'reconciled' },
        { id: 'excluded', label: st('sweep.weldbooks.bankTransactionsTable.excluded'), sortOrder: 3, filter: (t) => t.status === 'excluded' },
      ]
    : undefined;

  return (
    <ListTable<BankTransaction>
      columns={columns}
      data={transactions}
      emptyMessage={resolvedEmptyMessage}
      dense={dense}
      groups={groups}
    />
  );
}
