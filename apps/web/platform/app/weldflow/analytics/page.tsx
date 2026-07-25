import { AnalyticsListClient } from './_components/analytics-list-client';
import { AnalyticsDashboardClient } from './_components/analytics-dashboard-client';
import { useProjectAnalyticsReports } from '@/hooks/queries/use-projects-queries';
import { PageLoader } from '@/components/page-loader';
import { useI18n } from '@/lib/i18n/provider';
import { useBreadcrumbs } from '@/contexts/breadcrumb-context';

export default function ProjectsAnalyticsPage() {
  const { t } = useI18n();
  useBreadcrumbs([
    { label: t.projects.title, href: '/weldflow' },
    { label: t.projects.analytics.title },
  ]);

  const { data, isLoading } = useProjectAnalyticsReports();
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
