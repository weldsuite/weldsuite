
import { AnalyticsListClient } from './_components/analytics-list-client';
import { useAnalyticsReports } from '@/hooks/queries/use-projects-queries';
import { PageLoader } from '@/components/page-loader';

export default function ProjectsAnalyticsPage() {
  const { data, isLoading } = useAnalyticsReports();
  const reports = data?.data || [];

  if (isLoading) return <PageLoader fullScreen={false} />;

  return (
    <div className="container mx-auto py-6">
      <AnalyticsListClient reports={reports} />
    </div>
  );
}
