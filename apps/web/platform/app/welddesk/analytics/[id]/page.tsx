
import { useParams, useRouter } from '@/lib/router';
import { useAnalyticsReport, useAnalyticsCharts, useAnalyticsReports } from '@/hooks/queries/use-helpdesk-queries';
import { ReportViewClient } from './_components/report-view-client';
import { PageLoader } from '@/components/page-loader';

export default function HelpdeskAnalyticsReportPage() {
  const params = useParams();
  const router = useRouter();
  const reportId = params.id as string;

  const { data: reportResult, isLoading: reportLoading } = useAnalyticsReport(reportId);

  const { data: chartsResult, isLoading: chartsLoading } = useAnalyticsCharts(reportId);

  const { data: reportsResult, isLoading: reportsLoading } = useAnalyticsReports();

  const isLoading = reportLoading || chartsLoading || reportsLoading;

  if (isLoading) return <PageLoader fullScreen={false} />;

  if (!reportResult?.success || !reportResult?.data) {
    router.push('/welddesk/analytics');
    return null;
  }

  return (
    <ReportViewClient
      report={reportResult.data}
      initialCharts={chartsResult?.data || []}
      allReports={reportsResult?.data || []}
    />
  );
}
