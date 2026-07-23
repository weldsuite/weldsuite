
import { useParams } from '@/lib/router';
import { ReportViewClient } from './_components/report-view-client';
import { useAnalyticsReport, useAnalyticsCharts } from '@/hooks/queries/use-projects-queries';
import { PageLoader } from '@/components/page-loader';
import { useI18n } from '@/lib/i18n/provider';

export default function ProjectsAnalyticsReportPage() {
  const { t } = useI18n();
  const params = useParams();
  const id = params.id as string;

  const { data: reportResult, isLoading: reportLoading } = useAnalyticsReport(id);
  const { data: chartsResult, isLoading: chartsLoading } = useAnalyticsCharts(id);

  const isLoading = reportLoading || chartsLoading;

  if (isLoading) return <PageLoader fullScreen={false} />;

  const report = reportResult?.data?.report;
  const charts = chartsResult?.data || reportResult?.data?.charts || [];

  if (!report) {
    return <div className="flex items-center justify-center p-8 text-muted-foreground">{t.projects.analyticsReports.reportNotFound}</div>;
  }

  return (
    <div className="container mx-auto py-6">
      <ReportViewClient report={report} charts={charts} />
    </div>
  );
}
