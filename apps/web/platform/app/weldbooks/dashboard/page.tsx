import { Link } from '@tanstack/react-router';
import { Plus } from 'lucide-react';
import { PageLoader } from '@/components/page-loader';
import { useAccountingDashboard } from '@/hooks/queries/use-accounting-queries';
import { Button } from '@weldsuite/ui/components/button';
import { UndepositedFundsCallout } from '@/app/weldbooks/banking/components/undeposited-funds-callout';
import { useI18n } from '@/lib/i18n/provider';
import { TodaySection } from './components/today-section';
import { OverviewSection } from './components/overview-section';
import { ActivityLists } from './components/activity-lists';

/**
 * The WeldBooks dashboard, laid out like Stripe's home: a title row over a
 * hairline, the "Today" block (this year's running total and the balances to
 * act on), "Your overview" (cards over a chosen range and comparison), and
 * the invoices falling due and latest payments under it.
 */
export default function AccountingDashboardPage() {
  const { t } = useI18n();
  const td = t.accounting.dashboard;
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
    <div className="mx-auto w-full max-w-7xl space-y-14 p-6">
      <div className="flex items-center justify-between gap-4 border-b pb-4">
        <h1 className="text-[28px] font-bold leading-tight tracking-tight">{td.title}</h1>
        <Button asChild variant="outline" size="sm">
          <Link to="/weldbooks/invoices/add">
            <Plus className="size-4" />
            {td.charts.newInvoice}
          </Link>
        </Button>
      </div>

      <UndepositedFundsCallout />
      <TodaySection dashboard={dashboard} />
      <OverviewSection dashboard={dashboard} />
      <ActivityLists dashboard={dashboard} />
    </div>
  );
}
