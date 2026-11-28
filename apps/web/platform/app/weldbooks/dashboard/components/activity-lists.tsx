/**
 * The lists under the overview, side by side: what is due this week (invoices and bills, see
 * `DueThisWeek`) and the latest payments. Both are drawn with the lists' own row and column header
 * (the WeldBooks list row) in a bordered box. A due invoice or bill opens in its panel, a payment
 * in the panel of the invoice or bill it paid (a payment that paid neither is not clickable).
 */

import type { ColumnDef } from '@/components/entity-list';
import { useObjectPanel, useObjectPanelUrlSync } from '@/components/object-panel';
import { WeldbooksListHeader, WeldbooksListRow } from '@/components/accounting/weldbooks-entity-list';
import { RowAmount, RowDate, RowText, StatusChip } from '@/components/accounting/weldbooks-row-cells';
import type { Dashboard } from '@/lib/api/domains/weldbooks';
import { useI18n } from '@/lib/i18n/provider';
import { useWeldbooksFormat } from '@/lib/weldbooks/use-weldbooks-format';
import { DueThisWeek } from './due-this-week';

type RecentPayment = Dashboard['recentPayments'][number];

/** The panel a payment opens: the invoice it was recorded on, else the bill; none for a payment on neither. */
export function paymentPanelTarget(payment: Pick<RecentPayment, 'invoiceId' | 'billId'>) {
  if (payment.invoiceId) return { type: 'invoice' as const, id: payment.invoiceId };
  if (payment.billId) return { type: 'bill' as const, id: payment.billId };
  return null;
}

export function ActivityLists({ dashboard }: Readonly<{ dashboard: Dashboard }>) {
  const { t } = useI18n();
  const td = t.accounting.dashboard;
  // An invoice or bill opens in the shared object panel over the dashboard.
  const { open: openPanel } = useObjectPanel();
  useObjectPanelUrlSync('/weldbooks/dashboard');
  const { formatMoney, formatDate } = useWeldbooksFormat();
  const payments = dashboard.recentPayments ?? [];
  const methodLabels = t.accounting.paymentMethods as Record<string, string>;
  const typeLabels = td.paymentTypes as Record<string, string>;

  const paymentColumns: ColumnDef<RecentPayment>[] = [
    {
      id: 'date',
      header: td.table.date,
      width: 'w-[110px] shrink-0',
      render: (payment) => <RowDate>{formatDate(payment.date)}</RowDate>,
    },
    {
      id: 'type',
      header: td.table.type,
      width: 'w-[100px] shrink-0',
      render: (payment) => (
        <StatusChip tone={payment.type === 'received' ? 'green' : 'blue'}>
          {typeLabels[payment.type] ?? payment.type}
        </StatusChip>
      ),
    },
    {
      id: 'reference',
      header: td.table.method,
      width: 'hidden min-w-0 flex-1 @2xl/list:flex',
      render: (payment) => (
        <RowText>
          {[payment.paymentMethod ? (methodLabels[payment.paymentMethod] ?? payment.paymentMethod) : null, payment.reference]
            .filter(Boolean)
            .join(' · ')}
        </RowText>
      ),
    },
    {
      id: 'amount',
      header: td.table.amount,
      width: 'w-[110px] shrink-0 ml-auto',
      render: (payment) => <RowAmount>{formatMoney(Number(payment.amount))}</RowAmount>,
    },
  ];

  return (
    <div className="@container min-w-0">
      <div className="grid min-w-0 gap-6 @4xl:grid-cols-2">
        <DueThisWeek dashboard={dashboard} />

        <section className="min-w-0 space-y-3">
          <h3 className="text-sm font-semibold">{td.latestPayments}</h3>
          {payments.length === 0 ? (
            <p className="text-sm text-muted-foreground">{td.noRecentPayments}</p>
          ) : (
            <div className="@container/list overflow-hidden rounded-lg border [&>*:last-child]:border-b-0">
              <WeldbooksListHeader columns={paymentColumns} />
              {payments.map((payment) => {
                const target = paymentPanelTarget(payment);
                return (
                  <WeldbooksListRow
                    key={payment.id}
                    item={payment}
                    columns={paymentColumns}
                    getRowLabel={(p) => `${formatDate(p.date)} ${formatMoney(Number(p.amount))}`}
                    onRowClick={target ? () => openPanel({ ...target }) : undefined}
                  />
                );
              })}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
