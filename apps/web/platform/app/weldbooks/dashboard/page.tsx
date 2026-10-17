import { PageLoader } from '@/components/page-loader';
import { useAccountingDashboard } from '@/hooks/queries/use-accounting-queries';
import { UndepositedFundsCallout } from '@/app/weldbooks/banking/components/undeposited-funds-callout';
import { useI18n } from '@/lib/i18n/provider';
import { TodaySection } from './components/today-section';
import { OverviewSection } from './components/overview-section';
import { ActivityLists } from './components/activity-lists';

/**
 * The WeldBooks dashboard, laid out like Stripe's home: the "Today" block
 * (this year's running total and the balances to act on), "Your overview"
 * (cards over a chosen range and comparison), and the invoices falling due and
 * latest payments under it. No title row: the breadcrumb already names the page.
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
    <div className="mx-auto w-full max-w-7xl space-y-14 px-6 pt-16 pb-6">
      <UndepositedFundsCallout />
      <TodaySection dashboard={dashboard} />
      <OverviewSection dashboard={dashboard} />
      <ActivityLists dashboard={dashboard} />
    </div>
  );
}
