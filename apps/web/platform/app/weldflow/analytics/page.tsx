import { AnalyticsListClient } from './_components/analytics-list-client';
import { AnalyticsDashboardClient } from './_components/analytics-dashboard-client';
import { useAnalyticsReports } from '@/hooks/queries/use-projects-queries';
import { PageLoader } from '@/components/page-loader';
import { useI18n } from '@/lib/i18n/provider';

export default function ProjectsAnalyticsPage() {
  const { t } = useI18n();
  const { data, isLoading } = useAnalyticsReports();
  const reports = data?.data || [];

  if (isLoading) return <PageLoader fullScreen={false} />;

  return (
    <div className="container mx-auto space-y-10 py-6">
      <AnalyticsDashboardClient />
      <AnalyticsListClient
        reports={reports}
        embedded
        sectionTitle={t.projects.dashboard.customReports}
      />
    </div>
  );
}
