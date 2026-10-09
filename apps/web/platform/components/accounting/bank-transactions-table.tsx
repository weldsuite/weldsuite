import { Badge } from '@weldsuite/ui/components/badge';
import { useTranslations } from '@weldsuite/i18n/client';
import { useI18n } from '@/lib/i18n/provider';
import { cn } from '@/lib/utils';
import {
  ListTable,
  type ListTableColumn,
  type ListTableGroup,
} from '@weldsuite/ui/components/list-table';
import type { BankLine } from '@/lib/api/domains/weldbooks-banking';
import { useWeldbooksFormat } from '@/lib/weldbooks/use-weldbooks-format';
import { formatWeldbooksMoney } from '@/lib/weldbooks/format-money';

interface BankTransactionsTableProps {
  transactions: BankLine[];
  emptyMessage?: string;
  currency?: string;
  /** Per-account currency lookup used when the table shows mixed accounts. */
  currencyByAccountId?: Record<string, string | null | undefined>;
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

function formatAmount(amount: string, currency: string, locale?: string | null): string {
  return formatWeldbooksMoney(amount, currency, locale);
}

function createDateCell(formatDate: (value: string | null | undefined) => string) {
  return function renderDateCell(t: BankLine) {
    return <span className="text-sm">{formatDate(t.date)}</span>;
  };
}

function renderDescriptionCell(t: BankLine) {
  return <div className="text-sm truncate max-w-[360px]">{t.description || '—'}</div>;
}

function renderCounterpartyCell(t: BankLine) {
  return t.counterpartyName ? (
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
  );
}

function renderReferenceCell(t: BankLine) {
  return (
    <span className="text-sm text-muted-foreground truncate max-w-[200px]">
      {t.reference || '—'}
    </span>
  );
}

function createAmountCell(
  currencyByAccountId: BankTransactionsTableProps['currencyByAccountId'],
  displayCurrency: string,
  locale: string | null | undefined,
) {
  return function renderAmountCell(t: BankLine) {
    const isPositive = (Number(t.amount) || 0) >= 0;
    return (
      <span
        className={cn(
          'text-sm font-medium tabular-nums',
          isPositive ? 'text-emerald-600 dark:text-emerald-400' : 'text-foreground',
        )}
      >
        {formatAmount(t.amount, currencyByAccountId?.[t.bankAccountId] ?? displayCurrency, locale)}
      </span>
    );
  };
}

function renderCheckNumberCell(t: BankLine) {
  return t.checkNumber ? (
    <span className="text-sm tabular-nums">{t.checkNumber}</span>
  ) : (
    <span className="text-muted-foreground">—</span>
  );
}

function renderStatusCell(t: BankLine) {
  return (
    <Badge variant={statusVariant(t.status)} className="capitalize">
      {t.status}
    </Badge>
  );
}

export function BankTransactionsTable({
  transactions,
  emptyMessage,
  currency,
  currencyByAccountId,
  dense,
  groupByStatus,
}: Readonly<BankTransactionsTableProps>) {
  const st = useTranslations();
  const { t: i18n } = useI18n();
  const tl = i18n.weldbooksUs.banking.lines;
  const { currency: entityCurrency, entityLocale: locale, formatDate } = useWeldbooksFormat();
  const displayCurrency = currency || entityCurrency;
  const resolvedEmptyMessage = emptyMessage ?? st('sweep.weldbooks.bankTransactionsTable.emptyMessage');
  const columns: ListTableColumn<BankLine>[] = [
    {
      id: 'date',
      header: st('sweep.weldbooks.date'),
      width: 110,
      cell: createDateCell(formatDate),
    },
    {
      id: 'description',
      header: st('sweep.weldbooks.description'),
      cell: renderDescriptionCell,
    },
    {
      id: 'counterparty',
      header: st('sweep.weldbooks.bankTransactionsTable.counterparty'),
      hidden: dense,
      cell: renderCounterpartyCell,
    },
    {
      id: 'reference',
      header: st('sweep.weldbooks.bankTransactionsTable.reference'),
      cell: renderReferenceCell,
    },
    {
      id: 'checkNumber',
      header: tl.checkNumber,
      width: 100,
      hidden: !transactions.some((t) => t.checkNumber),
      cell: renderCheckNumberCell,
    },
    {
      id: 'source',
      header: tl.source,
      width: 110,
      hidden: !transactions.some((t) => t.source),
      cell: (t) => (t.source ? <span className="text-sm text-muted-foreground">{tl.sources[t.source]}</span> : null),
    },
    {
      id: 'amount',
      header: st('sweep.weldbooks.amount'),
      align: 'right',
      cell: createAmountCell(currencyByAccountId, displayCurrency, locale),
    },
    {
      id: 'status',
      header: st('sweep.weldbooks.status'),
      width: 120,
      cell: renderStatusCell,
    },
  ];

  const groups: ListTableGroup<BankLine>[] | undefined = groupByStatus
    ? [
        { id: 'unreconciled', label: st('sweep.weldbooks.bankTransactionsTable.unreconciled'), sortOrder: 1, filter: (t) => t.status === 'unreconciled' },
        { id: 'reconciled', label: st('sweep.weldbooks.bankTransactionsTable.reconciled'), sortOrder: 2, filter: (t) => t.status === 'reconciled' },
        { id: 'excluded', label: st('sweep.weldbooks.bankTransactionsTable.excluded'), sortOrder: 3, filter: (t) => t.status === 'excluded' },
      ]
    : undefined;

  return (
    <ListTable<BankLine>
      columns={columns}
      data={transactions}
      emptyMessage={resolvedEmptyMessage}
      dense={dense}
      groups={groups}
    />
  );
}
