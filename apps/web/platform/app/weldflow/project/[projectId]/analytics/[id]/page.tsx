
import { useParams } from '@/lib/router';
import { useQuery } from '@tanstack/react-query';
import { analyticsApi } from '@/app/weldflow/lib/api-client';
import { projectKeys } from '@/hooks/queries/use-projects-queries';
import { ProjectReportViewClient } from './_components/project-report-view-client';
import { PageLoader } from '@/components/page-loader';
import { useI18n } from '@/lib/i18n/provider';

export default function ProjectAnalyticsReportPage() {
  const { t } = useI18n();
  const params = useParams();
  const projectId = params.projectId as string;
  const reportId = params.id as string;

  // Same query keys as the report hooks, so the rename/delete/add-chart mutations invalidate this page.
  const { data: reportResult, isLoading: reportLoading } = useQuery({
    queryKey: projectKeys.analyticsReport(reportId),
    queryFn: () => analyticsApi.getReport(reportId),
    enabled: !!reportId,
  });

  const { data: chartsResult, isLoading: chartsLoading } = useQuery({
    queryKey: projectKeys.analyticsCharts(reportId),
    queryFn: () => analyticsApi.getCharts(reportId),
    enabled: !!reportId,
  });

  if (reportLoading || chartsLoading) return <PageLoader fullScreen={false} />;

  // `GET /project-analytics/reports/:id` answers `{ report, charts }`, not the report itself.
  const report = reportResult?.data?.report;
  const charts = chartsResult?.data ?? reportResult?.data?.charts ?? [];

  if (!report) {
    return (
      <div className="container mx-auto py-6 px-4">
        <p className="text-muted-foreground">{t.projects.analyticsReports.reportNotFound}</p>
      </div>
    );
  }

  return (
    <div className="container mx-auto py-6 px-4">
      <ProjectReportViewClient
        key={`${report.id}:${charts.map((chart: { id: string }) => chart.id).join(',')}`}
        report={report}
        charts={charts}
        projectId={projectId}
      />
    </div>
  );
}
