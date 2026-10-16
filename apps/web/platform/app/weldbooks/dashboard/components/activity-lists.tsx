/**
 * The two short lists under the overview: invoices falling due in the next 30
 * days and the latest payments, five rows each; the title opens the full list.
 */

import type { ReactNode } from 'react';
import { Link, type LinkProps } from '@tanstack/react-router';
import { ArrowDownLeft, ArrowUpRight } from 'lucide-react';
import type { Dashboard } from '@/lib/api/domains/weldbooks';
import { useI18n } from '@/lib/i18n/provider';
import { ContactCell, RowAmount, RowDate, RowText } from '@/components/accounting/weldbooks-row-cells';
import { useChartFormat } from './use-chart-format';

export function ActivityLists({ dashboard }: Readonly<{ dashboard: Dashboard }>) {
  return (
    <section className="grid gap-x-12 gap-y-14 md:grid-cols-2">
      <DueSoon dashboard={dashboard} />
      <RecentPayments dashboard={dashboard} />
    </section>
  );
}

/** A bare list like the top section: a title that links to the full list, hairline-split rows. */
function ListPanel({
  title,
  to,
  empty,
  children,
}: Readonly<{
  title: string;
  to: LinkProps['to'];
  empty: string | null;
  children: ReactNode;
}>) {
  return (
    <div className="min-w-0">
      <h3 className="text-sm font-semibold">
        <Link to={to} className="hover:underline">
          {title}
        </Link>
      </h3>
      {empty ? <p className="py-3 text-sm text-muted-foreground">{empty}</p> : <ul className="mt-2 divide-y">{children}</ul>}
    </div>
  );
}

function DueSoon({ dashboard }: Readonly<{ dashboard: Dashboard }>) {
  const { t } = useI18n();
  const td = t.accounting.dashboard;
  const { formatMoney, dayMonth } = useChartFormat();
  const invoices = (dashboard.upcomingDue ?? []).slice(0, 5);

  return (
    <ListPanel title={td.charts.dueSoon} to="/weldbooks/invoices" empty={invoices.length ? null : td.noUpcomingInvoices}>
      {invoices.map((inv) => (
        <li key={inv.id}>
          <Link
            to="/weldbooks/invoices/$id"
            params={{ id: inv.id }}
            className="-mx-2 flex h-10 items-center gap-2 rounded-md px-2 hover:bg-accent/50"
          >
            <span className="flex min-w-0 flex-1 items-center" title={inv.invoiceNumber ?? undefined}>
              <ContactCell name={inv.contactName ?? inv.invoiceNumber} />
            </span>
            <RowDate className="text-xs">{dayMonth(inv.dueDate)}</RowDate>
            <RowAmount className="w-24 text-right">{formatMoney(Number(inv.balanceDue ?? 0))}</RowAmount>
          </Link>
        </li>
      ))}
    </ListPanel>
  );
}

function RecentPayments({ dashboard }: Readonly<{ dashboard: Dashboard }>) {
  const { t } = useI18n();
  const td = t.accounting.dashboard;
  const tpm = t.accounting.paymentMethods;
  const { formatMoney, dayMonth } = useChartFormat();
  const payments = (dashboard.recentPayments ?? []).slice(0, 5);

  return (
    <ListPanel title={td.recentPayments} to="/weldbooks/banking" empty={payments.length ? null : td.noRecentPayments}>
      {payments.map((p) => {
        const received = p.type === 'received';
        const method = p.paymentMethod ? (tpm[p.paymentMethod as keyof typeof tpm] ?? p.paymentMethod.replace(/_/g, ' ')) : null;
        return (
          <li key={p.id} className="flex h-10 items-center gap-2">
            <span
              className={`flex size-5 shrink-0 items-center justify-center rounded-[7px] ${
                received ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400' : 'bg-muted text-muted-foreground'
              }`}
              title={received ? td.charts.received : td.charts.paid}
            >
              {received ? <ArrowDownLeft className="size-3" /> : <ArrowUpRight className="size-3" />}
            </span>
            <RowText className="min-w-0 flex-1">{p.reference ?? method}</RowText>
            <RowDate className="text-xs">{dayMonth(p.date)}</RowDate>
            <RowAmount className={`w-24 text-right ${received ? '' : 'text-muted-foreground'}`}>
              {received ? formatMoney(Number(p.amount)) : `−${formatMoney(Number(p.amount))}`}
            </RowAmount>
          </li>
        );
      })}
    </ListPanel>
  );
}
