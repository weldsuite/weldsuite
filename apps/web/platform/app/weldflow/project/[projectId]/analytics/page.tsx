import { AnalyticsListClient } from '@/app/weldflow/analytics/_components/analytics-list-client';
import { AnalyticsDashboardClient } from '@/app/weldflow/analytics/_components/analytics-dashboard-client';
import { useAnalyticsReports } from '@/hooks/queries/use-projects-queries';
import { PageLoader } from '@/components/page-loader';
import { useI18n } from '@/lib/i18n/provider';
import { useParams } from '@/lib/router';

export default function ProjectAnalyticsPage() {
  const { t } = useI18n();
  const params = useParams();
  const projectId = params.projectId as string;

  const { data, isLoading } = useAnalyticsReports();
  const reports = data?.data || [];
  const basePath = `/weldflow/project/${projectId}/analytics`;

  if (isLoading) return <PageLoader fullScreen={false} />;

  return (
    <div className="container mx-auto space-y-10 py-6">
      <AnalyticsDashboardClient projectId={projectId} />
      <AnalyticsListClient
        reports={reports}
        basePath={basePath}
        embedded
        sectionTitle={t.projects.dashboard.customReports}
      />
    </div>
  );
}
