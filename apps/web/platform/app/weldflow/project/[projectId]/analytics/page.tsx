import { AnalyticsListClient } from '@/app/weldflow/analytics/_components/analytics-list-client';
import { useProjectAnalyticsReports } from '@/hooks/queries/use-projects-queries';
import { PageLoader } from '@weldsuite/ui/components/page-loader';
import { useI18n } from '@/lib/i18n/provider';
import { useParams } from '@/lib/router';
import { useBreadcrumbs } from '@/contexts/breadcrumb-context';

export default function ProjectAnalyticsPage() {
  const { t } = useI18n();
  const params = useParams();
  const projectId = params.projectId as string;

  useBreadcrumbs([
    { label: t.projects.title, href: '/weldflow' },
    { label: t.projects.analytics.projectAnalytics },
  ]);

  const { data, isLoading } = useProjectAnalyticsReports(projectId);
  const reports = data?.data || [];
  const basePath = `/weldflow/project/${projectId}/analytics`;

  if (isLoading) return <PageLoader fullScreen={false} />;

  return (
    <AnalyticsListClient
      reports={reports}
      projectId={projectId}
      basePath={basePath}
      emptyStateClassName="min-h-[calc(100dvh-350px)]"
    />
  );
}
