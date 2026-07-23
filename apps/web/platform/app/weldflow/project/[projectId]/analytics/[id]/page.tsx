
import { useParams } from '@/lib/router';
import { useQuery } from '@tanstack/react-query';
import { analyticsApi } from '@/app/weldflow/lib/api-client';
import { ProjectReportViewClient } from './_components/project-report-view-client';
import { PageLoader } from '@/components/page-loader';
import { useI18n } from '@/lib/i18n/provider';

export default function ProjectAnalyticsReportPage() {
  const { t } = useI18n();
  const params = useParams();
  const projectId = params.projectId as string;
  const reportId = params.id as string;

  const { data: reportResult, isLoading: reportLoading } = useQuery({
    queryKey: ['analytics', 'reports', reportId],
    queryFn: () => analyticsApi.getReport(reportId),
    enabled: !!reportId,
  });

  const { data: chartsResult, isLoading: chartsLoading } = useQuery({
    queryKey: ['analytics', 'reports', reportId, 'charts'],
    queryFn: () => analyticsApi.getCharts(reportId),
    enabled: !!reportId,
  });

  if (reportLoading || chartsLoading) return <PageLoader fullScreen={false} />;

  if (!reportResult?.data) {
    return (
      <div className="container mx-auto py-6 px-4">
        <p className="text-muted-foreground">{t.projects.analyticsReports.reportNotFound}</p>
      </div>
    );
  }

  return (
    <div className="container mx-auto py-6 px-4">
      <ProjectReportViewClient
        report={reportResult.data}
        charts={chartsResult?.data ?? []}
        projectId={projectId}
      />
    </div>
  );
}
