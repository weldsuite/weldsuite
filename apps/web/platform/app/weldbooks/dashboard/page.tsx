import { Link } from '@tanstack/react-router';
import { PageLoader } from '@/components/page-loader';
import { useAccountingDashboard } from '@/hooks/queries/use-accounting-queries';
import { Card, CardContent, CardHeader, CardTitle } from '@weldsuite/ui/components/card';
import { Badge } from '@weldsuite/ui/components/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@weldsuite/ui/components/table';
import { KpiCards } from './components/kpi-cards';
import { TrendChart } from './components/trend-chart';
import { ProfitChart } from './components/profit-chart';
import { AgingChart } from './components/aging-chart';
import { CashChart } from './components/cash-chart';
import { UndepositedFundsCallout } from '@/app/weldbooks/banking/components/undeposited-funds-callout';
import { useI18n } from '@/lib/i18n/provider';
import { useWeldbooksFormat } from '@/lib/weldbooks/use-weldbooks-format';

export default function AccountingDashboardPage() {
  const { t } = useI18n();
  const td = t.accounting.dashboard;
  const tpm = t.accounting.paymentMethods;
  const { formatMoney: fmt, formatDate } = useWeldbooksFormat();
  const { data, isLoading } = useAccountingDashboard();
  if (isLoading) return <PageLoader fullScreen={false} />;
  const dashboard = data?.data;
  if (!dashboard)
    return (
      <div className="mx-auto w-full max-w-7xl p-6 text-muted-foreground">
        {td.loadingMessage}
      </div>
    );

  return (
    <div className="mx-auto w-full max-w-7xl p-6 space-y-6">
      <h1 className="text-2xl font-semibold">{td.title}</h1>

      <TrendChart dashboard={dashboard} />

      <UndepositedFundsCallout />
      <KpiCards dashboard={dashboard} />

      <div className={`grid grid-cols-1 gap-6 ${dashboard.monthlyTrend?.length ? 'lg:grid-cols-3' : 'lg:grid-cols-2'}`}>
        {dashboard.monthlyTrend?.length ? (
          <ProfitChart trend={dashboard.monthlyTrend} profitYear={dashboard.profit?.year} />
        ) : null}
        <AgingChart dashboard={dashboard} />
        <CashChart dashboard={dashboard} />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Upcoming Due */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{td.upcomingDue}</CardTitle>
          </CardHeader>
          <CardContent>
            {(dashboard.upcomingDue ?? []).length === 0 ? (
              <p className="text-sm text-muted-foreground">{td.noUpcomingInvoices}</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{td.table.invoice}</TableHead>
                    <TableHead>{td.table.contact}</TableHead>
                    <TableHead>{td.table.due}</TableHead>
                    <TableHead className="text-right">{td.table.amount}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {dashboard.upcomingDue.map((inv) => (
                    <TableRow key={inv.id}>
                      <TableCell>
                        <Link
                          to="/weldbooks/invoices/$id"
                          params={{ id: inv.id }}
                          className="text-primary hover:underline text-sm"
                        >
                          {inv.invoiceNumber}
                        </Link>
                      </TableCell>
                      <TableCell className="text-sm">{inv.contactName}</TableCell>
                      <TableCell className="text-sm">{formatDate(inv.dueDate)}</TableCell>
                      <TableCell className="text-sm text-right">{fmt(inv.balanceDue)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>

        {/* Recent Payments */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{td.recentPayments}</CardTitle>
          </CardHeader>
          <CardContent>
            {(dashboard.recentPayments ?? []).length === 0 ? (
              <p className="text-sm text-muted-foreground">{td.noRecentPayments}</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{td.table.date}</TableHead>
                    <TableHead>{td.table.type}</TableHead>
                    <TableHead>{td.table.method}</TableHead>
                    <TableHead>{td.table.reference}</TableHead>
                    <TableHead className="text-right">{td.table.amount}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {dashboard.recentPayments.slice(0, 10).map((p) => (
                    <TableRow key={p.id}>
                      <TableCell className="text-sm">{formatDate(p.date)}</TableCell>
                      <TableCell>
                        <Badge variant={p.type === 'received' ? 'default' : 'secondary'} className="text-xs">
                          {p.type}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-sm">
                        {p.paymentMethod
                          ? (tpm[p.paymentMethod as keyof typeof tpm] ?? p.paymentMethod.replace(/_/g, ' '))
                          : '-'}
                      </TableCell>
                      <TableCell className="text-sm">{p.reference ?? '-'}</TableCell>
                      <TableCell className="text-sm text-right">{fmt(p.amount)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
