/**
 * "Due this week": the invoices that fall due and the bills to pay in the next
 * seven days (a bill past its date counts too), soonest first, in one list.
 * Each row opens its record in the object panel over the dashboard.
 *
 * Invoices come from the dashboard. Bills come from the to-process list where
 * the edition serves it (`bills_due`: approved bills due within a week or
 * overdue); elsewhere the first page of approved bills is narrowed to the
 * week, which can miss a bill that is far down the list.
 */

import { useMemo } from 'react';
import { WeldbooksListHeader, WeldbooksListRow } from '@/components/accounting/weldbooks-entity-list';
import { ContactCell, RowAmount, RowDate, RowTitle, StatusChip } from '@/components/accounting/weldbooks-row-cells';
import type { ColumnDef } from '@/components/entity-list';
import { useObjectPanel } from '@/components/object-panel';
import { useInfiniteAccountingBills } from '@/hooks/queries/use-accounting-queries';
import { isTodoAvailable, useTodoTopItems } from '@/hooks/queries/use-weldbooks-todo-queries';
import type { Dashboard } from '@/lib/api/domains/weldbooks';
import { useI18n } from '@/lib/i18n/provider';
import { BILL_DUE_DAYS, isBillDue } from '@/lib/weldbooks/list-views';
import { useWeldbooksFormat } from '@/lib/weldbooks/use-weldbooks-format';

/** Rows shown: the list is a glance, not the lists it links to. */
const MAX_ROWS = 10;

export interface DueRow {
  kind: 'invoice' | 'bill';
  id: string;
  number: string | null;
  contactName: string | null;
  dueDate: string;
  amount: string | number | null;
  currency: string | null;
}

/** `YYYY-MM-DD` of the day `days` after `today`. */
function addDays(today: string, days: number): string {
  const date = new Date(`${today}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/** Invoices and bills due by the end of the week, soonest first; rows without a due date are left out. */
export function dueThisWeek(rows: readonly DueRow[], today: string): DueRow[] {
  const end = addDays(today, BILL_DUE_DAYS);
  return rows
    .filter((row) => row.dueDate.slice(0, 10) <= end)
    .sort((a, b) => a.dueDate.localeCompare(b.dueDate))
    .slice(0, MAX_ROWS);
}

function useDueRows(dashboard: Dashboard, today: string): DueRow[] {
  const todoAvailable = isTodoAvailable();
  const todoBills = useTodoTopItems('bills_due', MAX_ROWS, { enabled: todoAvailable });
  const listedBills = useInfiniteAccountingBills({ status: 'approved' }, { enabled: !todoAvailable });
  const listed = listedBills.data?.rows;
  const todoData = todoBills.data;

  return useMemo(() => {
    const invoices: DueRow[] = (dashboard.upcomingDue ?? []).map((inv) => ({
      kind: 'invoice',
      id: inv.id,
      number: inv.invoiceNumber,
      contactName: inv.contactName,
      dueDate: inv.dueDate,
      amount: inv.balanceDue,
      currency: dashboard.currency ?? null,
    }));
    const bills: DueRow[] = todoAvailable
      ? (todoData ?? [])
          .filter((item) => item.objectType === 'bill' && item.dueDate)
          .map((item) => ({
            kind: 'bill' as const,
            id: item.objectId,
            number: item.subtitle,
            contactName: item.title,
            dueDate: item.dueDate ?? '',
            amount: item.amount,
            currency: item.currency,
          }))
      : (listed ?? [])
          .filter((bill) => bill.dueDate && isBillDue({ status: bill.status, dueDate: bill.dueDate }, today))
          .map((bill) => ({
            kind: 'bill' as const,
            id: bill.id,
            number: bill.billNumber ?? null,
            contactName: bill.contactName ?? null,
            dueDate: bill.dueDate ?? '',
            amount: bill.balanceDue ?? bill.total,
            currency: bill.currency ?? null,
          }));
    return dueThisWeek([...invoices, ...bills], today);
  }, [dashboard, todoAvailable, todoData, listed, today]);
}

export function DueThisWeek({ dashboard }: Readonly<{ dashboard: Dashboard }>) {
  const { t } = useI18n();
  const td = t.accounting.dashboard;
  const tip = t.accounting.invoicesPage;
  const { formatMoney, formatDate, today } = useWeldbooksFormat();
  const { open: openPanel } = useObjectPanel();
  const rows = useDueRows(dashboard, today());

  // A row's key is its kind and id: an invoice and a bill never share a panel.
  const items = rows.map((row) => ({ ...row, rowId: `${row.kind}:${row.id}` }));
  type Item = (typeof items)[number];

  const columns: ColumnDef<Item>[] = [
    {
      id: 'number',
      header: tip.colNumber,
      width: 'min-w-0 flex-1 gap-2',
      render: (row) => <RowTitle>{row.number ?? '—'}</RowTitle>,
    },
    {
      id: 'contact',
      header: tip.colContact,
      width: 'hidden shrink-0 @2xl/list:flex w-[140px]',
      render: (row) => <ContactCell name={row.contactName} />,
    },
    {
      id: 'kind',
      header: td.table.type,
      width: 'hidden shrink-0 @2xl/list:flex w-[100px]',
      render: (row) => (
        <StatusChip tone={row.kind === 'invoice' ? 'green' : 'blue'}>
          {row.kind === 'invoice' ? td.charts.toReceive : td.charts.toPay}
        </StatusChip>
      ),
    },
    {
      id: 'dueDate',
      header: tip.colDueDate,
      width: 'w-[110px] shrink-0',
      render: (row) => <RowDate>{formatDate(row.dueDate)}</RowDate>,
    },
    {
      id: 'amount',
      header: td.table.amount,
      width: 'w-[110px] shrink-0',
      render: (row) => <RowAmount>{formatMoney(row.amount, row.currency)}</RowAmount>,
    },
  ];

  return (
    <section className="min-w-0 space-y-3">
      <h3 className="text-sm font-semibold">{td.dueThisWeek}</h3>
      {items.length === 0 ? (
        <p className="text-sm text-muted-foreground">{td.noDueThisWeek}</p>
      ) : (
        // A bordered box around the rows; its last row drops its own divider so the bottom edge is one line.
        <div className="@container/list overflow-hidden rounded-lg border [&>*:last-child]:border-b-0">
          <WeldbooksListHeader columns={columns} />
          {items.map((row) => (
            <WeldbooksListRow
              key={row.rowId}
              item={{ ...row, id: row.rowId }}
              columns={columns}
              getRowLabel={(r) => r.number ?? tip.colNumber}
              onRowClick={() => openPanel({ type: row.kind, id: row.id })}
            />
          ))}
        </div>
      )}
    </section>
  );
}
