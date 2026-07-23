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
import { useI18n } from '@/lib/i18n/provider';

function fmt(value: string | number | null | undefined): string {
  return new Intl.NumberFormat('nl-NL', {
    style: 'currency',
    currency: 'EUR',
  }).format(Number(value ?? 0));
}

export default function AccountingDashboardPage() {
  const { t } = useI18n();
  const td = t.accounting.dashboard;
  const { data, isLoading } = useAccountingDashboard();
  if (isLoading) return <PageLoader fullScreen={false} />;
  const dashboard = data?.data;
  if (!dashboard)
    return (
      <div className="p-6 text-muted-foreground">
        {td.loadingMessage}
      </div>
    );

  return (
    <div className="p-6 space-y-6">
      <h1 className="text-2xl font-semibold">{td.title}</h1>

      <KpiCards dashboard={dashboard} />

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Bank Balances */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{td.bankAccounts}</CardTitle>
          </CardHeader>
          <CardContent>
            {(dashboard.bankAccounts ?? []).length === 0 ? (
              <p className="text-sm text-muted-foreground">{td.noBankAccounts}</p>
            ) : (
              <div className="space-y-3">
                {dashboard.bankAccounts.map((ba) => (
                  <div key={ba.id} className="flex items-center justify-between">
                    <div>
                      <p className="text-sm font-medium">{ba.name}</p>
                      <p className="text-xs text-muted-foreground">{ba.iban}</p>
                    </div>
                    <p className="text-sm font-semibold">{fmt(ba.currentBalance)}</p>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

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
                          to={`/weldbooks/invoices/${inv.id}` as any}
                          className="text-primary hover:underline text-sm"
                        >
                          {inv.invoiceNumber}
                        </Link>
                      </TableCell>
                      <TableCell className="text-sm">{inv.contactName}</TableCell>
                      <TableCell className="text-sm">{inv.dueDate}</TableCell>
                      <TableCell className="text-sm text-right">{fmt(inv.balanceDue)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>

        {/* Recent Payments */}
        <Card className="lg:col-span-2">
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
                  {dashboard.recentPayments.slice(0, 10).map((p: any) => (
                    <TableRow key={p.id}>
                      <TableCell className="text-sm">{p.date}</TableCell>
                      <TableCell>
                        <Badge variant={p.type === 'received' ? 'default' : 'secondary'} className="text-xs">
                          {p.type}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-sm capitalize">{p.paymentMethod?.replace('_', ' ')}</TableCell>
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
