import { Card, CardContent, CardHeader, CardTitle } from '@weldsuite/ui/components/card';
import type { Dashboard } from '@/lib/api/domains/weldbooks';
import { useI18n } from '@/lib/i18n/provider';

function fmt(value: string | number | null | undefined): string {
  return new Intl.NumberFormat('nl-NL', {
    style: 'currency',
    currency: 'EUR',
  }).format(Number(value ?? 0));
}

export function KpiCards({ dashboard }: { dashboard: Dashboard }) {
  const { t } = useI18n();
  const tk = t.accounting.kpiCards;

  const cards = [
    { label: tk.revenueMonth, value: fmt(dashboard.revenue?.month) },
    { label: tk.revenueYear, value: fmt(dashboard.revenue?.year) },
    { label: tk.expensesMonth, value: fmt(dashboard.expenses?.month) },
    { label: tk.profitMonth, value: fmt(dashboard.profit?.month) },
    {
      label: tk.outstandingReceivables,
      value: fmt(dashboard.receivables?.outstanding),
      sub: tk.invoices.replace('{count}', String(dashboard.receivables?.outstandingCount ?? 0)),
    },
    {
      label: tk.overdueReceivables,
      value: fmt(dashboard.receivables?.overdue),
      sub: tk.invoices.replace('{count}', String(dashboard.receivables?.overdueCount ?? 0)),
      warn: Number(dashboard.receivables?.overdue ?? 0) > 0,
    },
    {
      label: tk.outstandingPayables,
      value: fmt(dashboard.payables?.outstanding),
      sub: tk.bills.replace('{count}', String(dashboard.payables?.outstandingCount ?? 0)),
    },
    {
      label: tk.pendingDocuments,
      value: String(dashboard.pendingDocuments ?? 0),
    },
  ];

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
      {cards.map(({ label, value, sub, warn }) => (
        <Card key={label}>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              {label}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className={`text-2xl font-semibold ${warn ? 'text-destructive' : ''}`}>
              {value}
            </p>
            {sub && (
              <p className="text-xs text-muted-foreground mt-1">{sub}</p>
            )}
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
