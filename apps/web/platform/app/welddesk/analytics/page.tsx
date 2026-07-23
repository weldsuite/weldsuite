
import { useAnalyticsReports } from '@/hooks/queries/use-helpdesk-queries';
import { AnalyticsListClient } from './_components/analytics-list-client';
import { PageLoader } from '@/components/page-loader';

export default function HelpdeskAnalyticsListPage() {
  const { data, isLoading } = useAnalyticsReports();

  if (isLoading) return <PageLoader fullScreen={false} />;

  return <AnalyticsListClient initialReports={data?.data || []} />;
}
