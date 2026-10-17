/**
 * The list under the overview: the invoices falling due in the next 30 days,
 * drawn with the invoices page's own row and column header (the WeldBooks list
 * row) in a bordered box across the dashboard's width. The title opens the
 * full invoice list.
 */

import { Link } from '@tanstack/react-router';
import type { ColumnDef } from '@/components/entity-list';
import { useObjectPanel, useObjectPanelUrlSync } from '@/components/object-panel';
import { WeldbooksListHeader, WeldbooksListRow } from '@/components/accounting/weldbooks-entity-list';
import { ContactCell, RowAmount, RowDate, RowTitle } from '@/components/accounting/weldbooks-row-cells';
import type { Dashboard } from '@/lib/api/domains/weldbooks';
import { useI18n } from '@/lib/i18n/provider';
import { useWeldbooksFormat } from '@/lib/weldbooks/use-weldbooks-format';

type DueInvoice = Dashboard['upcomingDue'][number];

export function ActivityLists({ dashboard }: Readonly<{ dashboard: Dashboard }>) {
  const { t } = useI18n();
  const td = t.accounting.dashboard;
  const tip = t.accounting.invoicesPage;
  // An invoice opens in the shared object panel over the dashboard.
  const { open: openPanel } = useObjectPanel();
  useObjectPanelUrlSync('/weldbooks/dashboard');
  const { formatMoney, formatDate } = useWeldbooksFormat();
  const invoices = dashboard.upcomingDue ?? [];

  const columns: ColumnDef<DueInvoice>[] = [
    {
      id: 'number',
      header: tip.colNumber,
      width: 'min-w-[200px] flex-1 gap-2',
      render: (inv) => <RowTitle>{inv.invoiceNumber ?? '—'}</RowTitle>,
    },
    {
      id: 'contact',
      header: tip.colContact,
      width: 'w-[200px]',
      render: (inv) => <ContactCell name={inv.contactName} />,
    },
    {
      id: 'dueDate',
      header: tip.colDueDate,
      width: 'w-[120px]',
      render: (inv) => <RowDate>{formatDate(inv.dueDate)}</RowDate>,
    },
    {
      id: 'balanceDue',
      header: td.table.amount,
      width: 'w-[130px]',
      render: (inv) => <RowAmount>{formatMoney(Number(inv.balanceDue ?? 0))}</RowAmount>,
    },
  ];

  return (
    <section className="min-w-0 space-y-3">
      <h3 className="text-sm font-semibold">
        <Link to="/weldbooks/invoices" className="hover:underline">
          {td.charts.dueSoon}
        </Link>
      </h3>
      {invoices.length === 0 ? (
        <p className="text-sm text-muted-foreground">{td.noUpcomingInvoices}</p>
      ) : (
        // A bordered box around the rows; its last row drops its own divider so the bottom edge is one line.
        <div className="overflow-hidden rounded-lg border [&>*:last-child]:border-b-0">
          <WeldbooksListHeader columns={columns} />
          {invoices.map((inv) => (
            <WeldbooksListRow
              key={inv.id}
              item={inv}
              columns={columns}
              getRowLabel={(i) => i.invoiceNumber ?? tip.colNumber}
              onRowClick={(i) => openPanel({ type: 'invoice', id: i.id })}
            />
          ))}
        </div>
      )}
    </section>
  );
}
